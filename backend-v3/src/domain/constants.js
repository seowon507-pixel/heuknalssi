function frozenValues(values) {
  return Object.freeze([...values]);
}

export const UsageMode = frozenValues(["LAND_SEARCH", "ACTIVE_GROWING"]);
export const Crop = frozenValues([
  "APPLE",
  "PEAR",
  "CUCUMBER",
  "POTATO",
  "LETTUCE",
]);
export const CultivationMode = frozenValues([
  "OPEN_FIELD",
  "FACILITY_SOIL",
  "FACILITY_HYDRO",
]);
export const EvidenceStatus = frozenValues([
  "CONFIRMED_RANGE",
  "SINGLE_TARGET",
  "RISK_ONLY",
  "UNCONFIRMED",
]);
export const SpatialLevel = frozenValues([
  "NORMAL_STATION",
  "OBSERVATION_STATION",
  "REGIONAL_SOIL_STAT",
  "FORECAST_GRID",
  "FORECAST_REGION",
  "FIELD",
]);
export const DeliveryState = frozenValues([
  "LIVE",
  "CACHE",
  "SAMPLE",
  "UNAVAILABLE",
]);
export const AdapterState = frozenValues([
  "SUCCESS",
  "NO_DATA",
  "TIMEOUT",
  "RATE_LIMITED",
  "AUTH_ERROR",
  "SCHEMA_CHANGED",
  "UNSUPPORTED",
  "INTERNAL_ERROR",
]);
export const ModuleState = frozenValues([
  "READY",
  "PARTIAL",
  "HOLD",
  "NOT_APPLICABLE",
  "UNAVAILABLE",
]);
export const DecisionGuidance = frozenValues([
  "DATA_NEEDED",
  "CHECK_FIRST",
  "FIELD_TEST_NEXT",
  "FACILITY_DATA_NEEDED",
  "FACILITY_CHECK_FIRST",
  "FACILITY_SENSOR_NEXT",
]);
export const AnalysisLifecycleState = frozenValues([
  "RECEIVED",
  "VALIDATING",
  "RESOLVING_LOCATION",
  "FETCHING_MODULES",
  "CALCULATING",
  "CORE_READY",
  "REPORT_PENDING",
  "COMPLETE",
  "FAILED_INPUT",
]);
export const AnalysisState = frozenValues(["COMPLETE", "PARTIAL", "DATA_NEEDED"]);
export const ConditionState = frozenValues([
  "READY",
  "PARTIAL",
  "HOLD",
  "NOT_APPLICABLE",
]);
export const RiskState = frozenValues(["READY", "PARTIAL", "HOLD"]);

export const ALLOWED_CULTIVATION_MODES = Object.freeze({
  APPLE: frozenValues(["OPEN_FIELD"]),
  PEAR: frozenValues(["OPEN_FIELD"]),
  POTATO: frozenValues(["OPEN_FIELD"]),
  CUCUMBER: frozenValues([
    "OPEN_FIELD",
    "FACILITY_SOIL",
    "FACILITY_HYDRO",
  ]),
  LETTUCE: frozenValues([
    "OPEN_FIELD",
    "FACILITY_SOIL",
    "FACILITY_HYDRO",
  ]),
});

export const RAW_WEIGHT_BY_TIER = Object.freeze({
  CRITICAL: 3,
  IMPORTANT: 2,
  SUPPORTING: 1,
});

export const PRODUCT_GUARDRAILS = Object.freeze({
  climateCoverageReady: 0.7,
  climateCoverageHold: 0.4,
  soilCoverageReady: 0.7,
  soilCoverageHold: 0.4,
  soilUncertainMaximum: 0.3,
});

export const MODULE_APPLICABILITY = Object.freeze({
  OPEN_FIELD: Object.freeze({
    climate: "EXPECTED",
    soil: "EXPECTED",
    observations: "EXPECTED",
    shortForecast: "EXPECTED",
    midForecast: "EXPECTED",
  }),
  FACILITY_SOIL: Object.freeze({
    climate: "NOT_APPLICABLE",
    soil: "EXPECTED_REFERENCE",
    observations: "EXPECTED",
    shortForecast: "EXPECTED",
    midForecast: "EXPECTED",
  }),
  FACILITY_HYDRO: Object.freeze({
    climate: "NOT_APPLICABLE",
    soil: "NOT_APPLICABLE",
    observations: "EXPECTED",
    shortForecast: "EXPECTED",
    midForecast: "EXPECTED",
  }),
});

export const ENUMS = Object.freeze({
  UsageMode,
  Crop,
  CultivationMode,
  EvidenceStatus,
  SpatialLevel,
  DeliveryState,
  AdapterState,
  ModuleState,
  DecisionGuidance,
  AnalysisLifecycleState,
  AnalysisState,
  ConditionState,
  RiskState,
});
