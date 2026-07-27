const FORECAST_WEIGHT = 0.6;
const SOIL_WEIGHT = 0.4;
const SEVERITY_CAP = Object.freeze({
  WARNING: 45,
  CAUTION: 70,
  INFO: 85,
});

/**
 * 현재 도착한 작물별 예보와 토양 적합도를 0~100으로 정리한다.
 *
 * - 자료가 없거나 작물 규칙 평가가 끝나지 않으면 0점으로 채우지 않는다.
 * - 예보는 가까운 위험 신호를 60%, 토양은 작물 적합도를 40% 반영한다.
 * - 사진·시설 센서는 선택 정보이며, 없어도 날씨·토양 점수를 계산한다.
 */
export function calculateCropConditionScore(analysis = {}) {
  const forecast = forecastConditionScore(analysis?.forecast);
  const soil = soilConditionScore(analysis?.soil);
  const measurementBasis = analysis?.soil?.result?.measurementBasis ?? null;

  if (!Number.isFinite(forecast) || !Number.isFinite(soil)) {
    return {
      score: null,
      label: "산정 대기",
      tone: "hold",
      components: { forecast, soil },
      weights: { forecast: FORECAST_WEIGHT, soil: SOIL_WEIGHT },
      basisLabel: soilBasisLabel(measurementBasis),
      explanation:
        "작물별 예보 판정과 토양 적합도가 모두 확인되면 예상 점수를 표시합니다.",
    };
  }

  const score = clampScore(
    Math.round(forecast * FORECAST_WEIGHT + soil * SOIL_WEIGHT),
  );
  const grade = gradeForScore(score);
  return {
    score,
    ...grade,
    components: { forecast, soil },
    weights: { forecast: FORECAST_WEIGHT, soil: SOIL_WEIGHT },
    basisLabel: soilBasisLabel(measurementBasis),
    explanation:
      "가까운 예보 60%와 작물별 토양 적합도 40%를 반영합니다.",
  };
}

export function forecastConditionScore(forecast) {
  const riskState = forecast?.result?.riskState ?? forecast?.state;
  if (riskState !== "READY") return null;
  const risks = Array.isArray(forecast?.result?.risks)
    ? forecast.result.risks.filter(
        (risk) => risk?.sourceFreshness === "CURRENT",
      )
    : [];
  if (risks.length === 0) {
    return forecast?.result?.noActiveRisksConfirmed === true ? 100 : null;
  }
  const scores = risks.map(scoreForecastRisk).filter(Number.isFinite);
  return scores.length ? Math.min(...scores) : null;
}

export function soilConditionScore(soil) {
  const metrics = Array.isArray(soil?.result?.metrics)
    ? soil.result.metrics
    : [];
  const eligible = metrics.filter(
    (metric) =>
      Number.isFinite(metric?.fitRatio) &&
      Number.isFinite(metric?.uncertainRatio) &&
      Number.isFinite(metric?.outsideRatio),
  );
  if (eligible.length === 0) return null;

  let weightedTotal = 0;
  let totalWeight = 0;
  for (const metric of eligible) {
    const weight =
      Number.isFinite(metric.rawWeight) && metric.rawWeight > 0
        ? metric.rawWeight
        : 1;
    const metricScore =
      clampRatio(metric.fitRatio) * 100 +
      clampRatio(metric.uncertainRatio) * 65;
    weightedTotal += clampScore(metricScore) * weight;
    totalWeight += weight;
  }
  return totalWeight > 0
    ? clampScore(Math.round(weightedTotal / totalWeight))
    : null;
}

function scoreForecastRisk(risk) {
  const cap = SEVERITY_CAP[risk?.severity];
  if (!Number.isFinite(cap)) return null;
  const comparison = risk?.trigger?.comparison;
  const readings = Array.isArray(risk?.trigger?.readings)
    ? risk.trigger.readings
    : [];
  const exceedances = readings
    .map(({ value }) => exceedance(value, comparison))
    .filter(Number.isFinite);
  const worstExceedance = exceedances.length
    ? Math.max(...exceedances)
    : 0;
  const metric = risk?.trigger?.metric;
  const degreePenalty = temperatureMetric(metric)
    ? Math.min(30, worstExceedance * 4)
    : ratioPenalty(worstExceedance, comparison?.threshold);
  return clampScore(Math.round(cap - degreePenalty));
}

function exceedance(value, comparison) {
  if (!Number.isFinite(value) || !comparison) return null;
  if (["GT", "GTE"].includes(comparison.operator)) {
    return Number.isFinite(comparison.threshold)
      ? Math.max(0, value - comparison.threshold)
      : null;
  }
  if (["LT", "LTE"].includes(comparison.operator)) {
    return Number.isFinite(comparison.threshold)
      ? Math.max(0, comparison.threshold - value)
      : null;
  }
  if (
    comparison.operator === "BETWEEN" &&
    Number.isFinite(comparison.lower) &&
    Number.isFinite(comparison.upper)
  ) {
    if (value < comparison.lower) return comparison.lower - value;
    if (value > comparison.upper) return value - comparison.upper;
    return 0;
  }
  return null;
}

function ratioPenalty(exceedanceValue, threshold) {
  if (!Number.isFinite(exceedanceValue)) return 0;
  const denominator = Math.max(Math.abs(threshold ?? 0), 1);
  return Math.min(30, (exceedanceValue / denominator) * 30);
}

function temperatureMetric(metric) {
  return ["minTemperature", "maxTemperature"].includes(metric);
}

function soilBasisLabel(value) {
  if (value === "USER_SOIL_TEST") return "사용자 등록 토양검정";
  if (value === "PROVIDER_SOIL_TEST") return "필지 토양검정";
  if (value === "REGIONAL_STATISTICS") return "지역 토양 통계 추정";
  return "토양 근거 확인 필요";
}

function gradeForScore(score) {
  if (score >= 85) return { label: "양호", tone: "good" };
  if (score >= 70) return { label: "관심", tone: "caution" };
  if (score >= 50) return { label: "점검 필요", tone: "caution" };
  return { label: "주의", tone: "danger" };
}

function clampRatio(value) {
  return Math.max(0, Math.min(1, value));
}

function clampScore(value) {
  return Math.max(0, Math.min(100, value));
}
