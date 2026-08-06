const TEMPERATURE_METRICS = Object.freeze([
  'minTemperature',
  'maxTemperature',
]);

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredInstant(value, field) {
  const normalized = requiredString(value, field);
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${field} must be an ISO instant.`);
  }
  return { value: new Date(timestamp).toISOString(), timestamp };
}

function finiteMetric(value, field, { minimum = -Infinity, maximum = Infinity } = {}) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function metricSummary(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object.`);
  }
  return Object.freeze({
    sampleCount: finiteMetric(value.sampleCount, `${field}.sampleCount`, {
      minimum: 0,
      maximum: 100_000,
    }),
    meanAbsoluteError: finiteMetric(
      value.meanAbsoluteError,
      `${field}.meanAbsoluteError`,
      { minimum: 0, maximum: 100 },
    ),
    rootMeanSquaredError: finiteMetric(
      value.rootMeanSquaredError,
      `${field}.rootMeanSquaredError`,
      { minimum: 0, maximum: 100 },
    ),
    bias: finiteMetric(value.bias, `${field}.bias`, {
      minimum: -100,
      maximum: 100,
    }),
  });
}

/**
 * Freezes a deployable temperature-calibration candidate. The profile stays
 * separate from provider data and growth-score inputs, requires an explicit
 * runtime enable, and expires so old backtests cannot silently change live
 * forecasts.
 */
export function createTemperatureCalibrationProfile(input = {}) {
  const profileId = requiredString(input.profileId, 'profileId');
  const version = requiredString(input.version, 'version');
  const areaCode = requiredString(input.areaCode, 'areaCode');
  if (!/^\d{10}$/u.test(areaCode)) {
    throw new TypeError('areaCode must be a 10-digit administrative code.');
  }
  if (!Number.isInteger(input.leadDays) || input.leadDays < 1 || input.leadDays > 10) {
    throw new TypeError('leadDays must be an integer between 1 and 10.');
  }
  if (!TEMPERATURE_METRICS.includes(input.metric)) {
    throw new TypeError('metric must be minTemperature or maxTemperature.');
  }
  const biasC = finiteMetric(input.biasC, 'biasC', {
    minimum: -5,
    maximum: 5,
  });
  const trainedThrough = requiredInstant(input.trainedThrough, 'trainedThrough');
  const validFrom = requiredInstant(input.validFrom, 'validFrom');
  const expiresAt = requiredInstant(input.expiresAt, 'expiresAt');
  if (trainedThrough.timestamp >= validFrom.timestamp) {
    throw new TypeError('trainedThrough must be earlier than validFrom.');
  }
  if (expiresAt.timestamp <= validFrom.timestamp) {
    throw new TypeError('expiresAt must be later than validFrom.');
  }
  if (expiresAt.timestamp - validFrom.timestamp > 120 * 24 * 60 * 60 * 1000) {
    throw new TypeError('calibration profiles must expire within 120 days.');
  }
  const raw = metricSummary(input.raw, 'raw');
  const adjusted = metricSummary(input.adjusted, 'adjusted');
  if (raw.sampleCount !== adjusted.sampleCount) {
    throw new TypeError('raw and adjusted sample counts must match.');
  }
  const reasons = [];
  if (adjusted.sampleCount < 180) {
    reasons.push('FEWER_THAN_180_OUT_OF_SAMPLE_PAIRS');
  }
  if (raw.meanAbsoluteError - adjusted.meanAbsoluteError < 0.1) {
    reasons.push('MAE_REDUCTION_BELOW_0_1C');
  }
  if (raw.rootMeanSquaredError - adjusted.rootMeanSquaredError < 0.1) {
    reasons.push('RMSE_REDUCTION_BELOW_0_1C');
  }
  if (Math.abs(adjusted.bias) >= Math.abs(raw.bias)) {
    reasons.push('ABSOLUTE_BIAS_NOT_REDUCED');
  }

  return Object.freeze({
    profileId,
    version,
    areaCode,
    leadDays: input.leadDays,
    metric: input.metric,
    method: 'ROLLING_MEAN_ERROR_SUBTRACTION',
    biasC,
    trainedThrough: trainedThrough.value,
    validFrom: validFrom.value,
    expiresAt: expiresAt.value,
    raw,
    adjusted,
    activationState: reasons.length === 0 ? 'VALIDATED_CANDIDATE' : 'RAW_ONLY',
    reasons: Object.freeze(reasons),
    providerValuesMutated: false,
    entersGrowthScore: false,
  });
}

/**
 * Projects raw and adjusted values without mutating the provider payload.
 * Missing, disabled, expired, unvalidated, and out-of-scope profiles always
 * keep the provider value as the decision value.
 */
export function projectTemperatureCalibration({
  rawValue,
  metric,
  areaCode,
  leadDays,
  issuedAt,
  profile = null,
  health = null,
  enabled = false,
} = {}) {
  const raw = rawValue === null ? null : finiteMetric(rawValue, 'rawValue', {
    minimum: -90,
    maximum: 70,
  });
  const issue = requiredInstant(issuedAt, 'issuedAt');
  const common = {
    rawValue: raw,
    adjustedValue: null,
    decisionValue: raw,
    applied: false,
    providerValueMutated: false,
    entersGrowthScore: false,
    profileId: profile?.profileId ?? null,
    profileVersion: profile?.version ?? null,
  };
  if (raw === null) return Object.freeze({ ...common, reason: 'RAW_VALUE_MISSING' });
  if (!enabled) return Object.freeze({ ...common, reason: 'CALIBRATION_DISABLED' });
  if (!profile) return Object.freeze({ ...common, reason: 'PROFILE_MISSING' });
  if (health?.state === 'ROLLBACK_TO_RAW') {
    return Object.freeze({ ...common, reason: 'PROFILE_ROLLED_BACK' });
  }
  if (profile.activationState !== 'VALIDATED_CANDIDATE') {
    return Object.freeze({ ...common, reason: 'PROFILE_NOT_VALIDATED' });
  }
  if (
    profile.metric !== metric ||
    profile.areaCode !== areaCode ||
    profile.leadDays !== leadDays
  ) {
    return Object.freeze({ ...common, reason: 'PROFILE_SCOPE_MISMATCH' });
  }
  if (
    issue.timestamp < Date.parse(profile.validFrom) ||
    issue.timestamp >= Date.parse(profile.expiresAt)
  ) {
    return Object.freeze({ ...common, reason: 'PROFILE_OUTSIDE_VALIDITY' });
  }
  const adjustedValue = Math.round((raw - profile.biasC) * 10) / 10;
  return Object.freeze({
    ...common,
    adjustedValue,
    decisionValue: adjustedValue,
    applied: true,
    reason: 'VALIDATED_PROFILE_APPLIED',
  });
}

/**
 * Evaluates recent out-of-sample pairs and fails closed to the provider value.
 * Callers persist the returned state with the profile and pass it to
 * projectTemperatureCalibration; this module never rewrites provider data.
 */
export function evaluateTemperatureCalibrationDrift({
  profile,
  recentRaw,
  recentAdjusted,
  checkedAt,
  minimumSampleCount = 30,
} = {}) {
  if (!profile || typeof profile !== 'object') {
    throw new TypeError('profile must be an object.');
  }
  if (!Number.isInteger(minimumSampleCount) || minimumSampleCount < 10) {
    throw new TypeError('minimumSampleCount must be an integer of at least 10.');
  }
  const checked = requiredInstant(checkedAt, 'checkedAt');
  const raw = metricSummary(recentRaw, 'recentRaw');
  const adjusted = metricSummary(recentAdjusted, 'recentAdjusted');
  if (raw.sampleCount !== adjusted.sampleCount) {
    throw new TypeError('recent raw and adjusted sample counts must match.');
  }
  const common = {
    profileId: profile.profileId ?? null,
    profileVersion: profile.version ?? null,
    sampleCount: raw.sampleCount,
    checkedAt: checked.value,
    raw,
    adjusted,
  };
  if (raw.sampleCount < minimumSampleCount) {
    return Object.freeze({
      ...common,
      state: 'MONITORING',
      reasons: Object.freeze(['INSUFFICIENT_RECENT_PAIRS']),
    });
  }
  const reasons = [];
  if (adjusted.meanAbsoluteError >= raw.meanAbsoluteError) {
    reasons.push('RECENT_MAE_NOT_IMPROVED');
  }
  if (adjusted.rootMeanSquaredError >= raw.rootMeanSquaredError) {
    reasons.push('RECENT_RMSE_NOT_IMPROVED');
  }
  if (Math.abs(adjusted.bias) >= Math.abs(raw.bias)) {
    reasons.push('RECENT_ABSOLUTE_BIAS_NOT_IMPROVED');
  }
  return Object.freeze({
    ...common,
    state: reasons.length === 0 ? 'HEALTHY' : 'ROLLBACK_TO_RAW',
    reasons: Object.freeze(reasons),
  });
}

export const temperatureCalibrationContract = Object.freeze({
  metrics: TEMPERATURE_METRICS,
  maximumProfileLifetimeDays: 120,
  minimumOutOfSamplePairs: 180,
  minimumDriftPairs: 30,
});
