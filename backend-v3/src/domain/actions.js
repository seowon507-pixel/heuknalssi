import { DomainError } from "./errors.js";

const SEVERITY_PRIORITY = Object.freeze({
  WARNING: 3,
  CAUTION: 2,
  INFO: 1,
});
const DUE_PRIORITY = Object.freeze({
  NOW: 4,
  "1_TO_3_DAYS": 3,
  BEFORE_DECISION: 2,
  "4_TO_10_DAYS": 1,
});
const EVIDENCE_PRIORITY = Object.freeze({
  CONFIRMED_RANGE: 4,
  RISK_ONLY: 3,
  SINGLE_TARGET: 2,
  UNCONFIRMED: 1,
});
const FRESHNESS_PRIORITY = Object.freeze({
  CURRENT: 3,
  STALE: 2,
  SAMPLE: 1,
});

export function rankActions(actions, request = null) {
  if (!Array.isArray(actions)) {
    throw new DomainError("INVALID_ACTION_CANDIDATES", "actions must be an array");
  }
  const filtered = actions.filter((action) => {
    validateAction(action);
    if (
      action.evidenceStrength === "RISK_ONLY" &&
      ["STALE", "SAMPLE"].includes(action.sourceFreshness)
    ) {
      return false;
    }
    if (!request) return true;
    return (
      action.usageModes.includes(request.usageMode) &&
      action.cultivationModes.includes(request.cultivationMode)
    );
  });
  const groups = new Map();
  for (const action of filtered) {
    const existing = groups.get(action.actionId) ?? [];
    existing.push(structuredClone(action));
    groups.set(action.actionId, existing);
  }
  return [...groups.values()].map(mergeActionGroup).sort(compareActions);
}

export function selectPrimaryAction(request, ranked) {
  if (!Array.isArray(ranked) || ranked.length === 0) return null;
  if (request?.usageMode === "ACTIVE_GROWING") {
    const warning = ranked.find(
      (action) =>
        action.severity === "WARNING" &&
        ["NOW", "1_TO_3_DAYS"].includes(action.dueWindow) &&
        action.sourceFreshness === "CURRENT",
    );
    if (warning) {
      return toPrimary(warning, "ACTIVE_GROWING_CURRENT_WARNING");
    }
  }
  const blocking = ranked.find((action) => action.blocking);
  if (blocking) return toPrimary(blocking, "BLOCKING_INFORMATION");
  return toPrimary(ranked[0], "HIGHEST_RANKED_ACTION");
}

export function projectDisplayActions(primary, ranked, limit = 3) {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new DomainError(
      "INVALID_ACTION_LIMIT",
      "display action limit must be a non-negative integer",
    );
  }
  if (!Array.isArray(ranked) || limit === 0) return [];
  const primaryAction =
    primary === null || primary === undefined
      ? null
      : ranked.find((action) => action.actionId === primary.actionId) ?? null;
  const ordered = [
    ...(primaryAction ? [primaryAction] : []),
    ...ranked.filter((action) => action.actionId !== primaryAction?.actionId),
  ];
  return ordered.slice(0, limit);
}

export function mergeAndRankActions({ request, actions = [] } = {}) {
  const ranked = rankActions(actions, request);
  const primaryAction = selectPrimaryAction(request, ranked);
  return {
    ranked,
    primaryAction,
    displayActions: projectDisplayActions(primaryAction, ranked, 3),
  };
}

function mergeActionGroup(group) {
  const best = [...group].sort(compareActions)[0];
  return {
    ...best,
    usageModes: unique(group.flatMap((item) => item.usageModes)).sort(),
    cultivationModes: unique(
      group.flatMap((item) => item.cultivationModes),
    ).sort(),
    triggerIds: unique(group.flatMap((item) => item.triggerIds)).sort(),
    blocking: group.some((item) => item.blocking),
    severity: strongest(group, "severity", SEVERITY_PRIORITY),
    dueWindow: strongest(group, "dueWindow", DUE_PRIORITY),
    evidenceStrength: strongest(
      group,
      "evidenceStrength",
      EVIDENCE_PRIORITY,
    ),
    sourceFreshness: strongestFreshness(group),
    ruleOrder: Math.min(...group.map((item) => item.ruleOrder)),
  };
}

function strongest(group, field, priority) {
  return [...group]
    .map((item) => item[field])
    .sort(
      (left, right) =>
        priority[right] - priority[left] || left.localeCompare(right),
    )[0];
}

function strongestFreshness(group) {
  const comparable = group
    .map((item) => item.sourceFreshness)
    .filter((value) => value !== "NOT_APPLICABLE");
  if (comparable.length === 0) return "NOT_APPLICABLE";
  return comparable.sort(
    (left, right) =>
      FRESHNESS_PRIORITY[right] - FRESHNESS_PRIORITY[left] ||
      left.localeCompare(right),
  )[0];
}

function compareActions(left, right) {
  if (left.blocking !== right.blocking) return left.blocking ? -1 : 1;
  let comparison =
    SEVERITY_PRIORITY[right.severity] - SEVERITY_PRIORITY[left.severity];
  if (comparison !== 0) return comparison;
  comparison = DUE_PRIORITY[right.dueWindow] - DUE_PRIORITY[left.dueWindow];
  if (comparison !== 0) return comparison;
  comparison =
    EVIDENCE_PRIORITY[right.evidenceStrength] -
    EVIDENCE_PRIORITY[left.evidenceStrength];
  if (comparison !== 0) return comparison;
  if (
    left.sourceFreshness !== "NOT_APPLICABLE" &&
    right.sourceFreshness !== "NOT_APPLICABLE"
  ) {
    comparison =
      FRESHNESS_PRIORITY[right.sourceFreshness] -
      FRESHNESS_PRIORITY[left.sourceFreshness];
    if (comparison !== 0) return comparison;
  }
  return (
    left.ruleOrder - right.ruleOrder ||
    left.actionId.localeCompare(right.actionId)
  );
}

function validateAction(action) {
  if (action === null || typeof action !== "object" || Array.isArray(action)) {
    throw new DomainError(
      "INVALID_ACTION_CANDIDATE",
      "action candidate must be an object",
    );
  }
  if (typeof action.actionId !== "string" || action.actionId.trim() === "") {
    throw new DomainError(
      "INVALID_ACTION_CANDIDATE",
      "actionId is required",
    );
  }
  if (
    typeof action.titleTemplateId !== "string" ||
    action.titleTemplateId.trim() === ""
  ) {
    throw new DomainError(
      "INVALID_ACTION_CANDIDATE",
      "titleTemplateId is required",
    );
  }
  for (const field of ["usageModes", "cultivationModes", "triggerIds"]) {
    if (!Array.isArray(action[field])) {
      throw new DomainError(
        "INVALID_ACTION_CANDIDATE",
        `${field} must be an array`,
      );
    }
  }
  if (typeof action.blocking !== "boolean") {
    throw new DomainError(
      "INVALID_ACTION_CANDIDATE",
      "blocking must be boolean",
    );
  }
  if (!Object.hasOwn(SEVERITY_PRIORITY, action.severity)) {
    throw new DomainError(
      "INVALID_ACTION_CANDIDATE",
      "severity is unsupported",
    );
  }
  if (!Object.hasOwn(DUE_PRIORITY, action.dueWindow)) {
    throw new DomainError(
      "INVALID_ACTION_CANDIDATE",
      "dueWindow is unsupported",
    );
  }
  if (!Object.hasOwn(EVIDENCE_PRIORITY, action.evidenceStrength)) {
    throw new DomainError(
      "INVALID_ACTION_CANDIDATE",
      "evidenceStrength is unsupported",
    );
  }
  if (
    !Object.hasOwn(FRESHNESS_PRIORITY, action.sourceFreshness) &&
    action.sourceFreshness !== "NOT_APPLICABLE"
  ) {
    throw new DomainError(
      "INVALID_ACTION_CANDIDATE",
      "sourceFreshness is unsupported",
    );
  }
  if (!Number.isInteger(action.ruleOrder) || action.ruleOrder < 0) {
    throw new DomainError(
      "INVALID_ACTION_CANDIDATE",
      "ruleOrder must be a non-negative integer",
    );
  }
}

function toPrimary(action, selectionReason) {
  return {
    actionId: action.actionId,
    triggerIds: [...action.triggerIds],
    selectionReason,
  };
}

function unique(values) {
  return [...new Set(values)];
}
