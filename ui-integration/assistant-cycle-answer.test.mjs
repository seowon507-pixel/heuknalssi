import assert from "node:assert/strict";
import test from "node:test";

import { buildAssistantCycleAnswer } from "./assistant-cycle-answer.mjs";

const projection = Object.freeze({
  status: "ACTIVE",
  progress: { minPercent: 41, maxPercent: 64, actualBiologicalScore: null },
  currentMilestone: { candidates: [{ label: "한창 자라는 중" }] },
  preparationStartsOn: { earliest: "2026-07-19", latest: "2026-10-15" },
  harvestWindow: { earliest: "2026-08-18", latest: "2026-10-22" },
});

test("재배 진행과 수확 질문은 일정 예상·확인 위치·한계를 직접 설명한다", () => {
  for (const question of [
    "사과 재배 진행률과 수확 준비 시점은 어디에서 확인하나요?",
    "사과는 얼마나 진행됐고 언제 수확해?",
  ]) {
    const answer = buildAssistantCycleAnswer(question, { cropLabel: "사과", projection });
    assert.match(answer, /41~64%/);
    assert.match(answer, /한창 자라는 중/);
    assert.match(answer, /7월 19일~10월 15일/);
    assert.match(answer, /8월 18일~10월 22일/);
    assert.match(answer, /재배 진행.*조건 바꾸기/u);
    assert.match(answer, /실제 생체 상태 점수는 아닙니다/);
  }
});

test("일반 날씨 질문과 일정 자료가 없는 경우는 가로채지 않는다", () => {
  assert.equal(buildAssistantCycleAnswer("내일 비가 와?", { cropLabel: "사과", projection }), null);
  assert.equal(buildAssistantCycleAnswer("수확은 언제야?", { cropLabel: "사과" }), null);
});

test("재배 준비와 시즌 종료 상태를 현재 상태대로 설명한다", () => {
  const planning = buildAssistantCycleAnswer("상추 재배 일정 알려줘", {
    cropLabel: "상추",
    projection: { ...projection, status: "PLANNING", progress: { minPercent: 0, maxPercent: 0 } },
  });
  assert.match(planning, /재배 시작 전/);
  assert.match(planning, /0%/);

  const completed = buildAssistantCycleAnswer("사과 수확 시점 알려줘", {
    cropLabel: "사과",
    projection: { ...projection, status: "COMPLETED", progress: { minPercent: 100, maxPercent: 100 } },
  });
  assert.match(completed, /시즌은 종료된 상태/);
});
