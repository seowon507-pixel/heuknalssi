const SCORE_VERSION = "growth-score-v2";

const IMPORTANCE_BY_MODE = Object.freeze({
  OPEN_FIELD: Object.freeze({ climate: 0.2, soil: 0.3, forecast: 0.5 }),
  FACILITY_SOIL: Object.freeze({ soil: 0.4, forecast: 0.6 }),
  FACILITY_HYDRO: Object.freeze({ forecast: 1 }),
});

const SOURCE_TRUST = Object.freeze({
  CLIMATE_NORMAL: 0.7,
  USER_OR_PROVIDER_SOIL_RECENT: 0.95,
  USER_OR_PROVIDER_SOIL_AGED: 0.75,
  USER_OR_PROVIDER_SOIL_OLD: 0.5,
  REGIONAL_SOIL: 0.25,
  SHORT_GRID: 0.9,
  MID_REGIONAL: 0.65,
});

const FORECAST_LEVEL_SCORE = Object.freeze({
  DANGER: 35,
  CAUTION: 60,
  NORMAL: 80,
  FAVORABLE: 92,
});

const FORECAST_SEVERITY_BASE = Object.freeze({
  WARNING: 45,
  CAUTION: 65,
  INFO: 82,
});

const MINIMUM_EVIDENCE_STRENGTH = 0.35;
const MAX_REGIONAL_SOIL_SHARE = 0.12;

/**
 * 환경 기반 생육지표 v2.
 *
 * 각 축의 작물 영향도에 자료 신뢰도와 실제 충족도를 곱해 합산한다.
 * 지역 토양통계는 필지 실측보다 낮은 신뢰도를 가져 전체 점수를 지배하지
 * 못한다. 결측값은 0으로 바꾸지 않으며, 근거강도가 0.35 미만이면 점수
 * 자체를 보류한다. 고신뢰 위험 신호는 별도의 상한으로 보존한다.
 */
export function calculateGrowthScore(input = {}) {
  const cultivationMode =
    input.cultivationMode ?? input.request?.cultivationMode ?? "OPEN_FIELD";
  const importance =
    IMPORTANCE_BY_MODE[cultivationMode] ?? IMPORTANCE_BY_MODE.OPEN_FIELD;
  const scored = {
    climate: scoreClimate(input.climate),
    soil: scoreSoil(input.soil, input.now),
    forecast: scoreForecast(input.forecast),
  };
  let applicable = Object.entries(importance).map(([key, weight]) => {
    const value = scored[key];
    const effectiveWeight = Number.isFinite(value.score)
      ? round(weight * value.trust * value.coverage, 6)
      : 0;
    return [
      key,
      {
        ...value,
        importance: weight,
        effectiveWeight,
      },
    ];
  });
  applicable = limitRegionalSoilShare(applicable);

  if (cultivationMode === "FACILITY_HYDRO") {
    return facilityHydroResult(applicable);
  }
  const available = applicable.filter(
    ([, value]) => Number.isFinite(value.score) && value.effectiveWeight > 0,
  );
  const evidenceStrength = available.reduce(
    (sum, [, value]) => sum + value.effectiveWeight,
    0,
  );
  const dataCoverage = applicable.reduce(
    (sum, [, value]) => sum + value.importance * value.coverage,
    0,
  );
  const rawScore =
    evidenceStrength >= MINIMUM_EVIDENCE_STRENGTH
      ? available.reduce(
          (sum, [, value]) => sum + value.score * value.effectiveWeight,
          0,
        ) / evidenceStrength
      : null;
  const cap = scoreCap(input.forecast, Object.fromEntries(applicable).soil);
  const score = Number.isFinite(rawScore)
    ? Math.round(Math.min(rawScore, cap.value))
    : null;
  const allReady = applicable.every(([, value]) => value.state === "READY");
  const state = score === null ? "HOLD" : allReady ? "READY" : "PARTIAL";

  return deepFreeze({
    state,
    score,
    rawScore: Number.isFinite(rawScore) ? round(rawScore, 2) : null,
    label: labelForScore(score),
    calculation: "EVIDENCE_WEIGHTED_MEAN_WITH_GUARDRAILS",
    version: SCORE_VERSION,
    scoreCap: cap,
    confidence: {
      level: confidenceLevel(evidenceStrength),
      coverage: round(dataCoverage, 4),
      evidenceStrength: round(evidenceStrength, 4),
      minimumRequired: MINIMUM_EVIDENCE_STRENGTH,
      availableComponents: available.map(([key]) => key),
      missingComponents: applicable
        .filter(([, value]) => !Number.isFinite(value.score))
        .map(([key]) => key),
    },
    components: Object.fromEntries(applicable),
  });
}

function scoreClimate(module) {
  const deviation = module?.result?.aggregateDeviation;
  if (!Number.isFinite(deviation)) {
    return unavailableComponent(module, "NO_AGGREGATE_DEVIATION", {
      trust: SOURCE_TRUST.CLIMATE_NORMAL,
      coverage: moduleCoverage(module),
      basis: "CLIMATE_NORMAL_STATION",
    });
  }
  return component(module, 100 / (1 + Math.max(0, deviation)), {
    trust: SOURCE_TRUST.CLIMATE_NORMAL,
    coverage: moduleCoverage(module),
    basis: "CLIMATE_NORMAL_STATION",
    factors: ["cropRangeDeviation"],
  });
}

function scoreSoil(module, now) {
  const metrics = Array.isArray(module?.result?.metrics)
    ? module.result.metrics.filter(validSoilMetric)
    : [];
  const basis = module?.result?.measurementBasis ?? "REGIONAL_STATISTICS";
  const trust = soilTrust(module, basis, now);
  if (metrics.length === 0) {
    return unavailableComponent(module, "NO_VALID_SOIL_METRICS", {
      trust,
      coverage: moduleCoverage(module),
      basis,
    });
  }
  const denominator = metrics.reduce((sum, metric) => sum + metric.rawWeight, 0);
  if (!(denominator > 0)) {
    return unavailableComponent(module, "NO_VALID_SOIL_WEIGHT", {
      trust,
      coverage: moduleCoverage(module),
      basis,
    });
  }
  const pointMetrics = metrics.filter(validMeasuredPointMetric);
  const numerator = metrics.reduce((sum, metric) => {
    const metricScore = validMeasuredPointMetric(metric)
      ? measuredPointScore(metric.observedValue, metric.optimalRange)
      : metric.fitRatio * 100 + metric.uncertainRatio * 50;
    return sum + metric.rawWeight * metricScore;
  }, 0);
  return component(module, numerator / denominator, {
    trust,
    coverage: moduleCoverage(module),
    basis,
    factors:
      pointMetrics.length > 0
        ? ["measuredValueDeviation"]
        : ["fitArea", "uncertainArea"],
  });
}

function scoreForecast(module) {
  const dailyOutlooks = Array.isArray(module?.result?.dailyOutlooks)
    ? module.result.dailyOutlooks
    : [];
  const trust = forecastTrust(module);
  const coverage = forecastCoverage(module);
  const weightedDays = dailyOutlooks
    .map((day, index) => ({
      weight: dailyOutlooks.length - index,
      score: FORECAST_LEVEL_SCORE[day?.level],
    }))
    .filter(({ score }) => Number.isFinite(score));
  if (weightedDays.length > 0) {
    const denominator = weightedDays.reduce((sum, item) => sum + item.weight, 0);
    const numerator = weightedDays.reduce(
      (sum, item) => sum + item.score * item.weight,
      0,
    );
    return component(module, numerator / denominator, {
      trust,
      coverage,
      basis: "DAILY_FORECAST_OUTLOOK",
      factors: ["dailyOutlook", "leadTime"],
    });
  }

  const risks = Array.isArray(module?.result?.risks) ? module.result.risks : [];
  const riskState = module?.result?.riskState ?? module?.state;
  if (risks.length === 0) {
    if (riskState !== "READY" || module?.result?.noActiveRisksConfirmed !== true) {
      return unavailableComponent(module, "FORECAST_NOT_FULLY_EVALUATED", {
        trust,
        coverage,
        basis: "FORECAST_RISK_RULES",
      });
    }
    return component(module, FORECAST_LEVEL_SCORE.FAVORABLE, {
      trust,
      coverage,
      basis: "FORECAST_RISK_RULES",
      factors: ["noActiveRisksConfirmed"],
    });
  }
  const validRisks = risks.map(scoreForecastRisk).filter(Number.isFinite);
  if (validRisks.length === 0) {
    return unavailableComponent(module, "NO_SCORABLE_FORECAST_RISKS", {
      trust,
      coverage,
      basis: "FORECAST_RISK_RULES",
    });
  }
  return component(module, Math.min(...validRisks), {
    trust,
    coverage,
    basis: "FORECAST_RISK_RULES",
    factors: ["severity", "deviation", "duration"],
  });
}

function scoreCap(forecast, soil) {
  const risks = Array.isArray(forecast?.result?.risks)
    ? forecast.result.risks
    : [];
  const candidates = [{ value: 100, reason: null }];
  if (risks.some((risk) => risk?.severity === "WARNING")) {
    candidates.push({ value: 49, reason: "WARNING_FORECAST" });
  } else if (risks.some((risk) => risk?.severity === "CAUTION")) {
    candidates.push({ value: 69, reason: "CAUTION_FORECAST" });
  }
  if (soil?.trust >= 0.75 && Number.isFinite(soil.score)) {
    candidates.push({
      value: round(Math.min(100, soil.score + 20), 2),
      reason: "FIELD_SOIL_CONTINUOUS_GUARDRAIL",
    });
  }
  return candidates.reduce((lowest, candidate) =>
    candidate.value < lowest.value ? candidate : lowest,
  );
}

function scoreForecastRisk(risk) {
  const base = FORECAST_SEVERITY_BASE[risk?.severity] ?? 65;
  const readings = Array.isArray(risk?.trigger?.readings)
    ? risk.trigger.readings.map(({ value }) => value).filter(Number.isFinite)
    : [];
  const deviationRatio = comparisonDeviationRatio(
    readings,
    risk?.trigger?.comparison,
  );
  const deviationPenalty = Math.min(20, deviationRatio * 30);
  const duration = inclusiveDateCount(risk?.dateRange?.from, risk?.dateRange?.to);
  const durationPenalty = Math.min(9, Math.max(0, duration - 1) * 3);
  const raw = base - deviationPenalty - durationPenalty;
  if (risk?.severity === "WARNING") return Math.min(49, clamp(raw));
  if (risk?.severity === "CAUTION") return Math.max(50, Math.min(69, raw));
  if (risk?.severity === "INFO") return Math.max(70, Math.min(84, raw));
  return clamp(raw);
}

function limitRegionalSoilShare(applicable) {
  const regionalSoil = applicable.find(
    ([key, value]) =>
      key === "soil" &&
      value.basis === "REGIONAL_STATISTICS" &&
      value.effectiveWeight > 0,
  );
  if (!regionalSoil) return applicable;

  const otherWeight = applicable.reduce(
    (sum, [key, value]) =>
      key === "soil" ? sum : sum + Math.max(0, value.effectiveWeight),
    0,
  );
  const maximum =
    otherWeight * (MAX_REGIONAL_SOIL_SHARE / (1 - MAX_REGIONAL_SOIL_SHARE));
  const limitedWeight = floorTo(
    Math.min(regionalSoil[1].effectiveWeight, maximum),
    6,
  );

  return applicable.map(([key, value]) =>
    key === "soil"
      ? [
          key,
          {
            ...value,
            baseEffectiveWeight: value.effectiveWeight,
            effectiveWeight: limitedWeight,
            weightGuardrail:
              limitedWeight < value.effectiveWeight
                ? "REGIONAL_SOIL_SHARE_MAX_12_PERCENT"
                : null,
          },
        ]
      : [key, value],
  );
}

function facilityHydroResult(applicable) {
  const forecast = Object.fromEntries(applicable).forecast;
  return deepFreeze({
    state: "HOLD",
    score: null,
    rawScore: null,
    label: "산정 대기",
    calculation: "EVIDENCE_WEIGHTED_MEAN_WITH_GUARDRAILS",
    version: SCORE_VERSION,
    reason: "INDOOR_ENVIRONMENT_DATA_REQUIRED",
    scoreCap: { value: null, reason: "INDOOR_ENVIRONMENT_DATA_REQUIRED" },
    externalRisk: {
      score: Number.isFinite(forecast?.score) ? forecast.score : null,
      label: externalRiskLabel(forecast?.score),
      basis: forecast?.basis ?? "FORECAST_RISK_RULES",
    },
    confidence: {
      level: "INSUFFICIENT",
      coverage: 0,
      evidenceStrength: 0,
      minimumRequired: MINIMUM_EVIDENCE_STRENGTH,
      availableComponents: [],
      missingComponents: ["indoorEnvironment"],
    },
    components: Object.fromEntries(applicable),
  });
}

function externalRiskLabel(score) {
  if (!Number.isFinite(score)) return "확인 대기";
  if (score >= 85) return "외기 양호";
  if (score >= 70) return "외기 보통";
  if (score >= 50) return "외기 주의";
  return "외기 위험";
}

function comparisonDeviationRatio(readings, comparison) {
  if (readings.length === 0 || !comparison || typeof comparison !== "object") return 0;
  const operator = comparison.operator;
  if (["GT", "GTE"].includes(operator) && Number.isFinite(comparison.threshold)) {
    const excess = Math.max(0, Math.max(...readings) - comparison.threshold);
    return excess / Math.max(1, Math.abs(comparison.threshold));
  }
  if (["LT", "LTE"].includes(operator) && Number.isFinite(comparison.threshold)) {
    const excess = Math.max(0, comparison.threshold - Math.min(...readings));
    return excess / Math.max(1, Math.abs(comparison.threshold));
  }
  return 0;
}

function inclusiveDateCount(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to ?? from}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  return Math.floor((end - start) / 86_400_000) + 1;
}

function soilTrust(module, basis, now) {
  if (basis === "REGIONAL_STATISTICS") return SOURCE_TRUST.REGIONAL_SOIL;
  const sampledOn =
    module?.result?.userSoilTest?.sampledOn ??
    module?.result?.providerSoilTest?.sampledOn ??
    null;
  if (!sampledOn || !now) return SOURCE_TRUST.USER_OR_PROVIDER_SOIL_RECENT;
  const sampled = Date.parse(`${sampledOn}T00:00:00Z`);
  const reference = Date.parse(now);
  if (!Number.isFinite(sampled) || !Number.isFinite(reference)) {
    return SOURCE_TRUST.USER_OR_PROVIDER_SOIL_RECENT;
  }
  const ageDays = Math.max(0, reference - sampled) / 86_400_000;
  if (ageDays <= 365) return SOURCE_TRUST.USER_OR_PROVIDER_SOIL_RECENT;
  if (ageDays <= 1095) return SOURCE_TRUST.USER_OR_PROVIDER_SOIL_AGED;
  return SOURCE_TRUST.USER_OR_PROVIDER_SOIL_OLD;
}

function forecastTrust(module) {
  const days = Array.isArray(module?.result?.mergedDisplayDays)
    ? module.result.mergedDisplayDays
    : [];
  if (days.length === 0) return SOURCE_TRUST.SHORT_GRID;
  return (
    days.reduce(
      (sum, day) =>
        sum + (SOURCE_TRUST[day?.sourceType] ?? SOURCE_TRUST.MID_REGIONAL),
      0,
    ) / days.length
  );
}

function forecastCoverage(module) {
  const evaluations = Array.isArray(module?.result?.ruleEvaluations)
    ? module.result.ruleEvaluations
    : [];
  if (evaluations.length === 0) return module?.state === "READY" ? 1 : 0;
  const evaluated = evaluations.reduce(
    (sum, item) => sum + Math.max(0, item?.evaluatedDayCount ?? 0),
    0,
  );
  const missing = evaluations.reduce(
    (sum, item) => sum + Math.max(0, item?.missingDayCount ?? 0),
    0,
  );
  return evaluated + missing > 0 ? evaluated / (evaluated + missing) : 0;
}

function moduleCoverage(module) {
  const value = module?.coverage ?? module?.result?.coverage;
  if (Number.isFinite(value)) return clamp01(value);
  if (module?.state === "READY") return 1;
  if (module?.state === "PARTIAL") return 0.5;
  return 0;
}

function measuredPointScore(value, optimalRange) {
  const [lower, upper] = optimalRange;
  const deviation = Math.max(0, lower - value, value - upper) / (upper - lower);
  return 100 / (1 + deviation);
}

function validMeasuredPointMetric(metric) {
  return (
    Number.isFinite(metric?.observedValue) &&
    Array.isArray(metric?.optimalRange) &&
    metric.optimalRange.length === 2 &&
    Number.isFinite(metric.optimalRange[0]) &&
    Number.isFinite(metric.optimalRange[1]) &&
    metric.optimalRange[0] < metric.optimalRange[1]
  );
}

function validSoilMetric(metric) {
  return (
    Number.isFinite(metric?.fitRatio) &&
    Number.isFinite(metric?.uncertainRatio) &&
    Number.isFinite(metric?.outsideRatio) &&
    Number.isFinite(metric?.rawWeight) &&
    metric.rawWeight > 0
  );
}

function component(module, score, options) {
  return {
    state: module?.state === "READY" ? "READY" : "PARTIAL",
    score: round(clamp(score), 2),
    factors: options.factors,
    reason: null,
    basis: options.basis,
    trust: round(clamp01(options.trust), 4),
    coverage: round(clamp01(options.coverage), 4),
  };
}

function unavailableComponent(module, reason, options) {
  return {
    state: module?.state === "NOT_APPLICABLE" ? "NOT_APPLICABLE" : "HOLD",
    score: null,
    factors: [],
    reason,
    basis: options.basis,
    trust: round(clamp01(options.trust), 4),
    coverage: round(clamp01(options.coverage), 4),
  };
}

function labelForScore(score) {
  if (!Number.isFinite(score)) return "산정 대기";
  if (score >= 85) return "양호";
  if (score >= 70) return "보통";
  if (score >= 50) return "주의";
  return "위험";
}

function confidenceLevel(evidenceStrength) {
  if (evidenceStrength >= 0.8) return "HIGH";
  if (evidenceStrength >= 0.55) return "MEDIUM";
  if (evidenceStrength >= MINIMUM_EVIDENCE_STRENGTH) return "LOW";
  return "INSUFFICIENT";
}

function clamp(value) {
  return Math.max(0, Math.min(100, value));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function floorTo(value, digits) {
  const factor = 10 ** digits;
  return Math.floor(value * factor) / factor;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}
