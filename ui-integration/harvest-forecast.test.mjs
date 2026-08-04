import assert from "node:assert/strict";
import test from "node:test";

import { buildHarvestForecast } from "./harvest-forecast.mjs";

const PROJECTION = Object.freeze({
  status: "ACTIVE",
  anchorDate: "2026-07-01",
  progress: { minPercent: 29, maxPercent: 100 },
  harvestWindow: { earliest: "2026-08-15", latest: "2026-09-14" },
  harvestSeasonWindow: { earliest: "2026-08-15", latest: "2027-02-26" },
  preparationStartsOn: { earliest: "2026-08-08", latest: "2026-09-07" },
});

test("오이 첫 수확 진행도는 장기 수확 종료일과 분리된 단일 값이다", () => {
  const result = buildHarvestForecast({
    crop: "cucumber",
    projection: PROJECTION,
    asOf: new Date("2026-08-04T00:00:00Z"),
  });

  assert.equal(typeof result.progressPercent, "number");
  assert.ok(result.progressPercent > 50 && result.progressPercent < 100);
  assert.deepEqual(result.firstHarvestWindow, PROJECTION.harvestWindow);
  assert.deepEqual(result.harvestSeasonWindow, PROJECTION.harvestSeasonWindow);
});

test("확인된 고온·저온 예보만 첫 수확 일정을 최대 7일 늦춘다", () => {
  const result = buildHarvestForecast({
    crop: "cucumber",
    projection: PROJECTION,
    forecastDays: Array.from({ length: 7 }, (_, index) => ({
      date: `2026-08-${String(index + 4).padStart(2, "0")}`,
      minTemperature: 24,
      maxTemperature: 41,
    })),
    asOf: new Date("2026-08-04T00:00:00Z"),
  });

  assert.equal(result.weather.delayDays, 7);
  assert.equal(result.firstHarvestWindow.earliest, "2026-08-22");
  assert.equal(result.preparationWindow.earliest, "2026-08-15");
});

test("재배 시작 후 ASOS 적산온도 보정은 예보 전에 수확 일정에 반영된다", () => {
  const result = buildHarvestForecast({
    crop: "cucumber",
    projection: PROJECTION,
    seasonWeather: {
      adjustmentApplied: true,
      adjustmentDays: -4,
      pairedDayCount: 35,
      coverage: 0.95,
      paceRatio: 1.12,
      summary: "적산온도가 평년보다 빨라 4일 앞당겨 예상",
    },
    asOf: new Date("2026-08-04T00:00:00Z"),
  });

  assert.equal(result.history.adjustmentDays, -4);
  assert.equal(result.totalAdjustmentDays, -4);
  assert.equal(result.firstHarvestWindow.earliest, "2026-08-11");
  assert.match(result.sourceLabel, /4일 앞당김/u);
});

test("누적날씨 결측 보류는 수확 일정을 바꾸지 않는다", () => {
  const result = buildHarvestForecast({
    crop: "cucumber",
    projection: PROJECTION,
    seasonWeather: {
      adjustmentApplied: false,
      adjustmentDays: 12,
      summary: "관측이 부족해 기준 일정을 유지",
    },
    asOf: new Date("2026-08-04T00:00:00Z"),
  });

  assert.equal(result.history.adjustmentDays, 0);
  assert.deepEqual(result.firstHarvestWindow, PROJECTION.harvestWindow);
});

test("수확 직전의 신뢰 가능한 NOT_READY 사진만 일정 지연에 반영한다", () => {
  const result = buildHarvestForecast({
    crop: "cucumber",
    projection: PROJECTION,
    photoAssessment: {
      state: "NOT_READY",
      quality: "USABLE",
      confidence: 0.86,
      suggestedDelayDays: 6,
    },
    asOf: new Date("2026-08-12T00:00:00Z"),
  });

  assert.equal(result.photo.delayDays, 6);
  assert.equal(result.firstHarvestWindow.earliest, "2026-08-21");
});

test("판단 보류·저신뢰 사진은 수확일을 바꾸지 않는다", () => {
  const result = buildHarvestForecast({
    crop: "cucumber",
    projection: PROJECTION,
    photoAssessment: {
      state: "NOT_READY",
      quality: "USABLE",
      confidence: 0.4,
      suggestedDelayDays: 12,
    },
    asOf: new Date("2026-08-12T00:00:00Z"),
  });

  assert.equal(result.photo.delayDays, 0);
  assert.deepEqual(result.firstHarvestWindow, PROJECTION.harvestWindow);
});

test("첫 수확 범위에서 너무 멀리 떨어진 사진은 과거 일정을 다시 쓰지 않는다", () => {
  const result = buildHarvestForecast({
    crop: "cucumber",
    projection: PROJECTION,
    photoAssessment: {
      state: "NOT_READY",
      quality: "USABLE",
      confidence: 0.9,
      suggestedDelayDays: 10,
    },
    asOf: new Date("2027-01-10T00:00:00Z"),
  });

  assert.equal(result.photo.delayDays, 0);
  assert.deepEqual(result.firstHarvestWindow, PROJECTION.harvestWindow);
});
