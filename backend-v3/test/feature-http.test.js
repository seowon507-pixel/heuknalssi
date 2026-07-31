import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createHttpHandler } from "../src/api/index.js";

const ORIGIN = "https://app.example.test";
const SECRET = "feature-http-test-secret-that-is-longer-than-32-bytes";

function coreServices() {
  return {
    async searchLocations() { return { candidates: [] }; },
    async createAnalysis() { return { analysisId: "unused" }; },
    async getAnalysis() { return null; },
    async requestReport() { return { state: "UNAVAILABLE" }; },
    async getPreflight() { return { state: "READY" }; },
  };
}

async function openServer(t, featureServices) {
  const server = createServer(createHttpHandler({
    services: coreServices(),
    featureServices,
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

function headers(sessionDetails, extra = {}) {
  return {
    Origin: ORIGIN,
    Cookie: sessionDetails.cookie,
    "Content-Type": "application/json",
    "X-CSRF-Token": sessionDetails.csrf,
    ...extra,
  };
}

test("행동·필지·위성 쓰기는 CSRF와 명시적 확인을 거쳐 계정 범위로 전달된다", async (t) => {
  const calls = [];
  const featureServices = {
    actionPlan: {
      async listActions(input) {
        calls.push(["list", input]);
        return { firstAction: null, today: [], upcoming: [] };
      },
      async createAction(input) {
        calls.push(["create", input]);
        return { created: true, action: { actionId: "action-1" } };
      },
      async updateActionStatus(input) {
        calls.push(["update", input]);
        return { actionId: input.actionId, status: input.status };
      },
    },
    satellite: {
      async getParcel(input) { calls.push(["parcel.get", input]); return null; },
      async putParcel(input) { calls.push(["parcel.put", input]); return { farmId: input.farmId }; },
      async getLatest(input) { calls.push(["satellite.get", input]); return null; },
      async refresh(input) { calls.push(["satellite.refresh", input]); return { state: "PARTIAL" }; },
    },
  };
  const baseUrl = await openServer(t, featureServices);
  const currentSession = await session(baseUrl);

  const listResponse = await fetch(`${baseUrl}/api/farms/farm-1/actions?cropId=crop-apple`, {
    headers: { Origin: ORIGIN, Cookie: currentSession.cookie },
  });
  assert.equal(listResponse.status, 200);

  const unconfirmedParcel = await fetch(`${baseUrl}/api/farms/farm-1/parcel`, {
    method: "PUT",
    headers: headers(currentSession),
    body: JSON.stringify({ geometry: { type: "Polygon", coordinates: [] } }),
  });
  assert.equal(unconfirmedParcel.status, 409);
  assert.equal((await unconfirmedParcel.json()).code, "CONFIRMATION_REQUIRED");

  const createResponse = await fetch(`${baseUrl}/api/farms/farm-1/actions`, {
    method: "POST",
    headers: headers(currentSession, { "Idempotency-Key": "feature-action-1" }),
    body: JSON.stringify({ confirmed: true, draft: { farmId: "farm-1" } }),
  });
  assert.equal(createResponse.status, 201);

  const refreshResponse = await fetch(`${baseUrl}/api/farms/farm-1/satellite/observations`, {
    method: "POST",
    headers: headers(currentSession),
    body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(refreshResponse.status, 200);

  assert.equal(calls[0][0], "list");
  assert.equal(calls[0][1].farmId, "farm-1");
  assert.equal(calls[0][1].cropId, "crop-apple");
  assert.equal(calls[1][0], "create");
  assert.equal(calls[1][1].confirmed, true);
  assert.equal(calls[2][0], "satellite.refresh");
  assert.match(calls[2][1].ownerSessionId, /^[A-Za-z0-9_-]+$/);
});
