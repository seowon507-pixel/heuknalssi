import { randomUUID } from "node:crypto";

import {
  assertActionItem,
  buildActionPlan,
  createActionItem,
  ruleActionDedupeKey,
  transitionActionStatus,
} from "../domain/action-plan.js";
import { DomainError } from "../domain/errors.js";

export const ACTION_PLAN_REPOSITORY_METHODS = Object.freeze([
  "listActions",
  "getAction",
  "insertAction",
  "updateAction",
]);

export const ACTION_PLAN_REPOSITORY_CONTRACT = Object.freeze({
  listActions:
    "async ({ accountId, farmId, cropId, seasonId }) => ActionItem[]",
  getAction:
    "async ({ accountId, farmId, actionId }) => ActionItem | null",
  insertAction:
    "async ({ accountId, farmId, action, idempotencyKey, ruleDedupeKey }) => { action, created }; atomically enforce idempotencyKey and non-null ruleDedupeKey",
  updateAction:
    "async ({ accountId, farmId, action, expectedUpdatedAt, idempotencyKey }) => ActionItem; atomically verify scope and expectedUpdatedAt",
});

export function createActionPlanService({
  repository,
  clock = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  assertRepository(repository);
  if (typeof clock !== "function" || typeof idFactory !== "function") {
    throw new DomainError(
      "ACTION_PLAN_DEPENDENCY_INVALID",
      "clock and idFactory must be functions",
    );
  }

  return Object.freeze({
    async listActions({ accountId, farmId, cropId = null, seasonId = null } = {}) {
      const scope = readScope({ accountId, farmId, cropId, seasonId });
      const actions = await repository.listActions(scope);
      if (!Array.isArray(actions)) {
        throw repositoryContractError("listActions must return an array");
      }
      const normalized = actions.map(assertActionItem);
      if (
        normalized.some(
          (action) =>
            action.farmId !== scope.farmId ||
            (scope.cropId !== null && action.cropId !== scope.cropId) ||
            (scope.seasonId !== null && action.seasonId !== scope.seasonId),
        )
      ) {
        throw repositoryContractError("listActions returned an item outside scope");
      }
      return buildActionPlan(normalized, {
        farmId: scope.farmId,
        cropId: scope.cropId,
      });
    },

    async createAction({
      accountId,
      farmId,
      draft,
      ruleId = null,
      confirmed,
      idempotencyKey,
    } = {}) {
      const scope = writeScope({
        accountId,
        farmId,
        confirmed,
        idempotencyKey,
      });
      if (draft?.farmId !== scope.farmId) {
        throw new DomainError(
          "ACTION_FARM_SCOPE_MISMATCH",
          "draft farmId must match the route farmId",
          { status: 403 },
        );
      }
      if (draft?.origin === "RULE" && !isIdentifier(ruleId)) {
        throw new DomainError(
          "ACTION_RULE_ID_REQUIRED",
          "RULE action requires ruleId",
        );
      }
      if (draft?.origin !== "RULE" && ruleId !== null) {
        throw new DomainError(
          "ACTION_RULE_ID_UNSUPPORTED",
          "only RULE action may include ruleId",
        );
      }
      const action = createActionItem(draft, {
        actionId: idFactory(),
        now: clock(),
      });
      const dedupeKey =
        draft.origin === "RULE"
          ? ruleActionDedupeKey({
              farmId: action.farmId,
              cropId: action.cropId,
              ruleId,
              dueAt: action.dueAt,
            })
          : null;
      const result = await repository.insertAction({
        accountId: scope.accountId,
        farmId: scope.farmId,
        action,
        idempotencyKey: scope.idempotencyKey,
        ruleDedupeKey: dedupeKey,
      });
      if (
        result === null ||
        typeof result !== "object" ||
        typeof result.created !== "boolean"
      ) {
        throw repositoryContractError(
          "insertAction must return { action, created }",
        );
      }
      const saved = assertActionItem(result.action);
      assertStoredScope(saved, scope);
      return { action: saved, created: result.created };
    },

    async updateActionStatus({
      accountId,
      farmId,
      actionId,
      status,
      confirmed,
      idempotencyKey,
    } = {}) {
      const scope = writeScope({
        accountId,
        farmId,
        confirmed,
        idempotencyKey,
      });
      const normalizedActionId = identifier(actionId, "actionId");
      const existingValue = await repository.getAction({
        accountId: scope.accountId,
        farmId: scope.farmId,
        actionId: normalizedActionId,
      });
      if (existingValue === null || existingValue === undefined) {
        throw new DomainError("ACTION_NOT_FOUND", "action was not found", {
          status: 404,
        });
      }
      const existing = assertActionItem(existingValue);
      assertStoredScope(existing, scope);
      const updated = transitionActionStatus(existing, status, { now: clock() });
      if (updated.status === existing.status) return updated;
      const savedValue = await repository.updateAction({
        accountId: scope.accountId,
        farmId: scope.farmId,
        action: updated,
        expectedUpdatedAt: existing.updatedAt,
        idempotencyKey: scope.idempotencyKey,
      });
      const saved = assertActionItem(savedValue);
      assertStoredScope(saved, scope);
      if (saved.status !== updated.status) {
        throw repositoryContractError("updateAction returned the wrong status");
      }
      return saved;
    },
  });
}

function assertRepository(repository) {
  if (repository === null || typeof repository !== "object") {
    throw repositoryContractError("repository is required");
  }
  const missing = ACTION_PLAN_REPOSITORY_METHODS.filter(
    (method) => typeof repository[method] !== "function",
  );
  if (missing.length > 0) {
    throw repositoryContractError(
      `repository methods are required: ${missing.join(", ")}`,
    );
  }
}

function readScope({ accountId, farmId, cropId, seasonId }) {
  return {
    accountId: identifier(accountId, "accountId"),
    farmId: identifier(farmId, "farmId"),
    cropId: nullableIdentifier(cropId, "cropId"),
    seasonId: nullableIdentifier(seasonId, "seasonId"),
  };
}

function writeScope({ accountId, farmId, confirmed, idempotencyKey }) {
  if (confirmed !== true) {
    throw new DomainError(
      "ACTION_CONFIRMATION_REQUIRED",
      "explicit user confirmation is required",
      { status: 409 },
    );
  }
  return {
    accountId: identifier(accountId, "accountId"),
    farmId: identifier(farmId, "farmId"),
    idempotencyKey: identifier(idempotencyKey, "idempotencyKey"),
  };
}

function assertStoredScope(action, scope) {
  if (action.farmId !== scope.farmId) {
    throw repositoryContractError("repository returned an action outside scope");
  }
}

function nullableIdentifier(value, field) {
  return value === null || value === undefined ? null : identifier(value, field);
}

function identifier(value, field) {
  if (!isIdentifier(value)) {
    throw new DomainError(
      "ACTION_IDENTIFIER_REQUIRED",
      `${field} must be a non-empty identifier`,
      { details: { field } },
    );
  }
  return value.trim();
}

function isIdentifier(value) {
  return typeof value === "string" && value.trim() !== "" && value.length <= 160;
}

function repositoryContractError(message) {
  return new DomainError("ACTION_REPOSITORY_CONTRACT", message, {
    status: 500,
    expose: false,
  });
}
