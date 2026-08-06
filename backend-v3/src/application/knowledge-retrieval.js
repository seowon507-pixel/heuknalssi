// 흙톡 RAG 검색기.
//
// 한국어 형태소 분석기 없이 동작해야 하므로 공백 토큰과 문자 bigram을 함께
// 색인한다. bigram은 "배수로가"와 "배수"처럼 조사가 붙은 형태를 잇는 역할을
// 하고, 공백 토큰은 "ph"나 "ec"처럼 짧은 단어를 잃지 않게 한다.
//
// 색인은 프로세스 기동 시 한 번만 만들고 질의마다 재사용한다. 네트워크 호출도
// 무작위성도 없으므로 같은 질문은 항상 같은 문단을 돌려준다.

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const DEFAULT_LIMIT = 3;
// 문단 하나가 최소 이 점수를 넘지 않으면 "관련 자료 없음"으로 둔다. 관련 없는
// 문단을 억지로 붙이면 사용자가 근거를 잘못 신뢰하게 되므로 비우는 편이 낫다.
const DEFAULT_MINIMUM_SCORE = 4;
// BM25 점수는 질문 길이에 따라 절대값이 크게 달라져서 절대 임계값만으로는
// 걸러낼 수 없다. 1위 점수의 이 비율 아래는 버려서, 질문이 정확할수록 문단이
// 적게 붙고 질문이 막연할수록 넓게 붙는 동작을 만든다.
const DEFAULT_RELATIVE_FLOOR = 0.5;
const KEYWORD_WEIGHT = 3;
const TITLE_WEIGHT = 2;
const TOPIC_MATCH_BONUS = 0.6;
const CROP_MATCH_BONUS = 1.1;
const MAX_QUESTION_LENGTH = 400;

// 조사·접미사와 의미 없는 질문 표현. 이 토큰은 공백 토큰 색인에서 제외하되
// bigram에서는 지우지 않는다. bigram은 이미 위치 정보를 담고 있어서 흔한
// 토큰이 IDF로 자동 감점되기 때문이다.
const STOP_TOKENS = new Set([
  "그리고", "그런데", "하지만", "그래서", "무엇", "무엇을", "어떻게", "어떤",
  "언제", "왜", "어디", "얼마", "인가요", "있나요", "하나요", "합니까", "해야",
  "되나요", "인지", "것", "때", "수", "좀", "제", "저", "내", "나", "이거",
  "그거", "정도", "관련", "대해", "대한", "알려", "알려줘", "주세요", "please",
]);

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordTokens(normalized) {
  return normalized
    .split(" ")
    .filter((token) => token && token !== "." && !STOP_TOKENS.has(token))
    .map((token) => token.replace(/\.$/, ""))
    .filter(Boolean);
}

function bigramTokens(normalized) {
  const tokens = [];
  for (const word of normalized.split(" ")) {
    const compact = word.replace(/\./g, "");
    // 한 글자 단어는 bigram을 만들 수 없으므로 그대로 색인한다.
    if (compact.length < 2) {
      if (compact) tokens.push(compact);
      continue;
    }
    for (let index = 0; index + 2 <= compact.length; index += 1) {
      tokens.push(compact.slice(index, index + 2));
    }
  }
  return tokens;
}

export function tokenize(value) {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return [...wordTokens(normalized), ...bigramTokens(normalized)];
}

function repeat(tokens, times) {
  const output = [];
  for (let count = 0; count < times; count += 1) output.push(...tokens);
  return output;
}

function documentTokens(passage) {
  return [
    ...repeat(tokenize(passage.title), TITLE_WEIGHT),
    ...tokenize(passage.text),
    ...repeat(
      (passage.keywords ?? []).flatMap((keyword) => tokenize(keyword)),
      KEYWORD_WEIGHT,
    ),
  ];
}

function termFrequencies(tokens) {
  const frequencies = new Map();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
}

/**
 * 코퍼스를 BM25 색인으로 바꾼다. 문단 배열이 바뀌지 않는 한 한 번만 호출한다.
 */
export function buildKnowledgeIndex(passages = []) {
  const documents = passages
    .filter(
      (passage) =>
        passage &&
        typeof passage.id === "string" &&
        typeof passage.text === "string" &&
        passage.text.trim(),
    )
    .map((passage) => {
      const tokens = documentTokens(passage);
      return {
        passage,
        frequencies: termFrequencies(tokens),
        length: tokens.length,
      };
    });

  const documentFrequency = new Map();
  for (const document of documents) {
    for (const token of document.frequencies.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const totalLength = documents.reduce((sum, doc) => sum + doc.length, 0);
  return Object.freeze({
    documents,
    documentFrequency,
    documentCount: documents.length,
    averageLength: documents.length ? totalLength / documents.length : 0,
  });
}

function inverseDocumentFrequency(index, token) {
  const frequency = index.documentFrequency.get(token) ?? 0;
  if (frequency === 0) return 0;
  // BM25 표준 IDF. 0 이하로 내려가지 않도록 하한을 둔다.
  return Math.max(
    0,
    Math.log(
      1 + (index.documentCount - frequency + 0.5) / (frequency + 0.5),
    ),
  );
}

function bm25Score(index, document, queryFrequencies) {
  let score = 0;
  for (const [token, queryCount] of queryFrequencies) {
    const termCount = document.frequencies.get(token);
    if (!termCount) continue;
    const idf = inverseDocumentFrequency(index, token);
    if (idf === 0) continue;
    const normalization =
      termCount +
      BM25_K1 *
        (1 -
          BM25_B +
          BM25_B * (document.length / (index.averageLength || 1)));
    score += idf * queryCount * ((termCount * (BM25_K1 + 1)) / normalization);
  }
  return score;
}

function passageMatchesCrop(passage, crop) {
  // crops가 빈 배열이면 작물 공통 지식이므로 항상 후보에 남는다.
  if (!passage.crops || passage.crops.length === 0) return true;
  if (!crop) return false;
  return passage.crops.includes(crop);
}

/**
 * 질문과 현재 분석 문맥으로 관련 문단을 찾는다.
 *
 * @param {object} options
 * @param {object} options.index            buildKnowledgeIndex 결과
 * @param {string} options.question         정규화된 사용자 질문
 * @param {string|null} options.crop        현재 분석 작물 코드 (APPLE 등)
 * @param {string[]} options.topics         classifyAssistantIntent의 topics
 * @param {number} options.limit            돌려줄 최대 문단 수
 * @param {number} options.minimumScore     이 점수 미만은 버린다
 * @param {number} options.relativeFloor    1위 점수 대비 이 비율 미만은 버린다
 * @param {boolean} options.allowDraft      DRAFT 문단을 포함할지
 */
export function retrieveKnowledge({
  index,
  question,
  crop = null,
  topics = [],
  limit = DEFAULT_LIMIT,
  minimumScore = DEFAULT_MINIMUM_SCORE,
  relativeFloor = DEFAULT_RELATIVE_FLOOR,
  allowDraft = false,
} = {}) {
  if (!index || index.documentCount === 0) return [];
  const trimmedQuestion =
    typeof question === "string" ? question.slice(0, MAX_QUESTION_LENGTH) : "";
  const queryFrequencies = termFrequencies(tokenize(trimmedQuestion));
  if (queryFrequencies.size === 0) return [];

  const requestedTopics = new Set(
    Array.isArray(topics)
      ? topics.filter((topic) => typeof topic === "string")
      : [],
  );

  const scored = [];
  for (const document of index.documents) {
    const { passage } = document;
    if (!allowDraft && passage.reviewState !== "REVIEWED") continue;
    if (!passageMatchesCrop(passage, crop)) continue;

    let score = bm25Score(index, document, queryFrequencies);
    if (score <= 0) continue;

    // 어휘 점수만으로는 "오늘 뭐 해야 해?"처럼 짧은 질문을 가릴 수 없어서
    // intent 주제와 작물 지정 여부를 가산점으로만 반영한다. 순서를 바꾸는
    // 정도이고 minimumScore 통과 여부를 뒤집을 만큼 크지 않게 둔다.
    const topicOverlap = (passage.topics ?? []).filter((topic) =>
      requestedTopics.has(topic),
    ).length;
    score += topicOverlap * TOPIC_MATCH_BONUS;
    if (crop && passage.crops?.includes(crop)) score += CROP_MATCH_BONUS;

    scored.push({ passage, score });
  }

  const topScore = scored.reduce((best, { score }) => Math.max(best, score), 0);
  const floor = Math.max(minimumScore, topScore * relativeFloor);

  return scored
    .filter(({ score }) => score >= floor)
    .sort((a, b) =>
      b.score - a.score ||
      // 점수가 같으면 id 순서로 고정해 응답이 흔들리지 않게 한다.
      a.passage.id.localeCompare(b.passage.id),
    )
    .slice(0, Math.max(0, limit))
    .map(({ passage, score }) =>
      Object.freeze({ passage, score: Number(score.toFixed(4)) }),
    );
}

export const KNOWLEDGE_RETRIEVAL_DEFAULTS = Object.freeze({
  limit: DEFAULT_LIMIT,
  minimumScore: DEFAULT_MINIMUM_SCORE,
  relativeFloor: DEFAULT_RELATIVE_FLOOR,
});
