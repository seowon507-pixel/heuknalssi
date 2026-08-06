import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptRefinedDraft,
  auditDraftText,
  buildDiaryDraft,
  buildEnvironmentScene,
  checkinUniqueKey,
  correctCheckin,
  createCheckin,
  deleteCheckin,
  resolveStage,
  saveDiaryEntry,
  summarizeCheckins,
  summarizeFarmCoverage,
  toPublicCheckin,
} from "../src/domain/index.js";

const TODAY = "2026-08-04";
const NOW = "2026-08-04T09:15:00.000Z";
const USER = "user-1";
const FARM = "farm-1";

function checkin(overrides = {}) {
  return createCheckin({
    userId: USER,
    farmId: FARM,
    localDate: TODAY,
    today: TODAY,
    checkinType: "FIELD_VISIT",
    clientRequestId: "req-1",
    checkedAt: NOW,
    ...overrides,
  });
}

function risk(metric, severity = "WARNING", riskId = `${metric}:1`) {
  return { riskId, severity, trigger: { metric, unit: "mm", readings: [] } };
}

/* ── 출석 ───────────────────────────────────────────────────── */

test("출석은 농장·날짜 조합 하나로 식별된다", () => {
  const record = checkin();
  assert.equal(record.status, "ACTIVE");
  assert.equal(
    checkinUniqueKey(record),
    checkinUniqueKey({ userId: USER, farmId: FARM, localDate: TODAY }),
  );
});

test("미래 날짜 출석은 만들 수 없다", () => {
  assert.throws(
    () => checkin({ localDate: "2026-08-05" }),
    (error) => error.code === "CHECKIN_FUTURE_DATE",
  );
});

test("과거 날짜에는 출석을 만들지 않는다. 일기는 별개로 허용된다", () => {
  assert.throws(
    () => checkin({ localDate: "2026-08-01" }),
    (error) => error.code === "CHECKIN_PAST_DATE",
  );
  const draft = buildDiaryDraft({ farmId: FARM, entryDate: "2026-08-01", userNote: "그날 메모" });
  assert.equal(draft.entryDate, "2026-08-01");
  assert.equal(draft.body.includes("그날 메모"), true);
});

test("원격 확인이 현장 방문으로 표시되지 않는다", () => {
  const remote = toPublicCheckin(checkin({ checkinType: "REMOTE_CHECK" }));
  assert.equal(remote.visitedInPerson, false);
  assert.equal(remote.checkinTypeLabelKo, "원격 확인");

  const field = toPublicCheckin(checkin());
  assert.equal(field.visitedInPerson, true);
  assert.equal(field.checkinTypeLabelKo, "현장 확인");
});

test("수정은 CORRECTED 가 되고 확인 시각은 보존된다", () => {
  const corrected = correctCheckin(checkin(), { checkinType: "REMOTE_CHECK", note: "비 와서 원격" }, {
    now: "2026-08-04T12:00:00.000Z",
  });
  assert.equal(corrected.status, "CORRECTED");
  assert.equal(corrected.checkedAt, NOW, "언제 확인했는지는 사실이므로 바뀌지 않는다");
  assert.equal(corrected.note, "비 와서 원격");
});

test("삭제는 이력을 남기고, 삭제된 출석은 다시 되돌릴 수 없다", () => {
  const removed = deleteCheckin(checkin(), { now: NOW });
  assert.equal(removed.status, "DELETED");
  assert.throws(
    () => correctCheckin(removed, {}, { now: NOW }),
    (error) => error.code === "CHECKIN_TRANSITION_INVALID",
  );
});

test("삭제된 출석은 화면에서 미출석으로 보인다", () => {
  const summary = summarizeCheckins({
    farmId: FARM,
    today: TODAY,
    records: [deleteCheckin(checkin(), { now: NOW })],
  });
  assert.equal(summary.displayState, "NOT_CHECKED");
  assert.equal(summary.todayCheckin, null);
  assert.equal(summary.monthlyCheckedDays, 0);
});

test("두 농장의 출석은 서로 영향을 주지 않는다", () => {
  const records = [
    checkin(),
    { ...checkin({ farmId: "farm-2", clientRequestId: "req-2" }) },
  ];
  const first = summarizeCheckins({ farmId: FARM, today: TODAY, records });
  const second = summarizeCheckins({ farmId: "farm-2", today: TODAY, records });
  const third = summarizeCheckins({ farmId: "farm-3", today: TODAY, records });

  assert.equal(first.displayState, "CHECKED");
  assert.equal(second.displayState, "CHECKED");
  assert.equal(third.displayState, "NOT_CHECKED", "출석이 다른 농장으로 복사되지 않는다");
  assert.equal(first.streakDays, 1);
});

test("연속 기록은 농장별로 세고 이번 달 기록일을 함께 준다", () => {
  const records = ["2026-08-02", "2026-08-03", "2026-08-04", "2026-07-30"].map((localDate) => ({
    ...checkin(),
    localDate,
  }));
  const summary = summarizeCheckins({ farmId: FARM, today: TODAY, records });
  assert.equal(summary.streakDays, 3);
  assert.equal(summary.monthlyCheckedDays, 3, "7월 기록은 이번 달에 세지 않는다");
  assert.equal(summary.recentDays.length, 7);
  assert.equal(summary.recentDays.at(-1).isToday, true);
  assert.equal(summary.recentDays.at(-1).checked, true);
});

test("계정 홈은 오늘 확인한 농장 수와 활성 농장 수를 준다", () => {
  const coverage = summarizeFarmCoverage({
    today: TODAY,
    activeFarmIds: [FARM, "farm-2", "farm-3"],
    records: [checkin(), { ...checkin({ farmId: "farm-2", clientRequestId: "r2" }) }],
  });
  assert.equal(coverage.activeFarms, 3);
  assert.equal(coverage.checkedFarms, 2);
});

test("출석 도메인은 작물 점수나 예보 판정을 읽지 않는다", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/domain/checkin.js", import.meta.url), "utf8"),
  );
  for (const forbidden of ["growth-score", "forecast.js", "soil.js", "climate.js", "suitability"]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `출석은 ${forbidden} 에 의존하면 안 된다`,
    );
  }
});

/* ── 환경 장면 ──────────────────────────────────────────────── */

test("장면 우선순위대로 주요 원인 하나와 보조 하나만 고른다", () => {
  const scene = buildEnvironmentScene({
    cropId: "CUCUMBER",
    stage: { stage: 3, source: "USER_CONFIRMED" },
    forecastRisks: [risk("MAX_TEMPERATURE"), risk("WIND_SPEED"), risk("PRECIPITATION")],
  });
  assert.equal(scene.environment.state, "TYPHOON", "강풍과 강한 비가 함께 경고면 태풍이다");
  assert.equal(scene.environment.effects.length <= 3, true);
  assert.ok(scene.environment.secondaryState !== scene.environment.state);
});

test("경고가 아닌 비는 주의로 올리지 않는다", () => {
  const mild = buildEnvironmentScene({
    cropId: "LETTUCE",
    stage: { stage: 2, source: "USER_CONFIRMED" },
    forecastRisks: [risk("PRECIPITATION", "CAUTION")],
  });
  assert.equal(mild.environment.state, "RAIN");
  assert.equal(mild.environment.labelKo, "비");

  const severe = buildEnvironmentScene({
    cropId: "LETTUCE",
    stage: { stage: 2, source: "USER_CONFIRMED" },
    forecastRisks: [risk("PRECIPITATION", "WARNING")],
  });
  assert.equal(severe.environment.state, "HEAVY_RAIN");
  assert.equal(severe.environment.labelKo, "주의 · 강수");
});

test("고온 예보만으로 식물을 시들게 만들지 않는다", () => {
  const scene = buildEnvironmentScene({
    cropId: "POTATO",
    stage: { stage: 4, source: "USER_CONFIRMED" },
    forecastRisks: [risk("MAX_TEMPERATURE")],
  });
  assert.equal(scene.environment.state, "HIGH_HEAT");
  assert.equal(scene.motion.plant, "BREATHE", "숨 쉬는 움직임까지만 허용된다");
  assert.equal(scene.observedPlantState, null);
  assert.equal(scene.plantAsset, "plant-potato-stage-4", "그림은 단계만으로 결정된다");
});

test("같은 단계면 날씨가 달라도 식물 그림이 같다", () => {
  const stage = { stage: 5, source: "USER_CONFIRMED" };
  const stormy = buildEnvironmentScene({ cropId: "APPLE", stage, forecastRisks: [risk("PRECIPITATION")] });
  const calm = buildEnvironmentScene({ cropId: "APPLE", stage, forecastRisks: [] });
  assert.equal(stormy.plantAsset, calm.plantAsset);
  assert.notEqual(stormy.environment.state, calm.environment.state);
});

test("잎 상태 표현은 사용자가 고른 관찰이 있을 때만 실린다", () => {
  const observed = buildEnvironmentScene({
    cropId: "CUCUMBER",
    stage: { stage: 3, source: "USER_SELECTED_WITH_PHOTO" },
    forecastRisks: [],
    observedPlantState: { kind: "USER_SELECTED", noteKo: "아래 잎이 처졌어요" },
  });
  assert.equal(observed.observedPlantState.kind, "USER_SELECTED");
  assert.equal(observed.stage.estimated, false);
});

test("날짜로 계산한 단계에는 예상 표시가 붙는다", () => {
  const estimated = resolveStage({ stage: 2, source: "ESTIMATED_FROM_SCHEDULE" });
  assert.equal(estimated.estimated, true);
  assert.equal(estimated.labelKo, "새롭게 돋아나는 중");

  const confirmed = resolveStage({ stage: 2, source: "USER_CONFIRMED" });
  assert.equal(confirmed.estimated, false);
});

test("단계 정보가 없으면 그림을 고르지 않고 설정을 요청한다", () => {
  const scene = buildEnvironmentScene({ cropId: "PEAR", stage: {}, forecastRisks: [] });
  assert.equal(scene.plantAsset, null);
  assert.equal(scene.stage.needsSetup, true);
  assert.equal(scene.stage.labelKo, null);
});

test("자료가 없으면 맑음으로 위장하지 않고 중립 배경을 쓴다", () => {
  const scene = buildEnvironmentScene({
    cropId: "APPLE",
    stage: { stage: 1, source: "USER_CONFIRMED" },
    forecastRisks: [],
    todayForecast: null,
  });
  assert.equal(scene.environment.known, false);
  assert.equal(scene.environment.state, "NEUTRAL");
  assert.equal(scene.environment.background, "NEUTRAL");
  assert.equal(scene.motion.particles, 0);
});

test("위험이 없으면 검증된 예보값으로만 바탕 장면을 정한다", () => {
  const rainy = buildEnvironmentScene({
    cropId: "APPLE",
    stage: { stage: 3, source: "USER_CONFIRMED" },
    todayForecast: { PRECIPITATION: 4 },
  });
  assert.equal(rainy.environment.state, "RAIN");

  const cloudy = buildEnvironmentScene({
    cropId: "APPLE",
    stage: { stage: 3, source: "USER_CONFIRMED" },
    todayForecast: { PRECIPITATION: 0, cloudCover: 80 },
  });
  assert.equal(cloudy.environment.state, "CLOUDY");
});

test("표에 없는 metric 은 추측하지 않고 드러낸다", () => {
  const scene = buildEnvironmentScene({
    cropId: "CUCUMBER",
    stage: { stage: 3, source: "USER_CONFIRMED" },
    forecastRisks: [risk("UNKNOWN_METRIC_XYZ")],
  });
  assert.deepEqual(scene.unmappedMetrics, ["UNKNOWN_METRIC_XYZ"]);
  assert.equal(scene.environment.known, false, "모르는 신호로 장면을 만들지 않는다");
});

test("상태·원인·행동 문구는 백엔드 판정을 그대로 쓴다", () => {
  const scene = buildEnvironmentScene({
    cropId: "POTATO",
    stage: { stage: 4, source: "USER_CONFIRMED" },
    forecastRisks: [risk("PRECIPITATION")],
    riskState: "주의",
    primaryCause: { summaryKo: "내일 강수 45mm" },
    primaryAction: { titleKo: "배수 상태 확인" },
  });
  assert.equal(scene.labels.statusKo, "주의");
  assert.equal(scene.labels.causeKo, "내일 강수 45mm");
  assert.equal(scene.labels.actionKo, "배수 상태 확인");
});

test("모션 감소에서는 반복 모션과 입자가 모두 꺼진다", () => {
  const base = {
    cropId: "CUCUMBER",
    stage: { stage: 3, source: "USER_CONFIRMED" },
    forecastRisks: [risk("PRECIPITATION")],
  };
  const full = buildEnvironmentScene(base);
  const lite = buildEnvironmentScene({ ...base, rendering: { lowPower: true } });
  const still = buildEnvironmentScene({ ...base, rendering: { reducedMotion: true } });

  assert.equal(full.motion.quality, "FULL");
  assert.equal(lite.motion.quality, "LITE");
  assert.ok(lite.motion.particles < full.motion.particles);
  assert.equal(still.motion.quality, "STATIC");
  assert.equal(still.motion.particles, 0);
  assert.equal(still.motion.seconds, 0);
  assert.deepEqual(still.environment.effects, []);
  assert.equal(still.environment.state, full.environment.state, "정적이어도 같은 정보를 전달한다");
});

test("다섯 작물만 장면을 만들 수 있다", () => {
  for (const cropId of ["APPLE", "PEAR", "CUCUMBER", "POTATO", "LETTUCE"]) {
    const scene = buildEnvironmentScene({
      cropId,
      stage: { stage: 3, source: "USER_CONFIRMED" },
      forecastRisks: [],
    });
    assert.equal(scene.plantAsset, `plant-${cropId.toLowerCase()}-stage-3`);
  }
  assert.throws(
    () => buildEnvironmentScene({ cropId: "TOMATO", stage: { stage: 1 } }),
    (error) => error.code === "SCENE_CROP_INVALID",
  );
});

/* ── 자동 일기 초안 ─────────────────────────────────────────── */

test("초안은 허용 목록 입력만으로 결정론적으로 만들어진다", () => {
  const input = {
    farmId: FARM,
    entryDate: TODAY,
    checkin: { checkinType: "FIELD_VISIT", localDate: TODAY },
    completedActions: [{ titleKo: "배수로 점검", completedAt: NOW }],
    photos: [{ takenOn: TODAY, cropId: "CUCUMBER" }],
    weatherSnapshot: { summaryKo: "흐리고 비", warningsKo: ["강수 주의"] },
    cropCycleLabels: [{ cropId: "CUCUMBER", stageLabelKo: "잎과 줄기가 자라는 중", estimated: true }],
  };
  const first = buildDiaryDraft(input);
  const second = buildDiaryDraft(input);
  assert.deepEqual(first, second);
  assert.equal(first.draftStatus, "DRAFT");
  assert.equal(first.presentationLabelKo, "자동으로 정리한 초안");
  assert.ok(first.body.includes("농장에 다녀왔어요"));
  assert.ok(first.body.includes("배수로 점검"));
  assert.ok(first.body.includes("(예상 단계)"), "계산된 단계는 예상임을 밝힌다");
  assert.deepEqual(
    first.usedSources.map((row) => row.sourceType),
    ["CHECKIN", "WEATHER_SNAPSHOT", "ACTIONS", "PHOTOS", "CROP_CYCLE"],
  );
});

test("출석하지 않은 날 초안은 현장에 갔다고 쓰지 않는다", () => {
  const draft = buildDiaryDraft({
    farmId: FARM,
    entryDate: TODAY,
    checkin: null,
    weatherSnapshot: { summaryKo: "맑음" },
  });
  assert.equal(draft.body.includes("다녀왔어요"), false);
  assert.equal(draft.usedSources.some((row) => row.sourceType === "CHECKIN"), false);
});

test("원격 확인은 원격이라고 적는다", () => {
  const draft = buildDiaryDraft({
    farmId: FARM,
    entryDate: TODAY,
    checkin: { checkinType: "REMOTE_CHECK", localDate: TODAY },
  });
  assert.ok(draft.body.includes("원격으로 확인했어요"));
  assert.equal(draft.body.includes("다녀왔어요"), false);
});

test("지역 통계와 필지 검사값을 구분해 적는다", () => {
  const regional = buildDiaryDraft({
    farmId: FARM,
    entryDate: TODAY,
    soilReference: { kind: "REGIONAL", summaryKo: "산도가 조금 낮은 편" },
  });
  assert.ok(regional.body.includes("주변 토양 참고"));

  const field = buildDiaryDraft({
    farmId: FARM,
    entryDate: TODAY,
    soilReference: { kind: "FIELD_TEST", summaryKo: "산도 6.2" },
  });
  assert.ok(field.body.includes("내 농장 검사값"));
});

test("금지 표현 검사가 관찰 날조와 처방을 잡는다", () => {
  assert.equal(auditDraftText("잎이 시들었어요").valid, false);
  assert.equal(auditDraftText("탄저병으로 보입니다").valid, false);
  assert.equal(auditDraftText("살균제를 살포하세요").valid, false);
  assert.equal(auditDraftText("비료 20kg 주세요").valid, false);
  assert.equal(auditDraftText("작업을 모두 끝냈습니다").valid, false);
  assert.equal(auditDraftText("농장에 다녀왔어요. 날씨는 흐리고 비였어요.").valid, true);
});

test("AI 가 없던 관찰을 끼워 넣으면 초안을 받지 않는다", () => {
  const draft = buildDiaryDraft({
    farmId: FARM,
    entryDate: TODAY,
    checkin: { checkinType: "FIELD_VISIT", localDate: TODAY },
  });
  const rejected = acceptRefinedDraft(draft, "농장에 다녀왔어요. 잎이 누렇게 변색되었어요.");
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "FORBIDDEN_CLAIM");
  assert.equal(rejected.draft.body, draft.body, "거절되면 템플릿 초안이 그대로 남는다");
});

test("AI 가 없던 숫자를 만들면 사실 추가로 보고 거절한다", () => {
  const draft = buildDiaryDraft({
    farmId: FARM,
    entryDate: TODAY,
    weatherSnapshot: { summaryKo: "흐림" },
  });
  const rejected = acceptRefinedDraft(draft, "날씨는 흐림이었고 강수량은 45mm였어요.");
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "NEW_NUMBERS");
  assert.deepEqual(rejected.introduced, [45]);
});

test("AI 가 문장만 다듬으면 받아들이고 작성 방식을 기록한다", () => {
  const draft = buildDiaryDraft({
    farmId: FARM,
    entryDate: TODAY,
    checkin: { checkinType: "FIELD_VISIT", localDate: TODAY },
    completedActions: [{ titleKo: "배수로 점검", completedAt: NOW }],
  });
  const accepted = acceptRefinedDraft(
    draft,
    "오늘은 농장에 다녀왔어요. 배수로 점검을 했습니다.",
  );
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.draft.authoringMode, "AI_DRAFT_EDITED");
  assert.equal(accepted.draft.draftStatus, "DRAFT", "다듬어도 저장은 사용자가 한다");
});

test("AI 가 실패해도 템플릿 초안과 수동 저장이 동작한다", () => {
  const draft = buildDiaryDraft({
    farmId: FARM,
    entryDate: TODAY,
    checkin: { checkinType: "FIELD_VISIT", localDate: TODAY },
  });
  const failed = acceptRefinedDraft(draft, "");
  assert.equal(failed.accepted, false);
  assert.equal(failed.reason, "EMPTY_REFINEMENT");

  const saved = saveDiaryEntry(failed.draft, { emotionTag: "CALM" }, { now: NOW });
  assert.equal(saved.draftStatus, "SAVED");
  assert.equal(saved.authoringMode, "MANUAL");
  assert.equal(saved.emotionLabelKo, "괜찮아요");
  assert.equal(saved.visibility, "PRIVATE");
});

test("감정 태그는 사용자의 기분이며 작물 상태가 아니다", () => {
  const draft = buildDiaryDraft({ farmId: FARM, entryDate: TODAY, userNote: "괜찮은 하루" });
  const saved = saveDiaryEntry(draft, { emotionTag: "WORRIED" }, { now: NOW });
  assert.equal(saved.emotionTag, "WORRIED");
  assert.equal(Object.hasOwn(saved, "plantCondition"), false);
  assert.throws(
    () => saveDiaryEntry(draft, { emotionTag: "LEAF_WILTING" }, { now: NOW }),
    (error) => error.code === "DIARY_EMOTION_INVALID",
  );
});

test("사용자 메모는 검사에 걸리지 않고 그대로 남는다", () => {
  const draft = buildDiaryDraft({
    farmId: FARM,
    entryDate: TODAY,
    userNote: "아래쪽 잎이 시들어 보여서 걱정된다",
  });
  assert.ok(draft.body.includes("시들어 보여서"), "자기 밭을 자기 말로 적는 것은 막지 않는다");
  assert.equal(draft.generatedBody, "", "생성 문장에는 그 표현이 없다");
});
