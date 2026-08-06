import { domainAssert } from "./errors.js";

/**
 * 출석 도메인. 명세 25번 2절의 계약을 그대로 구현한다.
 *
 * 두 가지를 반드시 지킨다.
 *
 * - 출석은 작물 점수·위험도·과거 분석에 참여하지 않는다. 이 파일은 생육
 *   지표나 예보 판정을 읽지 않으며, 어떤 값도 그쪽으로 내보내지 않는다.
 * - 같은 농장·날짜에는 한 건만 존재한다. 재시도는 `clientRequestId` 로
 *   같은 결과를 돌려주고 새 기록을 만들지 않는다.
 *
 * 물리 삭제를 하지 않는다. `DELETED` 는 화면에서 미출석처럼 보이지만
 * 이력은 남는다.
 */

export const CHECKIN_RULE_VERSION = "checkin-v2";

export const CheckinType = Object.freeze(["FIELD_VISIT", "REMOTE_CHECK"]);
export const CheckinStatus = Object.freeze(["ACTIVE", "CORRECTED", "DELETED"]);

/** 화면에 보이는 상태. 저장 상태와 분리해 둔다. */
export const CheckinDisplayState = Object.freeze(["NOT_CHECKED", "CHECKED"]);

const ALLOWED_TRANSITIONS = Object.freeze({
  ACTIVE: Object.freeze(["CORRECTED", "DELETED"]),
  CORRECTED: Object.freeze(["CORRECTED", "DELETED"]),
  DELETED: Object.freeze([]),
});

const MAX_NOTE_LENGTH = 300;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const TYPE_LABEL_KO = Object.freeze({
  FIELD_VISIT: "현장 확인",
  REMOTE_CHECK: "원격 확인",
});

/**
 * 출석 한 건을 만든다. 저장은 호출자가 한다.
 *
 * 미래 날짜는 만들지 않는다. 과거 날짜도 만들지 않는다. 명세대로 과거
 * 날짜는 일기만 허용하고 출석은 오늘만 남긴다.
 */
export function createCheckin(input = {}) {
  const {
    userId,
    farmId,
    localDate,
    today,
    checkinType,
    note = null,
    clientRequestId,
    checkedAt,
  } = input;

  requireText(userId, "userId");
  requireText(farmId, "farmId");
  requireText(clientRequestId, "clientRequestId");
  requireDate(localDate, "localDate");
  requireDate(today, "today");
  domainAssert(
    CheckinType.includes(checkinType),
    "CHECKIN_TYPE_INVALID",
    "checkinType must be FIELD_VISIT or REMOTE_CHECK",
    { checkinType },
  );
  domainAssert(
    localDate <= today,
    "CHECKIN_FUTURE_DATE",
    "a check-in cannot be recorded for a future date",
    { localDate, today },
  );
  domainAssert(
    localDate === today,
    "CHECKIN_PAST_DATE",
    "only today can be checked in; earlier days accept a diary entry instead",
    { localDate, today },
  );

  return Object.freeze({
    userId,
    farmId,
    localDate,
    checkinType,
    status: "ACTIVE",
    note: normalizeNote(note),
    clientRequestId,
    checkedAt: requireTimestamp(checkedAt, "checkedAt"),
    createdAt: requireTimestamp(checkedAt, "checkedAt"),
    updatedAt: requireTimestamp(checkedAt, "checkedAt"),
    ruleVersion: CHECKIN_RULE_VERSION,
  });
}

/**
 * 유형이나 메모를 고친다. 고친 기록은 `CORRECTED` 가 되며 원래
 * `checkedAt` 은 보존한다. 언제 확인했는지가 사실이기 때문이다.
 */
export function correctCheckin(current, patch = {}, { now } = {}) {
  const record = assertCheckin(current);
  assertTransition(record.status, "CORRECTED");

  const checkinType = patch.checkinType ?? record.checkinType;
  domainAssert(
    CheckinType.includes(checkinType),
    "CHECKIN_TYPE_INVALID",
    "checkinType must be FIELD_VISIT or REMOTE_CHECK",
    { checkinType },
  );

  return Object.freeze({
    ...record,
    checkinType,
    note: patch.note === undefined ? record.note : normalizeNote(patch.note),
    status: "CORRECTED",
    updatedAt: requireTimestamp(now, "now"),
  });
}

/** 취소. 기록은 남고 화면에서만 미출석으로 보인다. */
export function deleteCheckin(current, { now } = {}) {
  const record = assertCheckin(current);
  assertTransition(record.status, "DELETED");
  return Object.freeze({
    ...record,
    status: "DELETED",
    updatedAt: requireTimestamp(now, "now"),
  });
}

export function assertCheckin(value) {
  domainAssert(
    value !== null && typeof value === "object",
    "CHECKIN_RECORD_INVALID",
    "a check-in record is required",
    {},
  );
  requireText(value.userId, "userId");
  requireText(value.farmId, "farmId");
  requireDate(value.localDate, "localDate");
  domainAssert(
    CheckinType.includes(value.checkinType),
    "CHECKIN_TYPE_INVALID",
    "checkinType must be FIELD_VISIT or REMOTE_CHECK",
    { checkinType: value.checkinType },
  );
  domainAssert(
    CheckinStatus.includes(value.status),
    "CHECKIN_STATUS_INVALID",
    "status must be ACTIVE, CORRECTED or DELETED",
    { status: value.status },
  );
  return value;
}

/** 같은 농장·날짜에 한 건만 남기는 키. 저장소가 유일성 제약에 쓴다. */
export function checkinUniqueKey({ userId, farmId, localDate } = {}) {
  requireText(userId, "userId");
  requireText(farmId, "farmId");
  requireDate(localDate, "localDate");
  return `${userId}|${farmId}|${localDate}`;
}

/**
 * 오늘 화면에 필요한 요약. 연속 기록은 농장별로만 센다. 한 농장의 출석을
 * 다른 농장으로 옮기지 않는다.
 */
export function summarizeCheckins(input = {}) {
  const { farmId, today, records = [] } = input;
  requireText(farmId, "farmId");
  requireDate(today, "today");

  const visible = records
    .filter(
      (row) =>
        row?.farmId === farmId &&
        row?.status !== "DELETED" &&
        isDate(row?.localDate) &&
        row.localDate <= today,
    )
    .sort((left, right) => left.localDate.localeCompare(right.localDate));

  const byDate = new Map(visible.map((row) => [row.localDate, row]));
  const todayRecord = byDate.get(today) ?? null;
  const month = today.slice(0, 7);

  return Object.freeze({
    farmId,
    today,
    displayState: todayRecord === null ? "NOT_CHECKED" : "CHECKED",
    todayCheckin: todayRecord === null ? null : toPublicCheckin(todayRecord),
    monthlyCheckedDays: visible.filter((row) => row.localDate.startsWith(month)).length,
    streakDays: countStreak(byDate, today),
    recentDays: Object.freeze(
      lastDates(today, 7).map((date) =>
        Object.freeze({
          localDate: date,
          checked: byDate.has(date),
          checkinType: byDate.get(date)?.checkinType ?? null,
          isToday: date === today,
        }),
      ),
    ),
  });
}

/**
 * 계정 홈의 `오늘 확인한 농장 수 / 활성 농장 수`.
 */
export function summarizeFarmCoverage(input = {}) {
  const { today, activeFarmIds = [], records = [] } = input;
  requireDate(today, "today");
  const checkedToday = new Set(
    records
      .filter((row) => row?.localDate === today && row?.status !== "DELETED")
      .map((row) => row.farmId),
  );
  const active = [...new Set(activeFarmIds)];
  return Object.freeze({
    today,
    activeFarms: active.length,
    checkedFarms: active.filter((farmId) => checkedToday.has(farmId)).length,
  });
}

export function toPublicCheckin(record) {
  const value = assertCheckin(record);
  return Object.freeze({
    farmId: value.farmId,
    localDate: value.localDate,
    checkinType: value.checkinType,
    checkinTypeLabelKo: TYPE_LABEL_KO[value.checkinType],
    status: value.status,
    note: value.note ?? null,
    checkedAt: value.checkedAt,
    // 원격 확인이 현장 방문처럼 보이지 않게, 화면 문구를 서버가 정한다.
    visitedInPerson: value.checkinType === "FIELD_VISIT",
  });
}

function countStreak(byDate, today) {
  let streak = 0;
  let cursor = today;
  while (byDate.has(cursor)) {
    streak += 1;
    cursor = shiftDate(cursor, -1);
  }
  return streak;
}

function lastDates(today, count) {
  return Array.from({ length: count }, (_, index) =>
    shiftDate(today, index - (count - 1)),
  );
}

function shiftDate(localDate, amount) {
  const [year, month, day] = localDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) + amount * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function assertTransition(from, to) {
  domainAssert(
    (ALLOWED_TRANSITIONS[from] ?? []).includes(to),
    "CHECKIN_TRANSITION_INVALID",
    `a ${from} check-in cannot become ${to}`,
    { from, to },
  );
}

function normalizeNote(note) {
  if (note === null || note === undefined) return null;
  domainAssert(typeof note === "string", "CHECKIN_NOTE_INVALID", "note must be text", {});
  const trimmed = note.trim();
  if (trimmed.length === 0) return null;
  domainAssert(
    trimmed.length <= MAX_NOTE_LENGTH,
    "CHECKIN_NOTE_TOO_LONG",
    `note must be at most ${MAX_NOTE_LENGTH} characters`,
    { length: trimmed.length },
  );
  return trimmed;
}

function requireText(value, field) {
  domainAssert(
    typeof value === "string" && value.trim().length > 0,
    "CHECKIN_FIELD_REQUIRED",
    `${field} is required`,
    { field },
  );
}

function requireDate(value, field) {
  domainAssert(
    isDate(value),
    "CHECKIN_DATE_INVALID",
    `${field} must be a YYYY-MM-DD calendar date`,
    { field, value },
  );
}

function requireTimestamp(value, field) {
  domainAssert(
    typeof value === "string" && Number.isFinite(Date.parse(value)),
    "CHECKIN_TIMESTAMP_INVALID",
    `${field} must be an ISO timestamp`,
    { field },
  );
  return value;
}

function isDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  return new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
}

export { MAX_NOTE_LENGTH };
