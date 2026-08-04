import { normalizeCropCycleInput } from "./crop-cycle.mjs";

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
        season: cropSettings.season ?? "unknown",
        analysisMonth: values?.analysisMonth,
        growth: cropSettings.growth ?? values?.growth,
        saveConsent: values?.saveConsent,
        smartfarmAvailable: values?.smartfarmAvailable === true,
        // 등록된 토양검정 결과는 작물과 무관하게 같은 필지 값이므로 모두에 싣는다.
        soilTest: values?.soilTest,
      },
      candidateToken,
    );
  });
}

export function buildCropCycleRequests(values) {
  const crops = Array.isArray(values?.crops)
    ? [...new Set(values.crops.filter((crop) => typeof crop === "string"))]
    : [];
  return crops.map((crop) => ({
    crop,
    cropId: CROP_BY_UI_VALUE[crop],
    input: normalizeCropCycleInput(values?.cropSettings?.[crop]?.cycle, {
      crop,
      situation: values?.situation,
    }),
  }));
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
      includeSmartfarmBenchmark: smartfarmReferenceAvailable(
        crop,
        cultivationMode,
        values?.smartfarmAvailable === true,
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

  const soilTest = soilTestFor(values?.soilTest);
  if (soilTest) request.soilTest = soilTest;

  return request;
}

// 서버(domain/request.js)가 받는 항목과 범위를 그대로 따른다.
const SOIL_TEST_RANGES = Object.freeze({
  ph: [3, 10],
  electricalConductivity: [0, 30],
  organicMatter: [0, 500],
  availablePhosphate: [0, 3000],
  exchangeableK: [0, 100],
  exchangeableCa: [0, 100],
  exchangeableMg: [0, 100],
});

function soilTestFor(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") {
    throw new ContractValidationError(
      "SOIL_TEST_INVALID",
      "토양검정 결과를 다시 입력해 주세요.",
      "soilTest",
    );
  }

  const measurements = {};
  for (const [field, [min, max]] of Object.entries(SOIL_TEST_RANGES)) {
    const raw = value[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      throw new ContractValidationError(
        "SOIL_TEST_OUT_OF_RANGE",
        `검정 결과 값이 입력할 수 있는 범위를 벗어났습니다. (${min}~${max})`,
        `soilTest.${field}`,
      );
    }
    measurements[field] = parsed;
  }

  if (measurements.ph === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value.sampledOn ?? ""))) {
    throw new ContractValidationError(
      "SOIL_TEST_DATE_REQUIRED",
      "검정을 받은 날짜를 입력해 주세요.",
      "soilTest.sampledOn",
    );
  }

  const issuer = String(value.issuer ?? "").trim();
  return {
    ...measurements,
    sampledOn: value.sampledOn,
    ...(issuer === "" ? {} : { issuer: issuer.slice(0, 60) }),
    userConfirmed: true,
  };
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

/**
 * SmartFarm은 핵심 판정이 아니라 동종 농가 참고자료다.
 * 서버 사전점검에서 실제 사용 가능하다고 확인된 경우에만, 백엔드가
 * 지원하는 작물·재배환경 조합으로 요청한다. 공급자 장애는 핵심 분석과
 * 분리되어 있으므로 실패해도 기상·토양 판정을 막지 않는다.
 */
function smartfarmReferenceAvailable(crop, cultivationMode, available) {
  if (!available) return false;
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
