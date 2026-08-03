import assert from "node:assert/strict";
import test from "node:test";

import {
  TtlMemoryStore,
  createPhotoSeasonRepository,
} from "../src/infrastructure/index.js";

const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const SCOPE = Object.freeze({
  farmId: "farm-1",
  cropId: "APPLE",
  seasonId: "season-2026",
});

function photo(photoId, observedAt) {
  return {
    photoId,
    ...SCOPE,
    objectPath: `private/${photoId}.jpg`,
    thumbnailPath: null,
    observedAt,
    growthStage: null,
    note: null,
    consentState: "GRANTED",
    evidenceRefs: [],
    createdAt: observedAt,
    deletedAt: null,
  };
}

function repository() {
  return createPhotoSeasonRepository({
    store: new TtlMemoryStore({ capacityPolicy: "reject" }),
  });
}

test("photo repository persists one scoped season and isolates account owners", async () => {
  const { photoRepository, seasonRepository } = repository();
  await photoRepository.insertPhoto(
    photo("photo-1", "2026-05-01T00:00:00.000Z"),
    { ownerSessionId: OWNER_A },
  );

  const owned = await photoRepository.listPhotosBySeason({
    ownerSessionId: OWNER_A,
    ...SCOPE,
  });
  const otherOwner = await photoRepository.listPhotosBySeason({
    ownerSessionId: OWNER_B,
    ...SCOPE,
  });
  assert.equal(owned.length, 1);
  assert.deepEqual(otherOwner, []);
  assert.deepEqual(
    await seasonRepository.findSeason({ ownerSessionId: OWNER_A, ...SCOPE }),
    {
      ...SCOPE,
      startedAt: "2026-05-01T00:00:00.000Z",
      endedAt: null,
      status: "ACTIVE",
    },
  );
});

test("photo bundle deletion atomically removes comparisons that reference it", async () => {
  const { photoRepository } = repository();
  const first = photo("photo-1", "2026-05-01T00:00:00.000Z");
  const second = photo("photo-2", "2026-05-08T00:00:00.000Z");
  await photoRepository.insertPhoto(first, { ownerSessionId: OWNER_A });
  await photoRepository.insertPhoto(second, { ownerSessionId: OWNER_A });
  await photoRepository.insertComparison(
    {
      comparisonId: "comparison-1",
      scope: SCOPE,
      baselinePhotoId: first.photoId,
      currentPhotoId: second.photoId,
      baselineObservedAt: first.observedAt,
      currentObservedAt: second.observedAt,
      observableChanges: [],
      evidenceRefs: [],
      createdAt: second.observedAt,
    },
    { ownerSessionId: OWNER_A },
  );

  assert.equal(
    await photoRepository.deletePhotoBundle({
      ownerSessionId: OWNER_A,
      farmId: SCOPE.farmId,
      photoId: first.photoId,
    }),
    true,
  );
  assert.equal(
    (await photoRepository.listPhotosBySeason({
      ownerSessionId: OWNER_A,
      ...SCOPE,
    })).length,
    1,
  );
  assert.deepEqual(
    await photoRepository.listComparisonsBySeason({
      ownerSessionId: OWNER_A,
      ...SCOPE,
    }),
    [],
  );
});

test("season completion uses an expected-status compare and blocks later photos", async () => {
  const { photoRepository, seasonRepository } = repository();
  await photoRepository.insertPhoto(
    photo("photo-1", "2026-05-01T00:00:00.000Z"),
    { ownerSessionId: OWNER_A },
  );
  await seasonRepository.completeSeason({
    ownerSessionId: OWNER_A,
    scope: SCOPE,
    expectedStatus: "ACTIVE",
    endedAt: "2026-09-01T00:00:00.000Z",
    summary: { seasonId: SCOPE.seasonId },
  });

  assert.equal(
    (await seasonRepository.findSeason({ ownerSessionId: OWNER_A, ...SCOPE }))
      .status,
    "COMPLETED",
  );
  await assert.rejects(
    () =>
      photoRepository.insertPhoto(
        photo("photo-2", "2026-09-02T00:00:00.000Z"),
        { ownerSessionId: OWNER_A },
      ),
    (error) => error?.code === "SEASON_NOT_ACTIVE",
  );
});
