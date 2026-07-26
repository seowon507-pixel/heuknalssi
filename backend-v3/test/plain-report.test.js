import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPlainReport,
  buildReportFacts,
  extractNumbers,
  validatePlainReport,
} from "../src/application/plain-report.js";

const FACTS = [
  "경북 안동시에서 사과를 분석했습니다.",
  "생육 적합도는 90점이고 판정은 매우 적합입니다.",
  "먼저 할 일은 주의 근거 우선 확인입니다.",
];

test("입력에 없는 숫자를 쓰면 거부한다", () => {
  const invented = validatePlainReport(
    ["적합도가 95점으로 아주 좋습니다."],
    FACTS,
  );
  assert.equal(invented.valid, false);
  assert.match(invented.reason, /^INVENTED_NUMBER:95$/);

  const kept = validatePlainReport(
    ["적합도가 90점으로 아주 좋습니다."],
    FACTS,
  );
  assert.equal(kept.valid, true);
});

test("진단·처방으로 읽히는 말을 쓰면 거부한다", () => {
  for (const bad of [
    "농약을 뿌리세요.",
    "병해충이 의심됩니다.",
    "이 처방을 따르세요.",
    "수확이 보장됩니다.",
  ]) {
    const result = validatePlainReport([bad], FACTS);
    assert.equal(result.valid, false, `${bad} 는 막혀야 한다`);
    assert.match(result.reason, /^FORBIDDEN_TERM:/);
  }
});

test("비었거나 지나치게 길면 거부한다", () => {
  assert.equal(validatePlainReport([], FACTS).valid, false);
  assert.equal(
    validatePlainReport(["가".repeat(300)], FACTS).reason,
    "PARAGRAPH_TOO_LONG",
  );
  assert.equal(
    validatePlainReport(["가", "나", "다", "라", "마", "바"], FACTS).reason,
    "TOO_MANY_PARAGRAPHS",
  );
});

test("소수점과 쉼표가 섞인 수치도 대조한다", () => {
  assert.deepEqual(extractNumbers("산도 6.1, 인산 1,500"), ["6.1", "1500"]);
  const ok = validatePlainReport(["산도는 6.1입니다."], [
    "등록하신 토양검정 결과의 산도는 6.1입니다.",
  ]);
  assert.equal(ok.valid, true);
});

test("확정된 분석 문장만 사실로 넘긴다", () => {
  const facts = buildReportFacts({
    inputSummary: { regionLabel: "경북 안동시", cropLabel: "사과" },
    suitability: {
      scored: true,
      score: 90,
      grade: "매우 적합",
      modules: [{ label: "토양", score: 100 }],
    },
    primaryAction: { title: "주의 근거 우선 확인" },
    limitations: ["OBSERVATION_WINDOW_INCOMPLETE"],
  });

  assert.ok(facts.some((fact) => fact.includes("90점")));
  assert.ok(facts.some((fact) => fact.includes("주의 근거 우선 확인")));
  assert.ok(facts.some((fact) => fact.includes("OBSERVATION_WINDOW_INCOMPLETE")));
});

test("모델이 새 숫자를 만들면 리포트를 버리고 이유를 남긴다", async () => {
  const result = await buildPlainReport({
    analysis: {
      inputSummary: { regionLabel: "경북 안동시", cropLabel: "사과" },
      suitability: { scored: true, score: 90, grade: "매우 적합", modules: [] },
    },
    assistant: {
      state: "READY",
      rewrite: async () => ({ paragraphs: ["적합도가 77점입니다."] }),
    },
  });

  assert.equal(result.state, "REJECTED");
  assert.equal(result.reason, "INVENTED_NUMBER:77");
  assert.deepEqual(result.paragraphs, []);
});

test("모델이 규칙을 지키면 쉬운 말 리포트를 사용한다", async () => {
  const result = await buildPlainReport({
    analysis: {
      inputSummary: { regionLabel: "경북 안동시", cropLabel: "사과" },
      suitability: { scored: true, score: 90, grade: "매우 적합", modules: [] },
      primaryAction: { title: "주의 근거 우선 확인" },
    },
    assistant: {
      state: "READY",
      rewrite: async () => ({
        paragraphs: [
          "안동에서 키우는 사과는 지금 조건이 좋은 편입니다. 적합도가 90점입니다.",
          "먼저 주의 근거를 확인해 주세요.",
        ],
      }),
    },
  });

  assert.equal(result.state, "READY");
  assert.equal(result.paragraphs.length, 2);
});

test("AI가 없으면 조용히 건너뛰고 템플릿을 쓴다", async () => {
  const result = await buildPlainReport({
    analysis: { inputSummary: { regionLabel: "경북 안동시", cropLabel: "사과" } },
    assistant: { state: "FALLBACK" },
  });
  assert.equal(result.state, "SKIPPED");
  assert.equal(result.reason, "GOOGLE_AI_NOT_CONFIGURED");
});
