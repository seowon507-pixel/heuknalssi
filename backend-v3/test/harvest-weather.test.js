import assert from "node:assert/strict";
import test from "node:test";

import { calculateHarvestWeatherPace } from "../src/domain/index.js";

const FROM = "2026-07-01";
const TO = "2026-07-30";
const BASELINE_HARVEST_WINDOW = Object.freeze({
  earliest: "2026-08-29",
  latest: "2026-09-28",
});

function days(meanTemperature, count = 30) {
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(Date.UTC(2026, 6, index + 1)).toISOString().slice(0, 10),
    minTemperature: meanTemperature - 5,
    maxTemperature: meanTemperature + 5,
    meanTemperature,
    precipitationAmount: index % 5 === 0 ? 3 : 0,
  }));
}

function normals(value = 20) {
  return Array.from({ length: 12 }, (_, index) => ({
    metric: "meanTemperature",
    month: index + 1,
    value,
    unit: "degC",
  }));
}

test("평년과 같은 적산온도는 수확 일정을 바꾸지 않는다", () => {
  const result = calculateHarvestWeatherPace({
    cropId: "CUCUMBER",
    from: FROM,
    to: TO,
    asOfDate: TO,
    baselineHarvestWindow: BASELINE_HARVEST_WINDOW,
    readings: days(20),
    monthlyNormals: normals(20),
  });

  assert.equal(result.state, "READY");
  assert.equal(result.coverage, 1);
  assert.equal(result.adjustmentApplied, true);
  assert.equal(result.adjustmentDays, 0);
  assert.deepEqual(result.adjustedHarvestWindow, BASELINE_HARVEST_WINDOW);
  assert.equal(result.adjustmentMode, "REMAINING_GDD_WINDOW_V2");
  assert.equal(result.precipitationAmount, 18);
});

test("남은 기간과 기준 수확 범위 폭 안에서 빠르거나 느린 일정을 조정한다", () => {
  const fast = calculateHarvestWeatherPace({
    cropId: "CUCUMBER",
    from: FROM,
    to: TO,
    asOfDate: TO,
    baselineHarvestWindow: BASELINE_HARVEST_WINDOW,
    readings: days(25),
    monthlyNormals: normals(20),
  });
  const slow = calculateHarvestWeatherPace({
    cropId: "CUCUMBER",
    from: FROM,
    to: TO,
    asOfDate: TO,
    baselineHarvestWindow: BASELINE_HARVEST_WINDOW,
    readings: days(15),
    monthlyNormals: normals(20),
  });

  assert.equal(fast.maximumAdjustmentDays, 8);
  assert.equal(fast.adjustmentDays, -8);
  assert.deepEqual(fast.adjustedHarvestWindow, {
    earliest: "2026-08-21",
    latest: "2026-09-20",
  });
  assert.equal(slow.adjustmentDays, 8);
  assert.deepEqual(slow.adjustedHarvestWindow, {
    earliest: "2026-09-06",
    latest: "2026-10-06",
  });
  assert.match(fast.summary, /앞당겨/u);
  assert.match(slow.summary, /늦춰/u);
});

test("기준 수확 범위가 없으면 적산온도만 계산하고 일정을 만들지 않는다", () => {
  const result = calculateHarvestWeatherPace({
    cropId: "CUCUMBER",
    from: FROM,
    to: TO,
    readings: days(25),
    monthlyNormals: normals(20),
  });

  assert.equal(result.state, "READY");
  assert.equal(result.adjustmentApplied, false);
  assert.equal(result.adjustmentDays, 0);
  assert.equal(result.adjustmentMode, "THERMAL_PACE_ONLY");
  assert.equal(result.baselineHarvestWindow, null);
  assert.equal(result.adjustedHarvestWindow, null);
  assert.ok(result.limitations.includes("BASELINE_HARVEST_WINDOW_REQUIRED"));
});

test("기준 수확 범위가 이미 끝났으면 과거 일정을 다시 움직이지 않는다", () => {
  const result = calculateHarvestWeatherPace({
    cropId: "CUCUMBER",
    from: FROM,
    to: TO,
    asOfDate: "2026-10-01",
    baselineHarvestWindow: BASELINE_HARVEST_WINDOW,
    readings: days(25),
    monthlyNormals: normals(20),
  });

  assert.equal(result.adjustmentApplied, false);
  assert.equal(result.adjustmentDays, 0);
  assert.equal(result.adjustmentMode, "THERMAL_PACE_ONLY");
  assert.deepEqual(result.adjustedHarvestWindow, BASELINE_HARVEST_WINDOW);
  assert.ok(result.limitations.includes("BASELINE_HARVEST_WINDOW_ELAPSED"));
});

test("관측 결측이 많으면 0으로 채우지 않고 일정 보정을 보류한다", () => {
  const result = calculateHarvestWeatherPace({
    cropId: "LETTUCE",
    from: FROM,
    to: TO,
    readings: days(20, 10),
    monthlyNormals: normals(20),
  });

  assert.equal(result.state, "PARTIAL");
  assert.equal(result.coverage, 0.3333);
  assert.equal(result.adjustmentApplied, false);
  assert.equal(result.adjustmentDays, 0);
  assert.ok(result.limitations.includes("SEASON_WEATHER_COVERAGE_INSUFFICIENT"));
});

test("관측은 충분하지만 평년 적산온도가 0이면 결측이 아닌 비활성 기준으로 구분한다", () => {
  const result = calculateHarvestWeatherPace({
    cropId: "CUCUMBER",
    from: FROM,
    to: TO,
    readings: days(5),
    monthlyNormals: normals(5),
  });

  assert.equal(result.coverage, 1);
  assert.equal(result.paceRatio, null);
  assert.equal(result.adjustmentApplied, false);
  assert.ok(result.limitations.includes("NORMAL_GDD_BASELINE_INACTIVE"));
  assert.ok(!result.limitations.includes("SEASON_WEATHER_COVERAGE_INSUFFICIENT"));
});

test("5종 작물은 각각의 기준온도로 누적을 계산한다", () => {
  const bases = Object.fromEntries(
    ["APPLE", "PEAR", "CUCUMBER", "POTATO", "LETTUCE"].map((cropId) => {
      const result = calculateHarvestWeatherPace({
        cropId,
        from: FROM,
        to: TO,
        readings: days(20),
        monthlyNormals: normals(20),
      });
      return [cropId, result.baseTemperature];
    }),
  );

  assert.deepEqual(bases, {
    APPLE: 4,
    PEAR: 4,
    CUCUMBER: 10,
    POTATO: 5,
    LETTUCE: 4,
  });
});
