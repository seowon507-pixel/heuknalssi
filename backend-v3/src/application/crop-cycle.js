import { domainAssert } from "../domain/errors.js";
import {
  createCropCycleRecord,
  projectCropCycle,
  updateCropCycleRecord,
} from "../domain/crop-cycle.js";

export const CROP_CYCLE_REPOSITORY_CONTRACT = Object.freeze([
  "insertCycle",
  "findCycle",
  "replaceCycle",
]);

export function createCropCycleService({
  repository,
  clock = { now: () => new Date() },
} = {}) {
  for (const method of CROP_CYCLE_REPOSITORY_CONTRACT) {
    domainAssert(
      typeof repository?.[method] === "function",
      "CROP_CYCLE_PORT_INVALID",
      `repository.${method} must be a function.`,
    );
  }
  domainAssert(
    typeof clock?.now === "function",
    "CROP_CYCLE_PORT_INVALID",
    "clock.now must be a function.",
  );

  return Object.freeze({ getCycle, putCycle });

  async function getCycle(input = {}) {
    const scope = scopeFrom(input);
    const stored = await repository.findCycle({
      ownerSessionId: ownerFrom(input),
      ...scope,
    });
    return stored ? projectCropCycle(stored, { asOfDate: now(clock).date }) : null;
  }

  async function putCycle(input = {}) {
    const scope = scopeFrom(input);
    const ownerSessionId = ownerFrom(input);
    const timestamp = now(clock);

    domainAssert(
      input.status === "PLANNING" ||
        (typeof input.anchorDate === "string" && input.anchorDate <= timestamp.date),
      "CROP_CYCLE_ACTIVE_DATE_INVALID",
      "An active crop cycle anchor date cannot be in the future.",
    );

    domainAssert(
      input.status !== "COMPLETED" || input.userConfirmed === true,
      "CROP_CYCLE_COMPLETE_CONFIRMATION_REQUIRED",
      "Completing a crop cycle requires explicit confirmation.",
    );

    const existing = await repository.findCycle({
      ownerSessionId,
      ...scope,
    });

    if (!existing) {
      domainAssert(
        input.status !== "COMPLETED",
        "CROP_CYCLE_NOT_FOUND",
        "The crop cycle was not found.",
      );
      const created = createCropCycleRecord({
        ...scope,
        anchorType: input.anchorType,
        anchorDate: input.anchorDate,
        status: input.status,
        userConfirmed: input.userConfirmed,
        completedOn: null,
        createdAt: timestamp.instant,
        updatedAt: timestamp.instant,
        revision: 1,
      });
      const inserted = await repository.insertCycle(created, {
        ownerSessionId,
      });
      domainAssert(
        inserted,
        "CROP_CYCLE_UPDATE_CONFLICT",
        "The crop cycle changed while it was being created.",
      );
      return projectCropCycle(created, { asOfDate: timestamp.date });
    }

    if (existing.status === "COMPLETED") {
      const sameCompletedCycle =
        input.status === "COMPLETED" &&
        input.userConfirmed === true &&
        input.anchorType === existing.anchorType &&
        input.anchorDate === existing.anchorDate;
      domainAssert(
        sameCompletedCycle,
        "CROP_CYCLE_COMPLETED",
        "A completed crop cycle cannot be changed.",
      );
      return projectCropCycle(existing, { asOfDate: timestamp.date });
    }

    if (
      input.status === existing.status &&
      input.userConfirmed === existing.userConfirmed &&
      input.anchorType === existing.anchorType &&
      input.anchorDate === existing.anchorDate
    ) {
      return projectCropCycle(existing, { asOfDate: timestamp.date });
    }

    const updated = updateCropCycleRecord(existing, {
      anchorType: input.anchorType,
      anchorDate: input.anchorDate,
      status: input.status,
      userConfirmed: input.userConfirmed,
      completedOn: input.status === "COMPLETED" ? timestamp.date : null,
      updatedAt: timestamp.instant,
    });
    const replaced = await repository.replaceCycle(updated, {
      ownerSessionId,
      expectedRevision: existing.revision,
    });
    domainAssert(
      replaced,
      "CROP_CYCLE_UPDATE_CONFLICT",
      "The crop cycle changed before this update was applied.",
    );
    return projectCropCycle(updated, { asOfDate: timestamp.date });
  }
}

function scopeFrom(input) {
  return {
    farmId: requiredIdentifier(input.farmId, "farmId"),
    cropId: requiredIdentifier(input.cropId, "cropId"),
    seasonId: requiredIdentifier(input.seasonId, "seasonId"),
  };
}

function ownerFrom(input) {
  return requiredIdentifier(input.ownerSessionId, "ownerSessionId");
}

function requiredIdentifier(value, field) {
  domainAssert(
    typeof value === "string" &&
      value.trim() === value &&
      value.length > 0 &&
      value.length <= 180,
    "CROP_CYCLE_SCOPE_INVALID",
    `${field} must be a non-empty identifier.`,
  );
  return value;
}

function now(clock) {
  const value = clock.now();
  domainAssert(
    value instanceof Date && Number.isFinite(value.getTime()),
    "CROP_CYCLE_PORT_INVALID",
    "clock.now must return a valid Date.",
  );
  return {
    instant: value.toISOString(),
    date: seoulDate(value),
  };
}

function seoulDate(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
