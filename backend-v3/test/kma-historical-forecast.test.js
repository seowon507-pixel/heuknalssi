import assert from "node:assert/strict";
import test from "node:test";

import {
  VERIFIED_KMA_HISTORICAL_SHORT_CONTRACT_VERSION,
  createKmaHistoricalShortForecastAdapter
} from "../src/adapters/index.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    async json() {
      return structuredClone(body);
    }
  };
}

function item(category, value, fcstDate, fcstTime = "0600") {
  return {
    baseDate: "20250719",
    baseTime: "1700",
    category,
    fcstDate,
    fcstTime,
    fcstValue: String(value),
    nx: 91,
    ny: 106
  };
}

const FIXTURE = {
  response: {
    header: { resultCode: "00", resultMsg: "NORMAL_SERVICE" },
    body: {
      totalCount: 6,
      items: {
        item: [
          item("TMN", 20, "20250720"),
          item("TMX", 31, "20250720", "1500"),
          item("POP", 60, "20250720", "1500"),
          item("TMN", 21, "20250721"),
          item("TMX", 32, "20250721", "1500"),
          item("POP", 30, "20250721", "1500")
        ]
      }
    }
  }
};

test("historical forecast adapter requests API Hub with authKey and preserves issue time", async () => {
  let requestedUrl;
  const adapter = createKmaHistoricalShortForecastAdapter({
    enabled: true,
    apiKey: "historical-fixture-key",
    contractVersion: VERIFIED_KMA_HISTORICAL_SHORT_CONTRACT_VERSION,
    cacheFreshForMs: 0,
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return jsonResponse(FIXTURE);
    },
    now: () => new Date("2026-08-03T00:00:00.000Z")
  });

  const result = await adapter.getIssuedForecast({
    nx: 91,
    ny: 106,
    baseDate: "20250719",
    baseTime: "1700"
  });

  assert.equal(result.adapterState, "SUCCESS");
  assert.equal(result.data.dataRole, "HISTORICAL_ISSUED_FORECAST");
  assert.equal(result.data.days.length, 2);
  assert.equal(result.issuedAt, "2025-07-19T08:00:00.000Z");
  assert.equal(requestedUrl.hostname, "apihub.kma.go.kr");
  assert.equal(requestedUrl.searchParams.get("authKey"), "historical-fixture-key");
  assert.equal(requestedUrl.searchParams.has("serviceKey"), false);
  assert.equal(result.sourceUrl.includes("historical-fixture-key"), false);
});

test("historical forecast adapter reports missing API Hub permission as AUTH_ERROR", async () => {
  const adapter = createKmaHistoricalShortForecastAdapter({
    enabled: true,
    apiKey: "unapproved-fixture-key",
    contractVersion: VERIFIED_KMA_HISTORICAL_SHORT_CONTRACT_VERSION,
    cacheFreshForMs: 0,
    fetchImpl: async () => jsonResponse({}, 403)
  });

  const result = await adapter.getIssuedForecast({
    nx: 91,
    ny: 106,
    baseDate: "20250719",
    baseTime: "1700"
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
      return jsonResponse(FIXTURE);
    }
  });

  const result = await adapter.getIssuedForecast({
    nx: 91,
    ny: 106,
    baseDate: "20250719",
    baseTime: "1700"
  });

  assert.equal(result.adapterState, "UNSUPPORTED");
  assert.equal(calls, 0);
});
