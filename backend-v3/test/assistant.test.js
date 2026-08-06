import assert from "node:assert/strict";
import test from "node:test";

import { createGoogleAiSelector } from "../src/adapters/index.js";
import {
  answerGroundedQuestion,
  buildAssistantCatalog,
  classifyAssistantPolicy,
  classifyAssistantIntent,
  createKnowledgeSource,
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

// ── RAG (재배 참고 지식) ────────────────────────────────────

function knowledgeFixture(overrides = {}) {
  return createKnowledgeSource({
    passages: [
      {
        id: "KB_TEST_SOIL",
        title: "토양 산도란",
        text: "토양 pH는 흙이 산성인지 알칼리성인지 나타내는 값입니다. 작물마다 적정 구간이 다릅니다.",
        crops: [],
        topics: ["SOIL"],
        keywords: ["ph", "산도", "토양"],
        imageId: "TEST_CONNECTED",
        reviewState: "REVIEWED",
        reviewedBy: "테스트 검수자",
        source: {
          sourceTitle: "테스트 출처",
          sourceUrl: "https://example.test/soil",
          reviewedAt: "2026-08-04",
        },
      },
      {
        id: "KB_TEST_APPLE",
        title: "사과 개화기 저온",
        text: "개화기에 저온을 겪으면 꽃 중심의 암술머리가 갈색으로 변할 수 있습니다. 다음 날 아침에 확인합니다.",
        crops: ["APPLE"],
        topics: ["WEATHER", "ACTION"],
        keywords: ["사과", "개화", "저온", "서리"],
        imageId: "TEST_NOT_CONNECTED",
        reviewState: "REVIEWED",
        reviewedBy: "테스트 검수자",
        source: {
          sourceTitle: "테스트 출처",
          sourceUrl: "https://example.test/apple",
          reviewedAt: "2026-08-04",
        },
      },
    ],
    images: {
      TEST_CONNECTED: {
        url: "https://ncpms.rda.go.kr/test.jpg",
        alt: "대체 텍스트",
        caption: "설명",
        credit: "테스트 제공",
        licence: "CC BY-NC 2.0",
      },
      TEST_NOT_CONNECTED: {
        url: null,
        alt: "대체 텍스트",
        caption: "설명",
        credit: "테스트 제공",
      },
    },
    allowDraft: false,
    ...overrides,
  });
}

test("코퍼스가 없으면 흙톡은 기존처럼 분석 근거만으로 답한다", async () => {
  const result = await answerGroundedQuestion({
    analysis: analysisFixture(),
    question: "토양 산도가 무엇인가요?",
    assistant: null,
  });

  assert.equal(result.grounded, true);
  assert.deepEqual(result.references, []);
  assert.equal(result.retrieval.state, "NOT_CONFIGURED");
  assert.doesNotMatch(result.answer, /재배 참고/);
});

test("검색된 재배 참고가 답변과 인용 카드에 함께 담긴다", async () => {
  const result = await answerGroundedQuestion({
    analysis: analysisFixture(),
    question: "토양 산도(pH)가 무엇을 뜻하나요?",
    assistant: null,
    knowledge: knowledgeFixture(),
  });

  assert.equal(result.retrieval.state, "READY");
  assert.ok(result.retrieval.matched > 0);
  assert.match(result.answer, /재배 참고/);
  assert.match(result.answer, /토양 산도란: /);
  assert.equal(result.references.length > 0, true);

  const reference = result.references.find(
    ({ passageId }) => passageId === "KB_TEST_SOIL",
  );
  assert.equal(reference.title, "토양 산도란");
  assert.equal(reference.sourceUrl, "https://example.test/soil");
  assert.equal(reference.image.available, true);
  assert.equal(reference.image.imageId, "TEST_CONNECTED");
  assert.equal(reference.image.licence, "CC BY-NC 2.0");
});

test("인용 카드는 업스트림 이미지 URL을 클라이언트로 내보내지 않는다", async () => {
  const result = await answerGroundedQuestion({
    analysis: analysisFixture(),
    question: "토양 산도(pH)가 무엇을 뜻하나요?",
    assistant: null,
    knowledge: knowledgeFixture(),
  });

  assert.doesNotMatch(JSON.stringify(result), /ncpms\.rda\.go\.kr|test\.jpg/);
});

test("연결되지 않은 이미지는 available=false로 표시된다", async () => {
  const result = await answerGroundedQuestion({
    analysis: analysisFixture(),
    question: "사과 개화기에 서리가 오면 어디를 봐야 하나요?",
    assistant: null,
    knowledge: knowledgeFixture(),
  });

  const reference = result.references.find(
    ({ passageId }) => passageId === "KB_TEST_APPLE",
  );
  assert.equal(reference.image.available, false);
});

test("Google AI가 재배 참고를 고르지 않아도 카드가 사라지지 않는다", async () => {
  const result = await answerGroundedQuestion({
    analysis: analysisFixture(),
    question: "토양 산도(pH)가 무엇을 뜻하나요?",
    knowledge: knowledgeFixture(),
    assistant: {
      state: "READY",
      async select() {
        // 분석 근거만 고르고 KNOWLEDGE 항목은 무시하는 응답.
        return { selectedIds: ["ITEM_1"] };
      },
    },
  });

  assert.equal(result.mode, "GOOGLE_AI");
  assert.equal(result.references.length, 1);
});

test("Google AI 요청 본문에는 재배 참고의 출처·이미지 메타데이터가 실리지 않는다", async () => {
  let requestBody = null;
  const selector = createGoogleAiSelector({
    enabled: true,
    apiKey: "test-key",
    fetchImpl: async (_url, init) => {
      requestBody = init.body;
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: '{"selectedIds":["ITEM_1"]}' }] } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  // 흙톡이 실제로 만드는 카탈로그를 그대로 어댑터에 넘긴다.
  const catalog = buildAssistantCatalog(analysisFixture(), {
    knowledgeHits: [
      {
        passage: {
          id: "KB_TEST_SOIL",
          title: "토양 산도란",
          text: "토양 pH는 흙이 산성인지 알칼리성인지 나타내는 값입니다.",
          topics: ["SOIL"],
          imageId: "TEST_CONNECTED",
          reviewState: "REVIEWED",
          source: {
            sourceTitle: "테스트 출처",
            sourceUrl: "https://example.test/soil",
          },
        },
        score: 12,
      },
    ],
  });
  await selector.select({ intent: { topics: ["SOIL"] }, catalog });

  assert.match(requestBody, /KNOWLEDGE/);
  assert.match(requestBody, /토양 pH는/);
  // 모델은 문단 본문만 본다. 출처 URL·이미지 식별자·검수 상태는 나가지 않는다.
  for (const leak of [
    "example.test",
    "TEST_CONNECTED",
    "sourceUrl",
    "sourceTitle",
    "reviewState",
    "passageId",
    "imageId",
  ]) {
    assert.equal(
      requestBody.includes(leak),
      false,
      `요청 본문에 ${leak}이 포함되면 안 된다`,
    );
  }
});

test("안전 정책에 걸린 질문에는 재배 참고를 검색하지 않는다", async () => {
  let retrieved = false;
  const knowledge = knowledgeFixture();
  const spy = {
    ...knowledge,
    retrieve(args) {
      retrieved = true;
      return knowledge.retrieve(args);
    },
  };

  for (const question of [
    "요소를 몇 kg 줘야 해?",
    "이 사진 속 잎이 왜 이래?",
  ]) {
    const result = await answerGroundedQuestion({
      analysis: analysisFixture(),
      question,
      assistant: null,
      knowledge: spy,
    });
    assert.equal(retrieved, false, `${question}에서 검색이 실행되면 안 된다`);
    assert.deepEqual(result.references, []);
    assert.equal(result.retrieval.state, "SKIPPED_BY_POLICY");
  }
});

test("참고 사진을 보여 달라는 요청은 사진 진단 차단에 걸리지 않는다", () => {
  for (const question of [
    "저온 피해 사진 보여줘",
    "참고 이미지 있어요?",
    "사과 잎 사진 같이 보여주세요",
  ]) {
    assert.equal(
      classifyAssistantPolicy(question, analysisFixture()),
      null,
      `"${question}"은 통과해야 한다`,
    );
  }
});

test("내 사진으로 원인을 판단해 달라는 요청은 계속 차단한다", () => {
  for (const question of [
    "이 사진 속 잎이 왜 이래?",
    "사진으로 진단해줘",
    "이 사진 보고 원인 알려줘",
    "사진 보여줄게 무슨 병이야?",
    "병명 알려줘",
  ]) {
    const result = classifyAssistantPolicy(question, analysisFixture());
    assert.equal(result?.outcome, "NOT_SUPPORTED", `"${question}"은 막아야 한다`);
  }
});

test("재배 참고 문단이 분석 근거를 카탈로그에서 밀어내지 않는다", () => {
  const hits = [
    { passage: { id: "KB_A", title: "가", text: "가 본문", topics: ["SOIL"] }, score: 9 },
    { passage: { id: "KB_B", title: "나", text: "나 본문", topics: ["SOIL"] }, score: 8 },
    { passage: { id: "KB_C", title: "다", text: "다 본문", topics: ["SOIL"] }, score: 7 },
  ];
  const withKnowledge = buildAssistantCatalog(analysisFixture(), {
    knowledgeHits: hits,
  });
  const withoutKnowledge = buildAssistantCatalog(analysisFixture());

  const evidence = withKnowledge.filter(({ kind }) => kind !== "KNOWLEDGE");
  assert.deepEqual(
    evidence.map(({ text }) => text),
    withoutKnowledge.map(({ text }) => text),
  );
  assert.equal(
    withKnowledge.filter(({ kind }) => kind === "KNOWLEDGE").length,
    3,
  );
  // 어댑터가 잘라내지 않도록 전체가 MAX_CATALOG_ITEMS(30) 이내여야 한다.
  assert.ok(withKnowledge.length <= 30);
});
