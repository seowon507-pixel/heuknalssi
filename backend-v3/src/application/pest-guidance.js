const REVIEWED_SOURCE = Object.freeze({
  sourceId: "ncpms-reviewed-reference",
  sourceName: "국가농작물병해충관리시스템(NCPMS)",
  sourceUrl: "https://ncpms.rda.go.kr/npms/OpenApiInfo.np",
  sourceState: "REVIEWED_REFERENCE",
  reviewedAt: "2026-08-03",
});

const REVIEWED_OBSERVATIONS = Object.freeze({
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

function requireIdentifier(value, field) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > 180 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    const error = new Error(`${field} must be a safe identifier`);
    error.code = "INVALID_INPUT";
    throw error;
  }
  return value.trim();
}

function currentWeatherSignals(analysis) {
  const risks = analysis?.forecast?.result?.risks;
  if (!Array.isArray(risks)) return [];
  return risks
    .filter(
      (risk) =>
        risk?.sourceFreshness === "CURRENT" &&
        typeof risk?.dateRange?.from === "string",
    )
    .map((risk) => ({
      riskId: risk.riskId,
      dateRange: structuredClone(risk.dateRange),
      severity: risk.severity,
      headline: risk.guidance?.headline ?? null,
      reason: risk.guidance?.reason ?? null,
      nextAction: risk.guidance?.nextAction ?? null,
      trigger: structuredClone(risk.trigger ?? null),
    }));
}

export function createPestGuidanceService({ getAnalysis } = {}) {
  if (typeof getAnalysis !== "function") {
    throw new TypeError("getAnalysis must be a function");
  }
  return Object.freeze({
    async getGuidance({ ownerSessionId, analysisId }) {
      const owner = requireIdentifier(ownerSessionId, "ownerSessionId");
      const id = requireIdentifier(analysisId, "analysisId");
      const analysis = await getAnalysis({ ownerSessionId: owner, analysisId: id });
      if (!analysis) return null;
      const crop = String(analysis?.inputSummary?.crop ?? "").toUpperCase();
      const observations = REVIEWED_OBSERVATIONS[crop];
      if (!observations) {
        const error = new Error("crop does not have reviewed pest guidance");
        error.code = "UNSUPPORTED_CROP";
        throw error;
      }
      const weatherSignals = currentWeatherSignals(analysis);
      return {
        schemaVersion: 1,
        catalogVersion: "pest-observation-v1-2026-08-03",
        analysisId: id,
        crop,
        state: weatherSignals.length > 0
          ? "WEATHER_LINKED_CHECK"
          : "ROUTINE_OBSERVATION",
        diagnosisState: "NOT_PERFORMED",
        liveOccurrenceState: "NOT_CONNECTED",
        summary: weatherSignals.length > 0
          ? "현재 예보에서 작물 관리에 영향을 줄 수 있는 조건이 확인되었습니다. 병해충 발생을 확정한 결과는 아니므로 현장 징후를 함께 확인하세요."
          : "현재 예보에서 긴급 관리 신호는 확인되지 않았습니다. 병해충이 없다는 뜻은 아니므로 정기 관찰을 이어가세요.",
        weatherSignals,
        observations: structuredClone(observations),
        source: structuredClone(REVIEWED_SOURCE),
        limitations: [
          "WEATHER_SIGNAL_IS_NOT_PEST_DIAGNOSIS",
          "LIVE_NCPMS_OCCURRENCE_NOT_CONNECTED",
        ],
      };
    },
  });
}

export const pestGuidanceDefaults = Object.freeze({
  supportedCrops: Object.freeze(Object.keys(REVIEWED_OBSERVATIONS)),
  source: REVIEWED_SOURCE,
});
