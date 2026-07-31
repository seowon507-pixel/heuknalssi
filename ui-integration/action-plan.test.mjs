import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_PLAN_STYLES,
  buildActionPlanView,
  renderActionPlanMarkup,
} from "./action-plan.mjs";

function action(overrides = {}) {
  return {
    actionId: "action-today",
    farmId: "farm-a",
    cropId: "crop-a",
    seasonId: "season-a",
    title: "배수로를 먼저 확인하세요",
    instruction: "물이 고인 곳과 막힌 배수로가 있는지 직접 확인하세요.",
    reason: "오늘 강수 예보가 확인되었습니다.",
    horizon: "TODAY",
    status: "OPEN",
    dueAt: "2026-07-31T09:00:00.000Z",
    recheckAt: "2026-08-01T00:00:00.000Z",
    evidenceRefs: [
      {
        sourceKind: "PUBLIC_API",
        sourceId: "forecast-a",
        observedAt: "2026-07-31T00:00:00.000Z",
        fetchedAt: "2026-07-31T00:01:00.000Z",
        spatialLevel: "FIELD_NEARBY_GRID",
        state: "READY",
        limitationCodes: ["INTERNAL_CODE_MUST_STAY_HIDDEN"],
      },
    ],
    origin: "RULE",
    completedAt: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

test("첫 열린 행동은 별도 강조하고 오늘/당분간을 분리한다", () => {
  const view = buildActionPlanView({
    firstAction: action(),
    today: [action()],
    upcoming: [
      action({
        actionId: "action-upcoming",
        title: "다음 예보를 다시 확인하세요",
        horizon: "UPCOMING",
      }),
    ],
  });

  assert.equal(view.firstAction.actionId, "action-today");
  assert.equal(view.firstAction.badge, "가장 먼저 할 일");
  assert.equal(view.sections[0].heading, "오늘 할 일");
  assert.equal(view.sections[1].heading, "당분간 주의");
  assert.equal(view.sections[1].items[0].actionId, "action-upcoming");
});

test("사용자 화면은 실제 행동·이유·기한·재확인·근거를 함께 보여주고 내부 코드를 숨긴다", () => {
  const markup = renderActionPlanMarkup({
    firstAction: action(),
    today: [action()],
    upcoming: [],
  });

  assert.match(markup, /가장 먼저 할 일/);
  assert.match(markup, /물이 고인 곳과 막힌 배수로가 있는지 직접 확인하세요/);
  assert.match(markup, /오늘 강수 예보가 확인되었습니다/);
  assert.match(markup, /기한/);
  assert.match(markup, /재확인/);
  assert.match(markup, /공공자료/);
  assert.match(markup, /추가로 등록된 오늘 행동이 없습니다/);
  assert.match(markup, /data-action-status="DONE"/);
  assert.match(markup, /data-action-status="SKIPPED"/);
  assert.doesNotMatch(markup, /INTERNAL_CODE_MUST_STAY_HIDDEN|forecast-a/);
  assert.doesNotMatch(markup, /종합점수|총점|compositeScore/);
});

test("완료/건너뜀 항목은 상태만 표시하고 재실행 버튼을 만들지 않는다", () => {
  const markup = renderActionPlanMarkup({
    firstAction: null,
    today: [action({ status: "DONE", completedAt: "2026-07-31T02:00:00.000Z" })],
    upcoming: [action({ actionId: "skip", status: "SKIPPED", horizon: "UPCOMING" })],
  });

  assert.match(markup, /완료</);
  assert.match(markup, /건너뜀</);
  assert.doesNotMatch(markup, /data-action-status=/);
});

test("사용자에게 같은 종류·시각·상태의 근거를 반복해서 보여주지 않는다", () => {
  const duplicate = action().evidenceRefs[0];
  const markup = renderActionPlanMarkup({
    firstAction: action({ evidenceRefs: [duplicate, { ...duplicate, sourceId: "forecast-b" }] }),
    today: [],
    upcoming: [],
  });

  assert.equal(markup.match(/공공자료/g)?.length, 1);
});

test("문구는 HTML로 실행되지 않도록 이스케이프한다", () => {
  const markup = renderActionPlanMarkup({
    firstAction: action({ title: '<img src=x onerror="alert(1)">' }),
    today: [action({ title: '<img src=x onerror="alert(1)">' })],
    upcoming: [],
  });

  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, /&lt;img/);
});

test("독립 스타일은 모바일에서도 첫 행동과 44px 상태 버튼을 유지한다", () => {
  assert.match(ACTION_PLAN_STYLES, /\.action-plan__first/);
  assert.match(ACTION_PLAN_STYLES, /min-height:\s*44px/);
  assert.match(ACTION_PLAN_STYLES, /@media\s*\(max-width:\s*620px\)/);
});
