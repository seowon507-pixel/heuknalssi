import { randomBytes } from "node:crypto";

import {
  VERIFIED_SOIL_EXAM_CONTRACT_VERSION,
  runCachedAdapterCall,
} from "./adapter-call.js";
import {
  InMemoryAdapterCache,
  SingleFlight,
  hmacCacheValue,
  makeAdapterCacheKey,
} from "./cache.js";
import { createUnavailableEnvelope } from "./data-envelope.js";
import {
  AdapterError,
  NoDataError,
  SchemaChangedError,
} from "./errors.js";
import {
  providerDisclosureUrl,
  requestProviderText,
} from "./network.js";
import { ProviderExecutionGuard } from "./provider-control.js";

const DEFAULT_ENDPOINT =
  "https://apis.data.go.kr/1390802/SoilEnviron/SoilExam/V2/getSoilExam";
const MAX_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const METRIC_CONTRACT = Object.freeze([
  Object.freeze({
    tag: "ACID",
    metric: "PH",
    unit: "pH",
    min: 0,
    max: 14,
  }),
  Object.freeze({
    tag: "ELCD",
    metric: "EC",
    unit: "dS/m",
    min: 0,
    max: 100,
  }),
  Object.freeze({
    tag: "OM",
    metric: "ORGANIC_MATTER",
    unit: "g/kg",
    min: 0,
    max: 1000,
  }),
  Object.freeze({
    tag: "VLDPHA",
    metric: "AVAILABLE_PHOSPHATE",
    unit: "mg/kg",
    min: 0,
    max: 10000,
  }),
  Object.freeze({
    tag: "POSIFERT_K",
    metric: "EXCHANGEABLE_K",
    unit: "cmol+/kg",
    min: 0,
    max: 100,
  }),
  Object.freeze({
    tag: "POSIFERT_CA",
    metric: "EXCHANGEABLE_CA",
    unit: "cmol+/kg",
    min: 0,
    max: 100,
  }),
  Object.freeze({
    tag: "POSIFERT_MG",
    metric: "EXCHANGEABLE_MG",
    unit: "cmol+/kg",
    min: 0,
    max: 100,
  }),
]);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function ensureSafeXml(xml) {
  if (typeof xml !== "string") {
    throw new SchemaChangedError("Soil exam response must be XML text.");
  }
  if (Buffer.byteLength(xml, "utf8") > 2 * 1024 * 1024) {
    throw new SchemaChangedError("Soil exam XML exceeds the parser size limit.");
  }
  if (/<!DOCTYPE|<!ENTITY|\0/iu.test(xml)) {
    throw new SchemaChangedError(
      "Soil exam XML contains a forbidden declaration.",
    );
  }
}

function decodeXmlText(value, field) {
  if (/<[^>]+>/u.test(value)) {
    throw new SchemaChangedError(`${field} must contain text only.`);
  }
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&")
    .trim();
}

function extractField(xml, tagName, field = tagName) {
  const tag = escapeRegex(tagName);
  const regex = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${tag}\\s*>`,
    "iu",
  );
  const match = regex.exec(xml);
  return match ? decodeXmlText(match[1], field) : null;
}

function providerResultCode(xml) {
  return (
    extractField(xml, "Result_Code", "soil exam result code") ??
    extractField(xml, "result_Code", "soil exam result code") ??
    extractField(xml, "resultCode", "soil exam result code")
  );
}

function validateProviderResult(xml) {
  const code = providerResultCode(xml);
  if (["200", "00", "0"].includes(code)) return;
  if (["301", "03"].includes(code)) {
    throw new NoDataError("Soil exam service returned no parcel result.");
  }
  if (["101", "20", "30", "31"].includes(code)) {
    throw new AdapterError("Soil exam service rejected the service key.", {
      adapterState: "AUTH_ERROR",
      code: "PROVIDER_AUTH_ERROR",
      retryable: false,
    });
  }
  if (code === null) {
    throw new SchemaChangedError(
      "Soil exam response is missing its result code.",
    );
  }
  throw new AdapterError(
    "Soil exam service returned a provider status error.",
    {
      adapterState: "INTERNAL_ERROR",
      code: "PROVIDER_STATUS_ERROR",
      retryable: ["500", "600"].includes(code),
    },
  );
}

function extractSingleItem(xml) {
  const rows = [
    ...xml.matchAll(
      /<(?:[A-Za-z_][\w.-]*:)?item(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?item\s*>/giu,
    ),
  ].map((match) => match[1]);
  if (rows.length === 0) {
    throw new NoDataError("Soil exam response contains no parcel row.");
  }
  if (rows.length !== 1) {
    throw new SchemaChangedError(
      "Soil exam response must contain exactly one latest parcel row.",
    );
  }
  return rows[0];
}

function requirePnu(value, field = "pnuCode") {
  const normalized = String(value ?? "").trim();
  if (!/^\d{19}$/u.test(normalized)) {
    throw new TypeError(`${field} must contain a 19-digit PNU.`);
  }
  return normalized;
}

function nullableMeasurement(row, contract) {
  const raw = extractField(row, contract.tag, contract.metric);
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value < contract.min ||
    value > contract.max
  ) {
    throw new SchemaChangedError(
      `Soil exam ${contract.metric} is outside its frozen contract.`,
    );
  }
  return {
    metric: contract.metric,
    unit: contract.unit,
    boundarySemanticsVerified: true,
    totalValidArea: 1,
    areaUnit: "MEASURED_POINT",
    intervals: [
      {
        lower: value,
        upper: value,
        lowerInclusive: true,
        upperInclusive: true,
        area: 1,
        areaUnit: "MEASURED_POINT",
      },
    ],
  };
}

function normalizeExamDate(value) {
  const normalized = String(value ?? "").trim().replaceAll("-", "");
  if (!/^\d{8}$/u.test(normalized)) {
    throw new SchemaChangedError(
      "Soil exam sample date must use YYYYMMDD.",
    );
  }
  const year = Number(normalized.slice(0, 4));
  const month = Number(normalized.slice(4, 6));
  const day = Number(normalized.slice(6, 8));
  const isoDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    throw new SchemaChangedError("Soil exam sample date is invalid.");
  }
  return isoDate;
}

/**
 * Parses the latest field test without returning the PNU or address.
 * Missing chemistry values stay missing; no regional statistic is substituted.
 */
export function parseSoilExam(xml, { expectedPnu } = {}) {
  const requestedPnu = requirePnu(expectedPnu, "expectedPnu");
  ensureSafeXml(xml);
  validateProviderResult(xml);
  const row = extractSingleItem(xml);
  const responsePnu = requirePnu(
    extractField(row, "PNU_Cd", "soil exam PNU"),
    "response PNU",
  );
  if (responsePnu !== requestedPnu) {
    throw new SchemaChangedError(
      "Soil exam response does not match the requested parcel.",
    );
  }
  const metrics = METRIC_CONTRACT.map((contract) =>
    nullableMeasurement(row, contract),
  ).filter(Boolean);
  if (metrics.length === 0) {
    throw new NoDataError(
      "Soil exam response contains no supported chemistry measurement.",
    );
  }
  return {
    dataRole: "PROVIDER_SOIL_TEST",
    sampledOn: normalizeExamDate(
      extractField(row, "Exam_Day", "soil exam sample date"),
    ),
    examType: extractField(row, "Exam_Type", "soil exam type") || null,
    metrics,
  };
}

export function createSoilExamAdapter({
  enabled = false,
  apiKey,
  contractVersion = null,
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  timeoutMs = 3000,
  adapterVersion = "1",
  cache,
  singleFlight,
  executionGuard,
  providerControl = {},
  cacheFreshForMs = MAX_CACHE_TTL_MS,
  cacheKeySecret = randomBytes(32),
  now = () => new Date(),
} = {}) {
  if (
    !Number.isFinite(cacheFreshForMs) ||
    cacheFreshForMs < 0 ||
    cacheFreshForMs > MAX_CACHE_TTL_MS
  ) {
    throw new TypeError(
      "Soil exam cacheFreshForMs must be between 0 and 2592000000.",
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
      provider: "SOIL_EXAM_V2",
      now: providerControl.now ?? cacheClock,
    });
  const envelopeBase = {
    sourceId: "soil-exam-v2",
    sourceName: "토양검정 화학성 상세정보 V2",
    sourceUrl: providerDisclosureUrl(endpoint, "SOIL_EXAM_V2"),
    observedAt: null,
    issuedAt: null,
    validFrom: null,
    validTo: null,
    spatialLevel: "FIELD",
    spatialLabel: "선택 필지 최근 토양검정",
    distanceKm: null,
    unit: null,
    provenance: {
      adapterId: "soil-exam-v2",
      adapterVersion,
      operationId: "getSoilExam",
      contractVersion,
      providerIssueTime: null,
    },
  };

  return Object.freeze({
    id: "soilExam",
    async getLatestExam({ pnuCode } = {}, { signal, deadlineAt } = {}) {
      let normalizedPnu = null;
      try {
        normalizedPnu = requirePnu(pnuCode);
      } catch {
        return createUnavailableEnvelope(envelopeBase, {
          adapterState: "UNSUPPORTED",
          qualityFlags: ["FIELD_PNU_UNAVAILABLE"],
          now,
        });
      }
      const cacheKey = makeAdapterCacheKey({
        adapterVersion,
        operationId: "getSoilExam",
        verifiedLocationKey: null,
        requestedPeriod: { latestWithinYears: 3 },
        providerIssueTime: null,
        normalizedParameters: {
          contractVersion,
          pnuHmac: hmacCacheValue(normalizedPnu, cacheKeySecret),
        },
      });
      return runCachedAdapterCall({
        enabled,
        credential: apiKey,
        contractVersion,
        allowedContractVersions: [
          VERIFIED_SOIL_EXAM_CONTRACT_VERSION,
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
          deadlineAt: upstreamDeadlineAt,
        }) => {
          const url = new URL(endpoint);
          url.searchParams.set("serviceKey", apiKey.trim());
          url.searchParams.set("PNU_CD", normalizedPnu);
          const xml = await requestProviderText({
            fetchImpl,
            url,
            provider: "SOIL_EXAM_V2",
            requestInit: {
              headers: { Accept: "application/xml, text/xml" },
            },
            signal: upstreamSignal,
            timeoutMs,
            deadlineAt: upstreamDeadlineAt,
            now: cacheClock,
          });
          const data = parseSoilExam(xml, {
            expectedPnu: normalizedPnu,
          });
          return {
            adapterState: "SUCCESS",
            observedAt: new Date(
              `${data.sampledOn}T00:00:00+09:00`,
            ).toISOString(),
            qualityFlags: ["FIELD_SOIL_EXAM_LATEST_WITHIN_THREE_YEARS"],
            data,
          };
        },
      });
    },
  });
}
