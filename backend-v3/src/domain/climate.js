import { PRODUCT_GUARDRAILS, RAW_WEIGHT_BY_TIER } from "./constants.js";
import {
  ruleMatchesRequestContext,
  validateRuleRegistry,
} from "../rules/registry.js";
import { expandSeasonMonths } from "./season.js";

export function calculateNormalizedDeviation(value, optimalRange) {
  if (
    !Number.isFinite(value) ||
    !Array.isArray(optimalRange) ||
    optimalRange.length !== 2 ||
    !Number.isFinite(optimalRange[0]) ||
    !Number.isFinite(optimalRange[1]) ||
    optimalRange[0] >= optimalRange[1]
  ) {
    return null;
  }
  const [lower, upper] = optimalRange;
  const width = upper - lower;
  if (value < lower) return (lower - value) / width;
  if (value > upper) return (value - upper) / width;
  return 0;
}

export function evaluateClimate(input = {}) {
  const cultivationMode = input.cultivationMode ?? input.request?.cultivationMode;
  if (cultivationMode && cultivationMode !== "OPEN_FIELD") {
    return climateModule("NOT_APPLICABLE", null, [], [], {
      mode: "NOT_APPLICABLE",
      coverage: null,
      aggregateDeviation: null,
      deviations: [],
      singleTargetDeviations: [],
      includedRuleIds: [],
      excludedRules: [],
      ruleVersion: "NONE",
      aggregation: null,
    });
  }

  const season = input.season ?? input.request?.season ?? null;
  if (season?.kind === "UNKNOWN") {
    return climateModule(
      "HOLD",
      null,
      ["SEASON_UNKNOWN"],
      ["season"],
      emptyClimateResult("VARIABLE_DEVIATIONS_ONLY"),
    );
  }

  const validation = validateRuleRegistry(input.rules ?? []);
  const invalidClimateRules = validation.invalidRules.filter(
    ({ rule }) =>
      rule?.module === "CLIMATE" &&
      invalidRuleMatchesContext(rule, input, season),
  );
  const activeRules = validation.validRules.filter(
    (rule) =>
      rule.module === "CLIMATE" &&
      ruleMatchesRequestContext(rule, input) &&
      rule.use !== "DISPLAY_ONLY",
  );
  const deviationRules = activeRules.filter((rule) => rule.use === "DEVIATION");
  const singleTargetRules = activeRules.filter(
    (rule) => rule.use === "SINGLE_TARGET",
  );
  const observations = normalizeObservations(
    input.observations ?? input.values ?? [],
  );
  // 평년값 어댑터는 월별 관측값만 내보낸다. 계절 범위를 아는 것은 이
  // 계층이므로 SEASON_AGGREGATE 규칙이 필요한 집계는 여기서 만든다.
  observations.push(
    ...deriveSeasonAggregateObservations(observations, activeRules, season, input),
  );
  const excludedRules = [];
  const deviations = [];
  const singleTargetDeviations = [];
  const includedRuleIds = [];
  const missingInputs = [];

  const plannedWeight = deviationRules.reduce(
    (sum, rule) => sum + RAW_WEIGHT_BY_TIER[rule.sensitivityTier],
    0,
  );
  let availableWeight = 0;
  let weightedDeviation = 0;
  const missingCritical = [];

  for (const rule of deviationRules) {
    const found = findObservation(observations, rule);
    const exclusionReason = observationExclusionReason(found, rule);
    if (exclusionReason !== null) {
      excludedRules.push({ ruleId: rule.ruleId, reason: exclusionReason });
      missingInputs.push(rule.ruleId);
      if (rule.critical) missingCritical.push(rule.ruleId);
      continue;
    }

    const normalizedDeviation = calculateNormalizedDeviation(
      found.value,
      rule.optimalRange,
    );
    const [lower, upper] = rule.optimalRange;
    const direction =
      found.value < lower
        ? "BELOW"
        : found.value > upper
          ? "ABOVE"
          : "WITHIN";
    const amount =
      direction === "BELOW"
        ? lower - found.value
        : direction === "ABOVE"
          ? found.value - upper
          : 0;
    const rawWeight = RAW_WEIGHT_BY_TIER[rule.sensitivityTier];
    availableWeight += rawWeight;
    weightedDeviation += rawWeight * normalizedDeviation;
    includedRuleIds.push(rule.ruleId);
    deviations.push({
      ruleId: rule.ruleId,
      metric: rule.metric,
      observedValue: found.value,
      unit: rule.unit,
      optimalRange: [...rule.optimalRange],
      physicalDeviation: { direction, amount },
      normalizedDeviation,
      rawWeight,
      critical: rule.critical,
      evidenceStatus: rule.evidenceStatus,
      sourceRefs: [rule.sourceUrl],
    });
  }

  for (const rule of singleTargetRules) {
    const found = findObservation(observations, rule);
    const exclusionReason = observationExclusionReason(found, rule);
    if (exclusionReason !== null) {
      excludedRules.push({ ruleId: rule.ruleId, reason: exclusionReason });
      missingInputs.push(rule.ruleId);
      continue;
    }
    includedRuleIds.push(rule.ruleId);
    singleTargetDeviations.push({
      ruleId: rule.ruleId,
      observedValue: found.value,
      target: rule.target,
      absoluteDeviation: Math.abs(found.value - rule.target),
      unit: rule.unit,
    });
  }

  for (const invalid of invalidClimateRules) {
    excludedRules.push({
      ruleId: invalid.ruleId,
      reason: "INVALID_RULE_SCHEMA",
    });
  }

  const coverage = plannedWeight === 0 ? null : availableWeight / plannedWeight;
  const aggregateEligible =
    coverage !== null &&
    coverage >= PRODUCT_GUARDRAILS.climateCoverageReady &&
    missingCritical.length === 0 &&
    invalidClimateRules.length === 0;
  const aggregateDeviation =
    aggregateEligible && availableWeight > 0
      ? weightedDeviation / availableWeight
      : null;
  const mode =
    deviationRules.length > 0
      ? aggregateEligible
        ? "DEVIATION_COMPOSITE"
        : "VARIABLE_DEVIATIONS_ONLY"
      : singleTargetRules.length > 0
        ? "SINGLE_TARGET_ONLY"
        : "VARIABLE_DEVIATIONS_ONLY";
  const result = {
    mode,
    coverage,
    aggregateDeviation,
    deviations,
    singleTargetDeviations,
    includedRuleIds,
    excludedRules,
    ruleVersion: combineVersions(activeRules),
    aggregation:
      aggregateDeviation === null
        ? null
        : {
            numerator: weightedDeviation,
            denominator: availableWeight,
            plannedDenominator: plannedWeight,
          },
  };

  if (invalidClimateRules.length > 0) {
    return climateModule(
      "HOLD",
      coverage,
      ["INVALID_RULE_SCHEMA"],
      unique(missingInputs),
      result,
    );
  }
  if (deviationRules.length === 0) {
    if (
      singleTargetRules.length > 0 &&
      singleTargetDeviations.length > 0
    ) {
      return climateModule("READY", null, [], unique(missingInputs), result);
    }
    return climateModule(
      "HOLD",
      null,
      ["NO_ACTIVE_CONFIRMED_RANGE_RULES"],
      unique(missingInputs),
      result,
    );
  }
  if (coverage < PRODUCT_GUARDRAILS.climateCoverageHold) {
    return climateModule(
      "HOLD",
      coverage,
      ["CLIMATE_COVERAGE_BELOW_40_PERCENT"],
      unique(missingInputs),
      result,
    );
  }
  if (!aggregateEligible) {
    const reasons = [];
    if (coverage < PRODUCT_GUARDRAILS.climateCoverageReady) {
      reasons.push("CLIMATE_COVERAGE_BELOW_70_PERCENT");
    }
    if (missingCritical.length > 0) reasons.push("CRITICAL_CLIMATE_INPUT_MISSING");
    return climateModule(
      "PARTIAL",
      coverage,
      reasons,
      unique(missingInputs),
      result,
    );
  }
  return climateModule("READY", coverage, [], unique(missingInputs), result);
}

function climateModule(state, coverage, blockingReasons, missingInputs, result) {
  return {
    state,
    coverage,
    blockingReasons,
    missingInputs,
    qualityFlags: [],
    result,
  };
}

function emptyClimateResult(mode) {
  return {
    mode,
    coverage: null,
    aggregateDeviation: null,
    deviations: [],
    singleTargetDeviations: [],
    includedRuleIds: [],
    excludedRules: [],
    ruleVersion: "NONE",
    aggregation: null,
  };
}

function normalizeObservations(observations) {
  if (Array.isArray(observations)) return observations;
  if (observations === null || typeof observations !== "object") return [];
  return Object.entries(observations).map(([ruleId, observation]) =>
    observation !== null && typeof observation === "object"
      ? { ruleId, ...observation }
      : { ruleId, value: observation },
  );
}

/**
 * 월별 평년값에서 계절 집계 관측값을 파생시킨다.
 * 원본 관측값은 그대로 두고 부족한 집계만 덧붙이므로, 어댑터가 이미
 * 집계를 제공하면 그 값을 우선한다. 필요한 달이 하나라도 비면 만들지
 * 않고 규칙이 MISSING_VALUE로 제외되게 둔다.
 */
function deriveSeasonAggregateObservations(observations, rules, season, input) {
  const wanted = new Map();
  for (const rule of rules) {
    const period = rule.evaluationPeriod;
    if (period?.grain !== "SEASON_AGGREGATE") continue;
    if (period.aggregation !== "MEAN") continue;
    const key = `${rule.metric}:${period.aggregation}`;
    if (!wanted.has(key)) {
      wanted.set(key, { metric: rule.metric, aggregation: period.aggregation });
    }
  }
  if (wanted.size === 0) return [];

  const months = seasonAggregateMonths(season, input);
  if (months === null) return [];

  const derived = [];
  for (const { metric, aggregation } of wanted.values()) {
    const alreadyProvided = observations.some(
      (value) =>
        value?.metric === metric &&
        value?.grain === "SEASON_AGGREGATE" &&
        value?.aggregation === aggregation,
    );
    if (alreadyProvided) continue;

    const monthly = months.map((month) =>
      observations.find(
        (value) => value?.metric === metric && value?.month === month,
      ),
    );
    if (monthly.some((value) => value === undefined)) continue;
    if (!monthly.every((value) => Number.isFinite(value.value))) continue;
    const units = unique(monthly.map((value) => value.unit));
    if (units.length !== 1) continue;

    const total = monthly.reduce((sum, value) => sum + value.value, 0);
    derived.push({
      metric,
      grain: "SEASON_AGGREGATE",
      aggregation,
      value: Number((total / monthly.length).toFixed(2)),
      unit: units[0],
      derivedFromMonths: [...months],
    });
  }
  return derived;
}

/**
 * 사과·배의 VERIFIED_PROFILE은 연간 프로파일이라 startMonth/endMonth가
 * null이다. 이 경우 12개월 전체를 집계 범위로 본다.
 */
function seasonAggregateMonths(season, input) {
  const explicit =
    input.seasonMonths ?? input.request?.seasonMonths ?? season?.months;
  if (Array.isArray(explicit) && explicit.length > 0) return explicit;
  if (
    Number.isInteger(season?.startMonth) &&
    Number.isInteger(season?.endMonth)
  ) {
    return expandSeasonMonths(season.startMonth, season.endMonth);
  }
  if (season?.kind === "VERIFIED_PROFILE") {
    return Array.from({ length: 12 }, (_, index) => index + 1);
  }
  return null;
}

function findObservation(observations, rule) {
  const direct = observations.find((value) => value?.ruleId === rule.ruleId);
  if (direct !== undefined) return direct;
  return observations.find(
    (value) =>
      value?.metric === rule.metric &&
      periodMatchesObservation(rule.evaluationPeriod, value),
  );
}

function periodMatchesObservation(period, observation) {
  if (period.grain === "MONTH") return observation.month === period.month;
  return (
    observation.grain === "SEASON_AGGREGATE" &&
    observation.aggregation === period.aggregation
  );
}

function observationExclusionReason(observation, rule) {
  if (observation === undefined || observation?.value === null) {
    return "MISSING_VALUE";
  }
  if (!Number.isFinite(observation?.value)) return "INVALID_VALUE";
  if (observation.unit !== rule.unit) return "UNIT_MISMATCH";
  return null;
}

function invalidRuleMatchesContext(rule, input, season) {
  const request = input.request ?? {};
  const crop = input.crop ?? request.crop;
  const cultivationMode = input.cultivationMode ?? request.cultivationMode;
  const growthStage = input.growthStage ?? request.growthStage ?? "UNSPECIFIED";
  if (crop && rule.crop && rule.crop !== crop) return false;
  if (
    cultivationMode &&
    rule.cultivationMode &&
    rule.cultivationMode !== cultivationMode
  ) {
    return false;
  }
  if (
    season?.profileId &&
    rule.seasonProfileId &&
    rule.seasonProfileId !== season.profileId
  ) {
    return false;
  }
  if (
    typeof rule.stage === "string" &&
    rule.stage !== "ANY" &&
    rule.stage !== growthStage
  ) {
    return false;
  }
  if (
    season?.kind === "CUSTOM" &&
    rule?.evaluationPeriod?.grain === "MONTH" &&
    Number.isInteger(rule.evaluationPeriod.month)
  ) {
    const activeMonths =
      input.seasonMonths ??
      request.seasonMonths ??
      season.months ??
      expandSeasonMonths(season.startMonth, season.endMonth);
    if (!activeMonths.includes(rule.evaluationPeriod.month)) return false;
  }
  return true;
}

function combineVersions(rules) {
  const versions = unique(rules.map((rule) => rule.ruleVersion)).sort();
  return versions.length === 0 ? "NONE" : versions.join("+");
}

function unique(values) {
  return [...new Set(values)];
}
