import {
  VERIFIED_KMA_ASOS_CONTRACT_VERSION,
  VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
  runCachedAdapterCall,
} from "./adapter-call.js";
import {
  InMemoryAdapterCache,
  SingleFlight,
  makeAdapterCacheKey,
} from "./cache.js";
import {
  AdapterError,
  NoDataError,
  SchemaChangedError,
} from "./errors.js";
import {
  providerDisclosureUrl,
  requestProviderJson,
} from "./network.js";
import { ProviderExecutionGuard } from "./provider-control.js";
import BUNDLED_CLIMATE_NORMALS from "../../runtime/climate-normal-1991-2020.json" with { type: "json" };

const ASOS_ENDPOINT =
  "https://apis.data.go.kr/1360000/AsosDalyInfoService/getWthrDataList";
// 평년값은 30년 고정값이라 실시간 호출 대상이 아니다. 기상청이 배포한
// 월별 기후평년값(1991-2020) 엑셀을 scripts/build-climate-normal.mjs로
// 변환해 저장소에 포함하고, 아래 주소는 출처 표기 용도로만 쓴다.
const CLIMATE_NORMAL_SOURCE_URL =
  "https://data.kma.go.kr/climate/average30Years/selectAverage30YearsMonthList.do";
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function isoKstDate(value) {
  return new Date(new Date(value).getTime() + KST_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

function addIsoDays(date, amount) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount))
    .toISOString()
    .slice(0, 10);
}

function compactDate(date) {
  return date.replaceAll("-", "");
}

function completedDates(now, count) {
  const today = isoKstDate(now());
  return Array.from(
    { length: count },
    (_, index) => addIsoDays(today, index - count),
  );
}

function localDayStart(date) {
  return new Date(`${date}T00:00:00+09:00`).toISOString();
}

function localDayEnd(date) {
  return new Date(
    Date.parse(`${addIsoDays(date, 1)}T00:00:00+09:00`) - 1,
  ).toISOString();
}

function extractKmaItems(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SchemaChangedError("KMA ASOS response must be an object.");
  }
  const header = payload.response?.header;
  const resultCode = String(header?.resultCode ?? "").trim();
  if (resultCode && !["0", "00", "03"].includes(resultCode)) {
    throw new AdapterError("KMA ASOS returned a provider status error.", {
      adapterState:
        ["20", "30", "31"].includes(resultCode) ? "AUTH_ERROR" : "INTERNAL_ERROR",
      code:
        ["20", "30", "31"].includes(resultCode)
          ? "PROVIDER_AUTH_ERROR"
          : "KMA_PROVIDER_ERROR",
      retryable: false,
    });
  }
  if (resultCode === "03") return [];
  const nested = payload.response?.body?.items;
  const candidates = [
    nested?.item,
    Array.isArray(nested) ? nested : undefined,
    payload.items?.item,
    Array.isArray(payload.items) ? payload.items : undefined,
  ];
  const items = candidates.find(Array.isArray);
  if (items) return items;
  const totalCount = Number(payload.response?.body?.totalCount);
  if (totalCount === 0 || nested === "" || nested === null) return [];
  throw new SchemaChangedError("KMA ASOS response is missing its item array.");
}

function nullableNumber(value, field, { min, max }) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new SchemaChangedError(`KMA ASOS ${field} is outside its contract.`);
  }
  return number;
}

export function parseKmaAsosDaily(
  payload,
  { stationId, expectedDates } = {},
) {
  const normalizedStationId = String(stationId ?? "").trim();
  if (!/^\d{2,4}$/u.test(normalizedStationId)) {
    throw new TypeError("KMA ASOS stationId is invalid.");
  }
  if (
    !Array.isArray(expectedDates) ||
    expectedDates.length === 0 ||
    expectedDates.some((date) => !/^\d{4}-\d{2}-\d{2}$/u.test(date))
  ) {
    throw new TypeError("KMA ASOS expectedDates are invalid.");
  }

  const expected = new Set(expectedDates);
  const rows = extractKmaItems(payload);
  const matching = rows.filter(
    (row) =>
      String(row?.stnId ?? "").trim() === normalizedStationId &&
      expected.has(String(row?.tm ?? "").trim()),
  );
  const byDate = new Map();
  const stationNames = new Set();
  const qualityFlags = [];
  for (const row of matching) {
    const date = String(row.tm).trim();
    if (byDate.has(date)) {
      throw new SchemaChangedError(
        `KMA ASOS returned duplicate daily data for ${date}.`,
      );
    }
    const stationName = String(row.stnNm ?? "").trim();
    if (!stationName) {
      throw new SchemaChangedError("KMA ASOS station name is missing.");
    }
    stationNames.add(stationName);
    const precipitationText = String(row.sumRn ?? "").trim();
    if (precipitationText === "") {
      qualityFlags.push("ASOS_DRY_DAY_BLANK_INTERPRETED_AS_ZERO");
    }
    byDate.set(date, {
      date,
      stationId: normalizedStationId,
      minTemperature: nullableNumber(row.minTa, "minTa", {
        min: -100,
        max: 100,
      }),
      maxTemperature: nullableNumber(row.maxTa, "maxTa", {
        min: -100,
        max: 100,
      }),
      meanTemperature: nullableNumber(row.avgTa, "avgTa", {
        min: -100,
        max: 100,
      }),
      precipitationAmount:
        precipitationText === ""
          ? 0
          : nullableNumber(row.sumRn, "sumRn", { min: 0, max: 5000 }),
    });
  }
  if (stationNames.size > 1) {
    throw new SchemaChangedError(
      "KMA ASOS response contains conflicting station names.",
    );
  }
  return {
    stationId: normalizedStationId,
    stationName: [...stationNames][0] ?? null,
    readings: expectedDates.flatMap((date) =>
      byDate.has(date) ? [byDate.get(date)] : [],
    ),
    missingDates: expectedDates.filter((date) => !byDate.has(date)),
    qualityFlags: [...new Set(qualityFlags)],
  };
}

function normalizeHeaderLine(line) {
  return line
    .replace(/^\s*#+\s*/u, "")
    .replace(/,?\s*=\s*$/u, "")
    .trim();
}

function parseClimateNumber(value, field, { min, max }) {
  const number = Number(String(value ?? "").trim());
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new SchemaChangedError(
      `KMA climate-normal ${field} is outside its contract.`,
    );
  }
  return number;
}

/**
 * 저장소에 포함된 월별 기후평년값(1991-2020)에서 한 지점을 고른다.
 * 반환 형태는 이전의 실시간 CSV 파서와 동일하게 유지한다.
 */
export function selectKmaClimateNormals(
  dataset = BUNDLED_CLIMATE_NORMALS,
  { stationId } = {},
) {
  const normalizedStationId = String(stationId ?? "").trim();
  if (!/^\d{2,4}$/u.test(normalizedStationId)) {
    throw new TypeError("KMA climate-normal stationId is invalid.");
  }
  if (dataset === null || typeof dataset !== "object") {
    throw new SchemaChangedError("KMA climate-normal dataset must be an object.");
  }
  if (dataset.normalPeriod !== "1991-2020") {
    throw new SchemaChangedError(
      "KMA climate-normal dataset is not the 1991-2020 normal period.",
    );
  }

  const station = dataset.stations?.[normalizedStationId];
  if (station === undefined) {
    throw new NoDataError(
      "KMA climate-normal dataset has no entry for the requested station.",
    );
  }
  const monthlyValues = station.metrics?.meanTemperature;
  if (!Array.isArray(monthlyValues) || monthlyValues.length !== 12) {
    throw new NoDataError(
      "KMA climate-normal dataset does not contain all 12 monthly values.",
    );
  }

  const observations = monthlyValues.map((value, index) => ({
    metric: "meanTemperature",
    month: index + 1,
    value: parseClimateNumber(value, "meanTemperature", {
      min: -100,
      max: 100,
    }),
    unit: "degC",
  }));
  return {
    stationId: normalizedStationId,
    normalPeriod: "1991-2020",
    observations,
    monthlyNormals: observations.map((observation) => ({
      stationId: normalizedStationId,
      month: observation.month,
      meanTemperature: observation.value,
      normalPeriod: "1991-2020",
    })),
  };
}

function envelopeBase({
  sourceId,
  sourceName,
  sourceUrl,
  spatialLevel,
  spatialLabel,
  adapterVersion,
  operationId,
  contractVersion,
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
      providerIssueTime: null,
    },
  };
}

function liveControl({
  now,
  cache,
  singleFlight,
  executionGuard,
  providerControl,
  maxEntries,
  maxTtlMs,
}) {
  const cacheClock = () => new Date(now()).getTime();
  return {
    cacheClock,
    cache:
      cache ??
      new InMemoryAdapterCache({
        maxEntries,
        maxTtlMs,
        now: cacheClock,
      }),
    singleFlight: singleFlight ?? new SingleFlight(),
    executionGuard:
      executionGuard ??
      new ProviderExecutionGuard({
        maxConcurrency: 2,
        maxQueue: 4,
        failureThreshold: 3,
        circuitCooldownMs: 1000,
        ...providerControl,
        provider: "KMA",
        now: providerControl.now ?? cacheClock,
      }),
  };
}

export function createKmaAsosObservationAdapter({
  enabled = false,
  apiKey,
  fetchImpl = globalThis.fetch,
  endpoint = ASOS_ENDPOINT,
  timeoutMs = 5000,
  adapterVersion = "1",
  contractVersion = null,
  cache,
  singleFlight,
  executionGuard,
  providerControl = {},
  cacheFreshForMs = 30 * 60 * 1000,
  now = () => new Date(),
} = {}) {
  const control = liveControl({
    now,
    cache,
    singleFlight,
    executionGuard,
    providerControl,
    maxEntries: 100,
    maxTtlMs: 3 * 60 * 60 * 1000,
  });
  const base = envelopeBase({
    sourceId: "kma-asos-observations",
    sourceName: "기상청 ASOS 최근 일관측",
    sourceUrl: providerDisclosureUrl(endpoint, "KMA"),
    spatialLevel: "OBSERVATION_STATION",
    spatialLabel: "ASOS 관측 지점",
    adapterVersion,
    operationId: "getWthrDataList",
    contractVersion,
  });

  return Object.freeze({
    id: "kmaAsos",
    async getRecent(
      { stationId, completedDays = 7 } = {},
      { signal, deadlineAt } = {},
    ) {
      const dates =
        Number.isInteger(completedDays) && completedDays === 7
          ? completedDates(now, completedDays)
          : [];
      const cacheKey = makeAdapterCacheKey({
        adapterVersion,
        operationId: "getWthrDataList",
        verifiedLocationKey: { stationId: stationId ?? null },
        requestedPeriod: {
          from: dates[0] ?? null,
          to: dates.at(-1) ?? null,
        },
        providerIssueTime: null,
        normalizedParameters: { contractVersion, completedDays },
      });
      return runCachedAdapterCall({
        enabled,
        credential: apiKey,
        contractVersion,
        allowedContractVersions: [VERIFIED_KMA_ASOS_CONTRACT_VERSION],
        envelopeBase: base,
        cache: control.cache,
        singleFlight: control.singleFlight,
        executionGuard: control.executionGuard,
        cacheKey,
        cacheFreshForMs,
        signal,
        deadlineAt,
        now,
        operation: async ({
          signal: upstreamSignal,
          deadlineAt: upstreamDeadlineAt,
        }) => {
          if (dates.length !== 7) {
            throw new TypeError("KMA ASOS requires seven completed days.");
          }
          const url = new URL(endpoint);
          const query = {
            serviceKey: apiKey.trim(),
            pageNo: 1,
            numOfRows: 10,
            dataType: "JSON",
            dataCd: "ASOS",
            dateCd: "DAY",
            startDt: compactDate(dates[0]),
            endDt: compactDate(dates.at(-1)),
            stnIds: String(stationId ?? "").trim(),
          };
          for (const [name, value] of Object.entries(query)) {
            url.searchParams.set(name, String(value));
          }
          const payload = await requestProviderJson({
            fetchImpl,
            url,
            provider: "KMA",
            requestInit: { headers: { Accept: "application/json" } },
            signal: upstreamSignal,
            timeoutMs,
            deadlineAt: upstreamDeadlineAt,
            now: control.cacheClock,
          });
          const parsed = parseKmaAsosDaily(payload, {
            stationId,
            expectedDates: dates,
          });
          if (parsed.readings.length === 0) {
            throw new NoDataError("KMA ASOS returned no completed daily rows.");
          }
          return {
            adapterState: "SUCCESS",
            observedAt: localDayEnd(dates.at(-1)),
            validFrom: localDayStart(dates[0]),
            validTo: localDayEnd(dates.at(-1)),
            qualityFlags: [
              ...parsed.qualityFlags,
              ...(parsed.missingDates.length > 0
                ? ["ASOS_COMPLETED_WINDOW_INCOMPLETE"]
                : []),
            ],
            data: {
              dataRole: "OBSERVATION",
              stationId: parsed.stationId,
              stationName: parsed.stationName,
              readings: parsed.readings,
              monthlyNormals: [],
            },
          };
        },
      });
    },
  });
}

export function createKmaClimateNormalAdapter({
  enabled = false,
  dataset = BUNDLED_CLIMATE_NORMALS,
  adapterVersion = "2",
  contractVersion = null,
  cache,
  singleFlight,
  executionGuard,
  providerControl = {},
  cacheFreshForMs = 30 * DAY_MS,
  now = () => new Date(),
} = {}) {
  const control = liveControl({
    now,
    cache,
    singleFlight,
    executionGuard,
    providerControl,
    maxEntries: 50,
    maxTtlMs: 90 * DAY_MS,
  });
  const base = envelopeBase({
    sourceId: "kma-climate-normal",
    sourceName: "기상청 기후평년 1991~2020",
    sourceUrl: CLIMATE_NORMAL_SOURCE_URL,
    spatialLevel: "NORMAL_STATION",
    spatialLabel: "기후평년 지점",
    adapterVersion,
    operationId: "climate-normal-monthly-bundled",
    contractVersion,
  });

  return Object.freeze({
    id: "kmaClimate",
    async getNormals({ stationId } = {}, { signal, deadlineAt } = {}) {
      const normalizedStationId = String(stationId ?? "").trim();
      const cacheKey = makeAdapterCacheKey({
        adapterVersion,
        operationId: "climate-normal-monthly-bundled",
        verifiedLocationKey: { stationId: normalizedStationId || null },
        requestedPeriod: { normalPeriod: "1991-2020" },
        providerIssueTime: null,
        normalizedParameters: { contractVersion, norm: "M" },
      });
      return runCachedAdapterCall({
        enabled,
        // 저장소에 포함된 정적 데이터라 자격증명이 필요 없다.
        credential: null,
        credentialRequired: false,
        contractVersion,
        allowedContractVersions: [
          VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
        ],
        envelopeBase: base,
        cache: control.cache,
        singleFlight: control.singleFlight,
        executionGuard: control.executionGuard,
        cacheKey,
        cacheFreshForMs,
        signal,
        deadlineAt,
        now,
        operation: async () => {
          const data = selectKmaClimateNormals(dataset, {
            stationId: normalizedStationId,
          });
          return {
            adapterState: "SUCCESS",
            validFrom: "1990-12-31T15:00:00.000Z",
            validTo: "2020-12-31T14:59:59.999Z",
            data: {
              dataRole: "CLIMATE_NORMAL",
              ...data,
            },
          };
        },
      });
    },
  });
}
