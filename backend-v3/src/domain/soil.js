import {
  PRODUCT_GUARDRAILS,
  RAW_WEIGHT_BY_TIER,
} from "./constants.js";
import {
  ruleMatchesRequestContext,
  validateRuleRegistry,
} from "../rules/registry.js";

const EPSILON = 1e-12;

export function classifySoilInterval(interval, optimalRange) {
  if (!validIntervalShape(interval) || !validRange(optimalRange)) {
    return null;
  }
  const [optimalLower, optimalUpper] = optimalRange;

  const fullyInside =
    interval.lower >= optimalLower && interval.upper <= optimalUpper;
  if (fullyInside) return "FIT";

  const below =
    interval.upper < optimalLower ||
    (interval.upper === optimalLower && !interval.upperInclusive);
  const above =
    interval.lower > optimalUpper ||
    (interval.lower === optimalUpper && !interval.lowerInclusive);
  if (below || above) return "OUTSIDE";

  return "UNCERTAIN";
}

export function evaluateSoil(input = {}) {
  const cultivationMode = input.cultivationMode ?? input.request?.cultivationMode;
  if (cultivationMode === "FACILITY_HYDRO") {
    return soilModule("NOT_APPLICABLE", null, [], [], {
      mode: "NOT_APPLICABLE",
      coverage: null,
      metrics: [],
      includedRuleIds: [],
      excludedRules: [],
      ruleVersion: "NONE",
    });
  }

  const validation = validateRuleRegistry(input.rules ?? []);
  const invalidSoilRules = validation.invalidRules.filter(
    ({ rule }) =>
      rule?.module === "SOIL" && invalidRuleMatchesContext(rule, input),
  );
  const rules = validation.validRules.filter(
    (rule) =>
      rule.module === "SOIL" &&
      rule.use === "DEVIATION" &&
      ruleMatchesRequestContext(rule, input),
  );
  const metricInputs = normalizeMetricInputs(
    input.intervalsByMetric ?? input.metrics ?? [],
  );
  const plannedWeight = rules.reduce(
    (sum, rule) => sum + RAW_WEIGHT_BY_TIER[rule.sensitivityTier],
    0,
  );
  let availableWeight = 0;
  const metrics = [];
  const includedRuleIds = [];
  const excludedRules = [];
  const missingInputs = [];
  const criticalMissing = [];
  const criticalUncertain = [];

  for (const rule of rules) {
    const dataset =
      metricInputs.find((item) => item.ruleId === rule.ruleId) ??
      metricInputs.find((item) => item.metric === rule.metric);
    const validationResult = validateMetricDataset(dataset, rule);
    if (!validationResult.valid) {
      excludedRules.push({
        ruleId: rule.ruleId,
        reason: validationResult.reason,
        adapterState: validationResult.adapterState,
      });
      missingInputs.push(rule.ruleId);
      if (rule.critical) criticalMissing.push(rule.ruleId);
      continue;
    }

    let fitArea = 0;
    let uncertainArea = 0;
    let outsideArea = 0;
    for (const interval of dataset.intervals) {
      const classification = classifySoilInterval(interval, rule.optimalRange);
      if (classification === "FIT") fitArea += interval.area;
      if (classification === "UNCERTAIN") uncertainArea += interval.area;
      if (classification === "OUTSIDE") outsideArea += interval.area;
    }
    const fitRatio = fitArea / dataset.totalValidArea;
    const uncertainRatio = uncertainArea / dataset.totalValidArea;
    const outsideRatio = outsideArea / dataset.totalValidArea;
    const summaryEligible =
      uncertainRatio <= PRODUCT_GUARDRAILS.soilUncertainMaximum + EPSILON;
    const rawWeight = RAW_WEIGHT_BY_TIER[rule.sensitivityTier];
    const ratioSum = fitRatio + uncertainRatio + outsideRatio;

    if (Math.abs(ratioSum - 1) > EPSILON) {
      excludedRules.push({
        ruleId: rule.ruleId,
        reason: "AREA_RATIO_MISMATCH",
        adapterState: "SCHEMA_CHANGED",
      });
      missingInputs.push(rule.ruleId);
      if (rule.critical) criticalMissing.push(rule.ruleId);
      continue;
    }

    availableWeight += rawWeight;
    includedRuleIds.push(rule.ruleId);
    if (rule.critical && !summaryEligible) criticalUncertain.push(rule.ruleId);
    metrics.push({
      ruleId: rule.ruleId,
      metric: rule.metric,
      unit: rule.unit,
      optimalRange: [...rule.optimalRange],
      ...(measuredPointValue(dataset) === null
        ? {}
        : { observedValue: measuredPointValue(dataset) }),
      fitRatio,
      uncertainRatio,
      outsideRatio,
      totalValidArea: dataset.totalValidArea,
      areaUnit: dataset.areaUnit,
      summaryEligible,
      rawWeight,
      critical: rule.critical,
    });
  }

  for (const invalid of invalidSoilRules) {
    excludedRules.push({
      ruleId: invalid.ruleId,
      reason: "INVALID_RULE_SCHEMA",
      adapterState: "SCHEMA_CHANGED",
    });
  }

  const coverage = plannedWeight === 0 ? null : availableWeight / plannedWeight;
  const result = {
    mode: cultivationMode === "FACILITY_SOIL" ? "FACILITY_REFERENCE" : "OPEN_FIELD",
    coverage,
    metrics,
    includedRuleIds,
    excludedRules,
    ruleVersion: combineVersions(rules),
  };

  if (invalidSoilRules.length > 0) {
    return soilModule(
      "HOLD",
      coverage,
      ["INVALID_RULE_SCHEMA"],
      unique(missingInputs),
      result,
    );
  }
  if (rules.length === 0) {
    return soilModule(
      "HOLD",
      null,
      ["NO_ACTIVE_CONFIRMED_SOIL_RULES"],
      [],
      result,
    );
  }
  if (
    metrics.length === 0 ||
    coverage < PRODUCT_GUARDRAILS.soilCoverageHold
  ) {
    return soilModule(
      "HOLD",
      coverage,
      [
        metrics.length === 0
          ? "NO_VALID_SOIL_METRICS"
          : "SOIL_COVERAGE_BELOW_40_PERCENT",
      ],
      unique(missingInputs),
      result,
    );
  }
  if (
    coverage < PRODUCT_GUARDRAILS.soilCoverageReady ||
    criticalMissing.length > 0 ||
    criticalUncertain.length > 0
  ) {
    const reasons = [];
    if (coverage < PRODUCT_GUARDRAILS.soilCoverageReady) {
      reasons.push("SOIL_COVERAGE_BELOW_70_PERCENT");
    }
    if (criticalMissing.length > 0) reasons.push("CRITICAL_SOIL_INPUT_MISSING");
    if (criticalUncertain.length > 0) {
      reasons.push("CRITICAL_SOIL_UNCERTAINTY_ABOVE_30_PERCENT");
    }
    return soilModule(
      "PARTIAL",
      coverage,
      reasons,
      unique(missingInputs),
      result,
    );
  }
  return soilModule("READY", coverage, [], unique(missingInputs), result);
}

function measuredPointValue(dataset) {
  if (
    dataset?.areaUnit !== "MEASURED_POINT" ||
    dataset.intervals?.length !== 1
  ) {
    return null;
  }
  const interval = dataset.intervals[0];
  return interval.lower === interval.upper && Number.isFinite(interval.lower)
    ? interval.lower
    : null;
}

function validateMetricDataset(dataset, rule) {
  if (dataset === undefined) {
    return { valid: false, reason: "MISSING_VALUE", adapterState: "NO_DATA" };
  }
  if (dataset.boundarySemanticsVerified !== true) {
    return {
      valid: false,
      reason: "BOUNDARY_SEMANTICS_UNVERIFIED",
      adapterState: "SCHEMA_CHANGED",
    };
  }
  if (dataset.unit !== rule.unit) {
    return { valid: false, reason: "UNIT_MISMATCH", adapterState: "SCHEMA_CHANGED" };
  }
  if (
    !Array.isArray(dataset.intervals) ||
    dataset.intervals.length === 0 ||
    !Number.isFinite(dataset.totalValidArea) ||
    dataset.totalValidArea <= 0 ||
    typeof dataset.areaUnit !== "string" ||
    dataset.areaUnit.trim() === ""
  ) {
    return {
      valid: false,
      reason: "INVALID_AREA_CONTRACT",
      adapterState:
        dataset.totalValidArea === 0 ? "NO_DATA" : "SCHEMA_CHANGED",
    };
  }
  if (
    dataset.intervals.some(
      (interval) =>
        !validIntervalShape(interval) ||
        !Number.isFinite(interval.area) ||
        interval.area < 0 ||
        interval.areaUnit !== dataset.areaUnit,
    )
  ) {
    return {
      valid: false,
      reason: "INVALID_INTERVAL_SCHEMA",
      adapterState: "SCHEMA_CHANGED",
    };
  }
  if (hasOverlappingIntervals(dataset.intervals)) {
    return {
      valid: false,
      reason: "OVERLAPPING_INTERVALS",
      adapterState: "SCHEMA_CHANGED",
    };
  }

  const intervalArea = dataset.intervals.reduce(
    (sum, interval) => sum + interval.area,
    0,
  );
  const tolerance =
    dataset.areaToleranceVerified === true &&
    Number.isFinite(dataset.areaTolerance) &&
    dataset.areaTolerance >= 0
      ? dataset.areaTolerance
      : 0;
  if (Math.abs(intervalArea - dataset.totalValidArea) > tolerance + EPSILON) {
    return {
      valid: false,
      reason: "AREA_SUM_MISMATCH",
      adapterState: "SCHEMA_CHANGED",
    };
  }
  return { valid: true };
}

function validIntervalShape(interval) {
  return (
    interval !== null &&
    typeof interval === "object" &&
    Number.isFinite(interval.lower) &&
    Number.isFinite(interval.upper) &&
    (interval.lower < interval.upper ||
      (interval.lower === interval.upper &&
        interval.lowerInclusive === true &&
        interval.upperInclusive === true)) &&
    typeof interval.lowerInclusive === "boolean" &&
    typeof interval.upperInclusive === "boolean"
  );
}

function hasOverlappingIntervals(intervals) {
  const sorted = [...intervals].sort(
    (left, right) => left.lower - right.lower || left.upper - right.upper,
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (current.lower < previous.upper) return true;
    if (
      current.lower === previous.upper &&
      current.lowerInclusive &&
      previous.upperInclusive
    ) {
      return true;
    }
  }
  return false;
}

function validRange(range) {
  return (
    Array.isArray(range) &&
    range.length === 2 &&
    Number.isFinite(range[0]) &&
    Number.isFinite(range[1]) &&
    range[0] < range[1]
  );
}

function normalizeMetricInputs(input) {
  if (Array.isArray(input)) return input;
  if (input === null || typeof input !== "object") return [];
  return Object.entries(input).map(([metric, dataset]) => ({
    metric,
    ...(dataset ?? {}),
  }));
}

function invalidRuleMatchesContext(rule, input) {
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
    typeof rule.stage === "string" &&
    rule.stage !== "ANY" &&
    rule.stage !== growthStage
  ) {
    return false;
  }
  return true;
}

function soilModule(state, coverage, blockingReasons, missingInputs, result) {
  return {
    state,
    coverage,
    blockingReasons,
    missingInputs,
    qualityFlags: [],
    result,
  };
}

function combineVersions(rules) {
  const versions = unique(rules.map((rule) => rule.ruleVersion)).sort();
  return versions.length === 0 ? "NONE" : versions.join("+");
}

function unique(values) {
  return [...new Set(values)];
}
