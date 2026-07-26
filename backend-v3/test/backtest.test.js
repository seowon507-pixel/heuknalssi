import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateIssuedForecastMetrics,
  replayAsosRiskRules,
} from '../src/application/index.js';

const OBSERVATIONS = [
  {
    date: '2026-07-20',
    minTemperature: 20,
    maxTemperature: 31,
    precipitationAmount: 10,
  },
  {
    date: '2026-07-21',
    minTemperature: 18,
    maxTemperature: 27,
    precipitationAmount: 0,
  },
];

test('issued forecast metrics use only forecasts created before valid time', () => {
  const result = calculateIssuedForecastMetrics({
    issuedForecasts: [
      {
        issuedAt: '2026-07-19T02:00:00.000Z',
        validAt: '2026-07-20T06:00:00.000Z',
        validDate: '2026-07-20',
        minTemperature: 19,
        maxTemperature: 33,
        precipitationProbability: 60,
      },
      {
        issuedAt: '2026-07-20T02:00:00.000Z',
        validAt: '2026-07-21T06:00:00.000Z',
        validDate: '2026-07-21',
        minTemperature: 20,
        maxTemperature: 26,
        precipitationProbability: 20,
      },
    ],
    observations: OBSERVATIONS,
  });

  assert.equal(result.state, 'READY');
  assert.equal(result.matchedForecastRatio, 1);
  assert.deepEqual(result.temperature.maxTemperature, {
    sampleCount: 2,
    meanAbsoluteError: 1.5,
    rootMeanSquaredError: Math.sqrt(2.5),
    bias: 0.5,
  });
  assert.deepEqual(result.temperature.minTemperature, {
    sampleCount: 2,
    meanAbsoluteError: 1.5,
    rootMeanSquaredError: Math.sqrt(2.5),
    bias: 0.5,
  });
  assert.ok(
    Math.abs(result.precipitation.brierScore - 0.1) <
      Number.EPSILON,
  );
});

test('issued forecast metrics reject forecasts produced after their valid time', () => {
  assert.throws(
    () =>
      calculateIssuedForecastMetrics({
        issuedForecasts: [
          {
            issuedAt: '2026-07-20T07:00:00.000Z',
            validAt: '2026-07-20T06:00:00.000Z',
            validDate: '2026-07-20',
          },
        ],
        observations: OBSERVATIONS,
      }),
    /issued before its valid time/,
  );
});

test('missing forecast-observation pairs remain excluded instead of imputed', () => {
  const result = calculateIssuedForecastMetrics({
    issuedForecasts: [
      {
        issuedAt: '2026-07-21T02:00:00.000Z',
        validAt: '2026-07-22T06:00:00.000Z',
        validDate: '2026-07-22',
        minTemperature: 20,
        maxTemperature: 30,
        precipitationProbability: 50,
      },
    ],
    observations: OBSERVATIONS,
  });
  assert.equal(result.state, 'HOLD');
  assert.equal(result.matchedForecastCount, 0);
  assert.deepEqual(result.exclusions, [
    {
      issuedAt: '2026-07-21T02:00:00.000Z',
      validDate: '2026-07-22',
      reason: 'OBSERVATION_MISSING',
    },
  ]);
});

test('ASOS replay separates comparable thresholds from forecast probability', () => {
  const result = replayAsosRiskRules({
    rules: [
      {
        ruleId: 'apple-heat',
        crop: 'APPLE',
        module: 'FORECAST',
        use: 'FORECAST_RISK',
        metric: 'maxTemperature',
        comparison: { operator: 'GTE', threshold: 30 },
        duration: { kind: 'ANY_DAY' },
      },
      {
        ruleId: 'apple-rain-probability',
        crop: 'APPLE',
        module: 'FORECAST',
        use: 'FORECAST_RISK',
        metric: 'precipitationProbability',
        comparison: { operator: 'GTE', threshold: 60 },
        duration: { kind: 'ANY_DAY' },
      },
    ],
    observations: OBSERVATIONS,
  });

  assert.equal(result.state, 'READY');
  assert.equal(result.replayedRuleCount, 1);
  assert.equal(result.nonComparableRuleCount, 1);
  assert.deepEqual(result.results[0].triggerDates, ['2026-07-20']);
  assert.equal(result.results[1].state, 'NOT_COMPARABLE');
});
