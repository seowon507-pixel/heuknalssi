const DATE_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

const PHOTO_STATE_LABELS = Object.freeze({
  READY: "사진 기록 있음",
  PARTIAL: "일부 사진만 확인 가능",
  UNAVAILABLE: "사진 기록 없음",
  UNSUPPORTED: "사진 비교 미지원",
});

const PHOTO_CHANGE_LABELS = Object.freeze({
  COLOR: Object.freeze({
    LIGHTER: "색이 더 밝게 보임",
    DARKER: "색이 더 어둡게 보임",
    MORE_YELLOW: "노란색으로 보이는 부분이 늘어남",
    LESS_YELLOW: "노란색으로 보이는 부분이 줄어듦",
    NO_VISIBLE_CHANGE: "눈에 보이는 변화 없음",
  }),
  AREA: Object.freeze({
    INCREASED: "보이는 면적이 늘어남",
    DECREASED: "보이는 면적이 줄어듦",
    NO_VISIBLE_CHANGE: "눈에 보이는 변화 없음",
  }),
  SHAPE: Object.freeze({
    MORE_CURLED: "말려 보이는 형태가 늘어남",
    LESS_CURLED: "말려 보이는 형태가 줄어듦",
    MORE_IRREGULAR: "불규칙하게 보이는 형태가 늘어남",
    LESS_IRREGULAR: "불규칙하게 보이는 형태가 줄어듦",
    NO_VISIBLE_CHANGE: "눈에 보이는 변화 없음",
  }),
});

export function presentPhotoRecord(photo = {}) {
  return {
    photoId: text(photo.photoId),
    farmId: text(photo.farmId),
    cropId: text(photo.cropId),
    seasonId: text(photo.seasonId),
    observedAt: photo.observedAt ?? null,
    observedAtLabel: `촬영 ${formatDate(photo.observedAt)}`,
    createdAt: photo.createdAt ?? null,
    createdAtLabel: `등록 ${formatDate(photo.createdAt)}`,
    growthStage: nullableText(photo.growthStage),
    note: nullableText(photo.note),
    consentLabel:
      photo.consentState === "GRANTED" ? "저장 동의됨" : "저장 동의 철회됨",
    deletable: photo.deletedAt == null,
    deleteRequiresConfirmation: true,
    hasThumbnail: photo.hasThumbnail === true || Boolean(photo.thumbnailPath),
  };
}

export function presentPhotoComparison(comparison = {}) {
  const observableChanges = Array.isArray(comparison.observableChanges)
    ? comparison.observableChanges
        .filter((change) => PHOTO_CHANGE_LABELS[change?.aspect]?.[change?.change])
        .map((change) => ({
          aspect: change.aspect,
          change: change.change,
          label: PHOTO_CHANGE_LABELS[change.aspect][change.change],
        }))
    : [];
  return {
    comparisonId: text(comparison.comparisonId),
    baselinePhotoId: text(comparison.baselinePhotoId),
    currentPhotoId: text(comparison.currentPhotoId),
    periodLabel: `${formatDate(comparison.baselineObservedAt)} → ${formatDate(
      comparison.currentObservedAt,
    )}`,
    observableChanges,
    limitation:
      "사진에서 눈에 보이는 변화만 비교하며 상태를 확정하지 않습니다.",
  };
}

export function presentSeasonSummary(summary = {}) {
  const photos = Array.isArray(summary.photoTimeline)
    ? summary.photoTimeline.map(presentPhotoRecord)
    : [];
  const photoState = PHOTO_STATE_LABELS[summary.photoEvidence?.state] ??
    "사진 상태 확인 중";
  return {
    seasonId: text(summary.seasonId),
    farmId: text(summary.farmId),
    cropId: text(summary.cropId),
    status: summary.status === "COMPLETED" ? "종료" : "진행 중",
    completedActionCount: safeCount(summary.completedActionCount),
    skippedActionCount: safeCount(summary.skippedActionCount),
    actionTimeline: Array.isArray(summary.actionTimeline)
      ? summary.actionTimeline.map(presentAction)
      : [],
    riskTimeline: Array.isArray(summary.riskTimeline)
      ? summary.riskTimeline.map(presentRisk)
      : [],
    photos,
    comparisons: Array.isArray(summary.comparisonTimeline)
      ? summary.comparisonTimeline.map(presentPhotoComparison)
      : [],
    photoState,
    photoGuidance:
      photos.length === 0
        ? "사진은 선택 기록입니다. 사진이 없어도 저장된 할 일과 주의 기록은 계속 확인할 수 있습니다."
        : "촬영일 기준으로 사진 기록과 눈에 보이는 변화를 확인합니다.",
    blocked: summary.photoEvidence?.blocksProduct === true,
    limitationMessages: userLimitationMessages(summary.limitations),
  };
}

export function renderPhotoSeasonPanel(input = {}) {
  const scopes = Array.isArray(input.scopes) ? input.scopes : [];
  if (scopes.length === 0) {
    return '<section class="photo-season" aria-label="사진 기록과 시즌 회고"><p>표시할 재배 시즌이 없습니다.</p></section>';
  }

  const cards = scopes.map(({ farm = {}, crop = {}, summary = {} }) => {
    const view = presentSeasonSummary(summary);
    const photos = view.photos.length
      ? `<ul class="photo-season__photos">${view.photos
          .map(
            (photo) =>
              `<li><strong>${escapeHtml(photo.observedAtLabel)}</strong>${
                photo.growthStage
                  ? ` · ${escapeHtml(photo.growthStage)}`
                  : ""
              }${photo.note ? `<p>${escapeHtml(photo.note)}</p>` : ""}<small>${escapeHtml(
                photo.consentLabel,
              )}</small>${
                photo.deletable
                  ? `<button type="button" data-photo-delete="${escapeHtml(
                      photo.photoId,
                    )}" data-confirm-required="true">사진 삭제</button>`
                  : ""
              }</li>`,
          )
          .join("")}</ul>`
      : `<p class="photo-season__empty">${escapeHtml(view.photoGuidance)}</p>`;
    const comparisons = view.comparisons.flatMap(
      (comparison) => comparison.observableChanges,
    );
    const changes = comparisons.length
      ? `<ul class="photo-season__changes">${comparisons
          .map((change) => `<li>${escapeHtml(change.label)}</li>`)
          .join("")}</ul>`
      : "";
    return `<article class="photo-season__card" data-farm-id="${escapeHtml(
      farm.farmId,
    )}" data-crop-id="${escapeHtml(crop.cropId)}">
      <header><p>${escapeHtml(farm.name)} · ${escapeHtml(
        crop.name,
      )}</p><h3>시즌 ${escapeHtml(view.status)}</h3></header>
      <p>완료 ${view.completedActionCount}건 · 건너뜀 ${
        view.skippedActionCount
      }건</p>
      <section aria-label="사진 기록"><h4>${escapeHtml(
        view.photoState,
      )}</h4>${photos}${changes}</section>
    </article>`;
  });

  return `<section class="photo-season" aria-label="사진 기록과 시즌 회고">${cards.join(
    "",
  )}</section>`;
}

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "날짜 미확인";
  return DATE_FORMATTER.format(date);
}

function presentAction(action = {}) {
  return {
    actionId: text(action.actionId),
    title: text(action.title),
    status: ["OPEN", "DONE", "SKIPPED", "CANCELLED"].includes(action.status)
      ? action.status
      : "OPEN",
    occurredAt: action.occurredAt ?? action.completedAt ?? action.createdAt ?? null,
  };
}

function presentRisk(risk = {}) {
  return {
    riskId: text(risk.riskId),
    title: text(risk.title),
    state: ["READY", "PARTIAL", "HOLD", "UNAVAILABLE", "UNSUPPORTED"].includes(
      risk.state,
    )
      ? risk.state
      : "UNAVAILABLE",
    occurredAt: risk.occurredAt ?? risk.observedAt ?? risk.createdAt ?? null,
  };
}

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function userLimitationMessages(values) {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) =>
    value === "PHOTO_HISTORY_ABSENT"
      ? ["이 시즌에는 저장된 사진 기록이 없습니다."]
      : [],
  );
}

function nullableText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function escapeHtml(value) {
  return text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
