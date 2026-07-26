import { DomainError } from "./errors.js";

export function decideGuidance(input = {}) {
  const request = input.request ?? {};
  const modules = input.modules ?? {};
  const states = input.analysisStates ?? input.states ?? {};
  const cultivationMode =
    input.cultivationMode ?? request.cultivationMode ?? "OPEN_FIELD";
  const usageMode = input.usageMode ?? request.usageMode ?? "LAND_SEARCH";
  const facility = cultivationMode !== "OPEN_FIELD";

  const decision = facility
    ? decideFacility(modules, states)
    : decideOpenField(request, modules, states);
  const messageTemplateId = resolveTemplateId(
    input.templateRegistry,
    usageMode,
    cultivationMode,
    decision.code,
  );
  return {
    kind: facility ? "FACILITY_OPERATION" : "OPEN_FIELD_CONDITION",
    code: decision.code,
    messageTemplateId,
    triggerIds: unique(decision.triggerIds).sort(),
    limitations: unique(decision.limitations),
  };
}

function decideOpenField(request, modules, states) {
  const climate = modules.climate;
  const soil = modules.soil;
  const unknownSeason = request.season?.kind === "UNKNOWN";
  const unconfirmedClimateRules = climate?.blockingReasons?.some((reason) =>
    [
      "INVALID_RULE_SCHEMA",
      "NO_ACTIVE_CONFIRMED_RANGE_RULES",
      "SEASON_UNKNOWN",
    ].includes(reason),
  );
  const bothConditionModulesHeld =
    held(climate) && held(soil);

  if (unknownSeason || unconfirmedClimateRules || bothConditionModulesHeld) {
    return {
      code: "DATA_NEEDED",
      triggerIds: [
        ...(unknownSeason ? ["input:season:unknown"] : []),
        ...(unconfirmedClimateRules ? ["climate:rule-or-input-hold"] : []),
        ...(bothConditionModulesHeld ? ["condition:all-held"] : []),
      ],
      limitations: ["PUBLIC_DATA_INSUFFICIENT_FOR_OPEN_FIELD_CONDITION"],
    };
  }

  const climateSignals = climateDeviations(climate).filter(
    (deviation) => deviation.critical && deviation.normalizedDeviation > 0,
  );
  const risks = activeCurrentRisks(modules);
  const soilSignals = soilMetrics(soil).filter(
    (metric) =>
      metric.critical &&
      ((metric.fitRatio === 0 && metric.uncertainRatio === 0) ||
        metric.uncertainRatio > 0.3),
  );
  const soilConservative = ["PARTIAL", "HOLD", "UNAVAILABLE"].includes(
    soil?.state ?? "UNAVAILABLE",
  );
  const riskIncomplete =
    states.riskState !== "READY" || !noActiveRiskConclusionAvailable(modules);

  if (
    climateSignals.length > 0 ||
    risks.length > 0 ||
    riskIncomplete ||
    soilSignals.length > 0 ||
    soilConservative
  ) {
    return {
      code: "CHECK_FIRST",
      triggerIds: [
        ...climateSignals.map((item) => item.ruleId ?? `climate:${item.metric}`),
        ...risks.map((risk) => risk.riskId ?? risk.ruleId),
        ...(riskIncomplete ? ["state:risk-not-ready"] : []),
        ...soilSignals.map((item) => item.ruleId ?? `soil:${item.metric}`),
        ...(soilConservative ? ["state:soil-not-ready"] : []),
      ],
      limitations: [
        ...(riskIncomplete ? ["NO_RISK_CANNOT_BE_CONFIRMED"] : []),
        ...(soilConservative ? ["SOIL_SUMMARY_NOT_READY"] : []),
      ],
    };
  }

  const allConditionReady =
    climate?.state === "READY" &&
    soil?.state === "READY" &&
    states.conditionState === "READY";
  const allEvidenceCurrent = [climate, soil, riskModule(modules)].every(
    currentModule,
  );
  const allCriticalClimateWithin = climateDeviations(climate)
    .filter((item) => item.critical)
    .every((item) => item.normalizedDeviation === 0);
  const strongOutside = soilMetrics(soil).some(
    (metric) =>
      metric.critical &&
      (metric.outsideRatio === 1 || metric.uncertainRatio > 0.3),
  );

  if (
    allConditionReady &&
    states.riskState === "READY" &&
    allEvidenceCurrent &&
    allCriticalClimateWithin &&
    risks.length === 0 &&
    noActiveRiskConclusionAvailable(modules) &&
    !strongOutside
  ) {
    return {
      code: "FIELD_TEST_NEXT",
      triggerIds: ["state:condition-ready", "state:risk-ready"],
      limitations: ["REGIONAL_PUBLIC_DATA_IS_NOT_A_FIELD_MEASUREMENT"],
    };
  }

  return {
    code: "CHECK_FIRST",
    triggerIds: ["state:strict-next-step-gate-not-met"],
    limitations: ["FIELD_TEST_NEXT_REQUIREMENTS_NOT_CONFIRMED"],
  };
}

function decideFacility(modules, states) {
  const risks = activeCurrentRisks(modules);
  if (risks.length > 0) {
    return {
      code: "FACILITY_CHECK_FIRST",
      triggerIds: risks.map((risk) => risk.riskId ?? risk.ruleId),
      limitations: ["OUTDOOR_FORECAST_IS_NOT_INTERNAL_FACILITY_CONDITION"],
    };
  }
  if (
    states.riskState !== "READY" ||
    !currentModule(riskModule(modules)) ||
    !shortForecastAvailable(modules) ||
    !noActiveRiskConclusionAvailable(modules)
  ) {
    return {
      code: "FACILITY_DATA_NEEDED",
      triggerIds: [
        ...(states.riskState !== "READY" ? ["state:risk-not-ready"] : []),
        ...(!shortForecastAvailable(modules)
          ? ["forecast:current-short-unavailable"]
          : []),
      ],
      limitations: ["NO_CURRENT_FACILITY_OPERATION_RISK_CONFIRMATION"],
    };
  }
  return {
    code: "FACILITY_SENSOR_NEXT",
    triggerIds: ["state:risk-ready", "forecast:no-active-operation-risk"],
    limitations: ["INTERNAL_FACILITY_ENVIRONMENT_REQUIRES_SENSOR_CONFIRMATION"],
  };
}

function resolveTemplateId(registry, usageMode, cultivationMode, code) {
  const key = `${usageMode}.${cultivationMode}.${code}`;
  if (registry === undefined || registry === null) return key;
  const templateId =
    registry instanceof Map ? registry.get(key) : registry[key];
  if (typeof templateId !== "string" || templateId.trim() === "") {
    throw new DomainError(
      "MISSING_DECISION_TEMPLATE",
      `no reviewed decision template exists for ${key}`,
      { status: 500, details: { key } },
    );
  }
  return templateId;
}

function climateDeviations(module) {
  return module?.result?.deviations ?? module?.deviations ?? [];
}

function soilMetrics(module) {
  return module?.result?.metrics ?? module?.metrics ?? [];
}

function activeCurrentRisks(modules) {
  return forecastRisks(modules).filter(
    (risk) => (risk.sourceFreshness ?? risk.freshness) === "CURRENT",
  );
}

function noActiveRiskConclusionAvailable(modules) {
  const result = modules.forecast?.result ?? modules.forecast;
  return (
    result?.noActiveRisksConfirmed === true ||
    forecastRisks(modules).some(
      (risk) => (risk.sourceFreshness ?? risk.freshness) === "CURRENT",
    )
  );
}

function forecastRisks(modules) {
  return uniqueObjectsById(
    [
      ...(modules.forecast?.result?.risks ?? modules.forecast?.risks ?? []),
      ...(modules.shortForecast?.result?.risks ??
        modules.shortForecast?.risks ??
        []),
      ...(modules.midForecast?.result?.risks ?? modules.midForecast?.risks ?? []),
    ],
    (item) => item.riskId ?? `${item.ruleId}:${item.dateRange?.from ?? ""}`,
  );
}

function riskModule(modules) {
  if (modules.forecast) return modules.forecast;
  const summaries = [
    modules.observations ?? modules.observation,
    modules.shortForecast,
    modules.midForecast,
  ].filter(Boolean);
  return {
    state: summaries.every((summary) => summary.state === "READY")
      ? "READY"
      : summaries.some((summary) => summary.state === "PARTIAL")
        ? "PARTIAL"
        : "HOLD",
    qualityFlags: summaries.flatMap((summary) => summary.qualityFlags ?? []),
    result: summaries.some((summary) => summary.result != null) ? {} : null,
  };
}

function shortForecastAvailable(modules) {
  if (modules.shortForecast) return modules.shortForecast.state === "READY";
  const result = modules.forecast?.result ?? modules.forecast;
  return (
    result?.shortAvailable === true ||
    (Array.isArray(result?.shortDays) && result.shortDays.length > 0)
  );
}

function held(module) {
  return !module || ["HOLD", "UNAVAILABLE"].includes(module.state);
}

function currentModule(module) {
  if (!module || module.state !== "READY") return false;
  return !(
    module.deliveryState === "SAMPLE" ||
    module.qualityFlags?.includes("SAMPLE") ||
    module.qualityFlags?.includes("STALE")
  );
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function uniqueObjectsById(values, key) {
  const result = new Map();
  for (const value of values) {
    const id = key(value);
    if (!result.has(id)) result.set(id, value);
  }
  return [...result.values()];
}
