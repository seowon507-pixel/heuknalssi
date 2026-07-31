import assert from "node:assert/strict";
import test from "node:test";

import { createActionPlanRepository } from "../src/infrastructure/action-plan-repository.js";
import { TtlMemoryStore } from "../src/infrastructure/ttl-memory-store.js";

const action = Object.freeze({
  actionId: "action-1",
  ruleId: "apple.rain.v1",
  farmId: "farm-1",
  cropId: "crop-1",
  seasonId: "season-1",
  title: "배수로 확인",
  instruction: "막힌 곳을 확인합니다.",
  reason: "강한 비가 예보됐습니다.",
  horizon: "TODAY",
  status: "OPEN",
  dueAt: "2026-07-31T23:00:00.000Z",
  recheckAt: "2026-08-01T03:00:00.000Z",
  evidenceRefs: [{ sourceKind: "PUBLIC_API", sourceId: "forecast" }],
  origin: "RULE",
  completedAt: null,
  createdAt: "2026-07-31T10:00:00.000Z",
  updatedAt: "2026-07-31T10:00:00.000Z",
});

function repository() {
  return createActionPlanRepository({
    store: new TtlMemoryStore({ clock: () => Date.parse("2026-07-31T10:00:00Z") }),
  });
}

test("action repository atomically replays idempotent and rule duplicates", async () => {
  const repo = repository();
  const first = await repo.insertAction({
    accountId: "account-1",
    farmId: "farm-1",
    action,
    idempotencyKey: "request-1",
    ruleDedupeKey: "rule-1",
  });
  const replay = await repo.insertAction({
    accountId: "account-1",
    farmId: "farm-1",
    action: { ...action, actionId: "action-2" },
    idempotencyKey: "request-2",
    ruleDedupeKey: "rule-1",
  });
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.action.actionId, "action-1");
  assert.equal((await repo.listActions({ accountId: "account-1", farmId: "farm-1" })).length, 1);
});

test("action repository enforces account scope and optimistic updates", async () => {
  const repo = repository();
  await repo.insertAction({
    accountId: "account-1",
    farmId: "farm-1",
    action,
    idempotencyKey: "request-1",
    ruleDedupeKey: null,
  });
  assert.equal(
    await repo.getAction({ accountId: "account-2", farmId: "farm-1", actionId: "action-1" }),
    null,
  );
  const updated = { ...action, status: "DONE", completedAt: "2026-07-31T10:15:00.000Z", updatedAt: "2026-07-31T10:15:00.000Z" };
  await repo.updateAction({
    accountId: "account-1",
    farmId: "farm-1",
    action: updated,
    expectedUpdatedAt: action.updatedAt,
    idempotencyKey: "request-2",
  });
  await assert.rejects(
    () => repo.updateAction({
      accountId: "account-1",
      farmId: "farm-1",
      action: { ...updated, updatedAt: "2026-07-31T10:20:00.000Z" },
      expectedUpdatedAt: action.updatedAt,
      idempotencyKey: "request-3",
    }),
    { code: "ACTION_UPDATE_CONFLICT" },
  );
});

test("action repository atomically refreshes an OPEN rule action with current evidence", async () => {
  const repo = repository();
  await repo.insertAction({
    accountId: "account-1",
    farmId: "farm-1",
    action,
    idempotencyKey: "request-1",
    ruleDedupeKey: "rule-1",
  });
  const refreshed = await repo.insertAction({
    accountId: "account-1",
    farmId: "farm-1",
    action: {
      ...action,
      actionId: "action-2",
      instruction: "새로 관측된 강수량을 기준으로 배수로를 다시 확인합니다.",
      reason: "예보 발표 후 강수량이 증가했습니다.",
      evidenceRefs: [{ sourceKind: "PUBLIC_API", sourceId: "forecast-updated" }],
      recheckAt: "2026-08-01T06:00:00.000Z",
      createdAt: "2026-07-31T11:00:00.000Z",
      updatedAt: "2026-07-31T11:00:00.000Z",
    },
    idempotencyKey: "request-2",
    ruleDedupeKey: "rule-1",
  });

  assert.equal(refreshed.created, false);
  assert.equal(refreshed.action.actionId, "action-1");
  assert.equal(refreshed.action.createdAt, action.createdAt);
  assert.equal(refreshed.action.updatedAt, "2026-07-31T11:00:00.000Z");
  assert.match(refreshed.action.reason, /강수량이 증가/);
  assert.equal(refreshed.action.evidenceRefs[0].sourceId, "forecast-updated");
  assert.equal(
    (await repo.listActions({ accountId: "account-1", farmId: "farm-1" })).length,
    1,
  );
});

test("action repository never overwrites a completed rule action", async () => {
  const repo = repository();
  const done = {
    ...action,
    status: "DONE",
    completedAt: "2026-07-31T10:15:00.000Z",
    updatedAt: "2026-07-31T10:15:00.000Z",
  };
  await repo.insertAction({
    accountId: "account-1",
    farmId: "farm-1",
    action: done,
    idempotencyKey: "request-1",
    ruleDedupeKey: "rule-1",
  });
  const duplicate = await repo.insertAction({
    accountId: "account-1",
    farmId: "farm-1",
    action: {
      ...action,
      actionId: "action-2",
      instruction: "완료된 행동을 덮어쓰면 안 됩니다.",
      updatedAt: "2026-07-31T11:00:00.000Z",
    },
    idempotencyKey: "request-2",
    ruleDedupeKey: "rule-1",
  });

  assert.equal(duplicate.created, false);
  assert.equal(duplicate.action.status, "DONE");
  assert.equal(duplicate.action.instruction, done.instruction);
  assert.equal(duplicate.action.updatedAt, done.updatedAt);
});

test("action repository moves the same OPEN risk rule to its latest forecast date", async () => {
  const repo = repository();
  await repo.insertAction({
    accountId: "account-1",
    farmId: "farm-1",
    action,
    idempotencyKey: "request-1",
    ruleDedupeKey: "stable-risk-rule",
  });
  const moved = await repo.insertAction({
    accountId: "account-1",
    farmId: "farm-1",
    action: {
      ...action,
      actionId: "action-2",
      dueAt: "2026-08-02T21:00:00.000Z",
      recheckAt: "2026-08-04T23:00:00.000Z",
      evidenceRefs: [{ sourceKind: "PUBLIC_API", sourceId: "forecast-moved" }],
      updatedAt: "2026-07-31T12:00:00.000Z",
    },
    idempotencyKey: "request-2",
    ruleDedupeKey: "stable-risk-rule",
  });

  assert.equal(moved.created, false);
  assert.equal(moved.action.actionId, "action-1");
  assert.equal(moved.action.dueAt, "2026-08-02T21:00:00.000Z");
  assert.equal(moved.action.evidenceRefs[0].sourceId, "forecast-moved");
  assert.equal(
    (await repo.listActions({ accountId: "account-1", farmId: "farm-1" })).length,
    1,
  );
});

test("rule reconciliation cancels only disappeared OPEN system rules and preserves terminal/user actions", async () => {
  const repo = repository();
  const actions = [
    action,
    { ...action, actionId: "active", ruleId: "apple.heat.v1" },
    {
      ...action,
      actionId: "done",
      ruleId: "apple.frost.v1",
      status: "DONE",
      completedAt: "2026-07-31T10:15:00.000Z",
      updatedAt: "2026-07-31T10:15:00.000Z",
    },
    { ...action, actionId: "user", ruleId: null, origin: "USER" },
  ];
  for (const [index, item] of actions.entries()) {
    await repo.insertAction({
      accountId: "account-1",
      farmId: "farm-1",
      action: item,
      idempotencyKey: `seed-${index}`,
      ruleDedupeKey: item.origin === "RULE" ? `rule-${index}` : null,
    });
  }

  const result = await repo.reconcileRuleActions({
    accountId: "account-1",
    farmId: "farm-1",
    cropId: "crop-1",
    seasonId: "season-1",
    activeRuleIds: ["apple.heat.v1"],
    updatedAt: "2026-07-31T12:00:00.000Z",
    idempotencyKey: "reconcile-1",
  });
  const replay = await repo.reconcileRuleActions({
    accountId: "account-1",
    farmId: "farm-1",
    cropId: "crop-1",
    seasonId: "season-1",
    activeRuleIds: [],
    updatedAt: "2026-07-31T13:00:00.000Z",
    idempotencyKey: "reconcile-1",
  });

  assert.deepEqual(result, replay);
  assert.deepEqual(result.cancelled.map(({ actionId }) => actionId), ["action-1"]);
  const stored = await repo.listActions({ accountId: "account-1", farmId: "farm-1" });
  assert.equal(stored.find(({ actionId }) => actionId === "action-1").status, "CANCELLED");
  assert.equal(stored.find(({ actionId }) => actionId === "active").status, "OPEN");
  assert.equal(stored.find(({ actionId }) => actionId === "done").status, "DONE");
  assert.equal(stored.find(({ actionId }) => actionId === "user").status, "OPEN");
});
