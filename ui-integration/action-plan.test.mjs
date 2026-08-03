import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_PLAN_STYLES,
  buildActionPlanView,
  composeForecastActionReason,
  compressWeeklyRisks,
  filterWeeklyRisksForOpenAction,
  formatActionDueLabel,
  formatActionDueLabelForAction,
  groupWeeklyRiskRanges,
  mountActionPlan,
  nextSeoulMorning,
  renderActionPlanMarkup,
} from "./action-plan.mjs";

function action(overrides = {}) {
  return {
    actionId: "action-today",
    farmId: "farm-a",
    cropId: "crop-apple",
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
  assert.equal(view.firstAction.badge, "우선");
  assert.equal(view.sections[0].heading, "오늘 할 일");
  assert.equal(view.sections[1].heading, "당분간 주의");
  assert.equal(view.sections[1].items[0].actionId, "action-upcoming");
});

test("오늘 행동이 없으면 예정 행동을 오늘의 우선 행동으로 표시하지 않는다", () => {
  const upcoming = action({
    actionId: "action-upcoming",
    title: "내일 아침 다시 확인하세요",
    horizon: "UPCOMING",
    dueAt: "2026-08-04T22:00:00.000Z",
  });
  const view = buildActionPlanView({
    firstAction: upcoming,
    today: [],
    upcoming: [upcoming],
  });

  assert.equal(view.firstAction, null);
  assert.equal(view.sections[0].items.length, 0);
  assert.equal(view.sections[1].items[0].actionId, "action-upcoming");
});

test("사용자 화면은 실제 행동·이유·기한·대상·재확인·근거를 함께 보여주고 내부 코드를 숨긴다", () => {
  const markup = renderActionPlanMarkup({
    firstAction: action(),
    today: [action()],
    upcoming: [],
  });

  assert.match(markup, /우선/);
  assert.match(markup, /물이 고인 곳과 막힌 배수로가 있는지 직접 확인하세요/);
  assert.match(markup, /오늘 강수 예보가 확인되었습니다/);
  assert.match(markup, />위험</);
  assert.match(markup, />할 일</);
  assert.match(markup, /기한/);
  assert.match(markup, /대상/);
  assert.match(markup, /사과 농장/);
  assert.match(markup, /재확인/);
  assert.match(markup, /공공자료/);
  assert.match(markup, /action-plan__quick-meta/);
  assert.match(markup, /추가로 등록된 오늘 행동이 없습니다/);
  assert.match(markup, /data-action-status="DONE"/);
  assert.match(markup, /data-action-status="SKIPPED"/);
  assert.match(markup, /data-action-snooze="NEXT_MORNING"/);
  assert.doesNotMatch(markup, /INTERNAL_CODE_MUST_STAY_HIDDEN|forecast-a/);
  assert.doesNotMatch(markup, /종합점수|총점|compositeScore/);
});

test("내일 다시 알림은 서울 기준 다음 날 오전 7시로 저장 요청한다", async () => {
  let clickHandler = null;
  let received = null;
  const now = new Date("2026-08-03T06:30:00.000Z");
  const root = {
    innerHTML: "",
    addEventListener(type, handler) {
      if (type === "click") clickHandler = handler;
    },
    removeEventListener() {},
    contains() { return true; },
  };
  const button = {
    disabled: false,
    dataset: {
      actionId: "action-today",
      actionSnooze: "NEXT_MORNING",
    },
    closest() { return this; },
  };
  mountActionPlan(root, { firstAction: action(), today: [action()], upcoming: [] }, {
    now,
    onSnooze(payload) { received = payload; },
  });

  await clickHandler({ target: button });

  assert.deepEqual(received, {
    actionId: "action-today",
    snoozedUntil: "2026-08-03T22:00:00.000Z",
  });
  assert.equal(nextSeoulMorning(now), "2026-08-03T22:00:00.000Z");
  assert.equal(button.disabled, false);
});

test("조건과 위험을 구분할 수 있는 이유 문장은 원인과 위험으로 나눠 표시한다", () => {
  const markup = renderActionPlanMarkup({
    firstAction: action({
      reason: "최고기온이 30℃ 이상이면 과실 햇볕 데임 위험이 커집니다.",
    }),
    today: [],
    upcoming: [],
  });

  assert.match(markup, />원인</);
  assert.match(markup, /최고기온이 30℃ 이상이면/);
  assert.match(markup, /과실 햇볕 데임 위험이 커집니다/);
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

test("행동 계획은 런타임 스타일을 삽입하지 않고 48px 완료 조작을 사용한다", () => {
  const markup = renderActionPlanMarkup({
    firstAction: action(),
    today: [action()],
    upcoming: [],
  });
  assert.doesNotMatch(markup, /<style>/);
  assert.match(markup, /action-plan__complete/);
  assert.match(markup, /action-plan__check/);
  assert.match(ACTION_PLAN_STYLES, /min-height:\s*48px/);
});

test("행동 상태 저장 실패는 화면 콜백으로 전달하고 버튼을 다시 활성화한다", async () => {
  let clickHandler = null;
  let received = null;
  const root = {
    innerHTML: "",
    addEventListener(type, handler) {
      if (type === "click") clickHandler = handler;
    },
    removeEventListener() {},
    contains() { return true; },
  };
  const button = {
    disabled: false,
    dataset: { actionId: "action-today", actionStatus: "DONE" },
    closest() { return this; },
  };
  mountActionPlan(
    root,
    { firstAction: action(), today: [action()], upcoming: [] },
    {
      async onStatusChange() { throw new Error("SAVE_FAILED"); },
      onStatusError(payload) { received = payload; },
    },
  );

  await clickHandler({ target: button });

  assert.equal(received.actionId, "action-today");
  assert.equal(received.status, "DONE");
  assert.match(received.error.message, /SAVE_FAILED/);
  assert.equal(button.disabled, false);
});

test("기한이 지난 열린 행동은 정상 날짜 대신 지금 확인할 지연 항목으로 표시한다", () => {
  const now = new Date("2026-08-01T00:00:00.000Z");
  const markup = renderActionPlanMarkup(
    {
      firstAction: action({ dueAt: "2026-07-31T09:00:00.000Z" }),
      today: [action({ dueAt: "2026-07-31T09:00:00.000Z" })],
      upcoming: [],
    },
    { now },
  );

  assert.match(markup, /지연됨 · 지금 확인/);
  assert.equal(
    formatActionDueLabel("2026-08-02T00:00:00.000Z", { now }),
    "8월 2일 09:00",
  );
});

test("현재 열린 행동과 같은 위험은 이번 주 주의에서 반복하지 않는다", () => {
  const risks = [
    { riskId: "heat-aug-01", ruleId: "apple.heat.v1" },
    { riskId: "rain-aug-03", ruleId: "apple.rain.v1" },
  ];
  const plan = {
    firstAction: action({
      ruleId: "apple.heat.v1",
      evidenceRefs: [
        { ...action().evidenceRefs[0], sourceId: "heat-aug-01" },
      ],
    }),
  };

  assert.deepEqual(filterWeeklyRisksForOpenAction(risks, plan), [risks[1]]);
  assert.deepEqual(
    filterWeeklyRisksForOpenAction([risks[0]], plan),
    [],
  );
});

test("원자료 조건과 위험 설명이 두 문장이면 원인과 위험으로 나눠 표시한다", () => {
  const markup = renderActionPlanMarkup({
    firstAction: action({
      reason:
        "8월 1일 최고기온 34℃ · 주의 기준 30℃ 이상입니다. 과실 햇볕 데임 위험이 커집니다.",
    }),
    today: [],
    upcoming: [],
  });

  assert.match(markup, />원인</);
  assert.match(markup, /8월 1일 최고기온 34℃/);
  assert.match(markup, />위험</);
  assert.match(markup, /과실 햇볕 데임 위험이 커집니다/);
});

test("NOW 폴백 행동은 4시간 확인 창을 주고 실제 예방기한은 즉시 지연으로 표시한다", () => {
  const now = new Date("2026-08-01T00:05:00.000Z");
  const immediate = action({
    ruleId: "confirm-season",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    dueAt: "2026-07-31T23:59:55.000Z",
  });
  const preventive = action({
    ruleId: "apple.forecast.heat.v2",
    createdAt: "2026-08-01T00:00:00.000Z",
    dueAt: "2026-08-01T00:00:00.000Z",
  });

  assert.equal(formatActionDueLabelForAction(immediate, { now }), "지금 확인");
  assert.equal(
    formatActionDueLabelForAction(immediate, {
      now: new Date("2026-08-01T04:01:00.000Z"),
    }),
    "지연됨 · 지금 확인",
  );
  assert.equal(
    formatActionDueLabelForAction(preventive, { now }),
    "지연됨 · 지금 확인",
  );
});

test("같은 날짜범위와 metric의 중복 규칙만 한 주간 위험으로 압축한다", () => {
  const heatA = {
    riskId: "heat-a",
    ruleId: "apple.heat.a",
    dateRange: { from: "2026-08-01", to: "2026-08-02" },
    trigger: { metric: "maxTemperature" },
  };
  const heatB = { ...heatA, riskId: "heat-b", ruleId: "apple.heat.b" };
  const rain = {
    ...heatA,
    riskId: "rain-a",
    ruleId: "apple.rain.a",
    trigger: { metric: "precipitationProbability" },
  };
  const laterHeat = {
    ...heatA,
    riskId: "heat-later",
    dateRange: { from: "2026-08-03", to: "2026-08-03" },
  };

  assert.deepEqual(
    compressWeeklyRisks([heatA, heatB, rain, laterHeat]),
    [heatA, rain, laterHeat],
  );
  assert.deepEqual(
    groupWeeklyRiskRanges([heatA, heatB, rain, laterHeat]),
    [
      { ...heatA, dateRange: { from: "2026-08-01", to: "2026-08-03" } },
      rain,
    ],
  );
});

test("실제 예보 원인과 위험 문장에 같은 기준값을 반복하지 않는다", () => {
  const reason = composeForecastActionReason(
    "8월 1일 최고기온 34℃ · 주의 기준 30℃ 이상",
    "최고기온이 30℃ 이상이면 과실 햇볕 데임 위험이 커집니다.",
  );

  assert.equal(
    reason,
    "8월 1일 최고기온 34℃ · 주의 기준 30℃ 이상. 과실 햇볕 데임 위험이 커집니다.",
  );
  assert.equal(reason.match(/30℃/g)?.length, 1);
});
