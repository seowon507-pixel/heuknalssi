import assert from "node:assert/strict";
import test from "node:test";

import { createCropCycleService } from "../src/application/crop-cycle.js";
import {
  TtlMemoryStore,
  createCropCycleRepository,
} from "../src/infrastructure/index.js";

const SCOPE = Object.freeze({
  farmId: "farm-1",
  cropId: "LETTUCE",
  seasonId: "season-summer",
});

function setup() {
  let now = new Date("2026-08-04T03:00:00.000Z");
  const repository = createCropCycleRepository({
    store: new TtlMemoryStore({ capacityPolicy: "reject" }),
  });
  const service = createCropCycleService({
    repository,
    clock: { now: () => now },
  });
  return {
    repository,
    service,
    setNow(value) {
      now = new Date(value);
    },
  };
}

test("PUT-style upsert stores and updates only the exact farm-crop-season owner scope", async () => {
  const { service } = setup();
  const created = await service.putCycle({
    ownerSessionId: "owner-a",
    ...SCOPE,
    anchorType: "TRANSPLANTING",
    anchorDate: "2026-07-28",
    status: "ACTIVE",
    userConfirmed: true,
  });
  assert.equal(created.status, "ACTIVE");

  const otherOwner = await service.getCycle({
    ownerSessionId: "owner-b",
    ...SCOPE,
  });
  assert.equal(otherOwner, null);

  const updated = await service.putCycle({
    ownerSessionId: "owner-a",
    ...SCOPE,
    anchorType: "TRANSPLANTING",
    anchorDate: "2026-07-30",
    status: "ACTIVE",
    userConfirmed: true,
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.anchorDate, "2026-07-30");
});

test("an unconfirmed planned anchor can be confirmed active and completed", async () => {
  const { service, setNow } = setup();
  await service.putCycle({
    ownerSessionId: "owner-a",
    ...SCOPE,
    anchorType: "TRANSPLANTING",
    anchorDate: "2026-08-10",
    status: "PLANNING",
    userConfirmed: false,
  });

  setNow("2026-08-10T03:00:00.000Z");
  const activated = await service.putCycle({
    ownerSessionId: "owner-a",
    ...SCOPE,
    anchorType: "TRANSPLANTING",
    anchorDate: "2026-08-10",
    status: "ACTIVE",
    userConfirmed: true,
  });
  assert.equal(activated.status, "ACTIVE");

  setNow("2026-09-20T03:00:00.000Z");
  const completed = await service.putCycle({
    ownerSessionId: "owner-a",
    ...SCOPE,
    anchorType: "TRANSPLANTING",
    anchorDate: "2026-08-10",
    status: "COMPLETED",
    userConfirmed: true,
  });
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.completedOn, "2026-09-20");

  setNow("2026-09-21T03:00:00.000Z");
  const replayedCompletion = await service.putCycle({
    ownerSessionId: "owner-a",
    ...SCOPE,
    anchorType: "TRANSPLANTING",
    anchorDate: "2026-08-10",
    status: "COMPLETED",
    userConfirmed: true,
  });
  assert.equal(replayedCompletion.revision, completed.revision);
  assert.equal(replayedCompletion.completedOn, "2026-09-20");

  await assert.rejects(
    () => service.putCycle({
      ownerSessionId: "owner-a",
      ...SCOPE,
      anchorType: "TRANSPLANTING",
      anchorDate: "2026-08-10",
      status: "ACTIVE",
      userConfirmed: true,
    }),
    (error) => error?.code === "CROP_CYCLE_COMPLETED",
  );
});

test("completion requires explicit confirmation", async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.putCycle({
      ownerSessionId: "owner-a",
      ...SCOPE,
      anchorType: "TRANSPLANTING",
      anchorDate: "2026-07-28",
      status: "COMPLETED",
      userConfirmed: false,
    }),
    (error) => error?.code === "CROP_CYCLE_COMPLETE_CONFIRMATION_REQUIRED",
  );
});

test("a stored user-confirmed HARVEST_WINDOW is preserved before the estimate", async () => {
  const { service } = setup();
  const scope = {
    farmId: "farm-1",
    cropId: "CUCUMBER",
    seasonId: "season-early-harvest",
  };
  const stored = await service.putCycle({
    ownerSessionId: "owner-a",
    ...scope,
    anchorType: "TRANSPLANTING",
    anchorDate: "2026-08-01",
    status: "HARVEST_WINDOW",
    userConfirmed: true,
  });
  assert.equal(stored.status, "HARVEST_WINDOW");
  assert.equal(stored.currentMilestone.candidates[0].code, "HARVEST");
  assert.equal(stored.nextMilestone, null);

  const retrieved = await service.getCycle({
    ownerSessionId: "owner-a",
    ...scope,
  });
  assert.equal(retrieved.status, "HARVEST_WINDOW");
});

test("repository rejects stale replacements and keeps exact owner scope", async () => {
  const { repository } = setup();
  const stored = {
    farmId: "farm-1",
    cropId: "APPLE",
    seasonId: "season-1",
    revision: 1,
  };
  assert.equal(await repository.insertCycle(stored, { ownerSessionId: "owner-a" }), true);
  assert.equal(await repository.insertCycle(stored, { ownerSessionId: "owner-a" }), false);
  assert.equal(
    await repository.replaceCycle(
      { ...stored, revision: 2 },
      { ownerSessionId: "owner-a", expectedRevision: 9 },
    ),
    false,
  );
  assert.equal(
    await repository.findCycle({ ownerSessionId: "owner-b", ...SCOPE }),
    null,
  );
});

test("한국 날짜 경계로 기준일과 완료일을 계산한다", async () => {
  const { service, setNow } = setup();
  setNow("2026-08-03T15:30:00.000Z");
  const activated = await service.putCycle({
    ownerSessionId: "owner-a",
    ...SCOPE,
    anchorType: "TRANSPLANTING",
    anchorDate: "2026-08-04",
    status: "ACTIVE",
    userConfirmed: true,
  });
  assert.equal(activated.anchorDate, "2026-08-04");

  const completed = await service.putCycle({
    ownerSessionId: "owner-a",
    ...SCOPE,
    anchorType: "TRANSPLANTING",
    anchorDate: "2026-08-04",
    status: "COMPLETED",
    userConfirmed: true,
  });
  assert.equal(completed.completedOn, "2026-08-04");
});

test("재배 중인 작물의 기준일은 한국 날짜 기준 미래일 수 없다", async () => {
  const { service, setNow } = setup();
  setNow("2026-08-03T15:30:00.000Z");
  await assert.rejects(
    () => service.putCycle({
      ownerSessionId: "owner-a",
      ...SCOPE,
      anchorType: "TRANSPLANTING",
      anchorDate: "2026-08-05",
      status: "ACTIVE",
      userConfirmed: true,
    }),
    (error) => error?.code === "CROP_CYCLE_ACTIVE_DATE_INVALID",
  );
});
