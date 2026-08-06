import assert from "node:assert/strict";
import test from "node:test";

import {
  KMA_GRID_CELL_COUNT,
  KMA_GRID_WIDTH,
  VERIFIED_KMA_HISTORICAL_SHORT_CONTRACT_VERSION,
  createKmaHistoricalShortForecastAdapter,
  parseKmaHistoricalGrid
} from "../src/adapters/index.js";

function textResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    async text() {
      return body;
    }
  };
}

function fixtureGrid(entries = []) {
  const values = Array(KMA_GRID_CELL_COUNT).fill(-99);
  for (const { nx, ny, value } of entries) {
    values[(ny - 1) * KMA_GRID_WIDTH + (nx - 1)] = value;
  }
  return values.join(",");
}

test("historical grid parser enforces the official 149 by 253 cell contract", () => {
  const parsed = parseKmaHistoricalGrid(
    fixtureGrid([{ nx: 91, ny: 106, value: 31 }])
  );
  assert.equal(parsed.length, KMA_GRID_CELL_COUNT);
  assert.equal(parsed[(106 - 1) * KMA_GRID_WIDTH + (91 - 1)], 31);
  assert.equal(parsed[0], null);
  assert.throws(
    () => parseKmaHistoricalGrid("1,2,3"),
    /expected 37697 cells/
  );
});

test("historical forecast adapter requests the archived grid and extracts every reviewed point", async () => {
  let requestedUrl;
  const adapter = createKmaHistoricalShortForecastAdapter({
    enabled: true,
    apiKey: "historical-fixture-key",
    contractVersion: VERIFIED_KMA_HISTORICAL_SHORT_CONTRACT_VERSION,
    cacheFreshForMs: 0,
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return textResponse(
        fixtureGrid([
          { nx: 91, ny: 106, value: 31 },
          { nx: 55, ny: 127, value: 29 }
        ])
      );
    },
    now: () => new Date("2026-08-03T00:00:00.000Z")
  });

  const result = await adapter.getGridSnapshot({
    baseDate: "20250719",
    baseTime: "1700",
    validDate: "20250720",
    validTime: "1500",
    variable: "TMX",
    points: [
      { id: "andong", nx: 91, ny: 106 },
      { id: "seoul", nx: 55, ny: 127 }
    ]
  });

  assert.equal(result.adapterState, "SUCCESS");
  assert.equal(
    result.data.dataRole,
    "HISTORICAL_ISSUED_FORECAST_GRID_SNAPSHOT"
  );
  assert.deepEqual(
    result.data.points.map(({ id, value }) => ({ id, value })),
    [
      { id: "andong", value: 31 },
      { id: "seoul", value: 29 }
    ]
  );
  assert.equal(result.issuedAt, "2025-07-19T08:00:00.000Z");
  assert.equal(result.validFrom, "2025-07-20T06:00:00.000Z");
  assert.equal(requestedUrl.hostname, "apihub.kma.go.kr");
  assert.equal(requestedUrl.searchParams.get("tmfc"), "2025071917");
  assert.equal(requestedUrl.searchParams.get("tmef"), "2025072015");
  assert.equal(requestedUrl.searchParams.get("vars"), "TMX");
  assert.equal(requestedUrl.searchParams.get("authKey"), "historical-fixture-key");
  assert.equal(result.sourceUrl.includes("historical-fixture-key"), false);
});

test("historical forecast adapter reports missing grid permission as AUTH_ERROR", async () => {
  const adapter = createKmaHistoricalShortForecastAdapter({
    enabled: true,
    apiKey: "unapproved-fixture-key",
    contractVersion: VERIFIED_KMA_HISTORICAL_SHORT_CONTRACT_VERSION,
    cacheFreshForMs: 0,
    fetchImpl: async () => textResponse("", 403)
  });

  const result = await adapter.getGridSnapshot({
    baseDate: "20250719",
    baseTime: "1700",
    validDate: "20250720",
    validTime: "1500",
    variable: "TMX",
    points: [{ id: "andong", nx: 91, ny: 106 }]
  });

  assert.equal(result.adapterState, "AUTH_ERROR");
  assert.deepEqual(result.qualityFlags, ["PROVIDER_AUTH_ERROR"]);
  assert.equal(result.data, null);
});

test("historical forecast capability stays disabled without an approved key", async () => {
  let calls = 0;
  const adapter = createKmaHistoricalShortForecastAdapter({
    enabled: false,
    contractVersion: VERIFIED_KMA_HISTORICAL_SHORT_CONTRACT_VERSION,
    fetchImpl: async () => {
      calls += 1;
      return textResponse(fixtureGrid());
    }
  });

  const result = await adapter.getGridSnapshot({
    baseDate: "20250719",
    baseTime: "1700",
    validDate: "20250720",
    validTime: "1500",
    variable: "TMX",
    points: [{ id: "andong", nx: 91, ny: 106 }]
  });

  assert.equal(result.adapterState, "UNSUPPORTED");
  assert.equal(calls, 0);
});
