import assert from "node:assert/strict";
import test from "node:test";

import {
  DomainError,
  calculateNormalizedDeviation,
  classifySoilInterval,
  createRuleRegistry,
  decideGuidance,
  evaluateAnalysisStates,
  evaluateClimate,
  evaluateForecastRisks,
  evaluateSoil,
  expandSeasonMonths,
  mergeForecasts,
  projectDisplayActions,
  rankActions,
  selectPrimaryAction,
  validateAndNormalizeRequest,
  validateRuleRegistry,
} from "../src/domain/index.js";

const provenance = Object.freeze({
  sourceTitle: "Reviewed source",
  sourceUrl: "https://example.test/reviewed-source",
  sourcePageOrTable: "Table 1",
  sourceVersion: "2026-01",
  reviewedAt: "2026-07-01",
  ruleVersion: "rules-v1",
});

function climateRule(overrides = {}) {
  return {
    ruleId: "climate-1",
    module: "CLIMATE",
    crop: "CUCUMBER",
    cultivationMode: "OPEN_FIELD",
    seasonProfileId: "CUSTOM",
    evaluationPeriod: { grain: "MONTH", month: 5 },
    stage: "ANY",
    metric: "meanTemperature",
    unit: "degC",
    use: "DEVIATION",
    evidenceStatus: "CONFIRMED_RANGE",
    optimalRange: [10, 20],
    toleranceRange: null,
    sensitivityTier: "CRITICAL",
    critical: true,
    ...provenance,
    ...overrides,
  };
}

function soilRule(overrides = {}) {
  return {
    ...climateRule({
      ruleId: "soil-1",
      module: "SOIL",
      metric: "soilMetric",
      unit: "unit",
      optimalRange: [6, 7],
      ...overrides,
    }),
  };
}

function forecastRule(overrides = {}) {
  return {
    ruleId: "forecast-1",
    module: "FORECAST",
    use: "FORECAST_RISK",
    crop: "CUCUMBER",
    cultivationMode: "OPEN_FIELD",
    stage: "ANY",
    metric: "maxTemperature",
    unit: "degC",
    comparison: { operator: "GT", threshold: 30 },
    duration: { kind: "ANY_DAY" },
    severity: "WARNING",
    actionId: "check-heat",
    evidenceStatus: "RISK_ONLY",
    ...provenance,
    ...overrides,
  };
}

function baseRequest(overrides = {}) {
  return {
    usageMode: "LAND_SEARCH",
    location: { candidateToken: " token-123 ", userConfirmed: true },
    crop: "CUCUMBER",
    cultivationMode: "OPEN_FIELD",
    season: {
      kind: "CUSTOM",
      profileId: "CUSTOM",
      startMonth: 11,
      endMonth: 2,
      userConfirmed: true,
    },
    ...overrides,
  };
}

function forecastDay(date, sourceType, overrides = {}) {
  return {
    date,
    sourceType,
    spatialLevel:
      sourceType === "SHORT_GRID" ? "FORECAST_GRID" : "FORECAST_REGION",
    issueTime: `${date}T00:00:00Z`,
    validFrom: `${date}T00:00:00Z`,
    validTo: `${date}T23:59:59Z`,
    minTemperature: 10,
    maxTemperature: 20,
    precipitationProbability: 20,
    precipitationAmount: null,
    windSpeed: null,
    risks: [],
    units: {
      minTemperature: "degC",
      maxTemperature: "degC",
      precipitationProbability: "percent",
      precipitationAmount: "mm",
      windSpeed: "m/s",
    },
    freshness: "CURRENT",
    ...overrides,
  };
}

function soilDataset(overrides = {}) {
  return {
    metric: "soilMetric",
    unit: "unit",
    boundarySemanticsVerified: true,
    totalValidArea: 100,
    areaUnit: "m2",
    intervals: [
      {
        lower: 6,
        upper: 7,
        lowerInclusive: true,
        upperInclusive: true,
        area: 100,
        areaUnit: "m2",
      },
    ],
    ...overrides,
  };
}

test("DomainError is structured and serializable", () => {
  const error = new DomainError("INVALID_INPUT", "bad request", {
    details: { field: "crop" },
  });
  assert.deepEqual(error.toJSON(), {
    name: "DomainError",
    code: "INVALID_INPUT",
    message: "bad request",
    status: 400,
    details: { field: "crop" },
  });
});

test("request validation normalizes safe fields and expands a cross-year season", () => {
  const normalized = validateAndNormalizeRequest(baseRequest());
  assert.equal(normalized.location.candidateToken, "token-123");
  assert.equal(normalized.growthStage, "UNSPECIFIED");
  assert.deepEqual(normalized.seasonMonths, [11, 12, 1, 2]);
  assert.deepEqual(normalized.options, {
    includeSmartfarmBenchmark: false,
    includeSatelliteObservation: false,
    saveConsent: false,
  });
});

test("request validation rejects invalid crop-mode, unconfirmed location, and injected coordinates", () => {
  assert.throws(
    () =>
      validateAndNormalizeRequest(
        baseRequest({ crop: "APPLE", cultivationMode: "FACILITY_SOIL" }),
      ),
    (error) => error.code === "INVALID_CULTIVATION_MODE",
  );
  assert.throws(
    () =>
      validateAndNormalizeRequest(
        baseRequest({
          location: { candidateToken: "x", userConfirmed: false },
        }),
      ),
    (error) => error.code === "LOCATION_NOT_CONFIRMED",
  );
  assert.throws(
    () =>
      validateAndNormalizeRequest(
        baseRequest({
          location: {
            candidateToken: "x",
            userConfirmed: true,
            latitude: 37.5,
          },
        }),
      ),
    (error) => error.code === "INVALID_LOCATION_SELECTION",
  );
  assert.throws(
    () =>
      validateAndNormalizeRequest(
        baseRequest({
          exactCoordinate: "37.5,127.0",
        }),
      ),
    (error) =>
      error.code === "INVALID_INPUT" &&
      error.details.fields.includes("exactCoordinate"),
  );
});

test("season combinations and growth-stage contexts are gated", () => {
  assert.throws(
    () =>
      validateAndNormalizeRequest(
        baseRequest({
          crop: "POTATO",
          cultivationMode: "OPEN_FIELD",
          season: undefined,
        }),
      ),
    (error) => error.code === "SEASON_REQUIRED",
  );
  const facility = validateAndNormalizeRequest(
    baseRequest({
      crop: "LETTUCE",
      cultivationMode: "FACILITY_HYDRO",
      season: undefined,
    }),
  );
  assert.equal(facility.season.kind, "NOT_APPLICABLE");
  assert.throws(
    () =>
      validateAndNormalizeRequest(
        baseRequest({
          growthStage: "FLOWERING",
        }),
        { growthStagesByCrop: { CUCUMBER: ["FLOWERING"] } },
      ),
    (error) => error.code === "INVALID_GROWTH_STAGE_CONTEXT",
  );
  const active = validateAndNormalizeRequest(
    baseRequest({
      usageMode: "ACTIVE_GROWING",
      growthStage: "flowering",
    }),
    { growthStagesByCrop: { CUCUMBER: ["FLOWERING"] } },
  );
  assert.equal(active.growthStage, "FLOWERING");
});

test("month expansion validates boundaries and never infers a month", () => {
  assert.deepEqual(expandSeasonMonths(3, 5), [3, 4, 5]);
  assert.deepEqual(expandSeasonMonths(11, 2), [11, 12, 1, 2]);
  assert.throws(
    () => expandSeasonMonths(0, 2),
    (error) => error.code === "INVALID_SEASON_MONTH",
  );
});

test("rule registry activates only rules with provenance, units, versions, and valid schemas", () => {
  const validDeviation = climateRule();
  const validTarget = climateRule({
    ruleId: "target",
    metric: "targetTemperature",
    use: "SINGLE_TARGET",
    evidenceStatus: "SINGLE_TARGET",
    target: 15,
    optimalRange: undefined,
    toleranceRange: undefined,
  });
  const validDisplay = climateRule({
    ruleId: "display",
    use: "DISPLAY_ONLY",
    evidenceStatus: "UNCONFIRMED",
    optimalRange: undefined,
    toleranceRange: undefined,
    sensitivityTier: undefined,
    critical: undefined,
  });
  const invalid = climateRule({ ruleId: "bad", unit: "", optimalRange: [10, 10] });
  const result = validateRuleRegistry([
    validDeviation,
    validTarget,
    validDisplay,
    invalid,
  ]);
  assert.deepEqual(
    result.validRules.map((rule) => rule.ruleId),
    ["climate-1", "target", "display"],
  );
  assert.equal(result.invalidRules.length, 1);
  assert.throws(
    () => createRuleRegistry([invalid]),
    (error) =>
      error.code === "INVALID_RULE_REGISTRY" && error.status === 500,
  );
});

test("invalid forecast numeric and duration contracts never activate", () => {
  const result = validateRuleRegistry([
    forecastRule({
      comparison: { operator: "BETWEEN", lower: 10, upper: 10 },
    }),
    forecastRule({
      ruleId: "duration-bad",
      duration: { kind: "CONSECUTIVE_DAYS", count: 0 },
    }),
  ]);
  assert.equal(result.validRules.length, 0);
  assert.equal(result.invalidRules.length, 2);
});

test("registry rejects duplicate periods and monthly/season aggregate double counting", () => {
  const monthly = climateRule({ ruleId: "monthly" });
  const aggregate = climateRule({
    ruleId: "aggregate",
    evaluationPeriod: {
      grain: "SEASON_AGGREGATE",
      aggregation: "MEAN",
    },
  });
  const result = validateRuleRegistry([monthly, aggregate]);
  assert.equal(result.validRules.length, 0);
  assert.deepEqual(
    result.invalidRules.map((item) => item.code),
    ["CONFLICTING_RULE_EVALUATION", "CONFLICTING_RULE_EVALUATION"],
  );
});

test("soil conflict scope and season profile allowlists follow season-independent activation", () => {
  const conflictingSoil = validateRuleRegistry([
    soilRule({
      ruleId: "soil-profile-a",
      seasonProfileId: "PROFILE_A",
      evaluationPeriod: { grain: "MONTH", month: 5 },
    }),
    soilRule({
      ruleId: "soil-profile-b",
      seasonProfileId: "PROFILE_B",
      evaluationPeriod: { grain: "MONTH", month: 6 },
      unit: "different-unit",
    }),
  ]);
  assert.equal(conflictingSoil.validRules.length, 0);
  assert.deepEqual(
    conflictingSoil.invalidRules.map(({ code }) => code),
    ["CONFLICTING_RULE_EVALUATION", "CONFLICTING_RULE_EVALUATION"],
  );

  const distinctStages = validateRuleRegistry([
    soilRule({
      ruleId: "soil-flowering",
      stage: "FLOWERING",
      evaluationPeriod: { grain: "MONTH", month: 5 },
    }),
    soilRule({
      ruleId: "soil-fruiting",
      stage: "FRUITING",
      evaluationPeriod: {
        grain: "SEASON_AGGREGATE",
        aggregation: "MEAN",
      },
    }),
  ]);
  assert.equal(distinctStages.validRules.length, 2);
  assert.equal(distinctStages.invalidRules.length, 0);

  const profileIndependentSoil = soilRule({
    ruleId: "soil-without-profile",
    metric: "profileIndependentSoilMetric",
  });
  delete profileIndependentSoil.seasonProfileId;
  const registry = createRuleRegistry([
    climateRule({ seasonProfileId: "REVIEWED_CLIMATE_PROFILE" }),
    profileIndependentSoil,
  ]);
  assert.deepEqual(
    registry.rules.map(({ ruleId }) => ruleId),
    ["climate-1", "soil-without-profile"],
  );
  assert.deepEqual(
    registry.seasonProfilesFor("CUCUMBER", "OPEN_FIELD"),
    ["REVIEWED_CLIMATE_PROFILE"],
  );
});

test("registry and soil engine keep soil and forecast active for UNKNOWN seasons", () => {
  const registry = createRuleRegistry([
    climateRule(),
    soilRule(),
    forecastRule(),
  ]);
  const request = validateAndNormalizeRequest(
    baseRequest({
      season: {
        kind: "UNKNOWN",
        profileId: "UNKNOWN",
        startMonth: null,
        endMonth: null,
        userConfirmed: true,
      },
    }),
    { ruleRegistry: registry },
  );

  assert.deepEqual(registry.resolve(request, "CLIMATE"), []);
  assert.deepEqual(
    registry.resolve(request, "SOIL").map(({ ruleId }) => ruleId),
    ["soil-1"],
  );
  assert.deepEqual(
    registry.resolve(request, "FORECAST").map(({ ruleId }) => ruleId),
    ["forecast-1"],
  );

  const soil = evaluateSoil({
    request,
    rules: registry.rules,
    intervalsByMetric: [soilDataset()],
  });
  assert.equal(soil.state, "READY");
  assert.deepEqual(soil.result.includedRuleIds, ["soil-1"]);
});

test("registry climate resolution uses the normalized CUSTOM month set", () => {
  const registry = createRuleRegistry([
    climateRule({ evaluationPeriod: { grain: "MONTH", month: 5 } }),
    climateRule({
      ruleId: "climate-month-11",
      metric: "meanTemperatureMonth11",
      evaluationPeriod: { grain: "MONTH", month: 11 },
    }),
    climateRule({
      ruleId: "climate-month-2",
      metric: "meanTemperatureMonth2",
      evaluationPeriod: { grain: "MONTH", month: 2 },
    }),
    climateRule({
      ruleId: "climate-month-3",
      metric: "meanTemperatureMonth3",
      evaluationPeriod: { grain: "MONTH", month: 3 },
    }),
    soilRule(),
    forecastRule(),
  ]);
  const requestForMonth = (month) =>
    validateAndNormalizeRequest(
      baseRequest({
        season: {
          kind: "CUSTOM",
          profileId: "CUSTOM",
          startMonth: month,
          endMonth: month,
          userConfirmed: true,
        },
      }),
      { ruleRegistry: registry },
    );

  assert.deepEqual(
    registry.resolve(requestForMonth(5), "CLIMATE").map(({ ruleId }) => ruleId),
    ["climate-1"],
  );
  assert.deepEqual(registry.resolve(requestForMonth(6), "CLIMATE"), []);
  assert.deepEqual(
    registry
      .resolve(validateAndNormalizeRequest(baseRequest(), { ruleRegistry: registry }), "CLIMATE")
      .map(({ ruleId }) => ruleId),
    ["climate-month-11", "climate-month-2"],
  );
  assert.deepEqual(
    registry.resolve(requestForMonth(6), "SOIL").map(({ ruleId }) => ruleId),
    ["soil-1"],
  );
});

test("invalid climate rules outside the CUSTOM month do not contaminate execution", () => {
  const invalidOutsideSeason = climateRule({
    ruleId: "invalid-month-6",
    evaluationPeriod: { grain: "MONTH", month: 6 },
  });
  delete invalidOutsideSeason.sourceTitle;
  const request = validateAndNormalizeRequest(
    baseRequest({
      season: {
        kind: "CUSTOM",
        profileId: "CUSTOM",
        startMonth: 5,
        endMonth: 5,
        userConfirmed: true,
      },
    }),
  );
  const result = evaluateClimate({
    request,
    rules: [climateRule(), invalidOutsideSeason],
    observations: [
      {
        metric: "meanTemperature",
        month: 5,
        value: 15,
        unit: "degC",
      },
    ],
  });

  assert.equal(result.state, "READY");
  assert.deepEqual(result.result.includedRuleIds, ["climate-1"]);
  assert.deepEqual(result.result.excludedRules, []);
});

test("request season profiles come from the validated registry and crop-specific kinds stay strict", () => {
  const registry = createRuleRegistry([
    climateRule({
      crop: "POTATO",
      seasonProfileId: "POTATO_REVIEWED_PROFILE",
    }),
  ]);
  const potato = validateAndNormalizeRequest(
    baseRequest({
      crop: "POTATO",
      season: {
        kind: "VERIFIED_PROFILE",
        profileId: "POTATO_REVIEWED_PROFILE",
        startMonth: null,
        endMonth: null,
        userConfirmed: true,
      },
    }),
    { ruleRegistry: registry },
  );
  assert.equal(potato.season.profileId, "POTATO_REVIEWED_PROFILE");

  assert.throws(
    () =>
      validateAndNormalizeRequest(
        baseRequest({
          crop: "APPLE",
          cultivationMode: "OPEN_FIELD",
          season: undefined,
        }),
        { ruleRegistry: createRuleRegistry([]) },
      ),
    (error) => error.code === "UNVERIFIED_SEASON_PROFILE",
  );

  assert.throws(
    () =>
      validateAndNormalizeRequest(
        baseRequest({
          crop: "APPLE",
          season: {
            kind: "CUSTOM",
            profileId: "CUSTOM",
            startMonth: 1,
            endMonth: 12,
            userConfirmed: true,
          },
        }),
      ),
    (error) => error.code === "INVALID_SEASON_CONTEXT",
  );
  assert.throws(
    () =>
      validateAndNormalizeRequest(
        baseRequest({
          season: {
            kind: "VERIFIED_PROFILE",
            profileId: "SOMETHING",
            startMonth: null,
            endMonth: null,
            userConfirmed: true,
          },
        }),
      ),
    (error) => error.code === "INVALID_SEASON_CONTEXT",
  );
});

test("normalized climate deviation preserves physical and unbounded normalized distance", () => {
  assert.equal(calculateNormalizedDeviation(10, [10, 20]), 0);
  assert.equal(calculateNormalizedDeviation(5, [10, 20]), 0.5);
  assert.equal(calculateNormalizedDeviation(25, [10, 20]), 0.5);
  assert.equal(calculateNormalizedDeviation(100, [10, 20]), 8);
  assert.equal(calculateNormalizedDeviation(10, [10, 10]), null);
});

test("climate coverage keeps missing planned weights and gates aggregate deviation at 70 percent", () => {
  const tiers = [
    ["r1", 1, "CRITICAL", true],
    ["r2", 2, "CRITICAL", true],
    ["r3", 3, "IMPORTANT", false],
    ["r4", 4, "SUPPORTING", false],
    ["r5", 5, "SUPPORTING", false],
  ];
  const rules = tiers.map(([ruleId, month, sensitivityTier, critical]) =>
    climateRule({
      ruleId,
      evaluationPeriod: { grain: "MONTH", month },
      sensitivityTier,
      critical,
    }),
  );
  const observations = [1, 2, 4].map((month) => ({
    metric: "meanTemperature",
    month,
    value: month === 1 ? 25 : 15,
    unit: "degC",
  }));
  const module = evaluateClimate({
    crop: "CUCUMBER",
    cultivationMode: "OPEN_FIELD",
    season: {
      kind: "CUSTOM",
      profileId: "CUSTOM",
      startMonth: 1,
      endMonth: 5,
    },
    rules,
    observations,
  });
  assert.equal(module.coverage, 0.7);
  assert.equal(module.state, "READY");
  assert.equal(module.result.aggregateDeviation, 1.5 / 7);
  assert.deepEqual(module.result.aggregation, {
    numerator: 1.5,
    denominator: 7,
    plannedDenominator: 10,
  });
});

test("critical climate missing input hides aggregate even at 70 percent coverage", () => {
  const rules = [
    climateRule({ ruleId: "r1", evaluationPeriod: { grain: "MONTH", month: 1 } }),
    climateRule({ ruleId: "r2", evaluationPeriod: { grain: "MONTH", month: 2 } }),
    climateRule({
      ruleId: "r3",
      evaluationPeriod: { grain: "MONTH", month: 3 },
      sensitivityTier: "IMPORTANT",
      critical: true,
    }),
    climateRule({
      ruleId: "r4",
      evaluationPeriod: { grain: "MONTH", month: 4 },
      sensitivityTier: "SUPPORTING",
      critical: false,
    }),
    climateRule({
      ruleId: "r5",
      evaluationPeriod: { grain: "MONTH", month: 5 },
      sensitivityTier: "SUPPORTING",
      critical: false,
    }),
  ];
  const module = evaluateClimate({
    cultivationMode: "OPEN_FIELD",
    season: {
      kind: "CUSTOM",
      profileId: "CUSTOM",
      startMonth: 1,
      endMonth: 5,
    },
    rules,
    observations: [1, 2, 4].map((month) => ({
      metric: "meanTemperature",
      month,
      value: 15,
      unit: "degC",
    })),
  });
  assert.equal(module.coverage, 0.7);
  assert.equal(module.state, "PARTIAL");
  assert.equal(module.result.aggregateDeviation, null);
});

test("climate coverage at 40 percent is PARTIAL and below 40 percent is HOLD", () => {
  const rules = [
    climateRule({ ruleId: "r1", evaluationPeriod: { grain: "MONTH", month: 1 } }),
    climateRule({ ruleId: "r2", evaluationPeriod: { grain: "MONTH", month: 2 } }),
    climateRule({
      ruleId: "r3",
      evaluationPeriod: { grain: "MONTH", month: 3 },
      sensitivityTier: "IMPORTANT",
      critical: false,
    }),
    climateRule({
      ruleId: "r4",
      evaluationPeriod: { grain: "MONTH", month: 4 },
      sensitivityTier: "SUPPORTING",
      critical: false,
    }),
    climateRule({
      ruleId: "r5",
      evaluationPeriod: { grain: "MONTH", month: 5 },
      sensitivityTier: "SUPPORTING",
      critical: false,
    }),
  ];
  const evaluate = (months) =>
    evaluateClimate({
      cultivationMode: "OPEN_FIELD",
      season: {
        kind: "CUSTOM",
        profileId: "CUSTOM",
        startMonth: 1,
        endMonth: 5,
      },
      rules,
      observations: months.map((month) => ({
        metric: "meanTemperature",
        month,
        value: 15,
        unit: "degC",
      })),
    });
  const atGate = evaluate([1, 4]);
  assert.equal(atGate.coverage, 0.4);
  assert.equal(atGate.state, "PARTIAL");
  assert.equal(atGate.result.aggregateDeviation, null);

  const belowGate = evaluate([1]);
  assert.equal(belowGate.coverage, 0.3);
  assert.equal(belowGate.state, "HOLD");
});

test("single targets never enter climate coverage or aggregate deviation", () => {
  const targetRule = climateRule({
    use: "SINGLE_TARGET",
    evidenceStatus: "SINGLE_TARGET",
    target: 15,
    optimalRange: undefined,
    toleranceRange: undefined,
  });
  const module = evaluateClimate({
    cultivationMode: "OPEN_FIELD",
    season: { kind: "VERIFIED_PROFILE", profileId: "CUSTOM" },
    rules: [targetRule],
    observations: [
      {
        ruleId: targetRule.ruleId,
        value: 18,
        unit: "degC",
      },
    ],
  });
  assert.equal(module.state, "READY");
  assert.equal(module.coverage, null);
  assert.equal(module.result.aggregateDeviation, null);
  assert.equal(module.result.singleTargetDeviations[0].absoluteDeviation, 3);
});

test("zero active deviation rules produce null coverage rather than 0/0", () => {
  const module = evaluateClimate({
    cultivationMode: "OPEN_FIELD",
    rules: [],
    observations: [],
  });
  assert.equal(module.coverage, null);
  assert.equal(module.result.aggregateDeviation, null);
  assert.ok(!Number.isNaN(module.coverage));
});

test("soil interval classification respects open boundaries", () => {
  assert.equal(
    classifySoilInterval(
      {
        lower: 6,
        upper: 7,
        lowerInclusive: true,
        upperInclusive: true,
      },
      [6, 7],
    ),
    "FIT",
  );
  assert.equal(
    classifySoilInterval(
      {
        lower: 5,
        upper: 6,
        lowerInclusive: true,
        upperInclusive: false,
      },
      [6, 7],
    ),
    "OUTSIDE",
  );
  assert.equal(
    classifySoilInterval(
      {
        lower: 5,
        upper: 6,
        lowerInclusive: true,
        upperInclusive: true,
      },
      [6, 7],
    ),
    "UNCERTAIN",
  );
});

test("soil uncertainty at exactly 30 percent is eligible; above it is PARTIAL", () => {
  const intervals = (uncertainArea) => [
    {
      lower: 5,
      upper: 6.5,
      lowerInclusive: true,
      upperInclusive: false,
      area: uncertainArea,
      areaUnit: "m2",
    },
    {
      lower: 6.5,
      upper: 7,
      lowerInclusive: true,
      upperInclusive: true,
      area: 100 - uncertainArea,
      areaUnit: "m2",
    },
  ];
  const atGate = evaluateSoil({
    cultivationMode: "OPEN_FIELD",
    rules: [soilRule()],
    intervalsByMetric: [
      soilDataset({ intervals: intervals(30) }),
    ],
  });
  assert.equal(atGate.state, "READY");
  assert.equal(atGate.result.metrics[0].uncertainRatio, 0.3);
  assert.equal(atGate.result.metrics[0].summaryEligible, true);

  const aboveGate = evaluateSoil({
    cultivationMode: "OPEN_FIELD",
    rules: [soilRule()],
    intervalsByMetric: [
      soilDataset({ intervals: intervals(30.1) }),
    ],
  });
  assert.equal(aboveGate.state, "PARTIAL");
  assert.equal(aboveGate.result.metrics[0].summaryEligible, false);
});

test("unverified soil boundary semantics HOLD and hydroponic soil is not applicable", () => {
  const held = evaluateSoil({
    cultivationMode: "OPEN_FIELD",
    rules: [soilRule()],
    intervalsByMetric: [
      soilDataset({ boundarySemanticsVerified: false }),
    ],
  });
  assert.equal(held.state, "HOLD");
  assert.equal(held.result.excludedRules[0].reason, "BOUNDARY_SEMANTICS_UNVERIFIED");

  const hydro = evaluateSoil({
    cultivationMode: "FACILITY_HYDRO",
    rules: [soilRule()],
    intervalsByMetric: [],
  });
  assert.equal(hydro.state, "NOT_APPLICABLE");
  assert.equal(hydro.coverage, null);
});

test("open-field and facility-soil with no active soil rules HOLD rather than NOT_APPLICABLE", () => {
  for (const cultivationMode of ["OPEN_FIELD", "FACILITY_SOIL"]) {
    const module = evaluateSoil({
      cultivationMode,
      rules: [],
      intervalsByMetric: [],
    });
    assert.equal(module.state, "HOLD");
    assert.equal(module.coverage, null);
    assert.deepEqual(module.blockingReasons, [
      "NO_ACTIVE_CONFIRMED_SOIL_RULES",
    ]);
  }
});

test("soil coverage uses original 3/2/1 planned weights", () => {
  const rules = [
    soilRule({ ruleId: "critical", metric: "criticalMetric" }),
    soilRule({
      ruleId: "important",
      metric: "importantMetric",
      sensitivityTier: "IMPORTANT",
      critical: false,
    }),
    soilRule({
      ruleId: "supporting",
      metric: "supportingMetric",
      sensitivityTier: "SUPPORTING",
      critical: false,
    }),
  ];
  const partial = evaluateSoil({
    cultivationMode: "OPEN_FIELD",
    rules,
    intervalsByMetric: [
      {
        ...soilDataset(),
        metric: "criticalMetric",
      },
    ],
  });
  assert.equal(partial.coverage, 0.5);
  assert.equal(partial.state, "PARTIAL");

  const hold = evaluateSoil({
    cultivationMode: "OPEN_FIELD",
    rules,
    intervalsByMetric: [
      {
        ...soilDataset(),
        metric: "importantMetric",
      },
    ],
  });
  assert.equal(hold.coverage, 2 / 6);
  assert.equal(hold.state, "HOLD");
});

test("soil coverage at 40 percent is PARTIAL and below 40 percent is HOLD", () => {
  const specifications = [
    ["m1", "CRITICAL", true],
    ["m2", "CRITICAL", true],
    ["m3", "IMPORTANT", false],
    ["m4", "SUPPORTING", false],
    ["m5", "SUPPORTING", false],
  ];
  const rules = specifications.map(([metric, sensitivityTier, critical]) =>
    soilRule({
      ruleId: `soil-${metric}`,
      metric,
      sensitivityTier,
      critical,
    }),
  );
  const dataset = (metric) => ({ ...soilDataset(), metric });
  const atGate = evaluateSoil({
    cultivationMode: "OPEN_FIELD",
    rules,
    intervalsByMetric: [dataset("m1"), dataset("m4")],
  });
  assert.equal(atGate.coverage, 0.4);
  assert.equal(atGate.state, "PARTIAL");

  const belowGate = evaluateSoil({
    cultivationMode: "OPEN_FIELD",
    rules,
    intervalsByMetric: [dataset("m1")],
  });
  assert.equal(belowGate.coverage, 0.3);
  assert.equal(belowGate.state, "HOLD");
});

test("forecast merge uses real ISO dates, short priority, and preserves both originals", () => {
  const shortDay = forecastDay("2026-07-25", "SHORT_GRID", {
    maxTemperature: 31,
  });
  const midDay = forecastDay("2026-07-25", "MID_REGIONAL", {
    maxTemperature: 29,
  });
  const midOnly = forecastDay("2026-07-26", "MID_REGIONAL");
  delete midOnly.units.windSpeed;
  const merged = mergeForecasts([shortDay], [midDay, midOnly]);
  assert.equal(merged.mergedDisplayDays[0].sourceType, "SHORT_GRID");
  assert.equal(merged.mergedDisplayDays[0].maxTemperature, 31);
  assert.equal(merged.shortDays.length, 1);
  assert.equal(merged.midDays.length, 2);
  assert.equal(merged.overlapEvidence.length, 1);
  assert.throws(
    () =>
      mergeForecasts(
        [forecastDay("2026-02-30", "SHORT_GRID")],
        [],
      ),
    (error) => error.code === "INVALID_FORECAST_DATE",
  );
});

test("missing forecast values cannot be reported as confirmed no-risk", () => {
  const days = [
    forecastDay("2026-07-25", "SHORT_GRID", { maxTemperature: 20 }),
    forecastDay("2026-07-26", "SHORT_GRID", { maxTemperature: null }),
  ];
  const partial = evaluateForecastRisks({
    days,
    rules: [forecastRule()],
    crop: "CUCUMBER",
    cultivationMode: "OPEN_FIELD",
  });
  assert.equal(partial.state, "PARTIAL");
  assert.equal(partial.risks.length, 0);
  assert.equal(partial.noActiveRisksConfirmed, false);
  assert.equal(partial.missingMetrics[0].reason, "MISSING_VALUE");

  const ready = evaluateForecastRisks({
    days: days.map((day) => ({ ...day, maxTemperature: 20 })),
    rules: [forecastRule()],
    crop: "CUCUMBER",
    cultivationMode: "OPEN_FIELD",
  });
  assert.equal(ready.state, "READY");
  assert.equal(ready.noActiveRisksConfirmed, true);
});

test("stale/sample forecasts never create current risk flags", () => {
  const stale = evaluateForecastRisks({
    days: [
      forecastDay("2026-07-25", "SHORT_GRID", {
        maxTemperature: 40,
        freshness: "STALE",
      }),
    ],
    rules: [forecastRule()],
    crop: "CUCUMBER",
    cultivationMode: "OPEN_FIELD",
  });
  assert.equal(stale.risks.length, 0);
  assert.equal(stale.state, "HOLD");
  assert.equal(stale.noActiveRisksConfirmed, false);
});

test("UNSPECIFIED stage never activates a stage-only forecast risk", () => {
  const result = evaluateForecastRisks({
    days: [
      forecastDay("2026-07-25", "SHORT_GRID", { maxTemperature: 40 }),
    ],
    rules: [forecastRule({ stage: "FLOWERING" })],
    crop: "CUCUMBER",
    cultivationMode: "OPEN_FIELD",
    growthStage: "UNSPECIFIED",
  });
  assert.equal(result.risks.length, 0);
  assert.equal(result.noActiveRisksConfirmed, false);
  assert.equal(result.state, "HOLD");
});

test("registry and forecast execution share ANY, UNSPECIFIED, and concrete stage semantics", () => {
  const rules = [
    forecastRule({ ruleId: "forecast-any", stage: "ANY" }),
    forecastRule({
      ruleId: "forecast-unspecified",
      stage: "UNSPECIFIED",
    }),
    forecastRule({
      ruleId: "forecast-flowering",
      stage: "FLOWERING",
    }),
  ];
  const registry = createRuleRegistry(rules);
  const baselineRequest = validateAndNormalizeRequest(baseRequest(), {
    ruleRegistry: registry,
  });
  const floweringRequest = validateAndNormalizeRequest(
    baseRequest({
      usageMode: "ACTIVE_GROWING",
      growthStage: "FLOWERING",
    }),
    { ruleRegistry: registry },
  );
  const evaluatedRuleIds = (request) =>
    evaluateForecastRisks({
      request,
      rules,
      days: [forecastDay("2026-07-25", "SHORT_GRID")],
    }).ruleEvaluations.map(({ ruleId }) => ruleId);

  assert.deepEqual(
    registry.resolve(baselineRequest, "FORECAST").map(({ ruleId }) => ruleId),
    ["forecast-any"],
  );
  assert.deepEqual(evaluatedRuleIds(baselineRequest), ["forecast-any"]);
  assert.deepEqual(
    registry.resolve(floweringRequest, "FORECAST").map(({ ruleId }) => ruleId),
    ["forecast-any", "forecast-flowering"],
  );
  assert.deepEqual(evaluatedRuleIds(floweringRequest), [
    "forecast-any",
    "forecast-flowering",
  ]);
});

test("scientific rules preserve their existing UNSPECIFIED baseline stage semantics", () => {
  const rules = [
    climateRule({ stage: "UNSPECIFIED" }),
    soilRule({ stage: "UNSPECIFIED" }),
  ];
  const registry = createRuleRegistry(rules);
  const request = validateAndNormalizeRequest(
    baseRequest({
      season: {
        kind: "CUSTOM",
        profileId: "CUSTOM",
        startMonth: 5,
        endMonth: 5,
        userConfirmed: true,
      },
    }),
    { ruleRegistry: registry },
  );

  assert.deepEqual(
    registry.resolve(request, "CLIMATE").map(({ ruleId }) => ruleId),
    ["climate-1"],
  );
  assert.deepEqual(
    registry.resolve(request, "SOIL").map(({ ruleId }) => ruleId),
    ["soil-1"],
  );
  assert.equal(
    evaluateClimate({
      request,
      rules,
      observations: [
        {
          metric: "meanTemperature",
          month: 5,
          value: 15,
          unit: "degC",
        },
      ],
    }).state,
    "READY",
  );
  assert.equal(
    evaluateSoil({
      request,
      rules,
      intervalsByMetric: [soilDataset()],
    }).state,
    "READY",
  );
});

test("duration risks cannot claim no-risk across an unevaluated source boundary or short horizon", () => {
  const durationRule = forecastRule({
    duration: { kind: "CONSECUTIVE_DAYS", count: 2 },
  });
  const boundary = evaluateForecastRisks({
    days: [
      forecastDay("2026-07-25", "SHORT_GRID"),
      forecastDay("2026-07-26", "MID_REGIONAL"),
    ],
    rules: [durationRule],
    crop: "CUCUMBER",
    cultivationMode: "OPEN_FIELD",
  });
  assert.equal(boundary.state, "PARTIAL");
  assert.equal(boundary.noActiveRisksConfirmed, false);
  assert.ok(
    boundary.missingMetrics.some(
      (item) => item.reason === "SOURCE_BOUNDARY_IN_WINDOW",
    ),
  );

  const shortHorizon = evaluateForecastRisks({
    days: [forecastDay("2026-07-25", "SHORT_GRID")],
    rules: [durationRule],
    crop: "CUCUMBER",
    cultivationMode: "OPEN_FIELD",
  });
  assert.equal(shortHorizon.state, "PARTIAL");
  assert.equal(shortHorizon.noActiveRisksConfirmed, false);
});

test("analysis states follow cultivation applicability and do not count sample as READY", () => {
  const ready = (result = {}) => ({
    state: "READY",
    result,
    qualityFlags: [],
  });
  const open = evaluateAnalysisStates({
    request: { cultivationMode: "OPEN_FIELD" },
    modules: {
      climate: ready(),
      soil: ready(),
      observations: ready(),
      shortForecast: ready(),
      midForecast: ready(),
    },
  });
  assert.deepEqual(
    [open.analysisState, open.conditionState, open.riskState],
    ["COMPLETE", "READY", "READY"],
  );

  const hydro = evaluateAnalysisStates({
    request: { cultivationMode: "FACILITY_HYDRO" },
    modules: {
      observations: ready(),
      shortForecast: ready(),
      midForecast: ready(),
    },
  });
  assert.equal(hydro.analysisState, "COMPLETE");
  assert.equal(hydro.conditionState, "NOT_APPLICABLE");

  const sample = evaluateAnalysisStates({
    request: { cultivationMode: "OPEN_FIELD" },
    modules: {
      climate: ready(),
      soil: { ...ready(), qualityFlags: ["SAMPLE"] },
      observations: ready(),
      shortForecast: ready(),
      midForecast: ready(),
    },
  });
  assert.equal(sample.analysisState, "PARTIAL");
  assert.equal(sample.conditionState, "PARTIAL");
});

test("risk state not READY prevents optimistic open-field next step", () => {
  const decision = decideGuidance({
    request: {
      usageMode: "LAND_SEARCH",
      cultivationMode: "OPEN_FIELD",
      season: { kind: "CUSTOM" },
    },
    modules: {
      climate: {
        state: "READY",
        result: {
          deviations: [
            {
              ruleId: "c1",
              critical: true,
              normalizedDeviation: 0,
            },
          ],
        },
        qualityFlags: [],
      },
      soil: {
        state: "READY",
        result: {
          metrics: [
            {
              ruleId: "s1",
              critical: true,
              fitRatio: 1,
              uncertainRatio: 0,
              outsideRatio: 0,
            },
          ],
        },
        qualityFlags: [],
      },
    },
    analysisStates: { conditionState: "READY", riskState: "PARTIAL" },
  });
  assert.equal(decision.code, "CHECK_FIRST");
  assert.ok(decision.triggerIds.includes("state:risk-not-ready"));
});

test("facility needs current short forecast before SENSOR_NEXT", () => {
  const decision = decideGuidance({
    request: {
      usageMode: "ACTIVE_GROWING",
      cultivationMode: "FACILITY_HYDRO",
    },
    modules: {
      forecast: {
        state: "READY",
        result: {
          risks: [],
          shortAvailable: false,
          midAvailable: true,
        },
        qualityFlags: [],
      },
    },
    analysisStates: { riskState: "READY" },
  });
  assert.equal(decision.code, "FACILITY_DATA_NEEDED");
});

test("facility SENSOR_NEXT requires an explicit, current no-risk conclusion", () => {
  const base = {
    request: {
      usageMode: "ACTIVE_GROWING",
      cultivationMode: "FACILITY_HYDRO",
    },
    analysisStates: { riskState: "READY" },
  };
  const missingConclusion = decideGuidance({
    ...base,
    modules: {
      forecast: {
        state: "READY",
        result: { risks: [], shortAvailable: true, midAvailable: true },
        qualityFlags: [],
      },
    },
  });
  assert.equal(missingConclusion.code, "FACILITY_DATA_NEEDED");

  const confirmed = decideGuidance({
    ...base,
    modules: {
      forecast: {
        state: "READY",
        result: {
          risks: [],
          shortAvailable: true,
          midAvailable: true,
          noActiveRisksConfirmed: true,
        },
        qualityFlags: [],
      },
    },
  });
  assert.equal(confirmed.code, "FACILITY_SENSOR_NEXT");
});

function action(overrides = {}) {
  return {
    actionId: "action-a",
    titleTemplateId: "action.title.a",
    usageModes: ["LAND_SEARCH", "ACTIVE_GROWING"],
    cultivationModes: ["OPEN_FIELD"],
    triggerIds: ["trigger-a"],
    blocking: false,
    severity: "INFO",
    dueWindow: "4_TO_10_DAYS",
    evidenceStrength: "UNCONFIRMED",
    sourceFreshness: "CURRENT",
    ruleOrder: 10,
    ...overrides,
  };
}

test("actions deduplicate after preserving every trigger and sort deterministically", () => {
  const ranked = rankActions([
    action({
      actionId: "duplicate",
      triggerIds: ["t1"],
      severity: "INFO",
      dueWindow: "4_TO_10_DAYS",
      ruleOrder: 9,
    }),
    action({
      actionId: "duplicate",
      triggerIds: ["t2"],
      severity: "WARNING",
      dueWindow: "NOW",
      evidenceStrength: "RISK_ONLY",
      ruleOrder: 7,
    }),
    action({
      actionId: "blocking",
      triggerIds: ["missing"],
      blocking: true,
      severity: "INFO",
      dueWindow: "BEFORE_DECISION",
      sourceFreshness: "NOT_APPLICABLE",
      ruleOrder: 1,
    }),
  ]);
  assert.deepEqual(ranked.map((item) => item.actionId), [
    "blocking",
    "duplicate",
  ]);
  assert.deepEqual(
    ranked.find((item) => item.actionId === "duplicate").triggerIds,
    ["t1", "t2"],
  );
  assert.equal(
    ranked.find((item) => item.actionId === "duplicate").severity,
    "WARNING",
  );
});

test("ACTIVE_GROWING current warning becomes primary before display truncation", () => {
  const ranked = rankActions([
    action({ actionId: "block-1", blocking: true, ruleOrder: 1 }),
    action({ actionId: "block-2", blocking: true, ruleOrder: 2 }),
    action({ actionId: "block-3", blocking: true, ruleOrder: 3 }),
    action({
      actionId: "urgent",
      severity: "WARNING",
      dueWindow: "1_TO_3_DAYS",
      evidenceStrength: "RISK_ONLY",
      sourceFreshness: "CURRENT",
      ruleOrder: 99,
    }),
  ]);
  const primary = selectPrimaryAction(
    { usageMode: "ACTIVE_GROWING" },
    ranked,
  );
  assert.equal(primary.actionId, "urgent");
  assert.equal(primary.selectionReason, "ACTIVE_GROWING_CURRENT_WARNING");
  const display = projectDisplayActions(primary, ranked, 3);
  assert.equal(display[0].actionId, "urgent");
  assert.equal(display.length, 3);
});

test("stale or sample risk-only candidates cannot become actions", () => {
  const ranked = rankActions([
    action({
      actionId: "stale-risk",
      evidenceStrength: "RISK_ONLY",
      sourceFreshness: "STALE",
      severity: "WARNING",
      dueWindow: "NOW",
    }),
    action({
      actionId: "sample-risk",
      evidenceStrength: "RISK_ONLY",
      sourceFreshness: "SAMPLE",
      severity: "WARNING",
      dueWindow: "NOW",
    }),
  ]);
  assert.deepEqual(ranked, []);
});

test("domain outputs contain no invented composite score or forecast penalty", () => {
  const climate = evaluateClimate({
    cultivationMode: "OPEN_FIELD",
    season: { kind: "CUSTOM", profileId: "CUSTOM", startMonth: 5, endMonth: 5 },
    rules: [climateRule()],
    observations: [
      {
        metric: "meanTemperature",
        month: 5,
        value: 15,
        unit: "degC",
      },
    ],
    forecastScorePenalty: 999,
  });
  assert.equal(Object.hasOwn(climate.result, "score"), false);
  assert.equal(Object.hasOwn(climate.result, "compositeScore"), false);
  assert.equal(Object.hasOwn(climate.result, "forecastPenalty"), false);
  assert.equal(climate.result.aggregateDeviation, 0);
});
