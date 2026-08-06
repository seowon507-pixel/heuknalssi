import assert from "node:assert/strict";
import test from "node:test";

import {
  createCropCycleRecord,
  projectCropCycle,
  updateCropCycleRecord,
} from "../src/domain/crop-cycle.js";

const META = Object.freeze({
  farmId: "farm-1",
  seasonId: "season-2026-spring",
  createdAt: "2026-03-10T01:00:00.000Z",
  updatedAt: "2026-03-10T01:00:00.000Z",
  completedOn: null,
  revision: 1,
});

function record(overrides = {}) {
  return createCropCycleRecord({
    ...META,
    cropId: "POTATO",
    anchorType: "SOWING",
    anchorDate: "2026-03-10",
    status: "ACTIVE",
    userConfirmed: true,
    ...overrides,
  });
}

test("official potato ranges preserve preparation and harvest windows", () => {
  const cycle = projectCropCycle(record(), { asOfDate: "2026-05-20" });

  assert.equal(cycle.status, "HARVEST_WINDOW");
  assert.equal(cycle.anchorType, "SOWING");
  assert.deepEqual(cycle.preparationStartsOn, {
    earliest: "2026-04-14",
    latest: "2026-07-08",
  });
  assert.deepEqual(cycle.harvestWindow, {
    earliest: "2026-05-19",
    latest: "2026-07-28",
  });
  assert.deepEqual(cycle.progress, {
    kind: "SCHEDULE_ESTIMATE",
    minPercent: 50,
    maxPercent: 100,
    actualBiologicalScore: null,
  });
  assert.equal("growthScore" in cycle, false);
  assert.equal(cycle.ruleVersion, "crop-cycle-v2");
  assert.equal(cycle.evidenceVersion, "nongsaro-crop-cycle-evidence-2026-08-04.v2");
  assert.ok(cycle.evidenceRefs.some(({ sourceId }) => sourceId === "NONGSARO_POTATO_WORK_SCHEDULE"));
});

test("cucumber first-harvest readiness is separate from the long harvest season", () => {
  const cycle = projectCropCycle(
    record({
      cropId: "CUCUMBER",
      anchorType: "TRANSPLANTING",
      anchorDate: "2026-07-01",
    }),
    { asOfDate: "2026-08-04" },
  );

  assert.deepEqual(cycle.harvestWindow, {
    earliest: "2026-08-15",
    latest: "2026-09-14",
  });
  assert.deepEqual(cycle.harvestSeasonWindow, {
    earliest: "2026-08-15",
    latest: "2027-02-26",
  });
  assert.deepEqual(cycle.progress, {
    kind: "SCHEDULE_ESTIMATE",
    minPercent: 45,
    maxPercent: 76,
    actualBiologicalScore: null,
  });
});

test("a planned LAND_SEARCH-style anchor stays PLANNING and supports unconfirmed estimates", () => {
  const cycle = projectCropCycle(
    record({
      cropId: "LETTUCE",
      anchorType: "TRANSPLANTING",
      anchorDate: "2026-09-01",
      status: "PLANNING",
      userConfirmed: false,
    }),
    { asOfDate: "2026-08-04" },
  );

  assert.equal(cycle.status, "PLANNING");
  assert.deepEqual(cycle.progress, {
    kind: "SCHEDULE_ESTIMATE",
    minPercent: 0,
    maxPercent: 0,
    actualBiologicalScore: null,
  });
  assert.equal(cycle.currentMilestone.candidates[0].code, "PLANNING");
  assert.equal(cycle.nextMilestone.candidates[0].code, "TRANSPLANTING");
  assert.equal(cycle.userConfirmed, false);
  assert.equal(cycle.estimated, true);
});

test("crop-specific anchor allowlists reject unsupported or unknown context", () => {
  assert.throws(
    () => record({ cropId: "APPLE", anchorType: "SOWING" }),
    (error) => error?.code === "CROP_CYCLE_ANCHOR_INVALID",
  );
  assert.throws(
    () => record({ cropId: "TOMATO", anchorType: "SOWING" }),
    (error) => error?.code === "CROP_CYCLE_CROP_INVALID",
  );
  assert.throws(
    () => record({ cropId: "POTATO", anchorType: "UNKNOWN" }),
    (error) => error?.code === "CROP_CYCLE_ANCHOR_INVALID",
  );
});

test("all five crops expose deterministic reviewed anchor projections", () => {
  const cases = [
    ["APPLE", "FLOWERING"],
    ["PEAR", "FLOWERING"],
    ["CUCUMBER", "TRANSPLANTING"],
    ["POTATO", "SOWING"],
    ["LETTUCE", "TRANSPLANTING"],
  ];

  for (const [cropId, anchorType] of cases) {
    const cycle = projectCropCycle(
      record({ cropId, anchorType, anchorDate: "2026-04-01" }),
      { asOfDate: "2026-04-15" },
    );
    assert.equal(cycle.cropId, cropId);
    assert.equal(cycle.anchorType, anchorType);
    assert.ok(cycle.harvestWindow.earliest < cycle.harvestWindow.latest);
    assert.ok(cycle.anchorDate < cycle.preparationStartsOn.earliest);
    assert.ok(
      cycle.preparationStartsOn.earliest < cycle.harvestWindow.earliest,
    );
    assert.ok(
      cycle.preparationStartsOn.latest <= cycle.harvestWindow.latest,
    );
    assert.ok(
      cycle.preparationStartsOn.earliest <= cycle.preparationStartsOn.latest,
    );
    assert.ok(["LOW", "MEDIUM"].includes(cycle.confidence));
    assert.equal(cycle.evidenceRefs.length, 1);
  }
});

test("a confirmed HARVEST_WINDOW overrides an earlier schedule estimate", () => {
  const cycle = projectCropCycle(
    record({
      cropId: "CUCUMBER",
      anchorType: "TRANSPLANTING",
      anchorDate: "2026-04-01",
      status: "HARVEST_WINDOW",
      userConfirmed: true,
    }),
    { asOfDate: "2026-04-10" },
  );

  assert.equal(cycle.status, "HARVEST_WINDOW");
  assert.equal(cycle.currentMilestone.candidates[0].code, "HARVEST");
  assert.equal(cycle.nextMilestone, null);
  assert.throws(
    () =>
      record({
        status: "HARVEST_WINDOW",
        userConfirmed: false,
      }),
    (error) => error?.code === "CROP_CYCLE_CONFIRMATION_INVALID",
  );
});

test("fruit flowering anchors retain variety uncertainty instead of a point date", () => {
  const apple = projectCropCycle(
    record({
      cropId: "APPLE",
      anchorType: "FLOWERING",
      anchorDate: "2026-04-10",
    }),
    { asOfDate: "2026-08-20" },
  );
  const pear = projectCropCycle(
    record({
      cropId: "PEAR",
      anchorType: "FLOWERING",
      anchorDate: "2026-04-10",
    }),
    { asOfDate: "2026-08-20" },
  );

  assert.deepEqual(apple.harvestWindow, {
    earliest: "2026-08-13",
    latest: "2026-10-17",
  });
  assert.deepEqual(pear.harvestWindow, {
    earliest: "2026-09-02",
    latest: "2026-10-12",
  });
  assert.equal(apple.confidence, "MEDIUM");
  assert.ok(apple.uncertaintyFactors.includes("VARIETY_UNSPECIFIED"));
  assert.ok(pear.uncertaintyFactors.includes("VARIETY_UNSPECIFIED"));
});

test("updates preserve scope and completion is explicit and terminal", () => {
  const updated = updateCropCycleRecord(record(), {
    anchorDate: "2026-03-12",
    status: "ACTIVE",
    userConfirmed: true,
    updatedAt: "2026-05-01T01:00:00.000Z",
    completedOn: null,
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.anchorDate, "2026-03-12");

  const completed = updateCropCycleRecord(updated, {
    anchorDate: updated.anchorDate,
    anchorType: updated.anchorType,
    status: "COMPLETED",
    userConfirmed: true,
    updatedAt: "2026-06-01T01:00:00.000Z",
    completedOn: "2026-06-01",
  });
  const cycle = projectCropCycle(completed, { asOfDate: "2026-06-01" });
  assert.equal(cycle.status, "COMPLETED");
  assert.deepEqual(cycle.progress, {
    kind: "SCHEDULE_ESTIMATE",
    minPercent: 100,
    maxPercent: 100,
    actualBiologicalScore: null,
  });
  assert.equal(cycle.nextMilestone, null);
  const retrievedLater = projectCropCycle(completed, { asOfDate: "2026-06-20" });
  assert.equal(retrievedLater.completedOn, "2026-06-01");
  assert.deepEqual(retrievedLater.harvestWindow, {
    earliest: "2026-05-21",
    latest: "2026-07-30",
  });
  assert.deepEqual(retrievedLater.preparationStartsOn, {
    earliest: "2026-04-16",
    latest: "2026-07-10",
  });
  assert.deepEqual(retrievedLater.currentMilestone.candidates[0].window, {
    earliest: "2026-06-01",
    latest: "2026-06-01",
  });
  assert.throws(
    () => updateCropCycleRecord(completed, { ...completed, status: "ACTIVE" }),
    (error) => error?.code === "CROP_CYCLE_COMPLETED",
  );
});
