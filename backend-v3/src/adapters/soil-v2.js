import {
  VERIFIED_SOIL_V2_CONTRACT_VERSION,
  runCachedAdapterCall,
} from "./adapter-call.js";
import {
  InMemoryAdapterCache,
  SingleFlight,
  makeAdapterCacheKey,
} from "./cache.js";
import { createUnavailableEnvelope } from "./data-envelope.js";
import {
  AdapterError,
  NoDataError,
  SchemaChangedError,
  UnsupportedContractError,
} from "./errors.js";
import {
  providerDisclosureUrl,
  requestProviderText,
} from "./network.js";
import { ProviderExecutionGuard } from "./provider-control.js";
import {
  requireFiniteNumber,
  requireNonEmptyString,
} from "./strict-values.js";

const DEFAULT_ENDPOINT =
  "https://apis.data.go.kr/1390802/SoilEnviron/SoilExamStat/V2/getFarmExamPhInfo";
const MAX_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PH_OPEN_FIELD_INTERVALS = Object.freeze([
  Object.freeze({ lower: 0, upper: 4.5, lowerInclusive: true, upperInclusive: true }),
  Object.freeze({ lower: 4.5, upper: 5.0, lowerInclusive: false, upperInclusive: true }),
  Object.freeze({ lower: 5.0, upper: 5.5, lowerInclusive: false, upperInclusive: true }),
  Object.freeze({ lower: 5.5, upper: 6.0, lowerInclusive: false, upperInclusive: true }),
  Object.freeze({ lower: 6.0, upper: 6.5, lowerInclusive: false, upperInclusive: true }),
  Object.freeze({ lower: 6.5, upper: 14, lowerInclusive: false, upperInclusive: true }),
]);

const PH_FACILITY_INTERVALS = Object.freeze([
  Object.freeze({ lower: 0, upper: 5.0, lowerInclusive: true, upperInclusive: true }),
  Object.freeze({ lower: 5.0, upper: 5.5, lowerInclusive: false, upperInclusive: true }),
  Object.freeze({ lower: 5.5, upper: 6.0, lowerInclusive: false, upperInclusive: true }),
  Object.freeze({ lower: 6.0, upper: 6.5, lowerInclusive: false, upperInclusive: true }),
  Object.freeze({ lower: 6.5, upper: 7.0, lowerInclusive: false, upperInclusive: true }),
  Object.freeze({ lower: 7.0, upper: 14, lowerInclusive: false, upperInclusive: true }),
]);

const CANONICAL_SOIL_V2_CONTRACT = Object.freeze({
  frozen: true,
  version: VERIFIED_SOIL_V2_CONTRACT_VERSION,
  rowTag: "item",
  responseFields: Object.freeze({
    resultCode: "result_Code",
    areaCode: "stdg_Cd",
    areaName: "bjd_Nm",
  }),
  landUses: Object.freeze({
    PFLD: Object.freeze({
      areaFields: Object.freeze([
        "acid_Pfld1_Area",
        "acid_Pfld2_Area",
        "acid_Pfld3_Area",
        "acid_Pfld4_Area",
        "acid_Pfld5_Area",
        "acid_Pfld6_Area",
      ]),
      intervals: PH_OPEN_FIELD_INTERVALS,
    }),
    FACHS: Object.freeze({
      areaFields: Object.freeze([
        "acid_Fachs1_Area",
        "acid_Fachs2_Area",
        "acid_Fachs3_Area",
        "acid_Fachs4_Area",
        "acid_Fachs5_Area",
        "acid_Fachs6_Area",
      ]),
      intervals: PH_FACILITY_INTERVALS,
    }),
    FRUIT: Object.freeze({
      areaFields: Object.freeze([
        "acid_Fruit1_Area",
        "acid_Fruit2_Area",
        "acid_Fruit3_Area",
        "acid_Fruit4_Area",
        "acid_Fruit5_Area",
        "acid_Fruit6_Area",
      ]),
      intervals: PH_OPEN_FIELD_INTERVALS,
    }),
  }),
  supportedMetrics: Object.freeze(["PH"]),
  metricUnits: Object.freeze({ PH: "pH" }),
  requestFields: Object.freeze({ areaCode: "STDG_CD" }),
  areaUnit: "ha",
  areaSumTolerance: 0,
  provenance: Object.freeze({
    datasetId: "15144685",
    specificationVersion: "1.0.0",
    providerUpdatedAt: "2025-11-04",
  }),
});

export const VERIFIED_SOIL_V2_CONTRACT = CANONICAL_SOIL_V2_CONTRACT;

function hasExactCanonicalValue(value, canonical) {
  if (Object.is(value, canonical)) return true;
  if (Array.isArray(canonical)) {
    if (!Array.isArray(value) || value.length !== canonical.length) return false;
    if (Reflect.ownKeys(value).length !== Reflect.ownKeys(canonical).length) {
      return false;
    }
    return canonical.every((entry, index) =>
      hasExactCanonicalValue(value[index], entry),
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
  if (valuePrototype !== Object.prototype && valuePrototype !== null) {
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
      "Soil V2 contract version is not in the verified allowlist.",
    );
  }
  if (!hasExactCanonicalValue(contract, CANONICAL_SOIL_V2_CONTRACT)) {
    throw new UnsupportedContractError(
      "Soil V2 contract does not match the verified official schema.",
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
      "Soil V2 XML contains a forbidden DTD or entity declaration.",
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
    "gi",
  );
  return [...xml.matchAll(regex)].map((match) => match[1]);
}

function extractField(row, tagName, field) {
  const tag = escapeRegex(tagName);
  const regex = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${tag}\\s*>`,
    "i",
  );
  const match = regex.exec(row);
  if (!match) return null;
  return decodeXmlText(match[1], field);
}

function validateProviderResult(xml, contract) {
  const code = extractField(
    xml,
    contract.responseFields.resultCode,
    "Soil V2 result code",
  );
  if (code === "200") return;
  if (code === "301") {
    throw new NoDataError("Soil V2 returned no regional pH data.");
  }
  if (code === "101") {
    throw new AdapterError("Soil V2 rejected the service key.", {
      adapterState: "AUTH_ERROR",
      code: "PROVIDER_AUTH_ERROR",
      retryable: false,
    });
  }
  if (code === null) {
    throw new SchemaChangedError("Soil V2 response is missing its result code.");
  }
  throw new AdapterError("Soil V2 returned a provider status error.", {
    adapterState: "INTERNAL_ERROR",
    code: "PROVIDER_STATUS_ERROR",
    retryable: ["500", "600"].includes(code),
  });
}

function parsePhMetric(row, contract, landUse) {
  const profile = contract.landUses[landUse];
  if (!profile) {
    throw new UnsupportedContractError("Soil V2 land use is unsupported.");
  }
  const intervals = profile.areaFields.map((field, index) => {
    const area = requireFiniteNumber(extractField(row, field, field), {
      field: `Soil V2 ${field}`,
      min: 0,
    });
    return {
      ...profile.intervals[index],
      area,
      areaUnit: contract.areaUnit,
    };
  });
  const totalValidArea = intervals.reduce(
    (sum, interval) => sum + interval.area,
    0,
  );
  if (totalValidArea === 0) {
    throw new NoDataError("Soil V2 pH distribution has zero valid area.");
  }
  return {
    metric: "PH",
    unit: contract.metricUnits.PH,
    intervals,
    totalValidArea,
    areaUnit: contract.areaUnit,
    boundarySemanticsVerified: true,
    areaToleranceVerified: true,
    areaTolerance: contract.areaSumTolerance,
  };
}

/**
 * Parses the official data.go.kr 15144685 pH area distribution. It keeps the
 * provider's six intervals and never manufactures a representative field pH.
 */
export function parseSoilV2(
  xml,
  { contract, landUse, requestedAreaCode } = {},
) {
  const frozenContract = validateSoilV2Contract(contract);
  ensureSafeXml(xml);
  validateProviderResult(xml, frozenContract);
  const rows = extractRows(xml, frozenContract.rowTag);
  if (rows.length === 0) {
    throw new NoDataError("Soil V2 response contains no pH distribution row.");
  }
  if (rows.length !== 1) {
    throw new SchemaChangedError(
      "Soil V2 regional pH response must contain exactly one row.",
    );
  }
  const row = rows[0];
  const areaCode = requireNonEmptyString(
    extractField(
      row,
      frozenContract.responseFields.areaCode,
      "Soil V2 legal area code",
    ),
    "Soil V2 legal area code",
  );
  if (!/^\d{10}$/.test(areaCode)) {
    throw new SchemaChangedError("Soil V2 legal area code must be 10 digits.");
  }
  if (
    typeof requestedAreaCode === "string" &&
    areaCode !== requestedAreaCode.trim()
  ) {
    throw new SchemaChangedError(
      "Soil V2 response area does not match the requested legal area.",
    );
  }
  const areaName = requireNonEmptyString(
    extractField(
      row,
      frozenContract.responseFields.areaName,
      "Soil V2 legal area name",
    ),
    "Soil V2 legal area name",
  );

  return {
    contractVersion: frozenContract.version,
    areaCode,
    areaName,
    landUse,
    metrics: [parsePhMetric(row, frozenContract, landUse)],
  };
}

export function createSoilV2Adapter({
  enabled = false,
  apiKey,
  contract,
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  timeoutMs = 3000,
  adapterVersion = "2",
  cache,
  singleFlight,
  executionGuard,
  providerControl = {},
  cacheFreshForMs = MAX_CACHE_TTL_MS,
  now = () => new Date(),
} = {}) {
  if (
    !Number.isFinite(cacheFreshForMs) ||
    cacheFreshForMs < 0 ||
    cacheFreshForMs > MAX_CACHE_TTL_MS
  ) {
    throw new TypeError(
      "Soil V2 cacheFreshForMs must be between 0 and 604800000.",
    );
  }
  const cacheClock = () => new Date(now()).getTime();
  const liveCache =
    cache ??
    new InMemoryAdapterCache({
      maxEntries: 100,
      maxTtlMs: MAX_CACHE_TTL_MS,
      now: cacheClock,
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
      now: providerControl.now ?? cacheClock,
    });
  const envelopeBase = {
    sourceId: "soil-v2",
    sourceName: "농경지화학성 통계정보 V2",
    sourceUrl: providerDisclosureUrl(endpoint, "SOIL_V2"),
    observedAt: null,
    issuedAt: null,
    validFrom: null,
    validTo: null,
    spatialLevel: "REGIONAL_SOIL_STAT",
    spatialLabel: "법정동 토양 pH 면적통계",
    distanceKm: null,
    unit: null,
    provenance: {
      adapterId: "soil-v2",
      adapterVersion,
      operationId: "getFarmExamPhInfo",
      contractVersion: contract?.version ?? null,
      providerIssueTime: null,
    },
  };

  return Object.freeze({
    id: "soilV2",
    async getDistribution(
      { verifiedSoilAreaCode, landUse } = {},
      { signal, deadlineAt } = {},
    ) {
      if (
        enabled === true &&
        (typeof verifiedSoilAreaCode !== "string" ||
          !/^\d{10}$/.test(verifiedSoilAreaCode.trim()))
      ) {
        return createUnavailableEnvelope(envelopeBase, {
          adapterState: "UNSUPPORTED",
          qualityFlags: ["VERIFIED_SOIL_AREA_CODE_MISSING"],
          now,
        });
      }
      if (
        enabled === true &&
        (typeof landUse !== "string" ||
          !Object.hasOwn(CANONICAL_SOIL_V2_CONTRACT.landUses, landUse))
      ) {
        return createUnavailableEnvelope(envelopeBase, {
          adapterState: "UNSUPPORTED",
          qualityFlags: ["SOIL_LAND_USE_UNSUPPORTED"],
          now,
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
              now,
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
        operationId: "getFarmExamPhInfo",
        verifiedLocationKey: { soilAreaCode: normalizedAreaCode },
        requestedPeriod: null,
        providerIssueTime: null,
        normalizedParameters: {
          contractVersion: contract?.version ?? null,
          landUse,
        },
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
          deadlineAt: upstreamDeadlineAt,
        }) => {
          const frozenContract = validateSoilV2Contract(contract);
          const areaCode = requireNonEmptyString(
            verifiedSoilAreaCode,
            "verifiedSoilAreaCode",
          );
          const url = new URL(endpoint);
          url.searchParams.set("serviceKey", apiKey.trim());
          url.searchParams.set(
            frozenContract.requestFields.areaCode,
            areaCode,
          );
          const xml = await requestProviderText({
            fetchImpl,
            url,
            provider: "SOIL_V2",
            requestInit: {
              headers: { Accept: "application/xml, text/xml" },
            },
            signal: upstreamSignal,
            timeoutMs,
            deadlineAt: upstreamDeadlineAt,
            now: cacheClock,
          });
          const data = parseSoilV2(xml, {
            contract: frozenContract,
            landUse,
            requestedAreaCode: areaCode,
          });
          return {
            adapterState: "SUCCESS",
            data,
          };
        },
      });
    },
  });
}
