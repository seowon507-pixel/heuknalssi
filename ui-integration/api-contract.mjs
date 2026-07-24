const CROP_BY_UI_VALUE = Object.freeze({
  apple: "APPLE",
  pear: "PEAR",
  cucumber: "CUCUMBER",
  potato: "POTATO",
  lettuce: "LETTUCE",
});

const CULTIVATION_BY_UI_VALUE = Object.freeze({
  outdoor: "OPEN_FIELD",
  "facility-soil": "FACILITY_SOIL",
  "facility-water": "FACILITY_HYDRO",
});

const GROWTH_STAGE_BY_UI_VALUE = Object.freeze({
  before: "BEFORE",
  early: "EARLY",
  middle: "MIDDLE",
  harvest: "HARVEST",
  unknown: "UNSPECIFIED",
});

const CUSTOM_SEASON_MONTHS = Object.freeze({
  potato: Object.freeze({
    spring: Object.freeze([3, 6]),
    "highland-summer": Object.freeze([4, 9]),
    autumn: Object.freeze([7, 11]),
  }),
  cucumber: Object.freeze({
    spring: Object.freeze([3, 5]),
    summer: Object.freeze([6, 8]),
    "autumn-winter": Object.freeze([9, 2]),
  }),
  lettuce: Object.freeze({
    spring: Object.freeze([3, 5]),
    summer: Object.freeze([6, 8]),
    "autumn-winter": Object.freeze([9, 2]),
  }),
});

export class ContractValidationError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = "ContractValidationError";
    this.code = code;
    this.field = field;
  }
}

export function buildAnalysisRequest(values, candidateToken) {
  const token = requiredString(candidateToken, "LOCATION_CANDIDATE_REQUIRED", "region");
  const situation = requiredString(values?.situation, "SITUATION_REQUIRED", "situation");
  const cropValue = requiredString(values?.crop, "CROP_REQUIRED", "crop");
  const crop = CROP_BY_UI_VALUE[cropValue];
  if (!crop) {
    throw new ContractValidationError(
      "CROP_UNSUPPORTED",
      "지원하는 작물을 선택해 주세요.",
      "crop",
    );
  }

  const usageMode =
    situation === "planning"
      ? "LAND_SEARCH"
      : situation === "growing"
        ? "ACTIVE_GROWING"
        : null;
  if (!usageMode) {
    throw new ContractValidationError(
      "SITUATION_UNSUPPORTED",
      "현재 상황을 다시 선택해 주세요.",
      "situation",
    );
  }

  const cultivationMode = cultivationModeFor(cropValue, values?.cultivation);
  const season = seasonFor(cropValue, values?.season);
  const request = {
    usageMode,
    location: {
      candidateToken: token,
      userConfirmed: true,
    },
    crop,
    cultivationMode,
    ...(season ? { season } : {}),
    options: {
      includeSmartfarmBenchmark: false,
      includeSatelliteObservation: false,
      saveConsent: values?.saveConsent === true,
    },
  };

  if (usageMode === "ACTIVE_GROWING") {
    const growthValue = requiredString(
      values?.growth,
      "GROWTH_STAGE_REQUIRED",
      "growth",
    );
    const growthStage = GROWTH_STAGE_BY_UI_VALUE[growthValue];
    if (!growthStage) {
      throw new ContractValidationError(
        "GROWTH_STAGE_UNSUPPORTED",
        "생육단계를 다시 선택해 주세요.",
        "growth",
      );
    }
    request.growthStage = growthStage;
  }

  return request;
}

export function createIdempotencyKey(randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
  if (typeof randomUUID !== "function") {
    throw new Error("secure randomUUID support is required");
  }
  return `soil-weather-ui-${randomUUID()}`;
}

export function requestFingerprint(request) {
  return JSON.stringify(request);
}

function cultivationModeFor(crop, cultivationValue) {
  if (crop === "apple" || crop === "pear" || crop === "potato") {
    return "OPEN_FIELD";
  }
  const value = requiredString(
    cultivationValue,
    "CULTIVATION_REQUIRED",
    "cultivation",
  );
  if (value === "unknown") {
    throw new ContractValidationError(
      "CULTIVATION_CONFIRMATION_REQUIRED",
      "안전한 분석을 위해 노지·시설흙·시설물 중 하나를 확인해 주세요.",
      "cultivation",
    );
  }
  const cultivationMode = CULTIVATION_BY_UI_VALUE[value];
  if (!cultivationMode) {
    throw new ContractValidationError(
      "CULTIVATION_UNSUPPORTED",
      "재배 환경을 다시 선택해 주세요.",
      "cultivation",
    );
  }
  return cultivationMode;
}

function seasonFor(crop, seasonValue) {
  if (crop === "apple" || crop === "pear") {
    return null;
  }
  const value = requiredString(seasonValue, "SEASON_REQUIRED", "season");
  if (value === "unknown") {
    return {
      kind: "UNKNOWN",
      profileId: "UNKNOWN",
      startMonth: null,
      endMonth: null,
      userConfirmed: true,
    };
  }
  const months = CUSTOM_SEASON_MONTHS[crop]?.[value];
  if (!months) {
    throw new ContractValidationError(
      "SEASON_UNSUPPORTED",
      "재배 시기를 다시 선택해 주세요.",
      "season",
    );
  }
  return {
    kind: "CUSTOM",
    profileId: "CUSTOM",
    startMonth: months[0],
    endMonth: months[1],
    userConfirmed: true,
  };
}

function requiredString(value, code, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ContractValidationError(code, "필수 입력을 확인해 주세요.", field);
  }
  return value.trim();
}
