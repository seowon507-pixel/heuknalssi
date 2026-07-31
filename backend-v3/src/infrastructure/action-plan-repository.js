const DEFAULT_TTL_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_CAS_ATTEMPTS = 8;
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
  return { actions: [], idempotency: {}, ruleDedupe: {} };
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
      const baseline = (await loadDocument(store, key)) ?? emptyDocument();
      const outcome = operation(structuredClone(baseline));
      if (outcome.write === false) return outcome.value;
      const changed = await Promise.resolve(
        store.compareAndSet(key, baseline, outcome.document, ttlMs),
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
      const document = (await loadDocument(store, key)) ?? emptyDocument();
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
      const document = (await loadDocument(store, key)) ?? emptyDocument();
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
          const projected = existing.status === "OPEN"
            ? upsertOpenRuleAction(existing, action)
            : existing;
          document.actions[index] = projected;
          document.idempotency[idempotencyKey] = existing.actionId;
          return {
            write: true,
            document,
            value: { action: structuredClone(projected), created: false },
          };
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

export const actionPlanRepositoryDefaults = Object.freeze({
  ttlMs: DEFAULT_TTL_MS,
  maxCasAttempts: MAX_CAS_ATTEMPTS,
});
