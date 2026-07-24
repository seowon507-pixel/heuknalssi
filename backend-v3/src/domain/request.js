import {
  ALLOWED_CULTIVATION_MODES,
  Crop,
  CultivationMode,
  UsageMode,
} from "./constants.js";
import { DomainError, domainAssert } from "./errors.js";
import { expandSeasonMonths } from "./season.js";

const DEFAULT_VERIFIED_PROFILES = Object.freeze({
  APPLE: Object.freeze({
    OPEN_FIELD: Object.freeze(["APPLE_OPEN_FIELD_ANNUAL"]),
  }),
  PEAR: Object.freeze({
    OPEN_FIELD: Object.freeze(["PEAR_OPEN_FIELD_ANNUAL"]),
  }),
  POTATO: Object.freeze({
    OPEN_FIELD: Object.freeze([]),
  }),
  CUCUMBER: Object.freeze({
    OPEN_FIELD: Object.freeze([]),
    FACILITY_SOIL: Object.freeze([]),
    FACILITY_HYDRO: Object.freeze([]),
  }),
  LETTUCE: Object.freeze({
    OPEN_FIELD: Object.freeze([]),
    FACILITY_SOIL: Object.freeze([]),
    FACILITY_HYDRO: Object.freeze([]),
  }),
});

const DEFAULT_OPTIONS = Object.freeze({
  includeSmartfarmBenchmark: false,
  includeSatelliteObservation: false,
  saveConsent: false,
});

export function validateAndNormalizeRequest(raw, options = {}) {
  domainAssert(
    isPlainObject(raw),
    "INVALID_INPUT",
    "analysis request must be an object",
  );
  const allowedRequestFields = new Set([
    "usageMode",
    "location",
    "crop",
    "cultivationMode",
    "season",
    "growthStage",
    "parcel",
    "options",
  ]);
  domainAssert(
    Object.keys(raw).every((key) => allowedRequestFields.has(key)),
    "INVALID_INPUT",
    "analysis request contains unsupported fields",
    {
      fields: Object.keys(raw)
        .filter((key) => !allowedRequestFields.has(key))
        .sort(),
    },
  );

  const usageMode = normalizeEnum(raw.usageMode, UsageMode, "usageMode");
  const crop = normalizeEnum(raw.crop, Crop, "crop");
  const cultivationMode = normalizeEnum(
    raw.cultivationMode,
    CultivationMode,
    "cultivationMode",
  );

  domainAssert(
    ALLOWED_CULTIVATION_MODES[crop].includes(cultivationMode),
    "INVALID_CULTIVATION_MODE",
    `${cultivationMode} is not allowed for ${crop}`,
    { crop, cultivationMode },
  );

  const location = normalizeLocation(raw.location);
  const verifiedProfiles =
    options.verifiedSeasonProfiles ??
    defaultingProfileRegistry(options.ruleRegistry);
  const season = normalizeSeason(
    raw.season,
    crop,
    cultivationMode,
    verifiedProfiles,
  );
  const growthStages = resolveGrowthStages(options, crop, cultivationMode);
  const growthStage = normalizeGrowthStage(raw.growthStage, {
    usageMode,
    crop,
    allowedStages: growthStages,
  });
  const normalizedOptions = normalizeOptions(raw.options);
  const parcel = raw.parcel === undefined ? undefined : normalizeParcel(raw.parcel);

  if (normalizedOptions.includeSatelliteObservation) {
    domainAssert(
      cultivationMode === "OPEN_FIELD",
      "INVALID_SATELLITE_CONTEXT",
      "satellite observation is available only for open-field cultivation",
    );
    domainAssert(
      parcel !== undefined,
      "PARCEL_REQUIRED",
      "a confirmed parcel is required for satellite observation",
    );
  }

  return {
    usageMode,
    location,
    crop,
    cultivationMode,
    season,
    seasonMonths:
      season.kind === "CUSTOM"
        ? expandSeasonMonths(season.startMonth, season.endMonth)
        : null,
    growthStage,
    ...(parcel === undefined ? {} : { parcel }),
    options: normalizedOptions,
  };
}

function normalizeLocation(value) {
  domainAssert(
    isPlainObject(value),
    "INVALID_LOCATION_SELECTION",
    "location must contain a confirmed candidate token",
  );
  const keys = Object.keys(value);
  domainAssert(
    keys.every((key) => key === "candidateToken" || key === "userConfirmed"),
    "INVALID_LOCATION_SELECTION",
    "analysis location accepts only candidateToken and userConfirmed",
  );
  domainAssert(
    value.userConfirmed === true,
    "LOCATION_NOT_CONFIRMED",
    "the location candidate must be explicitly confirmed",
  );
  domainAssert(
    typeof value.candidateToken === "string",
    "INVALID_LOCATION_TOKEN",
    "candidateToken must be a string",
  );
  const candidateToken = value.candidateToken.trim();
  domainAssert(
    candidateToken.length >= 1 && candidateToken.length <= 512,
    "INVALID_LOCATION_TOKEN",
    "candidateToken must contain 1 through 512 characters",
  );
  domainAssert(
    !/[\u0000-\u001f\u007f]/u.test(candidateToken),
    "INVALID_LOCATION_TOKEN",
    "candidateToken contains control characters",
  );
  return { candidateToken, userConfirmed: true };
}

function normalizeSeason(rawSeason, crop, cultivationMode, registry) {
  const facilityOptional =
    cultivationMode !== "OPEN_FIELD" &&
    (crop === "CUCUMBER" || crop === "LETTUCE");

  if (rawSeason === undefined || rawSeason === null) {
    if (crop === "APPLE" || crop === "PEAR") {
      const annualProfiles = profileIdsFor(registry, crop, cultivationMode);
      domainAssert(
        annualProfiles.length === 1,
        "UNVERIFIED_SEASON_PROFILE",
        `exactly one reviewed annual profile must be configured for ${crop}`,
        { crop, cultivationMode },
      );
      return {
        kind: "VERIFIED_PROFILE",
        profileId: annualProfiles[0],
        startMonth: null,
        endMonth: null,
        userConfirmed: true,
      };
    }
    if (facilityOptional) {
      return {
        kind: "NOT_APPLICABLE",
        profileId: "NOT_APPLICABLE",
        startMonth: null,
        endMonth: null,
        userConfirmed: true,
      };
    }
    throwInputSeason();
  }

  domainAssert(isPlainObject(rawSeason), "INVALID_SEASON", "season must be an object");
  domainAssert(
    rawSeason.userConfirmed === true,
    "SEASON_NOT_CONFIRMED",
    "season must be explicitly confirmed",
  );
  const kind = normalizeEnum(
    rawSeason.kind,
    ["VERIFIED_PROFILE", "CUSTOM", "UNKNOWN", "NOT_APPLICABLE"],
    "season.kind",
  );
  domainAssert(
    allowedSeasonKinds(crop, cultivationMode).includes(kind),
    "INVALID_SEASON_CONTEXT",
    `${kind} season is not allowed for ${crop}/${cultivationMode}`,
    { crop, cultivationMode, kind },
  );

  if (kind === "VERIFIED_PROFILE") {
    domainAssert(
      typeof rawSeason.profileId === "string" && rawSeason.profileId.trim() !== "",
      "INVALID_SEASON_PROFILE",
      "profileId is required",
    );
    const profileId = rawSeason.profileId.trim();
    domainAssert(
      profileIdsFor(registry, crop, cultivationMode).includes(profileId),
      "UNVERIFIED_SEASON_PROFILE",
      "season profile is not reviewed for this crop and cultivation mode",
      { crop, cultivationMode, profileId },
    );
    assertNullMonths(rawSeason, kind);
    return {
      kind,
      profileId,
      startMonth: null,
      endMonth: null,
      userConfirmed: true,
    };
  }

  if (kind === "CUSTOM") {
    domainAssert(
      rawSeason.profileId === "CUSTOM",
      "INVALID_SEASON_PROFILE",
      'CUSTOM season requires profileId="CUSTOM"',
    );
    const months = expandSeasonMonths(rawSeason.startMonth, rawSeason.endMonth);
    return {
      kind,
      profileId: "CUSTOM",
      startMonth: rawSeason.startMonth,
      endMonth: rawSeason.endMonth,
      months,
      userConfirmed: true,
    };
  }

  if (kind === "UNKNOWN") {
    domainAssert(
      rawSeason.profileId === "UNKNOWN",
      "INVALID_SEASON_PROFILE",
      'UNKNOWN season requires profileId="UNKNOWN"',
    );
    assertNullMonths(rawSeason, kind);
    return {
      kind,
      profileId: "UNKNOWN",
      startMonth: null,
      endMonth: null,
      userConfirmed: true,
    };
  }

  domainAssert(
    facilityOptional,
    "INVALID_SEASON_CONTEXT",
    "NOT_APPLICABLE season is allowed only for optional facility seasons",
    { crop, cultivationMode },
  );
  domainAssert(
    rawSeason.profileId === "NOT_APPLICABLE",
    "INVALID_SEASON_PROFILE",
    'NOT_APPLICABLE season requires profileId="NOT_APPLICABLE"',
  );
  assertNullMonths(rawSeason, kind);
  return {
    kind,
    profileId: "NOT_APPLICABLE",
    startMonth: null,
    endMonth: null,
    userConfirmed: true,
  };
}

function normalizeGrowthStage(rawStage, { usageMode, crop, allowedStages }) {
  const growthStage =
    rawStage === undefined || rawStage === null || rawStage === ""
      ? "UNSPECIFIED"
      : typeof rawStage === "string"
        ? rawStage.trim().toUpperCase()
        : null;
  domainAssert(
    typeof growthStage === "string" && growthStage.length > 0,
    "INVALID_GROWTH_STAGE",
    "growthStage must be a non-empty string",
  );

  if (usageMode === "LAND_SEARCH" && growthStage !== "UNSPECIFIED") {
    throw new DomainError(
      "INVALID_GROWTH_STAGE_CONTEXT",
      "LAND_SEARCH requests cannot select a growth stage",
      { details: { crop, growthStage } },
    );
  }
  if (growthStage !== "UNSPECIFIED") {
    domainAssert(
      allowedStages.has(growthStage),
      "INVALID_GROWTH_STAGE",
      "growthStage is not present in the reviewed rule allowlist",
      { crop, growthStage },
    );
  }
  return growthStage;
}

function normalizeOptions(value) {
  if (value === undefined || value === null) return { ...DEFAULT_OPTIONS };
  domainAssert(isPlainObject(value), "INVALID_OPTIONS", "options must be an object");
  const result = { ...DEFAULT_OPTIONS };
  for (const key of Object.keys(value)) {
    domainAssert(
      Object.hasOwn(DEFAULT_OPTIONS, key),
      "INVALID_OPTIONS",
      `unsupported option: ${key}`,
    );
    domainAssert(
      typeof value[key] === "boolean",
      "INVALID_OPTIONS",
      `${key} must be boolean`,
    );
    result[key] = value[key];
  }
  return result;
}

function normalizeParcel(value) {
  domainAssert(isPlainObject(value), "INVALID_PARCEL", "parcel must be an object");
  domainAssert(
    value.userConfirmed === true,
    "PARCEL_NOT_CONFIRMED",
    "parcel geometry must be explicitly confirmed",
  );
  const geometry = value.geometry;
  domainAssert(isPlainObject(geometry), "INVALID_PARCEL", "parcel geometry is required");
  domainAssert(
    geometry.type === "Polygon" || geometry.type === "MultiPolygon",
    "INVALID_PARCEL",
    "parcel geometry must be Polygon or MultiPolygon",
  );
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  domainAssert(Array.isArray(polygons) && polygons.length > 0, "INVALID_PARCEL", "parcel is empty");
  let vertexCount = 0;
  for (const polygon of polygons) {
    domainAssert(Array.isArray(polygon) && polygon.length > 0, "INVALID_PARCEL", "polygon has no rings");
    for (const ring of polygon) {
      domainAssert(Array.isArray(ring) && ring.length >= 4, "INVALID_PARCEL", "ring requires at least four points");
      vertexCount += ring.length;
      for (const coordinate of ring) {
        domainAssert(
          Array.isArray(coordinate) &&
            coordinate.length >= 2 &&
            Number.isFinite(coordinate[0]) &&
            Number.isFinite(coordinate[1]) &&
            coordinate[0] >= -180 &&
            coordinate[0] <= 180 &&
            coordinate[1] >= -90 &&
            coordinate[1] <= 90,
          "INVALID_PARCEL",
          "parcel coordinate is invalid",
        );
      }
      domainAssert(
        sameCoordinate(ring[0], ring.at(-1)),
        "INVALID_PARCEL",
        "parcel rings must be closed",
      );
    }
  }
  domainAssert(vertexCount <= 10_000, "PARCEL_TOO_COMPLEX", "parcel has too many vertices");
  return {
    geometry: structuredClone(geometry),
    userConfirmed: true,
  };
}

function resolveGrowthStages(options, crop, cultivationMode) {
  const configured = options.growthStagesByCrop?.[crop] ?? [];
  const ruleStages =
    typeof options.ruleRegistry?.growthStagesFor === "function"
      ? options.ruleRegistry.growthStagesFor(crop, cultivationMode)
      : [];
  return new Set([...configured, ...ruleStages].map((value) => String(value).trim().toUpperCase()));
}

function profileIdsFor(registry, crop, mode) {
  if (typeof registry?.seasonProfilesFor === "function") {
    return registry.seasonProfilesFor(crop, mode);
  }
  const profiles = registry?.[crop]?.[mode];
  return Array.isArray(profiles) ? profiles : [];
}

function defaultingProfileRegistry(ruleRegistry) {
  return {
    seasonProfilesFor(crop, mode) {
      if (typeof ruleRegistry?.seasonProfilesFor === "function") {
        return ruleRegistry
          .seasonProfilesFor(crop, mode)
          .filter(
            (profileId) =>
              !["CUSTOM", "UNKNOWN", "NOT_APPLICABLE"].includes(profileId),
          );
      }
      return DEFAULT_VERIFIED_PROFILES[crop]?.[mode] ?? [];
    },
  };
}

function allowedSeasonKinds(crop, cultivationMode) {
  if (crop === "APPLE" || crop === "PEAR") return ["VERIFIED_PROFILE"];
  if (crop === "POTATO") {
    return ["VERIFIED_PROFILE", "CUSTOM", "UNKNOWN"];
  }
  if (cultivationMode === "OPEN_FIELD") return ["CUSTOM", "UNKNOWN"];
  return ["CUSTOM", "UNKNOWN", "NOT_APPLICABLE"];
}

function assertNullMonths(value, kind) {
  domainAssert(
    (value.startMonth ?? null) === null && (value.endMonth ?? null) === null,
    "INVALID_SEASON_MONTH",
    `${kind} season requires null startMonth and endMonth`,
  );
}

function throwInputSeason() {
  domainAssert(false, "SEASON_REQUIRED", "a confirmed season selection is required");
}

function normalizeEnum(value, allowed, field) {
  domainAssert(typeof value === "string", "INVALID_INPUT", `${field} must be a string`, {
    field,
  });
  const normalized = value.trim().toUpperCase();
  domainAssert(
    allowed.includes(normalized),
    "INVALID_INPUT",
    `${field} is not supported`,
    { field, value },
  );
  return normalized;
}

function sameCoordinate(left, right) {
  return left[0] === right[0] && left[1] === right[1];
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export { DEFAULT_VERIFIED_PROFILES };
