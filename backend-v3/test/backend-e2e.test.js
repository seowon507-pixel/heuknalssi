import assert from 'node:assert/strict';
import test from 'node:test';

import { createDataEnvelope } from '../src/adapters/index.js';
import { createBackend } from '../server/app.js';

const FIXED_TIME = Date.parse('2026-07-23T03:00:00.000Z');
const ALLOWED_ORIGIN = 'http://app.example.test';
const PROVENANCE = Object.freeze({
  sourceTitle: '검토된 E2E 시험 근거',
  sourceUrl: 'https://example.test/reviewed-source',
  sourcePageOrTable: 'Table 1',
  sourceVersion: '2026-01',
  reviewedAt: '2026-07-01',
  ruleVersion: 'rules-e2e-v1',
});

test('real HTTP composition completes analysis, semantic replay, ownership, and report flow', async (t) => {
  const backend = createBackend({
    env: {
      NODE_ENV: 'development',
      SESSION_SECRET: 'e2e-session-secret-longer-than-thirty-two-characters',
      ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    },
    adapters: fixtureAdapters(),
    rules: fixtureRules(),
    verifiedLocationMappings: {
      '4111710500': fixtureMapping(),
    },
    clock: () => FIXED_TIME,
    logger: { info() {}, error() {} },
  });
  await new Promise((resolve) =>
    backend.server.listen(0, '127.0.0.1', resolve),
  );
  t.after(
    () =>
      new Promise((resolve) => {
        backend.server.close(resolve);
      }),
  );
  const { port } = backend.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const sessionResponse = await fetch(`${baseUrl}/api/session`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  const cookie = sessionResponse.headers.get('set-cookie').split(';', 1)[0];

  const locationResponse = await fetch(
    `${baseUrl}/api/locations?q=${encodeURIComponent('수원시 원천동')}`,
    {
      headers: {
        Cookie: cookie,
        Origin: ALLOWED_ORIGIN,
      },
    },
  );
  assert.equal(locationResponse.status, 200);
  const location = await locationResponse.json();
  assert.equal(location.candidates.length, 1);
  const candidateToken = location.candidates[0].candidateToken;
  assert.equal('latitude' in location.candidates[0], false);

  const looseInput = {
    usageMode: ' land_search ',
    location: {
      candidateToken: ` ${candidateToken} `,
      userConfirmed: true,
    },
    crop: ' cucumber ',
    cultivationMode: ' open_field ',
    season: {
      kind: ' custom ',
      profileId: 'CUSTOM',
      startMonth: 5,
      endMonth: 5,
      userConfirmed: true,
    },
  };
  const createHeaders = {
    'Content-Type': 'application/json',
    Cookie: cookie,
    'Idempotency-Key': 'backend-e2e-semantic-replay',
    Origin: ALLOWED_ORIGIN,
    'X-CSRF-Token': session.csrfToken,
  };
  const createResponse = await fetch(`${baseUrl}/api/analyses`, {
    method: 'POST',
    headers: createHeaders,
    body: JSON.stringify(looseInput),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.state, 'COMPLETE');
  assert.equal(created.conditionState, 'READY');
  assert.equal(created.riskState, 'READY');
  assert.equal(created.lifecycle.currentState, 'CORE_READY');
  assert.equal(created.inputSummary.regionLabel, '경기도 수원시');

  const canonicalInput = {
    usageMode: 'LAND_SEARCH',
    location: { candidateToken, userConfirmed: true },
    crop: 'CUCUMBER',
    cultivationMode: 'OPEN_FIELD',
    season: {
      kind: 'CUSTOM',
      profileId: 'CUSTOM',
      startMonth: 5,
      endMonth: 5,
      userConfirmed: true,
    },
    options: {
      includeSmartfarmBenchmark: false,
      includeSatelliteObservation: false,
      saveConsent: false,
    },
  };
  const replayResponse = await fetch(`${baseUrl}/api/analyses`, {
    method: 'POST',
    headers: createHeaders,
    body: JSON.stringify(canonicalInput),
  });
  assert.equal(replayResponse.status, 201);
  assert.equal(replayResponse.headers.get('idempotency-replayed'), 'true');
  assert.equal((await replayResponse.json()).analysisId, created.analysisId);

  const reportResponse = await fetch(
    `${baseUrl}/api/analyses/${created.analysisId}/report`,
    {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: ALLOWED_ORIGIN,
        'X-CSRF-Token': session.csrfToken,
      },
    },
  );
  assert.equal(reportResponse.status, 202);
  assert.equal((await reportResponse.json()).report.state, 'PENDING');

  await new Promise((resolve) => setImmediate(resolve));
  const completedResponse = await fetch(
    `${baseUrl}/api/analyses/${created.analysisId}`,
    {
      headers: {
        Cookie: cookie,
        Origin: ALLOWED_ORIGIN,
      },
    },
  );
  assert.equal(completedResponse.status, 200);
  const completed = await completedResponse.json();
  assert.equal(completed.report.state, 'FALLBACK');
  assert.equal(completed.lifecycle.currentState, 'COMPLETE');

  const evidenceIds = new Set(
    [
      ...completed.climate.evidence,
      ...completed.soil.evidence,
      ...completed.observations.evidence,
      ...completed.forecast.evidence,
    ].map(({ evidenceId }) => evidenceId),
  );
  const reportFactIds = [
    completed.report.value.summary,
    ...completed.report.value.strengths,
    ...completed.report.value.risks,
    ...completed.report.value.nextActions,
    ...completed.report.value.limitations,
  ].flatMap(({ factIds }) => factIds);
  assert.equal(
    reportFactIds.every((factId) => evidenceIds.has(factId)),
    true,
  );

  const strangerResponse = await fetch(`${baseUrl}/api/session`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  const strangerCookie = strangerResponse.headers
    .get('set-cookie')
    .split(';', 1)[0];
  const forbiddenLookup = await fetch(
    `${baseUrl}/api/analyses/${created.analysisId}`,
    {
      headers: {
        Cookie: strangerCookie,
        Origin: ALLOWED_ORIGIN,
      },
    },
  );
  assert.equal(forbiddenLookup.status, 404);
});

function fixtureEnvelope({
  sourceId,
  spatialLevel,
  data,
  observedAt = null,
  issuedAt = null,
  validFrom = null,
  validTo = null,
}) {
  return createDataEnvelope(
    {
      sourceId,
      sourceName: `${sourceId} verified fixture`,
      sourceUrl: 'https://example.test/provider',
      retrievedAt: new Date(FIXED_TIME).toISOString(),
      observedAt,
      issuedAt,
      validFrom,
      validTo,
      spatialLevel,
      spatialLabel: `${spatialLevel} fixture`,
      distanceKm: null,
      unit: null,
      deliveryState: 'LIVE',
      adapterState: 'SUCCESS',
      qualityFlags: ['VERIFIED_FIXTURE'],
      cacheMeta: null,
      data,
      provenance: {
        adapterId: sourceId,
        adapterVersion: '1',
        operationId: `${sourceId}-fixture`,
        contractVersion: 'fixture-v1',
        providerIssueTime: issuedAt,
      },
    },
    { now: () => new Date(FIXED_TIME) },
  );
}

function fixtureAdapters() {
  return {
    kakao: {
      async searchLocations() {
        return fixtureEnvelope({
          sourceId: 'kakao-location',
          spatialLevel: 'FIELD',
          data: {
            candidates: [
              {
                displayName: '경기도 수원시 영통구 원천동 1',
                resolutionMode: 'ADDRESS_RESOLVED',
                latitude: 37.25,
                longitude: 127.05,
                legalDongCode10: '4111710500',
                adminAreaCode: '4111710500',
              },
            ],
          },
        });
      },
    },
    climate: {
      async getNormals() {
        return fixtureEnvelope({
          sourceId: 'kma-climate-normal',
          spatialLevel: 'NORMAL_STATION',
          observedAt: '2025-12-31T15:00:00.000Z',
          data: {
            observations: [
              {
                metric: 'meanTemperature',
                month: 5,
                value: 15,
                unit: 'degC',
              },
            ],
          },
        });
      },
    },
    observations: {
      async getRecent() {
        return fixtureEnvelope({
          sourceId: 'kma-asos-observations',
          spatialLevel: 'OBSERVATION_STATION',
          observedAt: '2026-07-22T15:00:00.000Z',
          data: {
            stationId: '119',
            stationName: '수원',
            readings: completedObservationDays(),
            monthlyNormals: [
              {
                stationId: '119',
                month: 7,
                meanTemperature: 24,
              },
            ],
          },
        });
      },
    },
    soilV2: {
      async getDistribution() {
        return fixtureEnvelope({
          sourceId: 'soil-v2',
          spatialLevel: 'REGIONAL_SOIL_STAT',
          observedAt: '2025-12-31T15:00:00.000Z',
          data: {
            metrics: [
              {
                metric: 'soilPh',
                unit: 'pH',
                boundarySemanticsVerified: true,
                areaToleranceVerified: true,
                areaTolerance: 0,
                totalValidArea: 100,
                areaUnit: 'ha',
                intervals: [
                  {
                    lower: 6,
                    upper: 7,
                    lowerInclusive: true,
                    upperInclusive: true,
                    area: 100,
                    areaUnit: 'ha',
                  },
                ],
              },
            ],
          },
        });
      },
    },
    kmaShort: {
      async getForecast() {
        return fixtureEnvelope({
          sourceId: 'kma-short-forecast',
          spatialLevel: 'FORECAST_GRID',
          issuedAt: '2026-07-23T02:00:00.000Z',
          validFrom: '2026-07-23T15:00:00.000Z',
          validTo: '2026-07-24T14:59:59.000Z',
          data: { days: [forecastDay('2026-07-24', 'SHORT_GRID')] },
        });
      },
    },
    kmaMid: {
      async getForecast() {
        return fixtureEnvelope({
          sourceId: 'kma-mid-forecast',
          spatialLevel: 'FORECAST_REGION',
          issuedAt: '2026-07-23T02:00:00.000Z',
          validFrom: '2026-07-24T15:00:00.000Z',
          validTo: '2026-07-25T14:59:59.000Z',
          data: { days: [forecastDay('2026-07-25', 'MID_REGIONAL')] },
        });
      },
    },
  };
}

function fixtureRules() {
  const common = {
    crop: 'CUCUMBER',
    cultivationMode: 'OPEN_FIELD',
    stage: 'ANY',
    ...PROVENANCE,
  };
  return [
    {
      ...common,
      ruleId: 'climate-mean-temperature',
      module: 'CLIMATE',
      seasonProfileId: 'CUSTOM',
      evaluationPeriod: { grain: 'MONTH', month: 5 },
      metric: 'meanTemperature',
      unit: 'degC',
      use: 'DEVIATION',
      evidenceStatus: 'CONFIRMED_RANGE',
      optimalRange: [10, 20],
      toleranceRange: null,
      sensitivityTier: 'CRITICAL',
      critical: true,
    },
    {
      ...common,
      ruleId: 'soil-ph',
      module: 'SOIL',
      seasonProfileId: 'CUSTOM',
      evaluationPeriod: {
        grain: 'SEASON_AGGREGATE',
        aggregation: 'MEAN',
      },
      metric: 'soilPh',
      unit: 'pH',
      use: 'DEVIATION',
      evidenceStatus: 'CONFIRMED_RANGE',
      optimalRange: [6, 7],
      toleranceRange: null,
      sensitivityTier: 'CRITICAL',
      critical: true,
    },
    {
      ...common,
      ruleId: 'forecast-high-temperature',
      module: 'FORECAST',
      use: 'FORECAST_RISK',
      metric: 'maxTemperature',
      unit: '℃',
      comparison: { operator: 'GT', threshold: 30 },
      duration: { kind: 'ANY_DAY' },
      severity: 'WARNING',
      actionId: 'CHECK_HEAT',
      evidenceStatus: 'RISK_ONLY',
    },
  ];
}

function fixtureMapping() {
  return {
    provenance: {
      sourceTitle: '검토된 위치 매핑표',
      sourceUrl: 'https://example.test/location-mapping',
      version: 'mapping-v1',
      reviewedAt: '2026-07-01',
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
    },
    soil: { verified: true, code: '4111710500' },
    midForecast: {
      verified: true,
      temperatureRegId: '11B20601',
      landRegId: '11B00000',
    },
    normalStation: { verified: true, id: '119' },
    observationStation: {
      verified: true,
      id: '119',
      distanceKm: 4.2,
      operationalVerified: true,
      periodDataVerified: true,
    },
  };
}

function completedObservationDays() {
  return [
    '2026-07-16',
    '2026-07-17',
    '2026-07-18',
    '2026-07-19',
    '2026-07-20',
    '2026-07-21',
    '2026-07-22',
  ].map((date, index) => ({
    date,
    stationId: '119',
    minTemperature: 18 + index / 10,
    maxTemperature: 27 + index / 10,
    meanTemperature: 22 + index / 10,
    precipitationAmount: index === 2 ? 3 : 0,
  }));
}

function forecastDay(date, sourceType) {
  return {
    date,
    sourceType,
    spatialLevel:
      sourceType === 'SHORT_GRID'
        ? 'FORECAST_GRID'
        : 'FORECAST_REGION',
    issueTime: '2026-07-23T02:00:00.000Z',
    validFrom: `${date}T00:00:00.000Z`,
    validTo: `${date}T23:59:59.000Z`,
    minTemperature: 15,
    maxTemperature: 24,
    precipitationProbability: 10,
    precipitationAmount: 0,
    windSpeed: 1,
    risks: [],
  };
}
