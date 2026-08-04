const SOURCE = Object.freeze({
  sourceId: "ncpms-reviewed-reference",
  sourceName: "국가농작물병해충관리시스템(NCPMS)",
  sourceUrl: "https://ncpms.rda.go.kr/npms/OpenApiInfo.np",
  sourceState: "REVIEWED_REFERENCE",
  reviewedAt: "2026-08-03",
});

const OBSERVATIONS = Object.freeze({
  APPLE: Object.freeze([
    Object.freeze({ part: "잎과 새순", guidance: "말림·반점·변색이 한 구역에 집중되는지 확인합니다." }),
    Object.freeze({ part: "과실", guidance: "햇볕 데임·찍힘과 번지는 반점을 구분해 같은 각도로 기록합니다." }),
    Object.freeze({ part: "나무 아래", guidance: "떨어진 잎과 과실이 늘었는지, 해충이 숨을 잔재가 쌓였는지 확인합니다." }),
  ]),
  PEAR: Object.freeze([
    Object.freeze({ part: "잎과 새순", guidance: "잎 가장자리 변색, 새순 마름과 끈적이는 흔적이 있는지 확인합니다." }),
    Object.freeze({ part: "과실", guidance: "표면의 갈변·패임·반점이 어제보다 넓어졌는지 비교합니다." }),
    Object.freeze({ part: "수관과 바닥", guidance: "가지 안쪽 통풍과 떨어진 잎·열매의 증가 여부를 확인합니다." }),
  ]),
  CUCUMBER: Object.freeze([
    Object.freeze({ part: "잎 앞·뒷면", guidance: "노란 반점, 흰 가루 모양 흔적과 작은 벌레가 있는지 확인합니다." }),
    Object.freeze({ part: "줄기와 마디", guidance: "물러짐·갈변·상처가 번지는지 확인하고 사진으로 남깁니다." }),
    Object.freeze({ part: "시설 내부", guidance: "잎이 오래 젖어 있지 않은지와 환기 상태를 함께 확인합니다." }),
  ]),
  POTATO: Object.freeze([
    Object.freeze({ part: "아랫잎", guidance: "물 먹은 듯한 반점이나 빠르게 넓어지는 갈변이 있는지 확인합니다." }),
    Object.freeze({ part: "줄기", guidance: "검게 변하거나 쓰러지는 구간이 한쪽에 모여 있는지 확인합니다." }),
    Object.freeze({ part: "밭 표면", guidance: "고인 물, 과습 구간과 병든 잎 잔재가 남아 있는지 확인합니다." }),
  ]),
  LETTUCE: Object.freeze([
    Object.freeze({ part: "잎 앞·뒷면", guidance: "작은 벌레, 끈적임, 구멍과 변색이 늘었는지 확인합니다." }),
    Object.freeze({ part: "포기 중심", guidance: "무름·냄새·갈변이 안쪽으로 번지는지 확인합니다." }),
    Object.freeze({ part: "재배 공간", guidance: "잎이 겹쳐 오래 젖는 곳과 통풍이 막힌 구간을 확인합니다." }),
  ]),
});

export function buildReviewedPestObservationFallback(crop, { analysisId = null } = {}) {
  const cropCode = String(crop ?? "").toUpperCase();
  const observations = OBSERVATIONS[cropCode];
  if (!observations) return null;
  return {
    schemaVersion: 1,
    catalogVersion: "pest-observation-v1-2026-08-03",
    analysisId,
    crop: cropCode,
    state: "REVIEWED_OBSERVATION_ONLY",
    diagnosisState: "NOT_PERFORMED",
    liveOccurrenceState: "NOT_CONNECTED",
    summary: "검수된 작물 관찰 기준입니다. 병해충 발생을 확정한 결과는 아닙니다.",
    weatherSignals: [],
    observations: observations.map((item) => ({ ...item })),
    source: { ...SOURCE },
    limitations: [
      "WEATHER_SIGNAL_IS_NOT_PEST_DIAGNOSIS",
      "LIVE_NCPMS_OCCURRENCE_NOT_CONNECTED",
      "ANALYSIS_SESSION_GUIDANCE_UNAVAILABLE",
    ],
  };
}

export function selectPestRecoveryAnalysis(analyses, crop) {
  if (!(analyses instanceof Map)) return null;
  const cropCode = String(crop ?? "").toUpperCase();
  return analyses.get(cropCode) ?? null;
}

export const reviewedPestObservationCrops = Object.freeze(Object.keys(OBSERVATIONS));
