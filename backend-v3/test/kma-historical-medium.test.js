import assert from "node:assert/strict";
import test from "node:test";

import {
  VERIFIED_KMA_HISTORICAL_MID_CONTRACT_VERSION,
  createKmaHistoricalMediumForecastAdapter,
  parseKmaHistoricalMediumTable,
} from "../src/adapters/index.js";

const TEMPERATURE = [
  "#START7777",
  "# REG_ID,TM_FC,TM_EF,MOD,MIN,MAX",
  "11B20201,2025080418,202508090000,A01,23,31",
  "#7777END",
].join("\n");
const LAND = [
  "#START7777",
  "# REG_ID,TM_FC,TM_EF,MOD,RN_ST",
  "11B00000,2025080418,202508090000,A02,40",
  "11B00000,2025080418,202508091200,A02,60",
  "#7777END",
].join("\n");

test("historical medium parser preserves issued time, date, temperature and POP", () => {
  const temperature = parseKmaHistoricalMediumTable(TEMPERATURE, {
    kind: "TEMPERATURE",
  });
  const land = parseKmaHistoricalMediumTable(LAND, { kind: "LAND" });
  assert.deepEqual(temperature[0], {
    regionId: "11B20201",
    issuedAt: "2025-08-04T09:00:00.000Z",
    validDate: "2025-08-09",
    validAt: "2025-08-08T15:00:00.000Z",
    periodMode: "A01",
    minTemperature: 23,
    maxTemperature: 31,
    precipitationProbability: null,
  });
  assert.equal(land.length, 2);
  assert.equal(land[1].precipitationProbability, 60);
});

test("historical medium adapter joins temperature and AM/PM land rows", async () => {
  const requested = [];
  const adapter = createKmaHistoricalMediumForecastAdapter({
    enabled: true,
    apiKey: "secret",
    contractVersion: VERIFIED_KMA_HISTORICAL_MID_CONTRACT_VERSION,
    fetchImpl: async (url) => {
      requested.push(new URL(url));
      return new Response(String(url).includes("fct_afs_wc") ? TEMPERATURE : LAND, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    },
  });
  const result = await adapter.getFiveDayForecast({
    baseDate: "20250804",
    baseTime: "1800",
    targetDate: "2025-08-09",
    regions: [
      {
        id: "incheon",
        temperatureRegId: "11B20201",
        landRegId: "11B00000",
      },
    ],
  });
  assert.equal(result.adapterState, "SUCCESS");
  assert.deepEqual(result.data.points[0], {
    id: "incheon",
    temperatureRegId: "11B20201",
    landRegId: "11B00000",
    minTemperature: 23,
    maxTemperature: 31,
    precipitationProbability: 60,
    precipitationPeriodCount: 2,
  });
  assert.equal(requested.length, 2);
  assert.ok(requested.every((url) => url.searchParams.get("authKey") === "secret"));
  assert.ok(requested.every((url) => url.searchParams.get("tmfc1") === "2025080418"));
});

test("historical medium permission failure stays unavailable", async () => {
  const adapter = createKmaHistoricalMediumForecastAdapter({
    enabled: true,
    apiKey: "secret",
    contractVersion: VERIFIED_KMA_HISTORICAL_MID_CONTRACT_VERSION,
    fetchImpl: async () =>
      new Response('{"result":{"status":403}}', {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
  });
  const result = await adapter.getFiveDayForecast({
    baseDate: "20250804",
    targetDate: "2025-08-09",
    regions: [
      { id: "a", temperatureRegId: "11B20201", landRegId: "11B00000" },
    ],
  });
  assert.equal(result.adapterState, "AUTH_ERROR");
  assert.equal(result.data, null);
});
