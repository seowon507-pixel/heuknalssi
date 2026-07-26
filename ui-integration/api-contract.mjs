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

const GENERIC_GROWTH_VALUES = Object.freeze(
  new Set(["early", "middle", "harvest", "unknown"]),
);

const REVIEWED_GROWTH_STAGE_BY_CONTEXT = Object.freeze({
  "pear:OPEN_FIELD:flowering": "FLOWERING",
  "potato:OPEN_FIELD:tuber-bulking": "TUBER_BULKING",
  "lettuce:FACILITY_SOIL:flower-differentiation":
    "FLOWER_DIFFERENTIATION",
  "lettuce:FACILITY_HYDRO:flower-differentiation":
    "FLOWER_DIFFERENTIATION",
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

export function buildAnalysisRequests(values, candidateToken) {
  const crops = Array.isArray(values?.crops)
    ? [...new Set(values.crops.filter((crop) => typeof crop === "string"))]
    : [];
  if (crops.length === 0) {
    throw new ContractValidationError(
      "CROP_REQUIRED",
      "재배 중인 작물을 하나 이상 선택해 주세요.",
      "crop",
    );
  }

  return crops.map((crop) => {
    const cropSettings = values?.cropSettings?.[crop] ?? {};
    return buildAnalysisRequest(
      {
        situation: values?.situation ?? "planning",
        crop,
        cultivation: cropSettings.cultivation,
        season: cropSettings.season ?? "current",
        analysisMonth: values?.analysisMonth,
        growth: cropSettings.growth ?? values?.growth,
        saveConsent: values?.saveConsent,
      },
      candidateToken,
    );
  });
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
  const season = seasonFor(cropValue, values?.season, values?.analysisMonth);
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
      includeSmartfarmBenchmark: smartfarmReferenceAvailable(
        crop,
        cultivationMode,
      ),
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
    const growthStage = growthStageForContext(
      cropValue,
      cultivationMode,
      growthValue,
    );
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

function growthStageForContext(crop, cultivationMode, growthValue) {
  if (GENERIC_GROWTH_VALUES.has(growthValue)) {
    return "UNSPECIFIED";
  }
  return (
    REVIEWED_GROWTH_STAGE_BY_CONTEXT[
      `${crop}:${cultivationMode}:${growthValue}`
    ] ?? null
  );
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

function smartfarmReferenceAvailable(crop, cultivationMode) {
  if (
    crop === "CUCUMBER" &&
    ["FACILITY_SOIL", "FACILITY_HYDRO"].includes(cultivationMode)
  ) {
    return true;
  }
  return (
    ["APPLE", "POTATO"].includes(crop) &&
    cultivationMode === "OPEN_FIELD"
  );
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

function seasonFor(crop, seasonValue, analysisMonth) {
  if (crop === "apple" || crop === "pear") {
    return null;
  }
  const value = requiredString(seasonValue, "SEASON_REQUIRED", "season");
  if (value === "current") {
    if (!Number.isInteger(analysisMonth) || analysisMonth < 1 || analysisMonth > 12) {
      throw new ContractValidationError(
        "ANALYSIS_MONTH_INVALID",
        "현재 날짜를 확인하지 못했습니다. 기기 날짜 설정을 확인해 주세요.",
        "season",
      );
    }
    return {
      kind: "CUSTOM",
      profileId: "CUSTOM",
      startMonth: analysisMonth,
      endMonth: analysisMonth,
      userConfirmed: true,
    };
  }
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
