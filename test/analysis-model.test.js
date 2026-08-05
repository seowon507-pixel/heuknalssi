import assert from 'node:assert/strict';
import test from 'node:test';

import { backendConditionCode, buildAnalysisViewModel } from '../public/analysis-model.js';

test('analysis model uses backend scores, causes, and seven-day values without fallback data', () => {
  const result = buildAnalysisViewModel({
    analysisId: 'analysis-1',
    createdAt: '2026-08-05T01:00:00Z',
    inputSummary: { regionLabel: '인천광역시 남동구' },
    forecast: {
      result: {
        risks: [{
          riskId: 'risk-heat-1',
          dateRange: { from: '2026-08-05', to: '2026-08-05' },
          guidance: {
            reason: '고온이 이어지면 과실 피해가 커질 수 있습니다.',
            actions: ['과실과 토양 수분을 확인합니다.'],
            recheck: '고온이 지난 다음 날 다시 확인합니다.',
          },
        }],
      },
    },
    growthScore: {
      state: 'READY',
      score: 67,
      label: '주의',
      components: {
        forecast: { state: 'READY', score: 60 },
        soil: { state: 'READY', score: 84 },
      },
    },
    environmentCause: {
      status: 'CAUTION',
      statusLabel: '주의',
      causeLabel: '고온',
      weather: {
        status: 'CAUTION',
        code: 'HIGH_TEMPERATURE',
        label: '고온',
        affectsScore: true,
        trigger: {
          metric: 'maxTemperature',
          unit: '℃',
          comparison: { operator: 'GTE', threshold: 30 },
          readings: [{ date: '2026-08-05', value: 37 }],
        },
        daily: Array.from({ length: 7 }, (_, index) => ({
          date: `2026-08-${String(index + 5).padStart(2, '0')}`,
          status: index === 0 ? 'CAUTION' : 'GOOD',
          statusLabel: index === 0 ? '주의' : '양호',
          code: index === 0 ? 'HIGH_TEMPERATURE' : 'WEATHER_STABLE',
          label: index === 0 ? '고온' : '날씨 안정',
          maxTemperature: 31 + index,
          minTemperature: 22,
          precipitationProbability: index * 10,
          sourceType: index < 4 ? 'SHORT_GRID' : 'MID_REGIONAL',
          riskId: index === 0 ? 'risk-heat-1' : null,
          trigger: index === 0 ? {
            metric: 'maxTemperature',
            unit: '℃',
            comparison: { operator: 'GTE', threshold: 30 },
            readings: [{ date: '2026-08-05', value: 31 }],
          } : null,
        })),
      },
      soil: {
        status: 'GOOD',
        code: 'SOIL_STABLE',
        label: '토양 안정',
        affectsScore: true,
        observedValue: 6.2,
        optimalRange: [5.5, 7.5],
      },
      scoreLink: { policy: 'SAME_INPUTS' },
    },
  });

  assert.equal(result.totalScore, 67);
  assert.equal(result.weather.score, 60);
  assert.equal(result.soil.score, 84);
  assert.equal(result.headline, '주의 · 고온');
  assert.equal(result.primaryCode, 'heat');
  assert.deepEqual(result.sceneCodes, ['heat', 'soilStable']);
  assert.equal(result.weather.trigger.comparison.threshold, 30);
  assert.equal(result.weather.trigger.unit, '℃');
  assert.equal(result.weather.trigger.readings[0].value, 37);
  assert.deepEqual(result.soil.optimalRange, [5.5, 7.5]);
  assert.equal(result.week.length, 7);
  assert.equal(result.week[0].tMax, 31);
  assert.equal(result.week[0].code, 'heat');
  assert.equal(result.week[0].trigger.comparison.threshold, 30);
  assert.equal(result.week[0].trigger.readings[0].value, 31);
  assert.equal(
    result.week[0].guidance.reason,
    '고온이 이어지면 과실 피해가 커질 수 있습니다.',
  );
  assert.deepEqual(result.week[0].guidance.actions, [
    '과실과 토양 수분을 확인합니다.',
  ]);
  assert.equal(
    result.week[0].guidance.recheck,
    '고온이 지난 다음 날 다시 확인합니다.',
  );
  assert.equal(result.week[6].sourceType, 'MID_REGIONAL');
});

test('missing backend values remain null instead of becoming zero or mock scores', () => {
  const result = buildAnalysisViewModel({
    growthScore: { state: 'HOLD', score: null, components: {} },
    environmentCause: {
      status: 'HOLD',
      statusLabel: '분석 중',
      causeLabel: '자료 확인 중',
      weather: { status: 'HOLD', code: 'WEATHER_UNRESOLVED', daily: [] },
      soil: { status: 'HOLD', code: 'SOIL_UNRESOLVED' },
    },
  });

  assert.equal(result.totalScore, null);
  assert.equal(result.weather.score, null);
  assert.equal(result.soil.score, null);
  assert.deepEqual(result.week, []);
});

test('weather card combines climate normals and forecast with backend effective weights', () => {
  const result = buildAnalysisViewModel({
    growthScore: {
      state: 'READY',
      score: 57,
      components: {
        climate: { state: 'READY', score: 66.96, effectiveWeight: 0.14 },
        forecast: { state: 'READY', score: 63.49, effectiveWeight: 0.3875 },
        soil: { state: 'READY', score: 6.52, effectiveWeight: 0.071931 },
      },
    },
    environmentCause: {
      status: 'CAUTION',
      statusLabel: '주의',
      causeLabel: '고온 · 산도 불균형',
      weather: { status: 'CAUTION', code: 'HIGH_TEMPERATURE', daily: [] },
      soil: { status: 'CAUTION', code: 'PH_IMBALANCE' },
    },
  });

  assert.equal(result.weather.score, 64.41);
  assert.equal(result.soil.score, 6.52);
  assert.equal(result.scoreComponents.climate.score, 66.96);
  assert.equal(result.scoreComponents.climate.effectiveWeight, 0.14);
  assert.equal(result.scoreComponents.forecast.score, 63.49);
  assert.equal(result.scoreComponents.forecast.effectiveWeight, 0.3875);
  assert.deepEqual(result.sceneCodes, ['heat', 'acidity']);
});

test('regional soil statistics request a field soil test without claiming a missing history', () => {
  const result = buildAnalysisViewModel({
    growthScore: {
      state: 'READY',
      score: 72,
      components: { soil: { state: 'READY', score: 64 } },
    },
    environmentCause: {
      status: 'GOOD',
      statusLabel: '양호',
      causeLabel: '토양 안정',
      weather: { status: 'GOOD', code: 'WEATHER_STABLE', daily: [] },
      soil: {
        status: 'GOOD',
        code: 'SOIL_STABLE',
        label: '토양 안정',
        referenceOnly: true,
        basis: 'REGIONAL_STATISTICS',
        measurementBasis: 'REGIONAL_STATISTICS',
      },
    },
  });

  assert.equal(result.soil.referenceOnly, true);
  assert.equal(result.soil.needsFieldTest, true);
  assert.equal(result.soil.measurementBasis, 'REGIONAL_STATISTICS');
});

test('all supported weather and soil causes keep their backend meaning in the mobile scene', () => {
  const cases = {
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
  };

  for (const [backendCode, sceneCode] of Object.entries(cases)) {
    assert.equal(backendConditionCode(backendCode), sceneCode, backendCode);
  }
});
