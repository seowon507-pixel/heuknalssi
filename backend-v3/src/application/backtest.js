const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const COMPARABLE_RULE_METRICS = Object.freeze(
  new Set(['minTemperature', 'maxTemperature', 'precipitationAmount']),
);
const NUMERIC_FORECAST_METRICS = Object.freeze([
  'minTemperature',
  'maxTemperature',
]);

function requireIsoDate(value, field) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw new TypeError(`${field} must be an ISO calendar date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new TypeError(`${field} must be a real ISO calendar date.`);
  }
  return value;
}

function requireInstant(value, field) {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be an ISO instant.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical ISO instant.`);
  }
  return parsed;
}

function finiteOrNull(value, field, { min = -Infinity, max = Infinity } = {}) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${field} must be finite and within its contract.`);
  }
  return value;
}

function normalizeObservation(row, index) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError(`observations[${index}] must be an object.`);
  }
  return {
    date: requireIsoDate(row.date, `observations[${index}].date`),
    minTemperature: finiteOrNull(
      row.minTemperature,
      `observations[${index}].minTemperature`,
      { min: -100, max: 100 },
    ),
    maxTemperature: finiteOrNull(
      row.maxTemperature,
      `observations[${index}].maxTemperature`,
      { min: -100, max: 100 },
    ),
    precipitationAmount: finiteOrNull(
      row.precipitationAmount,
      `observations[${index}].precipitationAmount`,
      { min: 0, max: 5000 },
    ),
  };
}

function normalizeIssuedForecast(row, index) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError(`issuedForecasts[${index}] must be an object.`);
  }
  const issuedAt = requireInstant(
    row.issuedAt,
    `issuedForecasts[${index}].issuedAt`,
  );
  const validAt = requireInstant(
    row.validAt,
    `issuedForecasts[${index}].validAt`,
  );
  if (issuedAt.getTime() >= validAt.getTime()) {
    throw new TypeError(
      `issuedForecasts[${index}] must be issued before its valid time.`,
    );
  }
  return {
    issuedAt: issuedAt.toISOString(),
    validAt: validAt.toISOString(),
    validDate: requireIsoDate(
      row.validDate,
      `issuedForecasts[${index}].validDate`,
    ),
    minTemperature: finiteOrNull(
      row.minTemperature,
      `issuedForecasts[${index}].minTemperature`,
      { min: -100, max: 100 },
    ),
    maxTemperature: finiteOrNull(
      row.maxTemperature,
      `issuedForecasts[${index}].maxTemperature`,
      { min: -100, max: 100 },
    ),
    precipitationProbability: finiteOrNull(
      row.precipitationProbability,
      `issuedForecasts[${index}].precipitationProbability`,
      { min: 0, max: 100 },
    ),
  };
}

function uniqueObservations(rows) {
  const byDate = new Map();
  for (const [index, row] of rows.entries()) {
    const normalized = normalizeObservation(row, index);
    if (byDate.has(normalized.date)) {
      throw new TypeError(`observations contains duplicate date ${normalized.date}.`);
    }
    byDate.set(normalized.date, normalized);
  }
  return byDate;
}

function errorMetrics(errors) {
  if (errors.length === 0) {
    return {
      sampleCount: 0,
      meanAbsoluteError: null,
      rootMeanSquaredError: null,
      bias: null,
    };
  }
  const total = errors.reduce((sum, error) => sum + error, 0);
  const absolute = errors.reduce((sum, error) => sum + Math.abs(error), 0);
  const squared = errors.reduce((sum, error) => sum + error ** 2, 0);
  return {
    sampleCount: errors.length,
    meanAbsoluteError: absolute / errors.length,
    rootMeanSquaredError: Math.sqrt(squared / errors.length),
    bias: total / errors.length,
  };
}

/**
 * Compares archived, issued-at-the-time daily forecasts with later ASOS
 * observations. Missing pairs remain excluded and visible; they are never
 * imputed.
 */
export function calculateIssuedForecastMetrics({
  issuedForecasts = [],
  observations = [],
} = {}) {
  if (!Array.isArray(issuedForecasts) || !Array.isArray(observations)) {
    throw new TypeError('issuedForecasts and observations must be arrays.');
  }
  const observationsByDate = uniqueObservations(observations);
  const forecasts = issuedForecasts.map(normalizeIssuedForecast);
  const errors = Object.fromEntries(
    NUMERIC_FORECAST_METRICS.map((metric) => [metric, []]),
  );
  const precipitationErrors = [];
  const exclusions = [];
  let matchedForecastCount = 0;

  for (const forecast of forecasts) {
    const observation = observationsByDate.get(forecast.validDate);
    if (!observation) {
      exclusions.push({
        issuedAt: forecast.issuedAt,
        validDate: forecast.validDate,
        reason: 'OBSERVATION_MISSING',
      });
      continue;
    }
    matchedForecastCount += 1;
    for (const metric of NUMERIC_FORECAST_METRICS) {
      if (forecast[metric] === null || observation[metric] === null) {
        exclusions.push({
          issuedAt: forecast.issuedAt,
          validDate: forecast.validDate,
          metric,
          reason: 'METRIC_PAIR_MISSING',
        });
        continue;
      }
      errors[metric].push(forecast[metric] - observation[metric]);
    }
    if (
      forecast.precipitationProbability === null ||
      observation.precipitationAmount === null
    ) {
      exclusions.push({
        issuedAt: forecast.issuedAt,
        validDate: forecast.validDate,
        metric: 'precipitationProbability',
        reason: 'METRIC_PAIR_MISSING',
      });
    } else {
      const probability = forecast.precipitationProbability / 100;
      const observedEvent = observation.precipitationAmount > 0 ? 1 : 0;
      precipitationErrors.push((probability - observedEvent) ** 2);
    }
  }

  const temperature = Object.fromEntries(
    NUMERIC_FORECAST_METRICS.map((metric) => [
      metric,
      errorMetrics(errors[metric]),
    ]),
  );
  const precipitation = {
    sampleCount: precipitationErrors.length,
    brierScore:
      precipitationErrors.length === 0
        ? null
        : precipitationErrors.reduce((sum, value) => sum + value, 0) /
          precipitationErrors.length,
    eventDefinition: 'ASOS precipitationAmount > 0 mm',
  };
  const completeMetricCoverage =
    NUMERIC_FORECAST_METRICS.every(
      (metric) => temperature[metric].sampleCount > 0,
    ) && precipitation.sampleCount > 0;

  return {
    state:
      forecasts.length === 0 || matchedForecastCount === 0
        ? 'HOLD'
        : completeMetricCoverage
          ? 'READY'
          : 'PARTIAL',
    issuedForecastCount: forecasts.length,
    matchedForecastCount,
    observationCount: observationsByDate.size,
    matchedForecastRatio:
      forecasts.length === 0 ? 0 : matchedForecastCount / forecasts.length,
    temperature,
    precipitation,
    exclusions,
  };
}

function compare(value, comparison) {
  switch (comparison.operator) {
    case 'GT':
      return value > comparison.threshold;
    case 'GTE':
      return value >= comparison.threshold;
    case 'LT':
      return value < comparison.threshold;
    case 'LTE':
      return value <= comparison.threshold;
    default:
      throw new TypeError(
        `Unsupported replay comparison operator: ${comparison.operator}`,
      );
  }
}

function normalizeReplayRule(rule, index) {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new TypeError(`rules[${index}] must be an object.`);
  }
  if (
    typeof rule.ruleId !== 'string' ||
    typeof rule.crop !== 'string' ||
    rule.module !== 'FORECAST' ||
    rule.use !== 'FORECAST_RISK' ||
    typeof rule.metric !== 'string'
  ) {
    throw new TypeError(`rules[${index}] is not a forecast-risk rule.`);
  }
  if (
    !rule.comparison ||
    !Number.isFinite(rule.comparison.threshold) ||
    !['GT', 'GTE', 'LT', 'LTE'].includes(rule.comparison.operator)
  ) {
    throw new TypeError(`rules[${index}] has an invalid comparison.`);
  }
  if (rule.duration?.kind !== 'ANY_DAY') {
    throw new TypeError(
      `rules[${index}] replay currently requires ANY_DAY duration.`,
    );
  }
  return rule;
}

/**
 * Replays reviewed ANY_DAY risk thresholds against historical ASOS values.
 * Forecast-probability rules are explicitly marked non-comparable because an
 * observed amount is not a probability.
 */
export function replayAsosRiskRules({
  rules = [],
  observations = [],
} = {}) {
  if (!Array.isArray(rules) || !Array.isArray(observations)) {
    throw new TypeError('rules and observations must be arrays.');
  }
  const rows = [...uniqueObservations(observations).values()].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const normalizedRules = rules.map(normalizeReplayRule);
  const results = normalizedRules.map((rule) => {
    if (!COMPARABLE_RULE_METRICS.has(rule.metric)) {
      return {
        ruleId: rule.ruleId,
        crop: rule.crop,
        metric: rule.metric,
        state: 'NOT_COMPARABLE',
        evaluatedDayCount: 0,
        missingDayCount: rows.length,
        triggerDates: [],
        reason: 'FORECAST_METRIC_HAS_NO_EQUIVALENT_ASOS_DAILY_VALUE',
      };
    }
    const available = rows.filter((row) => row[rule.metric] !== null);
    return {
      ruleId: rule.ruleId,
      crop: rule.crop,
      metric: rule.metric,
      state: available.length > 0 ? 'REPLAYED' : 'HOLD',
      evaluatedDayCount: available.length,
      missingDayCount: rows.length - available.length,
      triggerDates: available
        .filter((row) => compare(row[rule.metric], rule.comparison))
        .map((row) => row.date),
      comparison: structuredClone(rule.comparison),
    };
  });
  return {
    state:
      rows.length > 0 && results.some(({ state }) => state === 'REPLAYED')
        ? results.some(({ state }) => state === 'HOLD')
          ? 'PARTIAL'
          : 'READY'
        : 'HOLD',
    observationCount: rows.length,
    ruleCount: normalizedRules.length,
    replayedRuleCount: results.filter(({ state }) => state === 'REPLAYED')
      .length,
    nonComparableRuleCount: results.filter(
      ({ state }) => state === 'NOT_COMPARABLE',
    ).length,
    results,
  };
}
