import { buildDeterministicReport } from "./templates.js";
import {
  buildKnowledgeIndex,
  retrieveKnowledge,
} from "./knowledge-retrieval.js";
import { describeKnowledgeImage } from "./knowledge-images.js";

// 분석 근거 항목 뒤에 붙일 수 있는 재배 참고 문단의 최대 개수. 답변이 배경
// 설명으로 뒤덮이지 않도록 분석 근거보다 적게 유지한다.
const MAX_KNOWLEDGE_ITEMS = 3;

const STATE_TEXT = Object.freeze({
  COMPLETE: "분석 완료",
  READY: "자료 확인",
  PARTIAL: "일부 확인",
  HOLD: "판단 보류",
  UNAVAILABLE: "자료 없음",
  UNSUPPORTED: "지원 안 함",
  NOT_APPLICABLE: "해당 없음"
});

const LIMITATION_TEXT = Object.freeze({
  SEASON_UNKNOWN:
    "재배 시기가 확인되지 않아 시기별 위험 판단이 제한됩니다.",
  INVALID_OBSERVATION_CONTRACT:
    "최근 관측자료 형식이 검수 기준과 달라 판단에 사용하지 않았습니다.",
  OBSERVATION_DATE_OUTSIDE_COMPLETED_WINDOW:
    "최근 관측자료의 날짜가 검수 기간 밖이라 판단에 사용하지 않았습니다.",
  PUBLIC_DATA_INSUFFICIENT_FOR_OPEN_FIELD_CONDITION:
    "지역 공개자료만으로 내 밭의 실제 재배환경을 확정할 수 없습니다.",
  REGIONAL_PUBLIC_DATA_IS_NOT_A_FIELD_MEASUREMENT:
    "지역 토양 통계는 내 밭에서 직접 측정한 값이 아닙니다.",
  FIELD_TEST_NEXT_REQUIREMENTS_NOT_CONFIRMED:
    "필지 토양검정 등 현장 확인이 더 필요합니다.",
  OUTDOOR_FORECAST_IS_NOT_INTERNAL_FACILITY_CONDITION:
    "실외 예보는 시설 내부 환경을 대신하지 않습니다.",
  OUTDOOR_DATA_IS_NOT_INTERNAL_FACILITY_MEASUREMENT:
    "실외 자료는 시설 내부의 실제 측정값을 대신하지 않습니다.",
  NO_CURRENT_FACILITY_OPERATION_RISK_CONFIRMATION:
    "현재 시설 운영 위험을 확정할 자료가 없습니다.",
  INTERNAL_FACILITY_ENVIRONMENT_REQUIRES_SENSOR_CONFIRMATION:
    "시설 내부 환경은 센서나 현장 기록으로 확인해야 합니다.",
  NO_RISK_CANNOT_BE_CONFIRMED:
    "확인되지 않은 위험이 없다고 단정할 수 없습니다.",
  SOIL_SUMMARY_NOT_READY:
    "토양 상태를 요약할 자료가 아직 충분하지 않습니다.",
  NON_CURRENT_SOURCE:
    "현재 시점 자료가 아닌 출처가 포함되어 판단 범위가 제한됩니다.",
  NO_CURRENT_FORECAST_VALUES:
    "사용 가능한 예보 값이 없어 가까운 위험을 확정하지 않았습니다.",
  CLIMATE_COVERAGE_BELOW_40_PERCENT:
    "기후 자료 범위가 부족해 장기 기후 판단을 보류했습니다.",
  NO_VALID_SOIL_METRICS:
    "판단에 사용할 수 있는 토양 항목이 없어 토양 상태를 보류했습니다.",
  RECENT_OBSERVATIONS_UNAVAILABLE:
    "최근 관측자료가 없어 최근 기상 추이를 확인하지 못했습니다."
});

const TOPIC_KEYWORDS = Object.freeze({
  SOIL: ["토양", "흙", "ph", "ec", "산도", "배수", "토성", "필지"],
  WEATHER: [
    "날씨",
    "기상",
    "기온",
    "온도",
    "강수",
    "비",
    "예보",
    "바람",
    "저온",
    "고온"
  ],
  ACTION: ["해야", "행동", "조치", "어떻게", "오늘", "먼저", "점검"],
  SOURCE: ["자료", "출처", "연결", "api", "근거", "확인"],
  STATUS: ["상태", "결과", "판단", "점수", "왜", "주의"],
  RECHECK: ["언제", "다시", "재확인", "며칠", "시점"]
});

const CROP_NAMES = Object.freeze({
  APPLE: "사과",
  PEAR: "배",
  CUCUMBER: "오이",
  POTATO: "감자",
  LETTUCE: "상추"
});

const RESTRICTED_PATTERNS = Object.freeze([
  {
    outcome: "SAFETY_LIMIT",
    pattern:
      /(?:(?:사람|아이|어린이|반려동물|개|고양이).{0,24}(?:농약|살충제|살균제|제초제|약제).{0,24}(?:먹|마시|마셨|마신|마셔|삼키|삼켰|흡입|눈|피부|노출|중독)|(?:농약|살충제|살균제|제초제|약제).{0,24}(?:먹|마시|마셨|마신|마셔|삼키|삼켰|흡입|눈|피부|노출|중독)|응급|119)/u,
    answer:
      "사람이나 동물의 농약·약제 섭취, 흡입, 눈·피부 노출 가능성은 이 서비스가 판단할 수 없습니다. 즉시 119 또는 의료기관에 연락하고, 사용한 제품의 라벨과 용기를 함께 확인해 주세요."
  },
  {
    outcome: "SAFETY_LIMIT",
    pattern: /(농약|살충제|살균제|제초제|약제|희석배수|몇\s*배로)/u,
    answer:
      "농약·약제의 제품 선택, 희석배수, 살포량은 현재 분석 근거만으로 정하지 않습니다. 작물명·병해충·제품 라벨을 확인한 뒤 농촌진흥청 농약안전정보시스템 또는 가까운 농업기술센터의 등록 기준을 확인해 주세요."
  },
  {
    outcome: "SAFETY_LIMIT",
    pattern:
      /(비료|복합비료|요소(?:비료)?|퇴비|질소|인산|칼리|시비|웃거름|밑거름).*(몇|양|kg|킬로|포대|뿌려|줘|줘야|처방)/u,
    answer:
      "비료 종류와 양은 필지 토양검정과 작물별 처방 없이 확정하지 않습니다. 최근 토양검정 결과가 있으면 등록하고, 없으면 농업기술센터의 토양검정·비료사용처방을 먼저 받아 주세요."
  },
  {
    // 흙톡이 검수된 참고 사진을 보여주게 되었으므로, "사진"이라는 단어만으로는
    // 막지 않는다. 여전히 막는 것은 사용자의 사진을 보고 원인·병명을 판단해
    // 달라는 요청이다. 참고 사진을 보여 달라는 요청은 exemptedByImageRequest가
    // 먼저 걸러 재배 참고 자료로 이어진다.
    id: "PHOTO_DIAGNOSIS",
    outcome: "NOT_SUPPORTED",
    pattern: new RegExp(
      [
        "병명",
        "무슨\\s*병",
        "병해충\\s*진단",
        "(?:사진|이미지)[^?!.]{0,20}" +
          "(?:진단|판단|원인|왜|이상|이래|이러|병\\s*(?:인지|이야|이에요|입니까|같))",
        "(?:진단|판단)[^?!.]{0,10}(?:사진|이미지)"
      ].join("|"),
      "u"
    ),
    answer:
      "현재 버전은 사진으로 병명이나 병해충을 진단하지 않습니다. 잎·줄기·열매의 이상 부위를 여러 각도에서 기록하고 발생 시점과 범위를 함께 적은 뒤 농업기술센터에 확인해 주세요."
  }
]);

/**
 * 검수 코퍼스를 한 번만 색인해 두는 RAG 검색 소스를 만든다.
 *
 * @param {object} options
 * @param {Array} options.passages    reviewed-knowledge-base.js의 문단 배열
 * @param {boolean} options.allowDraft 검수 대기(DRAFT) 문단도 노출할지
 */
export function createKnowledgeSource({
  passages = [],
  images = {},
  allowDraft = false
} = {}) {
  const index = buildKnowledgeIndex(passages);
  const reviewedCount = passages.filter(
    (passage) => passage?.reviewState === "REVIEWED",
  ).length;
  const usableCount = allowDraft ? index.documentCount : reviewedCount;
  return Object.freeze({
    state: usableCount > 0 ? "READY" : "EMPTY",
    allowDraft,
    passageCount: index.documentCount,
    reviewedCount,
    describeImage(imageId) {
      if (typeof imageId !== "string" || !imageId) return null;
      return describeKnowledgeImage(images?.[imageId], imageId);
    },
    retrieve({ question, crop, topics }) {
      return retrieveKnowledge({
        index,
        question,
        crop,
        topics,
        allowDraft,
        limit: MAX_KNOWLEDGE_ITEMS,
      });
    },
  });
}

export function buildAssistantCatalog(analysis, { knowledgeHits = [] } = {}) {
  const items = [];
  const add = (kind, text, tags = [], metadata = null) => {
    const normalized = typeof text === "string" ? text.trim() : "";
    if (!normalized) return;
    if (items.some((item) => item.kind === kind && item.text === normalized)) {
      return;
    }
    items.push({
      id: `ITEM_${items.length + 1}`,
      kind,
      text: normalized.slice(0, 360),
      tags: [...new Set([...tags, ...tagsForText(normalized)])],
      // 재배 참고 문단의 제목·이미지·출처. Google AI 어댑터의 normalizeCatalog가
      // id/kind/text/tags만 남기므로 이 필드는 모델로 전송되지 않는다.
      knowledge: metadata
    });
  };

  const report = buildDeterministicReport(analysis);
  add("SUMMARY", report.summary?.text, ["GENERAL", "STATUS"]);

  [
    ["기후", analysis?.climate?.state, "WEATHER"],
    ["토양", analysis?.soil?.state, "SOIL"],
    ["가까운 예보", analysis?.forecast?.state, "WEATHER"]
  ].forEach(([label, state, topic]) => {
    add(
      "STATUS",
      `${label} 자료 상태는 ${STATE_TEXT[state] ?? "확인 필요"}입니다.`,
      [topic, "STATUS"]
    );
  });

  for (const risk of analysis?.forecast?.result?.risks ?? []) {
    add(
      "RISK",
      risk?.guidance?.reason ?? risk?.renderedText ?? risk?.title,
      ["WEATHER", "STATUS"]
    );
    for (const action of risk?.guidance?.actions ?? []) {
      add("ACTION", action, ["WEATHER", "ACTION"]);
    }
    add("RECHECK", risk?.guidance?.recheck, [
      "WEATHER",
      "RECHECK",
      "ACTION"
    ]);
  }

  for (const action of report.nextActions ?? []) {
    add("ACTION", action?.text, ["ACTION"]);
  }
  for (const limitation of analysis?.limitations ?? []) {
    const translated = LIMITATION_TEXT[limitation];
    if (translated) add("LIMITATION", translated, ["SOURCE", "STATUS"]);
  }
  for (const source of analysis?.dataSources ?? []) {
    const status = sourceStateText(source);
    if (status) {
      add(
        "SOURCE",
        `${source.sourceName ?? "공공자료"}: ${status}`,
        ["SOURCE"]
      );
    }
  }

  // 분석 근거를 먼저 24개로 고정한 뒤 재배 참고 문단을 뒤에 붙인다. 순서를
  // 바꾸면 실제 분석 근거가 배경 설명에 밀려 잘려 나갈 수 있다.
  items.length = Math.min(items.length, 24);
  for (const hit of knowledgeHits.slice(0, MAX_KNOWLEDGE_ITEMS)) {
    const passage = hit?.passage;
    if (!passage) continue;
    add(
      "KNOWLEDGE",
      passage.text,
      [...(passage.topics ?? []), "KNOWLEDGE"],
      {
        passageId: passage.id,
        title: passage.title,
        imageId: passage.imageId ?? null,
        reviewState: passage.reviewState ?? "DRAFT",
        source: passage.source ?? null,
        score: hit.score ?? null
      }
    );
  }
  return items;
}

export function classifyAssistantIntent(question) {
  const normalized = normalizeQuestion(question).toLowerCase();
  const topics = Object.entries(TOPIC_KEYWORDS)
    .filter(([, keywords]) =>
      keywords.some((keyword) => normalized.includes(keyword))
    )
    .map(([topic]) => topic);
  return Object.freeze({
    topics: topics.length ? topics : ["GENERAL"],
    wantsAction: topics.includes("ACTION"),
    wantsReason:
      topics.includes("STATUS") ||
      normalized.includes("이유") ||
      normalized.includes("왜"),
    wantsRecheck: topics.includes("RECHECK")
  });
}

export async function answerGroundedQuestion({
  analysis,
  question,
  assistant,
  knowledge = null,
  signal,
  deadlineAt
}) {
  const policyResult = classifyAssistantPolicy(question, analysis);
  if (policyResult) {
    return Object.freeze({
      mode: "POLICY",
      outcome: policyResult.outcome,
      fallbackReason: null,
      grounded: true,
      answer: policyResult.answer,
      itemIds: [],
      references: Object.freeze([]),
      retrieval: Object.freeze({ state: "SKIPPED_BY_POLICY", matched: 0 }),
      notice: "안전 기준과 현재 농장 문맥을 먼저 확인했습니다."
    });
  }
  const intent = classifyAssistantIntent(question);
  // 안전 정책을 통과한 질문만 코퍼스를 검색한다. 농약·비료·병명 질문은 위에서
  // 이미 정해진 안내로 끝나므로 배경 지식이 붙지 않는다.
  const knowledgeHits =
    knowledge?.state === "READY"
      ? knowledge.retrieve({
          question,
          crop: analysis?.inputSummary?.crop ?? null,
          topics: intent.topics
        })
      : [];
  const catalog = buildAssistantCatalog(analysis, { knowledgeHits });
  let selectedIds = [];
  let mode = "FALLBACK";
  let fallbackReason =
    assistant?.state === "READY" ? null : "GOOGLE_AI_NOT_CONFIGURED";
  if (assistant?.state === "READY" && typeof assistant.select === "function") {
    try {
      const selection = await assistant.select({
        intent,
        catalog,
        signal,
        deadlineAt
      });
      selectedIds = selection?.selectedIds ?? [];
      mode = "GOOGLE_AI";
    } catch (error) {
      selectedIds = [];
      fallbackReason = safeAssistantFailure(error);
    }
  }

  const selected = completeSelection({
    catalog,
    selectedIds,
    intent,
    hasKnowledge: knowledgeHits.length > 0
  });
  const references = buildReferences(selected, knowledge);
  return Object.freeze({
    mode,
    outcome: "ANSWERED",
    fallbackReason: mode === "GOOGLE_AI" ? null : fallbackReason,
    grounded: true,
    answer: renderAnswer(selected),
    itemIds: selected.map(({ id }) => id),
    references,
    retrieval: Object.freeze({
      state: knowledge?.state ?? "NOT_CONFIGURED",
      matched: knowledgeHits.length
    }),
    notice: assistantNotice({ mode, referenceCount: references.length })
  });
}

function assistantNotice({ mode, referenceCount }) {
  const base =
    mode === "GOOGLE_AI"
      ? "Google AI가 검증된 근거 중 관련 항목만 선택했습니다."
      : "검증된 근거를 기본 규칙으로 정리했습니다.";
  return referenceCount > 0
    ? `${base} 재배 참고 자료 ${referenceCount}건을 함께 찾았습니다.`
    : base;
}

/**
 * 선택된 항목 중 재배 참고 문단만 골라 화면에 보여줄 인용 카드로 바꾼다.
 * 업스트림 이미지 URL은 담지 않는다. 브라우저는 imageId로만 프록시를 호출한다.
 */
function buildReferences(selected, knowledgeSource) {
  return Object.freeze(
    selected
      .filter(({ kind, knowledge }) => kind === "KNOWLEDGE" && knowledge)
      .map(({ knowledge }) =>
        Object.freeze({
          passageId: knowledge.passageId,
          title: knowledge.title,
          reviewState: knowledge.reviewState,
          sourceTitle: knowledge.source?.sourceTitle ?? null,
          sourceUrl: knowledge.source?.sourceUrl ?? null,
          // available이 false면 화면은 이미지 자리를 비우고 "이미지 자료 미연결"로
          // 표시한다. 연결되지 않은 URL로 <img>를 만들면 깨진 아이콘만 남는다.
          image: knowledgeSource?.describeImage?.(knowledge.imageId) ?? null
        })
      )
  );
}

// "참고 사진 보여줘"처럼 검수된 자료를 보여 달라는 요청. 판단을 요구하는 낱말이
// 하나라도 섞이면 요청으로 보지 않고 사진 진단 차단 규칙으로 넘긴다.
const REFERENCE_IMAGE_REQUEST =
  /(?:사진|이미지|그림)[^?!.]{0,12}(?:보여|보고\s*싶|볼\s*수|있(?:어|나|을까|습니까)|첨부|함께|같이|참고)/u;
const IMAGE_INTERPRETATION_REQUEST =
  /(?:왜|이상|이래|이러|원인|진단|판단|병명|무슨\s*병)/u;

function exemptedByImageRequest(rule, normalized) {
  if (rule.id !== "PHOTO_DIAGNOSIS") return false;
  return (
    REFERENCE_IMAGE_REQUEST.test(normalized) &&
    !IMAGE_INTERPRETATION_REQUEST.test(normalized)
  );
}

export function classifyAssistantPolicy(question, analysis) {
  const normalized = normalizeQuestion(question);
  for (const rule of RESTRICTED_PATTERNS) {
    if (exemptedByImageRequest(rule, normalized)) continue;
    if (rule.pattern.test(normalized)) return rule;
  }

  if (/생육\s*점수/u.test(normalized)) {
    const growthScore = analysis?.growthScore;
    if (!Number.isFinite(growthScore?.score)) {
      return {
        outcome: "NEEDS_CLARIFICATION",
        answer:
          "현재는 생육점수를 계산할 환경자료가 부족합니다. 없는 값을 0점으로 채우지 않으므로 날씨·토양·예보 값이 더 확인된 뒤 표시합니다."
      };
    }
    const components = Object.entries(growthScore.components ?? {})
      .filter(([, component]) => Number.isFinite(component?.score))
      .map(([key, component]) => `${growthScoreComponentLabel(key)} ${component.score}점`)
      .join(", ");
    return {
      outcome: "ANSWERED",
      answer:
        `현재 생육점수는 ${growthScore.score}점(${growthScore.label})입니다. ` +
        `${components || "확인된 환경조건"}을 작물 영향도·자료 신뢰도·자료 충족도에 따라 반영했습니다. ` +
        "점수가 높아도 실제 작물의 안전을 확정하지는 않으며, 사진·센서·현장 확인을 더하면 정확도를 높일 수 있습니다."
    };
  }

  if (
    /(?:환경|적합도|종합|통합|안전)\s*점수|총\s*점/u.test(normalized)
  ) {
    return {
      outcome: "NEEDS_CLARIFICATION",
      answer:
        "현재 제공하는 숫자는 기상·토양·예보를 작물 영향도와 자료 신뢰도에 따라 계산한 환경 기반 생육점수입니다. 실제 작물의 안전이나 수확량을 보증하는 점수는 아닙니다."
    };
  }

  if (/(배수|물\s*빠짐)(?:\s*상태|조건|등급|이|은|는|이\s*좋|이\s*나쁘|어떻|알려|확인|\?|$)/u.test(normalized)) {
    return {
      outcome: "NEEDS_CLARIFICATION",
      answer:
        "현재 분석에는 사용자에게 설명할 수 있도록 검수된 필지 배수 등급이 없어 내 밭의 물 빠짐 상태를 확정할 수 없습니다. 비가 온 뒤 고인 물·배수로 막힘·뿌리 주변 과습을 현장에서 확인하고, 이상이 있으면 물 흐름을 먼저 확보한 뒤 내일 다시 확인해 주세요."
    };
  }

  if (/(다른\s*농장|농장.{0,12}비교|비교.{0,12}농장)/u.test(normalized)) {
    return {
      outcome: "NOT_SUPPORTED",
      answer:
        "현재 도우미는 선택한 농장 한 곳의 분석만 설명하며 농장 간 비교는 하지 않습니다. 비교할 농장을 바꾼 뒤 각 결과를 따로 확인해 주세요."
    };
  }

  if (
    /(완료|추가|삭제|저장|변경|수정|체크).{0,16}(처리|해\s*줘|해줘|해주세요)|(투두|할\s*일|농장|사진).{0,16}(추가|삭제|저장|변경|수정|완료)/u.test(normalized)
  ) {
    return {
      outcome: "NOT_SUPPORTED",
      answer:
        "현재 도우미는 분석 근거를 설명만 하며 할 일·농장·사진 기록을 변경하지 않습니다. 요청한 항목은 아무것도 변경되지 않았습니다."
    };
  }

  const currentCropCode = analysis?.inputSummary?.crop;
  const currentCrop = CROP_NAMES[currentCropCode] ?? null;
  const otherCropCode = mentionedCropCodes(normalized).find(
    (cropCode) => cropCode !== currentCropCode,
  );
  const otherCrop = CROP_NAMES[otherCropCode] ?? null;
  if (currentCrop && otherCrop) {
    return {
      outcome: "NEEDS_CLARIFICATION",
      answer:
        `현재 대화는 ${currentCrop} 분석을 기준으로 합니다. ${otherCrop} 결과가 필요하면 대시보드에서 ${otherCrop} 작물 탭으로 바꾼 뒤 다시 질문해 주세요.`
    };
  }

  if (
    /(오늘|내일|모레|이번\s*주).{0,18}(비|강수|기온|온도|날씨)|(비|강수|기온|온도|날씨).{0,18}(오늘|내일|모레|이번\s*주)/u.test(normalized)
  ) {
    return {
      outcome: "NOT_SUPPORTED",
      answer:
        "날짜별 기온·강수 수치는 대시보드의 7일 예보에서 확인해 주세요. 현재 도우미는 해당 수치에 대한 작물별 이유와 행동만 설명합니다."
    };
  }

  if (
    normalized.length <= 40 &&
    /(그거|그건|그때|아까|저거|그러면|그럼|그\s*이유|왜\s*그)/u.test(normalized)
  ) {
    return {
      outcome: "NEEDS_CLARIFICATION",
      answer:
        "이 도우미는 이전 질문을 기억해 이어서 판단하지 않습니다. 작물과 궁금한 날짜·항목을 한 문장으로 다시 적어 주세요. 예: ‘사과에 내일 비가 오면 무엇을 확인해야 해?’"
    };
  }

  return null;
}

function growthScoreComponentLabel(key) {
  return ({ climate: "기후", soil: "토양", forecast: "예보" })[key] ?? "환경";
}

function mentionedCropCodes(normalized) {
  const patterns = {
    APPLE: /사과/u,
    PEAR: /(배나무|배\s*(농장|과수원|작물|품종|상태|결과|재배|는|가|를|에|의)(?:\s|[?!.]|$))/u,
    CUCUMBER: /오이/u,
    POTATO: /감자/u,
    LETTUCE: /상추/u
  };
  return Object.entries(patterns)
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([cropCode]) => cropCode);
}

function safeAssistantFailure(error) {
  const byState = {
    AUTH_ERROR: "GOOGLE_AI_AUTH_ERROR",
    RATE_LIMITED: "GOOGLE_AI_RATE_LIMITED",
    TIMEOUT: "GOOGLE_AI_TIMEOUT",
    SCHEMA_CHANGED: "GOOGLE_AI_RESPONSE_CHANGED"
  };
  if (byState[error?.adapterState]) return byState[error.adapterState];
  const allowedCodes = new Set([
    "GOOGLE_AI_NOT_CONFIGURED",
    "GOOGLE_AI_CATALOG_EMPTY",
    "GOOGLE_AI_EMPTY_RESPONSE",
    "GOOGLE_AI_INVALID_RESPONSE",
    "GOOGLE_AI_SELECTION_EMPTY"
  ]);
  return allowedCodes.has(error?.code)
    ? error.code
    : "GOOGLE_AI_UNAVAILABLE";
}

export function normalizeQuestion(question) {
  if (typeof question !== "string") return "";
  return question
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function completeSelection({ catalog, selectedIds, intent, hasKnowledge = false }) {
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const selected = [
    ...new Set(selectedIds.filter((id) => byId.has(id)))
  ].map((id) => byId.get(id));
  const ranked = [...catalog].sort(
    (a, b) => scoreItem(b, intent) - scoreItem(a, intent)
  );
  const appendFirst = (kinds) => {
    const item = ranked.find(
      (candidate) =>
        kinds.includes(candidate.kind) &&
        !selected.some(({ id }) => id === candidate.id)
    );
    if (item) selected.push(item);
  };

  if (!selected.some(({ kind }) => ["SUMMARY", "STATUS", "RISK"].includes(kind))) {
    appendFirst(["RISK", "SUMMARY", "STATUS"]);
  }
  if (intent.wantsReason && !selected.some(({ kind }) => kind === "RISK")) {
    appendFirst(["RISK"]);
  }
  if (intent.wantsAction || selected.some(({ kind }) => kind === "RISK")) {
    appendFirst(["ACTION"]);
  }
  if (intent.wantsRecheck) appendFirst(["RECHECK"]);
  if (intent.topics.includes("SOURCE")) appendFirst(["SOURCE", "LIMITATION"]);
  if (intent.topics.includes("SOIL")) appendFirst(["LIMITATION", "STATUS"]);
  // 검색된 재배 참고가 있으면 최소 한 건은 답변에 남긴다. Google AI가 고르지
  // 않았거나 FALLBACK으로 내려간 경우에도 배경 설명과 이미지가 사라지지 않게
  // 하려는 것이다.
  if (hasKnowledge && !selected.some(({ kind }) => kind === "KNOWLEDGE")) {
    appendFirst(["KNOWLEDGE"]);
  }

  const knowledge = selected.filter(({ kind }) => kind === "KNOWLEDGE");
  const evidence = selected.filter(({ kind }) => kind !== "KNOWLEDGE");
  return [
    ...evidence.slice(0, 6),
    ...knowledge.slice(0, MAX_KNOWLEDGE_ITEMS)
  ].sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind));
}

function scoreItem(item, intent) {
  let score = item.kind === "SUMMARY" ? 1 : 0;
  for (const topic of intent.topics) {
    if (item.tags.includes(topic)) score += 4;
  }
  if (intent.wantsAction && item.kind === "ACTION") score += 7;
  if (intent.wantsReason && ["RISK", "SUMMARY"].includes(item.kind)) score += 5;
  if (intent.wantsRecheck && item.kind === "RECHECK") score += 7;
  return score;
}

function renderKnowledgeGroup(items) {
  // 재배 참고는 문단마다 제목을 앞에 붙여 줄로 나눈다. 분석 근거와 달리 여러
  // 주제가 섞일 수 있어서 한 줄로 이어 붙이면 어디까지가 한 설명인지 흐려진다.
  return items
    .map(({ knowledge, text }) =>
      knowledge?.title ? `${knowledge.title}: ${text}` : text
    )
    .join("\n");
}

function renderAnswer(items) {
  if (items.length === 0) {
    return [
      "현재 분석에서 설명할 수 있는 근거가 없습니다.",
      "농장 분석을 다시 실행한 뒤 확인해 주세요."
    ].join("\n");
  }
  const groups = [
    ["확인된 내용", ["SUMMARY", "STATUS", "RISK"]],
    ["필요한 행동", ["ACTION"]],
    ["다시 확인할 때", ["RECHECK"]],
    ["재배 참고", ["KNOWLEDGE"]],
    ["자료 확인", ["SOURCE", "LIMITATION"]]
  ];
  return groups
    .map(([heading, kinds]) => {
      const matched = items.filter(({ kind }) => kinds.includes(kind));
      if (matched.length === 0) return null;
      const body =
        heading === "재배 참고"
          ? renderKnowledgeGroup(matched)
          : matched.map(({ text }) => text).join(" ");
      return `${heading}\n${body}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function tagsForText(text) {
  const lower = text.toLowerCase();
  return Object.entries(TOPIC_KEYWORDS)
    .filter(([, keywords]) =>
      keywords.some((keyword) => lower.includes(keyword))
    )
    .map(([topic]) => topic);
}

function sourceStateText(source) {
  if (
    source?.deliveryState === "LIVE" &&
    ["CURRENT", "RECENT"].includes(source?.freshness)
  ) {
    return "현재 분석에 연결된 자료";
  }
  if (source?.deliveryState === "LIVE") return "연결되었으나 시점 확인이 필요한 자료";
  if (source?.deliveryState === "REFERENCE") return "공식 평년 참고자료";
  if (source?.deliveryState === "SAMPLE") return "개발 샘플이라 농업 판단에 사용하지 않는 자료";
  if (source?.adapterState === "UNAVAILABLE") return "현재 값을 받지 못한 자료";
  return null;
}

function kindOrder(kind) {
  return {
    SUMMARY: 0,
    STATUS: 1,
    RISK: 2,
    ACTION: 3,
    RECHECK: 4,
    KNOWLEDGE: 5,
    SOURCE: 6,
    LIMITATION: 7
  }[kind] ?? 9;
}
