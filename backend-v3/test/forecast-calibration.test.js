import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTemperatureCalibrationProfile,
  evaluateTemperatureCalibrationDrift,
  projectTemperatureCalibration,
} from '../src/application/index.js';

function validatedProfile(overrides = {}) {
  return createTemperatureCalibrationProfile({
    profileId: 'd5-pyeongchang-min-20260804',
    version: 'temperature-bias-v1',
    areaCode: '5176000000',
    leadDays: 5,
    metric: 'minTemperature',
    biasC: 3.27,
    trainedThrough: '2026-08-03T14:59:59.000Z',
    validFrom: '2026-08-03T15:00:00.000Z',
    expiresAt: '2026-09-02T15:00:00.000Z',
    raw: {
      sampleCount: 325,
      meanAbsoluteError: 3.5348,
      rootMeanSquaredError: 4.2465,
      bias: 3.272,
    },
    adjusted: {
      sampleCount: 325,
      meanAbsoluteError: 2.2017,
      rootMeanSquaredError: 2.7578,
      bias: -0.0606,
    },
    ...overrides,
  });
}

test('validated temperature calibration is explicit, scoped, expiring, and preserves raw data', () => {
  const profile = validatedProfile();
  const disabled = projectTemperatureCalibration({
    rawValue: 18,
    metric: 'minTemperature',
    areaCode: '5176000000',
    leadDays: 5,
    issuedAt: '2026-08-04T00:00:00.000Z',
    profile,
  });
  assert.equal(disabled.reason, 'CALIBRATION_DISABLED');
  assert.equal(disabled.decisionValue, 18);

  const applied = projectTemperatureCalibration({
    rawValue: 18,
    metric: 'minTemperature',
    areaCode: '5176000000',
    leadDays: 5,
    issuedAt: '2026-08-04T00:00:00.000Z',
    profile,
    enabled: true,
  });
  assert.deepEqual(
    {
      rawValue: applied.rawValue,
      adjustedValue: applied.adjustedValue,
      decisionValue: applied.decisionValue,
      applied: applied.applied,
      providerValueMutated: applied.providerValueMutated,
      entersGrowthScore: applied.entersGrowthScore,
    },
    {
      rawValue: 18,
      adjustedValue: 14.7,
      decisionValue: 14.7,
      applied: true,
      providerValueMutated: false,
      entersGrowthScore: false,
    },
  );

  const wrongScope = projectTemperatureCalibration({
    rawValue: 18,
    metric: 'maxTemperature',
    areaCode: '5176000000',
    leadDays: 5,
    issuedAt: '2026-08-04T00:00:00.000Z',
    profile,
    enabled: true,
  });
  assert.equal(wrongScope.reason, 'PROFILE_SCOPE_MISMATCH');
  assert.equal(wrongScope.decisionValue, 18);

  const expired = projectTemperatureCalibration({
    rawValue: 18,
    metric: 'minTemperature',
    areaCode: '5176000000',
    leadDays: 5,
    issuedAt: '2026-09-02T15:00:00.000Z',
    profile,
    enabled: true,
  });
  assert.equal(expired.reason, 'PROFILE_OUTSIDE_VALIDITY');
  assert.equal(expired.decisionValue, 18);
});

test('a weak calibration profile remains raw-only and missing values stay null', () => {
  const profile = validatedProfile({
    profileId: 'weak-profile',
    raw: {
      sampleCount: 100,
      meanAbsoluteError: 1.5,
      rootMeanSquaredError: 2,
      bias: 0.2,
    },
    adjusted: {
      sampleCount: 100,
      meanAbsoluteError: 1.49,
      rootMeanSquaredError: 2.01,
      bias: 0.3,
    },
  });
  assert.equal(profile.activationState, 'RAW_ONLY');
  assert.deepEqual(profile.reasons, [
    'FEWER_THAN_180_OUT_OF_SAMPLE_PAIRS',
    'MAE_REDUCTION_BELOW_0_1C',
    'RMSE_REDUCTION_BELOW_0_1C',
    'ABSOLUTE_BIAS_NOT_REDUCED',
  ]);

  const held = projectTemperatureCalibration({
    rawValue: null,
    metric: 'minTemperature',
    areaCode: '5176000000',
    leadDays: 5,
    issuedAt: '2026-08-04T00:00:00.000Z',
    profile,
    enabled: true,
  });
  assert.equal(held.reason, 'RAW_VALUE_MISSING');
  assert.equal(held.rawValue, null);
  assert.equal(held.decisionValue, null);
});

test('calibration profiles reject look-ahead and unbounded validity', () => {
  assert.throws(
    () =>
      validatedProfile({
        trainedThrough: '2026-08-04T00:00:00.000Z',
        validFrom: '2026-08-04T00:00:00.000Z',
      }),
    /trainedThrough must be earlier/u,
  );
  assert.throws(
    () =>
      validatedProfile({
        expiresAt: '2027-01-04T00:00:00.000Z',
      }),
    /expire within 120 days/u,
  );
});

test('recent drift rolls a profile back to the untouched provider value', () => {
  const profile = validatedProfile();
  const health = evaluateTemperatureCalibrationDrift({
    profile,
    checkedAt: '2026-08-10T00:00:00.000Z',
    recentRaw: {
      sampleCount: 40,
      meanAbsoluteError: 1.2,
      rootMeanSquaredError: 1.6,
      bias: 0.4,
    },
    recentAdjusted: {
      sampleCount: 40,
      meanAbsoluteError: 1.4,
      rootMeanSquaredError: 1.8,
      bias: 0.6,
    },
  });
  assert.equal(health.state, 'ROLLBACK_TO_RAW');

  const projected = projectTemperatureCalibration({
    rawValue: 18,
    metric: 'minTemperature',
    areaCode: '5176000000',
    leadDays: 5,
    issuedAt: '2026-08-10T00:00:00.000Z',
    profile,
    health,
    enabled: true,
  });
  assert.equal(projected.applied, false);
  assert.equal(projected.decisionValue, 18);
  assert.equal(projected.reason, 'PROFILE_ROLLED_BACK');
});

test('drift monitoring waits for enough recent pairs', () => {
  const health = evaluateTemperatureCalibrationDrift({
    profile: validatedProfile(),
    checkedAt: '2026-08-10T00:00:00.000Z',
    recentRaw: {
      sampleCount: 12,
      meanAbsoluteError: 1.2,
      rootMeanSquaredError: 1.6,
      bias: 0.4,
    },
    recentAdjusted: {
      sampleCount: 12,
      meanAbsoluteError: 1.0,
      rootMeanSquaredError: 1.3,
      bias: 0.2,
    },
  });
  assert.equal(health.state, 'MONITORING');
  assert.deepEqual(health.reasons, ['INSUFFICIENT_RECENT_PAIRS']);
});
