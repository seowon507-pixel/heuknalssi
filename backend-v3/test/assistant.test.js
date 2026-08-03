import assert from "node:assert/strict";
import test from "node:test";

import { createGoogleAiSelector } from "../src/adapters/index.js";
import {
  answerGroundedQuestion,
  buildAssistantCatalog,
  classifyAssistantPolicy,
  classifyAssistantIntent,
} from "../src/application/index.js";

function analysisFixture() {
  return {
    inputSummary: { crop: "APPLE" },
    growthScore: {
      state: "READY",
      score: 62,
      label: "주의",
      components: {
        climate: { score: 88 },
        soil: { score: 74 },
        forecast: { score: 62 },
      },
    },
    state: "PARTIAL",
    decision: {
      message: "현재 재배지에서 확인된 주의 항목을 먼저 점검하세요.",
      triggerIds: [],
    },
    primaryAction: { actionId: "CHECK_CURRENT_FORECAST_RISK" },
    actions: [
      {
        actionId: "REQUEST_FIELD_SOIL_TEST",
        title: "필지 토양검정 진행",
        triggerIds: [],
      },
    ],
    climate: { state: "READY", evidence: [] },
    soil: { state: "PARTIAL", evidence: [] },
    observations: { state: "READY", evidence: [] },
    forecast: {
      state: "READY",
      evidence: [],
      result: {
        risks: [
          {
            riskId: "RAIN_RISK",
            guidance: {
              reason: "비가 이어지면 토양의 물 빠짐 상태를 확인해야 합니다.",
              actions: ["배수로가 막히지 않았는지 확인하세요."],
              recheck: "내일 아침 최신 예보로 다시 확인하세요.",
            },
          },
        ],
      },
    },
    limitations: [
      "REGIONAL_PUBLIC_DATA_IS_NOT_A_FIELD_MEASUREMENT",
      "UNTRANSLATED_INTERNAL_CODE",
    ],
    dataSources: [
      {
        sourceName: "기상청 단기예보",
        deliveryState: "LIVE",
        freshness: "CURRENT",
      },
    ],
  };
}

test("assistant catalog contains only reviewed user text and hides raw limitation codes", () => {
  const catalog = buildAssistantCatalog(analysisFixture());
  const serialized = JSON.stringify(catalog);
  assert.match(serialized, /배수로가 막히지 않았는지/);
  assert.match(serialized, /지역 토양 통계는 내 밭에서 직접 측정한 값이 아닙니다/);
  assert.doesNotMatch(serialized, /UNTRANSLATED_INTERNAL_CODE/);
  assert.ok(catalog.every(({ id }) => /^ITEM_[0-9]+$/.test(id)));
});

test("assistant intent is classified locally without sending a raw question to the provider", async () => {
  let request;
  const selector = createGoogleAiSelector({
    enabled: true,
    apiKey: "test-key-that-must-not-be-returned",
    model: "gemini-3.6-flash",
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"selectedIds":["ITEM_1","ITEM_5"]}' }],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  const question = "서울시 종로구 123-4에서 오늘 토양은 어떻게 해요?";
  const intent = classifyAssistantIntent(question);
  const result = await selector.select({
    intent,
    catalog: buildAssistantCatalog(analysisFixture()),
  });
  assert.deepEqual(result.selectedIds, ["ITEM_1", "ITEM_5"]);
  const body = JSON.parse(request.init.body);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /종로구|123-4/);
  assert.match(serialized, /SOIL/);
  assert.equal(
    request.init.headers["x-goog-api-key"],
    "test-key-that-must-not-be-returned",
  );
  assert.doesNotMatch(JSON.stringify(result), /test-key/);
  assert.equal(body.generationConfig.temperature, undefined);
  assert.equal(body.generationConfig.maxOutputTokens, 512);
});

test("assistant ignores Gemini thought summary parts and reads only final JSON", async () => {
  const selector = createGoogleAiSelector({
    enabled: true,
    apiKey: "test-key",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: "ITEM_2를 선택해야 한다." },
                  { text: "최종 선택은 다음과 같습니다." },
                  {
                    text:
                      '```json\n{"selectedIds":["ITEM_1"]}\n```',
                    thoughtSignature: "opaque-signature",
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });
  const result = await selector.select({
    intent: { topics: ["STATUS"] },
    catalog: [
      {
        id: "ITEM_1",
        kind: "STATUS",
        text: "토양 자료 상태는 일부 확인입니다.",
        tags: ["STATUS"],
      },
    ],
  });
  assert.deepEqual(result.selectedIds, ["ITEM_1"]);
});

test("grounded assistant falls back to reason, action, and recheck from the analysis", async () => {
  const result = await answerGroundedQuestion({
    analysis: analysisFixture(),
    question: "왜 주의이고 오늘 무엇을 해야 하며 언제 다시 봐야 해?",
    assistant: { state: "FALLBACK" },
  });
  assert.equal(result.mode, "FALLBACK");
  assert.equal(result.fallbackReason, "GOOGLE_AI_NOT_CONFIGURED");
  assert.equal(result.grounded, true);
  assert.equal(result.outcome, "ANSWERED");
  assert.match(result.answer, /비가 이어지면/);
  assert.match(result.answer, /배수로가 막히지 않았는지/);
  assert.match(result.answer, /내일 아침/);
});

test("assistant blocks pesticide dosage and never calls the model selector", async () => {
  let called = false;
  const result = await answerGroundedQuestion({
    analysis: analysisFixture(),
    question: "사과에 농약을 몇 배로 희석해서 뿌려?",
    assistant: {
      state: "READY",
      async select() {
        called = true;
        return { selectedIds: [] };
      },
    },
  });
  assert.equal(called, false);
  assert.equal(result.mode, "POLICY");
  assert.equal(result.outcome, "SAFETY_LIMIT");
  assert.match(result.answer, /농약안전정보시스템|농업기술센터/);
});

test("응급 농약 노출은 일반 농약 규칙보다 먼저 119로 안내한다", async () => {
  const questions = [
    "사람이 농약을 마셨어",
    "농약을 마신 것 같아",
    "아이가 살충제를 먹었어",
    "반려동물이 제초제에 노출됐어",
  ];
  for (const question of questions) {
    let called = false;
    const result = await answerGroundedQuestion({
      analysis: analysisFixture(),
      question,
      assistant: {
        state: "READY",
        async select() {
          called = true;
          return { selectedIds: [] };
        },
      },
    });
    assert.equal(called, false);
    assert.equal(result.outcome, "SAFETY_LIMIT");
    assert.match(result.answer, /119|의료기관/);
    assert.doesNotMatch(result.answer, /희석배수/);
  }
});

test("비료·사진 질문의 자연어 변형도 모델 호출 전에 제한한다", async () => {
  for (const [question, expectedOutcome] of [
    ["요소를 몇 kg 줘야 해?", "SAFETY_LIMIT"],
    ["퇴비를 몇 포대 뿌려?", "SAFETY_LIMIT"],
    ["이 사진 속 잎이 왜 이래?", "NOT_SUPPORTED"],
  ]) {
    let called = false;
    const result = await answerGroundedQuestion({
      analysis: analysisFixture(),
      question,
      assistant: {
        state: "READY",
        async select() {
          called = true;
          return { selectedIds: [] };
        },
      },
    });
    assert.equal(called, false);
    assert.equal(result.outcome, expectedOutcome);
  }
});

test("assistant asks the user to switch crop context instead of answering from apple evidence", () => {
  const result = classifyAssistantPolicy("오이는 내일 뭘 해야 해?", analysisFixture());
  assert.equal(result.outcome, "NEEDS_CLARIFICATION");
  assert.match(result.answer, /현재 대화는 사과 분석/);
  assert.match(result.answer, /오이 작물 탭/);
});

test("배수를 배 작물로 오인하지 않고 근거 부재와 현장 행동을 안내한다", () => {
  const drainage = classifyAssistantPolicy(
    "배수 상태를 알려줘",
    analysisFixture(),
  );
  assert.equal(drainage.outcome, "NEEDS_CLARIFICATION");
  assert.match(drainage.answer, /검수된 필지 배수 등급이 없어/);
  assert.match(drainage.answer, /고인 물·배수로 막힘/);
  assert.match(drainage.answer, /내일 다시 확인/);
  const pear = classifyAssistantPolicy("배나무는 무엇을 해야 해?", analysisFixture());
  assert.equal(pear.outcome, "NEEDS_CLARIFICATION");
  assert.match(pear.answer, /배 작물 탭/);
});

test("생육점수는 근거를 설명하고 미지원 종합점수는 구분한다", () => {
  const cases = [
    ["다른 농장과 비교해 줘", "NOT_SUPPORTED", /비교는 하지 않습니다/],
    ["오늘 할 일을 완료 처리해 줘", "NOT_SUPPORTED", /아무것도 변경되지 않았습니다/],
    ["내일 비가 오나요?", "NOT_SUPPORTED", /7일 예보/],
    ["생육점수가 90점이니 안전하지?", "ANSWERED", /현재 생육점수는 62점\(주의\)/],
    ["종합점수가 90점이니 안전한 거죠?", "NEEDS_CLARIFICATION", /안전이나 수확량을 보증하는 점수/],
    ["총점이 높으면 위험이 없어?", "NEEDS_CLARIFICATION", /생육점수/],
    ["통합 점수를 알려줘", "NEEDS_CLARIFICATION", /생육점수/],
    ["안전점수 95점이면 괜찮아?", "NEEDS_CLARIFICATION", /생육점수/],
  ];
  for (const [question, outcome, answerPattern] of cases) {
    const result = classifyAssistantPolicy(question, analysisFixture());
    assert.equal(result.outcome, outcome);
    assert.match(result.answer, answerPattern);
  }
});

test("생육점수와 배수 근거를 모델 호출 전에 처리한다", async () => {
  for (const [question, expectedOutcome] of [
    ["생육점수를 알려줘", "ANSWERED"],
    ["배수 상태를 알려줘", "NEEDS_CLARIFICATION"],
  ]) {
    let called = false;
    const result = await answerGroundedQuestion({
      analysis: analysisFixture(),
      question,
      assistant: {
        state: "READY",
        async select() {
          called = true;
          return { selectedIds: [] };
        },
      },
    });
    assert.equal(called, false);
    assert.equal(result.mode, "POLICY");
    assert.equal(result.outcome, expectedOutcome);
  }
});

test("assistant makes its lack of conversational memory explicit", () => {
  const result = classifyAssistantPolicy("그러면 그건 언제 해?", analysisFixture());
  assert.equal(result.outcome, "NEEDS_CLARIFICATION");
  assert.match(result.answer, /이전 질문을 기억해 이어서 판단하지 않습니다/);
});

test("grounded assistant exposes only a safe provider failure category", async () => {
  const result = await answerGroundedQuestion({
    analysis: analysisFixture(),
    question: "현재 상태를 알려줘",
    assistant: {
      state: "READY",
      async select() {
        const error = new Error("sensitive provider response");
        error.adapterState = "AUTH_ERROR";
        error.code = "PRIVATE_PROVIDER_MESSAGE";
        throw error;
      },
    },
  });
  assert.equal(result.mode, "FALLBACK");
  assert.equal(result.fallbackReason, "GOOGLE_AI_AUTH_ERROR");
  assert.doesNotMatch(JSON.stringify(result), /sensitive|PRIVATE/);
});
