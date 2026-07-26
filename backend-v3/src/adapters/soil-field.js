import { randomBytes } from "node:crypto";

import {
  VERIFIED_SOIL_FIELD_CONTRACT_VERSION,
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
  "https://apis.data.go.kr/1390802/SoilEnviron/SoilCharac/V3/getSoilCharacter";
const MAX_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function ensureSafeXml(xml) {
  if (typeof xml !== "string") {
    throw new SchemaChangedError(
      "Soil field-character response must be XML text.",
    );
  }
  if (Buffer.byteLength(xml, "utf8") > 2 * 1024 * 1024) {
    throw new SchemaChangedError(
      "Soil field-character XML exceeds the parser size limit.",
    );
  }
  if (/<!DOCTYPE|<!ENTITY|\0/iu.test(xml)) {
    throw new SchemaChangedError(
      "Soil field-character XML contains a forbidden declaration.",
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

function extractResultCode(xml) {
  return (
    extractField(xml, "Result_Code", "soil field result code") ??
    extractField(xml, "result_Code", "soil field result code")
  );
}

function validateProviderResult(xml) {
  const code = extractResultCode(xml);
  if (code === "200") return;
  if (code === "301") {
    throw new NoDataError(
      "Soil field-character service returned no parcel data.",
    );
  }
  if (code === "101") {
    throw new AdapterError(
      "Soil field-character service rejected the service key.",
      {
        adapterState: "AUTH_ERROR",
        code: "PROVIDER_AUTH_ERROR",
        retryable: false,
      },
    );
  }
  if (code === null) {
    throw new SchemaChangedError(
      "Soil field-character response is missing its result code.",
    );
  }
  throw new AdapterError(
    "Soil field-character service returned a provider status error.",
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
    throw new NoDataError(
      "Soil field-character response contains no parcel row.",
    );
  }
  if (rows.length !== 1) {
    throw new SchemaChangedError(
      "Soil field-character response must contain exactly one parcel row.",
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

/**
 * 1:5,000 토양도에 속성이 없는 필지(임야·하천 등)는 태그는 오지만 값이 비어
 * 있다. 이건 계약이 바뀐 것이 아니라 그 필지에 자료가 없는 것이므로
 * NO_DATA로 구분한다. 값이 있는데 형식이 틀린 경우만 스키마 변경으로 본다.
 */
function requireCode(row, tagName, field) {
  const value = extractField(row, tagName, field);
  if (value === null || value.trim() === "") {
    throw new NoDataError(
      `${field} is empty for this parcel in the 1:5,000 soil map.`,
    );
  }
  if (!/^\d{2}$/u.test(value)) {
    throw new SchemaChangedError(`${field} must contain a two-digit code.`);
  }
  return value;
}

/**
 * Parses only the three audited physical properties needed by the product.
 * The PNU is verified against the request and then discarded so parcel
 * identifiers are not returned by the analysis API.
 */
export function parseSoilFieldCharacteristics(
  xml,
  { expectedPnu } = {},
) {
  const requestedPnu = requirePnu(expectedPnu, "expectedPnu");
  ensureSafeXml(xml);
  validateProviderResult(xml);
  const row = extractSingleItem(xml);
  const responsePnu = requirePnu(
    extractField(row, "PNU_Cd", "soil field PNU"),
    "response PNU",
  );
  if (responsePnu !== requestedPnu) {
    throw new SchemaChangedError(
      "Soil field-character response does not match the requested parcel.",
    );
  }
  return {
    parcelMatched: true,
    mapScale: "1:5000",
    drainageCode: requireCode(row, "Soildra_Cd", "drainage code"),
    effectiveDepthCode: requireCode(
      row,
      "Vldsoildep_Cd",
      "effective soil-depth code",
    ),
    topsoilTextureCode: requireCode(
      row,
      "Surtture_Cd",
      "topsoil texture code",
    ),
    codeLabelsVerified: false,
  };
}

export function createSoilFieldAdapter({
  enabled = false,
  apiKey,
  contractVersion = null,
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  timeoutMs = 3000,
  adapterVersion = "3",
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
      "Soil field cacheFreshForMs must be between 0 and 2592000000.",
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
      provider: "SOIL_FIELD_V3",
      now: providerControl.now ?? cacheClock,
    });
  const envelopeBase = {
    sourceId: "soil-field-v3",
    sourceName: "토양도 기반 토양특성 상세정보 V3",
    sourceUrl: providerDisclosureUrl(endpoint, "SOIL_FIELD_V3"),
    observedAt: null,
    issuedAt: null,
    validFrom: null,
    validTo: null,
    spatialLevel: "FIELD",
    spatialLabel: "선택 필지 1:5,000 토양도",
    distanceKm: null,
    unit: null,
    provenance: {
      adapterId: "soil-field-v3",
      adapterVersion,
      operationId: "getSoilCharacter",
      contractVersion,
      providerIssueTime: null,
    },
  };

  return Object.freeze({
    id: "soilField",
    async getFieldProfile(
      { pnuCode } = {},
      { signal, deadlineAt } = {},
    ) {
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
        operationId: "getSoilCharacter",
        verifiedLocationKey: null,
        requestedPeriod: null,
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
          VERIFIED_SOIL_FIELD_CONTRACT_VERSION,
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
          // 공공데이터포털 명세상 요청 파라미터는 PNU_CD, 응답 필드는 PNU_Cd다.
          url.searchParams.set("PNU_CD", normalizedPnu);
          const xml = await requestProviderText({
            fetchImpl,
            url,
            provider: "SOIL_FIELD_V3",
            requestInit: {
              headers: { Accept: "application/xml, text/xml" },
            },
            signal: upstreamSignal,
            timeoutMs,
            deadlineAt: upstreamDeadlineAt,
            now: cacheClock,
          });
          return {
            adapterState: "SUCCESS",
            data: parseSoilFieldCharacteristics(xml, {
              expectedPnu: normalizedPnu,
            }),
          };
        },
      });
    },
  });
}
