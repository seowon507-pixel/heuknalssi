export function buildAssistantCycleAnswer(question, { cropLabel, projection } = {}) {
  const normalized = String(question ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  if (!isCycleQuestion(normalized) || !projection?.progress) return null;

  const crop = String(cropLabel ?? "작물").trim() || "작물";
  const progress = formatProgress(projection.progress);
  const currentStage = milestoneText(projection.currentMilestone);
  const preparation = formatDateRange(projection.preparationStartsOn);
  const harvest = formatDateRange(projection.harvestWindow);
  const completed = projection.status === "COMPLETED";
  const planning = projection.status === "PLANNING";

  if (completed) {
    return `${crop} 재배 시즌은 종료된 상태입니다. 대시보드의 ‘재배 진행’에서 지난 기준일과 예상 수확 범위를 확인할 수 있습니다.`;
  }

  const progressSentence = planning
    ? `${crop}는 아직 재배 시작 전이며 일정 진행률은 0%입니다.`
    : `${crop}의 재배 일정은 현재 ${progress} 진행된 것으로 예상됩니다.`;
  const stageSentence = currentStage
    ? `현재 일정 단계는 ‘${currentStage}’입니다.`
    : "현재 일정 단계는 아직 정해지지 않았습니다.";
  const preparationSentence = preparation
    ? `수확 준비 시작 예상 범위는 ${preparation}입니다.`
    : "수확 준비 시작 시점은 아직 계산되지 않았습니다.";
  const harvestSentence = harvest
    ? `예상 수확 범위는 ${harvest}입니다.`
    : "예상 수확 시점은 아직 계산되지 않았습니다.";

  return [
    progressSentence,
    stageSentence,
    preparationSentence,
    harvestSentence,
    "대시보드의 ‘재배 진행’ 카드에서 확인하고 기준일이 다르면 ‘조건 바꾸기’에서 수정할 수 있습니다.",
    "이 수치는 입력한 파종·정식·개화일과 검수한 작기 범위로 계산한 일정 예상이며, 실제 생체 상태 점수는 아닙니다.",
  ].join(" ");
}

function isCycleQuestion(question) {
  return /(?:재배|작기|생육).{0,12}(?:진행|일정|단계|얼마)|진행률|얼마나\s*(?:진행|자랐)|수확.{0,12}(?:언제|시점|예정|준비)|언제.{0,12}수확/u.test(question);
}

function formatProgress(progress) {
  const minimum = boundedPercent(progress?.minPercent);
  const maximum = boundedPercent(progress?.maxPercent);
  if (minimum == null || maximum == null) return "확인 중인 상태로";
  return minimum === maximum ? `${minimum}%` : `${minimum}~${maximum}%`;
}

function boundedPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, Math.round(number)));
}

function milestoneText(milestone) {
  return Array.isArray(milestone?.candidates)
    ? milestone.candidates.map(({ label }) => String(label ?? "").trim()).filter(Boolean).join(" 또는 ")
    : "";
}

function formatDateRange(range) {
  const earliest = formatDate(range?.earliest);
  const latest = formatDate(range?.latest);
  if (!earliest || !latest) return null;
  return earliest === latest ? earliest : `${earliest}~${latest}`;
}

function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(value ?? ""));
  if (!match) return null;
  return `${Number(match[2])}월 ${Number(match[3])}일`;
}
