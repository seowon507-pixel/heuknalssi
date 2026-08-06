const CONDITION_CODE_BY_BACKEND = Object.freeze({
  WEATHER_STABLE: 'stable',
  CLEAR_WEATHER: 'clear',
  HIGH_TEMPERATURE: 'heat',
  EXTREME_HEAT: 'heatwave',
  LOW_TEMPERATURE: 'cold',
  FROST: 'frost',
  RAIN: 'rain',
  HEAVY_RAIN: 'downpour',
  STRONG_WIND: 'wind',
  TYPHOON: 'typhoon',
  DROUGHT: 'drought',
  SOIL_STABLE: 'soilStable',
  SOIL_DRY: 'dry',
  SOIL_WET: 'overwet',
  POOR_DRAINAGE: 'drainage',
  PH_IMBALANCE: 'acidity',
  SALINITY_HIGH: 'salinity',
  TEXTURE_CAUTION: 'texture',
  FLOODING: 'flood',
});

export function buildAnalysisViewModel(analysis) {
  if (!analysis || typeof analysis !== 'object') {
    throw new TypeError('analysis response is required');
  }
  const growth = analysis.growthScore ?? {};
  const cause = analysis.environmentCause ?? {};
  const weather = cause.weather ?? {};
  const soil = cause.soil ?? {};
  const combinedWeatherScore = weightedComponentScore([
    growth.components?.climate,
    growth.components?.forecast,
  ]);
  const weatherComponent = {
    ...(growth.components?.forecast ?? {}),
    score: combinedWeatherScore,
  };
  const weatherModel = axisModel(weather, weatherComponent, 'stable');
  const soilModel = axisModel(soil, growth.components?.soil, 'soilStable');
  const scoreComponents = Object.freeze({
    climate: scoreComponentModel(growth.components?.climate),
    forecast: scoreComponentModel(growth.components?.forecast),
    soil: scoreComponentModel(growth.components?.soil),
  });
  const forecastRisks = Array.isArray(analysis.forecast?.result?.risks)
    ? analysis.forecast.result.risks
    : [];

  return Object.freeze({
    analysisId: analysis.analysisId ?? null,
    totalScore: finiteOrNull(growth.score),
    rawScore: finiteOrNull(growth.rawScore),
    scoreCap: scoreCapModel(growth.scoreCap),
    scoreState: growth.state ?? 'HOLD',
    scoreLabel: growth.label ?? '산정 대기',
    confidence: growth.confidence ?? null,
    status: cause.status ?? 'HOLD',
    statusLabel: cause.statusLabel ?? '분석 중',
    causeLabel: cause.causeLabel ?? '자료 확인 중',
    headline: `${cause.statusLabel ?? '분석 중'} · ${cause.causeLabel ?? '자료 확인 중'}`,
    primaryCode: resolvePrimaryCode(cause),
    sceneCodes: Object.freeze([...new Set([weatherModel.code, soilModel.code])]),
    weather: weatherModel,
    soil: soilModel,
    scoreComponents,
    week: (Array.isArray(weather.daily) ? weather.daily : [])
      .slice(0, 7)
      .map((day) => dayModel(day, forecastRisks)),
    regionLabel: analysis.inputSummary?.regionLabel ?? null,
    updatedAt: analysis.createdAt ?? null,
    sourcePolicy: cause.scoreLink?.policy ?? null,
  });
}

function scoreComponentModel(component) {
  return Object.freeze({
    score: finiteOrNull(component?.score),
    effectiveWeight: finiteOrNull(component?.effectiveWeight),
    state: component?.state ?? 'HOLD',
  });
}

export function backendConditionCode(code, fallback = 'stable') {
  return CONDITION_CODE_BY_BACKEND[code] ?? fallback;
}

function axisModel(axis, component, fallbackCode) {
  const referenceOnly = axis?.referenceOnly === true;
  return Object.freeze({
    score: finiteOrNull(component?.score),
    state: component?.state ?? 'HOLD',
    code: backendConditionCode(axis?.code, fallbackCode),
    label: axis?.label ?? '확인 중',
    status: axis?.status ?? 'HOLD',
    affectsScore: axis?.affectsScore === true,
    referenceOnly,
    needsFieldTest: referenceOnly,
    basis: axis?.basis ?? null,
    measurementBasis: axis?.measurementBasis ?? null,
    trigger: triggerModel(axis?.trigger),
    observedValue: finiteOrNull(axis?.observedValue),
    optimalRange: Array.isArray(axis?.optimalRange)
      ? Object.freeze(axis.optimalRange.filter(Number.isFinite).slice(0, 2))
      : null,
    fitRatio: finiteOrNull(axis?.fitRatio),
    outsideRatio: finiteOrNull(axis?.outsideRatio),
  });
}

function triggerModel(trigger) {
  if (!trigger || typeof trigger !== 'object') return null;
  const comparison = trigger.comparison && typeof trigger.comparison === 'object'
    ? Object.freeze({
        operator: trigger.comparison.operator ?? null,
        threshold: finiteOrNull(trigger.comparison.threshold),
      })
    : null;
  const readings = Array.isArray(trigger.readings)
    ? Object.freeze(trigger.readings
        .filter((reading) => Number.isFinite(reading?.value))
        .slice(0, 14)
        .map((reading) => Object.freeze({
          date: reading.date ?? null,
          value: reading.value,
        })))
    : Object.freeze([]);
  return Object.freeze({
    metric: trigger.metric ?? null,
    unit: trigger.unit ?? null,
    comparison,
    readings,
  });
}

function scoreCapModel(scoreCap) {
  if (!scoreCap || typeof scoreCap !== 'object') return null;
  return Object.freeze({
    value: finiteOrNull(scoreCap.value),
    reason: scoreCap.reason ?? null,
  });
}

function dayModel(day, forecastRisks = []) {
  const matchingRisk = forecastRisks.find((risk) =>
    risk?.riskId && risk.riskId === day?.riskId)
    ?? forecastRisks.find((risk) =>
      day?.date &&
      risk?.dateRange?.from <= day.date &&
      day.date <= risk?.dateRange?.to &&
      (!day?.ruleId || !risk?.ruleId || risk.ruleId === day.ruleId));
  return Object.freeze({
    date: day?.date ?? null,
    code: backendConditionCode(day?.code, 'stable'),
    status: day?.status ?? 'HOLD',
    statusLabel: day?.statusLabel ?? '분석 중',
    causeLabel: day?.label ?? '날씨 확인 중',
    tMax: finiteOrNull(day?.maxTemperature),
    tMin: finiteOrNull(day?.minTemperature),
    precipitationProbability: finiteOrNull(day?.precipitationProbability),
    precipitationAmount: finiteOrNull(day?.precipitationAmount),
    windSpeed: finiteOrNull(day?.windSpeed),
    sourceType: day?.sourceType ?? null,
    trigger: triggerModel(day?.trigger),
    guidance: guidanceModel(day?.guidance ?? matchingRisk?.guidance),
  });
}

function guidanceModel(guidance) {
  if (!guidance || typeof guidance !== 'object') return null;
  const actions = Array.isArray(guidance.actions)
    ? Object.freeze(guidance.actions
        .filter((action) => typeof action === 'string' && action.trim())
        .slice(0, 4))
    : Object.freeze([]);
  return Object.freeze({
    headline: typeof guidance.headline === 'string' ? guidance.headline : null,
    reason: typeof guidance.reason === 'string' ? guidance.reason : null,
    actions,
    recheck: typeof guidance.recheck === 'string' ? guidance.recheck : null,
  });
}

function resolvePrimaryCode(cause) {
  const weather = cause.weather ?? {};
  const soil = cause.soil ?? {};
  const rank = { HOLD: -1, GOOD: 0, CAUTION: 1, DANGER: 2 };
  const primary = (rank[soil.status] ?? -1) > (rank[weather.status] ?? -1)
    ? soil
    : weather;
  return backendConditionCode(primary.code, 'stable');
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function weightedComponentScore(components) {
  const available = components.filter(
    (component) =>
      Number.isFinite(component?.score) &&
      Number.isFinite(component?.effectiveWeight) &&
      component.effectiveWeight > 0,
  );
  if (available.length === 0) {
    return components.find((component) => Number.isFinite(component?.score))?.score ?? null;
  }
  const denominator = available.reduce(
    (sum, component) => sum + component.effectiveWeight,
    0,
  );
  const score = available.reduce(
    (sum, component) => sum + component.score * component.effectiveWeight,
    0,
  ) / denominator;
  return Math.round(score * 100) / 100;
}
