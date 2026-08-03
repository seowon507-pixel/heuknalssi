import assert from "node:assert/strict";
import test from "node:test";

import {
  parseKmaAsosDaily,
  parseKmaClimateNormals,
  parseKmaShortForecast,
  selectKmaClimateNormals,
} from "../src/adapters/index.js";
import { estimateFieldConditions } from "../src/domain/index.js";

const DATES = [
  "2026-07-19",
  "2026-07-20",
  "2026-07-21",
  "2026-07-22",
  "2026-07-23",
  "2026-07-24",
  "2026-07-25",
];

function recentDays({ precipitationAmount = 0 } = {}) {
  return DATES.map((date, index) => ({
    date,
    minTemperature: 19 + index / 10,
    maxTemperature: 31 + index / 10,
    meanTemperature: 25 + index / 10,
    precipitationAmount,
    averageRelativeHumidity: 65,
    soilTemperature5cm: 23 + index / 10,
  }));
}

test("ASOS enrichment keeps official humidity, radiation, and soil-temperature values", () => {
  const payload = {
    response: {
      header: { resultCode: "00" },
      body: {
        totalCount: 1,
        items: {
          item: [
            {
              tm: DATES[0],
              stnId: "108",
              stnNm: "서울",
              minTa: "20",
              maxTa: "30",
              avgTa: "25",
              sumRn: "2.5",
              avgRhm: "68",
              minRhm: "42",
              sumSsHr: "7.3",
              sumGsr: "18.4",
              avgTs: "27.2",
              avgCm5Te: "24.8",
              avgWs: "2.1",
              sumLrgEv: "3.4",
            },
          ],
        },
      },
    },
  };
  const parsed = parseKmaAsosDaily(payload, {
    stationId: "108",
    expectedDates: DATES,
  });

  assert.deepEqual(parsed.readings[0], {
    date: DATES[0],
    stationId: "108",
    minTemperature: 20,
    maxTemperature: 30,
    meanTemperature: 25,
    precipitationAmount: 2.5,
    averageRelativeHumidity: 68,
    minimumRelativeHumidity: 42,
    sunshineDuration: 7.3,
    solarRadiation: 18.4,
    groundTemperature: 27.2,
    soilTemperature5cm: 24.8,
    meanWindSpeed: 2.1,
    evaporationAmount: 3.4,
  });
});

test("short forecast aggregates hourly REH without changing days that omit it", () => {
  const item = [
    ["TMN", "18", "0600"],
    ["TMX", "29", "1500"],
    ["REH", "80", "0600"],
    ["REH", "60", "1200"],
    ["REH", "70", "1800"],
  ].map(([category, fcstValue, fcstTime]) => ({
    baseDate: "20260723",
    baseTime: "0200",
    fcstDate: "20260723",
    fcstTime,
    category,
    fcstValue,
  }));
  const [day] = parseKmaShortForecast({
    response: {
      header: { resultCode: "00" },
      body: { items: { item } },
    },
  });

  assert.equal(day.minRelativeHumidity, 60);
  assert.equal(day.maxRelativeHumidity, 80);
  assert.equal(day.meanRelativeHumidity, 70);
});

test("live and bundled climate normals expose supplementary fields without changing score observations", () => {
  const apiText = [
    "# ST,STN,MM,DD,TA,TA_MAX,TA_MIN,RN,HM,SS,=",
    ...Array.from(
      { length: 12 },
      (_, index) =>
        `2021,108,${index + 1},0,${index},${index + 5},${index - 5},20,65,180,=`,
    ),
    "#7777END",
  ].join("\n");
  const live = parseKmaClimateNormals(apiText, { stationId: "108" });
  assert.equal(live.observations.length, 12);
  assert.equal(live.monthlyNormals[0].relativeHumidity, 65);
  assert.equal(live.monthlyNormals[0].precipitation, 20);
  assert.equal(live.monthlyNormals[0].sunshineDuration, 180);

  const bundled = selectKmaClimateNormals(
    {
      normalPeriod: "1991-2020",
      stations: {
        108: {
          metrics: {
            meanTemperature: Array.from({ length: 12 }, () => 12),
            relativeHumidity: Array.from({ length: 12 }, () => 66),
            groundSurfaceTemperature: Array.from({ length: 12 }, () => 14),
          },
        },
      },
    },
    { stationId: "108" },
  );
  assert.equal(bundled.observations.length, 12);
  assert.equal(bundled.monthlyNormals[0].relativeHumidity, 66);
  assert.equal(bundled.monthlyNormals[0].groundSurfaceTemperature, 14);
});

test("weather-balance estimate is deterministic, bounded, and never enters the growth score", () => {
  const dry = estimateFieldConditions({
    cultivationMode: "OPEN_FIELD",
    latitude: 37.5,
    recentDays: recentDays({ precipitationAmount: 0 }),
    forecastDays: [
      { minTemperature: 22, maxTemperature: 32 },
    ],
    observationDistanceKm: 4,
  });
  const wet = estimateFieldConditions({
    cultivationMode: "OPEN_FIELD",
    latitude: 37.5,
    recentDays: recentDays({ precipitationAmount: 10 }),
    observationDistanceKm: 4,
  });

  assert.equal(dry.state, "READY");
  assert.equal(dry.affectsGrowthScore, false);
  assert.equal(dry.measured, false);
  assert.equal(dry.soilTemperature.basis, "ASOS_5CM_SOIL_TEMPERATURE");
  assert.ok(dry.surfaceMoisture.central >= 0);
  assert.ok(dry.surfaceMoisture.central <= 100);
  assert.ok(dry.surfaceMoisture.lower <= dry.surfaceMoisture.central);
  assert.ok(dry.surfaceMoisture.central <= dry.surfaceMoisture.upper);
  assert.ok(wet.surfaceMoisture.central > dry.surfaceMoisture.central);
  assert.ok(dry.confidence.score <= dry.confidence.maximumPossible);
  assert.ok(dry.qualityFlags.includes("ESTIMATE_NOT_SENSOR_MEASUREMENT"));
  assert.ok(dry.qualityFlags.includes("IRRIGATION_NOT_INCLUDED"));
});

test("a farther observation station cannot increase estimate confidence", () => {
  const near = estimateFieldConditions({
    cultivationMode: "OPEN_FIELD",
    latitude: 37.5,
    recentDays: recentDays(),
    observationDistanceKm: 2,
  });
  const far = estimateFieldConditions({
    cultivationMode: "OPEN_FIELD",
    latitude: 37.5,
    recentDays: recentDays(),
    observationDistanceKm: 30,
  });

  assert.ok(far.confidence.score < near.confidence.score);
  const nearRange =
    near.surfaceMoisture.upper - near.surfaceMoisture.lower;
  const farRange = far.surfaceMoisture.upper - far.surfaceMoisture.lower;
  assert.ok(farRange > nearRange);
});

test("facility root-zone conditions are not guessed from outdoor weather", () => {
  const result = estimateFieldConditions({
    cultivationMode: "FACILITY_SOIL",
    latitude: 37.5,
    recentDays: recentDays(),
  });

  assert.equal(result.state, "NOT_APPLICABLE");
  assert.equal(result.surfaceMoisture, null);
  assert.deepEqual(result.blockingReasons, [
    "OUTDOOR_WEATHER_CANNOT_ESTIMATE_FACILITY_ROOT_ZONE",
  ]);
});
