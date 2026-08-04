import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateDailyPrecipitationProbability,
  calculateIssuedForecastMetrics,
  evaluateFarmOutcomeGroundTruth,
  evaluateHistoricalSoilCoverage,
  replayAsosRiskRules,
  selectHistoricalSoilSnapshot,
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

test('daily POP aggregation requires every expected hour and uses the daily maximum', () => {
  const periods = Array.from({ length: 24 }, (_, hour) => ({
    validAt: new Date(Date.UTC(2026, 6, 19, 15 + hour)).toISOString(),
    precipitationProbability: hour === 12 ? 70 : 20,
  }));
  const ready = aggregateDailyPrecipitationProbability({
    issuedAt: '2026-07-19T02:00:00.000Z',
    validDate: '2026-07-20',
    periods,
  });
  assert.equal(ready.state, 'READY');
  assert.equal(ready.precipitationProbability, 70);
  assert.equal(ready.coverageRatio, 1);

  const partial = aggregateDailyPrecipitationProbability({
    issuedAt: '2026-07-19T02:00:00.000Z',
    validDate: '2026-07-20',
    periods: periods.slice(0, 23),
  });
  assert.equal(partial.state, 'PARTIAL');
  assert.equal(partial.precipitationProbability, null);
  assert.deepEqual(partial.limitations, ['INCOMPLETE_HOURLY_POP']);
});

test('farm outcomes evaluate a historical harvest window and confirmed damage only', () => {
  const result = evaluateFarmOutcomeGroundTruth({
    harvestPredictions: [
      {
        farmId: 'farm-1', cropId: 'APPLE', seasonId: '2026',
        issuedAt: '2026-08-01T00:00:00.000Z',
        windowStart: '2026-09-10', windowEnd: '2026-09-20',
      },
    ],
    alerts: [
      {
        farmId: 'farm-1', cropId: 'APPLE', seasonId: '2026',
        riskType: 'HEAT_DAMAGE', issuedAt: '2026-08-01T00:00:00.000Z',
        validFrom: '2026-08-02', validTo: '2026-08-05',
      },
    ],
    outcomes: [
      {
        farmId: 'farm-1', cropId: 'APPLE', seasonId: '2026',
        firstHarvestDate: '2026-09-22', lastHarvestDate: '2026-10-01',
        evidenceSource: 'USER_CONFIRMED_PHOTO',
      },
    ],
    damageEvents: [
      {
        farmId: 'farm-1', cropId: 'APPLE', seasonId: '2026',
        riskType: 'HEAT_DAMAGE', observedDate: '2026-08-04',
        evidenceSource: 'USER_CONFIRMED_PHOTO',
      },
    ],
  });
  assert.equal(result.state, 'READY');
  assert.equal(result.harvest.meanAbsoluteWindowErrorDays, 2);
  assert.equal(result.harvest.meanAbsoluteMidpointErrorDays, 7);
  assert.equal(result.damage.eventRecall, 1);
  assert.equal(result.damage.alertPrecision, 1);
  assert.equal(result.damage.trueNegativeRate, null);
});

test('historical soil selection never uses a future or stale snapshot', () => {
  const snapshots = [
    {
      farmId: 'farm-1', parcelId: 'parcel-1', sampledOn: '2024-01-01',
      sourceType: 'FIELD_EXAM', ph: 6.1, ec: 1.2,
    },
    {
      farmId: 'farm-1', parcelId: 'parcel-1', sampledOn: '2026-08-01',
      sourceType: 'FIELD_EXAM', ph: 5.8, ec: 1.4,
    },
  ];
  const selected = selectHistoricalSoilSnapshot({
    farmId: 'farm-1', parcelId: 'parcel-1', asOfDate: '2025-01-01',
    snapshots, maxAgeDays: 1095,
  });
  assert.equal(selected.state, 'READY');
  assert.equal(selected.snapshot.sampledOn, '2024-01-01');
  assert.equal(selected.snapshot.ph, 6.1);

  const coverage = evaluateHistoricalSoilCoverage({
    analysisDates: [
      { farmId: 'farm-1', parcelId: 'parcel-1', date: '2023-12-31' },
      { farmId: 'farm-1', parcelId: 'parcel-1', date: '2025-01-01' },
    ],
    snapshots,
  });
  assert.equal(coverage.state, 'PARTIAL');
  assert.equal(coverage.readyCount, 1);
  assert.equal(coverage.missingCount, 1);
  assert.equal(coverage.futureSnapshotSubstituted, false);
});
