import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createHttpHandler } from "../src/api/index.js";
import { createCropCycleService } from "../src/application/index.js";
import {
  TtlMemoryStore,
  createCropCycleRepository,
} from "../src/infrastructure/index.js";

const ORIGIN = "https://app.example.test";
const SECRET = "crop-cycle-http-secret-that-is-longer-than-32-bytes";

function coreServices() {
  return {
    async searchLocations() { return { candidates: [] }; },
    async createAnalysis() { return { analysisId: "unused" }; },
    async getAnalysis() { return null; },
    async requestReport() { return { state: "UNAVAILABLE" }; },
    async getPreflight() { return { state: "READY" }; },
  };
}

async function openServer(t, cropCycle) {
  const server = createServer(createHttpHandler({
    services: coreServices(),
    featureServices: { cropCycle },
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
  const body = await response.json();
  return {
    csrf: body.csrfToken,
    cookie: response.headers.get("set-cookie").split(";", 1)[0],
  };
}

function headers(sessionDetails) {
  return {
    Origin: ORIGIN,
    Cookie: sessionDetails.cookie,
    "Content-Type": "application/json",
    "X-CSRF-Token": sessionDetails.csrf,
  };
}

test("GET/PUT crop-cycle routes preserve farm, crop, season, and session scope", async (t) => {
  const calls = [];
  const cropCycle = {
    async getCycle(input) { calls.push(["get", input]); return { status: "PLANNING" }; },
    async putCycle(input) { calls.push(["put", input]); return { ...input, status: input.status }; },
  };
  const baseUrl = await openServer(t, cropCycle);
  const currentSession = await session(baseUrl);
  const path = `${baseUrl}/api/farms/farm-1/crops/APPLE/cycle`;

  const saved = await fetch(path, {
    method: "PUT",
    headers: headers(currentSession),
    body: JSON.stringify({
      seasonId: "season-1",
      anchorType: "FLOWERING",
      anchorDate: "2026-04-10",
      status: "ACTIVE",
      userConfirmed: true,
    }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).cycle.status, "ACTIVE");

  const got = await fetch(`${path}?seasonId=season-1`, {
    headers: { Origin: ORIGIN, Cookie: currentSession.cookie },
  });
  assert.equal(got.status, 200);
  assert.equal((await got.json()).cycle.status, "PLANNING");

  assert.deepEqual(calls.map(([name]) => name), ["put", "get"]);
  for (const [, input] of calls) {
    assert.equal(input.farmId, "farm-1");
    assert.equal(input.cropId, "APPLE");
    assert.equal(input.seasonId, "season-1");
    assert.equal(typeof input.ownerSessionId, "string");
  }
  assert.equal(calls[0][1].anchorType, "FLOWERING");
  assert.equal(calls[0][1].userConfirmed, true);
});

test("GET requires one seasonId and missing cycles return 404", async (t) => {
  const cropCycle = {
    async getCycle() { return null; },
    async putCycle(input) { return input; },
  };
  const baseUrl = await openServer(t, cropCycle);
  const currentSession = await session(baseUrl);
  const path = `${baseUrl}/api/farms/farm-1/crops/APPLE/cycle`;

  const missingQuery = await fetch(path, {
    headers: { Origin: ORIGIN, Cookie: currentSession.cookie },
  });
  assert.equal(missingQuery.status, 400);

  const missingCycle = await fetch(`${path}?seasonId=season-1`, {
    headers: { Origin: ORIGIN, Cookie: currentSession.cookie },
  });
  assert.equal(missingCycle.status, 404);
});

test("HTTP projection rejects unknown crops and invalid crop-anchor pairs", async (t) => {
  const cropCycle = createCropCycleService({
    repository: createCropCycleRepository({
      store: new TtlMemoryStore({ capacityPolicy: "reject" }),
    }),
    clock: { now: () => new Date("2026-05-20T03:00:00.000Z") },
  });
  const baseUrl = await openServer(t, cropCycle);
  const currentSession = await session(baseUrl);
  const body = {
    seasonId: "season-1",
    anchorType: "SOWING",
    anchorDate: "2026-03-10",
    status: "ACTIVE",
    userConfirmed: true,
  };

  const potato = await fetch(
    `${baseUrl}/api/farms/farm-1/crops/POTATO/cycle`,
    { method: "PUT", headers: headers(currentSession), body: JSON.stringify(body) },
  );
  assert.equal(potato.status, 200);
  const projection = (await potato.json()).cycle;
  assert.equal(projection.status, "HARVEST_WINDOW");
  assert.deepEqual(projection.harvestWindow, {
    earliest: "2026-05-19",
    latest: "2026-07-28",
  });

  const unknownCrop = await fetch(
    `${baseUrl}/api/farms/farm-1/crops/TOMATO/cycle`,
    { method: "PUT", headers: headers(currentSession), body: JSON.stringify(body) },
  );
  assert.equal(unknownCrop.status, 400);

  const invalidAnchor = await fetch(
    `${baseUrl}/api/farms/farm-1/crops/APPLE/cycle`,
    { method: "PUT", headers: headers(currentSession), body: JSON.stringify(body) },
  );
  assert.equal(invalidAnchor.status, 400);
});
