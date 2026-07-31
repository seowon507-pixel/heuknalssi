/**
 * 화면이 쓰는 생육 적합도 표시값.
 *
 * 점수는 여기서 만들지 않는다. 백엔드 `analysis.suitability`가 검수된 규칙의
 * 민감도 등급(CRITICAL 3 / IMPORTANT 2 / SUPPORTING 1)과 이미 계산된 정규화
 * 편차만으로 산출하고 산식까지 함께 내려준다. 이 모듈은 그 값을 화면 구조에
 * 맞게 옮겨 담기만 한다.
 *
 * 예보 위험은 '지금 당장의 주의'라서 적합도 점수에 섞지 않는다. 백엔드가
 * `nearTermRiskDays`로 따로 주고, 화면도 따로 표시한다.
 */

const MODULE_LABELS = Object.freeze({
  CLIMATE: "기후 적합",
  SOIL: "토양 적합",
});

export function calculateCropConditionScore(analysis = {}) {
  const suitability = analysis?.suitability ?? null;
  const modules = Array.isArray(suitability?.modules) ? suitability.modules : [];
  const climate = moduleScore(modules, "CLIMATE");
  const soil = moduleScore(modules, "SOIL");
  const nearTermRiskDays = Number.isFinite(suitability?.nearTermRiskDays)
    ? suitability.nearTermRiskDays
    : null;

  if (!suitability || suitability.scored !== true) {
    return {
      score: null,
      label: "산정 대기",
      tone: "hold",
      components: { climate, soil },
      nearTermRiskDays,
      basisLabel: soilBasisLabel(basisOf(modules)),
      method: suitability?.method ?? null,
      explanation:
        suitability?.blockedReason ??
        "기후·토양 근거가 확인되면 생육 적합도를 표시합니다.",
    };
  }

  return {
    score: suitability.score,
    label: suitability.grade,
    tone: toneForScore(suitability.score),
    components: { climate, soil },
    nearTermRiskDays,
    basisLabel: soilBasisLabel(basisOf(modules)),
    method: suitability.method ?? null,
    explanation: explain(suitability),
  };
}

/** 화면 축 카드가 쓰는 모듈별 점수. 없으면 null이며 0으로 채우지 않는다. */
export function moduleScore(modules, moduleId) {
  const found = (modules ?? []).find((item) => item?.module === moduleId);
  return Number.isFinite(found?.score) ? found.score : null;
}

export function moduleLabel(moduleId) {
  return MODULE_LABELS[moduleId] ?? moduleId;
}

function basisOf(modules) {
  return (modules ?? []).find((item) => item?.module === "SOIL")?.basis ?? null;
}

function explain(suitability) {
  const weights = suitability?.method?.weights;
  if (!weights) return "검수된 규칙 가중치로 산출했습니다.";
  return [
    `민감도 등급 가중치 CRITICAL ${weights.CRITICAL} ·`,
    `IMPORTANT ${weights.IMPORTANT} · SUPPORTING ${weights.SUPPORTING}로`,
    "가중평균했습니다. 새로 만든 가중치는 없습니다.",
  ].join(" ");
}

function soilBasisLabel(value) {
  if (value === "USER_SOIL_TEST") return "사용자 등록 토양검정";
  if (value === "PROVIDER_SOIL_TEST") return "필지 토양검정";
  if (value === "REGIONAL_STATISTICS") return "지역 토양 통계 추정";
  return "토양 근거 확인 필요";
}

function toneForScore(score) {
  if (!Number.isFinite(score)) return "hold";
  if (score >= 85) return "good";
  if (score >= 70) return "caution";
  if (score >= 50) return "caution";
  return "danger";
}
