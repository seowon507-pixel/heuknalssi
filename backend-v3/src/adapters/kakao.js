import { randomBytes } from "node:crypto";

import {
  VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
  runCachedAdapterCall
} from "./adapter-call.js";
import {
  InMemoryAdapterCache,
  SingleFlight,
  hmacCacheValue,
  makeAdapterCacheKey
} from "./cache.js";
import { SchemaChangedError } from "./errors.js";
import {
  providerDisclosureUrl,
  requestProviderJson
} from "./network.js";
import { ProviderExecutionGuard } from "./provider-control.js";
import {
  parseStrictFiniteNumber,
  requireNonEmptyString
} from "./strict-values.js";

const DEFAULT_ENDPOINT =
  "https://dapi.kakao.com/v2/local/search/address.json";
const DEFAULT_REVERSE_ENDPOINT =
  "https://dapi.kakao.com/v2/local/geo/coord2regioncode.json";
const DEFAULT_REVERSE_ADDRESS_ENDPOINT =
  "https://dapi.kakao.com/v2/local/geo/coord2address.json";
const MAX_CACHE_TTL_MS = 10 * 60 * 1000;

function extractDocuments(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SchemaChangedError("Kakao response must be an object.");
  }
  if (!Array.isArray(payload.documents)) {
    throw new SchemaChangedError("Kakao response is missing documents.");
  }
  return payload.documents;
}

function legalDongCode(document, index) {
  const value = document.address?.b_code;
  if (value === null || value === undefined || value === "") return null;
  const code = String(value).trim();
  if (!/^\d{10}$/.test(code)) {
    throw new SchemaChangedError(
      `Kakao documents[${index}].address.b_code must be 10 digits.`
    );
  }
  return code;
}

function fieldParcelLookupKey(document, index, code) {
  if (code === null || document.address === null || document.address === undefined) {
    return null;
  }
  const mainText = String(document.address.main_address_no ?? "").trim();
  const rawSubAddress = document.address.sub_address_no;
  const subText =
    rawSubAddress === null ||
    rawSubAddress === undefined ||
    String(rawSubAddress).trim() === ""
      ? "0"
      : String(rawSubAddress).trim();
  const rawMountain = document.address.mountain_yn;
  const mountainText = String(
    rawMountain === null ||
      rawMountain === undefined ||
      String(rawMountain).trim() === ""
      ? "N"
      : rawMountain,
  )
    .trim()
    .toUpperCase();
  if (mainText === "") return null;
  if (
    !/^\d{1,4}$/u.test(mainText) ||
    !/^\d{1,4}$/u.test(subText) ||
    !["Y", "N"].includes(mountainText)
  ) {
    throw new SchemaChangedError(
      `Kakao documents[${index}] contains an invalid parcel number.`,
    );
  }
  const main = Number(mainText);
  const sub = Number(subText);
  if (main < 1 || main > 9999 || sub < 0 || sub > 9999) {
    throw new SchemaChangedError(
      `Kakao documents[${index}] parcel number is outside the PNU contract.`,
    );
  }
  return `${code}${mountainText === "Y" ? "2" : "1"}${String(main).padStart(4, "0")}${String(sub).padStart(4, "0")}`;
}

function resolutionMode(document) {
  const type = String(document.address_type ?? "").toUpperCase();
  if (type === "REGION_ADDR" || type === "ROAD_ADDR") {
    return "ADDRESS_RESOLVED";
  }
  if (type === "REGION" || type === "ROAD") {
    return "ADMIN_AREA_BROAD";
  }
  throw new SchemaChangedError("Kakao address_type is not supported.");
}

/**
 * Returns every verified candidate in provider order. It intentionally has no
 * selected/primary/first-candidate field.
 */
export function parseKakaoCandidates(payload) {
  return extractDocuments(payload).map((document, index) => {
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw new SchemaChangedError(`Kakao documents[${index}] must be an object.`);
    }
    const displayName = requireNonEmptyString(
      document.address_name,
      `Kakao documents[${index}].address_name`
    );
    const mode = resolutionMode(document);
    const longitude = parseStrictFiniteNumber(document.x, {
      field: `Kakao documents[${index}].x`,
      min: -180,
      max: 180
    });
    const latitude = parseStrictFiniteNumber(document.y, {
      field: `Kakao documents[${index}].y`,
      min: -90,
      max: 90
    });
    if (longitude === null || latitude === null) {
      throw new SchemaChangedError(
        `Kakao documents[${index}] is missing its provider coordinates.`
      );
    }

    const broad = mode === "ADMIN_AREA_BROAD";
    const legalDongCode10 = legalDongCode(document, index);
    const parcelLookupKey =
      mode === "ADDRESS_RESOLVED"
        ? fieldParcelLookupKey(document, index, legalDongCode10)
        : null;
    return {
      displayName,
      resolutionMode: mode,
      providerAddressType: String(document.address_type).toUpperCase(),
      legalDongCode10,
      longitude: mode === "ADDRESS_RESOLVED" ? longitude : null,
      latitude: mode === "ADDRESS_RESOLVED" ? latitude : null,
      providerCoordinatesExcluded: broad,
      ...(parcelLookupKey === null
        ? {}
        : { fieldParcelLookupKey: parcelLookupKey }),
      ...(broad
        ? {
            administrativeRepresentative: {
              longitude,
              latitude,
              purpose: "REGIONAL_FORECAST_ONLY",
            },
          }
        : {}),
    };
  });
}

export function parseKakaoRegionCandidates(payload) {
  return extractDocuments(payload)
    .filter((document) => document?.region_type === "B")
    .map((document, index) => {
      if (!document || typeof document !== "object" || Array.isArray(document)) {
        throw new SchemaChangedError(
          `Kakao legal-region documents[${index}] must be an object.`
        );
      }
      const displayName = requireNonEmptyString(
        document.address_name,
        `Kakao legal-region documents[${index}].address_name`
      );
      const legalDongCode10 = String(document.code ?? "").trim();
      if (!/^\d{10}$/.test(legalDongCode10)) {
        throw new SchemaChangedError(
          `Kakao legal-region documents[${index}].code must be 10 digits.`
        );
      }
      const longitude = parseStrictFiniteNumber(document.x, {
        field: `Kakao legal-region documents[${index}].x`,
        min: -180,
        max: 180
      });
      const latitude = parseStrictFiniteNumber(document.y, {
        field: `Kakao legal-region documents[${index}].y`,
        min: -90,
        max: 90
      });
      if (longitude === null || latitude === null) {
        throw new SchemaChangedError(
          `Kakao legal-region documents[${index}] is missing its provider coordinates.`
        );
      }
      return {
        displayName,
        resolutionMode: "ADMIN_AREA_BROAD",
        providerAddressType: "LEGAL_REGION_COORDINATE",
        legalDongCode10,
        longitude: null,
        latitude: null,
        providerCoordinatesExcluded: true,
        administrativeRepresentative: {
          longitude,
          latitude,
          purpose: "REGIONAL_FORECAST_ONLY"
        }
      };
    });
}

/**
 * Kakao's coordinate-to-address response contains a legal-dong code and a
 * parcel number but no top-level coordinates. The coordinates are therefore
 * the already validated browser coordinates supplied to the endpoint. Only
 * candidates with a complete 19-digit PNU are treated as parcel-resolved.
 */
export function parseKakaoCurrentAddressCandidates(
  payload,
  { latitude, longitude, legalDongCode10 = null }
) {
  const normalizedLatitude = parseStrictFiniteNumber(latitude, {
    field: "current address latitude",
    min: 32,
    max: 39.5
  });
  const normalizedLongitude = parseStrictFiniteNumber(longitude, {
    field: "current address longitude",
    min: 123,
    max: 133
  });
  if (normalizedLatitude === null || normalizedLongitude === null) {
    throw new TypeError("Current address coordinates are required.");
  }
  const verifiedLegalDongCode10 =
    legalDongCode10 === null || legalDongCode10 === undefined
      ? null
      : String(legalDongCode10).trim();
  if (
    verifiedLegalDongCode10 !== null &&
    !/^\d{10}$/u.test(verifiedLegalDongCode10)
  ) {
    throw new TypeError("Current address legal-dong code must be 10 digits.");
  }

  return extractDocuments(payload).flatMap((document, index) => {
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw new SchemaChangedError(
        `Kakao current-address documents[${index}] must be an object.`
      );
    }
    if (!document.address || typeof document.address !== "object") return [];
    const providerLegalDongCode10 = legalDongCode(document, index);
    if (
      providerLegalDongCode10 !== null &&
      verifiedLegalDongCode10 !== null &&
      providerLegalDongCode10 !== verifiedLegalDongCode10
    ) {
      throw new SchemaChangedError(
        `Kakao current-address documents[${index}] legal-dong code conflicts with the verified region response.`
      );
    }
    const candidateLegalDongCode10 =
      providerLegalDongCode10 ?? verifiedLegalDongCode10;
    const parcelLookupKey = fieldParcelLookupKey(
      document,
      index,
      candidateLegalDongCode10
    );
    if (parcelLookupKey === null) return [];
    const displayName = requireNonEmptyString(
      document.road_address?.address_name ?? document.address.address_name,
      `Kakao current-address documents[${index}].address_name`
    );
    return [{
      displayName,
      resolutionMode: "ADDRESS_RESOLVED",
      providerAddressType: "CURRENT_COORDINATE_ADDRESS",
      legalDongCode10: candidateLegalDongCode10,
      longitude: normalizedLongitude,
      latitude: normalizedLatitude,
      providerCoordinatesExcluded: false,
      fieldParcelLookupKey: parcelLookupKey
    }];
  });
}

export function createKakaoAdapter({
  enabled = false,
  apiKey,
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  reverseEndpoint = DEFAULT_REVERSE_ENDPOINT,
  reverseAddressEndpoint = DEFAULT_REVERSE_ADDRESS_ENDPOINT,
  timeoutMs = 3000,
  adapterVersion = "1",
  contractVersion = null,
  cache,
  singleFlight,
  executionGuard,
  providerControl = {},
  cacheFreshForMs = 10 * 60 * 1000,
  cacheKeySecret = randomBytes(32),
  now = () => new Date()
} = {}) {
  if (
    !Number.isFinite(cacheFreshForMs) ||
    cacheFreshForMs < 0 ||
    cacheFreshForMs > MAX_CACHE_TTL_MS
  ) {
    throw new TypeError(
      "Kakao cacheFreshForMs must be between 0 and 600000."
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
      maxConcurrency: 4,
      maxQueue: 8,
      failureThreshold: 3,
      circuitCooldownMs: 1000,
      ...providerControl,
      provider: "KAKAO",
      now: providerControl.now ?? cacheClock
    });
  const envelopeBase = {
    sourceId: "kakao-location",
    sourceName: "Kakao Local",
    sourceUrl: providerDisclosureUrl(endpoint, "KAKAO"),
    observedAt: null,
    issuedAt: null,
    validFrom: null,
    validTo: null,
    spatialLevel: "FIELD",
    spatialLabel: "위치 후보",
    distanceKm: null,
    unit: null,
    provenance: {
      adapterId: "kakao-location",
      adapterVersion,
      operationId: "search-address",
      contractVersion,
      providerIssueTime: null
    }
  };
  const reverseEnvelopeBase = {
    ...envelopeBase,
    sourceUrl: providerDisclosureUrl(reverseAddressEndpoint, "KAKAO"),
    spatialLabel: "현재 위치의 상세주소",
    provenance: {
      ...envelopeBase.provenance,
      operationId: "reverse-address"
    }
  };

  return Object.freeze({
    id: "kakao",
    async searchLocations(
      query,
      { signal, deadlineAt, page = 1, size = 10 } = {}
    ) {
      const queryForKey = typeof query === "string" ? query.trim() : "";
      const cacheKey = makeAdapterCacheKey({
        adapterVersion,
        operationId: "search-address",
        verifiedLocationKey: null,
        requestedPeriod: null,
        providerIssueTime: null,
        normalizedParameters: {
          contractVersion,
          queryHmac: hmacCacheValue(queryForKey, cacheKeySecret),
          page,
          size
        }
      });
      return runCachedAdapterCall({
        enabled,
        credential: apiKey,
        contractVersion,
        allowedContractVersions: [
          VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION
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
          const normalizedQuery = requireNonEmptyString(query, "location query");
          if (!Number.isInteger(page) || page < 1) {
            throw new TypeError("Kakao page must be a positive integer.");
          }
          if (!Number.isInteger(size) || size < 1 || size > 30) {
            throw new TypeError("Kakao size must be an integer from 1 to 30.");
          }

          const url = new URL(endpoint);
          url.searchParams.set("query", normalizedQuery);
          url.searchParams.set("page", String(page));
          url.searchParams.set("size", String(size));
          const payload = await requestProviderJson({
            fetchImpl,
            url,
            provider: "KAKAO",
            requestInit: {
              headers: {
                Authorization: `KakaoAK ${apiKey.trim()}`,
                Accept: "application/json"
              }
            },
            signal: upstreamSignal,
            timeoutMs,
            deadlineAt: upstreamDeadlineAt,
            now: () => new Date(now()).getTime()
          });
          const candidates = parseKakaoCandidates(payload);
          return {
            adapterState: candidates.length === 0 ? "NO_DATA" : "SUCCESS",
            data: {
              candidates,
              requiresSelection: candidates.length > 0
            },
            qualityFlags: candidates.some(
              (candidate) => candidate.providerCoordinatesExcluded
            )
              ? ["NON_ADDRESS_COORDINATES_EXCLUDED"]
              : []
          };
        }
      });
    },
    async resolveCurrentLocation(
      { latitude, longitude },
      { signal, deadlineAt } = {}
    ) {
      const normalizedLatitude = parseStrictFiniteNumber(latitude, {
        field: "current location latitude",
        min: 32,
        max: 39.5
      });
      const normalizedLongitude = parseStrictFiniteNumber(longitude, {
        field: "current location longitude",
        min: 123,
        max: 133
      });
      if (normalizedLatitude === null || normalizedLongitude === null) {
        throw new TypeError("Current location coordinates are required.");
      }
      const coordinateHmac = hmacCacheValue(
        `${normalizedLatitude.toFixed(6)},${normalizedLongitude.toFixed(6)}`,
        cacheKeySecret
      );
      const cacheKey = makeAdapterCacheKey({
        adapterVersion,
        operationId: "reverse-address",
        verifiedLocationKey: null,
        requestedPeriod: null,
        providerIssueTime: null,
        normalizedParameters: {
          contractVersion,
          coordinateHmac
        }
      });
      return runCachedAdapterCall({
        enabled,
        credential: apiKey,
        contractVersion,
        allowedContractVersions: [
          VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION
        ],
        envelopeBase: reverseEnvelopeBase,
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
          const addressUrl = new URL(reverseAddressEndpoint);
          addressUrl.searchParams.set("x", String(normalizedLongitude));
          addressUrl.searchParams.set("y", String(normalizedLatitude));
          const requestInit = {
            headers: {
              Authorization: `KakaoAK ${apiKey.trim()}`,
              Accept: "application/json"
            }
          };
          const addressPayload = await requestProviderJson({
            fetchImpl,
            url: addressUrl,
            provider: "KAKAO",
            requestInit,
            signal: upstreamSignal,
            timeoutMs,
            deadlineAt: upstreamDeadlineAt,
            now: () => new Date(now()).getTime()
          });
          const regionUrl = new URL(reverseEndpoint);
          regionUrl.searchParams.set("x", String(normalizedLongitude));
          regionUrl.searchParams.set("y", String(normalizedLatitude));
          const regionPayload = await requestProviderJson({
            fetchImpl,
            url: regionUrl,
            provider: "KAKAO",
            requestInit,
            signal: upstreamSignal,
            timeoutMs,
            deadlineAt: upstreamDeadlineAt,
            now: () => new Date(now()).getTime()
          });
          const candidates = parseKakaoRegionCandidates(regionPayload);
          const addressCandidates = parseKakaoCurrentAddressCandidates(
            addressPayload,
            {
              latitude: normalizedLatitude,
              longitude: normalizedLongitude,
              legalDongCode10: candidates[0]?.legalDongCode10 ?? null
            }
          );
          if (addressCandidates.length > 0) {
            return {
              adapterState: "SUCCESS",
              data: {
                candidates: addressCandidates,
                requiresSelection: true
              },
              qualityFlags: []
            };
          }
          return {
            adapterState: candidates.length === 0 ? "NO_DATA" : "SUCCESS",
            data: {
              candidates,
              requiresSelection: candidates.length > 0
            },
            qualityFlags: candidates.length > 0
              ? ["CURRENT_LOCATION_PARCEL_ADDRESS_UNAVAILABLE"]
              : []
          };
        }
      });
    }
  });
}
