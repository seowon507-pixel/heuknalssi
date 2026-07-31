/**
 * 할 일 완료 기록.
 *
 * 무엇을 언제 끝냈는지만 남긴다. 이 기록은 나중에 시즌 정리와 영농일지의
 * 재료가 되므로, 그때 가서 되짚을 수 있도록 근거를 함께 적어 둔다.
 *
 * 기록하지 않는 것
 * - 사용자가 실제로 그 일을 했는지는 확인할 수 없다. "눌렀다"는 사실만 남긴다.
 * - 완료했다고 위험이 사라졌다고 쓰지 않는다. 위험 판정은 자료가 한다.
 *
 * 같은 날 같은 항목을 여러 번 눌러도 한 번으로 친다. 하루 단위 작업이라
 * 중복을 그대로 쌓으면 나중 집계가 부풀려진다.
 */

import { DomainError } from "../domain/errors.js";

const MAX_ENTRIES = 400;
const ACTION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function assert(condition, code, message) {
  if (!condition) throw new DomainError(code, message);
}

export function normalizeCompletionInput(raw) {
  assert(
    raw !== null && typeof raw === "object" && !Array.isArray(raw),
    "INVALID_INPUT",
    "completion must be an object",
  );
  const allowed = new Set(["actionId", "analysisId", "done", "note"]);
  assert(
    Object.keys(raw).every((key) => allowed.has(key)),
    "INVALID_INPUT",
    "completion contains unsupported fields",
  );
  const actionId = typeof raw.actionId === "string" ? raw.actionId.trim() : "";
  assert(
    ACTION_ID_PATTERN.test(actionId),
    "INVALID_INPUT",
    "actionId must be a short identifier",
  );
  const analysisId =
    typeof raw.analysisId === "string" && raw.analysisId.trim() !== ""
      ? raw.analysisId.trim().slice(0, 64)
      : null;
  assert(
    typeof raw.done === "boolean",
    "INVALID_INPUT",
    "done must be a boolean",
  );
  const note =
    typeof raw.note === "string" && raw.note.trim() !== ""
      ? raw.note.trim().normalize("NFKC").replace(/\s+/gu, " ").slice(0, 200)
      : null;
  return { actionId, analysisId, done: raw.done, note };
}

function dayKey(instant) {
  // 농작업은 하루 단위다. 기록도 KST 날짜로 묶는다.
  const kst = new Date(instant + 9 * 3_600_000);
  return kst.toISOString().slice(0, 10);
}

/**
 * 완료 목록에 한 건을 반영한다. 원본을 바꾸지 않고 새 목록을 돌려준다.
 * done이 false면 같은 날 같은 항목의 기록을 지운다(체크 해제).
 */
export function applyCompletion(entries, input, { now, context = {} } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const completedOn = dayKey(now);
  const withoutSame = list.filter(
    (entry) =>
      !(entry.actionId === input.actionId && entry.completedOn === completedOn),
  );
  if (!input.done) return withoutSame.slice(-MAX_ENTRIES);

  const entry = {
    actionId: input.actionId,
    completedOn,
    completedAt: new Date(now).toISOString(),
    analysisId: input.analysisId,
    note: input.note,
    // 나중에 시즌 정리에서 "무엇을 보고 한 일인지" 되짚을 수 있어야 한다.
    context: {
      crop: context.crop ?? null,
      regionLabel: context.regionLabel ?? null,
      title: context.title ?? null,
      severity: context.severity ?? null,
      dueWindow: context.dueWindow ?? null,
    },
  };
  return [...withoutSame, entry]
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt))
    .slice(-MAX_ENTRIES);
}

/** 화면과 시즌 정리가 함께 쓰는 요약. 없는 값을 0으로 채우지 않는다. */
export function summarizeCompletions(entries, { now } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) {
    return {
      totalCount: 0,
      todayCount: 0,
      activeDayCount: 0,
      firstCompletedOn: null,
      lastCompletedOn: null,
      bySeverity: {},
    };
  }
  const today = dayKey(now);
  const days = new Set(list.map((entry) => entry.completedOn));
  const bySeverity = {};
  for (const entry of list) {
    const severity = entry.context?.severity;
    if (!severity) continue;
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
  }
  const sortedDays = [...days].sort();
  return {
    totalCount: list.length,
    todayCount: list.filter((entry) => entry.completedOn === today).length,
    activeDayCount: days.size,
    firstCompletedOn: sortedDays[0],
    lastCompletedOn: sortedDays.at(-1),
    bySeverity,
  };
}

/** 저장소에서 읽은 값이 규격 밖이면 통째로 버린다. 반쯤 깨진 이력은 안 쓴다. */
export function sanitizeStoredCompletions(value) {
  if (!Array.isArray(value)) return [];
  const clean = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    if (!ACTION_ID_PATTERN.test(entry.actionId ?? "")) continue;
    if (!ISO_DATE_PATTERN.test(entry.completedOn ?? "")) continue;
    if (typeof entry.completedAt !== "string") continue;
    clean.push({
      actionId: entry.actionId,
      completedOn: entry.completedOn,
      completedAt: entry.completedAt,
      analysisId:
        typeof entry.analysisId === "string" ? entry.analysisId : null,
      note: typeof entry.note === "string" ? entry.note : null,
      context:
        entry.context && typeof entry.context === "object"
          ? {
              crop: entry.context.crop ?? null,
              regionLabel: entry.context.regionLabel ?? null,
              title: entry.context.title ?? null,
              severity: entry.context.severity ?? null,
              dueWindow: entry.context.dueWindow ?? null,
            }
          : {},
    });
  }
  return clean.slice(-MAX_ENTRIES);
}

export const taskLogDefaults = Object.freeze({
  maxEntries: MAX_ENTRIES,
});
