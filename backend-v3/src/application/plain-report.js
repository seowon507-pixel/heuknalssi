/**
 * 초보 귀농인용 쉬운 말 리포트.
 *
 * LLM에게 새 사실을 쓰게 하지 않는다. 확정된 분석 문장만 넘겨 '다시 쓰게' 하고,
 * 돌아온 문장을 다음 세 가지로 검증한 뒤에만 사용한다.
 *
 *   1) 숫자 대조 — 결과에 있는 모든 수치가 입력 문장에도 있어야 한다
 *   2) 금지어   — 진단·처방·농약 같은 말을 쓰지 않아야 한다
 *   3) 분량     — 비어 있거나 지나치게 길지 않아야 한다
 *
 * 하나라도 걸리면 버리고 결정론적 템플릿을 그대로 쓴다. 검증에 실패했다는
 * 사실 자체도 응답에 남긴다.
 */

// 처방·진단으로 읽힐 수 있는 표현. 이 제품은 그런 판단을 하지 않는다.
const FORBIDDEN = Object.freeze([
  "농약",
  "살충",
  "살균",
  "방제",
  "처방",
  "진단",
  "병해충",
  "확실합니다",
  "틀림없",
  "보장",
]);

const MAX_PARAGRAPHS = 5;
const MAX_PARAGRAPH_LENGTH = 220;

/** 소수점·쉼표를 포함한 수치를 모두 뽑는다. */
export function extractNumbers(text) {
  return (String(text ?? "").match(/\d+(?:[.,]\d+)*/gu) ?? []).map((value) =>
    value.replace(/,/gu, ""),
  );
}

export function validatePlainReport(paragraphs, facts) {
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) {
    return { valid: false, reason: "EMPTY" };
  }
  if (paragraphs.length > MAX_PARAGRAPHS) {
    return { valid: false, reason: "TOO_MANY_PARAGRAPHS" };
  }
  if (paragraphs.some((item) => item.length > MAX_PARAGRAPH_LENGTH)) {
    return { valid: false, reason: "PARAGRAPH_TOO_LONG" };
  }

  const allowed = new Set(facts.flatMap((fact) => extractNumbers(fact)));
  for (const paragraph of paragraphs) {
    for (const number of extractNumbers(paragraph)) {
      if (!allowed.has(number)) {
        return { valid: false, reason: `INVENTED_NUMBER:${number}` };
      }
    }
    const banned = FORBIDDEN.find((word) => paragraph.includes(word));
    if (banned) {
      return { valid: false, reason: `FORBIDDEN_TERM:${banned}` };
    }
  }
  return { valid: true, reason: null };
}

/** 리포트에 넘길 확정 문장을 분석 결과에서 뽑는다. 여기 없는 말은 쓰지 못한다. */
export function buildReportFacts(analysis) {
  const facts = [];
  const summary = analysis?.inputSummary ?? {};
  if (summary.regionLabel && summary.cropLabel) {
    facts.push(`${summary.regionLabel}에서 ${summary.cropLabel}를 분석했습니다.`);
  }

  const suitability = analysis?.suitability;
  if (suitability?.scored) {
    facts.push(
      `생육 적합도는 ${suitability.score}점이고 판정은 ${suitability.grade}입니다.`,
    );
    for (const item of suitability.modules ?? []) {
      facts.push(`${item.label} 점수는 ${item.score}점입니다.`);
    }
  } else if (suitability?.blockedReason) {
    facts.push(suitability.blockedReason);
  }

  const decision = analysis?.decision;
  if (decision?.headline) facts.push(decision.headline);
  const primary = analysis?.primaryAction;
  if (primary?.title) facts.push(`먼저 할 일은 ${primary.title}입니다.`);
  for (const action of (analysis?.actions ?? []).slice(0, 3)) {
    if (action?.title) facts.push(`해야 할 일: ${action.title}`);
  }

  const soil = analysis?.soil;
  if (soil?.result?.measurementBasis === "USER_SOIL_TEST") {
    const measured = soil.result.userSoilTest ?? {};
    if (Number.isFinite(measured.ph)) {
      facts.push(`등록하신 토양검정 결과의 산도는 ${measured.ph}입니다.`);
    }
  }

  for (const limitation of (analysis?.limitations ?? []).slice(0, 3)) {
    facts.push(`확인하지 못한 항목이 있습니다: ${limitation}`);
  }
  return facts.filter((fact) => typeof fact === "string" && fact.trim());
}

/**
 * 쉬운 말 리포트를 만든다. 실패하면 null을 돌려주고 호출부가 템플릿을 쓴다.
 */
export async function buildPlainReport({
  analysis,
  assistant,
  signal,
  deadlineAt,
} = {}) {
  const facts = buildReportFacts(analysis);
  if (facts.length === 0) {
    return { state: "SKIPPED", reason: "NO_FACTS", paragraphs: [] };
  }
  if (assistant?.state !== "READY" || typeof assistant.rewrite !== "function") {
    return { state: "SKIPPED", reason: "GOOGLE_AI_NOT_CONFIGURED", paragraphs: [] };
  }

  let paragraphs;
  try {
    ({ paragraphs } = await assistant.rewrite({ facts, signal, deadlineAt }));
  } catch (error) {
    return {
      state: "FAILED",
      reason: error?.code ?? "GOOGLE_AI_ERROR",
      paragraphs: [],
    };
  }

  const check = validatePlainReport(paragraphs, facts);
  if (!check.valid) {
    // 검증 실패는 숨기지 않는다. 무엇 때문에 버렸는지 남긴다.
    return { state: "REJECTED", reason: check.reason, paragraphs: [] };
  }
  return { state: "READY", reason: null, paragraphs, factCount: facts.length };
}
