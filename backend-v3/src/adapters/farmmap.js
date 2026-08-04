import { normalizeParcelGeometry } from "../domain/parcel.js";
import { providerDisclosureUrl, requestProviderJson } from "./network.js";

const DEFAULT_ENDPOINT = "https://agis.epis.or.kr/ASD/farmmapApi/wfs.do";
const DEFAULT_LAYER = "farm_map_api";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_CANDIDATES = 20;
export const VERIFIED_FARMMAP_CONTRACT_VERSION =
  "epis-farmmap-wfs-v1-2026-08-04";

function requireCoordinate(value, label, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is outside the supported Korea bounds`);
  }
  return value;
}

function optionalProperty(properties, names) {
  for (const name of names) {
    const value = properties?.[name];
    if (["string", "number"].includes(typeof value) && String(value).trim()) {
      return String(value).trim().slice(0, 160);
    }
  }
  return null;
}

/**
 * Parses only the fields used by the product. Provider properties are not
 * forwarded wholesale because they may contain unstable internal columns.
 */
export function parseFarmmapFeatureCollection(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.type !== "FeatureCollection" ||
    !Array.isArray(payload.features)
  ) {
    throw new TypeError("FarmMap WFS response must be a GeoJSON FeatureCollection");
  }
  if (payload.features.length > 200) {
    throw new TypeError("FarmMap WFS response contains too many features");
  }
  return payload.features.slice(0, MAX_CANDIDATES).map((feature, index) => {
    if (!feature || feature.type !== "Feature") {
      throw new TypeError(`FarmMap feature ${index} is invalid`);
    }
    const normalized = normalizeParcelGeometry(feature.geometry);
    const properties =
      feature.properties && typeof feature.properties === "object" &&
      !Array.isArray(feature.properties)
        ? feature.properties
        : {};
    return Object.freeze({
      farmmapId:
        optionalProperty(properties, [
          "FARM_ID",
          "FARMMAP_ID",
          "farmmapId",
          "fm_id",
          "FM_SEQ",
        ]) ?? String(feature.id ?? `candidate-${index + 1}`).slice(0, 160),
      geometry: normalized.geometry,
      areaSquareMeters: normalized.areaSquareMeters,
      category: optionalProperty(properties, [
        "FLD_TYPENAME",
        "FARM_TYPE",
        "farmType",
        "LND_CGR",
        "landUse",
      ]),
      representativeAddress: optionalProperty(properties, [
        "ADDRESS",
        "ADDR",
        "address",
        "RPRSN_ADDR",
      ]),
      source: "EPIS_FARMMAP_WFS",
    });
  });
}

export function createFarmmapAdapter({
  enabled = false,
  apiKey,
  domain,
  contractVersion = null,
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  layer = DEFAULT_LAYER,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const configured =
    enabled &&
    typeof apiKey === "string" && apiKey.trim() &&
    typeof domain === "string" && domain.trim() &&
    contractVersion === VERIFIED_FARMMAP_CONTRACT_VERSION;

  return Object.freeze({
    id: "farmmap",
    state: !enabled ? "DISABLED" : configured ? "CONFIGURED_UNVERIFIED" : "HOLD",
    async searchParcels(
      { latitude, longitude, radiusMeters = 250 } = {},
      { signal, deadlineAt } = {},
    ) {
      if (!configured) {
        return Object.freeze({
          state: "UNAVAILABLE",
          candidates: Object.freeze([]),
          sourceUrl: "https://agis.epis.or.kr/",
          limitations: Object.freeze(["FARMMAP_NOT_CONFIGURED"]),
        });
      }
      const lat = requireCoordinate(latitude, "FarmMap latitude", 32, 39.5);
      const lon = requireCoordinate(longitude, "FarmMap longitude", 123, 133);
      const radius = Number(radiusMeters);
      if (!Number.isFinite(radius) || radius < 50 || radius > 1_000) {
        throw new TypeError("FarmMap radiusMeters must be between 50 and 1000");
      }
      const latitudeOffset = radius / 111_320;
      const longitudeOffset = radius /
        (111_320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
      const url = new URL(endpoint);
      url.searchParams.set("service", "WFS");
      url.searchParams.set("version", "1.1.0");
      url.searchParams.set("request", "GetFeature");
      url.searchParams.set("typeName", layer);
      url.searchParams.set("outputFormat", "application/json");
      url.searchParams.set("srsName", "EPSG:4326");
      url.searchParams.set(
        "bbox",
        [
          lon - longitudeOffset,
          lat - latitudeOffset,
          lon + longitudeOffset,
          lat + latitudeOffset,
          "EPSG:4326",
        ].join(","),
      );
      url.searchParams.set("maxFeatures", String(MAX_CANDIDATES));
      url.searchParams.set("apiKey", apiKey.trim());
      url.searchParams.set("domain", domain.trim());
      const payload = await requestProviderJson({
        fetchImpl,
        url,
        provider: "FARMMAP",
        requestInit: { headers: { Accept: "application/geo+json, application/json" } },
        signal,
        timeoutMs,
        deadlineAt,
        now: () => Number(new Date(now()).getTime()),
        maxResponseBytes: 2 * 1024 * 1024,
      });
      return Object.freeze({
        state: "READY",
        candidates: Object.freeze(parseFarmmapFeatureCollection(payload)),
        sourceUrl: providerDisclosureUrl(endpoint, "FARMMAP"),
        limitations: Object.freeze([
          "REFERENCE_MAP_NOT_LEGAL_CADASTRAL_BOUNDARY",
          "FARMMAP_ANNUAL_UPDATE_CYCLE",
        ]),
      });
    },
  });
}

export const farmmapDefaults = Object.freeze({
  endpoint: DEFAULT_ENDPOINT,
  layer: DEFAULT_LAYER,
});
