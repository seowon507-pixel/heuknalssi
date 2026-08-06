import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKnowledgeIndex,
  retrieveKnowledge,
} from "../src/application/knowledge-retrieval.js";
import {
  KNOWLEDGE_IMAGES,
  REVIEWED_KNOWLEDGE_BASE,
} from "../runtime/reviewed-knowledge-base.js";

function passage(overrides) {
  return {
    id: "KB_TEST",
    title: "제목",
    text: "본문",
    crops: [],
    topics: ["SOIL"],
    keywords: [],
    imageId: null,
    reviewState: "REVIEWED",
    source: { sourceTitle: "출처", sourceUrl: "https://example.test/" },
    ...overrides,
  };
}

// 기본 임계값은 36개 문단짜리 실제 코퍼스에 맞춰 두었다. 문서가 두세 개뿐인
// 합성 픽스처는 IDF가 거의 0이라 같은 임계값을 넘길 수 없으므로, 필터 로직만
// 확인하는 테스트에서는 임계값을 끄고 본다.
const NO_THRESHOLD = { minimumScore: 0, relativeFloor: 0 };

function reviewedCorpus() {
  // 코퍼스는 전부 DRAFT로 배포되므로 검색 동작 검증용으로만 REVIEWED로 바꾼다.
  return REVIEWED_KNOWLEDGE_BASE.map((entry) => ({
    ...entry,
    reviewState: "REVIEWED",
  }));
}

test("작물 질문은 해당 작물 문단과 공통 문단만 후보로 삼는다", () => {
  const index = buildKnowledgeIndex([
    passage({ id: "KB_APPLE", crops: ["APPLE"], keywords: ["저온"], text: "사과 저온" }),
    passage({ id: "KB_POTATO", crops: ["POTATO"], keywords: ["저온"], text: "감자 저온" }),
    passage({ id: "KB_COMMON", crops: [], keywords: ["저온"], text: "공통 저온" }),
  ]);

  const ids = retrieveKnowledge({
    index,
    question: "저온",
    crop: "APPLE",
    limit: 10,
    ...NO_THRESHOLD,
  }).map(({ passage: hit }) => hit.id);

  assert.deepEqual(ids.sort(), ["KB_APPLE", "KB_COMMON"]);
});

test("작물이 확정되지 않은 분석에서는 작물 전용 문단을 쓰지 않는다", () => {
  const index = buildKnowledgeIndex([
    passage({ id: "KB_APPLE", crops: ["APPLE"], keywords: ["저온"] }),
    passage({ id: "KB_COMMON", crops: [], keywords: ["저온"] }),
  ]);

  const ids = retrieveKnowledge({
    index,
    question: "저온",
    crop: null,
    limit: 10,
    ...NO_THRESHOLD,
  }).map(({ passage: hit }) => hit.id);

  assert.deepEqual(ids, ["KB_COMMON"]);
});

test("검수 대기 문단은 allowDraft를 켜지 않으면 노출되지 않는다", () => {
  const index = buildKnowledgeIndex([
    passage({ id: "KB_DRAFT", reviewState: "DRAFT", keywords: ["배수"] }),
  ]);

  assert.deepEqual(
    retrieveKnowledge({ index, question: "배수", ...NO_THRESHOLD }),
    [],
  );
  assert.equal(
    retrieveKnowledge({
      index,
      question: "배수",
      allowDraft: true,
      ...NO_THRESHOLD,
    }).length,
    1,
  );
});

test("농사와 무관한 질문에는 문단을 붙이지 않는다", () => {
  const index = buildKnowledgeIndex(reviewedCorpus());

  for (const question of [
    "자동차 보험 추천해줘",
    "주식 뭐 사면 돼?",
    "오늘 환율 알려줘",
  ]) {
    assert.deepEqual(
      retrieveKnowledge({ index, question, crop: "APPLE" }),
      [],
      `"${question}"에는 재배 참고가 붙지 않아야 한다`,
    );
  }
});

test("빈 질문과 빈 색인은 예외 없이 빈 결과를 돌려준다", () => {
  const empty = buildKnowledgeIndex([]);
  assert.deepEqual(retrieveKnowledge({ index: empty, question: "배수" }), []);
  assert.deepEqual(retrieveKnowledge({ index: undefined, question: "배수" }), []);

  const index = buildKnowledgeIndex(reviewedCorpus());
  assert.deepEqual(retrieveKnowledge({ index, question: "" }), []);
  assert.deepEqual(retrieveKnowledge({ index, question: "   " }), []);
  assert.deepEqual(retrieveKnowledge({ index, question: null }), []);
});

test("실제 코퍼스에서 대표 질문의 1순위 문단이 고정된다", () => {
  const index = buildKnowledgeIndex(reviewedCorpus());
  // topics는 흙톡이 classifyAssistantIntent로 넘기는 값과 같은 형태로 준다.
  // 주제 가산점이 순위를 바꾸므로 topics 없이 검증하면 실제 동작과 달라진다.
  const expectations = [
    ["토양 pH가 뭔가요?", "APPLE", ["SOIL"], "KB_SOIL_PH_MEANING"],
    ["토양검정 어디서 받아요?", "LETTUCE", ["SOIL", "ACTION"], "KB_SOIL_TEST_HOW"],
    ["ec가 높으면 어떻게 되나요", "CUCUMBER", ["SOIL"], "KB_SOIL_EC_MEANING"],
    ["사과 꽃이 서리를 맞았어요", "APPLE", ["WEATHER"], "KB_APPLE_BLOSSOM_FROST"],
    ["상추 잎 끝이 갈색으로 말라요", "LETTUCE", ["ACTION"], "KB_LETTUCE_TIPBURN"],
    ["감자 수확 언제 해요", "POTATO", ["ACTION", "RECHECK"], "KB_POTATO_HARVEST_TIMING"],
    [
      "하우스 환기 어떻게 해요",
      "CUCUMBER",
      ["WEATHER", "ACTION"],
      "KB_CUCUMBER_FACILITY_HUMIDITY",
    ],
    ["비 온 뒤에 뭘 봐야 해요", "PEAR", ["WEATHER", "ACTION"], "KB_PEAR_WET_LEAF"],
  ];

  for (const [question, crop, topics, expectedId] of expectations) {
    const hits = retrieveKnowledge({ index, question, crop, topics });
    assert.ok(hits.length > 0, `"${question}"에 결과가 있어야 한다`);
    assert.equal(hits[0].passage.id, expectedId, `"${question}" 1순위`);
  }
});

test("같은 질문은 항상 같은 순서를 돌려준다", () => {
  const index = buildKnowledgeIndex(reviewedCorpus());
  const run = () =>
    retrieveKnowledge({
      index,
      question: "비가 온 뒤 배수를 어떻게 확인해요",
      crop: "POTATO",
      topics: ["SOIL", "ACTION"],
    }).map(({ passage: hit, score }) => [hit.id, score]);

  assert.deepEqual(run(), run());
});

test("검색 결과는 limit을 넘지 않는다", () => {
  const index = buildKnowledgeIndex(reviewedCorpus());
  const hits = retrieveKnowledge({
    index,
    question: "토양 배수 관수 환기 수확 저온 고온",
    crop: "APPLE",
    limit: 2,
  });
  assert.ok(hits.length <= 2);
});

test("코퍼스가 작성 규칙을 지킨다", () => {
  const ids = new Set();
  for (const entry of REVIEWED_KNOWLEDGE_BASE) {
    assert.ok(/^KB_[A-Z0-9_]+$/.test(entry.id), `id 형식: ${entry.id}`);
    assert.equal(ids.has(entry.id), false, `id 중복: ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.title.length > 0 && entry.title.length <= 40, entry.id);
    assert.ok(entry.text.length > 40 && entry.text.length <= 360, entry.id);
    assert.ok(entry.topics.length > 0, entry.id);
    assert.ok(entry.keywords.length > 0, entry.id);
    assert.ok(entry.source?.sourceUrl?.startsWith("https://"), entry.id);
    assert.ok(
      ["DRAFT", "REVIEWED"].includes(entry.reviewState),
      `reviewState: ${entry.id}`,
    );
    if (entry.imageId) {
      assert.ok(
        Object.hasOwn(KNOWLEDGE_IMAGES, entry.imageId),
        `등록되지 않은 imageId: ${entry.id}`,
      );
    }
    // 안전 계약: 농약 제품·희석배수와 비료 사용량 숫자를 코퍼스에 두지 않는다.
    assert.doesNotMatch(
      entry.text,
      /희석배수|배로\s*희석|살포량|\d+\s*(?:kg|킬로|포대|말|리터|ml)/u,
      `사용량 표현 금지: ${entry.id}`,
    );
  }
});

test("검수 대기 문단은 검수자 서명 없이 REVIEWED가 되지 않는다", () => {
  for (const entry of REVIEWED_KNOWLEDGE_BASE) {
    if (entry.reviewState !== "REVIEWED") continue;
    assert.ok(
      typeof entry.reviewedBy === "string" && entry.reviewedBy.trim(),
      `REVIEWED 문단에는 reviewedBy가 필요하다: ${entry.id}`,
    );
    assert.ok(entry.source?.reviewedAt, `reviewedAt 필요: ${entry.id}`);
  }
});
