const DEFAULT_TTL_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_CAS_ATTEMPTS = 8;
const LEGACY_RULE_KEY_PREFIX = "action-rule:v1:";
const CURRENT_RULE_KEY_PREFIX = "action-rule:v2:";
const RULE_UPSERT_FIELDS = Object.freeze([
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

function requireIdentifier(value, field) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 160) {
    throw new TypeError(`${field} must be a non-empty identifier`);
  }
  return value.trim();
}

function documentKey(accountId, farmId) {
  return JSON.stringify([
    "action-plan-v1",
    requireIdentifier(accountId, "accountId"),
    requireIdentifier(farmId, "farmId"),
  ]);
}

function emptyDocument() {
  return { actions: [], idempotency: {}, ruleDedupe: {}, reconciliations: {} };
}

function assertStore(store) {
  for (const method of ["get", "set", "setIfAbsent", "compareAndSet"]) {
    if (typeof store?.[method] !== "function") {
      throw new TypeError(`action plan store.${method} is required`);
    }
  }
}

async function loadDocument(store, key) {
  const value = await Promise.resolve(store.get(key));
  if (value === undefined) return undefined;
  if (
    !value ||
    !Array.isArray(value.actions) ||
    !value.idempotency ||
    !value.ruleDedupe
  ) {
    throw new Error("action plan store returned an invalid document");
  }
  return structuredClone(value);
}

function normalizeDocument(value) {
  const document = structuredClone({
    ...value,
    reconciliations: value.reconciliations ?? {},
  });
  const legacyRuleIds = legacyRuleIdsByAction(document.ruleDedupe);
  document.actions = document.actions.map((action) => {
    if (action.origin === "RULE" && !isIdentifier(action.ruleId)) {
      const ruleId = legacyRuleIds.get(action.actionId);
      if (!ruleId) {
        const error = new Error("legacy action plan rule index is inconsistent");
        error.code = "ACTION_LEGACY_RULE_INDEX_MISSING";
        throw error;
      }
      return { ...action, ruleId };
    }
    if (action.origin !== "RULE" && action.ruleId === undefined) {
      return { ...action, ruleId: null };
    }
    return action;
  });
  const candidates = new Map();
  for (const action of document.actions) {
    if (action.origin !== "RULE" || !isIdentifier(action.ruleId)) continue;
    const key = currentRuleDedupeKey(action);
    const current = candidates.get(key);
    if (!current || preferRuleIndex(action, current)) candidates.set(key, action);
  }
  for (const [key, action] of candidates) {
    if (document.ruleDedupe[key] === undefined) {
      document.ruleDedupe[key] = action.actionId;
    }
  }
  return document;
}

export function createActionPlanRepository({
  store,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  assertStore(store);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError("action plan ttlMs must be a positive integer");
  }

  async function mutate(key, operation) {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await loadDocument(store, key);
      if (current === undefined) {
        const initial = emptyDocument();
        const created = await Promise.resolve(
          store.setIfAbsent(key, initial, ttlMs),
        );
        if (!created) continue;
      }
      const baselineRaw = (await loadDocument(store, key)) ?? emptyDocument();
      const baseline = normalizeDocument(baselineRaw);
      const outcome = operation(structuredClone(baseline));
      if (outcome.write === false) return outcome.value;
      const changed = await Promise.resolve(
        store.compareAndSet(key, baselineRaw, outcome.document, ttlMs),
      );
      if (changed) return outcome.value;
    }
    const error = new Error("action plan update conflicted repeatedly");
    error.code = "ACTION_REPOSITORY_CONFLICT";
    throw error;
  }

  return Object.freeze({
    async listActions({ accountId, farmId, cropId = null, seasonId = null }) {
      const key = documentKey(accountId, farmId);
      const document = normalizeDocument(
        (await loadDocument(store, key)) ?? emptyDocument(),
      );
      return structuredClone(
        document.actions.filter(
          (action) =>
            action.farmId === farmId &&
            (cropId === null || action.cropId === cropId) &&
            (seasonId === null || action.seasonId === seasonId),
        ),
      );
    },

    async getAction({ accountId, farmId, actionId }) {
      const key = documentKey(accountId, farmId);
      const document = normalizeDocument(
        (await loadDocument(store, key)) ?? emptyDocument(),
      );
      const action = document.actions.find(
        (item) => item.farmId === farmId && item.actionId === actionId,
      );
      return action ? structuredClone(action) : null;
    },

    async insertAction({
      accountId,
      farmId,
      action,
      idempotencyKey,
      ruleDedupeKey,
    }) {
      const key = documentKey(accountId, farmId);
      return mutate(key, (document) => {
        const replayId = document.idempotency[idempotencyKey];
        const duplicateId =
          ruleDedupeKey === null
            ? null
            : document.ruleDedupe[ruleDedupeKey] ?? null;
        if (replayId) {
          const existing = document.actions.find(
            (item) => item.actionId === replayId,
          );
          if (!existing) throw new Error("action plan index is inconsistent");
          return {
            write: false,
            value: { action: structuredClone(existing), created: false },
          };
        }
        if (duplicateId) {
          const index = document.actions.findIndex(
            (item) => item.actionId === duplicateId,
          );
          if (index < 0) throw new Error("action plan index is inconsistent");
          const existing = document.actions[index];
          if (existing.status === "OPEN") {
            const projected = upsertOpenRuleAction(existing, action);
            document.actions[index] = projected;
            document.idempotency[idempotencyKey] = existing.actionId;
            return {
              write: true,
              document,
              value: { action: structuredClone(projected), created: false },
            };
          }
          if (
            existing.status !== "CANCELLED" &&
            sameSeoulDate(existing.dueAt, action.dueAt)
          ) {
            document.idempotency[idempotencyKey] = existing.actionId;
            return {
              write: true,
              document,
              value: { action: structuredClone(existing), created: false },
            };
          }
        }
        document.actions.push(structuredClone(action));
        document.idempotency[idempotencyKey] = action.actionId;
        if (ruleDedupeKey !== null) {
          document.ruleDedupe[ruleDedupeKey] = action.actionId;
        }
        return {
          write: true,
          document,
          value: { action: structuredClone(action), created: true },
        };
      });
    },

    async updateAction({
      accountId,
      farmId,
      action,
      expectedUpdatedAt,
      idempotencyKey,
    }) {
      const key = documentKey(accountId, farmId);
      return mutate(key, (document) => {
        const replayId = document.idempotency[idempotencyKey];
        if (replayId) {
          const existing = document.actions.find(
            (item) => item.actionId === replayId,
          );
          if (!existing) throw new Error("action plan index is inconsistent");
          return { write: false, value: structuredClone(existing) };
        }
        const index = document.actions.findIndex(
          (item) => item.actionId === action.actionId && item.farmId === farmId,
        );
        if (index < 0) {
          const error = new Error("action was not found");
          error.code = "ACTION_NOT_FOUND";
          throw error;
        }
        if (document.actions[index].updatedAt !== expectedUpdatedAt) {
          const error = new Error("action was updated by another request");
          error.code = "ACTION_UPDATE_CONFLICT";
          throw error;
        }
        document.actions[index] = structuredClone(action);
        document.idempotency[idempotencyKey] = action.actionId;
        return { write: true, document, value: structuredClone(action) };
      });
    },

    async reconcileRuleActions({
      accountId,
      farmId,
      cropId,
      seasonId,
      activeRuleIds,
      updatedAt,
      idempotencyKey,
    }) {
      const key = documentKey(accountId, farmId);
      return mutate(key, (document) => {
        const replay = document.reconciliations[idempotencyKey];
        if (replay) return { write: false, value: structuredClone(replay) };
        const active = new Set(activeRuleIds);
        const cancelled = [];
        document.actions = document.actions.map((action) => {
          if (
            action.farmId !== farmId ||
            action.cropId !== cropId ||
            action.seasonId !== seasonId ||
            action.origin !== "RULE" ||
            action.status !== "OPEN" ||
            typeof action.ruleId !== "string" ||
            active.has(action.ruleId)
          ) {
            return action;
          }
          const projected = {
            ...action,
            status: "CANCELLED",
            completedAt: null,
            updatedAt: monotonicTimestamp(action.updatedAt, updatedAt),
          };
          cancelled.push(structuredClone(projected));
          return projected;
        });
        const result = { cancelled };
        document.reconciliations[idempotencyKey] = structuredClone(result);
        return { write: true, document, value: result };
      });
    },
  });
}

function upsertOpenRuleAction(existing, incoming) {
  const changed = RULE_UPSERT_FIELDS.some(
    (field) => !sameValue(existing[field], incoming[field]),
  );
  if (!changed) return existing;
  const projected = Object.fromEntries(
    RULE_UPSERT_FIELDS.map((field) => [field, structuredClone(incoming[field])]),
  );
  return {
    ...existing,
    ...projected,
    updatedAt: monotonicTimestamp(existing.updatedAt, incoming.updatedAt),
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function monotonicTimestamp(previous, candidate) {
  const previousMs = Date.parse(previous);
  const candidateMs = Date.parse(candidate);
  return new Date(Math.max(candidateMs, previousMs + 1)).toISOString();
}

function legacyRuleIdsByAction(ruleDedupe) {
  const inferred = new Map();
  for (const [key, actionId] of Object.entries(ruleDedupe)) {
    if (!key.startsWith(LEGACY_RULE_KEY_PREFIX) || !isIdentifier(actionId)) {
      continue;
    }
    const parts = parseLengthPrefixed(key.slice(LEGACY_RULE_KEY_PREFIX.length));
    if (parts?.length !== 4 || !isIdentifier(parts[2])) continue;
    inferred.set(actionId, parts[2]);
  }
  return inferred;
}

function parseLengthPrefixed(value) {
  const parts = [];
  let offset = 0;
  while (offset < value.length) {
    const separator = value.indexOf(":", offset);
    if (separator < 0) return null;
    const lengthText = value.slice(offset, separator);
    if (!/^\d+$/u.test(lengthText)) return null;
    const length = Number(lengthText);
    const start = separator + 1;
    const end = start + length;
    if (!Number.isSafeInteger(length) || end > value.length) return null;
    parts.push(value.slice(start, end));
    offset = end;
  }
  return parts;
}

function currentRuleDedupeKey(action) {
  const parts = [action.farmId, action.cropId, action.ruleId];
  return `${CURRENT_RULE_KEY_PREFIX}${parts.map(lengthPrefix).join("")}`;
}

function preferRuleIndex(candidate, current) {
  const candidateOpen = candidate.status === "OPEN";
  const currentOpen = current.status === "OPEN";
  if (candidateOpen !== currentOpen) return candidateOpen;
  return String(candidate.updatedAt).localeCompare(String(current.updatedAt)) > 0;
}

function lengthPrefix(value) {
  return `${value.length}:${value}`;
}

function isIdentifier(value) {
  return typeof value === "string" && value.trim() !== "" && value.length <= 160;
}

function sameSeoulDate(left, right) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(left)) === formatter.format(new Date(right));
}

export const actionPlanRepositoryDefaults = Object.freeze({
  ttlMs: DEFAULT_TTL_MS,
  maxCasAttempts: MAX_CAS_ATTEMPTS,
});
