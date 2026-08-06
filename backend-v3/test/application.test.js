import assert from 'node:assert/strict';
import test from 'node:test';

import { createDataEnvelope } from '../src/adapters/index.js';
import {
  applicationDefaults,
  createApplicationServices,
  validateVerifiedLocationMappings,
} from '../src/application/index.js';
import {
  StoreCapacityError,
  TtlMemoryStore,
} from '../src/infrastructure/index.js';

const FIXED_TIME = Date.parse('2026-07-23T03:00:00.000Z');
const PROVENANCE = Object.freeze({
  sourceTitle: '검토된 시험 근거',
  sourceUrl: 'https://example.test/reviewed-source',
  sourcePageOrTable: 'Table 1',
  sourceVersion: '2026-01',
  reviewedAt: '2026-07-01',
  ruleVersion: 'rules-v1',
});
const MAPPING_PROVENANCE = Object.freeze({
  sourceTitle: '검토된 위치 매핑표',
  sourceUrl: 'https://example.test/location-mapping',
  version: 'mapping-v1',
  reviewedAt: '2026-07-01',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
});

function deterministicRandomBytes(size) {
  return Buffer.alloc(size, 7);
}

function envelope({
  sourceId,
  spatialLevel,
  data,
  issuedAt = null,
  observedAt = null,
  validFrom = null,
  validTo = null,
  qualityFlags = ['VERIFIED_FIXTURE'],
}) {
  return createDataEnvelope(
    {
      sourceId,
      sourceName: `${sourceId} fixture`,
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
      qualityFlags,
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

function readyRuntimeStatus() {
  return {
    adapters: {
      kakao: 'READY',
      climate: 'READY',
      observations: 'READY',
      soilV2: 'READY',
      kmaShort: 'READY',
      kmaMid: 'READY',
    },
    contracts: {
      climate: 'fixture-v1',
      observations: 'fixture-v1',
      soil: 'fixture-v1',
      shortForecast: 'fixture-v1',
      midForecast: 'fixture-v1',
    },
  };
}

function locationAdapter({
  resolutionMode = 'ADDRESS_RESOLVED',
  latitude = 37.25,
  longitude = 127.05,
  fieldParcelLookupKey,
} = {}) {
  return {
    id: 'kakao-fixture',
    async searchLocations() {
      return envelope({
        sourceId: 'kakao-location',
        spatialLevel: 'FIELD',
        data: {
          candidates: [
            {
              displayName: '경기도 수원시 영통구 원천동 1',
              resolutionMode,
              latitude,
              longitude,
              ...(resolutionMode === 'ADMIN_AREA_BROAD'
                ? {
                    administrativeRepresentative: {
                      latitude,
                      longitude,
                      purpose: 'REGIONAL_FORECAST_ONLY',
                    },
                  }
                : {}),
              legalDongCode10: '4111710500',
              adminAreaCode: '4111710500',
              ...(fieldParcelLookupKey
                ? { fieldParcelLookupKey }
                : {}),
            },
          ],
        },
      });
    },
    async resolveCurrentLocation() {
      return this.searchLocations();
    },
  };
}

function reviewedRules() {
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
      evaluationPeriod: { grain: 'SEASON_AGGREGATE', aggregation: 'MEAN' },
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

function compatibleOpenFieldRules({
  crop = 'APPLE',
  seasonProfileId = 'APPLE_OPEN_FIELD_ANNUAL',
  stage = 'ANY',
} = {}) {
  return reviewedRules().map((rule) => ({
    ...rule,
    ruleId: `${crop.toLowerCase()}-${rule.ruleId}`,
    crop,
    seasonProfileId:
      rule.module === 'FORECAST' ? rule.seasonProfileId : seasonProfileId,
    stage,
  }));
}

function compatibleCustomOpenFieldRules(crop) {
  const [climate, soil, forecast] = compatibleOpenFieldRules({
    crop,
    seasonProfileId: 'CUSTOM',
  });
  return [
    ...Array.from({ length: 12 }, (_, index) => {
      const month = index + 1;
      return {
        ...climate,
        ruleId: `${climate.ruleId}-month-${month}`,
        evaluationPeriod: { grain: 'MONTH', month },
      };
    }),
    soil,
    forecast,
  ];
}

function fullyCompatibleRulesForAllContexts() {
  const openFieldProfiles = {
    APPLE: 'APPLE_OPEN_FIELD_ANNUAL',
    PEAR: 'PEAR_OPEN_FIELD_ANNUAL',
    POTATO: 'CUSTOM',
    CUCUMBER: 'CUSTOM',
    LETTUCE: 'CUSTOM',
  };
  const rules = Object.entries(openFieldProfiles).flatMap(
    ([crop, seasonProfileId]) =>
      ['APPLE', 'PEAR'].includes(crop)
        ? compatibleOpenFieldRules({ crop, seasonProfileId })
        : compatibleCustomOpenFieldRules(crop),
  );
  for (const crop of ['CUCUMBER', 'LETTUCE']) {
    rules.push(
      {
        ...reviewedRules()[1],
        ruleId: `${crop.toLowerCase()}-facility-soil`,
        crop,
        cultivationMode: 'FACILITY_SOIL',
        seasonProfileId: 'NOT_APPLICABLE',
      },
      {
        ...reviewedRules()[2],
        ruleId: `${crop.toLowerCase()}-facility-soil-forecast`,
        crop,
        cultivationMode: 'FACILITY_SOIL',
      },
      {
        ...reviewedRules()[2],
        ruleId: `${crop.toLowerCase()}-facility-hydro-forecast`,
        crop,
        cultivationMode: 'FACILITY_HYDRO',
      },
    );
  }
  return rules;
}

function climateEvidenceRules() {
  const common = {
    crop: 'CUCUMBER',
    cultivationMode: 'OPEN_FIELD',
    stage: 'ANY',
    seasonProfileId: 'CUSTOM',
    evaluationPeriod: { grain: 'MONTH', month: 5 },
    ...PROVENANCE,
  };
  return [
    ...reviewedRules(),
    {
      ...common,
      ruleId: 'climate-high-temperature',
      module: 'CLIMATE',
      metric: 'maxTemperature',
      unit: 'degC',
      use: 'DEVIATION',
      evidenceStatus: 'CONFIRMED_RANGE',
      optimalRange: [20, 30],
      toleranceRange: null,
      sensitivityTier: 'IMPORTANT',
      critical: false,
    },
    {
      ...common,
      ruleId: 'climate-rainfall',
      module: 'CLIMATE',
      metric: 'precipitationAmount',
      unit: 'mm',
      use: 'DEVIATION',
      evidenceStatus: 'CONFIRMED_RANGE',
      optimalRange: [40, 80],
      toleranceRange: null,
      sensitivityTier: 'SUPPORTING',
      critical: false,
    },
    {
      ...common,
      ruleId: 'climate-minimum-target',
      module: 'CLIMATE',
      metric: 'minTemperature',
      unit: 'degC',
      use: 'SINGLE_TARGET',
      evidenceStatus: 'SINGLE_TARGET',
      target: 16,
      sensitivityTier: 'SUPPORTING',
      critical: false,
    },
  ];
}

function forecastOnlyRulesForFiveCrops() {
  return ['APPLE', 'PEAR', 'CUCUMBER', 'POTATO', 'LETTUCE'].map(
    (crop) => ({
      ...reviewedRules()[2],
      ruleId: `forecast-${crop.toLowerCase()}`,
      crop,
    }),
  );
}

function facilityForecastRules() {
  return [
    {
      ...reviewedRules()[2],
      ruleId: 'facility-high-temperature',
      cultivationMode: 'FACILITY_HYDRO',
    },
  ];
}

function forecastDay(date, sourceType) {
  return {
    date,
    sourceType,
    spatialLevel:
      sourceType === 'SHORT_GRID' ? 'FORECAST_GRID' : 'FORECAST_REGION',
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

function completeObservationReadings() {
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

function completeAdapters(calls) {
  return {
    kakao: locationAdapter(),
    climate: {
      id: 'climate-fixture',
      async getNormals(params) {
        calls.climate.push(params);
        return envelope({
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
      id: 'observations-fixture',
      async getRecent(params) {
        calls.observations.push(params);
        return envelope({
          sourceId: 'kma-asos-observations',
          spatialLevel: 'OBSERVATION_STATION',
          observedAt: '2026-07-22T15:00:00.000Z',
          data: {
            stationId: '119',
            stationName: '수원',
            distanceKm: 4.2,
            readings: completeObservationReadings(),
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
      id: 'soil-fixture',
      async getDistribution(params) {
        calls.soil.push(params);
        return envelope({
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
      id: 'short-fixture',
      async getForecast(params) {
        calls.short.push(params);
        return envelope({
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
      id: 'mid-fixture',
      async getForecast(params) {
        calls.mid.push(params);
        return envelope({
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

function analysisInput(candidateToken) {
  return {
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
  };
}

function verifiedMapping(overrides = {}) {
  return {
    provenance: { ...MAPPING_PROVENANCE },
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
    ...overrides,
  };
}

function sixVerifiedMappings(mapper = () => verifiedMapping()) {
  return Object.fromEntries(
    Array.from({ length: 6 }, (_, index) => [
      `411171050${index}`,
      mapper(index),
    ]),
  );
}

async function confirmedCandidate(services, ownerSessionId = 'owner-a') {
  const search = await services.searchLocations({
    ownerSessionId,
    query: '수원시 원천동',
  });
  assert.equal(search.candidates.length, 1);
  return search.candidates[0].candidateToken;
}

test('current coordinates are converted to an owner-bound opaque location candidate', async () => {
  const services = createApplicationServices({
    adapters: { kakao: locationAdapter() },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const result = await services.resolveCurrentLocation({
    ownerSessionId: 'owner-current',
    latitude: 37.285,
    longitude: 127.045,
  });

  assert.equal(result.candidates.length, 1);
  assert.equal('latitude' in result.candidates[0], false);
  assert.equal('longitude' in result.candidates[0], false);
  assert.match(result.candidates[0].candidateToken, /^[A-Za-z0-9_-]+$/u);
});

test('FarmMap search uses the analysis-bound exact location without exposing coordinates', async () => {
  const calls = {
    climate: [], observations: [], soil: [], short: [], mid: [], farmmap: [],
  };
  const adapters = completeAdapters(calls);
  adapters.farmmap = {
    id: 'farmmap-fixture',
    state: 'CONFIGURED_UNVERIFIED',
    async searchParcels(params) {
      calls.farmmap.push(params);
      return {
        state: 'READY',
        candidates: [{
          farmmapId: 'FM-1',
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [127.049, 37.249], [127.051, 37.249],
              [127.051, 37.251], [127.049, 37.251],
              [127.049, 37.249],
            ]],
          },
          areaSquareMeters: 39_000,
          category: '밭',
          representativeAddress: '경기도 수원시 영통구 원천동',
          source: 'EPIS_FARMMAP_WFS',
        }],
        sourceUrl: 'https://agis.epis.or.kr/',
        limitations: ['REFERENCE_MAP_NOT_LEGAL_CADASTRAL_BOUNDARY'],
      };
    },
  };
  const services = createApplicationServices({
    adapters,
    rules: reviewedRules(),
    verifiedLocationMappings: sixVerifiedMappings(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
    capabilities: { farmmap: 'CONFIGURED_UNVERIFIED' },
  });
  const candidateToken = await confirmedCandidate(services, 'owner-farmmap');
  const analysis = await services.createAnalysis({
    ownerSessionId: 'owner-farmmap',
    analysisId: 'analysis-farmmap',
    input: analysisInput(candidateToken),
  });
  assert.equal(JSON.stringify(analysis).includes('37.25'), false);
  assert.equal(JSON.stringify(analysis).includes('127.05'), false);

  const result = await services.searchFarmmapParcels({
    ownerSessionId: 'owner-farmmap',
    analysisId: 'analysis-farmmap',
    radiusMeters: 300,
  });
  assert.deepEqual(calls.farmmap, [{
    latitude: 37.25,
    longitude: 127.05,
    radiusMeters: 300,
  }]);
  assert.equal(result.state, 'READY');
  assert.equal(result.candidates[0].farmmapId, 'FM-1');
  assert.equal(await services.searchFarmmapParcels({
    ownerSessionId: 'another-owner',
    analysisId: 'analysis-farmmap',
  }), null);
});

test('FarmMap provider timeout degrades to an unavailable optional feature', async () => {
  const calls = {
    climate: [], observations: [], soil: [], short: [], mid: [], farmmap: [],
  };
  const adapters = completeAdapters(calls);
  adapters.farmmap = {
    id: 'farmmap-timeout-fixture',
    state: 'CONFIGURED_UNVERIFIED',
    async searchParcels() {
      throw Object.assign(new Error('provider deadline exceeded'), {
        adapterState: 'TIMEOUT',
      });
    },
  };
  const services = createApplicationServices({
    adapters,
    rules: reviewedRules(),
    verifiedLocationMappings: sixVerifiedMappings(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
    capabilities: { farmmap: 'CONFIGURED_UNVERIFIED' },
  });
  const candidateToken = await confirmedCandidate(services, 'owner-farmmap-timeout');
  await services.createAnalysis({
    ownerSessionId: 'owner-farmmap-timeout',
    analysisId: 'analysis-farmmap-timeout',
    input: analysisInput(candidateToken),
  });

  const result = await services.searchFarmmapParcels({
    ownerSessionId: 'owner-farmmap-timeout',
    analysisId: 'analysis-farmmap-timeout',
  });

  assert.equal(result.state, 'UNAVAILABLE');
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.limitations, ['FARMMAP_PROVIDER_TIMEOUT']);
});

test('field soil profile is attached without exposing the private parcel lookup key', async () => {
  const privatePnu = '4111710500100010001';
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const adapters = completeAdapters(calls);
  adapters.kakao = locationAdapter({
    fieldParcelLookupKey: privatePnu,
  });
  adapters.soilField = {
    id: 'soil-field-fixture',
    async getFieldProfile(params) {
      assert.deepEqual(params, { pnuCode: privatePnu });
      return envelope({
        sourceId: 'soil-field-v3',
        spatialLevel: 'FIELD',
        observedAt: '2025-12-31T15:00:00.000Z',
        data: {
          parcelMatched: true,
          mapScale: '1:5000',
          drainageCode: '02',
          effectiveDepthCode: '03',
          topsoilTextureCode: '04',
          codeLabelsVerified: false,
        },
      });
    },
  };
  const services = createApplicationServices({
    adapters,
    rules: reviewedRules(),
    verifiedLocationMappings: sixVerifiedMappings(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-field-soil',
    input: analysisInput(candidateToken),
  });

  assert.equal(result.soil.result.fieldProfileState, 'SUCCESS');
  assert.deepEqual(result.soil.result.fieldProfile, {
    parcelMatched: true,
    mapScale: '1:5000',
    drainageCode: '02',
    effectiveDepthCode: '03',
    topsoilTextureCode: '04',
    codeLabelsVerified: false,
  });
  const fieldMapScope = result.analysisScope.groups
    .flatMap(({ items }) => items)
    .find(({ itemId }) => itemId === 'FIELD_SOIL_MAP');
  assert.equal(fieldMapScope.scope, 'FIELD_SOIL_MAP');
  assert.equal(fieldMapScope.state, 'AVAILABLE');
  assert.equal(fieldMapScope.source.sourceId, 'soil-field-v3');
  assert.equal(JSON.stringify(result).includes(privatePnu), false);
});

test('latest provider field exam is used before regional soil statistics', async () => {
  const privatePnu = '4111710500100010001';
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
    soilExam: [],
  };
  const adapters = completeAdapters(calls);
  adapters.kakao = locationAdapter({
    fieldParcelLookupKey: privatePnu,
  });
  adapters.soilExam = {
    id: 'soil-exam-fixture',
    async getLatestExam(params) {
      calls.soilExam.push(params);
      return envelope({
        sourceId: 'soil-exam-v2',
        spatialLevel: 'FIELD',
        observedAt: '2026-07-19T15:00:00.000Z',
        data: {
          dataRole: 'PROVIDER_SOIL_TEST',
          sampledOn: '2026-07-20',
          examType: '밭',
          metrics: [
            {
              metric: 'PH',
              unit: 'pH',
              boundarySemanticsVerified: true,
              totalValidArea: 1,
              areaUnit: 'MEASURED_POINT',
              intervals: [
                {
                  lower: 6.2,
                  upper: 6.2,
                  lowerInclusive: true,
                  upperInclusive: true,
                  area: 1,
                  areaUnit: 'MEASURED_POINT',
                },
              ],
            },
          ],
        },
      });
    },
  };
  const rules = reviewedRules().map((rule) =>
    rule.module === 'SOIL' ? { ...rule, metric: 'PH' } : rule,
  );
  const services = createApplicationServices({
    adapters,
    rules,
    verifiedLocationMappings: sixVerifiedMappings(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-provider-soil-exam',
    input: analysisInput(candidateToken),
  });

  assert.deepEqual(calls.soilExam, [{ pnuCode: privatePnu }]);
  assert.equal(result.soil.result.measurementBasis, 'PROVIDER_SOIL_TEST');
  assert.deepEqual(result.soil.result.providerSoilTest, {
    sampledOn: '2026-07-20',
    examType: '밭',
    measurements: [{ metric: 'PH', unit: 'pH', value: 6.2 }],
  });
  assert.equal(result.soil.result.metrics[0].areaUnit, 'MEASURED_POINT');
  assert.equal(result.soil.result.regionalStatistics.usedForDecision, false);
  const fieldExamScope = result.analysisScope.groups
    .flatMap(({ items }) => items)
    .find(({ itemId }) => itemId === 'FIELD_SOIL_EXAM');
  assert.equal(fieldExamScope.scope, 'FIELD_MEASUREMENT');
  assert.equal(fieldExamScope.state, 'AVAILABLE');
  assert.equal(fieldExamScope.source.sourceId, 'soil-exam-v2');
  assert.equal(JSON.stringify(result).includes(privatePnu), false);
});

test('regional pH is not held back by field-only supporting chemistry rules', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const baseRules = reviewedRules();
  const supportingEcRule = {
    ...baseRules[1],
    ruleId: 'soil-ec-supporting-field-only',
    metric: 'EC',
    unit: 'dS/m',
    sensitivityTier: 'SUPPORTING',
    critical: false,
  };
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules: [...baseRules, supportingEcRule],
    verifiedLocationMappings: sixVerifiedMappings(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-regional-soil',
    input: analysisInput(candidateToken),
  });

  assert.equal(result.soil.state, 'READY');
  assert.equal(result.soil.coverage, 1);
  assert.equal(result.soil.result.measurementBasis, 'REGIONAL_STATISTICS');
  assert.deepEqual(result.soil.result.includedRuleIds, ['soil-ph']);
  assert.equal(result.soil.result.regionalStatistics.usedForDecision, true);
});

test('application exposes a source-trust weighted growth score with separate confidence', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules: reviewedRules(),
    verifiedLocationMappings: {
      '4111710500': verifiedMapping(),
    },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-integration',
    input: analysisInput(candidateToken),
  });

  assert.equal(result.state, 'COMPLETE');
  assert.equal(result.conditionState, 'READY');
  assert.equal(result.riskState, 'READY');
  assert.equal(result.decision.code, 'FIELD_TEST_NEXT');
  assert.equal(result.climate.state, 'READY');
  assert.equal(result.soil.state, 'READY');
  assert.equal(result.observations.state, 'READY');
  assert.equal(result.forecast.state, 'READY');
  assert.equal(result.forecast.result.noActiveRisksConfirmed, true);
  assert.equal(result.inputSummary.regionLabel, '경기도 수원시');
  assert.equal(result.growthScore.state, 'READY');
  assert.equal(result.growthScore.score, 95);
  assert.equal(result.growthScore.label, '양호');
  assert.equal(
    result.growthScore.calculation,
    'EVIDENCE_WEIGHTED_MEAN_WITH_GUARDRAILS',
  );
  assert.equal(result.growthScore.confidence.coverage, 1);
  assert.equal(result.growthScore.confidence.level, 'MEDIUM');
  assert.equal(result.growthScore.confidence.evidenceStrength >= 0.55, true);
  assert.deepEqual(result.growthScore.confidence.availableComponents, [
    'climate',
    'soil',
    'forecast',
  ]);
  assert.deepEqual(result.growthScore.confidence.missingComponents, []);
  assert.equal(result.growthScore.components.soil.trust, 0.25);
  assert.equal(Object.hasOwn(result, 'compositeScore'), false);
  assert.equal(JSON.stringify(result).match(/"penalty"/giu), null);
  assert.deepEqual(calls.soil[0], {
    verifiedSoilAreaCode: '4111710500',
    landUse: 'PFLD',
  });
  assert.equal(calls.climate[0].stationId, '119');
  assert.equal(calls.observations[0].completedDays, 7);
  assert.deepEqual(
    await services.getAnalysisContext({
      ownerSessionId: 'owner-a',
      analysisId: 'analysis-integration',
    }),
    {
      cropId: 'CUCUMBER',
      observationStationId: '119',
      normalStationId: '119',
    },
  );
  assert.equal(
    await services.getAnalysisContext({
      ownerSessionId: 'owner-b',
      analysisId: 'analysis-integration',
    }),
    null,
  );
  assert.equal(calls.short[0].nx > 0 && calls.short[0].ny > 0, true);
  assert.equal(calls.mid[0].temperatureRegId, '11B20601');
  assert.equal(calls.mid[0].landRegId, '11B00000');
  assert.equal(result.observations.evidence.length, 35);
  assert.equal(
    result.observations.evidence.every(
      (item) =>
        item.module === 'OBSERVATION' &&
        item.unit !== null &&
        item.sourceVersion === 'fixture-v1',
    ),
    true,
  );
  const normalEvidence = result.observations.evidence.find(
    ({ evidenceId }) =>
      evidenceId ===
      'OBSERVATION_119_2026-07-16_monthlyNormalDeviation',
  );
  assert.deepEqual(normalEvidence.calculation, {
    observedMeanTemperature: 22,
    normalMeanTemperature: 24,
    deviation: -2,
    comparisonBasis: 'MONTHLY_NORMAL_1991_2020',
  });
  assert.ok(
    result.forecast.evidence.some(
      (item) =>
        item.effect === 'NO_ACTIVE_RISK' &&
        item.inclusion === 'INCLUDED',
    ),
  );
  assert.equal(
    result.dataSources.every((source) => source.sourceUrl.startsWith('https://')),
    true,
  );
  assert.equal(
    result.dataSources.find(
      (source) => source.sourceId === 'kma-asos-observations',
    ).distanceKm,
    4.2,
  );
  const fieldTestAction = result.actions.find(
    ({ actionId }) => actionId === 'REQUEST_FIELD_SOIL_TEST',
  );
  assert.ok(fieldTestAction);
  assert.notEqual(fieldTestAction.evidenceStrength, 'UNCONFIRMED');
  assert.equal(fieldTestAction.sourceFreshness, 'CURRENT');

  await services.requestReport({
    ownerSessionId: 'owner-a',
    analysisId: result.analysisId,
  });
  await new Promise((resolve) => queueMicrotask(resolve));
  const reported = await services.getAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: result.analysisId,
  });
  assert.ok(reported.report.value.summary.factIds.length > 0);
  assert.ok(
    reported.report.value.nextActions.find(
      ({ actionIds }) =>
        actionIds.includes('REQUEST_FIELD_SOIL_TEST'),
    ).factIds.length > 0,
  );

  assert.equal(
    await services.getAnalysis({
      ownerSessionId: 'owner-b',
      analysisId: result.analysisId,
    }),
    null,
  );
  assert.equal(
    (
      await services.getAnalysis({
        ownerSessionId: 'owner-a',
        analysisId: result.analysisId,
      })
    ).analysisId,
    result.analysisId,
  );
});

test('active open-field heat plus a dry weather balance creates a conditional irrigation action', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const adapters = completeAdapters(calls);
  adapters.observations = {
    id: 'dry-observations-fixture',
    async getRecent(params) {
      calls.observations.push(params);
      return envelope({
        sourceId: 'kma-asos-observations',
        spatialLevel: 'OBSERVATION_STATION',
        observedAt: '2026-07-22T15:00:00.000Z',
        data: {
          stationId: '119',
          stationName: '수원',
          distanceKm: 4.2,
          readings: completeObservationReadings().map((reading) => ({
            ...reading,
            minTemperature: 24,
            meanTemperature: 29,
            maxTemperature: 35,
            precipitationAmount: 0,
          })),
          monthlyNormals: [{ stationId: '119', month: 7, meanTemperature: 24 }],
        },
      });
    },
  };
  adapters.kmaShort = {
    id: 'hot-short-fixture',
    async getForecast(params) {
      calls.short.push(params);
      return envelope({
        sourceId: 'kma-short-forecast',
        spatialLevel: 'FORECAST_GRID',
        issuedAt: '2026-07-23T02:00:00.000Z',
        validFrom: '2026-07-23T15:00:00.000Z',
        validTo: '2026-07-24T14:59:59.000Z',
        data: {
          days: [{
            ...forecastDay('2026-07-24', 'SHORT_GRID'),
            minTemperature: 25,
            maxTemperature: 36,
          }],
        },
      });
    },
  };
  const services = createApplicationServices({
    adapters,
    rules: reviewedRules(),
    verifiedLocationMappings: { '4111710500': verifiedMapping() },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const input = analysisInput(candidateToken);
  input.usageMode = 'ACTIVE_GROWING';
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-hot-dry-irrigation',
    input,
  });

  assert.equal(result.fieldConditionsEstimate.surfaceMoisture.trend, 'DRYING');
  assert.ok(result.fieldConditionsEstimate.surfaceMoisture.central <= 35);
  const irrigation = result.actions.find(
    ({ actionId }) => actionId === 'CHECK_SOIL_MOISTURE_AND_IRRIGATE',
  );
  assert.ok(irrigation);
  assert.equal(irrigation.title, '고온 전 토양 수분 확인·관수');
  assert.equal(irrigation.sourceFreshness, 'CURRENT');
  assert.equal(
    result.actions.some(
      ({ actionId }) => actionId === 'CHECK_CURRENT_FORECAST_RISK',
    ),
    false,
  );
});

test('UNKNOWN open-field analysis still calculates season-independent soil and forecast', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules: reviewedRules(),
    verifiedLocationMappings: {
      '4111710500': verifiedMapping(),
    },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const input = analysisInput(candidateToken);
  input.season = {
    kind: 'UNKNOWN',
    profileId: 'UNKNOWN',
    startMonth: null,
    endMonth: null,
    userConfirmed: true,
  };

  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-unknown-season',
    input,
  });

  assert.equal(result.climate.state, 'HOLD');
  assert.ok(result.climate.blockingReasons.includes('SEASON_UNKNOWN'));
  assert.equal(result.soil.state, 'READY');
  assert.deepEqual(result.soil.result.includedRuleIds, ['soil-ph']);
  assert.equal(result.forecast.state, 'READY');
  assert.equal(
    result.forecast.result.ruleEvaluations.some(
      ({ ruleId }) => ruleId === 'forecast-high-temperature',
    ),
    true,
  );
});

test('unconfigured scientific sources fail closed and deterministic reports do not invent facts', async () => {
  const services = createApplicationServices({
    adapters: { kakao: locationAdapter() },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-hold',
    input: analysisInput(candidateToken),
  });

  assert.equal(result.state, 'DATA_NEEDED');
  assert.equal(result.decision.code, 'DATA_NEEDED');
  assert.equal(result.climate.state, 'HOLD');
  assert.equal(result.soil.state, 'HOLD');
  assert.equal(result.forecast.state, 'HOLD');
  assert.equal(result.capabilities.smartfarm, 'DISABLED');
  assert.equal(result.capabilities.satellite, 'DISABLED');

  const pending = await services.requestReport({
    ownerSessionId: 'owner-a',
    analysisId: result.analysisId,
  });
  assert.equal(pending.analysis.report.state, 'PENDING');
  await new Promise((resolve) => queueMicrotask(resolve));
  const completed = await services.getAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: result.analysisId,
  });
  assert.equal(completed.report.state, 'FALLBACK');
  assert.equal(completed.report.value.policyVersion, 'report-template-v1');
  assert.equal(
    completed.report.value.summary.text,
    completed.decision.message,
  );
  assert.ok(Array.isArray(completed.report.value.strengths));
  assert.ok(Array.isArray(completed.report.value.risks));
  assert.ok(Array.isArray(completed.report.value.nextActions));
  assert.ok(Array.isArray(completed.report.value.limitations));
  assert.ok(
    completed.report.value.nextActions.every(
      (sentence) =>
        Array.isArray(sentence.factIds) &&
        Array.isArray(sentence.actionIds),
    ),
  );
  assert.equal(
    [
      completed.report.value.summary,
      ...completed.report.value.risks,
      ...completed.report.value.nextActions,
      ...completed.report.value.limitations,
    ].every(({ factIds }) => factIds.length === 0),
    true,
  );
  assert.equal(JSON.stringify(completed.report.value).includes('적합도'), false);
});

test('a successful observation envelope with no valid completed days cannot produce false-ready guidance', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const adapters = completeAdapters(calls);
  adapters.observations = {
    id: 'empty-observations-fixture',
    async getRecent() {
      return envelope({
        sourceId: 'kma-asos-observations',
        spatialLevel: 'OBSERVATION_STATION',
        observedAt: '2026-07-22T15:00:00.000Z',
        data: {
          stationId: '119',
          stationName: '수원',
          distanceKm: 4.2,
          readings: [],
          monthlyNormals: [],
        },
      });
    },
  };
  const services = createApplicationServices({
    adapters,
    rules: reviewedRules(),
    verifiedLocationMappings: {
      '4111710500': verifiedMapping(),
    },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-observation-hold',
    input: analysisInput(candidateToken),
  });

  assert.equal(result.observations.state, 'HOLD');
  assert.equal(result.observations.result.validDayCount, 0);
  assert.equal(result.observations.result.trendSummaryAvailable, false);
  assert.notEqual(result.state, 'COMPLETE');
  assert.notEqual(result.riskState, 'READY');
  assert.notEqual(result.decision.code, 'FIELD_TEST_NEXT');
});

test('facility no-risk state triggers resolve to current eligible evidence', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules: facilityForecastRules(),
    verifiedLocationMappings: {
      '4111710500': verifiedMapping(),
    },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-facility-no-risk',
    input: {
      usageMode: 'LAND_SEARCH',
      location: { candidateToken, userConfirmed: true },
      crop: 'CUCUMBER',
      cultivationMode: 'FACILITY_HYDRO',
    },
  });

  assert.equal(result.riskState, 'READY');
  assert.equal(result.decision.code, 'FACILITY_SENSOR_NEXT');
  const sensorAction = result.actions.find(
    ({ actionId }) => actionId === 'CHECK_INTERNAL_SENSORS',
  );
  assert.ok(sensorAction);
  assert.equal(sensorAction.evidenceStrength, 'RISK_ONLY');
  assert.equal(sensorAction.sourceFreshness, 'CURRENT');

  await services.requestReport({
    ownerSessionId: 'owner-a',
    analysisId: result.analysisId,
  });
  await new Promise((resolve) => queueMicrotask(resolve));
  const completed = await services.getAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: result.analysisId,
  });
  assert.ok(completed.report.value.summary.factIds.length > 0);
  assert.ok(
    completed.report.value.nextActions.find(
      ({ actionIds }) => actionIds.includes('CHECK_INTERNAL_SENSORS'),
    ).factIds.length > 0,
  );
});

test('facility keeps its sensor action when an unrelated mid-forecast field is partial', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const adapters = completeAdapters(calls);
  adapters.kmaMid.getForecast = async () =>
    envelope({
      sourceId: 'kma-mid-forecast',
      spatialLevel: 'FORECAST_REGION',
      issuedAt: '2026-07-23T02:00:00.000Z',
      validFrom: '2026-07-24T15:00:00.000Z',
      validTo: '2026-07-25T14:59:59.000Z',
      qualityFlags: ['VERIFIED_FIXTURE', 'PARTIAL_PROVIDER_FAILURE'],
      data: { days: [forecastDay('2026-07-25', 'MID_REGIONAL')] },
    });
  const services = createApplicationServices({
    adapters,
    rules: facilityForecastRules(),
    verifiedLocationMappings: {
      '4111710500': verifiedMapping(),
    },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-facility-partial-forecast',
    input: {
      usageMode: 'ACTIVE_GROWING',
      location: { candidateToken, userConfirmed: true },
      crop: 'CUCUMBER',
      cultivationMode: 'FACILITY_HYDRO',
      growthStage: 'UNSPECIFIED',
    },
  });

  assert.equal(result.forecast.state, 'PARTIAL');
  assert.equal(result.forecast.result.riskState, 'READY');
  assert.equal(result.decision.code, 'FACILITY_SENSOR_NEXT');
  assert.equal(
    result.actions.some(
      ({ actionId }) => actionId === 'CHECK_INTERNAL_SENSORS',
    ),
    true,
  );
});

test('report generation preserves an absolute expiry and can extend it only by the bounded lock window', async () => {
  let now = FIXED_TIME;
  const services = createApplicationServices({
    adapters: { kakao: locationAdapter() },
    clock: () => now,
    randomBytes: deterministicRandomBytes,
    analysisTtlMs: 1_000,
    reportLockTtlMs: 15_000,
  });
  const candidateToken = await confirmedCandidate(services);
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-expiry',
    input: analysisInput(candidateToken),
  });

  now += 900;
  await services.requestReport({
    ownerSessionId: 'owner-a',
    analysisId: result.analysisId,
  });
  await new Promise((resolve) => queueMicrotask(resolve));

  now += 14_999;
  assert.ok(
    await services.getAnalysis({
      ownerSessionId: 'owner-a',
      analysisId: result.analysisId,
    }),
  );
  now += 1;
  assert.equal(
    await services.getAnalysis({
      ownerSessionId: 'owner-a',
      analysisId: result.analysisId,
    }),
    null,
  );
});

test('application stores reject saturation without evicting active candidates or analyses', async () => {
  assert.equal(applicationDefaults.storeCapacityPolicy, 'reject');
  let sequence = 0;
  const uniqueRandomBytes = (size) => {
    const value = Buffer.alloc(size, 0);
    value.writeUInt32BE(++sequence, size - 4);
    return value;
  };
  const candidateStore = new TtlMemoryStore({
    capacityPolicy: applicationDefaults.storeCapacityPolicy,
    clock: () => FIXED_TIME,
    maxEntries: 1,
  });
  const analysisStore = new TtlMemoryStore({
    capacityPolicy: applicationDefaults.storeCapacityPolicy,
    clock: () => FIXED_TIME,
    maxEntries: 1,
  });
  const services = createApplicationServices({
    adapters: { kakao: locationAdapter() },
    candidateStore,
    analysisStore,
    clock: () => FIXED_TIME,
    randomBytes: uniqueRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  await assert.rejects(
    () =>
      services.searchLocations({
        ownerSessionId: 'owner-b',
        query: '두 번째 후보',
      }),
    StoreCapacityError,
  );

  const first = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-preserved',
    input: analysisInput(candidateToken),
  });
  await assert.rejects(
    () =>
      services.createAnalysis({
        ownerSessionId: 'owner-a',
        analysisId: 'analysis-rejected',
        input: analysisInput(candidateToken),
      }),
    StoreCapacityError,
  );
  assert.equal(
    (
      await services.getAnalysis({
        ownerSessionId: 'owner-a',
        analysisId: first.analysisId,
      })
    ).analysisId,
    first.analysisId,
  );
});

test('location candidate batches roll back tokens inserted before capacity rejection', async () => {
  let sequence = 0;
  const issuedTokens = [];
  const uniqueRandomBytes = (size) => {
    const value = Buffer.alloc(size, 0);
    value.writeUInt32BE(++sequence, size - 4);
    issuedTokens.push(value.toString('base64url'));
    return value;
  };
  const candidateStore = new TtlMemoryStore({
    capacityPolicy: 'reject',
    clock: () => FIXED_TIME,
    maxEntries: 2,
  });
  candidateStore.set(
    'existing-token',
    {
      ownerSessionId: 'existing-owner',
      resolvedLocation: { displayName: '기존 후보' },
    },
    60_000,
  );
  const services = createApplicationServices({
    adapters: {
      kakao: {
        id: 'multi-location-fixture',
        async searchLocations() {
          return envelope({
            sourceId: 'kakao-location',
            spatialLevel: 'FIELD',
            data: {
              candidates: [
                {
                  displayName: '첫 번째 신규 후보',
                  resolutionMode: 'ADDRESS_RESOLVED',
                  latitude: 37.25,
                  longitude: 127.05,
                  legalDongCode10: '4111710500',
                  adminAreaCode: '4111710500',
                },
                {
                  displayName: '두 번째 신규 후보',
                  resolutionMode: 'ADDRESS_RESOLVED',
                  latitude: 37.26,
                  longitude: 127.06,
                  legalDongCode10: '4111710500',
                  adminAreaCode: '4111710500',
                },
              ],
            },
          });
        },
      },
    },
    candidateStore,
    clock: () => FIXED_TIME,
    randomBytes: uniqueRandomBytes,
  });

  await assert.rejects(
    () =>
      services.searchLocations({
        ownerSessionId: 'new-owner',
        query: '복수 후보',
      }),
    StoreCapacityError,
  );

  assert.equal(candidateStore.size, 1);
  assert.equal(
    candidateStore.get('existing-token').ownerSessionId,
    'existing-owner',
  );
  assert.equal(issuedTokens.length, 2);
  assert.equal(
    issuedTokens.every((candidateToken) => !candidateStore.has(candidateToken)),
    true,
  );
});

test('successful analysis and report record the specified lifecycle transitions', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules: reviewedRules(),
    verifiedLocationMappings: {
      '4111710500': verifiedMapping(),
    },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const created = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-lifecycle',
    input: analysisInput(candidateToken),
  });
  assert.equal(created.lifecycle.currentState, 'CORE_READY');
  assert.deepEqual(
    created.lifecycle.transitions.map(({ state }) => state),
    [
      'RECEIVED',
      'VALIDATING',
      'RESOLVING_LOCATION',
      'FETCHING_MODULES',
      'CALCULATING',
      'CORE_READY',
    ],
  );

  const pending = await services.requestReport({
    ownerSessionId: 'owner-a',
    analysisId: created.analysisId,
  });
  assert.equal(pending.analysis.lifecycle.currentState, 'REPORT_PENDING');
  await new Promise((resolve) => queueMicrotask(resolve));
  const completed = await services.getAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: created.analysisId,
  });
  assert.equal(completed.lifecycle.currentState, 'COMPLETE');
  assert.deepEqual(
    completed.lifecycle.transitions.map(({ state }) => state).slice(-2),
    ['REPORT_PENDING', 'COMPLETE'],
  );
});

test('broad administrative candidates use only a labeled regional forecast grid and never select an observation station', async () => {
  let shortCalls = 0;
  let observationCalls = 0;
  const services = createApplicationServices({
    adapters: {
      kakao: locationAdapter({
        resolutionMode: 'ADMIN_AREA_BROAD',
        latitude: 37.25,
        longitude: 127.05,
      }),
      kmaShort: {
        id: 'short-fixture',
        async getForecast(params) {
          shortCalls += 1;
          assert.deepEqual(params, {
            nx: 61,
            ny: 121,
            baseDate: '20260723',
            baseTime: '1100',
          });
          return envelope({
            sourceId: 'kma-short-forecast',
            spatialLevel: 'FORECAST_GRID',
            issuedAt: '2026-07-23T02:00:00.000Z',
            validFrom: '2026-07-23T15:00:00.000Z',
            validTo: '2026-07-24T14:59:59.000Z',
            data: { days: [forecastDay('2026-07-24', 'SHORT_GRID')] },
          });
        },
      },
      observations: {
        id: 'observations-fixture',
        async getRecent() {
          observationCalls += 1;
          throw new Error('broad regions must not select a station');
        },
      },
    },
    verifiedLocationMappings: {
      '4111710500': verifiedMapping({
        soil: undefined,
        midForecast: undefined,
        normalStation: undefined,
        observationStation: {
          verified: true,
          id: '119',
          distanceKm: 4.2,
          operationalVerified: true,
          periodDataVerified: true,
        },
      }),
    },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-broad',
    input: analysisInput(candidateToken),
  });

  assert.equal(shortCalls, 1);
  assert.equal(observationCalls, 0);
  assert.equal(result.inputSummary.locationPrecision, 'ADMIN_AREA_BROAD');
  const shortSource = result.dataSources.find(
    ({ sourceId }) => sourceId === 'kma-short-forecast',
  );
  assert.equal(shortSource.spatialLabel, '시·군 대표 예보 격자');
  assert.ok(shortSource.qualityFlags.includes('ADMIN_AREA_REPRESENTATIVE'));
  assert.equal(
    result.analysisScope.summary.commonNotice.code,
    'ADMIN_AREA_REFERENCE_ONLY',
  );
  const observationScope = result.analysisScope.groups
    .flatMap(({ items }) => items)
    .find(({ itemId }) => itemId === 'RECENT_OBSERVATION');
  assert.equal(observationScope.state, 'MISSING');
  assert.equal(observationScope.distanceKm, null);
  assert.equal(observationScope.source.distanceKm, null);
  assert.equal(result.state, 'DATA_NEEDED');
});

test('preflight is HOLD until rules, mappings, and every P0 adapter are actually configured', async () => {
  const unconfigured = createApplicationServices({
    adapters: { kakao: locationAdapter() },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const held = await unconfigured.getPreflight();
  assert.equal(held.ready, false);
  assert.equal(held.serviceState, 'HOLD');
  assert.equal(held.ruleRegistry.status, 'HOLD');
  assert.equal(held.locationMappings.status, 'HOLD');
  assert.equal(held.adapters.climate, 'UNSUPPORTED');
  assert.ok(held.blockers.includes('VERIFIED_RULES_NOT_CONFIGURED'));
  assert.equal(JSON.stringify(held).includes('secret'), false);

  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const mapping = {
    ...verifiedMapping(),
  };
  const configured = createApplicationServices({
    adapters: completeAdapters(calls),
    rules: fullyCompatibleRulesForAllContexts(),
    verifiedLocationMappings: sixVerifiedMappings(() =>
      structuredClone(mapping),
    ),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
    runtimeStatus: readyRuntimeStatus(),
  });
  const ready = await configured.getPreflight();
  assert.equal(ready.ready, true);
  assert.equal(ready.serviceState, 'READY');
  assert.equal(ready.deploymentReady, false);
  assert.equal(ready.deploymentState, 'HOLD');
  assert.deepEqual(ready.deploymentBlockers, [
    'SHARED_STATE_NOT_CONFIGURED',
  ]);
  assert.equal(ready.locationMappings.verifiedCount, 6);
  assert.equal(ready.locationMappings.p0ReadyCount, 6);
  assert.equal(ready.ruleRegistry.completeCropCount, 5);
  assert.equal(
    ready.guarantees.growthScoreCalculation,
    'EVIDENCE_WEIGHTED_MEAN_WITH_GUARDRAILS',
  );
  assert.equal(ready.guarantees.growthScoreConfidenceSeparated, true);
  assert.equal(ready.guarantees.growthScoreMinimumEvidenceStrength, 0.35);
  assert.equal(ready.guarantees.regionalSoilMaximumEffectiveShare, 0.12);
  assert.equal(ready.guarantees.fieldSoilContinuousGuardrail, true);
  assert.equal(ready.guarantees.hydroponicRequiresIndoorEnvironment, true);
  assert.equal(ready.guarantees.missingValuesBecomeZero, false);
  assert.equal(ready.guarantees.regionalSoilCreatesScoreCap, false);
  assert.equal(
    Object.hasOwn(ready.guarantees, 'singleCompositeScore'),
    false,
  );
  assert.deepEqual(ready.ruleRegistry.configuredCrops, [
    'APPLE',
    'PEAR',
    'CUCUMBER',
    'POTATO',
    'LETTUCE',
  ]);
  assert.deepEqual(
    ready.ruleRegistry.cropCoverage.find(({ crop }) => crop === 'APPLE'),
    {
      crop: 'APPLE',
      requiredCultivationModes: ['OPEN_FIELD'],
      configuredCultivationModes: ['OPEN_FIELD'],
      missingCultivationModes: [],
      status: 'CONFIGURED',
    },
  );
  assert.deepEqual(
    ready.ruleRegistry.contextCoverage.find(
      ({ crop, cultivationMode }) =>
        crop === 'APPLE' && cultivationMode === 'OPEN_FIELD',
    ),
    {
      contextId:
        'APPLE|OPEN_FIELD|VERIFIED_PROFILE|APPLE_OPEN_FIELD_ANNUAL|UNSPECIFIED',
      crop: 'APPLE',
      cultivationMode: 'OPEN_FIELD',
      seasonKind: 'VERIFIED_PROFILE',
      seasonProfileId: 'APPLE_OPEN_FIELD_ANNUAL',
      reviewedProfileCount: 0,
      growthStage: 'UNSPECIFIED',
      requiredModules: ['CLIMATE', 'SOIL', 'FORECAST'],
      expectedHoldModules: [],
      modules: {
        CLIMATE: { decisionRuleCount: 1, status: 'CONFIGURED' },
        SOIL: { decisionRuleCount: 1, status: 'CONFIGURED' },
        FORECAST: { decisionRuleCount: 1, status: 'CONFIGURED' },
      },
      missingModules: [],
      unexpectedActiveModules: [],
      monthCoverage: null,
      missingMonths: [],
      seasonKinds: ['VERIFIED_PROFILE'],
      missingSeasonKinds: [],
      missingReasons: [],
      requestValidation: 'VALID',
      requestErrorCode: null,
      status: 'CONFIGURED',
    },
  );
  assert.equal(
    Object.values(ready.adapters).every((state) => state === 'READY'),
    true,
  );

  let probeCalls = 0;
  const storageVerified = createApplicationServices({
    adapters: completeAdapters(calls),
    rules: fullyCompatibleRulesForAllContexts(),
    verifiedLocationMappings: sixVerifiedMappings(() =>
      structuredClone(mapping),
    ),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
    runtimeStatus: readyRuntimeStatus(),
    capabilities: { persistence: 'CONFIGURED_UNVERIFIED' },
    async sharedStateProbe() {
      probeCalls += 1;
      return {
        ready: true,
        state: 'READY',
        verifiedAt: new Date(FIXED_TIME).toISOString(),
      };
    },
  });
  const deploymentReady = await storageVerified.getPreflight();
  assert.equal(probeCalls, 1);
  assert.equal(deploymentReady.deploymentReady, true);
  assert.equal(deploymentReady.deploymentState, 'READY');
  assert.deepEqual(deploymentReady.deploymentBlockers, []);
  assert.deepEqual(deploymentReady.storage, {
    state: 'READY',
    verifiedAt: new Date(FIXED_TIME).toISOString(),
    probe: 'ATOMIC_WRITE_READ_DELETE',
  });
});

test('preflight requires declared runtime readiness and each adapter method contract', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const common = {
    rules: reviewedRules(),
    verifiedLocationMappings: sixVerifiedMappings(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  };
  const undeclared = createApplicationServices({
    ...common,
    adapters: completeAdapters(calls),
  });
  const undeclaredState = await undeclared.getPreflight();
  assert.equal(undeclaredState.ready, false);
  assert.equal(undeclaredState.adapters.climate, 'UNVERIFIED');

  const invalidAdapters = completeAdapters(calls);
  invalidAdapters.climate = {};
  const invalidContract = createApplicationServices({
    ...common,
    adapters: invalidAdapters,
    runtimeStatus: readyRuntimeStatus(),
  });
  const invalidState = await invalidContract.getPreflight();
  assert.equal(invalidState.ready, false);
  assert.equal(invalidState.adapters.climate, 'INVALID_CONTRACT');
  assert.ok(
    invalidState.blockers.includes('ADAPTER_climate:INVALID_CONTRACT'),
  );
});

test('preflight explains executable coverage for all five crops and allowed cultivation modes', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules: fullyCompatibleRulesForAllContexts(),
    verifiedLocationMappings: sixVerifiedMappings(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
    runtimeStatus: readyRuntimeStatus(),
  });

  const preflight = await services.getPreflight();
  assert.equal(preflight.ready, true);
  assert.deepEqual(preflight.ruleRegistry.configuredCrops, [
    'APPLE',
    'PEAR',
    'CUCUMBER',
    'POTATO',
    'LETTUCE',
  ]);
  assert.equal(preflight.ruleRegistry.completeCropCount, 5);
  assert.equal(preflight.ruleRegistry.contextCoverage.length, 20);
  assert.equal(
    preflight.ruleRegistry.contextCoverage.every(
      ({ requestValidation, status }) =>
        requestValidation === 'VALID' &&
        ['CONFIGURED', 'EXPECTED_PARTIAL'].includes(status),
    ),
    true,
  );

  const facilitySoil = preflight.ruleRegistry.contextCoverage.find(
    ({ crop, cultivationMode }) =>
      crop === 'CUCUMBER' && cultivationMode === 'FACILITY_SOIL',
  );
  assert.equal(facilitySoil.seasonKind, 'NOT_APPLICABLE');
  assert.deepEqual(facilitySoil.requiredModules, ['SOIL', 'FORECAST']);
  const facilityHydro = preflight.ruleRegistry.contextCoverage.find(
    ({ crop, cultivationMode }) =>
      crop === 'LETTUCE' && cultivationMode === 'FACILITY_HYDRO',
  );
  assert.equal(facilityHydro.seasonProfileId, 'NOT_APPLICABLE');
  assert.deepEqual(facilityHydro.requiredModules, ['FORECAST']);
});

test('preflight recognizes a reviewed potato context without lowering the five-crop gate', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules: compatibleOpenFieldRules({
      crop: 'POTATO',
      seasonProfileId: 'POTATO_REVIEWED_PROFILE',
    }),
    verifiedLocationMappings: sixVerifiedMappings(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
    runtimeStatus: readyRuntimeStatus(),
  });

  const preflight = await services.getPreflight();
  assert.equal(preflight.ready, false);
  assert.deepEqual(preflight.ruleRegistry.configuredCrops, []);
  assert.equal(preflight.ruleRegistry.status, 'HOLD');
  const context = preflight.ruleRegistry.contextCoverage.find(
    ({ crop, cultivationMode, seasonKind }) =>
      crop === 'POTATO' &&
      cultivationMode === 'OPEN_FIELD' &&
      seasonKind === 'VERIFIED_PROFILE',
  );
  assert.equal(context.requestValidation, 'VALID');
  assert.equal(context.seasonKind, 'VERIFIED_PROFILE');
  assert.equal(context.seasonProfileId, 'POTATO_REVIEWED_PROFILE');
  assert.equal(context.reviewedProfileCount, 1);
  assert.equal(context.status, 'CONFIGURED');
});

test('preflight summarizes reviewed profiles at a fixed context cardinality without rule metadata', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const [, soil, forecast] = compatibleOpenFieldRules({
    crop: 'POTATO',
    seasonProfileId: 'POTATO_PROFILE_1',
  });
  const climateRules = Array.from({ length: 8 }, (_, index) => ({
    ...compatibleOpenFieldRules({
      crop: 'POTATO',
      seasonProfileId: `POTATO_PROFILE_${index + 1}`,
    })[0],
    ruleId: `potato-reviewed-climate-${index + 1}`,
  }));
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules: [...climateRules, soil, forecast],
    verifiedLocationMappings: sixVerifiedMappings(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
    runtimeStatus: readyRuntimeStatus(),
  });

  const coverage = (await services.getPreflight()).ruleRegistry.contextCoverage;
  const reviewedContexts = coverage.filter(
    ({ crop, cultivationMode, seasonKind }) =>
      crop === 'POTATO' &&
      cultivationMode === 'OPEN_FIELD' &&
      seasonKind === 'VERIFIED_PROFILE',
  );
  assert.equal(reviewedContexts.length, 1);
  assert.equal(reviewedContexts[0].reviewedProfileCount, 8);
  assert.equal(
    reviewedContexts[0].seasonProfileId,
    'MULTIPLE_REVIEWED_PROFILES',
  );
  assert.equal(reviewedContexts[0].status, 'CONFIGURED');
  assert.equal(
    /ruleId|sourceUrl|example\.test/u.test(
      JSON.stringify(reviewedContexts[0]),
    ),
    false,
  );
});

test('preflight checks every single-month CUSTOM open-field context', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules: compatibleOpenFieldRules({
      crop: 'POTATO',
      seasonProfileId: 'CUSTOM',
    }),
    verifiedLocationMappings: sixVerifiedMappings(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
    runtimeStatus: readyRuntimeStatus(),
  });

  const preflight = await services.getPreflight();
  assert.equal(preflight.ready, false);
  const custom = preflight.ruleRegistry.contextCoverage.find(
    ({ crop, cultivationMode, seasonKind }) =>
      crop === 'POTATO' &&
      cultivationMode === 'OPEN_FIELD' &&
      seasonKind === 'CUSTOM',
  );
  assert.equal(custom.status, 'HOLD');
  assert.deepEqual(custom.monthCoverage, {
    requiredMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    coveredMonths: [5],
    missingMonths: [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12],
  });
  assert.deepEqual(custom.missingMonths, [
    1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12,
  ]);
  assert.deepEqual(custom.missingSeasonKinds, ['CUSTOM']);
  assert.equal(custom.modules.CLIMATE.status, 'HOLD');
  assert.equal(custom.modules.SOIL.status, 'CONFIGURED');
  assert.equal(custom.modules.FORECAST.status, 'CONFIGURED');
});

test('open-field UNKNOWN keeps climate HOLD while soil and forecast remain supported', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules: compatibleOpenFieldRules({
      crop: 'POTATO',
      seasonProfileId: 'CUSTOM',
    }),
    verifiedLocationMappings: sixVerifiedMappings(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
    runtimeStatus: readyRuntimeStatus(),
  });

  const context = (await services.getPreflight()).ruleRegistry.contextCoverage.find(
    ({ crop, cultivationMode, seasonKind }) =>
      crop === 'POTATO' &&
      cultivationMode === 'OPEN_FIELD' &&
      seasonKind === 'UNKNOWN',
  );
  assert.equal(context.requestValidation, 'VALID');
  assert.equal(context.status, 'EXPECTED_PARTIAL');
  assert.deepEqual(context.requiredModules, ['SOIL', 'FORECAST']);
  assert.deepEqual(context.expectedHoldModules, ['CLIMATE']);
  assert.deepEqual(context.missingModules, []);
  assert.deepEqual(context.missingSeasonKinds, []);
  assert.equal(context.modules.CLIMATE.status, 'HOLD');
  assert.equal(context.modules.SOIL.status, 'CONFIGURED');
  assert.equal(context.modules.FORECAST.status, 'CONFIGURED');
});

test('facility season kinds resolve the same applicable soil and forecast support', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const rules = fullyCompatibleRulesForAllContexts().filter(
    ({ crop, cultivationMode }) =>
      crop === 'CUCUMBER' &&
      ['FACILITY_SOIL', 'FACILITY_HYDRO'].includes(cultivationMode),
  );
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules,
    verifiedLocationMappings: sixVerifiedMappings(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
    runtimeStatus: readyRuntimeStatus(),
  });

  const coverage = (await services.getPreflight()).ruleRegistry.contextCoverage;
  const facilitySoil = coverage.filter(
    ({ crop, cultivationMode }) =>
      crop === 'CUCUMBER' && cultivationMode === 'FACILITY_SOIL',
  );
  assert.deepEqual(
    facilitySoil.map(({ seasonKind }) => seasonKind),
    ['NOT_APPLICABLE', 'CUSTOM', 'UNKNOWN'],
  );
  assert.equal(
    facilitySoil.every(
      ({ requiredModules, missingModules, status }) =>
        requiredModules.join(',') === 'SOIL,FORECAST' &&
        missingModules.length === 0 &&
        status === 'CONFIGURED',
    ),
    true,
  );

  const facilityHydro = coverage.filter(
    ({ crop, cultivationMode }) =>
      crop === 'CUCUMBER' && cultivationMode === 'FACILITY_HYDRO',
  );
  assert.deepEqual(
    facilityHydro.map(({ seasonKind }) => seasonKind),
    ['NOT_APPLICABLE', 'CUSTOM', 'UNKNOWN'],
  );
  assert.equal(
    facilityHydro.every(
      ({ requiredModules, missingModules, status }) =>
        requiredModules.join(',') === 'FORECAST' &&
        missingModules.length === 0 &&
        status === 'CONFIGURED',
    ),
    true,
  );
});

test('preflight does not promote UNKNOWN open-field partial support to full coverage', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules: compatibleOpenFieldRules({
      crop: 'POTATO',
      seasonProfileId: 'UNKNOWN',
    }),
    verifiedLocationMappings: sixVerifiedMappings(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
    runtimeStatus: readyRuntimeStatus(),
  });

  const preflight = await services.getPreflight();
  assert.equal(preflight.ready, false);
  const context = preflight.ruleRegistry.contextCoverage.find(
    ({ crop, cultivationMode, seasonKind }) =>
      crop === 'POTATO' &&
      cultivationMode === 'OPEN_FIELD' &&
      seasonKind === 'UNKNOWN',
  );
  assert.equal(context.requestValidation, 'VALID');
  assert.equal(context.seasonKind, 'UNKNOWN');
  assert.deepEqual(context.missingModules, []);
  assert.equal(context.modules.CLIMATE.status, 'HOLD');
  assert.equal(context.modules.SOIL.status, 'CONFIGURED');
  assert.equal(context.modules.FORECAST.status, 'CONFIGURED');
  assert.equal(context.status, 'EXPECTED_PARTIAL');
});

test('display-only unconfirmed rules cannot satisfy the readiness crop gate', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const sourceRule = reviewedRules()[0];
  const displayOnlyRule = {
    ...sourceRule,
    use: 'DISPLAY_ONLY',
    evidenceStatus: 'UNCONFIRMED',
  };
  for (const field of [
    'optimalRange',
    'toleranceRange',
    'sensitivityTier',
    'critical',
  ]) {
    delete displayOnlyRule[field];
  }
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules: [displayOnlyRule],
    verifiedLocationMappings: sixVerifiedMappings(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
    runtimeStatus: readyRuntimeStatus(),
  });

  const preflight = await services.getPreflight();
  assert.equal(preflight.ready, false);
  assert.equal(preflight.ruleRegistry.activeRuleCount, 1);
  assert.equal(preflight.ruleRegistry.decisionRuleCount, 0);
  assert.deepEqual(preflight.ruleRegistry.registeredCrops, ['CUCUMBER']);
  assert.deepEqual(preflight.ruleRegistry.configuredCrops, []);
  assert.equal(preflight.ruleRegistry.status, 'HOLD');
  assert.ok(preflight.blockers.includes('VERIFIED_RULES_NOT_CONFIGURED'));
});

test('five forecast-only crops cannot satisfy per-crop P0 rule coverage', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules: forecastOnlyRulesForFiveCrops(),
    verifiedLocationMappings: sixVerifiedMappings(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
    runtimeStatus: readyRuntimeStatus(),
  });

  const preflight = await services.getPreflight();
  assert.equal(preflight.ready, false);
  assert.equal(preflight.ruleRegistry.decisionRuleCount, 5);
  assert.equal(preflight.ruleRegistry.completeCropCount, 0);
  assert.deepEqual(preflight.ruleRegistry.configuredCrops, []);
  assert.equal(preflight.ruleRegistry.cropCoverage.length, 5);
  assert.equal(
    preflight.ruleRegistry.cropCoverage.every(({ status }) => status === 'HOLD'),
    true,
  );
  assert.ok(
    preflight.ruleRegistry.contextCoverage.some(
      ({ cultivationMode, missingModules, status }) =>
        cultivationMode === 'OPEN_FIELD' &&
        status === 'HOLD' &&
        missingModules.join(',') === 'CLIMATE,SOIL',
    ),
  );
  assert.ok(
    preflight.blockers.includes('VERIFIED_RULE_COVERAGE_INSUFFICIENT'),
  );
});

test('preflight revalidates mapping validity against the current clock', async () => {
  let now = FIXED_TIME;
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const mappings = sixVerifiedMappings(() =>
    verifiedMapping({
      provenance: {
        ...MAPPING_PROVENANCE,
        validTo: '2026-07-23',
      },
    }),
  );
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules: fullyCompatibleRulesForAllContexts(),
    verifiedLocationMappings: mappings,
    runtimeStatus: readyRuntimeStatus(),
    clock: () => now,
    randomBytes: deterministicRandomBytes,
  });

  assert.equal((await services.getPreflight()).ready, true);
  now += 24 * 60 * 60 * 1000;
  const expired = await services.getPreflight();
  assert.equal(expired.ready, false);
  assert.equal(expired.locationMappings.valid, false);
  assert.equal(expired.locationMappings.p0ReadyCount, 0);
  assert.equal(expired.locationMappings.status, 'HOLD');
  assert.ok(
    expired.blockers.includes('VERIFIED_LOCATION_MAPPINGS_INVALID'),
  );
});

test('preflight rejects crop modules split across incompatible season profiles', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const rules = compatibleOpenFieldRules();
  rules[0] = {
    ...rules[0],
    seasonProfileId: 'APPLE_PROFILE_A',
  };
  rules.push({
    ...rules[0],
    ruleId: 'apple-second-climate-profile',
    seasonProfileId: 'APPLE_PROFILE_B',
  });
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules,
    verifiedLocationMappings: sixVerifiedMappings(),
    runtimeStatus: readyRuntimeStatus(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });

  const preflight = await services.getPreflight();
  assert.equal(preflight.ready, false);
  const context = preflight.ruleRegistry.contextCoverage.find(
    ({ crop, cultivationMode }) =>
      crop === 'APPLE' && cultivationMode === 'OPEN_FIELD',
  );
  assert.equal(context.requestValidation, 'INVALID');
  assert.equal(context.requestErrorCode, 'UNVERIFIED_SEASON_PROFILE');
  assert.ok(
    context.missingReasons.includes(
      'REVIEWED_ANNUAL_PROFILE_COUNT_NOT_ONE:2',
    ),
  );
});

test('preflight rejects crop modules split across cultivation modes', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const rules = compatibleCustomOpenFieldRules('CUCUMBER');
  const soilRuleIndex = rules.findIndex(({ module }) => module === 'SOIL');
  rules[soilRuleIndex] = {
    ...rules[soilRuleIndex],
    cultivationMode: 'FACILITY_SOIL',
    seasonProfileId: 'NOT_APPLICABLE',
  };
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules,
    verifiedLocationMappings: sixVerifiedMappings(),
    runtimeStatus: readyRuntimeStatus(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });

  const preflight = await services.getPreflight();
  assert.equal(preflight.ready, false);
  const openField = preflight.ruleRegistry.contextCoverage.find(
    ({ crop, cultivationMode }) =>
      crop === 'CUCUMBER' && cultivationMode === 'OPEN_FIELD',
  );
  assert.deepEqual(openField.missingModules, ['SOIL']);
  assert.ok(
    openField.missingReasons.includes('NO_ACTIVE_DECISION_RULE:SOIL'),
  );
  assert.ok(
    preflight.ruleRegistry.cropCoverage
      .find(({ crop }) => crop === 'CUCUMBER')
      .missingCultivationModes.includes('OPEN_FIELD'),
  );
});

test('preflight rejects decision rules that do not activate at the baseline stage', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const rules = compatibleOpenFieldRules();
  rules[1] = {
    ...rules[1],
    stage: 'BLOOM',
  };
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules,
    verifiedLocationMappings: sixVerifiedMappings(),
    runtimeStatus: readyRuntimeStatus(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });

  const preflight = await services.getPreflight();
  assert.equal(preflight.ready, false);
  const context = preflight.ruleRegistry.contextCoverage.find(
    ({ crop, cultivationMode }) =>
      crop === 'APPLE' && cultivationMode === 'OPEN_FIELD',
  );
  assert.equal(context.growthStage, 'UNSPECIFIED');
  assert.deepEqual(context.missingModules, ['SOIL']);
  assert.ok(
    context.missingReasons.includes('NO_ACTIVE_DECISION_RULE:SOIL'),
  );
});

test('forecast rules scoped to UNSPECIFIED cannot satisfy preflight baseline coverage', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const rules = fullyCompatibleRulesForAllContexts().map((rule) =>
    rule.module === 'FORECAST'
      ? {
          ...rule,
          stage: 'UNSPECIFIED',
        }
      : rule,
  );
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules,
    verifiedLocationMappings: sixVerifiedMappings(),
    runtimeStatus: readyRuntimeStatus(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });

  const preflight = await services.getPreflight();
  assert.equal(preflight.ready, false);
  assert.equal(preflight.ruleRegistry.completeCropCount, 0);
  const context = preflight.ruleRegistry.contextCoverage.find(
    ({ crop, cultivationMode, seasonKind }) =>
      crop === 'APPLE' &&
      cultivationMode === 'OPEN_FIELD' &&
      seasonKind === 'VERIFIED_PROFILE',
  );
  assert.equal(context.modules.FORECAST.status, 'HOLD');
  assert.ok(context.missingModules.includes('FORECAST'));
  assert.ok(
    context.missingReasons.includes('NO_ACTIVE_DECISION_RULE:FORECAST'),
  );
});

test('six partial mappings cannot satisfy the six-region P0 readiness gate', async () => {
  const partialMappings = sixVerifiedMappings((index) => {
    const missing = [
      'soil',
      'midForecast',
      'normalStation',
      'observationStation',
    ][index % 4];
    return verifiedMapping({ [missing]: undefined });
  });
  const validation = validateVerifiedLocationMappings(partialMappings, {
    now: () => new Date(FIXED_TIME),
  });
  assert.equal(validation.valid, true);
  assert.equal(validation.verifiedCount, 6);
  assert.equal(validation.p0ReadyCount, 0);

  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const services = createApplicationServices({
    adapters: completeAdapters(calls),
    rules: reviewedRules(),
    verifiedLocationMappings: partialMappings,
    runtimeStatus: readyRuntimeStatus(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const preflight = await services.getPreflight();
  assert.equal(preflight.ready, false);
  assert.equal(preflight.locationMappings.verifiedCount, 6);
  assert.equal(preflight.locationMappings.p0ReadyCount, 0);
  assert.equal(preflight.locationMappings.status, 'HOLD');
});

test('location mapping activation requires provenance, validity, and verified station contracts', () => {
  assert.throws(
    () =>
      createApplicationServices({
        verifiedLocationMappings: {
          '4111710500': {
            observationStation: {
              verified: true,
              id: '119',
              distanceKm: 0,
            },
          },
        },
        clock: () => FIXED_TIME,
      }),
    /provenance is required/,
  );

  assert.throws(
    () =>
      createApplicationServices({
        verifiedLocationMappings: {
          '4111710500': verifiedMapping({
            provenance: {
              ...MAPPING_PROVENANCE,
              validTo: '2026-06-30',
            },
          }),
        },
        clock: () => FIXED_TIME,
      }),
    /outside its verified validity range/,
  );

  assert.throws(
    () =>
      createApplicationServices({
        verifiedLocationMappings: {
          '4111710500': verifiedMapping({
            observationStation: {
              verified: true,
              id: '119',
              distanceKm: 4.2,
              operationalVerified: false,
              periodDataVerified: true,
            },
          }),
        },
        clock: () => FIXED_TIME,
      }),
    /requires verified coordinates or a verified legacy distance/,
  );
});

test('normalization is exposed, side-effect free, and shared with analysis defaults', () => {
  const services = createApplicationServices({
    rules: reviewedRules(),
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const loose = {
    usageMode: ' land_search ',
    location: { candidateToken: '  candidate-token  ', userConfirmed: true },
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
  const before = structuredClone(loose);
  const canonical = {
    ...analysisInput('candidate-token'),
    options: {},
  };

  assert.equal(typeof services.normalizeAnalysisInput, 'function');
  assert.deepEqual(
    services.normalizeAnalysisInput(loose),
    services.normalizeAnalysisInput(canonical),
  );
  assert.deepEqual(loose, before);
  assert.deepEqual(services.normalizeAnalysisInput(loose).options, {
    includeSmartfarmBenchmark: false,
    includeSatelliteObservation: false,
    saveConsent: false,
  });
});

test('malformed adapter returns are isolated as unavailable source envelopes', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const adapters = completeAdapters(calls);
  adapters.climate.getNormals = async () => undefined;
  adapters.soilV2.getDistribution = async () => ({});
  const services = createApplicationServices({
    adapters,
    rules: reviewedRules(),
    verifiedLocationMappings: {
      '4111710500': verifiedMapping(),
    },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-malformed-envelope',
    input: analysisInput(candidateToken),
  });

  assert.equal(result.climate.state, 'HOLD');
  assert.equal(result.soil.state, 'HOLD');
  assert.ok(
    result.dataSources.some(
      (source) =>
        source.sourceId === 'kma-climate-normal' &&
        source.adapterState === 'INTERNAL_ERROR' &&
        source.qualityFlags.includes('ADAPTER_RETURNED_NO_ENVELOPE'),
    ),
  );
  assert.ok(
    result.dataSources.some(
      (source) =>
        source.sourceId === 'soil-v2' &&
        source.adapterState === 'SCHEMA_CHANGED' &&
        source.qualityFlags.includes('ADAPTER_ENVELOPE_SCHEMA_CHANGED'),
    ),
  );
});

test('malformed location adapter returns are contained before candidate mapping', async () => {
  for (const [returned, expectedState] of [
    [undefined, 'INTERNAL_ERROR'],
    [{}, 'SCHEMA_CHANGED'],
  ]) {
    const services = createApplicationServices({
      adapters: {
        kakao: {
          async searchLocations() {
            return returned;
          },
        },
      },
      clock: () => FIXED_TIME,
      randomBytes: deterministicRandomBytes,
    });
    const result = await services.searchLocations({
      ownerSessionId: 'owner-a',
      query: '수원시 원천동',
    });
    assert.deepEqual(result.candidates, []);
    assert.equal(result.sourceState, expectedState);
    assert.deepEqual(result.limitations, [
      'LOCATION_PROVIDER_UNAVAILABLE_OR_NO_DATA',
    ]);
  }
});

test('an unrelated partial mid-forecast field does not cancel a complete temperature risk evaluation', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const adapters = completeAdapters(calls);
  adapters.kmaMid.getForecast = async () =>
    envelope({
      sourceId: 'kma-mid-forecast',
      spatialLevel: 'FORECAST_REGION',
      issuedAt: '2026-07-23T02:00:00.000Z',
      validFrom: '2026-07-24T15:00:00.000Z',
      validTo: '2026-07-25T14:59:59.000Z',
      qualityFlags: ['VERIFIED_FIXTURE', 'PARTIAL_PROVIDER_FAILURE'],
      data: { days: [forecastDay('2026-07-25', 'MID_REGIONAL')] },
    });
  const services = createApplicationServices({
    adapters,
    rules: reviewedRules(),
    verifiedLocationMappings: {
      '4111710500': verifiedMapping(),
    },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-partial-provider',
    input: analysisInput(candidateToken),
  });

  assert.equal(result.forecast.state, 'PARTIAL');
  assert.equal(result.forecast.result.riskState, 'READY');
  assert.equal(result.forecast.result.noActiveRisksConfirmed, true);
  assert.equal(result.riskState, 'READY');
  assert.ok(
    result.forecast.blockingReasons.includes('PARTIAL_PROVIDER_FAILURE'),
  );
});

test('a missing temperature required by an active crop rule still blocks the no-risk conclusion', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const adapters = completeAdapters(calls);
  adapters.kmaShort.getForecast = async () =>
    envelope({
      sourceId: 'kma-short-forecast',
      spatialLevel: 'FORECAST_GRID',
      validFrom: '2026-07-24T00:00:00.000Z',
      validTo: '2026-07-24T23:59:59.000Z',
      data: {
        days: [
          {
            ...forecastDay('2026-07-24', 'SHORT_GRID'),
            maxTemperature: null,
          },
        ],
      },
    });
  const services = createApplicationServices({
    adapters,
    rules: reviewedRules(),
    verifiedLocationMappings: {
      '4111710500': verifiedMapping(),
    },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-missing-required-temperature',
    input: analysisInput(candidateToken),
  });

  assert.equal(result.forecast.result.riskState, 'PARTIAL');
  assert.equal(result.forecast.result.noActiveRisksConfirmed, false);
  assert.equal(result.riskState, 'PARTIAL');
  assert.ok(
    result.forecast.result.missingMetrics.some(
      (item) =>
        item.metric === 'maxTemperature' &&
        item.date === '2026-07-24' &&
        item.reason === 'MISSING_VALUE',
    ),
  );
});

test('climate evidence traces single targets, aggregate math, deviations, and excluded planned weight', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const adapters = completeAdapters(calls);
  adapters.climate.getNormals = async () =>
    envelope({
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
          {
            metric: 'maxTemperature',
            month: 5,
            value: 35,
            unit: 'degC',
          },
          {
            metric: 'minTemperature',
            month: 5,
            value: 18,
            unit: 'degC',
          },
        ],
      },
    });
  const services = createApplicationServices({
    adapters,
    rules: climateEvidenceRules(),
    verifiedLocationMappings: {
      '4111710500': verifiedMapping(),
    },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-climate-evidence',
    input: analysisInput(candidateToken),
  });

  const byId = new Map(
    result.climate.evidence.map((item) => [item.evidenceId, item]),
  );
  const deviation = byId.get('CLIMATE_climate-high-temperature');
  assert.deepEqual(deviation.calculation.physicalDeviation, {
    direction: 'ABOVE',
    amount: 5,
  });
  assert.equal(deviation.calculation.normalizedDeviation, 0.5);

  const target = byId.get(
    'CLIMATE_SINGLE_TARGET_climate-minimum-target',
  );
  assert.equal(target.value, 18);
  assert.equal(target.reference, 16);
  assert.equal(target.calculation.absoluteDeviation, 2);

  const aggregate = byId.get('CLIMATE_AGGREGATE');
  assert.equal(aggregate.calculation.numerator, 1);
  assert.equal(aggregate.calculation.denominator, 5);
  assert.equal(aggregate.calculation.plannedDenominator, 6);
  assert.equal(aggregate.calculation.coverage, 5 / 6);
  assert.equal(byId.get('CLIMATE_COVERAGE').value, 5 / 6);
  assert.equal(
    byId.get('CLIMATE_EXCLUDED_climate-rainfall').rawWeight,
    1,
  );
});

test('regional soil evidence uses critical pH without field-only supporting chemistry', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const adapters = completeAdapters(calls);
  adapters.soilV2.getDistribution = async () =>
    envelope({
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
                lower: 6.5,
                upper: 7,
                lowerInclusive: true,
                upperInclusive: true,
                area: 50,
                areaUnit: 'ha',
              },
              {
                lower: 5.5,
                upper: 6.5,
                lowerInclusive: true,
                upperInclusive: false,
                area: 20,
                areaUnit: 'ha',
              },
              {
                lower: 4,
                upper: 5,
                lowerInclusive: true,
                upperInclusive: true,
                area: 30,
                areaUnit: 'ha',
              },
            ],
          },
        ],
      },
    });
  const missingSoilRule = {
    ...reviewedRules()[1],
    ruleId: 'soil-ec',
    metric: 'soilEc',
    unit: 'dS/m',
    optimalRange: [1, 2],
    sensitivityTier: 'SUPPORTING',
    critical: false,
  };
  const services = createApplicationServices({
    adapters,
    rules: [...reviewedRules(), missingSoilRule],
    verifiedLocationMappings: {
      '4111710500': verifiedMapping(),
    },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-soil-evidence',
    input: analysisInput(candidateToken),
  });

  const byId = new Map(
    result.soil.evidence.map((item) => [item.evidenceId, item]),
  );
  assert.deepEqual(byId.get('SOIL_soil-ph').calculation, {
    classifiedMetric: {
      metric: 'soilPh',
      unit: 'pH',
      reviewedOptimalRange: [6, 7],
    },
    areas: {
      totalValid: 100,
      fit: 50,
      uncertain: 20,
      outside: 30,
      unit: 'ha',
    },
    ratios: {
      fit: 0.5,
      uncertain: 0.2,
      outside: 0.3,
    },
  });
  assert.equal(byId.get('SOIL_soil-ph').value, 0.5);
  assert.equal(byId.get('SOIL_soil-ph').unit, 'ratio');
  assert.equal(byId.get('SOIL_soil-ph').reference, null);
  assert.equal(byId.get('SOIL_COVERAGE').value, 1);
  assert.deepEqual(byId.get('SOIL_COVERAGE').calculation, {
    numerator: 3,
    denominator: 3,
    coverage: 1,
  });
  assert.equal(byId.has('SOIL_EXCLUDED_soil-ec'), false);
});

test('forecast evidence records actual values, thresholds, and both source provenances', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const adapters = completeAdapters(calls);
  adapters.kmaShort.getForecast = async () => {
    const day = forecastDay('2026-07-24', 'SHORT_GRID');
    day.maxTemperature = 35;
    return envelope({
      sourceId: 'kma-short-forecast',
      spatialLevel: 'FORECAST_GRID',
      issuedAt: '2026-07-23T02:00:00.000Z',
      validFrom: '2026-07-23T15:00:00.000Z',
      validTo: '2026-07-24T14:59:59.000Z',
      data: { days: [day] },
    });
  };
  const services = createApplicationServices({
    adapters,
    rules: reviewedRules(),
    verifiedLocationMappings: {
      '4111710500': verifiedMapping(),
    },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-forecast-evidence',
    input: analysisInput(candidateToken),
  });
  const risk = result.forecast.evidence.find(
    ({ evidenceId }) =>
      evidenceId === 'forecast-high-temperature:2026-07-24',
  );
  assert.equal(risk.value, 35);
  assert.equal(risk.reference, 'GT 30');
  assert.deepEqual(risk.calculation.comparison, {
    operator: 'GT',
    threshold: 30,
  });
  assert.deepEqual(risk.calculation.readings, [
    {
      date: '2026-07-24',
      value: 35,
      sourceType: 'SHORT_GRID',
    },
  ]);
  assert.equal(risk.spatialLevel, 'FORECAST_GRID');

  const evaluations = result.forecast.evidence.filter(
    ({ evidenceId }) =>
      evidenceId.startsWith(
        'FORECAST_EVALUATION_forecast-high-temperature_',
      ),
  );
  assert.deepEqual(
    evaluations.map(({ sourceType }) => sourceType).sort(),
    ['MID_REGIONAL', 'SHORT_GRID'],
  );
  assert.deepEqual(
    evaluations.map(({ spatialLevel }) => spatialLevel).sort(),
    ['FORECAST_GRID', 'FORECAST_REGION'],
  );

  await services.requestReport({
    ownerSessionId: 'owner-a',
    analysisId: result.analysisId,
  });
  await new Promise((resolve) => queueMicrotask(resolve));
  const completed = await services.getAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: result.analysisId,
  });
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
    ...completed.report.value.risks,
    ...completed.report.value.nextActions,
    ...completed.report.value.limitations,
  ].flatMap(({ factIds }) => factIds);
  assert.equal(
    reportFactIds.every((factId) => evidenceIds.has(factId)),
    true,
  );
});

test('application core deadline contains adapters that ignore AbortSignal', async () => {
  const services = createApplicationServices({
    adapters: {
      kakao: locationAdapter(),
      climate: {
        id: 'ignores-abort',
        async getNormals() {
          return new Promise(() => {});
        },
      },
    },
    verifiedLocationMappings: {
      '4111710500': verifiedMapping({
        soil: undefined,
        midForecast: undefined,
        observationStation: undefined,
      }),
    },
    clock: Date.now,
    randomBytes: deterministicRandomBytes,
    coreDeadlineMs: 10,
  });
  const candidateToken = await confirmedCandidate(services);
  let watchdog;
  const result = await Promise.race([
    services.createAnalysis({
      ownerSessionId: 'owner-a',
      analysisId: 'analysis-deadline',
      input: analysisInput(candidateToken),
    }),
    new Promise((_, reject) => {
      watchdog = setTimeout(
        () => reject(new Error('core deadline containment did not return')),
        2_000,
      );
      watchdog.unref?.();
    }),
  ]).finally(() => clearTimeout(watchdog));

  assert.equal(result.climate.state, 'HOLD');
  assert.ok(
    result.dataSources.some(
      (source) =>
        source.sourceId === 'kma-climate-normal' &&
        source.adapterState === 'TIMEOUT' &&
        source.qualityFlags.includes('CORE_DEADLINE_EXCEEDED'),
    ),
  );
});

test('SmartFarm is excluded even when a request asks for the benchmark', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
    smartfarm: [],
  };
  const adapters = completeAdapters(calls);
  adapters.smartfarm = {
    id: 'smartfarm-fixture',
    async getReference(params) {
      calls.smartfarm.push(params);
      return envelope({
        sourceId: 'smartfarm-reference',
        spatialLevel: 'REFERENCE_DATASET',
        data: {
          referenceType: 'PUBLIC_PEER_COHORT',
          decisionUse: 'REFERENCE_ONLY',
          affectsDecision: false,
          affectsScore: false,
          selectedCrop: '오이',
          requestedRegion: '경기도 수원시',
          comparisonLevel: 'SAME_DISTRICT',
          sameProvinceCount: 12,
          sameDistrictCount: 4,
          farmCount: 28,
          recordCount: 35,
          seasonCount: 35,
          privacy: {
            individualFarmIdsExposed: false,
            individualFarmSelected: false,
            aggregation: 'COHORT_ONLY',
          },
          datasetType: 'FACILITY_ITEM_DATA',
          datasetName: '스마트팜코리아 품목별 시설원예 데이터',
          datasetPeriod: { fromYear: 2018, toYear: 2024 },
          datasetUpdateCycle: 'ANNUAL_AFTER_SEASON',
          regions: [{ name: '경기도 수원시', count: 4 }],
          cultivationMethods: [{ name: '토경', count: 35 }],
          facilityTypes: [{ name: '비닐', count: 20 }],
          greenhouseStructures: [],
          sizeBands: [],
          varieties: [],
          fetchedDataTypes: ['FARM_SEASON_METADATA'],
          availableDataTypes: [
            'CROP_SEASON',
            'ENVIRONMENT',
            'CONTROL',
            'GROWTH',
          ],
          limitations: [
            'PUBLIC_COHORT_NOT_USER_FARM',
            'NO_ENVIRONMENT_VALUE_USED_AS_OPTIMUM',
          ],
        },
      });
    },
  };
  const services = createApplicationServices({
    adapters,
    rules: facilityForecastRules(),
    verifiedLocationMappings: {
      '4111710500': verifiedMapping(),
    },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const facilityInput = {
    usageMode: 'LAND_SEARCH',
    location: { candidateToken, userConfirmed: true },
    crop: 'CUCUMBER',
    cultivationMode: 'FACILITY_HYDRO',
  };
  const withoutReference = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-without-smartfarm',
    input: facilityInput,
  });
  const withReference = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-with-smartfarm',
    input: {
      ...facilityInput,
      options: {
        includeSmartfarmBenchmark: true,
        includeSatelliteObservation: false,
        saveConsent: false,
      },
    },
  });

  assert.equal(withReference.smartfarm, null);
  assert.deepEqual(withReference.decision, withoutReference.decision);
  assert.deepEqual(withReference.actions, withoutReference.actions);
  assert.equal(withReference.state, withoutReference.state);
  assert.equal(withReference.conditionState, withoutReference.conditionState);
  assert.equal(withReference.riskState, withoutReference.riskState);
  assert.equal(calls.smartfarm.length, 0);
  assert.equal(
    withReference.dataSources.some(
      ({ sourceId }) => sourceId === 'smartfarm-reference',
    ),
    false,
  );
  assert.equal(
    withReference.limitations.some((value) =>
      value.startsWith('smartfarm-reference:'),
    ),
    false,
  );
  assert.equal(
    JSON.stringify(withReference).match(/"smartfarmScore"/giu),
    null,
  );
  assert.equal(withoutReference.smartfarm, null);
});

test('excluded SmartFarm provider is never called', async () => {
  const calls = {
    climate: [],
    observations: [],
    soil: [],
    short: [],
    mid: [],
  };
  const adapters = completeAdapters(calls);
  let smartfarmCalls = 0;
  adapters.smartfarm = {
    async getReference() {
      smartfarmCalls += 1;
      throw new Error('provider unavailable');
    },
  };
  const services = createApplicationServices({
    adapters,
    rules: facilityForecastRules(),
    verifiedLocationMappings: {
      '4111710500': verifiedMapping(),
    },
    clock: () => FIXED_TIME,
    randomBytes: deterministicRandomBytes,
  });
  const candidateToken = await confirmedCandidate(services);
  const result = await services.createAnalysis({
    ownerSessionId: 'owner-a',
    analysisId: 'analysis-smartfarm-failure',
    input: {
      usageMode: 'LAND_SEARCH',
      location: { candidateToken, userConfirmed: true },
      crop: 'CUCUMBER',
      cultivationMode: 'FACILITY_HYDRO',
      options: {
        includeSmartfarmBenchmark: true,
        includeSatelliteObservation: false,
        saveConsent: false,
      },
    },
  });

  assert.equal(result.smartfarm, null);
  assert.equal(smartfarmCalls, 0);
  assert.equal(result.state, 'COMPLETE');
  assert.equal(result.conditionState, 'NOT_APPLICABLE');
  assert.equal(result.riskState, 'READY');
});
