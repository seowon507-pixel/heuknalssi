import assert from 'node:assert/strict';
import test from 'node:test';

import { FarmGame } from '../src/farmGame.js';

test('question setup can start each supported crop at its reported growth stage', () => {
  for (const crop of FarmGame.getCharacters()) {
    for (const stage of crop.stages) {
      const game = new FarmGame();
      const result = game.selectCrop(crop.id, '2026-08-05', {
        usageMode: 'ACTIVE_GROWING',
        region: '인천광역시 남동구',
        cultivationMode: 'OPEN_FIELD',
        stageKey: stage.key,
        startedKey: '2026-07-20',
      });

      assert.equal(result.ok, true, `${crop.id}:${stage.key}`);
      assert.equal(result.progress.stageKey, stage.key, `${crop.id}:${stage.key}`);
      assert.equal(result.progress.startedKey, '2026-07-20', crop.id);
      assert.equal(game.getCropProfile(crop.id).usageMode, 'ACTIVE_GROWING', crop.id);
    }
  }
});

test('all supported crops convert caution and danger analyses into prioritized work', () => {
  const cropIds = FarmGame.getCharacters().map((crop) => crop.id);

  for (const [index, cropId] of cropIds.entries()) {
    const game = new FarmGame();
    const caution = analysisFixture({
      analysisId: `caution-${cropId}`,
      cropId,
      createdAt: `2026-08-${String(index + 5).padStart(2, '0')}T03:00:00.000Z`,
      status: 'CAUTION',
      weatherCode: 'HIGH_TEMPERATURE',
      action: `${cropId} 한낮 전 수분 상태를 확인해요.`,
    });
    const danger = analysisFixture({
      analysisId: `danger-${cropId}`,
      cropId,
      createdAt: `2026-09-${String(index + 5).padStart(2, '0')}T03:00:00.000Z`,
      status: 'DANGER',
      weatherCode: 'TYPHOON',
      action: `${cropId} 시설 고정 상태를 바로 확인해요.`,
    });

    assert.ok(game.syncPreventiveTodos(caution).added.every((todo) => todo.priority === 'CAUTION'));
    assert.ok(game.syncPreventiveTodos(danger).added.every((todo) => todo.priority === 'DANGER'));
  }
});

test('attendance unlocks titles in order and rejects locked border selection', () => {
  const game = new FarmGame();
  assert.equal(game.getTitleProgress().current.key, 'seed');

  game.checkIn('2026-01-01');
  game.checkIn('2026-01-02');
  game.checkIn('2026-01-03');
  assert.equal(game.getTitleProgress().current.key, 'sprout');

  game.updateProfile({ selectedTitleKey: 'worldtree', selectedBorderKey: 'worldtree' });
  assert.equal(game.getProfile().selectedTitleKey, 'sprout');
  assert.equal(game.getProfile().selectedBorderKey, 'sprout');

  for (let day = 4; day <= 60; day += 1) {
    const date = new Date(2026, 0, day);
    game.checkIn(date);
  }
  assert.equal(game.getTitleProgress().current.key, 'worldtree');
  assert.equal(game.getTitleProgress().next, null);
});

test('caution and danger create preventive todos once, while good creates none', () => {
  const game = new FarmGame();
  const caution = analysisFixture({
    analysisId: 'analysis-a',
    status: 'CAUTION',
    weatherCode: 'HIGH_TEMPERATURE',
    action: '한낮 전에 토양 수분을 확인해요.',
  });
  const first = game.syncPreventiveTodos(caution);
  assert.equal(first.added.length, 1);
  assert.ok(first.added.every((todo) => todo.priority === 'CAUTION'));
  assert.ok(first.added.every((todo) => todo.evidence.dateKey === '2026-08-05'));
  assert.ok(first.added.every((todo) => todo.evidence.statusLabel === '주의'));
  assert.ok(first.added.every((todo) => todo.evidence.causeLabel === '고온'));
  assert.equal(first.added[0].evidence.cropName, '사과');
  assert.equal(first.added[0].evidence.reason, '고온이 이어지면 잎과 과실이 스트레스를 받을 수 있어요.');
  assert.equal(first.added[0].evidence.recheck, '해가 진 뒤 잎 상태를 다시 확인해요.');
  assert.equal(first.notifications.length, 1);

  const repeated = game.syncPreventiveTodos({ ...caution, analysisId: 'analysis-b' });
  assert.equal(repeated.added.length, 0);
  assert.equal(repeated.notifications.length, 0);

  const nextAnalysisDay = analysisFixture({
    analysisId: 'analysis-next-day',
    createdAt: '2026-08-06T00:10:00.000Z',
    riskDate: '2026-08-05',
    status: 'CAUTION',
    weatherCode: 'HIGH_TEMPERATURE',
    action: '한낮 전에 토양 수분을 확인해요.',
  });
  assert.equal(game.syncPreventiveTodos(nextAnalysisDay).added.length, 0);

  const danger = analysisFixture({
    analysisId: 'analysis-c',
    status: 'DANGER',
    weatherCode: 'TYPHOON',
    action: '지주와 시설 고정 상태를 확인해요.',
  });
  const urgent = game.syncPreventiveTodos(danger);
  assert.ok(urgent.added.length >= 1);
  assert.ok(urgent.added.every((todo) => todo.priority === 'DANGER'));

  const good = analysisFixture({
    analysisId: 'analysis-d',
    status: 'GOOD',
    weatherCode: 'WEATHER_STABLE',
    action: '평소대로 관찰해요.',
  });
  assert.deepEqual(game.syncPreventiveTodos(good), { added: [], notifications: [] });
});

test('saved prevention tasks with the same crop, signal date, and action are restored once', () => {
  const base = structuredClone(new FarmGame().toJSON());
  const common = {
    text: '예보 전에 잎 상태를 확인합니다.',
    done: false,
    createdKey: '2026-08-05',
    source: 'ENVIRONMENT_ANALYSIS',
    cropId: 'lettuce',
    priority: 'CAUTION',
  };
  base.todos = [
    { ...common, id: 'old', sourceKey: `environment:2026-08-04:lettuce:${common.text}` },
    {
      ...common,
      id: 'new',
      sourceKey: `environment:2026-08-05:lettuce:${common.text}`,
      evidence: { dateKey: '2026-08-05' },
    },
  ];

  assert.equal(new FarmGame(base).state.todos.length, 1);
});

test('automatic prevention keeps only urgent field work and limits caution workload per crop', () => {
  const game = new FarmGame();
  const analysis = analysisFixture({
    analysisId: 'focused-caution',
    status: 'CAUTION',
    weatherCode: 'HIGH_TEMPERATURE',
    action: '예보 전에 잎과 토양 수분을 확인해요.',
  });
  analysis.forecast.result.risks[0].guidance.actions = [
    '이상 징후가 이어지면 지역 농업기술센터에 문의해요.',
    '작기 확인 후 다시 분석',
    '현재 과실이 커지는 시기인지 확인해요.',
    '예보 전에 잎과 토양 수분을 확인해요.',
    '차광시설의 작동 상태를 확인해요.',
  ];

  const result = game.syncPreventiveTodos(analysis);

  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].text, '예보 전에 잎과 토양 수분을 확인해요.');
});

test('restoring saved work removes advisory tasks and caps caution work to one per crop and date', () => {
  const base = structuredClone(new FarmGame().toJSON());
  const automatic = (id, text) => ({
    id,
    text,
    done: false,
    createdKey: '2026-08-05',
    source: 'ENVIRONMENT_ANALYSIS',
    sourceKey: `environment:2026-08-05:lettuce:${text}`,
    cropId: 'lettuce',
    priority: 'CAUTION',
    evidence: { dateKey: '2026-08-05' },
  });
  base.todos = [
    automatic('center', '이상 징후가 이어지면 지역 농업기술센터에 문의해요.'),
    automatic('first', '예보 전에 잎의 시듦을 확인해요.'),
    automatic('second', '토양 수분을 확인해요.'),
    { id: 'manual', text: '개인 메모', done: false, createdKey: '2026-08-05' },
  ];

  const restored = new FarmGame(base).state.todos;

  assert.deepEqual(restored.map((todo) => todo.id), ['first', 'manual']);
});

function analysisFixture({
  analysisId,
  status,
  weatherCode,
  action,
  cropId = 'apple',
  createdAt = '2026-08-05T03:00:00.000Z',
  riskDate = createdAt.slice(0, 10),
}) {
  return {
    analysisId,
    createdAt,
    inputSummary: { crop: cropId.toUpperCase() },
    environmentCause: {
      status,
      statusLabel: status === 'DANGER' ? '위험' : status === 'GOOD' ? '양호' : '주의',
      causeLabel: weatherCode === 'TYPHOON' ? '태풍' : '고온',
      weather: {
        status,
        code: weatherCode,
        label: weatherCode === 'TYPHOON' ? '태풍' : '고온',
        daily: [{
          date: riskDate,
          status,
          statusLabel: status === 'DANGER' ? '위험' : status === 'GOOD' ? '양호' : '주의',
          code: weatherCode,
          label: weatherCode === 'TYPHOON' ? '태풍' : '고온',
          riskId: `${analysisId}-risk`,
        }],
      },
      soil: { code: 'SOIL_STABLE' },
    },
    forecast: {
      result: {
        risks: [{
          riskId: `${analysisId}-risk`,
          dateRange: { from: riskDate, to: riskDate },
          guidance: {
            reason: '고온이 이어지면 잎과 과실이 스트레스를 받을 수 있어요.',
            actions: [action],
            recheck: '해가 진 뒤 잎 상태를 다시 확인해요.',
          },
        }],
      },
    },
  };
}
