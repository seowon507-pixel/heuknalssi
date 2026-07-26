import assert from "node:assert/strict";
import test from "node:test";

import { createGoogleAiSelector } from "../src/adapters/index.js";
import {
  answerGroundedQuestion,
  buildAssistantCatalog,
  classifyAssistantIntent,
} from "../src/application/index.js";

function analysisFixture() {
  return {
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
  assert.match(result.answer, /비가 이어지면/);
  assert.match(result.answer, /배수로가 막히지 않았는지/);
  assert.match(result.answer, /내일 아침/);
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
