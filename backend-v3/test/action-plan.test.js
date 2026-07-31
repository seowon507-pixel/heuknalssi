import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActionPlan,
  createActionItem,
  ruleActionDedupeKey,
  transitionActionStatus,
} from "../src/domain/action-plan.js";
import {
  ACTION_PLAN_REPOSITORY_METHODS,
  createActionPlanService,
} from "../src/application/action-plan.js";

const NOW = "2026-07-31T00:00:00.000Z";

function evidence(overrides = {}) {
  return {
    sourceKind: "PUBLIC_API",
    sourceId: "forecast-2026-07-31",
    observedAt: "2026-07-31T00:00:00.000Z",
    fetchedAt: "2026-07-31T00:01:00.000Z",
    spatialLevel: "FIELD_NEARBY_GRID",
    state: "READY",
    limitationCodes: [],
    ...overrides,
  };
}

function draft(overrides = {}) {
  return {
    farmId: "farm-a",
    cropId: "crop-apple-a",
    seasonId: "season-a",
    title: "배수로를 먼저 확인하세요",
    instruction: "물이 고인 곳과 막힌 배수로가 있는지 직접 확인하세요.",
    reason: "오늘 강수 예보가 확인되어 물 빠짐 상태를 먼저 살펴봐야 합니다.",
    horizon: "TODAY",
    dueAt: "2026-07-31T09:00:00.000Z",
    recheckAt: "2026-08-01T00:00:00.000Z",
    evidenceRefs: [evidence()],
    origin: "RULE",
    ...overrides,
  };
}

function item(overrides = {}) {
  const { actionId = "action-a", ...draftOverrides } = overrides;
  return createActionItem(draft(draftOverrides), {
    actionId,
    now: NOW,
  });
}

test("ActionItem은 오늘/당분간, 상태, 기한, 재확인, 출처를 그대로 보존한다", () => {
  const action = item();

  assert.deepEqual(action, {
    actionId: "action-a",
    farmId: "farm-a",
    cropId: "crop-apple-a",
    seasonId: "season-a",
    title: "배수로를 먼저 확인하세요",
    instruction: "물이 고인 곳과 막힌 배수로가 있는지 직접 확인하세요.",
    reason: "오늘 강수 예보가 확인되어 물 빠짐 상태를 먼저 살펴봐야 합니다.",
    horizon: "TODAY",
    status: "OPEN",
    dueAt: "2026-07-31T09:00:00.000Z",
    recheckAt: "2026-08-01T00:00:00.000Z",
    evidenceRefs: [evidence()],
    origin: "RULE",
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
});

test("근거 또는 실제 행동 문구가 없거나 종합점수 필드가 섞이면 거부한다", () => {
  assert.throws(
    () => item({ evidenceRefs: [] }),
    (error) => error.code === "ACTION_EVIDENCE_REQUIRED",
  );
  assert.throws(
    () => item({ instruction: "" }),
    (error) => error.code === "ACTION_TEXT_REQUIRED",
  );
  assert.throws(
    () => item({ compositeScore: 92 }),
    (error) => error.code === "ACTION_FIELD_UNSUPPORTED",
  );
});

test("완료와 건너뜀 상태는 완료시각을 일관되게 전환한다", () => {
  const open = item();
  const done = transitionActionStatus(open, "DONE", {
    now: "2026-07-31T02:00:00.000Z",
  });
  const reopened = transitionActionStatus(done, "OPEN", {
    now: "2026-07-31T03:00:00.000Z",
  });
  const skipped = transitionActionStatus(reopened, "SKIPPED", {
    now: "2026-07-31T04:00:00.000Z",
  });

  assert.equal(done.completedAt, "2026-07-31T02:00:00.000Z");
  assert.equal(reopened.completedAt, null);
  assert.equal(skipped.completedAt, null);
  assert.equal(skipped.status, "SKIPPED");
  assert.equal(open.status, "OPEN");
});

test("목록은 열린 오늘 행동을 첫 행동으로 두고 농장/작물을 섞지 않는다", () => {
  const farmAAppleToday = item({ actionId: "a-today" });
  const farmAAppleUpcoming = item({
    actionId: "a-upcoming",
    horizon: "UPCOMING",
    dueAt: "2026-08-03T00:00:00.000Z",
    recheckAt: "2026-08-04T00:00:00.000Z",
  });
  const farmAPearToday = item({
    actionId: "pear-today",
    cropId: "crop-pear-a",
  });
  const farmBAppleToday = item({
    actionId: "farm-b-today",
    farmId: "farm-b",
  });
  const plan = buildActionPlan(
    [farmAAppleUpcoming, farmAPearToday, farmBAppleToday, farmAAppleToday],
    { farmId: "farm-a", cropId: "crop-apple-a" },
  );

  assert.equal(plan.firstAction.actionId, "a-today");
  assert.deepEqual(plan.today.map(({ actionId }) => actionId), ["a-today"]);
  assert.deepEqual(plan.upcoming.map(({ actionId }) => actionId), [
    "a-upcoming",
  ]);
});

test("규칙 행동 중복키는 농장+작물+규칙+서울 기준 기한 날짜에 묶인다", () => {
  const input = {
    farmId: "farm-a",
    cropId: "crop-apple-a",
    ruleId: "apple.rain.check.v1",
    dueAt: "2026-07-31T09:00:00.000Z",
  };

  assert.equal(ruleActionDedupeKey(input), ruleActionDedupeKey({ ...input }));
  assert.notEqual(
    ruleActionDedupeKey(input),
    ruleActionDedupeKey({ ...input, cropId: "crop-pear-a" }),
  );
  assert.equal(
    ruleActionDedupeKey(input),
    ruleActionDedupeKey({ ...input, dueAt: "2026-07-31T14:59:59.000Z" }),
  );
  assert.notEqual(
    ruleActionDedupeKey(input),
    ruleActionDedupeKey({
      ...input,
      dueAt: "2026-08-01T09:00:00.000Z",
    }),
  );
});

test("같은 날 생성된 규칙 행동은 한 건으로 정리하고 완료 상태를 보존한다", () => {
  const open = item({ actionId: "open" });
  const done = transitionActionStatus(
    item({ actionId: "done" }),
    "DONE",
    { now: "2026-07-31T02:00:00.000Z" },
  );
  const plan = buildActionPlan([open, done], {
    farmId: "farm-a",
    cropId: "crop-apple-a",
  });

  assert.equal(plan.today.length, 1);
  assert.equal(plan.today[0].actionId, "done");
  assert.equal(plan.today[0].status, "DONE");
});

test("응용 서비스는 규칙 중복을 원자 저장 계약에 위임하고 새 기한은 새 행동으로 만든다", async () => {
  const repository = createMemoryRepository();
  let id = 0;
  const service = createActionPlanService({
    repository,
    clock: () => new Date(NOW),
    idFactory: () => `action-${++id}`,
  });
  const command = {
    accountId: "account-a",
    farmId: "farm-a",
    confirmed: true,
    idempotencyKey: "request-1",
    ruleId: "apple.rain.check.v1",
    draft: draft(),
  };

  const first = await service.createAction(command);
  const duplicate = await service.createAction({
    ...command,
    idempotencyKey: "request-2",
  });
  const later = await service.createAction({
    ...command,
    idempotencyKey: "request-3",
    draft: draft({
      dueAt: "2026-08-01T09:00:00.000Z",
      recheckAt: "2026-08-02T00:00:00.000Z",
    }),
  });

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.action.actionId, first.action.actionId);
  assert.equal(later.created, true);
  assert.notEqual(later.action.actionId, first.action.actionId);
  assert.equal(repository.actions.size, 2);
});

test("응용 서비스는 확인 없는 쓰기를 막고 조회 범위를 계정/농장/작물로 전달한다", async () => {
  const repository = createMemoryRepository();
  const service = createActionPlanService({ repository });

  await assert.rejects(
    service.createAction({
      accountId: "account-a",
      farmId: "farm-a",
      confirmed: false,
      idempotencyKey: "request-1",
      ruleId: "apple.rain.check.v1",
      draft: draft(),
    }),
    (error) => error.code === "ACTION_CONFIRMATION_REQUIRED",
  );

  await service.listActions({
    accountId: "account-a",
    farmId: "farm-a",
    cropId: "crop-apple-a",
  });
  assert.deepEqual(repository.lastListScope, {
    accountId: "account-a",
    farmId: "farm-a",
    cropId: "crop-apple-a",
    seasonId: null,
  });
});

test("상태 변경은 저장된 소유 범위와 낙관적 갱신 기준을 유지한다", async () => {
  const repository = createMemoryRepository();
  const existing = item();
  repository.actions.set(existing.actionId, existing);
  const service = createActionPlanService({
    repository,
    clock: () => new Date("2026-07-31T02:00:00.000Z"),
  });

  const done = await service.updateActionStatus({
    accountId: "account-a",
    farmId: "farm-a",
    actionId: existing.actionId,
    status: "DONE",
    confirmed: true,
    idempotencyKey: "complete-1",
  });

  assert.equal(done.status, "DONE");
  assert.equal(done.completedAt, "2026-07-31T02:00:00.000Z");
  assert.equal(repository.lastExpectedUpdatedAt, NOW);
});

test("저장 어댑터 인터페이스는 통합자가 구현할 메서드를 고정한다", () => {
  assert.deepEqual(ACTION_PLAN_REPOSITORY_METHODS, [
    "listActions",
    "getAction",
    "insertAction",
    "updateAction",
  ]);
});

function createMemoryRepository() {
  const actions = new Map();
  const dedupe = new Map();
  return {
    actions,
    lastListScope: null,
    lastExpectedUpdatedAt: null,
    async listActions(scope) {
      this.lastListScope = scope;
      return [...actions.values()].filter(
        (action) =>
          action.farmId === scope.farmId &&
          (!scope.cropId || action.cropId === scope.cropId) &&
          (!scope.seasonId || action.seasonId === scope.seasonId),
      );
    },
    async getAction({ farmId, actionId }) {
      const action = actions.get(actionId) ?? null;
      return action?.farmId === farmId ? action : null;
    },
    async insertAction({ action, ruleDedupeKey: key }) {
      if (key && dedupe.has(key)) {
        return { action: actions.get(dedupe.get(key)), created: false };
      }
      actions.set(action.actionId, action);
      if (key) dedupe.set(key, action.actionId);
      return { action, created: true };
    },
    async updateAction({ action, expectedUpdatedAt }) {
      this.lastExpectedUpdatedAt = expectedUpdatedAt;
      const existing = actions.get(action.actionId);
      assert.equal(existing.updatedAt, expectedUpdatedAt);
      actions.set(action.actionId, action);
      return action;
    },
  };
}
