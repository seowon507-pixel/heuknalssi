import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCompletion,
  normalizeCompletionInput,
  sanitizeStoredCompletions,
  summarizeCompletions,
} from '../src/application/task-log.js';

// 2026-07-31 09:00 KST
const NOW = Date.parse('2026-07-31T00:00:00.000Z');

test('완료 입력은 허용된 필드만 받는다', () => {
  assert.deepEqual(
    normalizeCompletionInput({ actionId: 'CHECK_SOIL', done: true }),
    { actionId: 'CHECK_SOIL', analysisId: null, done: true, note: null },
  );
  assert.throws(
    () => normalizeCompletionInput({ actionId: 'CHECK_SOIL', done: true, evil: 1 }),
    /unsupported fields/u,
  );
  assert.throws(() => normalizeCompletionInput({ actionId: '', done: true }));
  assert.throws(
    () => normalizeCompletionInput({ actionId: 'CHECK_SOIL', done: 'yes' }),
    /done must be a boolean/u,
  );
});

test('메모는 제어문자를 걷어내고 길이를 자른다', () => {
  const { note } = normalizeCompletionInput({
    actionId: 'A',
    done: true,
    note: `  물   ${'매우'.repeat(200)}  `,
  });
  assert.ok(note.length <= 200);
  assert.equal(note.startsWith('물 매우'), true);
});

test('같은 날 같은 항목을 여러 번 눌러도 한 건으로 남는다', () => {
  const input = normalizeCompletionInput({ actionId: 'A', done: true });
  let entries = applyCompletion([], input, { now: NOW });
  entries = applyCompletion(entries, input, { now: NOW + 60_000 });
  assert.equal(entries.length, 1);
});

test('체크를 해제하면 그날 기록만 지운다', () => {
  const on = normalizeCompletionInput({ actionId: 'A', done: true });
  const off = normalizeCompletionInput({ actionId: 'A', done: false });
  const yesterday = applyCompletion([], on, { now: NOW - 86_400_000 });
  const both = applyCompletion(yesterday, on, { now: NOW });
  assert.equal(both.length, 2);

  const after = applyCompletion(both, off, { now: NOW });
  assert.equal(after.length, 1);
  assert.equal(after[0].completedOn, '2026-07-30');
});

test('KST 날짜로 묶는다', () => {
  // UTC 2026-07-30T16:00Z = KST 2026-07-31 01:00
  const entries = applyCompletion(
    [],
    normalizeCompletionInput({ actionId: 'A', done: true }),
    { now: Date.parse('2026-07-30T16:00:00.000Z') },
  );
  assert.equal(entries[0].completedOn, '2026-07-31');
});

test('근거는 호출부가 넘긴 분석 맥락을 그대로 적는다', () => {
  const entries = applyCompletion(
    [],
    normalizeCompletionInput({ actionId: 'A', done: true }),
    {
      now: NOW,
      context: {
        crop: 'LETTUCE',
        regionLabel: '서울 강동구',
        title: '가까운 기상위험 확인',
        severity: 'CAUTION',
        dueWindow: '1_TO_3_DAYS',
      },
    },
  );
  assert.deepEqual(entries[0].context, {
    crop: 'LETTUCE',
    regionLabel: '서울 강동구',
    title: '가까운 기상위험 확인',
    severity: 'CAUTION',
    dueWindow: '1_TO_3_DAYS',
  });
});

test('요약은 없는 값을 0으로 꾸미지 않는다', () => {
  const empty = summarizeCompletions([], { now: NOW });
  assert.equal(empty.totalCount, 0);
  assert.equal(empty.firstCompletedOn, null);
  assert.equal(empty.lastCompletedOn, null);
  assert.deepEqual(empty.bySeverity, {});
});

test('요약은 날짜 수와 심각도 분포를 함께 센다', () => {
  const context = { severity: 'WARNING' };
  let entries = applyCompletion(
    [],
    normalizeCompletionInput({ actionId: 'A', done: true }),
    { now: NOW - 86_400_000, context },
  );
  entries = applyCompletion(
    entries,
    normalizeCompletionInput({ actionId: 'B', done: true }),
    { now: NOW, context },
  );
  entries = applyCompletion(
    entries,
    normalizeCompletionInput({ actionId: 'C', done: true }),
    { now: NOW, context: { severity: 'CAUTION' } },
  );

  const summary = summarizeCompletions(entries, { now: NOW });
  assert.equal(summary.totalCount, 3);
  assert.equal(summary.todayCount, 2);
  assert.equal(summary.activeDayCount, 2);
  assert.equal(summary.firstCompletedOn, '2026-07-30');
  assert.equal(summary.lastCompletedOn, '2026-07-31');
  assert.deepEqual(summary.bySeverity, { WARNING: 2, CAUTION: 1 });
});

test('저장소에서 읽은 규격 밖 항목은 버린다', () => {
  const clean = sanitizeStoredCompletions([
    { actionId: 'A', completedOn: '2026-07-31', completedAt: 'x' },
    { actionId: '', completedOn: '2026-07-31', completedAt: 'x' },
    { actionId: 'B', completedOn: 'not-a-date', completedAt: 'x' },
    { actionId: 'C', completedOn: '2026-07-31' },
    null,
    'nope',
  ]);
  assert.equal(clean.length, 1);
  assert.equal(clean[0].actionId, 'A');
  assert.equal(sanitizeStoredCompletions('nope').length, 0);
});
