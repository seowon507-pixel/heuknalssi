import { normalizeParcelGeometry } from "../domain/parcel.js";
import { AdapterError } from "./errors.js";
import { providerDisclosureUrl, requestProviderJson } from "./network.js";

const DEFAULT_ENDPOINT = "https://agis.epis.or.kr/ASD/farmmapApi/wfs.do";
const DEFAULT_LAYER = "farm_map_api";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CANDIDATES = 20;
const FARMMAP_PROPERTY_NAMES = Object.freeze([
  "id",
  "uid",
  "clsf_nm",
  "pnu",
  "ldcg_cd",
  "stdg_cd",
  "stdg_addr",
  "shape",
]);
const DEGREE = Math.PI / 180;
const GRS80 = Object.freeze({
  semiMajorAxis: 6_378_137,
  inverseFlattening: 298.257222101,
});
const EPSG_5179 = Object.freeze({
  latitudeOfOrigin: 38 * DEGREE,
  centralMeridian: 127.5 * DEGREE,
  scaleFactor: 0.9996,
  falseEasting: 1_000_000,
  falseNorthing: 2_000_000,
});
export const VERIFIED_FARMMAP_CONTRACT_VERSION =
  "epis-farmmap-wfs-v1-2026-08-04";

export function normalizeFarmmapDomain(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  const candidate = /^[a-z][a-z\d+.-]*:\/\//iu.test(raw)
    ? raw
    : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function farmmapDomainCandidates(value) {
  const origin = normalizeFarmmapDomain(value);
  if (!origin) return [];
  const url = new URL(origin);
  const raw = value.trim();
  const registeredForm = /^[a-z][a-z\d+.-]*:\/\//iu.test(raw)
    ? origin
    : url.host;
  return [registeredForm, origin, url.host].filter(
    (candidate, index, values) => values.indexOf(candidate) === index,
  );
}

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

function meridionalArc(latitude, semiMajorAxis, eccentricitySquared) {
  const e4 = eccentricitySquared ** 2;
  const e6 = eccentricitySquared ** 3;
  return semiMajorAxis * (
    (1 - eccentricitySquared / 4 - (3 * e4) / 64 - (5 * e6) / 256) *
      latitude -
    ((3 * eccentricitySquared) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) *
      Math.sin(2 * latitude) +
    ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * latitude) -
    ((35 * e6) / 3072) * Math.sin(6 * latitude)
  );
}

/** Converts Korea 2000 / Unified CS (EPSG:5179) to WGS84 longitude/latitude. */
export function epsg5179ToWgs84(position) {
  if (
    !Array.isArray(position) ||
    position.length < 2 ||
    !Number.isFinite(position[0]) ||
    !Number.isFinite(position[1])
  ) {
    throw new TypeError("EPSG:5179 position must contain finite easting and northing");
  }

  const { semiMajorAxis: a, inverseFlattening } = GRS80;
  const flattening = 1 / inverseFlattening;
  const eccentricitySquared = flattening * (2 - flattening);
  const secondEccentricitySquared =
    eccentricitySquared / (1 - eccentricitySquared);
  const originArc = meridionalArc(
    EPSG_5179.latitudeOfOrigin,
    a,
    eccentricitySquared,
  );
  const x = (position[0] - EPSG_5179.falseEasting) / EPSG_5179.scaleFactor;
  const y = (position[1] - EPSG_5179.falseNorthing) / EPSG_5179.scaleFactor;
  const arc = originArc + y;
  const e4 = eccentricitySquared ** 2;
  const e6 = eccentricitySquared ** 3;
  const mu =
    arc /
    (a *
      (1 - eccentricitySquared / 4 - (3 * e4) / 64 - (5 * e6) / 256));
  const e1 =
    (1 - Math.sqrt(1 - eccentricitySquared)) /
    (1 + Math.sqrt(1 - eccentricitySquared));
  const footprintLatitude =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sinFootprint = Math.sin(footprintLatitude);
  const cosFootprint = Math.cos(footprintLatitude);
  const tanFootprint = Math.tan(footprintLatitude);
  const curvature =
    a / Math.sqrt(1 - eccentricitySquared * sinFootprint ** 2);
  const meridianRadius =
    (a * (1 - eccentricitySquared)) /
    (1 - eccentricitySquared * sinFootprint ** 2) ** 1.5;
  const tangentSquared = tanFootprint ** 2;
  const etaSquared = secondEccentricitySquared * cosFootprint ** 2;
  const d = x / curvature;
  const latitude =
    footprintLatitude -
    ((curvature * tanFootprint) / meridianRadius) *
      (d ** 2 / 2 -
        ((5 + 3 * tangentSquared + 10 * etaSquared -
          4 * etaSquared ** 2 - 9 * secondEccentricitySquared) * d ** 4) /
          24 +
        ((61 + 90 * tangentSquared + 298 * etaSquared +
          45 * tangentSquared ** 2 - 252 * secondEccentricitySquared -
          3 * etaSquared ** 2) * d ** 6) /
          720);
  const longitude =
    EPSG_5179.centralMeridian +
    (d -
      ((1 + 2 * tangentSquared + etaSquared) * d ** 3) / 6 +
      ((5 - 2 * etaSquared + 28 * tangentSquared -
        3 * etaSquared ** 2 + 8 * secondEccentricitySquared +
        24 * tangentSquared ** 2) * d ** 5) /
        120) /
      cosFootprint;

  return Object.freeze([longitude / DEGREE, latitude / DEGREE]);
}

function responseCrs(payload) {
  const name = payload?.crs?.properties?.name;
  if (name === undefined || name === null || name === "") return "EPSG:4326";
  if (typeof name !== "string") {
    throw new TypeError("FarmMap CRS name must be a string");
  }
  if (/EPSG(?::+)?5179$/iu.test(name)) return "EPSG:5179";
  if (/EPSG(?::+)?4326$/iu.test(name)) return "EPSG:4326";
  throw new TypeError(`Unsupported FarmMap CRS: ${name.slice(0, 80)}`);
}

function transformCoordinates(value, transformPosition) {
  if (!Array.isArray(value)) {
    throw new TypeError("FarmMap geometry coordinates must be arrays");
  }
  if (
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  ) {
    return transformPosition(value);
  }
  return value.map((nested) => transformCoordinates(nested, transformPosition));
}

function normalizeFarmmapGeometry(geometry, crs) {
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) {
    throw new TypeError("FarmMap feature geometry is invalid");
  }
  if (crs === "EPSG:4326") return geometry;
  return {
    type: geometry.type,
    coordinates: transformCoordinates(geometry.coordinates, epsg5179ToWgs84),
  };
}

/**
 * Parses only the fields used by the product. Provider properties are not
 * forwarded wholesale because they may contain unstable internal columns.
 */
export function parseFarmmapFeatureCollection(payload) {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload.type !== "FeatureCollection" &&
    Object.hasOwn(payload, "status")
  ) {
    throw new AdapterError("FarmMap rejected the registered key or domain.", {
      adapterState: "AUTH_ERROR",
      code: "FARMMAP_AUTH_REJECTED",
      retryable: false,
    });
  }
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
  const crs = responseCrs(payload);
  return payload.features.slice(0, MAX_CANDIDATES).map((feature, index) => {
    if (!feature || feature.type !== "Feature") {
      throw new TypeError(`FarmMap feature ${index} is invalid`);
    }
    const normalized = normalizeParcelGeometry(
      normalizeFarmmapGeometry(feature.geometry, crs),
    );
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
          "gid",
          "id",
          "uid",
          "pnu",
        ]) ?? String(feature.id ?? `candidate-${index + 1}`).slice(0, 160),
      geometry: normalized.geometry,
      areaSquareMeters: normalized.areaSquareMeters,
      category: optionalProperty(properties, [
        "FLD_TYPENAME",
        "FARM_TYPE",
        "farmType",
        "LND_CGR",
        "landUse",
        "clsf_nm",
        "o_clsf_nm",
      ]),
      representativeAddress: optionalProperty(properties, [
        "ADDRESS",
        "ADDR",
        "address",
        "RPRSN_ADDR",
        "stdg_addr",
      ]),
      source: "EPIS_FARMMAP_WFS",
    });
  });
}

export function createFarmmapAdapter({
  enabled = false,
  apiKey,
  domain,
  fallbackDomains = [],
  contractVersion = null,
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  layer = DEFAULT_LAYER,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const domains = Object.freeze([
    domain,
    ...(Array.isArray(fallbackDomains) ? fallbackDomains : []),
  ]
    .flatMap(farmmapDomainCandidates)
    .filter((value, index, values) => value && values.indexOf(value) === index));
  const configured =
    enabled &&
    typeof apiKey === "string" && apiKey.trim() &&
    domains.length > 0 &&
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
      let candidates = null;
      for (let index = 0; index < domains.length; index += 1) {
        const url = new URL(endpoint);
        // The provider recommends lower-case WFS parameter names. WFS 1.1.0
        // remains an explicitly supported contract and uses `maxfeatures`.
        url.searchParams.set("service", "wfs");
        url.searchParams.set("version", "1.1.0");
        url.searchParams.set("request", "GetFeature");
        url.searchParams.set("typename", layer);
        // EPIS validates this parameter against the literal WFS format name.
        // `application/json` is rejected even though a GeoJSON body is returned;
        // the provider accepts `JSON` (case-insensitively).
        url.searchParams.set("outputformat", "json");
        url.searchParams.set("propertyname", FARMMAP_PROPERTY_NAMES.join(","));
        url.searchParams.set("sortby", "asc");
        url.searchParams.set("startindex", "0");
        url.searchParams.set("srsname", "EPSG:4326");
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
        url.searchParams.set("maxfeatures", String(MAX_CANDIDATES));
        url.searchParams.set("apiKey", apiKey.trim());
        url.searchParams.set("domain", domains[index]);
        try {
          const payload = await requestProviderJson({
            fetchImpl,
            url,
            provider: "FARMMAP",
            requestInit: {
              headers: { Accept: "application/geo+json, application/json" },
            },
            signal,
            timeoutMs,
            deadlineAt,
            now: () => Number(new Date(now()).getTime()),
            maxResponseBytes: 2 * 1024 * 1024,
          });
          candidates = parseFarmmapFeatureCollection(payload);
          break;
        } catch (error) {
          const hasFallback = index < domains.length - 1;
          if (error?.adapterState === "AUTH_ERROR" && hasFallback) continue;
          throw error;
        }
      }
      return Object.freeze({
        state: "READY",
        candidates: Object.freeze(candidates ?? []),
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
