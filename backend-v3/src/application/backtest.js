const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const COMPARABLE_RULE_METRICS = Object.freeze(
  new Set(['minTemperature', 'maxTemperature', 'precipitationAmount']),
);
const NUMERIC_FORECAST_METRICS = Object.freeze([
  'minTemperature',
  'maxTemperature',
]);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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

function requiredIdentifier(value, field) {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 180
  ) {
    throw new TypeError(`${field} must be a non-empty identifier.`);
  }
  return value;
}

function optionalIsoDate(value, field) {
  if (value === null || value === undefined || value === '') return null;
  return requireIsoDate(value, field);
}

function daysBetween(fromDate, toDate) {
  return Math.round(
    (Date.parse(`${toDate}T00:00:00.000Z`) -
      Date.parse(`${fromDate}T00:00:00.000Z`)) /
      DAY_MS,
  );
}

function seoulDateFromInstant(value) {
  return new Date(value.getTime() + 9 * HOUR_MS).toISOString().slice(0, 10);
}

/**
 * Builds one daily precipitation probability only when every expected hourly
 * forecast is present. The maximum hourly POP is the same daily aggregation
 * used by the live KMA short-forecast parser; incomplete days stay excluded.
 */
export function aggregateDailyPrecipitationProbability({
  issuedAt,
  validDate,
  periods = [],
  expectedHourlyPeriodCount = 24,
} = {}) {
  const issue = requireInstant(issuedAt, 'issuedAt');
  const date = requireIsoDate(validDate, 'validDate');
  if (
    !Number.isInteger(expectedHourlyPeriodCount) ||
    expectedHourlyPeriodCount < 1 ||
    expectedHourlyPeriodCount > 24
  ) {
    throw new TypeError('expectedHourlyPeriodCount must be between 1 and 24.');
  }
  if (!Array.isArray(periods)) {
    throw new TypeError('periods must be an array.');
  }

  const byValidAt = new Map();
  for (const [index, period] of periods.entries()) {
    if (!period || typeof period !== 'object' || Array.isArray(period)) {
      throw new TypeError(`periods[${index}] must be an object.`);
    }
    const validAt = requireInstant(period.validAt, `periods[${index}].validAt`);
    if (validAt.getTime() <= issue.getTime()) {
      throw new TypeError(`periods[${index}] must be valid after issuedAt.`);
    }
    if (seoulDateFromInstant(validAt) !== date) {
      throw new TypeError(`periods[${index}] is outside validDate.`);
    }
    if (byValidAt.has(validAt.toISOString())) {
      throw new TypeError(`periods contains duplicate validAt ${validAt.toISOString()}.`);
    }
    byValidAt.set(
      validAt.toISOString(),
      finiteOrNull(
        period.precipitationProbability,
        `periods[${index}].precipitationProbability`,
        { min: 0, max: 100 },
      ),
    );
  }

  const probabilities = [...byValidAt.values()];
  const validProbabilities = probabilities.filter(Number.isFinite);
  const complete =
    byValidAt.size === expectedHourlyPeriodCount &&
    validProbabilities.length === expectedHourlyPeriodCount;
  return {
    state: complete ? 'READY' : byValidAt.size > 0 ? 'PARTIAL' : 'HOLD',
    validDate: date,
    issuedAt: issue.toISOString(),
    expectedHourlyPeriodCount,
    receivedPeriodCount: byValidAt.size,
    validPeriodCount: validProbabilities.length,
    coverageRatio: validProbabilities.length / expectedHourlyPeriodCount,
    precipitationProbability: complete
      ? Math.max(...validProbabilities)
      : null,
    aggregation: 'MAX_HOURLY_POP',
    limitations: complete ? [] : ['INCOMPLETE_HOURLY_POP'],
  };
}

function scopeKey(row, index, label) {
  return [
    requiredIdentifier(row.farmId, `${label}[${index}].farmId`),
    requiredIdentifier(row.cropId, `${label}[${index}].cropId`),
    requiredIdentifier(row.seasonId, `${label}[${index}].seasonId`),
  ].join('|');
}

function normalizeOutcome(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError(`outcomes[${index}] must be an object.`);
  }
  const firstHarvestDate = optionalIsoDate(
    row.firstHarvestDate,
    `outcomes[${index}].firstHarvestDate`,
  );
  const damageObservedDate = optionalIsoDate(
    row.damageObservedDate,
    `outcomes[${index}].damageObservedDate`,
  );
  const damageType =
    row.damageType === null || row.damageType === undefined || row.damageType === ''
      ? null
      : requiredIdentifier(row.damageType, `outcomes[${index}].damageType`);
  if ((damageObservedDate === null) !== (damageType === null)) {
    throw new TypeError('damageObservedDate and damageType must be supplied together.');
  }
  const lastHarvestDate = optionalIsoDate(
    row.lastHarvestDate,
    `outcomes[${index}].lastHarvestDate`,
  );
  if (
    firstHarvestDate !== null &&
    lastHarvestDate !== null &&
    lastHarvestDate < firstHarvestDate
  ) {
    throw new TypeError('lastHarvestDate must not precede firstHarvestDate.');
  }
  return {
    key: scopeKey(row, index, 'outcomes'),
    farmId: row.farmId,
    cropId: row.cropId,
    seasonId: row.seasonId,
    firstHarvestDate,
    lastHarvestDate,
    damageObservedDate,
    damageType,
    evidenceSource:
      row.evidenceSource === null || row.evidenceSource === undefined || row.evidenceSource === ''
        ? null
        : requiredIdentifier(row.evidenceSource, `outcomes[${index}].evidenceSource`),
  };
}

function normalizeHarvestPrediction(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError(`harvestPredictions[${index}] must be an object.`);
  }
  const issuedAt = requireInstant(
    row.issuedAt,
    `harvestPredictions[${index}].issuedAt`,
  );
  const windowStart = requireIsoDate(
    row.windowStart,
    `harvestPredictions[${index}].windowStart`,
  );
  const windowEnd = requireIsoDate(
    row.windowEnd,
    `harvestPredictions[${index}].windowEnd`,
  );
  if (windowStart > windowEnd) {
    throw new TypeError('harvest prediction windowStart must not exceed windowEnd.');
  }
  return {
    key: scopeKey(row, index, 'harvestPredictions'),
    issuedAt: issuedAt.toISOString(),
    issuedDate: seoulDateFromInstant(issuedAt),
    windowStart,
    windowEnd,
  };
}

function normalizeAlert(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError(`alerts[${index}] must be an object.`);
  }
  const issuedAt = requireInstant(row.issuedAt, `alerts[${index}].issuedAt`);
  const validFrom = requireIsoDate(row.validFrom, `alerts[${index}].validFrom`);
  const validTo = requireIsoDate(row.validTo, `alerts[${index}].validTo`);
  if (validFrom > validTo || seoulDateFromInstant(issuedAt) > validTo) {
    throw new TypeError('alert validity must end after issue time and validFrom.');
  }
  return {
    key: scopeKey(row, index, 'alerts'),
    riskType: requiredIdentifier(row.riskType, `alerts[${index}].riskType`),
    issuedAt: issuedAt.toISOString(),
    validFrom,
    validTo,
  };
}

function meanOrNull(values) {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Evaluates only user/field-confirmed outcomes. It never treats a missing
 * damage record as a confirmed negative, so precision/recall are limited to
 * event and alert matching rather than a fabricated full confusion matrix.
 */
export function evaluateFarmOutcomeGroundTruth({
  harvestPredictions = [],
  alerts = [],
  outcomes = [],
  damageEvents = [],
} = {}) {
  if (
    !Array.isArray(harvestPredictions) ||
    !Array.isArray(alerts) ||
    !Array.isArray(outcomes) ||
    !Array.isArray(damageEvents)
  ) {
    throw new TypeError(
      'harvestPredictions, alerts, outcomes, and damageEvents must be arrays.',
    );
  }
  const normalizedOutcomes = outcomes.map(normalizeOutcome);
  if (new Set(normalizedOutcomes.map(({ key }) => key)).size !== normalizedOutcomes.length) {
    throw new TypeError('outcomes must contain at most one harvest record per season.');
  }
  const predictions = harvestPredictions.map(normalizeHarvestPrediction);
  const normalizedAlerts = alerts.map(normalizeAlert);

  const harvestPairs = [];
  for (const outcome of normalizedOutcomes) {
    if (outcome.firstHarvestDate === null) continue;
    const eligible = predictions
      .filter(
        (prediction) =>
          prediction.key === outcome.key &&
          prediction.issuedDate <= outcome.firstHarvestDate,
      )
      .sort((left, right) => right.issuedAt.localeCompare(left.issuedAt));
    const prediction = eligible[0];
    if (!prediction) continue;
    const midpoint = addDaysForBacktest(
      prediction.windowStart,
      Math.floor(daysBetween(prediction.windowStart, prediction.windowEnd) / 2),
    );
    const signedWindowErrorDays =
      outcome.firstHarvestDate < prediction.windowStart
        ? daysBetween(prediction.windowStart, outcome.firstHarvestDate)
        : outcome.firstHarvestDate > prediction.windowEnd
          ? daysBetween(prediction.windowEnd, outcome.firstHarvestDate)
          : 0;
    harvestPairs.push({
      farmId: outcome.farmId,
      cropId: outcome.cropId,
      seasonId: outcome.seasonId,
      issuedAt: prediction.issuedAt,
      predictedWindowStart: prediction.windowStart,
      predictedWindowEnd: prediction.windowEnd,
      actualFirstHarvestDate: outcome.firstHarvestDate,
      signedWindowErrorDays,
      absoluteWindowErrorDays: Math.abs(signedWindowErrorDays),
      midpointAbsoluteErrorDays: Math.abs(
        daysBetween(midpoint, outcome.firstHarvestDate),
      ),
    });
  }

  const normalizedDamageEvents = [
    ...normalizedOutcomes
      .filter((outcome) => outcome.damageObservedDate !== null)
      .map((outcome) => ({
        key: outcome.key,
        riskType: outcome.damageType,
        observedDate: outcome.damageObservedDate,
      })),
    ...damageEvents.map((event, index) => {
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new TypeError(`damageEvents[${index}] must be an object.`);
      }
      return {
        key: scopeKey(event, index, 'damageEvents'),
        riskType: requiredIdentifier(
          event.riskType,
          `damageEvents[${index}].riskType`,
        ),
        observedDate: requireIsoDate(
          event.observedDate,
          `damageEvents[${index}].observedDate`,
        ),
      };
    }),
  ];
  const eventMatches = normalizedDamageEvents.map((event) => {
    const matchingAlerts = normalizedAlerts.filter(
      (alert) =>
        alert.key === event.key &&
        alert.riskType === event.riskType &&
        alert.validFrom <= event.observedDate &&
        alert.validTo >= event.observedDate,
    );
    return { event, matched: matchingAlerts.length > 0 };
  });
  const alertMatches = normalizedAlerts.map((alert) => ({
    alert,
    matched: normalizedDamageEvents.some(
      (event) =>
        event.key === alert.key &&
        event.riskType === alert.riskType &&
        event.observedDate >= alert.validFrom &&
        event.observedDate <= alert.validTo,
    ),
  }));
  const matchedEventCount = eventMatches.filter(({ matched }) => matched).length;
  const matchedAlertCount = alertMatches.filter(({ matched }) => matched).length;
  const pairedWindowErrors = harvestPairs.map(
    ({ absoluteWindowErrorDays }) => absoluteWindowErrorDays,
  );
  const pairedMidpointErrors = harvestPairs.map(
    ({ midpointAbsoluteErrorDays }) => midpointAbsoluteErrorDays,
  );

  return {
    state:
      normalizedOutcomes.length === 0 && normalizedDamageEvents.length === 0
        ? 'COLLECTION_READY_NO_RECORDS'
        : harvestPairs.length > 0 || normalizedDamageEvents.length > 0
          ? 'READY'
          : 'PARTIAL',
    outcomeRecordCount: normalizedOutcomes.length,
    harvest: {
      actualFirstHarvestCount: normalizedOutcomes.filter(
        ({ firstHarvestDate }) => firstHarvestDate !== null,
      ).length,
      pairedPredictionCount: harvestPairs.length,
      meanAbsoluteWindowErrorDays: meanOrNull(pairedWindowErrors),
      meanAbsoluteMidpointErrorDays: meanOrNull(pairedMidpointErrors),
      withinWindowCount: harvestPairs.filter(
        ({ signedWindowErrorDays }) => signedWindowErrorDays === 0,
      ).length,
      pairs: harvestPairs,
    },
    damage: {
      confirmedEventCount: normalizedDamageEvents.length,
      alertCount: normalizedAlerts.length,
      matchedEventCount,
      matchedAlertCount,
      eventRecall:
        normalizedDamageEvents.length === 0
          ? null
          : matchedEventCount / normalizedDamageEvents.length,
      alertPrecision:
        normalizedAlerts.length === 0
          ? null
          : matchedAlertCount / normalizedAlerts.length,
      trueNegativeRate: null,
      limitation: 'UNLABELED_DAYS_ARE_NOT_CONFIRMED_NEGATIVES',
    },
  };
}

function addDaysForBacktest(date, amount) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount))
    .toISOString()
    .slice(0, 10);
}

function normalizeSoilSnapshot(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError(`snapshots[${index}] must be an object.`);
  }
  return {
    farmId: requiredIdentifier(row.farmId, `snapshots[${index}].farmId`),
    parcelId: requiredIdentifier(row.parcelId, `snapshots[${index}].parcelId`),
    sampledOn: requireIsoDate(row.sampledOn, `snapshots[${index}].sampledOn`),
    sourceType: requiredIdentifier(
      row.sourceType,
      `snapshots[${index}].sourceType`,
    ),
    ph: finiteOrNull(row.ph, `snapshots[${index}].ph`, { min: 0, max: 14 }),
    ec: finiteOrNull(row.ec, `snapshots[${index}].ec`, { min: 0 }),
    organicMatter: finiteOrNull(
      row.organicMatter,
      `snapshots[${index}].organicMatter`,
      { min: 0 },
    ),
    availablePhosphorus: finiteOrNull(
      row.availablePhosphorus,
      `snapshots[${index}].availablePhosphorus`,
      { min: 0 },
    ),
    soilTexture:
      row.soilTexture === null || row.soilTexture === undefined || row.soilTexture === ''
        ? null
        : requiredIdentifier(row.soilTexture, `snapshots[${index}].soilTexture`),
    drainageClass:
      row.drainageClass === null || row.drainageClass === undefined || row.drainageClass === ''
        ? null
        : requiredIdentifier(
            row.drainageClass,
            `snapshots[${index}].drainageClass`,
          ),
  };
}

/** Selects only a snapshot sampled on or before the historical analysis date. */
export function selectHistoricalSoilSnapshot({
  farmId,
  parcelId,
  asOfDate,
  snapshots = [],
  maxAgeDays = 1095,
} = {}) {
  const normalizedFarmId = requiredIdentifier(farmId, 'farmId');
  const normalizedParcelId = requiredIdentifier(parcelId, 'parcelId');
  const date = requireIsoDate(asOfDate, 'asOfDate');
  if (!Array.isArray(snapshots)) throw new TypeError('snapshots must be an array.');
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 3650) {
    throw new TypeError('maxAgeDays must be between 1 and 3650.');
  }
  const eligible = snapshots
    .map(normalizeSoilSnapshot)
    .filter(
      (snapshot) =>
        snapshot.farmId === normalizedFarmId &&
        snapshot.parcelId === normalizedParcelId &&
        snapshot.sampledOn <= date,
    )
    .sort((left, right) => right.sampledOn.localeCompare(left.sampledOn));
  const selected = eligible[0] ?? null;
  if (!selected) {
    return {
      state: 'NO_HISTORICAL_SNAPSHOT',
      asOfDate: date,
      snapshot: null,
      ageDays: null,
      usableForScoring: false,
      limitations: ['NO_SNAPSHOT_ON_OR_BEFORE_ANALYSIS_DATE'],
    };
  }
  const ageDays = daysBetween(selected.sampledOn, date);
  const stale = ageDays > maxAgeDays;
  return {
    state: stale ? 'STALE' : 'READY',
    asOfDate: date,
    snapshot: selected,
    ageDays,
    usableForScoring: !stale,
    limitations: stale ? ['SOIL_SNAPSHOT_TOO_OLD'] : [],
  };
}

export function evaluateHistoricalSoilCoverage({
  analysisDates = [],
  snapshots = [],
  maxAgeDays = 1095,
} = {}) {
  if (!Array.isArray(analysisDates) || !Array.isArray(snapshots)) {
    throw new TypeError('analysisDates and snapshots must be arrays.');
  }
  const rows = analysisDates.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError(`analysisDates[${index}] must be an object.`);
    }
    return {
      farmId: requiredIdentifier(row.farmId, `analysisDates[${index}].farmId`),
      parcelId: requiredIdentifier(
        row.parcelId,
        `analysisDates[${index}].parcelId`,
      ),
      ...selectHistoricalSoilSnapshot({
        farmId: row.farmId,
        parcelId: row.parcelId,
        asOfDate: row.date,
        snapshots,
        maxAgeDays,
      }),
    };
  });
  const readyCount = rows.filter(({ state }) => state === 'READY').length;
  return {
    state:
      rows.length === 0
        ? 'COLLECTION_READY_NO_ANALYSIS_DATES'
        : readyCount === rows.length
          ? 'READY'
          : readyCount > 0
            ? 'PARTIAL'
            : 'HOLD',
    analysisDateCount: rows.length,
    snapshotRecordCount: snapshots.length,
    readyCount,
    coverageRatio: rows.length === 0 ? 0 : readyCount / rows.length,
    staleCount: rows.filter(({ state }) => state === 'STALE').length,
    missingCount: rows.filter(
      ({ state }) => state === 'NO_HISTORICAL_SNAPSHOT',
    ).length,
    futureSnapshotSubstituted: false,
    rows,
  };
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

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Produces an operational rolling bias calibration without look-ahead. For
 * each forecast, only forecast-observation pairs whose valid date was already
 * complete before that forecast's issue date may train the adjustment.
 * Provider values remain available as raw* fields and missing values stay null.
 */
export function buildRollingTemperatureBiasCalibration({
  issuedForecasts = [],
  observations = [],
  minimumTrainingSampleCount = 30,
  rollingWindowDays = 90,
  maximumAbsoluteAdjustmentC = 5,
} = {}) {
  if (!Array.isArray(issuedForecasts) || !Array.isArray(observations)) {
    throw new TypeError('issuedForecasts and observations must be arrays.');
  }
  if (
    !Number.isInteger(minimumTrainingSampleCount) ||
    minimumTrainingSampleCount < 2 ||
    minimumTrainingSampleCount > 365
  ) {
    throw new TypeError(
      'minimumTrainingSampleCount must be an integer between 2 and 365.',
    );
  }
  if (
    !Number.isInteger(rollingWindowDays) ||
    rollingWindowDays < minimumTrainingSampleCount ||
    rollingWindowDays > 730
  ) {
    throw new TypeError(
      'rollingWindowDays must include the training sample count and be at most 730.',
    );
  }
  if (
    !Number.isFinite(maximumAbsoluteAdjustmentC) ||
    maximumAbsoluteAdjustmentC <= 0 ||
    maximumAbsoluteAdjustmentC > 10
  ) {
    throw new TypeError(
      'maximumAbsoluteAdjustmentC must be greater than 0 and at most 10.',
    );
  }

  const observationsByDate = uniqueObservations(observations);
  const forecasts = issuedForecasts
    .map(normalizeIssuedForecast)
    .sort(
      (left, right) =>
        Date.parse(left.issuedAt) - Date.parse(right.issuedAt) ||
        left.validDate.localeCompare(right.validDate),
    );
  const rows = forecasts.map((forecast) => {
    const issueDate = seoulDateFromInstant(new Date(forecast.issuedAt));
    const metrics = {};
    for (const metric of NUMERIC_FORECAST_METRICS) {
      const trainingErrors = [];
      for (const historical of forecasts) {
        if (Date.parse(historical.validAt) >= Date.parse(forecast.issuedAt)) {
          continue;
        }
        if (historical.validDate >= issueDate) continue;
        const ageDays = daysBetween(historical.validDate, issueDate);
        if (ageDays < 1 || ageDays > rollingWindowDays) continue;
        const observation = observationsByDate.get(historical.validDate);
        if (
          !observation ||
          historical[metric] === null ||
          observation[metric] === null
        ) {
          continue;
        }
        trainingErrors.push(historical[metric] - observation[metric]);
      }
      const sampleCount = trainingErrors.length;
      const rawBiasC =
        sampleCount === 0
          ? null
          : trainingErrors.reduce((sum, value) => sum + value, 0) /
            sampleCount;
      const applied =
        forecast[metric] !== null &&
        sampleCount >= minimumTrainingSampleCount;
      const appliedBiasC = applied
        ? clamp(
            rawBiasC,
            -maximumAbsoluteAdjustmentC,
            maximumAbsoluteAdjustmentC,
          )
        : null;
      metrics[metric] = Object.freeze({
        sampleCount,
        rawBiasC,
        appliedBiasC,
        rawValue: forecast[metric],
        adjustedValue:
          appliedBiasC === null ? null : forecast[metric] - appliedBiasC,
        applied,
      });
    }
    return Object.freeze({
      issuedAt: forecast.issuedAt,
      validAt: forecast.validAt,
      validDate: forecast.validDate,
      precipitationProbability: forecast.precipitationProbability,
      metrics: Object.freeze(metrics),
    });
  });
  const appliedForecastCount = rows.filter((row) =>
    NUMERIC_FORECAST_METRICS.some((metric) => row.metrics[metric].applied),
  ).length;

  return Object.freeze({
    state:
      rows.length === 0
        ? 'HOLD'
        : appliedForecastCount === 0
          ? 'WARMUP'
          : appliedForecastCount === rows.length
            ? 'READY'
            : 'PARTIAL',
    method: 'ROLLING_MEAN_ERROR_SUBTRACTION',
    minimumTrainingSampleCount,
    rollingWindowDays,
    maximumAbsoluteAdjustmentC,
    issuedForecastCount: rows.length,
    appliedForecastCount,
    lookAheadPairsUsed: 0,
    providerValuesMutated: false,
    rows: Object.freeze(rows),
  });
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
