import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateCropConditionScore,
  moduleLabel,
  moduleScore,
} from "./crop-condition-score.mjs";

/** 백엔드가 내려주는 suitability 모양을 그대로 흉내낸다. */
function suitability({
  score = 88,
  grade = "매우 적합",
  scored = true,
  modules = [
    { module: "CLIMATE", label: "기후", score: 90, coverage: 1, itemCount: 3 },
    {
      module: "SOIL",
      label: "토양",
      score: 85,
      coverage: 1,
      itemCount: 4,
      basis: "USER_SOIL_TEST",
    },
  ],
  nearTermRiskDays = 0,
  blockedReason = null,
} = {}) {
  return {
    suitability: {
      score,
      grade,
      scored,
      blockedReason,
      modules,
      nearTermRiskDays,
      method: {
        itemDeviation: "|실측값 − 적정범위| ÷ 적정범위 폭 (범위 안이면 0)",
        weights: { CRITICAL: 3, IMPORTANT: 2, SUPPORTING: 1 },
        moduleScore: "100 × (1 − min(가중평균 편차, 1))",
        totalScore: "모듈 계획가중치로 가중평균",
        note: "검수된 규칙의 민감도 등급 외에 새로 만든 가중치는 없습니다.",
      },
    },
  };
}

test("점수는 백엔드 suitability를 그대로 쓰고 화면에서 다시 계산하지 않는다", () => {
  const result = calculateCropConditionScore(suitability());

  assert.equal(result.score, 88);
  assert.equal(result.label, "매우 적합");
  assert.equal(result.components.climate, 90);
  assert.equal(result.components.soil, 85);
  assert.equal(result.basisLabel, "사용자 등록 토양검정");
});

test("공개된 가중치를 설명 문구에 그대로 드러낸다", () => {
  const result = calculateCropConditionScore(suitability());

  assert.match(result.explanation, /CRITICAL 3/);
  assert.match(result.explanation, /IMPORTANT 2/);
  assert.match(result.explanation, /SUPPORTING 1/);
  assert.match(result.explanation, /새로 만든 가중치는 없습니다/);
  assert.deepEqual(result.method.weights, {
    CRITICAL: 3,
    IMPORTANT: 2,
    SUPPORTING: 1,
  });
});

test("예보 위험은 점수에 섞지 않고 건수로만 따로 전달한다", () => {
  const clear = calculateCropConditionScore(suitability({ nearTermRiskDays: 0 }));
  const risky = calculateCropConditionScore(
    suitability({ nearTermRiskDays: 3 }),
  );

  assert.equal(clear.nearTermRiskDays, 0);
  assert.equal(risky.nearTermRiskDays, 3);
  // 위험 건수가 달라도 적합도 점수 자체는 백엔드 값 그대로여야 한다.
  assert.equal(clear.score, risky.score);
  assert.equal(risky.components.climate, clear.components.climate);
});

test("점수를 내지 못하면 0점으로 꾸미지 않고 보류 사유를 그대로 보여 준다", () => {
  const result = calculateCropConditionScore(
    suitability({
      score: null,
      scored: false,
      grade: "판단 보류",
      modules: [],
      blockedReason: "기후·토양 자료가 확인되지 않아 점수를 내지 않았습니다.",
    }),
  );

  assert.equal(result.score, null);
  assert.equal(result.label, "산정 대기");
  assert.equal(result.tone, "hold");
  assert.equal(result.components.climate, null);
  assert.equal(result.components.soil, null);
  assert.equal(
    result.explanation,
    "기후·토양 자료가 확인되지 않아 점수를 내지 않았습니다.",
  );
});

test("suitability 자체가 없으면 미산정으로 취급한다", () => {
  const result = calculateCropConditionScore({});

  assert.equal(result.score, null);
  assert.equal(result.label, "산정 대기");
  assert.equal(result.basisLabel, "토양 근거 확인 필요");
  assert.match(result.explanation, /확인되면/);
});

test("모듈 점수 조회는 없는 모듈에 0을 채우지 않는다", () => {
  const modules = [{ module: "SOIL", score: 70 }];

  assert.equal(moduleScore(modules, "SOIL"), 70);
  assert.equal(moduleScore(modules, "CLIMATE"), null);
  assert.equal(moduleScore([], "SOIL"), null);
  assert.equal(moduleLabel("CLIMATE"), "기후 적합");
});

test("등급 색조는 점수 구간을 따른다", () => {
  const toneFor = (score) =>
    calculateCropConditionScore(suitability({ score })).tone;

  assert.equal(toneFor(90), "good");
  assert.equal(toneFor(75), "caution");
  assert.equal(toneFor(55), "caution");
  assert.equal(toneFor(30), "danger");
});
