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
      async reconcileRuleActions(input) {
        calls.push(["reconcile", input]);
        return { cancelled: [] };
      },
      async updateActionStatus(input) {
        calls.push(["update", input]);
        return { actionId: input.actionId, status: input.status };
      },
      async snoozeAction(input) {
        calls.push(["snooze", input]);
        return {
          actionId: input.actionId,
          status: "OPEN",
          snoozedUntil: input.snoozedUntil,
        };
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

  const reconcileResponse = await fetch(
    `${baseUrl}/api/farms/farm-1/actions/rules/reconcile`,
    {
      method: "POST",
      headers: headers(currentSession, { "Idempotency-Key": "feature-reconcile-1" }),
      body: JSON.stringify({
        cropId: "crop-apple",
        seasonId: "season-1",
        activeRuleIds: ["apple.heat.v1"],
        projection: "SYSTEM_RULE",
      }),
    },
  );
  assert.equal(reconcileResponse.status, 200);

  const snoozeResponse = await fetch(
    `${baseUrl}/api/farms/farm-1/actions/action-1`,
    {
      method: "PATCH",
      headers: headers(currentSession, { "Idempotency-Key": "feature-snooze-1" }),
      body: JSON.stringify({
        confirmed: true,
        snoozedUntil: "2026-08-03T22:00:00.000Z",
      }),
    },
  );
  assert.equal(snoozeResponse.status, 200);

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
  assert.equal(calls[2][0], "reconcile");
  assert.deepEqual(calls[2][1].activeRuleIds, ["apple.heat.v1"]);
  assert.equal(calls[2][1].projection, "SYSTEM_RULE");
  assert.equal(calls[3][0], "snooze");
  assert.equal(calls[3][1].confirmed, true);
  assert.equal(calls[3][1].snoozedUntil, "2026-08-03T22:00:00.000Z");
  assert.equal(calls[4][0], "satellite.refresh");
  assert.match(calls[4][1].ownerSessionId, /^[A-Za-z0-9_-]+$/);
});

test("병해충 가이드는 현재 세션과 분석 ID 범위로만 조회한다", async (t) => {
  const calls = [];
  const baseUrl = await openServer(t, {
    pestGuidance: {
      async getGuidance(input) {
        calls.push(input);
        return {
          analysisId: input.analysisId,
          crop: "APPLE",
          diagnosisState: "NOT_PERFORMED",
          observations: [],
        };
      },
    },
  });
  const currentSession = await session(baseUrl);
  const response = await fetch(
    `${baseUrl}/api/analyses/analysis-apple/pest-guidance`,
    { headers: { Origin: ORIGIN, Cookie: currentSession.cookie } },
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).diagnosisState, "NOT_PERFORMED");
  assert.equal(calls[0].analysisId, "analysis-apple");
  assert.match(calls[0].ownerSessionId, /^[A-Za-z0-9_-]+$/);
});

test("사진 업로드·기록·비교·삭제·시즌 회고는 세션 소유 범위로 전달된다", async (t) => {
  const calls = [];
  const featureServices = {
    photoSeason: {
      async prepareUpload(input) {
        calls.push(["upload", input]);
        return { uploadToken: "upload-token", mimeType: input.mimeType, size: 3 };
      },
      async addPhoto(input) {
        calls.push(["add", input]);
        return { photoId: "photo-1", farmId: input.farmId };
      },
      async comparePhotos(input) {
        calls.push(["compare", input]);
        return { comparisonId: "comparison-1" };
      },
      async deletePhoto(input) {
        calls.push(["delete", input]);
        return { photoId: input.photoId, deletedAt: "2026-08-03T00:00:00.000Z" };
      },
      async getSeasonTimeline(input) {
        calls.push(["timeline", input]);
        return { seasonId: input.seasonId, photoTimeline: [] };
      },
      async completeSeason(input) {
        calls.push(["complete", input]);
        return { seasonId: input.seasonId, status: "COMPLETED" };
      },
    },
  };
  const baseUrl = await openServer(t, featureServices);
  const currentSession = await session(baseUrl);

  const upload = await fetch(`${baseUrl}/api/farms/farm-1/photo-uploads`, {
    method: "POST",
    headers: headers(currentSession),
    body: JSON.stringify({
      cropId: "APPLE",
      seasonId: "season-1",
      mimeType: "image/jpeg",
      dataBase64: "YWJj",
    }),
  });
  assert.equal(upload.status, 201);

  const add = await fetch(`${baseUrl}/api/farms/farm-1/photos`, {
    method: "POST",
    headers: headers(currentSession),
    body: JSON.stringify({
      cropId: "APPLE",
      seasonId: "season-1",
      uploadToken: "upload-token",
      observedAt: "2026-08-03T00:00:00.000Z",
      consentState: "GRANTED",
    }),
  });
  assert.equal(add.status, 201);

  const timeline = await fetch(
    `${baseUrl}/api/farms/farm-1/seasons/season-1/timeline?cropId=APPLE`,
    { headers: { Origin: ORIGIN, Cookie: currentSession.cookie } },
  );
  assert.equal(timeline.status, 200);

  const compare = await fetch(`${baseUrl}/api/farms/farm-1/photos/compare`, {
    method: "POST",
    headers: headers(currentSession),
    body: JSON.stringify({
      cropId: "APPLE",
      seasonId: "season-1",
      baselinePhotoId: "photo-1",
      currentPhotoId: "photo-2",
      observations: [{ aspect: "COLOR", change: "DARKER" }],
    }),
  });
  assert.equal(compare.status, 201);

  const remove = await fetch(`${baseUrl}/api/farms/farm-1/photos/photo-1`, {
    method: "DELETE",
    headers: headers(currentSession),
    body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(remove.status, 200);

  const complete = await fetch(
    `${baseUrl}/api/farms/farm-1/seasons/season-1/complete`,
    {
      method: "POST",
      headers: headers(currentSession),
      body: JSON.stringify({ cropId: "APPLE", confirmed: true }),
    },
  );
  assert.equal(complete.status, 200);

  assert.deepEqual(calls.map(([name]) => name), [
    "upload",
    "add",
    "timeline",
    "compare",
    "delete",
    "complete",
  ]);
  const ownerIds = new Set(calls.map(([, input]) => input.ownerSessionId));
  assert.equal(ownerIds.size, 1);
  assert.match([...ownerIds][0], /^[A-Za-z0-9_-]+$/u);
  assert.equal(calls[4][1].confirmed, true);
  assert.equal(calls[5][1].confirmed, true);
});

test("리포트 저장·목록·내보내기는 같은 세션의 농장 범위로 제한된다", async (t) => {
  const calls = [];
  const featureServices = {
    reportHistory: {
      async saveReport(input) {
        calls.push(["save", input]);
        return { reportId: input.analysisId, score: 82 };
      },
      async listReports(input) {
        calls.push(["list", input]);
        return [{ reportId: "analysis-1", score: 82 }];
      },
      async getReport(input) {
        calls.push(["get", input]);
        return { reportId: input.reportId, schemaVersion: 1 };
      },
    },
  };
  const baseUrl = await openServer(t, featureServices);
  const currentSession = await session(baseUrl);

  const save = await fetch(`${baseUrl}/api/farms/farm-1/reports`, {
    method: "POST",
    headers: headers(currentSession),
    body: JSON.stringify({
      analysisId: "analysis-1",
      cropId: "crop-apple",
      seasonId: "season-2026-apple",
    }),
  });
  assert.equal(save.status, 201);

  const list = await fetch(
    `${baseUrl}/api/farms/farm-1/reports?cropId=crop-apple`,
    { headers: { Origin: ORIGIN, Cookie: currentSession.cookie } },
  );
  assert.equal(list.status, 200);
  assert.equal((await list.json()).reports.length, 1);

  const exported = await fetch(
    `${baseUrl}/api/farms/farm-1/reports/analysis-1`,
    { headers: { Origin: ORIGIN, Cookie: currentSession.cookie } },
  );
  assert.equal(exported.status, 200);

  assert.deepEqual(calls.map(([name]) => name), ["save", "list", "get"]);
  const owners = new Set(calls.map(([, input]) => input.ownerSessionId));
  assert.equal(owners.size, 1);
  assert.equal(calls[1][1].cropId, "crop-apple");
});
