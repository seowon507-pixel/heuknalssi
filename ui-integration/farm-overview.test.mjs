import assert from "node:assert/strict";
import test from "node:test";
import { mergeTodayActionPlans } from "./farm-overview.mjs";

function action(actionId, cropId, dueAt, status = "OPEN") {
  return { actionId, cropId, dueAt, status };
}

test("복수 품목의 오늘 할 일은 기한순으로 합치고 원래 품목 저장 범위를 보존한다", () => {
  const apple = action("apple-action", "crop-apple", "2026-08-03T10:00:00+09:00");
  const pear = action("pear-action", "crop-pear", "2026-08-03T08:00:00+09:00");
  const merged = mergeTodayActionPlans([
    {
      analysis: { analysisId: "analysis-apple" },
      scope: { farmId: "farm-1", cropId: "crop-apple" },
      plan: { today: [apple] },
    },
    {
      analysis: { analysisId: "analysis-pear" },
      scope: { farmId: "farm-1", cropId: "crop-pear" },
      plan: { today: [pear] },
    },
  ]);

  assert.deepEqual(merged.plan.today.map(({ actionId }) => actionId), [
    "pear-action",
    "apple-action",
  ]);
  assert.equal(merged.plan.firstAction.actionId, "pear-action");
  assert.equal(merged.actionTargets.get("apple-action").scope.cropId, "crop-apple");
  assert.equal(merged.actionTargets.get("pear-action").scope.cropId, "crop-pear");
});

test("서로 다른 품목에서 같은 행동 ID가 오면 잘못된 저장을 막는다", () => {
  assert.throws(
    () => mergeTodayActionPlans([
      {
        analysis: { analysisId: "analysis-apple" },
        scope: { farmId: "farm-1", cropId: "crop-apple" },
        plan: { today: [action("same-id", "crop-apple", "2026-08-03T08:00:00+09:00")] },
      },
      {
        analysis: { analysisId: "analysis-pear" },
        scope: { farmId: "farm-1", cropId: "crop-pear" },
        plan: { today: [action("same-id", "crop-pear", "2026-08-03T09:00:00+09:00")] },
      },
    ]),
    /unique across crops/u,
  );
});
