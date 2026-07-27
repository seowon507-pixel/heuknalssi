const USER_VISIBLE_FORECAST_STATES = new Set([
  "READY",
  "PARTIAL",
  "HOLD",
  "UNAVAILABLE",
]);

export function summarizeForecastEvaluation(input = {}) {
  const days = Array.isArray(input.days)
    ? input.days.filter((day) => typeof day?.date === "string")
    : [];
  const risks = Array.isArray(input.risks) ? input.risks.filter(Boolean) : [];
  const evaluations = Array.isArray(input.ruleEvaluations)
    ? input.ruleEvaluations.filter(validEvaluation)
    : [];
  const missingSummary = summarizeMissingMetrics(input.missingMetrics);
  const forecastState = USER_VISIBLE_FORECAST_STATES.has(input.forecastState)
    ? input.forecastState
    : "UNAVAILABLE";
  const dayCount = days.length;

  if (risks.length > 0) {
    return {
      kind: "RISK",
      tone: "caution",
      ready: true,
      bounded: false,
      evaluatedDayCount: evaluatedDayCount(evaluations, dayCount),
      condition: "작물 주의 기준을 넘는 예보가 있습니다.",
      reason: "위험 날짜와 필요한 행동을 우선 확인합니다.",
      actions: [],
      recheck: "위험 기상이 지난 다음 날에 작물 상태를 다시 확인합니다.",
    };
  }

  const checkedDays = evaluatedDayCount(evaluations, dayCount);
  const fullyEvaluated =
    evaluations.length > 0 &&
    evaluations.every(
      (evaluation) =>
        evaluation.status === "EVALUATED_NO_RISK" &&
        evaluation.missingDayCount === 0,
    );

  if (dayCount > 0 && checkedDays > 0) {
    const complete = forecastState === "READY" && fullyEvaluated;
    const rangeLabel =
      checkedDays === dayCount
        ? `${checkedDays}일 예보`
        : `확인 가능한 ${checkedDays}일 예보`;
    return {
      kind: complete ? "CLEAR" : "CLEAR_WITH_LIMIT",
      tone: complete ? "good" : "info",
      ready: complete,
      bounded: !complete,
      evaluatedDayCount: checkedDays,
      condition: `${rangeLabel} · 확인된 주의 기준 초과 없음`,
      reason: complete
        ? "도착한 기온·강수 예보를 이 작물의 검토 기준과 비교했으며 현재 주의 신호가 없습니다."
        : `도착한 예보 중 ${checkedDays}일은 확인했습니다. ${
            missingSummary
              ? `${missingSummary}은 아직 갱신 중입니다.`
              : "나머지 날짜나 값은 아직 갱신 중입니다."
          } 확인된 범위만 안내합니다.`,
      actions: complete
        ? [
            "오늘은 기존 농장 관리 일정을 유지하고 새 주의 알림이 생길 때만 확인합니다.",
          ]
        : [
            "오늘은 확인된 날짜의 결과만 참고하고 기존 농장 관리 일정을 유지합니다.",
            "예보가 갱신되면 새로 들어온 날짜의 주의 알림을 확인합니다.",
          ],
      recheck: complete
        ? "다음 예보 갱신 뒤 새 주의 알림이 있는지만 확인합니다."
        : "예보가 갱신되면 아직 도착하지 않은 날짜를 자동으로 다시 확인합니다.",
    };
  }

  if (dayCount > 0) {
    return {
      kind: "DATA_ONLY",
      tone: "info",
      ready: false,
      bounded: false,
      evaluatedDayCount: 0,
      condition: `${dayCount}일 예보 도착 · 기온·강수 흐름 확인`,
      reason:
        "예보값은 도착했습니다. 급격한 기온 변화와 비가 예상되는 날짜를 먼저 확인할 수 있습니다.",
      actions: [
        "기온 변화가 크거나 비가 예보된 날짜의 작물과 토양 상태를 확인합니다.",
      ],
      recheck: "다음 예보 갱신 뒤 작물별 주의 알림을 다시 확인합니다.",
    };
  }

  return {
    kind: "NO_DATA",
    tone: "unknown",
    ready: false,
    bounded: false,
    evaluatedDayCount: 0,
    condition: "가까운 예보를 불러오는 중",
    reason:
      "현재 예보값이 도착하지 않았습니다. 농장 위치는 유지한 채 예보만 다시 요청할 수 있습니다.",
    actions: ["예보 다시 불러오기를 눌러 같은 농장 조건으로 확인합니다."],
    recheck: "예보가 연결되면 자동으로 작물별 주의 기준과 비교합니다.",
  };
}

function validEvaluation(evaluation) {
  return (
    evaluation &&
    typeof evaluation === "object" &&
    Number.isInteger(evaluation.evaluatedDayCount) &&
    evaluation.evaluatedDayCount >= 0 &&
    Number.isInteger(evaluation.missingDayCount) &&
    evaluation.missingDayCount >= 0
  );
}

function evaluatedDayCount(evaluations, availableDayCount) {
  if (evaluations.length === 0 || availableDayCount === 0) return 0;
  const counts = evaluations
    .map((evaluation) => evaluation.evaluatedDayCount)
    .filter((count) => count > 0);
  if (counts.length === 0) return 0;
  return Math.min(availableDayCount, Math.min(...counts));
}

function summarizeMissingMetrics(values) {
  if (!Array.isArray(values)) return "";
  const labels = {
    minTemperature: "최저기온",
    maxTemperature: "최고기온",
    precipitationProbability: "강수확률",
    precipitationAmount: "강수량",
    windSpeed: "풍속",
  };
  const items = values
    .filter(
      (item) =>
        item &&
        typeof item.date === "string" &&
        typeof item.metric === "string",
    )
    .map((item) => {
      const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(item.date);
      const dateLabel = date
        ? `${Number(date[2])}월 ${Number(date[3])}일`
        : item.date;
      return `${dateLabel} ${labels[item.metric] ?? "예보값"}`;
    });
  return [...new Set(items)].slice(0, 2).join(" · ");
}
