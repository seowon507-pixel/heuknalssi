const DEFAULT_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1_000;
const MAX_CAS_ATTEMPTS = 8;

function requiredIdentifier(value, field) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > 180
  ) {
    throw new TypeError(`${field} must be a non-empty identifier`);
  }
  return value.trim();
}

function assertStore(store) {
  for (const method of ["get", "setIfAbsent", "compareAndSet"]) {
    if (typeof store?.[method] !== "function") {
      throw new TypeError(`photo season store.${method} is required`);
    }
  }
}

function documentKey(ownerSessionId, farmId) {
  return JSON.stringify([
    "photo-season-v1",
    requiredIdentifier(ownerSessionId, "ownerSessionId"),
    requiredIdentifier(farmId, "farmId"),
  ]);
}

function seasonKey(cropId, seasonId) {
  return JSON.stringify([
    requiredIdentifier(cropId, "cropId"),
    requiredIdentifier(seasonId, "seasonId"),
  ]);
}

function emptyDocument() {
  return { seasons: {} };
}

function assertDocument(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !value.seasons ||
    typeof value.seasons !== "object" ||
    Array.isArray(value.seasons)
  ) {
    throw new Error("photo season store returned an invalid document");
  }
  return structuredClone(value);
}

function emptySeason({ farmId, cropId, seasonId, startedAt }) {
  return {
    farmId,
    cropId,
    seasonId,
    startedAt,
    endedAt: null,
    status: "ACTIVE",
    summary: null,
    photos: [],
    comparisons: [],
  };
}

function ownedScope(input = {}) {
  return {
    ownerSessionId: requiredIdentifier(
      input.ownerSessionId,
      "ownerSessionId",
    ),
    farmId: requiredIdentifier(input.farmId, "farmId"),
    cropId: requiredIdentifier(input.cropId, "cropId"),
    seasonId: requiredIdentifier(input.seasonId, "seasonId"),
  };
}

function findPhotoInDocument(document, photoId) {
  for (const season of Object.values(document.seasons)) {
    const photo = season.photos.find((item) => item.photoId === photoId);
    if (photo) return photo;
  }
  return null;
}

export function createPhotoSeasonRepository({
  store,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  assertStore(store);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError("photo season ttlMs must be a positive integer");
  }

  async function load(key) {
    const value = await Promise.resolve(store.get(key));
    return value === undefined ? undefined : assertDocument(value);
  }

  async function mutate(ownerSessionId, farmId, operation) {
    const key = documentKey(ownerSessionId, farmId);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await load(key);
      if (current === undefined) {
        const created = await Promise.resolve(
          store.setIfAbsent(key, emptyDocument(), ttlMs),
        );
        if (!created) continue;
      }
      const baseline = (await load(key)) ?? emptyDocument();
      const outcome = operation(structuredClone(baseline));
      if (outcome.write === false) return outcome.value;
      const changed = await Promise.resolve(
        store.compareAndSet(key, baseline, outcome.document, ttlMs),
      );
      if (changed) return outcome.value;
    }
    const error = new Error("photo season update conflicted repeatedly");
    error.code = "PHOTO_SEASON_REPOSITORY_CONFLICT";
    throw error;
  }

  const photoRepository = Object.freeze({
    async insertPhoto(photo, { ownerSessionId } = {}) {
      const scope = ownedScope({ ownerSessionId, ...photo });
      return mutate(scope.ownerSessionId, scope.farmId, (document) => {
        if (findPhotoInDocument(document, photo.photoId)) {
          const error = new Error("photo already exists");
          error.code = "PHOTO_ALREADY_EXISTS";
          throw error;
        }
        const key = seasonKey(scope.cropId, scope.seasonId);
        const season =
          document.seasons[key] ??
          emptySeason({
            farmId: scope.farmId,
            cropId: scope.cropId,
            seasonId: scope.seasonId,
            startedAt: photo.observedAt,
          });
        if (season.status !== "ACTIVE") {
          const error = new Error("completed season cannot receive a photo");
          error.code = "SEASON_NOT_ACTIVE";
          throw error;
        }
        season.startedAt =
          Date.parse(photo.observedAt) < Date.parse(season.startedAt)
            ? photo.observedAt
            : season.startedAt;
        season.photos.push(structuredClone(photo));
        document.seasons[key] = season;
        return { write: true, document, value: structuredClone(photo) };
      });
    },

    async findPhoto({ ownerSessionId, farmId, photoId } = {}) {
      const key = documentKey(ownerSessionId, farmId);
      const document = (await load(key)) ?? emptyDocument();
      const photo = findPhotoInDocument(
        document,
        requiredIdentifier(photoId, "photoId"),
      );
      return photo ? structuredClone(photo) : null;
    },

    async insertComparison(comparison, { ownerSessionId } = {}) {
      const scope = ownedScope({ ownerSessionId, ...comparison.scope });
      return mutate(scope.ownerSessionId, scope.farmId, (document) => {
        const key = seasonKey(scope.cropId, scope.seasonId);
        const season = document.seasons[key];
        if (!season) {
          const error = new Error("season was not found");
          error.code = "SEASON_NOT_FOUND";
          throw error;
        }
        if (
          !findPhotoInDocument(document, comparison.baselinePhotoId) ||
          !findPhotoInDocument(document, comparison.currentPhotoId)
        ) {
          const error = new Error("comparison photos were not found");
          error.code = "PHOTO_NOT_FOUND";
          throw error;
        }
        season.comparisons.push(structuredClone(comparison));
        return {
          write: true,
          document,
          value: structuredClone(comparison),
        };
      });
    },

    async listPhotosBySeason(input = {}) {
      const scope = ownedScope(input);
      const document =
        (await load(documentKey(scope.ownerSessionId, scope.farmId))) ??
        emptyDocument();
      return structuredClone(
        document.seasons[seasonKey(scope.cropId, scope.seasonId)]?.photos ?? [],
      );
    },

    async listComparisonsBySeason(input = {}) {
      const scope = ownedScope(input);
      const document =
        (await load(documentKey(scope.ownerSessionId, scope.farmId))) ??
        emptyDocument();
      return structuredClone(
        document.seasons[seasonKey(scope.cropId, scope.seasonId)]
          ?.comparisons ?? [],
      );
    },

    async deletePhotoBundle({ ownerSessionId, farmId, photoId } = {}) {
      const normalizedPhotoId = requiredIdentifier(photoId, "photoId");
      return mutate(ownerSessionId, farmId, (document) => {
        for (const season of Object.values(document.seasons)) {
          const index = season.photos.findIndex(
            (item) => item.photoId === normalizedPhotoId,
          );
          if (index < 0) continue;
          season.photos.splice(index, 1);
          season.comparisons = season.comparisons.filter(
            (comparison) =>
              comparison.baselinePhotoId !== normalizedPhotoId &&
              comparison.currentPhotoId !== normalizedPhotoId,
          );
          return { write: true, document, value: true };
        }
        return { write: false, value: false };
      });
    },
  });

  const seasonRepository = Object.freeze({
    async findSeason(input = {}) {
      const scope = ownedScope(input);
      const document =
        (await load(documentKey(scope.ownerSessionId, scope.farmId))) ??
        emptyDocument();
      const season = document.seasons[seasonKey(scope.cropId, scope.seasonId)];
      if (!season) return null;
      const { photos: _photos, comparisons: _comparisons, summary: _summary, ...record } =
        season;
      return structuredClone(record);
    },

    async completeSeason({
      ownerSessionId,
      scope: rawScope,
      expectedStatus,
      endedAt,
      summary,
    } = {}) {
      const scope = ownedScope({ ownerSessionId, ...rawScope });
      return mutate(scope.ownerSessionId, scope.farmId, (document) => {
        const key = seasonKey(scope.cropId, scope.seasonId);
        const season = document.seasons[key];
        if (!season) {
          const error = new Error("season was not found");
          error.code = "SEASON_NOT_FOUND";
          throw error;
        }
        if (season.status !== expectedStatus) {
          const error = new Error("season status changed before completion");
          error.code = "SEASON_UPDATE_CONFLICT";
          throw error;
        }
        season.status = "COMPLETED";
        season.endedAt = endedAt;
        season.summary = structuredClone(summary);
        return {
          write: true,
          document,
          value: structuredClone(summary),
        };
      });
    },
  });

  return Object.freeze({ photoRepository, seasonRepository });
}

export const photoSeasonRepositoryDefaults = Object.freeze({
  ttlMs: DEFAULT_TTL_MS,
});
