import {
  VERIFIED_KMA_LOCATION_CATALOG_CONTRACT_VERSION,
  runCachedAdapterCall,
} from "./adapter-call.js";
import {
  InMemoryAdapterCache,
  SingleFlight,
} from "./cache.js";
import {
  NoDataError,
  SchemaChangedError,
} from "./errors.js";
import {
  providerDisclosureUrl,
  requestProviderJson,
  requestProviderText,
} from "./network.js";
import { ProviderExecutionGuard } from "./provider-control.js";

const STATION_ENDPOINT =
  "https://apihub.kma.go.kr/api/typ01/url/stn_inf.php";
const FORECAST_ZONE_ENDPOINT =
  "https://apihub.kma.go.kr/api/typ02/openApi/FcstZoneInfoService/getFcstZoneCd";
const CATALOG_CACHE_KEY = "kma-location-catalog:current:v1";

function finiteNumber(value, field, { min, max }) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new SchemaChangedError(
      `KMA location catalog ${field} is outside its contract.`,
    );
  }
  return number;
}

function stationLine(line) {
  const prefix = line.match(
    /^\s*(\d{2,4})\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+\d+\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+\d+\s+(.+)$/u,
  );
  if (!prefix) return null;
  const suffix = prefix[4].match(
    /^.*\s([0-9A-Z]{8})\s+(\d{10})\s+\S+\s+.*$/u,
  );
  if (!suffix) return null;
  return Object.freeze({
    id: prefix[1],
    longitude: finiteNumber(prefix[2], "station longitude", {
      min: 123,
      max: 132,
    }),
    latitude: finiteNumber(prefix[3], "station latitude", {
      min: 32,
      max: 39.5,
    }),
    forecastRegionId: suffix[1],
    legalDongCode: suffix[2],
  });
}

/**
 * Parses KMA API Hub's current SFC station list. Korean labels are not used
 * for routing, so a provider charset mismatch cannot affect station identity,
 * coordinates, forecast-zone code, or legal-dong code.
 */
export function parseKmaSurfaceStationCatalog(text) {
  if (typeof text !== "string" || !text.includes("#START7777")) {
    throw new SchemaChangedError(
      "KMA surface-station catalog is missing its frozen header.",
    );
  }
  const stations = text
    .split(/\r?\n/u)
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
    .map(stationLine)
    .filter(Boolean);
  if (stations.length < 50) {
    throw new SchemaChangedError(
      "KMA surface-station catalog contains too few valid stations.",
    );
  }
  const ids = new Set();
  for (const station of stations) {
    if (ids.has(station.id)) {
      throw new SchemaChangedError(
        "KMA surface-station catalog contains duplicate station IDs.",
      );
    }
    ids.add(station.id);
  }
  return Object.freeze(stations);
}

function zoneItems(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SchemaChangedError(
      "KMA forecast-zone catalog must be an object.",
    );
  }
  const header = payload.response?.header;
  if (String(header?.resultCode ?? "").trim() !== "00") {
    throw new SchemaChangedError(
      "KMA forecast-zone catalog returned an unsupported status.",
    );
  }
  const items = payload.response?.body?.items?.item;
  if (!Array.isArray(items)) {
    throw new SchemaChangedError(
      "KMA forecast-zone catalog is missing its item array.",
    );
  }
  return items;
}

export function parseKmaForecastZoneCatalog(payload) {
  const zones = zoneItems(payload)
    .filter(
      (item) => {
        if (!item || typeof item !== "object") return false;
        const type = String(item.regSp ?? "").trim();
        if (
          !["A", "B", "C"].includes(type) ||
          !/^11[0-9A-Z]{6}$/u.test(String(item.regId ?? "").trim())
        ) {
          return false;
        }
        if (type !== "C") return true;
        const latitude = Number(item.lat);
        const longitude = Number(item.lon);
        return (
          Number.isFinite(latitude) &&
          latitude >= 32 &&
          latitude <= 39.5 &&
          Number.isFinite(longitude) &&
          longitude >= 123 &&
          longitude <= 132
        );
      },
    )
    .map((item) => {
      const type = String(item.regSp).trim();
      const latitude =
        type === "C"
          ? finiteNumber(item.lat, "forecast-zone latitude", {
              min: 32,
              max: 39.5,
            })
          : null;
      const longitude =
        type === "C"
          ? finiteNumber(item.lon, "forecast-zone longitude", {
              min: 123,
              max: 132,
            })
          : null;
      return Object.freeze({
        id: String(item.regId).trim(),
        parentId: String(item.regUp ?? "").trim() || null,
        type,
        latitude,
        longitude,
      });
    });
  if (zones.length < 250) {
    throw new SchemaChangedError(
      "KMA forecast-zone catalog contains too few active land zones.",
    );
  }
  const ids = new Set();
  for (const zone of zones) {
    if (ids.has(zone.id)) {
      throw new SchemaChangedError(
        "KMA forecast-zone catalog contains duplicate region IDs.",
      );
    }
    ids.add(zone.id);
  }
  return Object.freeze(zones);
}

export function createKmaLocationCatalogAdapter({
  enabled = false,
  apiKey,
  fetchImpl = globalThis.fetch,
  stationEndpoint = STATION_ENDPOINT,
  forecastZoneEndpoint = FORECAST_ZONE_ENDPOINT,
  timeoutMs = 5000,
  adapterVersion = "1",
  contractVersion = null,
  cache,
  singleFlight,
  executionGuard,
  providerControl = {},
  cacheFreshForMs = 24 * 60 * 60 * 1000,
  now = () => new Date(),
} = {}) {
  const cacheClock = () => new Date(now()).getTime();
  const activeCache =
    cache ??
    new InMemoryAdapterCache({
      maxEntries: 2,
      maxTtlMs: 48 * 60 * 60 * 1000,
      now: cacheClock,
    });
  const activeSingleFlight = singleFlight ?? new SingleFlight();
  const activeGuard =
    executionGuard ??
    new ProviderExecutionGuard({
      maxConcurrency: 2,
      maxQueue: 4,
      failureThreshold: 3,
      circuitCooldownMs: 1000,
      ...providerControl,
      provider: "KMA",
      now: providerControl.now ?? cacheClock,
    });
  const envelopeBase = Object.freeze({
    sourceId: "kma-location-catalog",
    sourceName: "기상청 지상관측 지점·예보구역 정보",
    sourceUrl: providerDisclosureUrl(forecastZoneEndpoint, "KMA"),
    observedAt: null,
    issuedAt: null,
    validFrom: null,
    validTo: null,
    spatialLevel: "FORECAST_REGION",
    spatialLabel: "전국 공식 지점·예보구역 목록",
    distanceKm: null,
    unit: null,
    provenance: {
      adapterId: "kma-location-catalog",
      adapterVersion,
      operationId: "get-current-stations-and-forecast-zones",
      contractVersion,
      providerIssueTime: null,
    },
  });

  return Object.freeze({
    id: "kmaLocationCatalog",
    async getCatalog(_params = {}, { signal, deadlineAt } = {}) {
      return runCachedAdapterCall({
        enabled,
        credential: apiKey,
        contractVersion,
        allowedContractVersions: new Set([
          VERIFIED_KMA_LOCATION_CATALOG_CONTRACT_VERSION,
        ]),
        envelopeBase,
        now,
        cache: activeCache,
        singleFlight: activeSingleFlight,
        executionGuard: activeGuard,
        cacheKey: CATALOG_CACHE_KEY,
        cacheFreshForMs,
        signal,
        deadlineAt,
        operation: async ({
          signal: upstreamSignal,
          deadlineAt: upstreamDeadlineAt,
        }) => {
          const stationUrl = new URL(stationEndpoint);
          stationUrl.search = new URLSearchParams({
            inf: "SFC",
            stn: "0",
            help: "1",
            authKey: apiKey.trim(),
          });
          const zoneUrl = new URL(forecastZoneEndpoint);
          zoneUrl.search = new URLSearchParams({
            pageNo: "1",
            numOfRows: "1000",
            dataType: "JSON",
            regId: "",
            authKey: apiKey.trim(),
          });
          const [stationText, zonePayload] = await Promise.all([
            requestProviderText({
              fetchImpl,
              url: stationUrl,
              provider: "KMA",
              requestInit: { headers: { Accept: "text/plain" } },
              signal: upstreamSignal,
              timeoutMs,
              deadlineAt: upstreamDeadlineAt,
              now: cacheClock,
            }),
            requestProviderJson({
              fetchImpl,
              url: zoneUrl,
              provider: "KMA",
              requestInit: { headers: { Accept: "application/json" } },
              signal: upstreamSignal,
              timeoutMs,
              deadlineAt: upstreamDeadlineAt,
              now: cacheClock,
            }),
          ]);
          const stations = parseKmaSurfaceStationCatalog(stationText);
          const zones = parseKmaForecastZoneCatalog(zonePayload);
          if (stations.length === 0 || zones.length === 0) {
            throw new NoDataError(
              "KMA location catalog does not contain routable entries.",
            );
          }
          return {
            data: Object.freeze({ stations, zones }),
            qualityFlags: ["KMA_OFFICIAL_LOCATION_CATALOG"],
          };
        },
      });
    },
  });
}
