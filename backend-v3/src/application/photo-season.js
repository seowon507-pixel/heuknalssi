import { randomUUID } from "node:crypto";

import { DomainError, domainAssert } from "../domain/errors.js";
import {
  buildSeasonSummary,
  createObservablePhotoComparison,
  createPhotoMetadata,
  toPublicPhotoRecord,
} from "../domain/photo-season.js";

export const PHOTO_SEASON_PORT_METHODS = Object.freeze({
  photoRepository: Object.freeze([
    "insertPhoto",
    "findPhoto",
    "insertComparison",
    "listPhotosBySeason",
    "listComparisonsBySeason",
    "deletePhotoBundle",
  ]),
  seasonRepository: Object.freeze(["findSeason", "completeSeason"]),
  actionRepository: Object.freeze(["listActionsBySeason"]),
  riskRepository: Object.freeze(["listRisksBySeason"]),
  objectStorage: Object.freeze(["commitUpload", "deleteObjects"]),
});

/**
 * Creates the photo/season use cases around explicit persistence ports.
 *
 * `commitUpload` exchanges an opaque, server-validated upload token for private
 * paths. `deleteObjects` must be idempotent. `deletePhotoBundle` must atomically
 * remove photo metadata and every comparison that references the photo.
 */
export function createPhotoSeasonService(options = {}) {
  validatePorts(options);
  const {
    photoRepository,
    seasonRepository,
    actionRepository,
    riskRepository,
    objectStorage,
    clock = { now: () => new Date() },
    idGenerator = () => randomUUID(),
  } = options;

  domainAssert(
    typeof clock?.now === "function" && typeof idGenerator === "function",
    "PHOTO_SEASON_PORT_INVALID",
    "clock.now and idGenerator must be functions.",
  );

  return Object.freeze({
    addPhoto,
    comparePhotos,
    deletePhoto,
    getSeasonTimeline,
    completeSeason,
  });

  async function addPhoto(input = {}) {
    const photoId = requiredGeneratedId(idGenerator("photo"), "photo");
    const createdAt = nowIso(clock);

    // Validate consent, scope, timestamps, and user metadata before committing
    // any object to private storage.
    createPhotoMetadata({
      ...input,
      photoId,
      objectPath: `pending/${photoId}`,
      thumbnailPath: null,
      evidenceRefs: [],
      createdAt,
      deletedAt: null,
    });

    const scope = scopeFrom(input);
    const stored = await objectStorage.commitUpload({
      uploadToken: requiredText(
        input.uploadToken,
        "PHOTO_UPLOAD_TOKEN_REQUIRED",
        "uploadToken",
      ),
      photoId,
      ...scope,
    });
    let metadata;
    try {
      metadata = createPhotoMetadata({
        ...input,
        photoId,
        objectPath: stored?.objectPath,
      thumbnailPath: stored?.thumbnailPath ?? null,
      evidenceRefs: [],
      createdAt,
        deletedAt: null,
      });
    } catch (cause) {
      await cleanupCommittedObjects(stored, cause);
    }

    try {
      await photoRepository.insertPhoto(metadata);
    } catch (cause) {
      await cleanupCommittedObjects(metadata, cause);
    }

    return toPublicPhotoRecord(metadata);
  }

  async function comparePhotos(input = {}) {
    const scope = scopeFrom(input);
    const baselinePhotoId = requiredText(
      input.baselinePhotoId,
      "PHOTO_ID_REQUIRED",
      "baselinePhotoId",
    );
    const currentPhotoId = requiredText(
      input.currentPhotoId,
      "PHOTO_ID_REQUIRED",
      "currentPhotoId",
    );
    const [baselinePhoto, currentPhoto] = await Promise.all([
      photoRepository.findPhoto({ farmId: scope.farmId, photoId: baselinePhotoId }),
      photoRepository.findPhoto({ farmId: scope.farmId, photoId: currentPhotoId }),
    ]);
    domainAssert(
      baselinePhoto && currentPhoto,
      "PHOTO_NOT_FOUND",
      "Both stored photos are required for comparison.",
    );

    const comparison = createObservablePhotoComparison({
      comparisonId: requiredGeneratedId(
        idGenerator("comparison"),
        "comparison",
      ),
      baselinePhoto,
      currentPhoto,
      observations: input.observations,
      createdAt: nowIso(clock),
    });
    domainAssert(
      sameScope(comparison.scope, scope),
      "PHOTO_SCOPE_MISMATCH",
      "Photos must belong to the requested farm, crop, and season.",
    );
    await photoRepository.insertComparison(comparison);
    return structuredClone(comparison);
  }

  async function deletePhoto(input = {}) {
    domainAssert(
      input.confirmed === true,
      "PHOTO_DELETE_CONFIRMATION_REQUIRED",
      "Photo deletion requires explicit user confirmation.",
    );
    const farmId = requiredText(input.farmId, "FARM_ID_REQUIRED", "farmId");
    const photoId = requiredText(input.photoId, "PHOTO_ID_REQUIRED", "photoId");
    const photo = await photoRepository.findPhoto({ farmId, photoId });
    domainAssert(photo, "PHOTO_NOT_FOUND", "The photo was not found.");
    domainAssert(
      photo.farmId === farmId,
      "PHOTO_SCOPE_MISMATCH",
      "The photo does not belong to the requested farm.",
    );

    const deletedAt = nowIso(clock);
    // Objects are deleted first to prioritize privacy. This operation is safe to
    // retry because the storage port contract requires idempotent deletion.
    await objectStorage.deleteObjects({ objectPaths: privatePaths(photo) });
    await photoRepository.deletePhotoBundle({ farmId, photoId, deletedAt });
    return { photoId, deletedAt };
  }

  async function getSeasonTimeline(input = {}) {
    const scope = scopeFrom(input);
    const events = await loadSeasonEvents(scope);
    return buildSeasonSummary({
      ...events,
      generatedAt: nowIso(clock),
    });
  }

  async function completeSeason(input = {}) {
    domainAssert(
      input.confirmed === true,
      "SEASON_COMPLETE_CONFIRMATION_REQUIRED",
      "Season completion requires explicit user confirmation.",
    );
    const scope = scopeFrom(input);
    const events = await loadSeasonEvents(scope);
    domainAssert(
      events.season.status === "ACTIVE",
      "SEASON_NOT_ACTIVE",
      "Only an active season can be completed.",
    );
    const endedAt = nowIso(clock);
    const summary = buildSeasonSummary({
      ...events,
      status: "COMPLETED",
      endedAt,
      generatedAt: endedAt,
    });
    await seasonRepository.completeSeason({
      scope,
      expectedStatus: "ACTIVE",
      endedAt,
      summary,
    });
    return structuredClone(summary);
  }

  async function loadSeasonEvents(scope) {
    const [season, actions, risks, photos, comparisons] = await Promise.all([
      seasonRepository.findSeason(scope),
      actionRepository.listActionsBySeason(scope),
      riskRepository.listRisksBySeason(scope),
      photoRepository.listPhotosBySeason(scope),
      photoRepository.listComparisonsBySeason(scope),
    ]);
    domainAssert(season, "SEASON_NOT_FOUND", "The season was not found.");
    return { season, actions, risks, photos, comparisons };
  }

  async function cleanupCommittedObjects(stored, originalError) {
    const objectPaths = privatePaths(stored ?? {});
    try {
      if (objectPaths.length > 0) {
        await objectStorage.deleteObjects({ objectPaths });
      }
    } catch (cleanupError) {
      throw new DomainError(
        "PHOTO_PERSISTENCE_AND_CLEANUP_FAILED",
        "Photo metadata and storage cleanup both failed.",
        { status: 500, expose: false, cause: cleanupError },
      );
    }
    throw originalError;
  }
}

function validatePorts(options) {
  for (const [portName, methods] of Object.entries(PHOTO_SEASON_PORT_METHODS)) {
    for (const method of methods) {
      domainAssert(
        typeof options[portName]?.[method] === "function",
        "PHOTO_SEASON_PORT_INVALID",
        `${portName}.${method} must be a function.`,
      );
    }
  }
}

function scopeFrom(input) {
  return {
    farmId: requiredText(input.farmId, "FARM_ID_REQUIRED", "farmId"),
    cropId: requiredText(input.cropId, "CROP_ID_REQUIRED", "cropId"),
    seasonId: requiredText(input.seasonId, "SEASON_ID_REQUIRED", "seasonId"),
  };
}

function privatePaths(photo) {
  return [photo.objectPath, photo.thumbnailPath].filter(
    (path) => typeof path === "string" && path.length > 0,
  );
}

function nowIso(clock) {
  const value = clock.now();
  const date = value instanceof Date ? value : new Date(value);
  domainAssert(
    Number.isFinite(date.getTime()),
    "PHOTO_SEASON_CLOCK_INVALID",
    "clock.now must return a valid date.",
  );
  return date.toISOString();
}

function requiredGeneratedId(value, kind) {
  return requiredText(
    value,
    "PHOTO_SEASON_ID_GENERATOR_INVALID",
    `${kind}Id`,
  );
}

function requiredText(value, code, field) {
  domainAssert(
    typeof value === "string" && value.trim().length > 0,
    code,
    `${field} must be a non-empty string.`,
  );
  return value.trim();
}

function sameScope(left, right) {
  return (
    left.farmId === right.farmId &&
    left.cropId === right.cropId &&
    left.seasonId === right.seasonId
  );
}
