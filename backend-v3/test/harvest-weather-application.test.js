import assert from "node:assert/strict";
import test from "node:test";

import { createHarvestWeatherService } from "../src/application/index.js";

function readings() {
  return Array.from({ length: 30 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 6, index + 1)).toISOString().slice(0, 10),
    minTemperature: 15,
    maxTemperature: 25,
    meanTemperature: 20,
    precipitationAmount: 0,
  }));
}

function normals() {
  return Array.from({ length: 12 }, (_, index) => ({
    metric: "meanTemperature",
    month: index + 1,
    value: 20,
    unit: "degC",
  }));
}

test("소유 분석·작물주기의 지점으로 재배기간 ASOS와 평년값을 함께 조회한다", async () => {
  const calls = [];
  const service = createHarvestWeatherService({
    cropCycleService: {
      async getCycle(input) {
        calls.push(["cycle", input]);
        return { status: "ACTIVE", anchorDate: "2026-07-01" };
      },
    },
    async getAnalysis() {
      return { inputSummary: { crop: "CUCUMBER" }, observations: { result: null } };
    },
    async getAnalysisContext() {
      return { observationStationId: "119", normalStationId: "108" };
    },
    observationAdapter: {
      async getDailyRange(input) {
        calls.push(["observations", input]);
        return {
          sourceId: "kma-asos-observations",
          sourceName: "ASOS",
          adapterState: "SUCCESS",
          qualityFlags: [],
          data: { stationName: "수원", readings: readings() },
        };
      },
    },
    climateAdapter: {
      async getNormals(input) {
        calls.push(["normals", input]);
        return {
          sourceId: "kma-climate-normal",
          sourceName: "기후평년",
          adapterState: "SUCCESS",
          qualityFlags: [],
          data: { observations: normals() },
        };
      },
    },
    clock: () => new Date("2026-07-31T03:00:00.000Z").getTime(),
  });

  const result = await service.getSeasonWeather({
    ownerSessionId: "owner-1",
    farmId: "farm-1",
    cropId: "CUCUMBER",
    seasonId: "season-1",
    analysisId: "analysis-1",
  });

  assert.equal(result.state, "READY");
  assert.equal(result.adjustmentDays, 0);
  assert.deepEqual(calls.find(([name]) => name === "observations")[1], {
    stationId: "119",
    from: "2026-07-01",
    to: "2026-07-30",
  });
  assert.deepEqual(calls.find(([name]) => name === "normals")[1], {
    stationId: "108",
  });
});

test("재배 예정 상태는 과거 관측을 요청하지 않는다", async () => {
  let called = false;
  const service = createHarvestWeatherService({
    cropCycleService: {
      async getCycle() { return { status: "PLANNING", anchorDate: "2026-08-10" }; },
    },
    async getAnalysis() { return { inputSummary: { crop: "APPLE" } }; },
    async getAnalysisContext() {
      return { observationStationId: "108", normalStationId: "108" };
    },
    observationAdapter: { async getDailyRange() { called = true; } },
    climateAdapter: { async getNormals() { called = true; } },
    clock: () => new Date("2026-08-04T03:00:00.000Z").getTime(),
  });

  const result = await service.getSeasonWeather({
    ownerSessionId: "owner-1",
    farmId: "farm-1",
    cropId: "APPLE",
    seasonId: "season-1",
    analysisId: "analysis-1",
  });

  assert.equal(result.state, "HOLD");
  assert.equal(result.adjustmentApplied, false);
  assert.equal(called, false);
});
