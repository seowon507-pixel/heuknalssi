import assert from "node:assert/strict";
import test from "node:test";

import {
  createCropCycleAdapter,
  createDefaultCropCycleInput,
  normalizeCropCycleInput,
  projectLocalCropCycle,
} from "./crop-cycle.mjs";

const AS_OF = new Date("2026-08-04T12:00:00+09:00");

test("재배 중 미리보기는 실제 상태 점수가 아닌 범위 기반 진행률을 결정론적으로 보여 준다", () => {
  const input = {
    seasonId: "season-potato-2026",
    anchorType: "SOWING",
    anchorDate: "2026-06-15",
    status: "ACTIVE",
  };

  const first = projectLocalCropCycle({ crop: "potato", input, asOf: AS_OF });
  const second = projectLocalCropCycle({ crop: "potato", input, asOf: AS_OF });

  assert.deepEqual(first, second);
  assert.equal(first.source, "LOCAL_PREVIEW");
  assert.equal(first.sourceLabel, "입력 기준 예상");
  assert.ok(first.progress.minPercent <= first.progress.maxPercent);
  assert.ok(first.progress.maxPercent <= 100);
  assert.equal(typeof first.currentMilestone.candidates[0].label, "string");
  assert.equal(typeof first.nextMilestone.candidates[0].label, "string");
  assert.match(first.harvestWindow.earliest, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(first.progress.actualBiologicalScore, null);
  assert.equal("score" in first, false);
});

test("재배 준비 진단은 예정 시작일 전 준비 시작과 0% 진행 범위를 분리한다", () => {
  const input = createDefaultCropCycleInput({
    crop: "lettuce",
    situation: "planning",
    date: new Date("2026-08-18T12:00:00+09:00"),
    seasonId: "season-lettuce-planning",
  });
  const projection = projectLocalCropCycle({ crop: "lettuce", input, asOf: AS_OF });

  assert.equal(input.anchorType, "TRANSPLANTING");
  assert.equal(input.status, "PLANNING");
  assert.equal(projection.progress.minPercent, 0);
  assert.equal(projection.progress.maxPercent, 0);
  assert.equal(projection.currentMilestone.candidates[0].label, "재배 시작 전 준비");
  assert.equal(projection.nextMilestone.candidates[0].label, "재배 시작 예정");
  assert.ok(projection.currentMilestone.candidates[0].window.earliest < input.anchorDate);
  assert.ok(projection.preparationStartsOn.earliest > input.anchorDate);
});

test("기존 재배 농장의 기준일이 없으면 생육 단계에서 날짜 범위를 보수적으로 역산한다", () => {
  const input = createDefaultCropCycleInput({
    crop: "apple",
    situation: "growing",
    growth: "middle",
    date: AS_OF,
    seasonId: "season-apple-migrated",
  });
  const projection = projectLocalCropCycle({
    crop: "apple",
    input,
    asOf: AS_OF,
    sourceLabel: "날짜 기준 AI 예상",
  });

  assert.ok(input.anchorDate < "2026-08-04");
  assert.ok(projection.progress.minPercent >= 35);
  assert.ok(projection.progress.maxPercent <= 70);
  assert.equal(projection.sourceLabel, "날짜 기준 AI 예상");
  assert.equal(projection.progress.actualBiologicalScore, null);
});

test("서버 projection은 그대로 구분하고 API 실패만 로컬 미리보기로 낮춘다", async () => {
  const input = {
    seasonId: "season-cucumber-2026",
    anchorType: "TRANSPLANTING",
    anchorDate: "2026-07-01",
    status: "ACTIVE",
  };
  const serverCycle = {
    ...input,
    progress: {
      kind: "SCHEDULE_RANGE",
      minPercent: 28,
      maxPercent: 36,
      actualBiologicalScore: null,
    },
    harvestWindow: { earliest: "2026-08-20", latest: "2026-09-10" },
    currentMilestone: {
      certainty: "ESTIMATED",
      candidates: [{
        code: "FLOWERING_PREP",
        label: "개화 준비",
        window: { earliest: "2026-07-24", latest: "2026-08-02" },
      }],
    },
    nextMilestone: {
      certainty: "ESTIMATED",
      candidates: [{
        code: "FIRST_HARVEST",
        label: "첫 수확",
        window: { earliest: "2026-08-20", latest: "2026-09-10" },
      }],
    },
    preparationStartsOn: { earliest: "2026-06-17", latest: "2026-06-17" },
    confidence: "REVIEWED_RULE",
    estimated: true,
    evidenceRefs: [{
      sourceId: "NONGSARO_CUCUMBER_CROPPING_SYSTEMS",
      url: "https://www.nongsaro.go.kr/cucumber",
      supports: ["SOWING_AND_HARVEST_MONTH_RANGES"],
    }],
  };
  const remote = createCropCycleAdapter({
    getCycle: async () => ({ cycle: serverCycle }),
    putCycle: async () => ({ cycle: serverCycle }),
    now: () => AS_OF,
  });
  const ready = await remote.load({ farmId: "farm-1", cropId: "crop-cucumber", crop: "cucumber", input });

  assert.equal(ready.source, "SERVER_PROJECTION");
  assert.equal(ready.sourceLabel, "서버 재배일정 계산");
  assert.deepEqual(ready.progress, serverCycle.progress);
  assert.deepEqual(ready.evidenceRefs, [{
    sourceId: "NONGSARO_CUCUMBER_CROPPING_SYSTEMS",
    url: "https://www.nongsaro.go.kr/cucumber",
    supports: ["SOWING_AND_HARVEST_MONTH_RANGES"],
  }]);
  assert.notEqual(ready.evidenceRefs[0], "[object Object]");

  const unavailable = createCropCycleAdapter({
    getCycle: async () => { throw new Error("offline"); },
    putCycle: async () => { throw new Error("offline"); },
    now: () => AS_OF,
  });
  const fallback = await unavailable.save({ farmId: "farm-1", cropId: "crop-cucumber", crop: "cucumber", input });

  assert.equal(fallback.source, "LOCAL_PREVIEW");
  assert.equal(fallback.sourceLabel, "입력 기준 예상");
  assert.equal(fallback.remoteState, "UNAVAILABLE");
});

test("PUT 400·409 계약 오류는 미리보기로 숨기지 않는다", async () => {
  const contractError = Object.assign(new Error("invalid anchor"), { status: 400, code: "INVALID_ANCHOR_TYPE" });
  const adapter = createCropCycleAdapter({
    getCycle: async () => { throw contractError; },
    putCycle: async () => { throw contractError; },
    now: () => AS_OF,
  });
  const scope = {
    farmId: "farm-1",
    cropId: "POTATO",
    crop: "potato",
    input: {
      seasonId: "season-potato-2026",
      anchorType: "SOWING",
      anchorDate: "2026-06-15",
      status: "ACTIVE",
    },
  };

  await assert.rejects(adapter.save(scope), (error) => error === contractError);
  await assert.rejects(adapter.load(scope), (error) => error === contractError);
});

test("로컬 작물 범위와 수확 준비 기간은 백엔드 계약과 같다", () => {
  const projection = projectLocalCropCycle({
    crop: "potato",
    input: {
      seasonId: "season-potato-2026",
      anchorType: "SOWING",
      anchorDate: "2026-06-15",
      status: "ACTIVE",
    },
    asOf: AS_OF,
  });

  assert.deepEqual(projection.harvestWindow, {
    earliest: "2026-08-24",
    latest: "2026-11-02",
  });
  assert.deepEqual(projection.preparationStartsOn, {
    earliest: "2026-07-20",
    latest: "2026-10-13",
  });
});

test("서버에 없던 기존 시즌도 같은 ID로 활성화한 뒤 안전하게 종료한다", async () => {
  const calls = [];
  const input = {
    seasonId: "season-apple-legacy",
    anchorType: "FLOWERING",
    anchorDate: "2026-04-15",
    status: "COMPLETED",
  };
  const putCycle = async (_farmId, _cropId, payload) => {
    calls.push(structuredClone(payload));
    if (calls.length === 1) {
      throw Object.assign(new Error("missing"), {
        status: 404,
        code: "CROP_CYCLE_NOT_FOUND",
      });
    }
    return {
      cycle: {
        ...input,
        farmId: "farm-1",
        cropId: "APPLE",
        userConfirmed: true,
        completedOn: "2026-08-04",
        revision: 2,
        progress: { kind: "SCHEDULE_RANGE", minPercent: 100, maxPercent: 100, actualBiologicalScore: null },
        harvestWindow: { earliest: "2026-08-18", latest: "2026-10-22" },
        currentMilestone: {
          certainty: "CONFIRMED",
          candidates: [{ code: "COMPLETED", label: "시즌 종료", window: { earliest: "2026-08-04", latest: "2026-08-04" } }],
        },
        nextMilestone: null,
        preparationStartsOn: { earliest: "2026-07-19", latest: "2026-10-15" },
      },
    };
  };
  const adapter = createCropCycleAdapter({
    getCycle: async () => { throw new Error("not used"); },
    putCycle,
    now: () => AS_OF,
  });

  const result = await adapter.save({
    farmId: "farm-1",
    cropId: "APPLE",
    crop: "apple",
    input,
  });

  assert.deepEqual(calls.map(({ seasonId, status, userConfirmed }) => ({ seasonId, status, userConfirmed })), [
    { seasonId: "season-apple-legacy", status: "COMPLETED", userConfirmed: true },
    { seasonId: "season-apple-legacy", status: "ACTIVE", userConfirmed: true },
    { seasonId: "season-apple-legacy", status: "COMPLETED", userConfirmed: true },
  ]);
  assert.equal(result.progress.minPercent, 100);
  assert.equal(result.status, "COMPLETED");
});

test("재배 중 기준일은 미래일 수 없고 지난 계획일은 시작 확인을 요청한다", () => {
  assert.throws(
    () => normalizeCropCycleInput({
      seasonId: "season-lettuce-future",
      anchorType: "TRANSPLANTING",
      anchorDate: "2999-01-01",
      status: "ACTIVE",
    }, { crop: "lettuce", situation: "growing" }),
    /오늘 이후일 수 없습니다/u,
  );

  const projection = projectLocalCropCycle({
    crop: "lettuce",
    input: {
      seasonId: "season-lettuce-overdue",
      anchorType: "TRANSPLANTING",
      anchorDate: "2026-08-01",
      status: "PLANNING",
    },
    asOf: AS_OF,
  });
  assert.equal(projection.currentMilestone.candidates[0].label, "예정일 지남 · 시작 여부 확인");
  assert.equal(projection.nextMilestone.candidates[0].label, "재배 시작 상태로 전환");
});

test("완료한 시즌은 100% 진행으로 종료되고 다음 단계를 추측하지 않는다", () => {
  const projection = projectLocalCropCycle({
    crop: "apple",
    input: {
      seasonId: "season-apple-2026",
      anchorType: "FLOWERING",
      anchorDate: "2026-04-15",
      status: "COMPLETED",
    },
    asOf: AS_OF,
  });

  assert.equal(projection.progress.minPercent, 100);
  assert.equal(projection.progress.maxPercent, 100);
  assert.equal(projection.currentMilestone.candidates[0].label, "시즌 종료");
  assert.equal(projection.nextMilestone, null);
});
