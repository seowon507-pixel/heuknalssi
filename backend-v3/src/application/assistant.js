import { buildDeterministicReport } from "./templates.js";

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

export function buildAssistantCatalog(analysis) {
  const items = [];
  const add = (kind, text, tags = []) => {
    const normalized = typeof text === "string" ? text.trim() : "";
    if (!normalized) return;
    if (items.some((item) => item.kind === kind && item.text === normalized)) {
      return;
    }
    items.push({
      id: `ITEM_${items.length + 1}`,
      kind,
      text: normalized.slice(0, 360),
      tags: [...new Set([...tags, ...tagsForText(normalized)])]
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
  return items.slice(0, 24);
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
  signal,
  deadlineAt
}) {
  const catalog = buildAssistantCatalog(analysis);
  const intent = classifyAssistantIntent(question);
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
    intent
  });
  return Object.freeze({
    mode,
    fallbackReason: mode === "GOOGLE_AI" ? null : fallbackReason,
    grounded: true,
    answer: renderAnswer(selected),
    itemIds: selected.map(({ id }) => id),
    notice:
      mode === "GOOGLE_AI"
        ? "Google AI가 검증된 근거 중 관련 항목만 선택했습니다."
        : "검증된 근거를 기본 규칙으로 정리했습니다."
  });
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

function completeSelection({ catalog, selectedIds, intent }) {
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

  return selected
    .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind))
    .slice(0, 6);
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
    ["자료 확인", ["SOURCE", "LIMITATION"]]
  ];
  return groups
    .map(([heading, kinds]) => {
      const texts = items
        .filter(({ kind }) => kinds.includes(kind))
        .map(({ text }) => text);
      return texts.length ? `${heading}\n${texts.join(" ")}` : null;
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
    SOURCE: 5,
    LIMITATION: 6
  }[kind] ?? 9;
}
