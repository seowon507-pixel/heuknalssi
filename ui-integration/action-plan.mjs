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
const CROP_LABELS = Object.freeze({
  apple: "사과",
  pear: "배",
  cucumber: "오이",
  potato: "감자",
  lettuce: "상추",
});

// 실제 스타일은 dashboard-workspace.css에서 관리한다. 런타임 <style> 삽입은
// 대시보드 토큰과 접근성 규칙을 우회하므로 더 이상 사용하지 않는다.
export const ACTION_PLAN_STYLES = ".action-plan__complete { min-height: 48px; }";

export function buildActionPlanView(plan = {}, { now = new Date() } = {}) {
  const today = toViewItems(plan.today, "TODAY", now);
  const upcoming = toViewItems(plan.upcoming, "UPCOMING", now);
  const firstAction =
    plan.firstAction?.status === "OPEN" &&
    plan.firstAction?.horizon === "TODAY"
      ? toViewItem(plan.firstAction, plan.firstAction.horizon, now)
      : null;
  return {
    firstAction: firstAction
      ? {
          ...firstAction,
          badge: "우선",
        }
      : null,
    sections: [
      { horizon: "TODAY", heading: "오늘 할 일", items: today },
      { horizon: "UPCOMING", heading: "당분간 주의", items: upcoming },
    ],
  };
}

export function renderActionPlanMarkup(plan = {}, options = {}) {
  const view = buildActionPlanView(plan, options);
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
        <h3 class="action-plan__section-heading">${section.heading}</h3>
        ${content}
      </section>`;
    })
    .join("");
  return `<section class="action-plan" aria-label="농장 행동 계획">${first}${sections}</section>`;
}

export function mountActionPlan(
  root,
  plan,
  { onStatusChange, onSnooze, onStatusError, now } = {},
) {
  if (!root || typeof root.addEventListener !== "function") {
    throw new TypeError("action plan root element is required");
  }
  root.innerHTML = renderActionPlanMarkup(plan, { now });
  const handleClick = async (event) => {
    const button = event.target?.closest?.(
      "button[data-action-status], button[data-action-snooze]",
    );
    if (!button || !root.contains(button)) return;
    const snooze = button.dataset.actionSnooze;
    const operation = snooze ? "SNOOZE" : "STATUS";
    if (
      (operation === "SNOOZE" && typeof onSnooze !== "function") ||
      (operation === "STATUS" && typeof onStatusChange !== "function")
    ) return;
    button.disabled = true;
    try {
      if (operation === "SNOOZE") {
        await onSnooze({
          actionId: button.dataset.actionId,
          snoozedUntil: nextSeoulMorning(now),
        });
      } else {
        await onStatusChange({
          actionId: button.dataset.actionId,
          status: button.dataset.actionStatus,
        });
      }
    } catch (error) {
      if (typeof onStatusError === "function") {
        await onStatusError({
          actionId: button.dataset.actionId,
          status: button.dataset.actionStatus,
          operation,
          error,
        });
      } else {
        throw error;
      }
    } finally {
      button.disabled = false;
    }
  };
  root.addEventListener("click", handleClick);
  return () => root.removeEventListener("click", handleClick);
}

export function nextSeoulMorning(now = new Date()) {
  const reference = new Date(now);
  if (Number.isNaN(reference.getTime())) {
    throw new TypeError("now must be a valid timestamp");
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    })
      .formatToParts(reference)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  );
  return new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + 1, -2, 0, 0, 0),
  ).toISOString();
}

export function filterWeeklyRisksForOpenAction(risks = [], plan = {}) {
  if (!Array.isArray(risks)) return [];
  const action = plan?.firstAction;
  if (!action || action.status !== "OPEN") return [...risks];
  const riskIds = new Set(
    (Array.isArray(action.evidenceRefs) ? action.evidenceRefs : [])
      .map((reference) => reference?.sourceId)
      .filter((sourceId) => typeof sourceId === "string" && sourceId.trim()),
  );
  const ruleId = typeof action.ruleId === "string" ? action.ruleId : null;
  return risks.filter(
    (risk) =>
      !riskIds.has(risk?.riskId) &&
      !(ruleId && risk?.ruleId === ruleId),
  );
}

export function compressWeeklyRisks(risks = []) {
  if (!Array.isArray(risks)) return [];
  const seen = new Set();
  return risks.filter((risk, index) => {
    const from = risk?.dateRange?.from;
    const to = risk?.dateRange?.to ?? from;
    const metric = risk?.trigger?.metric;
    const key =
      typeof from === "string" &&
      typeof to === "string" &&
      typeof metric === "string" &&
      metric.trim()
        ? `${from}\u0000${to}\u0000${metric}`
        : `unclassified\u0000${risk?.riskId ?? risk?.ruleId ?? index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function groupWeeklyRiskRanges(risks = []) {
  const sorted = compressWeeklyRisks(risks).slice().sort((left, right) =>
    String(left?.dateRange?.from ?? "").localeCompare(
      String(right?.dateRange?.from ?? ""),
    ),
  );
  const groups = [];
  const latestByKey = new Map();
  for (const risk of sorted) {
    const metric = risk?.trigger?.metric;
    const guide = risk?.guidance ?? {};
    const key = [risk?.severity, metric, guide.headline, guide.reason].join("\u0000");
    const current = latestByKey.get(key);
    if (current && rangesTouch(current.risk.dateRange, risk.dateRange)) {
      current.risk.dateRange.to = laterDate(
        current.risk.dateRange.to,
        risk.dateRange.to,
      );
      continue;
    }
    const entry = {
      key,
      risk: {
        ...risk,
        dateRange: { ...risk.dateRange },
      },
    };
    groups.push(entry);
    latestByKey.set(key, entry);
  }
  return groups.map(({ risk }) => risk);
}

function rangesTouch(left = {}, right = {}) {
  const leftTo = Date.parse(`${left.to ?? left.from}T00:00:00Z`);
  const rightFrom = Date.parse(`${right.from}T00:00:00Z`);
  return Number.isFinite(leftTo) &&
    Number.isFinite(rightFrom) &&
    rightFrom <= leftTo + 86_400_000;
}

function laterDate(left, right) {
  return String(left ?? "").localeCompare(String(right ?? "")) >= 0 ? left : right;
}

export function composeForecastActionReason(cause, reason) {
  const sourceCause = String(cause ?? "").trim().replace(/[.!?]+$/u, "");
  const sourceReason = String(reason ?? "").trim();
  if (!sourceCause) return sourceReason;
  const consequence = sourceReason
    .replace(/^.+?(?:이면|하면|경우|때)\s*/u, "")
    .trim();
  return `${sourceCause}. ${consequence || sourceReason}`;
}

export function formatActionDueLabel(
  value,
  { status = "OPEN", now = new Date() } = {},
) {
  const due = new Date(value);
  const reference = new Date(now);
  if (Number.isNaN(due.getTime()) || Number.isNaN(reference.getTime())) {
    throw new TypeError("action timestamp must be valid");
  }
  if (status === "OPEN" && due.getTime() < reference.getTime()) {
    return "지연됨 · 지금 확인";
  }
  return formatKoreanTimestamp(value);
}

export function formatActionDueLabelForAction(
  action,
  { now = new Date() } = {},
) {
  if (!action || typeof action !== "object") {
    throw new TypeError("action is required");
  }
  const reference = new Date(now);
  const refreshedAt = new Date(action.updatedAt ?? action.createdAt);
  const dueAt = new Date(action.dueAt);
  const normalizedRuleId = String(action.ruleId ?? "")
    .replaceAll(/[.-]+/g, "_")
    .toUpperCase();
  const immediateRule = [
    "CONFIRM_SEASON",
    "COLLECT_REQUIRED_DATA",
    "REQUEST_FIELD_SOIL_TEST",
  ].includes(normalizedRuleId);
  const immediateFallback =
    action.status === "OPEN" &&
    immediateRule &&
    Number.isFinite(refreshedAt.getTime()) &&
    Number.isFinite(dueAt.getTime()) &&
    dueAt.getTime() <= refreshedAt.getTime() &&
    refreshedAt.getTime() - dueAt.getTime() <= 10 * 60 * 1_000;
  if (
    immediateFallback &&
    Number.isFinite(reference.getTime()) &&
    reference.getTime() <= refreshedAt.getTime() + 4 * 60 * 60 * 1_000
  ) {
    return "지금 확인";
  }
  return formatActionDueLabel(action.dueAt, {
    status: action.status,
    now: reference,
  });
}

function toViewItems(values, horizon, now) {
  if (!Array.isArray(values)) return [];
  return values.map((item) => toViewItem(item, horizon, now));
}

function toViewItem(item, expectedHorizon, now) {
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
    reasonParts: splitReason(item.reason),
    horizon: item.horizon,
    status: item.status,
    statusLabel: STATUS_LABELS[item.status],
    dueLabel: formatActionDueLabelForAction(item, { now }),
    recheckLabel: formatKoreanTimestamp(item.recheckAt),
    targetLabel: actionTargetLabel(item.cropId),
    sourceLabel: actionSourceLabel(item.evidenceRefs),
    evidence: [...new Set(item.evidenceRefs.map(toEvidenceLabel))],
  };
}

function actionTargetLabel(cropId) {
  const normalized = String(cropId ?? "")
    .trim()
    .replace(/^crop-/u, "")
    .split("-")[0]
    .toLowerCase();
  const crop = CROP_LABELS[normalized];
  return crop ? `${crop} 농장` : "현재 농장";
}

function actionSourceLabel(references) {
  const labels = new Set(
    references
      .map((reference) => SOURCE_LABELS[reference?.sourceKind])
      .filter(Boolean),
  );
  return labels.size > 0 ? `${labels.size}종 확인` : "분석 근거";
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
          <button class="action-plan__complete" type="button" data-action-id="${escapeHtml(item.actionId)}" data-action-status="DONE"><span class="action-plan__check" aria-hidden="true"></span><span class="action-plan__complete-label">완료 표시</span></button>
        </div>`
      : `<p class="action-plan__status">상태: ${escapeHtml(item.statusLabel)}</p>`;
  const skip =
    item.status === "OPEN"
      ? `<button class="action-plan__skip" type="button" data-action-id="${escapeHtml(item.actionId)}" data-action-status="SKIPPED">이번에는 건너뛰기</button>`
      : "";
  const snooze =
    item.status === "OPEN"
      ? `<button class="action-plan__snooze" type="button" data-action-id="${escapeHtml(item.actionId)}" data-action-snooze="NEXT_MORNING">내일 다시 알림</button>`
      : "";
  const cause = item.reasonParts.cause
    ? `<p><strong>원인</strong><span>${escapeHtml(item.reasonParts.cause)}</span></p>`
    : "";
  const dueTone = item.dueLabel.startsWith("지연됨")
    ? "danger"
    : item.horizon === "TODAY"
      ? "today"
      : "upcoming";
  return `<article class="action-plan__card" data-action-id="${escapeHtml(item.actionId)}">
    <div class="action-plan__copy">
      <h3>${escapeHtml(item.title)}</h3>
      <p class="action-plan__importance"><strong>왜 중요할까요?</strong><span>${escapeHtml(item.reasonParts.risk)}</span></p>
      <dl class="action-plan__quick-meta" aria-label="작업 요약">
        <div><dt>대상</dt><dd>${escapeHtml(item.targetLabel)}</dd></div>
        <div><dt>근거</dt><dd>${escapeHtml(item.sourceLabel)}</dd></div>
        <div><dt>재확인</dt><dd>${escapeHtml(item.recheckLabel)}</dd></div>
      </dl>
    </div>
    <dl class="action-plan__meta">
      <div class="is-${dueTone}"><dt>기한</dt><dd>${escapeHtml(item.dueLabel)}</dd></div>
    </dl>
    <details class="action-plan__details">
      <summary><span>행동 상세 보기</span></summary>
      <div class="action-plan__facts">
        ${cause}
        <p><strong>위험</strong><span>${escapeHtml(item.reasonParts.risk)}</span></p>
        <p><strong>할 일</strong><span>${escapeHtml(item.instruction)}</span></p>
      </div>
      <div class="action-plan__evidence"><strong>판단 근거 ${item.evidence.length}개</strong><ul aria-label="행동 근거">${evidence}</ul></div>
      <div class="action-plan__secondary-controls">${snooze}${skip}</div>
    </details>
    ${controls}
  </article>`;
}

function splitReason(value) {
  const reason = String(value).trim();
  const match = reason.match(/^(.+?(?:이면|하면|경우|때))\s+(.+)$/u);
  if (match) return { cause: match[1], risk: match[2] };
  const sentences = reason.match(/^(.+?[.!?])\s+(.+)$/u);
  if (sentences) return { cause: sentences[1], risk: sentences[2] };
  return { cause: null, risk: reason };
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
