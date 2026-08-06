import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createHttpHandler } from "../src/api/index.js";

const ORIGIN = "https://app.example.test";
const SECRET = "harvest-weather-http-secret-longer-than-32-bytes";

function coreServices() {
  return {
    async searchLocations() { return { candidates: [] }; },
    async createAnalysis() { return { analysisId: "unused" }; },
    async getAnalysis() { return null; },
    async requestReport() { return { state: "UNAVAILABLE" }; },
    async getPreflight() { return { state: "READY" }; },
  };
}

async function openServer(t, harvestWeather) {
  const server = createServer(createHttpHandler({
    services: coreServices(),
    featureServices: { harvestWeather },
    config: {
      allowedOrigins: [ORIGIN],
      logger: { info() {}, error() {} },
      sessionSecret: SECRET,
    },
  }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function session(baseUrl) {
  const response = await fetch(`${baseUrl}/api/session`, { headers: { Origin: ORIGIN } });
  return {
    cookie: response.headers.get("set-cookie").split(";", 1)[0],
  };
}

test("GET 수확 누적날씨는 세션·농장·작물·시즌·분석 범위를 전달한다", async (t) => {
  let received;
  const baseUrl = await openServer(t, {
    async getSeasonWeather(input) {
      received = input;
      return { state: "READY", adjustmentDays: -2 };
    },
  });
  const currentSession = await session(baseUrl);
  const response = await fetch(
    `${baseUrl}/api/farms/farm-1/crops/CUCUMBER/harvest-weather?seasonId=season-1&analysisId=analysis-1`,
    { headers: { Origin: ORIGIN, Cookie: currentSession.cookie } },
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).seasonWeather.adjustmentDays, -2);
  assert.equal(received.farmId, "farm-1");
  assert.equal(received.cropId, "CUCUMBER");
  assert.equal(received.seasonId, "season-1");
  assert.equal(received.analysisId, "analysis-1");
  assert.equal(typeof received.ownerSessionId, "string");
});

test("수확 누적날씨는 analysisId와 seasonId를 모두 요구한다", async (t) => {
  const baseUrl = await openServer(t, {
    async getSeasonWeather() { return { state: "READY" }; },
  });
  const currentSession = await session(baseUrl);
  const response = await fetch(
    `${baseUrl}/api/farms/farm-1/crops/APPLE/harvest-weather?seasonId=season-1`,
    { headers: { Origin: ORIGIN, Cookie: currentSession.cookie } },
  );
  assert.equal(response.status, 400);
});
