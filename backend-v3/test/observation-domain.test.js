import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecentCompletedDates,
  evaluateObservation,
  OBSERVATION_CONTRACT,
  validateObservationInput,
} from "../src/domain/index.js";

const SEOUL_NOON = "2026-07-23T03:00:00.000Z";

function reading(date, overrides = {}) {
  return {
    date,
    stationId: "108",
    minTemperature: 15,
    maxTemperature: 25,
    meanTemperature: 20,
    precipitationAmount: 0,
    ...overrides,
  };
}

function input(overrides = {}) {
  const now = overrides.now ?? SEOUL_NOON;
  const dates = buildRecentCompletedDates(now);
  return {
    stationId: "108",
    stationName: "서울",
    distanceKm: 4.2,
    readings: dates.map((date) => reading(date)),
    monthlyNormals: [],
    now,
    ...overrides,
  };
}

test("observation contract freezes Asia/Seoul, seven days, four fields, and the 5/7 gate", () => {
  assert.deepEqual(OBSERVATION_CONTRACT, {
    timeZone: "Asia/Seoul",
    windowDays: 7,
    trendMinimumValidDays: 5,
    requiredDailyFields: [
      "minTemperature",
      "maxTemperature",
      "meanTemperature",
      "precipitationAmount",
    ],
  });
});

test("completed dates exclude the current Asia/Seoul day at the UTC date boundary", () => {
  assert.deepEqual(
    buildRecentCompletedDates("2026-07-23T14:59:59.999Z"),
    [
      "2026-07-16",
      "2026-07-17",
      "2026-07-18",
      "2026-07-19",
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
    ],
  );
  assert.deepEqual(
    buildRecentCompletedDates("2026-07-23T15:00:00.000Z"),
    [
      "2026-07-17",
      "2026-07-18",
      "2026-07-19",
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
    ],
  );
});

test("seven complete, unique observation days are READY and deterministically sorted", () => {
  const request = input();
  request.readings.reverse();
  const module = evaluateObservation(request);
  assert.equal(module.state, "READY");
  assert.equal(module.coverage, 1);
  assert.deepEqual(module.blockingReasons, []);
  assert.equal(module.result.validDayCount, 7);
  assert.equal(module.result.trendSummaryAvailable, true);
  assert.deepEqual(
    module.result.days.map((day) => day.date),
    buildRecentCompletedDates(SEOUL_NOON),
  );
  assert.equal(
    module.result.completedDateRange.timeZone,
    "Asia/Seoul",
  );
});

test("empty readings are HOLD, never READY, and retain all seven missing dates", () => {
  const module = evaluateObservation(input({ readings: [] }));
  assert.equal(module.state, "HOLD");
  assert.equal(module.coverage, 0);
  assert.equal(module.result.validDayCount, 0);
  assert.equal(module.result.trendSummaryAvailable, false);
  assert.equal(module.result.days.length, 7);
  assert.ok(
    module.result.days.every(
      (day) =>
        day.minTemperature === null &&
        day.maxTemperature === null &&
        day.meanTemperature === null &&
        day.precipitationAmount === null,
    ),
  );
  assert.ok(module.qualityFlags.includes("NO_DATA"));
  assert.ok(module.missingInputs.includes("observation:2026-07-22:meanTemperature"));
});

test("a valid day requires all four fields; trend is hidden below five valid days", () => {
  const dates = buildRecentCompletedDates(SEOUL_NOON);
  const fourComplete = dates.slice(0, 4).map((date) => reading(date));
  const partialDay = reading(dates[4], { precipitationAmount: null });
  const module = evaluateObservation(
    input({ readings: [...fourComplete, partialDay] }),
  );
  assert.equal(module.state, "PARTIAL");
  assert.equal(module.result.validDayCount, 4);
  assert.equal(module.coverage, 4 / 7);
  assert.equal(module.result.trendSummaryAvailable, false);
  assert.ok(module.qualityFlags.includes("TREND_SUMMARY_WITHHELD"));
  assert.ok(
    module.missingInputs.includes(
      `observation:${dates[4]}:precipitationAmount`,
    ),
  );
});

test("an incomplete day cannot receive a monthly-normal deviation", () => {
  const dates = buildRecentCompletedDates(SEOUL_NOON);
  const module = evaluateObservation(
    input({
      readings: [
        reading(dates[0], {
          precipitationAmount: null,
          meanTemperature: 20,
        }),
      ],
      monthlyNormals: [
        {
          stationId: "108",
          month: 7,
          meanTemperature: 15,
          normalPeriod: "1991-2020",
        },
      ],
    }),
  );
  assert.equal(module.result.days[0].monthlyNormalDeviation, null);
});

test("five valid days enable trend but the incomplete seven-day window remains PARTIAL", () => {
  const dates = buildRecentCompletedDates(SEOUL_NOON);
  const module = evaluateObservation(
    input({ readings: dates.slice(0, 5).map((date) => reading(date)) }),
  );
  assert.equal(module.state, "PARTIAL");
  assert.equal(module.result.validDayCount, 5);
  assert.equal(module.result.trendSummaryAvailable, true);
  assert.deepEqual(module.blockingReasons, ["OBSERVATION_WINDOW_INCOMPLETE"]);
});

test("today, dates outside the seven-day window, duplicates, and station mismatch fail closed", () => {
  const dates = buildRecentCompletedDates(SEOUL_NOON);
  const cases = [
    [...dates.map((date) => reading(date)), reading("2026-07-23")],
    [reading("2026-07-15")],
    [reading(dates[0]), reading(dates[0])],
    [reading(dates[0], { stationId: "119" })],
  ];
  const expectedCodes = [
    "OBSERVATION_DATE_OUTSIDE_COMPLETED_WINDOW",
    "OBSERVATION_DATE_OUTSIDE_COMPLETED_WINDOW",
    "DUPLICATE_OBSERVATION_DATE",
    "OBSERVATION_STATION_MISMATCH",
  ];
  cases.forEach((readings, index) => {
    const module = evaluateObservation(input({ readings }));
    assert.equal(module.state, "HOLD");
    assert.equal(module.result, null);
    assert.ok(module.qualityFlags.includes("SCHEMA_CHANGED"));
    assert.ok(
      module.contractErrors.some(
        (error) => error.code === expectedCodes[index],
      ),
    );
  });
});

test("dates must be real ISO calendar dates", () => {
  const validation = validateObservationInput(
    input({ readings: [reading("2026-02-30")] }),
  );
  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.some(
      (error) => error.code === "INVALID_OBSERVATION_DATE",
    ),
  );
});

test("daily values remain finite or null and are never coerced from missing or malformed input", () => {
  const date = buildRecentCompletedDates(SEOUL_NOON)[0];
  const invalidReadings = [
    reading(date, { minTemperature: Number.NaN }),
    reading(date, { maxTemperature: "" }),
    reading(date, { meanTemperature: undefined }),
    reading(date, { precipitationAmount: -1 }),
    {
      date,
      stationId: "108",
      minTemperature: 15,
      maxTemperature: 25,
      meanTemperature: 20,
    },
  ];
  for (const invalid of invalidReadings) {
    const module = evaluateObservation(input({ readings: [invalid] }));
    assert.equal(module.state, "HOLD");
    assert.equal(module.result, null);
  }

  const partial = evaluateObservation(
    input({
      readings: [
        reading(date, {
          minTemperature: null,
          maxTemperature: null,
          meanTemperature: null,
          precipitationAmount: null,
        }),
      ],
    }),
  );
  assert.equal(partial.state, "HOLD");
  assert.equal(partial.result.days[0].minTemperature, null);
});

test("temperature ordering and non-negative precipitation are contract boundaries", () => {
  const date = buildRecentCompletedDates(SEOUL_NOON)[0];
  for (const invalid of [
    reading(date, { minTemperature: 30, maxTemperature: 20 }),
    reading(date, { minTemperature: 15, meanTemperature: 10 }),
    reading(date, { maxTemperature: 25, meanTemperature: 30 }),
    reading(date, { precipitationAmount: -0.1 }),
  ]) {
    const validation = validateObservationInput(
      input({ readings: [invalid] }),
    );
    assert.equal(validation.valid, false);
  }
});

test("monthly normal deviation uses the same station and each day's own month across a boundary", () => {
  const now = "2026-08-04T03:00:00.000Z";
  const dates = buildRecentCompletedDates(now);
  assert.deepEqual(dates, [
    "2026-07-28",
    "2026-07-29",
    "2026-07-30",
    "2026-07-31",
    "2026-08-01",
    "2026-08-02",
    "2026-08-03",
  ]);
  const module = evaluateObservation(
    input({
      now,
      readings: dates.map((date) => reading(date, { meanTemperature: 20 })),
      monthlyNormals: [
        {
          stationId: "108",
          month: 7,
          meanTemperature: 15,
          normalPeriod: "1991-2020",
        },
        {
          stationId: "108",
          month: 8,
          meanTemperature: 18,
          normalPeriod: "1991-2020",
        },
      ],
    }),
  );
  assert.equal(module.state, "READY");
  assert.deepEqual(
    module.result.days.map((day) => day.monthlyNormalDeviation),
    [5, 5, 5, 5, 2, 2, 2],
  );
  assert.equal(module.result.comparisonBasis, "MONTHLY_NORMAL_1991_2020");
});

test("station-mismatched normals never produce a deviation", () => {
  const module = evaluateObservation(
    input({
      monthlyNormals: [
        {
          stationId: "119",
          month: 7,
          meanTemperature: -100,
          normalPeriod: "1991-2020",
        },
      ],
    }),
  );
  assert.equal(module.state, "READY");
  assert.ok(
    module.result.days.every(
      (day) => day.monthlyNormalDeviation === null,
    ),
  );
  assert.ok(module.qualityFlags.includes("MONTHLY_NORMAL_UNAVAILABLE"));
});

test("duplicate or unreviewed same-station normals are excluded without corrupting recent raw data", () => {
  const normals = [
    {
      stationId: "108",
      month: 7,
      meanTemperature: 15,
      normalPeriod: "1981-2010",
    },
    {
      stationId: "108",
      month: 7,
      meanTemperature: 16,
      normalPeriod: "1991-2020",
    },
  ];
  const module = evaluateObservation(input({ monthlyNormals: normals }));
  assert.equal(module.state, "READY");
  assert.ok(
    module.result.days.every(
      (day) => day.monthlyNormalDeviation === null,
    ),
  );
  assert.ok(
    module.qualityFlags.includes("MONTHLY_NORMAL_CONTRACT_INVALID"),
  );
});

test("observation output has no climate aggregate or suitability fields", () => {
  const module = evaluateObservation(input());
  const serialized = JSON.stringify(module);
  assert.equal(/aggregateDeviation|optimalRange|suitability|score/iu.test(serialized), false);
});
