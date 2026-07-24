import {
  PARTIAL_PROVIDER_FAILURE,
  VERIFIED_KMA_MID_CONTRACT_VERSION,
  VERIFIED_KMA_SHORT_CONTRACT_VERSION,
  runCachedAdapterCall
} from "./adapter-call.js";
import {
  InMemoryAdapterCache,
  SingleFlight,
  makeAdapterCacheKey
} from "./cache.js";
import {
  AdapterError,
  SchemaChangedError,
  UnsupportedContractError,
  classifyProviderError
} from "./errors.js";
import { requestProviderJson } from "./network.js";
import { ProviderExecutionGuard } from "./provider-control.js";
import {
  kmaDateTimeToIso,
  parseIsoDate,
  parseIsoInstant,
  parseStrictFiniteNumber,
  requireNonEmptyString
} from "./strict-values.js";

const SHORT_ENDPOINT =
  "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst";
const MID_SERVICE_URL =
  "https://apis.data.go.kr/1360000/MidFcstInfoService";
const MID_TEMPERATURE_ENDPOINT = `${MID_SERVICE_URL}/getMidTa`;
const MID_LAND_ENDPOINT = `${MID_SERVICE_URL}/getMidLandFcst`;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function clockMs(now) {
  return new Date(now()).getTime();
}

function assertCacheTtl(value, maximum, field) {
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    throw new TypeError(`${field} must be between 0 and ${maximum}ms.`);
  }
}

function inspectKmaHeader(payload) {
  const header = payload?.response?.header;
  if (!header) return;
  const resultCode = String(header.resultCode ?? "").trim();
  if (resultCode === "00" || resultCode === "0") return;
  if (resultCode === "03") return "NO_DATA";
  throw new AdapterError("KMA returned a provider-level error.", {
    adapterState: "INTERNAL_ERROR",
    code: "KMA_PROVIDER_ERROR",
    retryable: false
  });
}

function extractKmaItems(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SchemaChangedError("KMA response must be an object.");
  }
  if (inspectKmaHeader(payload) === "NO_DATA") return [];

  const nestedItems = payload.response?.body?.items;
  const candidates = [
    nestedItems?.item,
    Array.isArray(nestedItems) ? nestedItems : undefined,
    payload.items?.item,
    Array.isArray(payload.items) ? payload.items : undefined,
    Array.isArray(payload.data) ? payload.data : undefined
  ];
  const items = candidates.find((candidate) => Array.isArray(candidate));
  if (!items) {
    const count = Number(payload.response?.body?.totalCount);
    if (count === 0 || nestedItems === "" || nestedItems === null) return [];
    throw new SchemaChangedError("KMA response is missing its item array.");
  }
  return items;
}

function numericField(row, field, options = {}) {
  return parseStrictFiniteNumber(row[field], {
    field: `KMA ${field}`,
    ...options
  });
}

function withQualityFlags(value, qualityFlags) {
  const flags = [...new Set(qualityFlags)];
  return flags.length === 0 ? value : { ...value, qualityFlags: flags };
}

function normalizedForecastDay(row, sourceType, index) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new SchemaChangedError(`KMA days[${index}] must be an object.`);
  }
  const date = parseIsoDate(row.date, `KMA days[${index}].date`);
  const issueTime = parseIsoInstant(
    row.issueTime ?? row.issuedAt,
    `KMA days[${index}].issueTime`
  );
  const validFrom = parseIsoInstant(
    row.validFrom,
    `KMA days[${index}].validFrom`
  );
  const validTo = parseIsoInstant(row.validTo, `KMA days[${index}].validTo`);
  if (Date.parse(validFrom) > Date.parse(validTo)) {
    throw new SchemaChangedError(
      `KMA days[${index}] has an inverted validity range.`
    );
  }

  return withQualityFlags(
    {
      date,
      sourceType,
      spatialLevel:
        sourceType === "SHORT_GRID" ? "FORECAST_GRID" : "FORECAST_REGION",
      issueTime,
      validFrom,
      validTo,
      minTemperature: numericField(row, "minTemperature", {
        min: -100,
        max: 100
      }),
      maxTemperature: numericField(row, "maxTemperature", {
        min: -100,
        max: 100
      }),
      precipitationProbability: numericField(row, "precipitationProbability", {
        min: 0,
        max: 100
      }),
      precipitationAmount: numericField(row, "precipitationAmount", { min: 0 }),
      windSpeed: numericField(row, "windSpeed", { min: 0 }),
      risks: []
    },
    Array.isArray(row.qualityFlags) ? row.qualityFlags : []
  );
}

function payloadDays(payload) {
  if (Array.isArray(payload?.days)) return payload.days;
  if (Array.isArray(payload?.data?.days)) return payload.data.days;
  return null;
}

function compactDate(value, field) {
  const text = String(value ?? "").trim();
  if (!/^\d{8}$/.test(text)) {
    throw new SchemaChangedError(`${field} must use YYYYMMDD.`);
  }
  return parseIsoDate(
    `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`,
    field
  );
}

function parseNumericSeries(values, field, options) {
  const parsed = values.map((value) =>
    parseStrictFiniteNumber(value, { field, ...options })
  );
  return {
    values: parsed.filter((value) => value !== null),
    hasMissing: parsed.some((value) => value === null)
  };
}

function aggregateExtreme(
  values,
  field,
  options,
  reducer,
  missingQualityFlag,
  qualityFlags
) {
  if (values.length === 0) return null;
  const parsed = parseNumericSeries(values, field, options);
  if (parsed.hasMissing || parsed.values.length === 0) {
    qualityFlags.push(missingQualityFlag);
    return null;
  }
  return reducer(...parsed.values);
}

function singleDailyValue(
  values,
  field,
  options,
  multipleQualityFlag,
  missingQualityFlag,
  qualityFlags
) {
  if (values.length === 0) return null;
  if (values.length !== 1) {
    qualityFlags.push(multipleQualityFlag);
    return null;
  }
  const value = parseStrictFiniteNumber(values[0], { field, ...options });
  if (value === null) qualityFlags.push(missingQualityFlag);
  return value;
}

function parsePcpValue(value, field) {
  if (value === null || value === undefined) return { kind: "MISSING" };
  const text = String(value).trim();
  if (text === "" || text === "-") return { kind: "MISSING" };
  if (text === "강수없음") return { kind: "NUMBER", value: 0 };

  const exact = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(?:mm)?$/i.exec(text);
  if (exact) {
    return {
      kind: "NUMBER",
      value: parseStrictFiniteNumber(exact[1], { field, min: 0 })
    };
  }
  if (
    /(?:mm|밀리미터)/i.test(text) &&
    /(?:미만|이상|초과|이하|[~∼])/u.test(text)
  ) {
    return { kind: "NON_QUANTITATIVE" };
  }
  throw new SchemaChangedError(`${field} has an unsupported precipitation value.`);
}

function aggregatePrecipitation(values, field, qualityFlags) {
  if (values.length === 0) return null;
  const parsed = values.map((value) => parsePcpValue(value, field));
  if (parsed.some((entry) => entry.kind === "NON_QUANTITATIVE")) {
    qualityFlags.push("SHORT_PCP_NON_QUANTITATIVE");
    return null;
  }
  if (parsed.some((entry) => entry.kind === "MISSING")) {
    qualityFlags.push("SHORT_PCP_MISSING");
    return null;
  }
  return parsed.reduce((sum, entry) => sum + entry.value, 0);
}

function parseShortCategoryItems(items) {
  if (items.length === 0) return [];
  const byDate = new Map();
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new SchemaChangedError(`KMA items[${index}] must be an object.`);
    }
    const category = requireNonEmptyString(
      item.category,
      `KMA items[${index}].category`
    );
    const date = compactDate(item.fcstDate, `KMA items[${index}].fcstDate`);
    const issueTime = kmaDateTimeToIso(item.baseDate, item.baseTime, {
      field: `KMA items[${index}] issue time`
    });
    const validTime = kmaDateTimeToIso(item.fcstDate, item.fcstTime, {
      field: `KMA items[${index}] valid time`
    });
    const group = byDate.get(date) ?? {
      issueTimes: new Set(),
      validTimes: [],
      categories: new Map()
    };
    group.issueTimes.add(issueTime);
    group.validTimes.push(validTime);
    const values = group.categories.get(category) ?? [];
    values.push(item.fcstValue);
    group.categories.set(category, values);
    byDate.set(date, group);
  }

  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, group]) => {
      if (group.issueTimes.size !== 1) {
        throw new SchemaChangedError(
          `KMA short forecast ${date} contains mixed issue times.`
        );
      }
      const validTimes = [...new Set(group.validTimes)].sort();
      const values = (category) => group.categories.get(category) ?? [];
      const qualityFlags = [];
      const hourlyTemperatures = parseNumericSeries(
        values("TMP"),
        `${date} TMP`,
        { min: -100, max: 100 }
      );
      if (hourlyTemperatures.hasMissing) {
        qualityFlags.push("SHORT_TMP_MISSING");
      }

      const explicitMinimum = singleDailyValue(
        values("TMN"),
        `${date} TMN`,
        { min: -100, max: 100 },
        "SHORT_TMN_MULTIPLE_VALUES",
        "SHORT_TMN_MISSING",
        qualityFlags
      );
      const explicitMaximum = singleDailyValue(
        values("TMX"),
        `${date} TMX`,
        { min: -100, max: 100 },
        "SHORT_TMX_MULTIPLE_VALUES",
        "SHORT_TMX_MISSING",
        qualityFlags
      );
      const derivedMinimum =
        hourlyTemperatures.values.length > 0 &&
        !hourlyTemperatures.hasMissing
          ? Math.min(...hourlyTemperatures.values)
          : null;
      const derivedMaximum =
        hourlyTemperatures.values.length > 0 &&
        !hourlyTemperatures.hasMissing
          ? Math.max(...hourlyTemperatures.values)
          : null;

      return withQualityFlags(
        {
          date,
          sourceType: "SHORT_GRID",
          spatialLevel: "FORECAST_GRID",
          issueTime: [...group.issueTimes][0],
          validFrom: validTimes[0],
          validTo: validTimes.at(-1),
          minTemperature: explicitMinimum ?? derivedMinimum,
          maxTemperature: explicitMaximum ?? derivedMaximum,
          precipitationProbability: aggregateExtreme(
            values("POP"),
            `${date} POP`,
            { min: 0, max: 100 },
            Math.max,
            "SHORT_POP_MISSING",
            qualityFlags
          ),
          precipitationAmount: aggregatePrecipitation(
            values("PCP"),
            `${date} PCP`,
            qualityFlags
          ),
          windSpeed: aggregateExtreme(
            values("WSD"),
            `${date} WSD`,
            { min: 0 },
            Math.max,
            "SHORT_WSD_MISSING",
            qualityFlags
          ),
          risks: []
        },
        qualityFlags
      );
    });
}

export function parseKmaShortForecast(payload) {
  const days = payloadDays(payload);
  if (days) {
    return days.map((row, index) =>
      normalizedForecastDay(row, "SHORT_GRID", index)
    );
  }
  return parseShortCategoryItems(extractKmaItems(payload));
}

function addCalendarDays(isoDate, count) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + count));
  return result.toISOString().slice(0, 10);
}

function localDayValidity(date) {
  const from = parseIsoInstant(`${date}T00:00:00+09:00`, "KMA validFrom");
  const next = addCalendarDays(date, 1);
  const toMs =
    Date.parse(parseIsoInstant(`${next}T00:00:00+09:00`, "KMA validTo")) - 1;
  return { validFrom: from, validTo: new Date(toMs).toISOString() };
}

function parseCompactIssue(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{12}$/.test(text)) {
    throw new SchemaChangedError(
      "KMA mid forecast issue time must use YYYYMMDDHHmm."
    );
  }
  return kmaDateTimeToIso(text.slice(0, 8), text.slice(8), {
    field: "KMA mid forecast issue time"
  });
}

function issueLocalDate(issueTime) {
  return new Date(Date.parse(issueTime) + KST_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

export function validateKmaMidRegionMapping(mapping) {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    throw new UnsupportedContractError("KMA mid region mapping is required.");
  }
  let temperatureRegId;
  let landRegId;
  try {
    temperatureRegId = requireNonEmptyString(
      mapping.temperatureRegId,
      "KMA temperatureRegId"
    );
    landRegId = requireNonEmptyString(mapping.landRegId, "KMA landRegId");
  } catch (error) {
    throw new UnsupportedContractError(
      "KMA mid mapping requires temperatureRegId and landRegId.",
      { cause: error }
    );
  }
  return Object.freeze({ temperatureRegId, landRegId });
}

function selectMidRegionItem(payload, regId, label) {
  const items = extractKmaItems(payload);
  if (items.length === 0) return null;
  const matches = items.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      String(item.regId ?? "").trim() === regId
  );
  if (matches.length !== 1) {
    throw new SchemaChangedError(
      `KMA ${label} response does not contain exactly one matching regId row.`
    );
  }
  return matches[0];
}

function midDayBase(issueTime, offset) {
  const date = addCalendarDays(issueLocalDate(issueTime), offset);
  return {
    date,
    issueTime,
    ...localDayValidity(date)
  };
}

export function parseKmaMidTemperature(
  payload,
  { issuedAt, temperatureRegId } = {}
) {
  const issueTime =
    typeof issuedAt === "string" && issuedAt.includes("T")
      ? parseIsoInstant(issuedAt, "KMA mid temperature issue time")
      : parseCompactIssue(issuedAt);
  const regId = requireNonEmptyString(
    temperatureRegId,
    "KMA temperatureRegId"
  );
  const item = selectMidRegionItem(payload, regId, "temperature");
  if (!item) return [];
  const days = [];
  for (let offset = 3; offset <= 10; offset += 1) {
    const minTemperature = numericField(item, `taMin${offset}`, {
      min: -100,
      max: 100
    });
    const maxTemperature = numericField(item, `taMax${offset}`, {
      min: -100,
      max: 100
    });
    if (minTemperature === null && maxTemperature === null) continue;
    days.push({
      ...midDayBase(issueTime, offset),
      minTemperature,
      maxTemperature
    });
  }
  return days;
}

function hasOwn(row, field) {
  return Object.prototype.hasOwnProperty.call(row, field);
}

function midLandProbability(item, offset, qualityFlags) {
  const dailyField = `rnSt${offset}`;
  if (hasOwn(item, dailyField)) {
    return numericField(item, dailyField, { min: 0, max: 100 });
  }
  const morningField = `rnSt${offset}Am`;
  const afternoonField = `rnSt${offset}Pm`;
  if (!hasOwn(item, morningField) && !hasOwn(item, afternoonField)) return null;
  const morning = numericField(item, morningField, { min: 0, max: 100 });
  const afternoon = numericField(item, afternoonField, { min: 0, max: 100 });
  if (morning === null || afternoon === null) {
    qualityFlags.push("MID_LAND_HALF_DAY_MISSING");
    return null;
  }
  return Math.max(morning, afternoon);
}

export function parseKmaMidLandForecast(
  payload,
  { issuedAt, landRegId } = {}
) {
  const issueTime =
    typeof issuedAt === "string" && issuedAt.includes("T")
      ? parseIsoInstant(issuedAt, "KMA mid land issue time")
      : parseCompactIssue(issuedAt);
  const regId = requireNonEmptyString(landRegId, "KMA landRegId");
  const item = selectMidRegionItem(payload, regId, "land");
  if (!item) return [];
  const days = [];
  for (let offset = 3; offset <= 10; offset += 1) {
    const qualityFlags = [];
    const precipitationProbability = midLandProbability(
      item,
      offset,
      qualityFlags
    );
    const hasWeather =
      hasOwn(item, `wf${offset}`) ||
      hasOwn(item, `wf${offset}Am`) ||
      hasOwn(item, `wf${offset}Pm`);
    if (precipitationProbability === null && !hasWeather) continue;
    days.push(
      withQualityFlags(
        {
          ...midDayBase(issueTime, offset),
          precipitationProbability
        },
        qualityFlags
      )
    );
  }
  return days;
}

export function joinKmaMidForecast(
  temperatureDays = [],
  landDays = []
) {
  const temperatureByDate = new Map(
    temperatureDays.map((day) => [day.date, day])
  );
  const landByDate = new Map(landDays.map((day) => [day.date, day]));
  const dates = [
    ...new Set([...temperatureByDate.keys(), ...landByDate.keys()])
  ].sort();

  return dates.map((date) => {
    const temperature = temperatureByDate.get(date);
    const land = landByDate.get(date);
    const issueTimes = [
      ...new Set(
        [temperature?.issueTime, land?.issueTime].filter(Boolean)
      )
    ];
    if (issueTimes.length !== 1) {
      throw new SchemaChangedError(
        `KMA mid forecast ${date} has mismatched issue times.`
      );
    }
    const source = temperature ?? land;
    return withQualityFlags(
      {
        date,
        sourceType: "MID_REGIONAL",
        spatialLevel: "FORECAST_REGION",
        issueTime: issueTimes[0],
        validFrom: source.validFrom,
        validTo: source.validTo,
        minTemperature: temperature?.minTemperature ?? null,
        maxTemperature: temperature?.maxTemperature ?? null,
        precipitationProbability: land?.precipitationProbability ?? null,
        precipitationAmount: null,
        windSpeed: null,
        risks: []
      },
      [
        ...(temperature?.qualityFlags ?? []),
        ...(land?.qualityFlags ?? [])
      ]
    );
  });
}

export function parseKmaMidForecast(
  payload,
  { issuedAt, temperatureRegId, landRegId } = {}
) {
  const days = payloadDays(payload);
  if (days) {
    return days.map((row, index) =>
      normalizedForecastDay(row, "MID_REGIONAL", index)
    );
  }
  const temperaturePayload =
    payload?.temperaturePayload ?? payload?.temperature ?? null;
  const landPayload = payload?.landPayload ?? payload?.land ?? null;
  if (!temperaturePayload && !landPayload) {
    throw new SchemaChangedError(
      "KMA mid forecast requires separate temperature and land payloads."
    );
  }
  const temperatureDays = temperaturePayload
    ? parseKmaMidTemperature(temperaturePayload, {
        issuedAt,
        temperatureRegId
      })
    : [];
  const landDays = landPayload
    ? parseKmaMidLandForecast(landPayload, { issuedAt, landRegId })
    : [];
  return joinKmaMidForecast(temperatureDays, landDays);
}

function dateRange(days) {
  if (days.length === 0) {
    return { issuedAt: null, validFrom: null, validTo: null };
  }
  const issueTimes = [...new Set(days.map((day) => day.issueTime))];
  if (issueTimes.length !== 1) {
    throw new SchemaChangedError("Forecast response contains mixed issue times.");
  }
  return {
    issuedAt: issueTimes[0],
    validFrom: days
      .map((day) => day.validFrom)
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0],
    validTo: days
      .map((day) => day.validTo)
      .sort((left, right) => Date.parse(left) - Date.parse(right))
      .at(-1)
  };
}

function appendQuery(url, values) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
}

function kmaBase({
  sourceId,
  sourceName,
  sourceUrl,
  spatialLevel,
  spatialLabel,
  adapterVersion,
  contractVersion,
  operationId
}) {
  return {
    sourceId,
    sourceName,
    sourceUrl,
    observedAt: null,
    issuedAt: null,
    validFrom: null,
    validTo: null,
    spatialLevel,
    spatialLabel,
    distanceKm: null,
    unit: null,
    provenance: {
      adapterId: sourceId,
      adapterVersion,
      operationId,
      contractVersion,
      providerIssueTime: null
    }
  };
}

function allDayQualityFlags(days) {
  return [
    ...new Set(days.flatMap((day) => day.qualityFlags ?? []))
  ];
}

export function createKmaShortForecastAdapter({
  enabled = false,
  apiKey,
  fetchImpl = globalThis.fetch,
  endpoint = SHORT_ENDPOINT,
  timeoutMs = 3000,
  adapterVersion = "1",
  contractVersion = null,
  cache,
  singleFlight,
  executionGuard,
  providerControl = {},
  cacheFreshForMs = 30 * 60 * 1000,
  now = () => new Date()
} = {}) {
  assertCacheTtl(
    cacheFreshForMs,
    3 * 60 * 60 * 1000,
    "KMA short cacheFreshForMs"
  );
  const cacheClock = () => clockMs(now);
  const liveCache =
    cache ??
    new InMemoryAdapterCache({
      maxEntries: 200,
      maxTtlMs: 3 * 60 * 60 * 1000,
      now: cacheClock
    });
  const liveSingleFlight = singleFlight ?? new SingleFlight();
  const liveExecutionGuard =
    executionGuard ??
    new ProviderExecutionGuard({
      maxConcurrency: 4,
      maxQueue: 8,
      failureThreshold: 3,
      circuitCooldownMs: 1000,
      ...providerControl,
      provider: "KMA",
      now: providerControl.now ?? cacheClock
    });
  const envelopeBase = kmaBase({
    sourceId: "kma-short-forecast",
    sourceName: "기상청 단기예보",
    sourceUrl: SHORT_ENDPOINT,
    spatialLevel: "FORECAST_GRID",
    spatialLabel: "단기예보 격자",
    adapterVersion,
    contractVersion,
    operationId: "get-vilage-forecast"
  });

  return Object.freeze({
    id: "kmaShort",
    async getForecast(
      { nx, ny, baseDate, baseTime, pageNo = 1, numOfRows = 1000 } = {},
      { signal, deadlineAt } = {}
    ) {
      let issueTime = null;
      try {
        issueTime = kmaDateTimeToIso(baseDate, baseTime, {
          field: "KMA base time"
        });
      } catch {
        // The operation will return a contained schema envelope.
      }
      const cacheKey = makeAdapterCacheKey({
        adapterVersion,
        operationId: "get-vilage-forecast",
        verifiedLocationKey: { nx: nx ?? null, ny: ny ?? null },
        requestedPeriod: { baseDate: baseDate ?? null },
        providerIssueTime: issueTime,
        normalizedParameters: { contractVersion, pageNo, numOfRows }
      });
      return runCachedAdapterCall({
        enabled,
        credential: apiKey,
        contractVersion,
        allowedContractVersions: [
          VERIFIED_KMA_SHORT_CONTRACT_VERSION
        ],
        envelopeBase,
        cache: liveCache,
        singleFlight: liveSingleFlight,
        executionGuard: liveExecutionGuard,
        cacheKey,
        cacheFreshForMs,
        signal,
        deadlineAt,
        now,
        operation: async ({
          signal: upstreamSignal,
          deadlineAt: upstreamDeadlineAt
        }) => {
          if (
            !Number.isInteger(nx) ||
            !Number.isInteger(ny) ||
            nx < 1 ||
            ny < 1
          ) {
            throw new TypeError("KMA short forecast requires positive nx and ny.");
          }
          kmaDateTimeToIso(baseDate, baseTime, { field: "KMA base time" });
          const url = new URL(endpoint);
          appendQuery(url, {
            serviceKey: apiKey.trim(),
            pageNo,
            numOfRows,
            dataType: "JSON",
            base_date: baseDate,
            base_time: baseTime,
            nx,
            ny
          });
          const payload = await requestProviderJson({
            fetchImpl,
            url,
            provider: "KMA",
            requestInit: { headers: { Accept: "application/json" } },
            signal: upstreamSignal,
            timeoutMs,
            deadlineAt: upstreamDeadlineAt,
            now: cacheClock
          });
          const days = parseKmaShortForecast(payload);
          const range = dateRange(days);
          return {
            adapterState: days.length === 0 ? "NO_DATA" : "SUCCESS",
            ...range,
            provenance: {
              ...envelopeBase.provenance,
              providerIssueTime: range.issuedAt
            },
            qualityFlags: allDayQualityFlags(days),
            data: {
              dataRole: "FORECAST",
              days
            }
          };
        }
      });
    }
  });
}

function midFailureFlag(label, error) {
  const classified = classifyProviderError(error);
  return `MID_${label}_${classified.code}`;
}

export function createKmaMidForecastAdapter({
  enabled = false,
  apiKey,
  fetchImpl = globalThis.fetch,
  temperatureEndpoint = MID_TEMPERATURE_ENDPOINT,
  landEndpoint = MID_LAND_ENDPOINT,
  timeoutMs = 3000,
  adapterVersion = "1",
  contractVersion = null,
  cache,
  singleFlight,
  executionGuard,
  providerControl = {},
  cacheFreshForMs = 60 * 60 * 1000,
  now = () => new Date()
} = {}) {
  assertCacheTtl(
    cacheFreshForMs,
    6 * 60 * 60 * 1000,
    "KMA mid cacheFreshForMs"
  );
  const cacheClock = () => clockMs(now);
  const liveCache =
    cache ??
    new InMemoryAdapterCache({
      maxEntries: 100,
      maxTtlMs: 6 * 60 * 60 * 1000,
      now: cacheClock
    });
  const liveSingleFlight = singleFlight ?? new SingleFlight();
  const liveExecutionGuard =
    executionGuard ??
    new ProviderExecutionGuard({
      maxConcurrency: 4,
      maxQueue: 8,
      failureThreshold: 3,
      circuitCooldownMs: 1000,
      ...providerControl,
      provider: "KMA",
      now: providerControl.now ?? cacheClock
    });
  const envelopeBase = kmaBase({
    sourceId: "kma-mid-forecast",
    sourceName: "기상청 중기예보",
    sourceUrl: MID_SERVICE_URL,
    spatialLevel: "FORECAST_REGION",
    spatialLabel: "중기예보 지역",
    adapterVersion,
    contractVersion,
    operationId: "get-mid-ta+get-mid-land-fcst"
  });

  return Object.freeze({
    id: "kmaMid",
    async getForecast(
      {
        temperatureRegId,
        landRegId,
        tmFc,
        pageNo = 1,
        numOfRows = 10
      } = {},
      { signal, deadlineAt } = {}
    ) {
      let issueTime = null;
      try {
        issueTime = parseCompactIssue(tmFc);
      } catch {
        // The operation will return a contained schema envelope.
      }
      const cacheKey = makeAdapterCacheKey({
        adapterVersion,
        operationId: "get-mid-ta+get-mid-land-fcst",
        verifiedLocationKey: {
          temperatureRegId: temperatureRegId ?? null,
          landRegId: landRegId ?? null
        },
        requestedPeriod: { dayOffsetFrom: 3, dayOffsetTo: 10 },
        providerIssueTime: issueTime,
        normalizedParameters: { contractVersion, pageNo, numOfRows }
      });
      return runCachedAdapterCall({
        enabled,
        credential: apiKey,
        contractVersion,
        allowedContractVersions: [
          VERIFIED_KMA_MID_CONTRACT_VERSION
        ],
        envelopeBase,
        cache: liveCache,
        singleFlight: liveSingleFlight,
        cacheKey,
        cacheFreshForMs,
        signal,
        deadlineAt,
        now,
        cacheable: (envelope) =>
          envelope.adapterState === "SUCCESS" &&
          !envelope.qualityFlags.includes(PARTIAL_PROVIDER_FAILURE) &&
          !envelope.qualityFlags.some((flag) =>
            flag.startsWith("MID_TEMPERATURE_PROVIDER_") ||
            flag.startsWith("MID_LAND_PROVIDER_")
          ),
        operation: async ({
          signal: upstreamSignal,
          deadlineAt: upstreamDeadlineAt
        }) => {
          const regionMapping = validateKmaMidRegionMapping({
            temperatureRegId,
            landRegId
          });
          parseCompactIssue(tmFc);
          const commonQuery = {
            serviceKey: apiKey.trim(),
            pageNo,
            numOfRows,
            dataType: "JSON",
            tmFc
          };
          const temperatureUrl = new URL(temperatureEndpoint);
          appendQuery(temperatureUrl, {
            ...commonQuery,
            regId: regionMapping.temperatureRegId
          });
          const landUrl = new URL(landEndpoint);
          appendQuery(landUrl, {
            ...commonQuery,
            regId: regionMapping.landRegId
          });

          const [temperatureResult, landResult] = await Promise.allSettled([
            liveExecutionGuard.run(
              () =>
                requestProviderJson({
                  fetchImpl,
                  url: temperatureUrl,
                  provider: "KMA",
                  requestInit: { headers: { Accept: "application/json" } },
                  signal: upstreamSignal,
                  timeoutMs,
                  deadlineAt: upstreamDeadlineAt,
                  now: cacheClock
                }),
              { signal: upstreamSignal }
            ).then((payload) =>
              parseKmaMidTemperature(payload, {
                issuedAt: tmFc,
                temperatureRegId: regionMapping.temperatureRegId
              })
            ),
            liveExecutionGuard.run(
              () =>
                requestProviderJson({
                  fetchImpl,
                  url: landUrl,
                  provider: "KMA",
                  requestInit: { headers: { Accept: "application/json" } },
                  signal: upstreamSignal,
                  timeoutMs,
                  deadlineAt: upstreamDeadlineAt,
                  now: cacheClock
                }),
              { signal: upstreamSignal }
            ).then((payload) =>
              parseKmaMidLandForecast(payload, {
                issuedAt: tmFc,
                landRegId: regionMapping.landRegId
              })
            )
          ]);

          if (
            temperatureResult.status === "rejected" &&
            landResult.status === "rejected"
          ) {
            throw temperatureResult.reason;
          }
          const temperatureDays =
            temperatureResult.status === "fulfilled"
              ? temperatureResult.value
              : [];
          const landDays =
            landResult.status === "fulfilled" ? landResult.value : [];
          const days = joinKmaMidForecast(temperatureDays, landDays);
          if (
            days.length === 0 &&
            (temperatureResult.status === "rejected" ||
              landResult.status === "rejected")
          ) {
            throw (
              (temperatureResult.status === "rejected" &&
                temperatureResult.reason) ||
              (landResult.status === "rejected" && landResult.reason)
            );
          }

          const qualityFlags = allDayQualityFlags(days);
          if (
            temperatureResult.status !== landResult.status
          ) {
            qualityFlags.push(PARTIAL_PROVIDER_FAILURE);
          }
          if (temperatureResult.status === "rejected") {
            qualityFlags.push(
              midFailureFlag("TEMPERATURE", temperatureResult.reason)
            );
          }
          if (landResult.status === "rejected") {
            qualityFlags.push(midFailureFlag("LAND", landResult.reason));
          }
          const range = dateRange(days);
          return {
            adapterState: days.length === 0 ? "NO_DATA" : "SUCCESS",
            ...range,
            provenance: {
              ...envelopeBase.provenance,
              providerIssueTime: range.issuedAt
            },
            qualityFlags: [...new Set(qualityFlags)],
            data: {
              dataRole: "FORECAST",
              regionMapping,
              days
            }
          };
        }
      });
    }
  });
}
