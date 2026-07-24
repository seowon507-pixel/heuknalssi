import {
  VERIFIED_SOIL_V2_CONTRACT_VERSION,
  runCachedAdapterCall
} from "./adapter-call.js";
import {
  InMemoryAdapterCache,
  SingleFlight,
  makeAdapterCacheKey
} from "./cache.js";
import {
  createUnavailableEnvelope
} from "./data-envelope.js";
import {
  NoDataError,
  SchemaChangedError,
  UnsupportedContractError
} from "./errors.js";
import {
  providerDisclosureUrl,
  requestProviderText
} from "./network.js";
import { ProviderExecutionGuard } from "./provider-control.js";
import {
  parseStrictBoolean,
  requireFiniteNumber,
  requireNonEmptyString
} from "./strict-values.js";

const DEFAULT_ENDPOINT =
  "https://apis.data.go.kr/1390802/SoilEnviron/SoilExam/getSoilExam";
const MAX_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Provider request/response semantics are code-reviewed and fixed here.
// Credentials, endpoint selection, and dataset year remain separate inputs.
const CANONICAL_SOIL_V2_CONTRACT = Object.freeze({
  frozen: true,
  version: VERIFIED_SOIL_V2_CONTRACT_VERSION,
  rowTag: "item",
  fields: Object.freeze({
    metric: "metric",
    lower: "lower",
    upper: "upper",
    lowerInclusive: "lowerInclusive",
    upperInclusive: "upperInclusive",
    area: "area",
    areaUnit: "areaUnit",
    totalValidArea: "totalValidArea"
  }),
  supportedMetrics: Object.freeze(["PH"]),
  metricUnits: Object.freeze({
    PH: "pH"
  }),
  requestFields: Object.freeze({
    areaCode: "areaCode",
    year: "year"
  }),
  allowedAreaUnits: Object.freeze(["ha"]),
  areaSumTolerance: 0
});

function hasExactCanonicalValue(value, canonical) {
  if (Object.is(value, canonical)) return true;
  if (Array.isArray(canonical)) {
    if (!Array.isArray(value) || value.length !== canonical.length) {
      return false;
    }
    if (Reflect.ownKeys(value).length !== Reflect.ownKeys(canonical).length) {
      return false;
    }
    return canonical.every((entry, index) =>
      hasExactCanonicalValue(value[index], entry)
    );
  }
  if (
    canonical === null ||
    typeof canonical !== "object" ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const valuePrototype = Object.getPrototypeOf(value);
  if (
    valuePrototype !== Object.prototype &&
    valuePrototype !== null
  ) {
    return false;
  }
  const canonicalKeys = Reflect.ownKeys(canonical);
  const valueKeys = Reflect.ownKeys(value);
  if (valueKeys.length !== canonicalKeys.length) return false;
  return canonicalKeys.every((key) => {
    if (!Object.hasOwn(value, key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return false;
    }
    return hasExactCanonicalValue(descriptor.value, canonical[key]);
  });
}

export function validateSoilV2Contract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new UnsupportedContractError("Soil V2 contract is missing.");
  }
  if (contract.frozen !== true) {
    throw new UnsupportedContractError("Soil V2 contract is not frozen.");
  }
  if (contract.version !== VERIFIED_SOIL_V2_CONTRACT_VERSION) {
    throw new UnsupportedContractError(
      "Soil V2 contract version is not in the verified allowlist."
    );
  }
  if (!hasExactCanonicalValue(contract, CANONICAL_SOIL_V2_CONTRACT)) {
    throw new UnsupportedContractError(
      "Soil V2 contract does not match the verified canonical fixture."
    );
  }
  return CANONICAL_SOIL_V2_CONTRACT;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureSafeXml(xml) {
  if (typeof xml !== "string") {
    throw new SchemaChangedError("Soil V2 response must be XML text.");
  }
  if (Buffer.byteLength(xml, "utf8") > 2 * 1024 * 1024) {
    throw new SchemaChangedError("Soil V2 XML exceeds the parser size limit.");
  }
  if (/<!DOCTYPE|<!ENTITY|\0/i.test(xml)) {
    throw new SchemaChangedError(
      "Soil V2 XML contains a forbidden DTD or entity declaration."
    );
  }
}

function decodeXmlText(value, field) {
  if (/<[^>]+>/.test(value)) {
    throw new SchemaChangedError(`${field} must contain text only.`);
  }
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function extractRows(xml, rowTag) {
  const tag = escapeRegex(rowTag);
  const regex = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${tag}\\s*>`,
    "gi"
  );
  return [...xml.matchAll(regex)].map((match) => match[1]);
}

function extractField(row, tagName, field) {
  const tag = escapeRegex(tagName);
  const regex = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${tag}\\s*>`,
    "i"
  );
  const match = regex.exec(row);
  if (!match) return null;
  return decodeXmlText(match[1], field);
}

function intervalFromRow(row, contract, index) {
  const get = (field) =>
    extractField(
      row,
      contract.fields[field],
      `Soil V2 row ${index} ${field}`
    );
  const metric = requireNonEmptyString(
    get("metric"),
    `Soil V2 row ${index} metric`
  );
  if (!contract.supportedMetrics.includes(metric)) {
    throw new SchemaChangedError(
      `Soil V2 row ${index} contains an unsupported metric.`
    );
  }
  const lower = requireFiniteNumber(get("lower"), {
    field: `Soil V2 row ${index} lower`
  });
  const upper = requireFiniteNumber(get("upper"), {
    field: `Soil V2 row ${index} upper`
  });
  if (lower >= upper) {
    throw new SchemaChangedError(
      `Soil V2 row ${index} has an empty or inverted interval.`
    );
  }
  const area = requireFiniteNumber(get("area"), {
    field: `Soil V2 row ${index} area`,
    min: 0
  });
  const areaUnit = requireNonEmptyString(
    get("areaUnit"),
    `Soil V2 row ${index} areaUnit`
  );
  const totalValidArea = requireFiniteNumber(get("totalValidArea"), {
    field: `Soil V2 row ${index} totalValidArea`,
    min: 0
  });

  return {
    metric,
    totalValidArea,
    interval: {
      lower,
      upper,
      lowerInclusive: parseStrictBoolean(
        get("lowerInclusive"),
        `Soil V2 row ${index} lowerInclusive`
      ),
      upperInclusive: parseStrictBoolean(
        get("upperInclusive"),
        `Soil V2 row ${index} upperInclusive`
      ),
      area,
      areaUnit
    }
  };
}

function validateMetricDistribution(metric, group, contract) {
  const totals = [...new Set(group.map((row) => row.totalValidArea))];
  if (totals.length !== 1) {
    throw new SchemaChangedError(
      `Soil V2 ${metric} rows disagree on total valid area.`
    );
  }
  const totalValidArea = totals[0];
  if (totalValidArea === 0) {
    throw new NoDataError(`Soil V2 ${metric} has zero valid area.`);
  }
  const units = [...new Set(group.map((row) => row.interval.areaUnit))];
  if (units.length !== 1) {
    throw new SchemaChangedError(`Soil V2 ${metric} mixes area units.`);
  }
  if (
    Array.isArray(contract.allowedAreaUnits) &&
    !contract.allowedAreaUnits.includes(units[0])
  ) {
    throw new SchemaChangedError(`Soil V2 ${metric} has an unexpected area unit.`);
  }

  const seen = new Set();
  for (const row of group) {
    const interval = row.interval;
    const key = [
      interval.lower,
      interval.upper,
      interval.lowerInclusive,
      interval.upperInclusive
    ].join("|");
    if (seen.has(key)) {
      throw new SchemaChangedError(`Soil V2 ${metric} has a duplicate interval.`);
    }
    seen.add(key);
  }
  const sorted = group
    .map((row) => row.interval)
    .sort(
      (left, right) =>
        left.lower - right.lower || left.upper - right.upper
    );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (
      current.lower < previous.upper ||
      (current.lower === previous.upper &&
        current.lowerInclusive &&
        previous.upperInclusive)
    ) {
      throw new SchemaChangedError(
        `Soil V2 ${metric} has overlapping intervals.`
      );
    }
  }

  const areaSum = group.reduce((sum, row) => sum + row.interval.area, 0);
  if (Math.abs(areaSum - totalValidArea) > contract.areaSumTolerance) {
    throw new SchemaChangedError(
      `Soil V2 ${metric} interval area sum does not match total valid area.`
    );
  }

  return {
    metric,
    unit: contract.metricUnits[metric],
    intervals: group.map((row) => ({ ...row.interval })),
    totalValidArea,
    areaUnit: units[0],
    boundarySemanticsVerified: true,
    areaToleranceVerified: true,
    areaTolerance: contract.areaSumTolerance
  };
}

/**
 * Parses only a caller-supplied, explicitly frozen XML contract. There are no
 * default field guesses and no representative scalar is ever synthesized.
 */
export function parseSoilV2(xml, { contract } = {}) {
  const frozenContract = validateSoilV2Contract(contract);
  ensureSafeXml(xml);
  const rows = extractRows(xml, frozenContract.rowTag);
  if (rows.length === 0) {
    throw new NoDataError("Soil V2 response contains no interval rows.");
  }

  const byMetric = new Map();
  rows.forEach((row, index) => {
    const parsed = intervalFromRow(row, frozenContract, index);
    const group = byMetric.get(parsed.metric) ?? [];
    group.push(parsed);
    byMetric.set(parsed.metric, group);
  });

  return {
    contractVersion: frozenContract.version,
    metrics: [...byMetric.entries()].map(([metric, group]) =>
      validateMetricDistribution(metric, group, frozenContract)
    )
  };
}

export function createSoilV2Adapter({
  enabled = false,
  apiKey,
  contract,
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  timeoutMs = 3000,
  adapterVersion = "1",
  defaultYear = null,
  cache,
  singleFlight,
  executionGuard,
  providerControl = {},
  cacheFreshForMs = MAX_CACHE_TTL_MS,
  now = () => new Date()
} = {}) {
  if (
    !Number.isFinite(cacheFreshForMs) ||
    cacheFreshForMs < 0 ||
    cacheFreshForMs > MAX_CACHE_TTL_MS
  ) {
    throw new TypeError(
      "Soil V2 cacheFreshForMs must be between 0 and 604800000."
    );
  }
  const cacheClock = () => new Date(now()).getTime();
  const liveCache =
    cache ??
    new InMemoryAdapterCache({
      maxEntries: 100,
      maxTtlMs: MAX_CACHE_TTL_MS,
      now: cacheClock
    });
  const liveSingleFlight = singleFlight ?? new SingleFlight();
  const liveExecutionGuard =
    executionGuard ??
    new ProviderExecutionGuard({
      maxConcurrency: 2,
      maxQueue: 4,
      failureThreshold: 3,
      circuitCooldownMs: 1000,
      ...providerControl,
      provider: "SOIL_V2",
      now: providerControl.now ?? cacheClock
    });
  const envelopeBase = {
    sourceId: "soil-v2",
    sourceName: "농경지 토양화학성 V2",
    sourceUrl: providerDisclosureUrl(endpoint, "SOIL_V2"),
    observedAt: null,
    issuedAt: null,
    validFrom: null,
    validTo: null,
    spatialLevel: "REGIONAL_SOIL_STAT",
    spatialLabel: "지역 토양 면적통계",
    distanceKm: null,
    unit: null,
    provenance: {
      adapterId: "soil-v2",
      adapterVersion,
      operationId: "get-regional-soil-distribution",
      contractVersion: contract?.version ?? null,
      providerIssueTime: null
    }
  };

  return Object.freeze({
    id: "soilV2",
    async getDistribution(
      { verifiedSoilAreaCode, year } = {},
      { signal, deadlineAt } = {}
    ) {
      if (
        enabled === true &&
        (typeof verifiedSoilAreaCode !== "string" ||
          verifiedSoilAreaCode.trim() === "")
      ) {
        return createUnavailableEnvelope(envelopeBase, {
          adapterState: "UNSUPPORTED",
          qualityFlags: ["VERIFIED_SOIL_AREA_CODE_MISSING"],
          now
        });
      }
      const requestedYear = year ?? defaultYear;
      if (
        enabled === true &&
        (!Number.isInteger(requestedYear) ||
          requestedYear < 1900 ||
          requestedYear > 2200)
      ) {
        return createUnavailableEnvelope(envelopeBase, {
          adapterState: "UNSUPPORTED",
          qualityFlags: ["SOIL_DATASET_YEAR_UNAVAILABLE"],
          now
        });
      }

      if (enabled === true) {
        try {
          validateSoilV2Contract(contract);
        } catch (error) {
          if (error instanceof UnsupportedContractError) {
            return createUnavailableEnvelope(envelopeBase, {
              adapterState: "UNSUPPORTED",
              qualityFlags: ["PROVIDER_CONTRACT_UNSUPPORTED"],
              now
            });
          }
          throw error;
        }
      }

      const normalizedAreaCode =
        typeof verifiedSoilAreaCode === "string"
          ? verifiedSoilAreaCode.trim()
          : null;
      const cacheKey = makeAdapterCacheKey({
        adapterVersion,
        operationId: "get-regional-soil-distribution",
        verifiedLocationKey: { soilAreaCode: normalizedAreaCode },
        requestedPeriod: { year: requestedYear },
        providerIssueTime: null,
        normalizedParameters: {
          contractVersion: contract?.version ?? null
        }
      });

      return runCachedAdapterCall({
        enabled,
        credential: apiKey,
        contractVersion: contract?.version,
        allowedContractVersions: [VERIFIED_SOIL_V2_CONTRACT_VERSION],
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
          const frozenContract = validateSoilV2Contract(contract);
          const areaCode = requireNonEmptyString(
            verifiedSoilAreaCode,
            "verifiedSoilAreaCode"
          );
          const url = new URL(endpoint);
          url.searchParams.set("serviceKey", apiKey.trim());
          url.searchParams.set(
            frozenContract.requestFields.areaCode,
            areaCode
          );
          url.searchParams.set(
            frozenContract.requestFields.year,
            String(requestedYear)
          );
          const xml = await requestProviderText({
            fetchImpl,
            url,
            provider: "SOIL_V2",
            requestInit: {
              headers: {
                Accept: "application/xml, text/xml"
              }
            },
            signal: upstreamSignal,
            timeoutMs,
            deadlineAt: upstreamDeadlineAt,
            now: cacheClock
          });
          const data = parseSoilV2(xml, { contract: frozenContract });
          return {
            adapterState: "SUCCESS",
            data: {
              requestedYear,
              ...data
            }
          };
        }
      });
    }
  });
}
