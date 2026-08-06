import {
  createDataEnvelope,
  createUnavailableEnvelope,
} from "./data-envelope.js";
import {
  providerDisclosureUrl,
  requestProviderJson,
} from "./network.js";
import { normalizeParcelGeometry } from "../domain/parcel.js";

const DEFAULT_STAC_ENDPOINT =
  "https://stac.dataspace.copernicus.eu/v1/search";
const DEFAULT_TOKEN_ENDPOINT =
  "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const DEFAULT_STATISTICS_ENDPOINT =
  "https://sh.dataspace.copernicus.eu/api/v1/statistics";
const SOURCE_URL = "https://dataspace.copernicus.eu/";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_INTERVAL_DAYS = 366;

const NDVI_EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "SCL", "dataMask"] }],
    output: [
      { id: "ndvi", bands: 1, sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(sample) {
  const cloudy = [3, 8, 9, 10, 11].includes(sample.SCL);
  const valid = sample.dataMask === 1 && !cloudy;
  const denominator = sample.B08 + sample.B04;
  const ndvi = valid && denominator !== 0
    ? (sample.B08 - sample.B04) / denominator
    : 0;
  return { ndvi: [ndvi], dataMask: [valid ? 1 : 0] };
}`;

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireIso(value, label) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function requireRange(from, to) {
  const normalizedFrom = requireIso(from, "satellite from");
  const normalizedTo = requireIso(to, "satellite to");
  const duration = Date.parse(normalizedTo) - Date.parse(normalizedFrom);
  if (duration <= 0 || duration > MAX_INTERVAL_DAYS * 24 * 60 * 60 * 1_000) {
    throw new TypeError(`satellite time range must be between 1 and ${MAX_INTERVAL_DAYS} days`);
  }
  return { from: normalizedFrom, to: normalizedTo };
}

function requireCloudCover(value) {
  const normalized = value ?? 30;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 100) {
    throw new TypeError("maxCloudCover must be between 0 and 100");
  }
  return normalized;
}

function safeFinite(value, label, { minimum = -Infinity, maximum = Infinity } = {}) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is outside its supported range`);
  }
  return value;
}

export function parseCopernicusStacItems(payload) {
  const collection = requireObject(payload, "STAC response");
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new TypeError("STAC response must be a FeatureCollection");
  }
  return collection.features.map((rawItem) => {
    const item = requireObject(rawItem, "STAC item");
    const properties = requireObject(item.properties, "STAC item properties");
    if (
      typeof item.id !== "string" ||
      item.id.trim() === "" ||
      item.id.length > 256 ||
      item.collection !== "sentinel-2-l2a"
    ) {
      throw new TypeError("STAC item identity is invalid");
    }
    return {
      itemId: item.id,
      collection: item.collection,
      acquiredAt: requireIso(properties.datetime, "STAC acquisition time"),
      cloudCoverPercent: safeFinite(
        properties["eo:cloud_cover"],
        "STAC cloud cover",
        { minimum: 0, maximum: 100 },
      ),
      resolutionMeters: 10,
      // Asset URLs are intentionally not forwarded. They can be short-lived or
      // point at a provider host that has not passed the fixed allowlist.
      previewUrl: null,
    };
  });
}

export function parseCopernicusNdviStatistics(payload) {
  const response = requireObject(payload, "satellite statistics response");
  if (!["OK", "PARTIAL"].includes(response.status) || !Array.isArray(response.data)) {
    throw new TypeError("satellite statistics response is not usable");
  }
  return response.data.map((rawInterval) => {
    const interval = requireObject(rawInterval, "satellite interval");
    const period = requireObject(interval.interval, "satellite interval range");
    const stats = interval.outputs?.ndvi?.bands?.B0?.stats;
    requireObject(stats, "satellite NDVI statistics");
    const sampleCount = safeFinite(stats.sampleCount, "sampleCount", { minimum: 0 });
    const noDataCount = safeFinite(stats.noDataCount, "noDataCount", {
      minimum: 0,
      maximum: sampleCount,
    });
    const validCount = sampleCount - noDataCount;
    return {
      from: requireIso(period.from, "satellite interval from"),
      to: requireIso(period.to, "satellite interval to"),
      meanNdvi:
        validCount > 0
          ? safeFinite(stats.mean, "mean NDVI", { minimum: -1, maximum: 1 })
          : null,
      standardDeviation:
        validCount > 0
          ? safeFinite(stats.stDev, "NDVI standard deviation", { minimum: 0, maximum: 2 })
          : null,
      validPixelRatio: sampleCount > 0 ? validCount / sampleCount : 0,
      sampleCount,
      noDataCount,
    };
  });
}

function envelopeBase(contractVersion) {
  return {
    sourceId: "copernicus-sentinel-2-l2a",
    sourceName: "Copernicus Sentinel-2 L2A",
    sourceUrl: SOURCE_URL,
    observedAt: null,
    issuedAt: null,
    validFrom: null,
    validTo: null,
    spatialLevel: "FIELD",
    spatialLabel: "사용자가 등록한 필지 경계",
    distanceKm: null,
    unit: null,
    provenance: {
      adapterId: "copernicus-sentinel-2",
      adapterVersion: "1",
      operationId: "parcel-observation",
      contractVersion,
      providerIssueTime: null,
    },
  };
}

export function createCopernicusSatelliteAdapter({
  enabled = false,
  clientId,
  clientSecret,
  contractVersion = null,
  fetchImpl = globalThis.fetch,
  stacEndpoint = DEFAULT_STAC_ENDPOINT,
  tokenEndpoint = DEFAULT_TOKEN_ENDPOINT,
  statisticsEndpoint = DEFAULT_STATISTICS_ENDPOINT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date(),
} = {}) {
  const credentialsConfigured =
    typeof clientId === "string" && clientId.trim() !== "" &&
    typeof clientSecret === "string" && clientSecret.trim() !== "";
  const base = envelopeBase(contractVersion);
  let accessToken = null;
  let accessTokenExpiresAt = 0;

  async function getAccessToken({ signal, deadlineAt }) {
    const nowMs = new Date(now()).getTime();
    if (accessToken && accessTokenExpiresAt - nowMs > 60_000) return accessToken;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }).toString();
    const response = await requestProviderJson({
      fetchImpl,
      url: providerDisclosureUrl(tokenEndpoint, "COPERNICUS"),
      provider: "COPERNICUS",
      requestInit: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
      signal,
      timeoutMs,
      deadlineAt,
      now: () => new Date(now()).getTime(),
    });
    if (
      typeof response?.access_token !== "string" ||
      response.access_token.length < 20 ||
      !Number.isFinite(response.expires_in) ||
      response.expires_in <= 0
    ) {
      throw new TypeError("Copernicus token response is invalid");
    }
    accessToken = response.access_token;
    accessTokenExpiresAt = nowMs + response.expires_in * 1_000;
    return accessToken;
  }

  return Object.freeze({
    state: !enabled
      ? "DISABLED"
      : credentialsConfigured
        ? "CONFIGURED_UNVERIFIED"
        : "CATALOG_ONLY",

    async searchLatest({
      geometry,
      from,
      to,
      maxCloudCover = 30,
      signal,
      deadlineAt,
    }) {
      if (!enabled) {
        return createUnavailableEnvelope(base, {
          qualityFlags: ["SATELLITE_DISABLED"],
          now,
        });
      }
      const parcel = normalizeParcelGeometry(geometry);
      const range = requireRange(from, to);
      const cloudCover = requireCloudCover(maxCloudCover);
      const payload = await requestProviderJson({
        fetchImpl,
        url: providerDisclosureUrl(stacEndpoint, "COPERNICUS"),
        provider: "COPERNICUS",
        requestInit: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            collections: ["sentinel-2-l2a"],
            intersects: parcel.geometry,
            datetime: `${range.from}/${range.to}`,
            query: { "eo:cloud_cover": { lte: cloudCover } },
            sortby: [{ field: "properties.datetime", direction: "desc" }],
            limit: 5,
          }),
        },
        signal,
        timeoutMs,
        deadlineAt,
        now: () => new Date(now()).getTime(),
      });
      const items = parseCopernicusStacItems(payload);
      return createDataEnvelope(
        {
          ...base,
          observedAt: items[0]?.acquiredAt ?? null,
          validFrom: range.from,
          validTo: range.to,
          qualityFlags: [
            "SATELLITE_NOT_FIELD_MEASUREMENT",
            "CLOUD_COVER_IS_SCENE_LEVEL",
            ...(items.length === 0 ? ["NO_MATCHING_ACQUISITION"] : []),
          ],
          data: {
            parcelAreaSquareMeters: parcel.areaSquareMeters,
            bbox: parcel.bbox,
            items,
          },
        },
        { now },
      );
    },

    async getNdviSeries({
      geometry,
      from,
      to,
      interval = "P5D",
      maxCloudCover = 30,
      signal,
      deadlineAt,
    }) {
      if (!enabled || !credentialsConfigured) {
        return createUnavailableEnvelope(base, {
          adapterState: "UNSUPPORTED",
          qualityFlags: [
            !enabled ? "SATELLITE_DISABLED" : "SATELLITE_OAUTH_NOT_CONFIGURED",
          ],
          now,
        });
      }
      if (!/^P(?:[1-9]|[12]\d|3[01])D$/u.test(interval)) {
        throw new TypeError("satellite aggregation interval must be P1D to P31D");
      }
      const parcel = normalizeParcelGeometry(geometry);
      const range = requireRange(from, to);
      const cloudCover = requireCloudCover(maxCloudCover);
      const token = await getAccessToken({ signal, deadlineAt });
      const payload = await requestProviderJson({
        fetchImpl,
        url: providerDisclosureUrl(statisticsEndpoint, "COPERNICUS"),
        provider: "COPERNICUS",
        requestInit: {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: {
              bounds: {
                geometry: parcel.geometry,
                properties: {
                  crs: "http://www.opengis.net/def/crs/EPSG/0/4326",
                },
              },
              data: [{
                type: "sentinel-2-l2a",
                dataFilter: {
                  maxCloudCoverage: cloudCover,
                  mosaickingOrder: "leastCC",
                },
              }],
            },
            aggregation: {
              timeRange: range,
              aggregationInterval: { of: interval },
              resx: 0.0001,
              resy: 0.0001,
              evalscript: NDVI_EVALSCRIPT,
            },
            calculations: { ndvi: {} },
          }),
        },
        signal,
        timeoutMs,
        deadlineAt,
        now: () => new Date(now()).getTime(),
      });
      const observations = parseCopernicusNdviStatistics(payload);
      return createDataEnvelope(
        {
          ...base,
          observedAt: observations.at(-1)?.to ?? null,
          validFrom: range.from,
          validTo: range.to,
          unit: "NDVI",
          qualityFlags: [
            "SATELLITE_NOT_FIELD_MEASUREMENT",
            "CLOUD_AND_NO_DATA_PIXELS_EXCLUDED",
            "APPROXIMATE_10M_RESOLUTION",
          ],
          data: {
            parcelAreaSquareMeters: parcel.areaSquareMeters,
            indexName: "NDVI",
            resolutionMeters: 10,
            observations,
          },
        },
        { now },
      );
    },
  });
}

export const copernicusSatelliteDefaults = Object.freeze({
  stacEndpoint: DEFAULT_STAC_ENDPOINT,
  tokenEndpoint: DEFAULT_TOKEN_ENDPOINT,
  statisticsEndpoint: DEFAULT_STATISTICS_ENDPOINT,
  timeoutMs: DEFAULT_TIMEOUT_MS,
});
