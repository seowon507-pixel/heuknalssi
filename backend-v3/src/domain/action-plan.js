import { DomainError } from "./errors.js";

const ACTION_HORIZONS = new Set(["TODAY", "UPCOMING"]);
const ACTION_STATUSES = new Set(["OPEN", "DONE", "SKIPPED"]);
const ACTION_ORIGINS = new Set(["RULE", "USER", "ASSISTANT_PROPOSAL"]);
const EVIDENCE_STATES = new Set([
  "READY",
  "PARTIAL",
  "HOLD",
  "UNAVAILABLE",
  "UNSUPPORTED",
]);
const SOURCE_KINDS = new Set([
  "USER",
  "PUBLIC_API",
  "PHOTO",
  "SATELLITE",
  "DERIVED_RULE",
]);
const DRAFT_FIELDS = new Set([
  "farmId",
  "cropId",
  "seasonId",
  "title",
  "instruction",
  "reason",
  "horizon",
  "dueAt",
  "recheckAt",
  "evidenceRefs",
  "origin",
]);
const ITEM_FIELDS = new Set([
  "actionId",
  ...DRAFT_FIELDS,
  "status",
  "completedAt",
  "createdAt",
  "updatedAt",
]);
const STATUS_PRIORITY = Object.freeze({ OPEN: 0, DONE: 1, SKIPPED: 2 });

export function createActionItem(draft, { actionId, now } = {}) {
  assertRecord(draft, "INVALID_ACTION_DRAFT", "action draft must be an object");
  rejectUnknownFields(draft, DRAFT_FIELDS);
  const timestamp = utcTimestamp(now, "now");
  const item = {
    actionId: requiredIdentifier(actionId, "actionId"),
    farmId: requiredIdentifier(draft.farmId, "farmId"),
    cropId: requiredIdentifier(draft.cropId, "cropId"),
    seasonId: requiredIdentifier(draft.seasonId, "seasonId"),
    title: requiredText(draft.title, "title", 120),
    instruction: requiredText(draft.instruction, "instruction", 500),
    reason: requiredText(draft.reason, "reason", 500),
    horizon: enumValue(draft.horizon, ACTION_HORIZONS, "horizon"),
    status: "OPEN",
    dueAt: utcTimestamp(draft.dueAt, "dueAt"),
    recheckAt: utcTimestamp(draft.recheckAt, "recheckAt"),
    evidenceRefs: validateEvidenceRefs(draft.evidenceRefs),
    origin: enumValue(draft.origin, ACTION_ORIGINS, "origin"),
    completedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (Date.parse(item.recheckAt) < Date.parse(item.dueAt)) {
    throw new DomainError(
      "ACTION_RECHECK_BEFORE_DUE",
      "recheckAt must not be before dueAt",
    );
  }
  return item;
}

export function assertActionItem(value) {
  assertRecord(value, "INVALID_ACTION_ITEM", "action item must be an object");
  rejectUnknownFields(value, ITEM_FIELDS);
  const normalized = {
    actionId: requiredIdentifier(value.actionId, "actionId"),
    farmId: requiredIdentifier(value.farmId, "farmId"),
    cropId: requiredIdentifier(value.cropId, "cropId"),
    seasonId: requiredIdentifier(value.seasonId, "seasonId"),
    title: requiredText(value.title, "title", 120),
    instruction: requiredText(value.instruction, "instruction", 500),
    reason: requiredText(value.reason, "reason", 500),
    horizon: enumValue(value.horizon, ACTION_HORIZONS, "horizon"),
    status: enumValue(value.status, ACTION_STATUSES, "status"),
    dueAt: utcTimestamp(value.dueAt, "dueAt"),
    recheckAt: utcTimestamp(value.recheckAt, "recheckAt"),
    evidenceRefs: validateEvidenceRefs(value.evidenceRefs),
    origin: enumValue(value.origin, ACTION_ORIGINS, "origin"),
    completedAt:
      value.completedAt === null
        ? null
        : utcTimestamp(value.completedAt, "completedAt"),
    createdAt: utcTimestamp(value.createdAt, "createdAt"),
    updatedAt: utcTimestamp(value.updatedAt, "updatedAt"),
  };
  if (Date.parse(normalized.recheckAt) < Date.parse(normalized.dueAt)) {
    throw new DomainError(
      "ACTION_RECHECK_BEFORE_DUE",
      "recheckAt must not be before dueAt",
    );
  }
  if (normalized.status === "DONE" && normalized.completedAt === null) {
    throw new DomainError(
      "ACTION_COMPLETED_AT_REQUIRED",
      "DONE action requires completedAt",
    );
  }
  if (normalized.status !== "DONE" && normalized.completedAt !== null) {
    throw new DomainError(
      "ACTION_COMPLETED_AT_UNSUPPORTED",
      "only DONE action may have completedAt",
    );
  }
  return normalized;
}

export function transitionActionStatus(action, status, { now } = {}) {
  const current = assertActionItem(action);
  const nextStatus = enumValue(status, ACTION_STATUSES, "status");
  if (current.status === nextStatus) return structuredClone(current);
  const timestamp = utcTimestamp(now, "now");
  return {
    ...current,
    status: nextStatus,
    completedAt: nextStatus === "DONE" ? timestamp : null,
    updatedAt: timestamp,
  };
}

export function ruleActionDedupeKey({ farmId, cropId, ruleId, dueAt } = {}) {
  const parts = [
    requiredIdentifier(farmId, "farmId"),
    requiredIdentifier(cropId, "cropId"),
    requiredIdentifier(ruleId, "ruleId"),
    utcTimestamp(dueAt, "dueAt"),
  ];
  return `action-rule:v1:${parts.map(lengthPrefix).join("")}`;
}

export function buildActionPlan(items, { farmId, cropId = null } = {}) {
  if (!Array.isArray(items)) {
    throw new DomainError("INVALID_ACTION_ITEMS", "action items must be an array");
  }
  const farmScope = requiredIdentifier(farmId, "farmId");
  const cropScope =
    cropId === null || cropId === undefined
      ? null
      : requiredIdentifier(cropId, "cropId");
  const scoped = items
    .map(assertActionItem)
    .filter(
      (item) =>
        item.farmId === farmScope &&
        (cropScope === null || item.cropId === cropScope),
    );
  const today = scoped.filter(({ horizon }) => horizon === "TODAY").sort(compare);
  const upcoming = scoped
    .filter(({ horizon }) => horizon === "UPCOMING")
    .sort(compare);
  const firstAction =
    today.find(({ status }) => status === "OPEN") ??
    upcoming.find(({ status }) => status === "OPEN") ??
    null;
  return {
    farmId: farmScope,
    cropId: cropScope,
    firstAction: firstAction ? structuredClone(firstAction) : null,
    today: structuredClone(today),
    upcoming: structuredClone(upcoming),
  };
}

function compare(left, right) {
  return (
    STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status] ||
    left.dueAt.localeCompare(right.dueAt) ||
    left.recheckAt.localeCompare(right.recheckAt) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.actionId.localeCompare(right.actionId)
  );
}

function validateEvidenceRefs(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new DomainError(
      "ACTION_EVIDENCE_REQUIRED",
      "at least one EvidenceRef is required",
    );
  }
  return values.map((value, index) => {
    assertRecord(
      value,
      "INVALID_ACTION_EVIDENCE",
      `evidenceRefs[${index}] must be an object`,
    );
    const limitationCodes = value.limitationCodes;
    if (
      !Array.isArray(limitationCodes) ||
      limitationCodes.some(
        (code) => typeof code !== "string" || code.trim() === "",
      )
    ) {
      throw new DomainError(
        "INVALID_ACTION_EVIDENCE",
        `evidenceRefs[${index}].limitationCodes must be a string array`,
      );
    }
    return {
      sourceKind: enumValue(
        value.sourceKind,
        SOURCE_KINDS,
        `evidenceRefs[${index}].sourceKind`,
      ),
      sourceId: requiredIdentifier(
        value.sourceId,
        `evidenceRefs[${index}].sourceId`,
      ),
      observedAt: nullableUtcTimestamp(
        value.observedAt,
        `evidenceRefs[${index}].observedAt`,
      ),
      fetchedAt: nullableUtcTimestamp(
        value.fetchedAt,
        `evidenceRefs[${index}].fetchedAt`,
      ),
      spatialLevel: requiredText(
        value.spatialLevel,
        `evidenceRefs[${index}].spatialLevel`,
        80,
      ),
      state: enumValue(
        value.state,
        EVIDENCE_STATES,
        `evidenceRefs[${index}].state`,
      ),
      limitationCodes: [...new Set(limitationCodes.map((code) => code.trim()))],
    };
  });
}

function rejectUnknownFields(value, allowed) {
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw new DomainError(
      "ACTION_FIELD_UNSUPPORTED",
      `unsupported action fields: ${unknown.sort().join(", ")}`,
      { details: { fields: unknown.sort() } },
    );
  }
}

function requiredIdentifier(value, field) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 160) {
    throw new DomainError(
      "ACTION_IDENTIFIER_REQUIRED",
      `${field} must be a non-empty identifier`,
      { details: { field } },
    );
  }
  return value.trim();
}

function requiredText(value, field, maxLength) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("ACTION_TEXT_REQUIRED", `${field} is required`, {
      details: { field },
    });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new DomainError("ACTION_TEXT_TOO_LONG", `${field} is too long`, {
      details: { field, maxLength },
    });
  }
  return normalized;
}

function enumValue(value, allowed, field) {
  if (!allowed.has(value)) {
    throw new DomainError("ACTION_ENUM_UNSUPPORTED", `${field} is unsupported`, {
      details: { field },
    });
  }
  return value;
}

function nullableUtcTimestamp(value, field) {
  return value === null ? null : utcTimestamp(value, field);
}

function utcTimestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (
    (!(value instanceof Date) &&
      (typeof value !== "string" || !value.endsWith("Z"))) ||
    Number.isNaN(date.getTime())
  ) {
    throw new DomainError(
      "ACTION_TIMESTAMP_INVALID",
      `${field} must be an ISO 8601 UTC timestamp`,
      { details: { field } },
    );
  }
  return date.toISOString();
}

function assertRecord(value, code, message) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(code, message);
  }
}

function lengthPrefix(value) {
  return `${value.length}:${value}`;
}
