import { calculateNormalizedDeviation } from "./climate.js";
import { RAW_WEIGHT_BY_TIER } from "./constants.js";

/**
 * 생육 적합도 점수.
 *
 * 새 가중치를 만들지 않는다. 이미 검수된 규칙의 민감도 등급
 * (CRITICAL 3 / IMPORTANT 2 / SUPPORTING 1)과 각 모듈이 이미 계산해 둔
 * 정규화 편차를 그대로 쓴다. 산식은 응답에 함께 실어 화면에 드러낸다.
 *
 *   항목 편차   = |실측값 − 적정범위| ÷ 적정범위 폭   (범위 안이면 0)
 *   모듈 편차   = Σ(가중치 × 항목편차) ÷ Σ(가중치)
 *   모듈 점수   = 100 × (1 − min(모듈편차, 1))
 *   종합 점수   = Σ(모듈계획가중치 × 모듈점수) ÷ Σ(모듈계획가중치)
 *
 * 자료가 모자라면 점수를 만들지 않고 보류한다. 반쪽짜리 근거로 숫자를
 * 내놓는 것이 이 제품에서는 가장 위험한 실패다.
 */

const SCORE_BLOCKED_STATES = Object.freeze(["HOLD", "UNAVAILABLE"]);

function toScore(deviation) {
  if (!Number.isFinite(deviation)) return null;
  return Math.round(100 * (1 - Math.min(Math.max(deviation, 0), 1)));
}

function grade(score) {
  if (score === null) return "판단 보류";
  if (score >= 85) return "매우 적합";
  if (score >= 70) return "적합";
  if (score >= 50) return "주의";
  return "부적합";
}

/** 기후 모듈은 이미 가중 정규화 편차를 계산해 둔다. 그대로 쓴다. */
function climateScore(climate) {
  if (!climate || SCORE_BLOCKED_STATES.includes(climate.state)) return null;
  if (climate.state === "NOT_APPLICABLE") return null;
  const deviation = climate.result?.aggregateDeviation;
  if (!Number.isFinite(deviation)) return null;
  return {
    module: "CLIMATE",
    label: "기후",
    score: toScore(deviation),
    deviation,
    coverage: climate.coverage ?? null,
    plannedWeight: climate.result?.aggregation?.plannedDenominator ?? null,
    itemCount: climate.result?.deviations?.length ?? 0,
  };
}

/**
 * 토양은 근거에 따라 편차 계산이 다르다.
 * - 사용자 실측: 값 하나이므로 기후와 같은 정규화 편차를 쓴다(이탈 정도가 나온다).
 * - 지역 통계: 구간별 면적뿐이라 '기준 밖 면적 비율'을 편차로 본다.
 */
function soilScore(soil, rules) {
  if (!soil || SCORE_BLOCKED_STATES.includes(soil.state)) return null;
  if (soil.state === "NOT_APPLICABLE") return null;
  const metrics = soil.result?.metrics ?? [];
  if (metrics.length === 0) return null;

  const measured = soil.result?.measurementBasis === "USER_SOIL_TEST"
    ? (soil.result?.userSoilTest ?? {})
    : null;
  const byRuleId = new Map((rules ?? []).map((rule) => [rule.ruleId, rule]));
  const FIELD_BY_METRIC = {
    PH: "ph",
    EC: "electricalConductivity",
    ORGANIC_MATTER: "organicMatter",
    AVAILABLE_PHOSPHATE: "availablePhosphate",
    EXCHANGEABLE_K: "exchangeableK",
    EXCHANGEABLE_CA: "exchangeableCa",
    EXCHANGEABLE_MG: "exchangeableMg",
  };

  let weighted = 0;
  let weight = 0;
  for (const metric of metrics) {
    const rawWeight =
      metric.rawWeight ?? RAW_WEIGHT_BY_TIER[byRuleId.get(metric.ruleId)?.sensitivityTier] ?? 1;
    let deviation = null;
    const value = measured?.[FIELD_BY_METRIC[metric.metric]];
    const range = byRuleId.get(metric.ruleId)?.optimalRange;
    if (Number.isFinite(value) && Array.isArray(range)) {
      deviation = calculateNormalizedDeviation(value, range);
    }
    if (deviation === null) deviation = metric.outsideRatio ?? null;
    if (!Number.isFinite(deviation)) continue;
    weighted += rawWeight * deviation;
    weight += rawWeight;
  }
  if (weight === 0) return null;

  const deviation = weighted / weight;
  return {
    module: "SOIL",
    label: "토양",
    score: toScore(deviation),
    deviation,
    coverage: soil.coverage ?? null,
    plannedWeight: weight,
    itemCount: metrics.length,
    basis: soil.result?.measurementBasis ?? null,
  };
}

export function calculateSuitability({ climate, soil, forecast, rules = [] } = {}) {
  const soilRules = rules.filter((rule) => rule.module === "SOIL");
  const parts = [climateScore(climate), soilScore(soil, soilRules)].filter(
    (part) => part !== null && part.score !== null,
  );

  const totalWeight = parts.reduce((sum, part) => sum + (part.plannedWeight ?? 0), 0);
  const score =
    parts.length === 0 || totalWeight === 0
      ? null
      : Math.round(
          parts.reduce((sum, part) => sum + part.plannedWeight * part.score, 0) /
            totalWeight,
        );

  // 예보 위험은 '지금 당장의 주의'라서 적합도 점수에 섞지 않고 따로 표시한다.
  const riskDays = Array.isArray(forecast?.result?.risks)
    ? forecast.result.risks.length
    : 0;

  const blockedModules = [
    climate && SCORE_BLOCKED_STATES.includes(climate.state) ? "기후" : null,
    soil && SCORE_BLOCKED_STATES.includes(soil.state) ? "토양" : null,
  ].filter(Boolean);

  return {
    score,
    grade: grade(score),
    scored: score !== null,
    blockedReason:
      score === null
        ? blockedModules.length > 0
          ? `${blockedModules.join("·")} 자료가 확인되지 않아 점수를 내지 않았습니다.`
          : "점수를 낼 만큼 확인된 항목이 없습니다."
        : null,
    modules: parts.map(({ module, label, score: value, coverage, itemCount, basis }) => ({
      module,
      label,
      score: value,
      coverage,
      itemCount,
      ...(basis ? { basis } : {}),
    })),
    nearTermRiskDays: riskDays,
    method: {
      itemDeviation: "|실측값 − 적정범위| ÷ 적정범위 폭 (범위 안이면 0)",
      weights: { CRITICAL: 3, IMPORTANT: 2, SUPPORTING: 1 },
      moduleScore: "100 × (1 − min(가중평균 편차, 1))",
      totalScore: "모듈 계획가중치로 가중평균",
      note: "검수된 규칙의 민감도 등급 외에 새로 만든 가중치는 없습니다.",
    },
  };
}
