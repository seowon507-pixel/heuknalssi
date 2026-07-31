const SOURCE_LABELS = Object.freeze({
  USER: "사용자 기록",
  PUBLIC_API: "공공자료",
  PHOTO: "사진 기록",
  SATELLITE: "위성 관측",
  DERIVED_RULE: "검수된 규칙",
});
const EVIDENCE_STATE_LABELS = Object.freeze({
  READY: "확인됨",
  PARTIAL: "일부 확인",
  HOLD: "판단 보류",
  UNAVAILABLE: "현재 이용 불가",
  UNSUPPORTED: "지원 안 함",
});
const STATUS_LABELS = Object.freeze({
  OPEN: "진행 전",
  DONE: "완료",
  SKIPPED: "건너뜀",
  CANCELLED: "자동 해제",
});

export const ACTION_PLAN_STYLES = `
.action-plan { color: #17251d; display: grid; gap: 20px; }
.action-plan__first { background: #173f2b; border-radius: 20px; color: #fff; padding: 24px; }
.action-plan__eyebrow { color: #bfe5c8; font-size: .82rem; font-weight: 800; letter-spacing: .04em; margin: 0 0 8px; }
.action-plan__section { display: grid; gap: 12px; }
.action-plan__section h2 { font-size: 1.2rem; margin: 0; }
.action-plan__list { display: grid; gap: 12px; list-style: none; margin: 0; padding: 0; }
.action-plan__card { background: #fff; border: 1px solid #dce6df; border-radius: 16px; padding: 18px; }
.action-plan__first .action-plan__card { background: transparent; border: 0; padding: 0; }
.action-plan__card h3 { font-size: 1.12rem; margin: 0 0 8px; }
.action-plan__instruction { font-size: 1rem; font-weight: 750; line-height: 1.55; margin: 0 0 14px; }
.action-plan__reason { line-height: 1.55; margin: 0 0 14px; }
.action-plan__meta { display: grid; gap: 6px; margin: 0; }
.action-plan__meta div { display: grid; gap: 2px; grid-template-columns: 68px 1fr; }
.action-plan__meta dt { font-weight: 750; }
.action-plan__meta dd { margin: 0; }
.action-plan__evidence { margin: 14px 0 0; padding-left: 20px; }
.action-plan__controls { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.action-plan__controls button { border: 1px solid currentColor; border-radius: 999px; cursor: pointer; font: inherit; font-weight: 750; min-height: 44px; padding: 8px 18px; }
.action-plan__first .action-plan__controls button { background: #fff; color: #173f2b; }
.action-plan__empty { color: #66756c; margin: 0; }
@media (max-width: 620px) {
  .action-plan { gap: 16px; }
  .action-plan__first { border-radius: 16px; padding: 20px; }
  .action-plan__controls button { flex: 1 1 120px; }
}
`;

export function buildActionPlanView(plan = {}) {
  const today = toViewItems(plan.today, "TODAY");
  const upcoming = toViewItems(plan.upcoming, "UPCOMING");
  const firstAction =
    plan.firstAction?.status === "OPEN"
      ? toViewItem(plan.firstAction, plan.firstAction.horizon)
      : null;
  return {
    firstAction: firstAction
      ? {
          ...firstAction,
          badge:
            firstAction.horizon === "TODAY"
              ? "가장 먼저 할 일"
              : "가장 먼저 확인할 일",
        }
      : null,
    sections: [
      { horizon: "TODAY", heading: "오늘 할 일", items: today },
      { horizon: "UPCOMING", heading: "당분간 주의", items: upcoming },
    ],
  };
}

export function renderActionPlanMarkup(plan = {}) {
  const view = buildActionPlanView(plan);
  const firstId = view.firstAction?.actionId ?? null;
  const first = view.firstAction
    ? `<article class="action-plan__first" aria-label="${escapeHtml(view.firstAction.badge)}">
        <p class="action-plan__eyebrow">${escapeHtml(view.firstAction.badge)}</p>
        ${renderCard(view.firstAction)}
      </article>`
    : "";
  const sections = view.sections
    .map((section) => {
      const items = section.items.filter(
        ({ actionId }) => actionId !== firstId,
      );
      const content =
        items.length > 0
          ? `<ul class="action-plan__list">${items
              .map((item) => `<li>${renderCard(item)}</li>`)
              .join("")}</ul>`
          : `<p class="action-plan__empty">${emptySectionText(
              section,
              firstId,
            )}</p>`;
      return `<section class="action-plan__section" data-horizon="${section.horizon}">
        <h2>${section.heading}</h2>
        ${content}
      </section>`;
    })
    .join("");
  return `<style>${ACTION_PLAN_STYLES}</style><section class="action-plan" aria-label="농장 행동 계획">${first}${sections}</section>`;
}

export function mountActionPlan(root, plan, { onStatusChange } = {}) {
  if (!root || typeof root.addEventListener !== "function") {
    throw new TypeError("action plan root element is required");
  }
  root.innerHTML = renderActionPlanMarkup(plan);
  const handleClick = async (event) => {
    const button = event.target?.closest?.("button[data-action-status]");
    if (!button || !root.contains(button)) return;
    if (typeof onStatusChange !== "function") return;
    button.disabled = true;
    try {
      await onStatusChange({
        actionId: button.dataset.actionId,
        status: button.dataset.actionStatus,
      });
    } finally {
      button.disabled = false;
    }
  };
  root.addEventListener("click", handleClick);
  return () => root.removeEventListener("click", handleClick);
}

function toViewItems(values, horizon) {
  if (!Array.isArray(values)) return [];
  return values.map((item) => toViewItem(item, horizon));
}

function toViewItem(item, expectedHorizon) {
  if (!item || typeof item !== "object" || item.horizon !== expectedHorizon) {
    throw new TypeError("action item horizon does not match its section");
  }
  for (const field of ["actionId", "title", "instruction", "reason", "dueAt", "recheckAt"]) {
    if (typeof item[field] !== "string" || item[field].trim() === "") {
      throw new TypeError(`action item ${field} is required`);
    }
  }
  if (!Object.hasOwn(STATUS_LABELS, item.status)) {
    throw new TypeError("action item status is unsupported");
  }
  if (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0) {
    throw new TypeError("action item EvidenceRefs are required");
  }
  return {
    actionId: item.actionId,
    title: item.title,
    instruction: item.instruction,
    reason: item.reason,
    horizon: item.horizon,
    status: item.status,
    statusLabel: STATUS_LABELS[item.status],
    dueLabel: formatKoreanTimestamp(item.dueAt),
    recheckLabel: formatKoreanTimestamp(item.recheckAt),
    evidence: [...new Set(item.evidenceRefs.map(toEvidenceLabel))],
  };
}

function toEvidenceLabel(reference) {
  if (!reference || typeof reference !== "object") {
    throw new TypeError("EvidenceRef must be an object");
  }
  const source = SOURCE_LABELS[reference.sourceKind];
  const state = EVIDENCE_STATE_LABELS[reference.state];
  if (!source || !state) {
    throw new TypeError("EvidenceRef source or state is unsupported");
  }
  const timestamp = reference.observedAt ?? reference.fetchedAt;
  return timestamp
    ? `${source} · ${formatKoreanTimestamp(timestamp)} · ${state}`
    : `${source} · ${state}`;
}

function renderCard(item) {
  const evidence = item.evidence
    .map((label) => `<li>${escapeHtml(label)}</li>`)
    .join("");
  const controls =
    item.status === "OPEN"
      ? `<div class="action-plan__controls" aria-label="행동 상태 변경">
          <button type="button" data-action-id="${escapeHtml(item.actionId)}" data-action-status="DONE">완료</button>
          <button type="button" data-action-id="${escapeHtml(item.actionId)}" data-action-status="SKIPPED">건너뜀</button>
        </div>`
      : `<p class="action-plan__status">상태: ${escapeHtml(item.statusLabel)}</p>`;
  return `<article class="action-plan__card" data-action-id="${escapeHtml(item.actionId)}">
    <h3>${escapeHtml(item.title)}</h3>
    <p class="action-plan__instruction">${escapeHtml(item.instruction)}</p>
    <p class="action-plan__reason"><strong>이유</strong> ${escapeHtml(item.reason)}</p>
    <dl class="action-plan__meta">
      <div><dt>기한</dt><dd>${escapeHtml(item.dueLabel)}</dd></div>
      <div><dt>재확인</dt><dd>${escapeHtml(item.recheckLabel)}</dd></div>
    </dl>
    <ul class="action-plan__evidence" aria-label="행동 근거">${evidence}</ul>
    ${controls}
  </article>`;
}

function emptySectionText(section, firstId) {
  const firstIsInSection = section.items.some(
    ({ actionId }) => actionId === firstId,
  );
  if (section.horizon === "TODAY") {
    return firstIsInSection
      ? "추가로 등록된 오늘 행동이 없습니다."
      : "등록된 오늘 행동이 없습니다.";
  }
  return firstIsInSection
    ? "추가로 등록된 당분간 행동이 없습니다."
    : "등록된 당분간 행동이 없습니다.";
}

function formatKoreanTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("action timestamp must be valid");
  }
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
