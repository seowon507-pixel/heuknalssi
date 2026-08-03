import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActionPlan,
  cancelRuleAction,
  createActionItem,
  ruleActionDedupeKey,
  snoozeActionUntil,
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
  const { actionId = "action-a", ruleId = "apple.rain.check.v1", ...draftOverrides } = overrides;
  return createActionItem(draft(draftOverrides), {
    actionId,
    ruleId: draftOverrides.origin === "RULE" || draftOverrides.origin === undefined
      ? ruleId
      : null,
    now: NOW,
  });
}

test("ActionItem은 오늘/당분간, 상태, 기한, 재확인, 출처를 그대로 보존한다", () => {
  const action = item();

  assert.deepEqual(action, {
    actionId: "action-a",
    ruleId: "apple.rain.check.v1",
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
    snoozedUntil: null,
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

test("열린 할 일은 내일로 미루고 다음 날 다시 오늘 목록으로 복귀한다", () => {
  const snoozed = snoozeActionUntil(item(), "2026-07-31T22:00:00.000Z", {
    now: "2026-07-31T02:00:00.000Z",
  });

  assert.equal(snoozed.status, "OPEN");
  assert.equal(snoozed.horizon, "UPCOMING");
  assert.equal(snoozed.dueAt, "2026-07-31T22:00:00.000Z");
  assert.equal(snoozed.snoozedUntil, "2026-07-31T22:00:00.000Z");
  assert.equal(
    buildActionPlan([snoozed], {
      farmId: "farm-a",
      cropId: "crop-apple-a",
      now: "2026-07-31T03:00:00.000Z",
    }).upcoming.length,
    1,
  );
  assert.equal(
    buildActionPlan([snoozed], {
      farmId: "farm-a",
      cropId: "crop-apple-a",
      now: "2026-07-31T22:30:00.000Z",
    }).today.length,
    1,
  );
  assert.throws(
    () => snoozeActionUntil(snoozed, "2026-07-31T01:00:00.000Z", {
      now: "2026-07-31T02:00:00.000Z",
    }),
    (error) => error.code === "ACTION_SNOOZE_INVALID",
  );
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

test("규칙 행동 중복키는 예보 날짜가 이동해도 농장+작물+위험 규칙에 묶인다", () => {
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
  assert.equal(
    ruleActionDedupeKey(input),
    ruleActionDedupeKey({
      ...input,
      dueAt: "2026-08-01T09:00:00.000Z",
    }),
  );
});

test("시스템 규칙 투영은 OPEN 행동만 자동 해제하고 완료 기록은 보존한다", () => {
  const cancelled = cancelRuleAction(item(), {
    now: "2026-07-31T05:00:00.000Z",
  });
  const done = transitionActionStatus(
    item({ actionId: "done", title: "완료한 별도 행동" }),
    "DONE",
    { now: "2026-07-31T04:00:00.000Z" },
  );

  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.updatedAt, "2026-07-31T05:00:00.000Z");
  assert.equal(cancelRuleAction(done, { now: "2026-07-31T06:00:00.000Z" }).status, "DONE");
  assert.throws(
    () => transitionActionStatus(cancelled, "OPEN", { now: "2026-07-31T07:00:00.000Z" }),
    (error) => error.code === "ACTION_STATUS_TRANSITION_INVALID",
  );
  assert.throws(
    () => transitionActionStatus(item({ actionId: "manual-cancel" }), "CANCELLED", {
      now: "2026-07-31T07:00:00.000Z",
    }),
    (error) => error.code === "ACTION_STATUS_TRANSITION_INVALID",
  );

  const plan = buildActionPlan([cancelled, done], {
    farmId: "farm-a",
    cropId: "crop-apple-a",
  });
  assert.equal(plan.today.length, 1);
  assert.equal(plan.archived.length, 1);
  assert.equal(plan.archived[0].status, "CANCELLED");
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

test("응용 서비스는 같은 규칙의 예보 날짜가 이동하면 OPEN 행동을 최신 근거로 갱신한다", async () => {
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
    projection: "SYSTEM_RULE",
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
  assert.equal(later.created, false);
  assert.equal(later.action.actionId, first.action.actionId);
  assert.equal(later.action.dueAt, "2026-08-01T09:00:00.000Z");
  assert.equal(repository.actions.size, 1);
});

test("응용 서비스는 자동 규칙 계약과 사용자 확인을 분리하고 조회 범위를 전달한다", async () => {
  const repository = createMemoryRepository();
  const service = createActionPlanService({ repository });

  await assert.rejects(
    service.createAction({
      accountId: "account-a",
      farmId: "farm-a",
      idempotencyKey: "request-1",
      ruleId: "apple.rain.check.v1",
      draft: draft(),
    }),
    (error) => error.code === "ACTION_PROJECTION_REQUIRED",
  );
  await assert.rejects(
    service.createAction({
      accountId: "account-a",
      farmId: "farm-a",
      confirmed: false,
      idempotencyKey: "request-2",
      draft: draft({ origin: "USER" }),
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

test("응용 서비스는 확인한 사용자의 다시 알림 시각을 저장한다", async () => {
  const repository = createMemoryRepository();
  const existing = item();
  repository.actions.set(existing.actionId, existing);
  const service = createActionPlanService({
    repository,
    clock: () => new Date("2026-07-31T02:00:00.000Z"),
  });

  const snoozed = await service.snoozeAction({
    accountId: "account-a",
    farmId: "farm-a",
    actionId: existing.actionId,
    snoozedUntil: "2026-07-31T22:00:00.000Z",
    confirmed: true,
    idempotencyKey: "snooze-1",
  });

  assert.equal(snoozed.status, "OPEN");
  assert.equal(snoozed.snoozedUntil, "2026-07-31T22:00:00.000Z");
  await assert.rejects(
    service.snoozeAction({
      accountId: "account-a",
      farmId: "farm-a",
      actionId: existing.actionId,
      snoozedUntil: "2026-08-01T22:00:00.000Z",
      confirmed: false,
      idempotencyKey: "snooze-2",
    }),
    (error) => error.code === "ACTION_CONFIRMATION_REQUIRED",
  );
});

test("위험 규칙 재조정은 사라진 OPEN 자동 행동만 해제한다", async () => {
  const repository = createMemoryRepository();
  const open = item();
  const done = transitionActionStatus(
    item({ actionId: "done", ruleId: "apple.done.v1" }),
    "DONE",
    { now: "2026-07-31T01:00:00.000Z" },
  );
  repository.actions.set(open.actionId, open);
  repository.actions.set(done.actionId, done);
  const service = createActionPlanService({
    repository,
    clock: () => new Date("2026-07-31T02:00:00.000Z"),
  });

  const result = await service.reconcileRuleActions({
    accountId: "account-a",
    farmId: "farm-a",
    cropId: "crop-apple-a",
    seasonId: "season-a",
    activeRuleIds: [],
    projection: "SYSTEM_RULE",
    idempotencyKey: "reconcile-1",
  });

  assert.deepEqual(result.cancelled.map(({ actionId }) => actionId), ["action-a"]);
  assert.equal(repository.actions.get("action-a").status, "CANCELLED");
  assert.equal(repository.actions.get("done").status, "DONE");
});

test("저장 어댑터 인터페이스는 통합자가 구현할 메서드를 고정한다", () => {
  assert.deepEqual(ACTION_PLAN_REPOSITORY_METHODS, [
    "listActions",
    "getAction",
    "insertAction",
    "updateAction",
    "reconcileRuleActions",
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
        const actionId = dedupe.get(key);
        const existing = actions.get(actionId);
        if (existing.status === "OPEN") {
          const updated = {
            ...action,
            actionId: existing.actionId,
            status: existing.status,
            completedAt: existing.completedAt,
            createdAt: existing.createdAt,
          };
          actions.set(actionId, updated);
          return { action: updated, created: false };
        }
        return { action: existing, created: false };
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
    async reconcileRuleActions({ farmId, cropId, seasonId, activeRuleIds, updatedAt }) {
      const active = new Set(activeRuleIds);
      const cancelled = [];
      for (const [actionId, action] of actions) {
        if (
          action.farmId === farmId &&
          action.cropId === cropId &&
          action.seasonId === seasonId &&
          action.origin === "RULE" &&
          action.status === "OPEN" &&
          !active.has(action.ruleId)
        ) {
          const next = { ...action, status: "CANCELLED", updatedAt };
          actions.set(actionId, next);
          cancelled.push(next);
        }
      }
      return { cancelled };
    },
  };
}
