import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createHttpHandler } from "../src/api/index.js";

const ALLOWED_ORIGIN = "https://app.example.test";
const SESSION_SECRET = "test-only-session-secret-that-is-longer-than-32-bytes";

function makeRandomBytes() {
  let counter = 0;
  return (size) => {
    counter += 1;
    const bytes = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1) {
      bytes[index] = (counter + index) % 256;
    }
    return bytes;
  };
}

function setCookieValue(response) {
  const values =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")];
  return values[0]?.split(";", 1)[0];
}

async function openServer(
  t,
  {
    services,
    config = {},
    clock = Date.now,
    randomBytes = makeRandomBytes(),
  },
) {
  const handler = createHttpHandler({
    services,
    clock,
    randomBytes,
    config: {
      allowedOrigins: [ALLOWED_ORIGIN],
      logger: { info() {}, error() {} },
      sessionSecret: SESSION_SECRET,
      ...config,
    },
  });
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
  };
}

async function startSession(baseUrl, headers = {}) {
  const response = await fetch(`${baseUrl}/api/session`, {
    headers: {
      Origin: ALLOWED_ORIGIN,
      ...headers,
    },
  });
  assert.equal(response.status, 200);
  return {
    cookie: setCookieValue(response),
    response,
    session: await response.json(),
  };
}

function notFoundError() {
  const error = new Error("not found or belongs to another owner");
  error.code = "ANALYSIS_NOT_FOUND";
  return error;
}

function makeFlowServices() {
  let candidateSequence = 0;
  const candidates = new Map();
  const analyses = new Map();
  const calls = {
    search: [],
    current: [],
    create: [],
    get: [],
    report: [],
    assistant: [],
    preflight: [],
  };

  return {
    calls,
    candidates,
    analyses,

    async searchLocations(input) {
      calls.search.push(input);
      candidateSequence += 1;
      const candidateToken = `candidate_${String(candidateSequence).padStart(16, "0")}`;
      candidates.set(candidateToken, {
        ownerSessionId: input.ownerSessionId,
        regionLabel: input.query,
      });
      return {
        candidates: [
          {
            candidateToken,
            displayName: input.query,
            resolutionMode: "ADDRESS_RESOLVED",
            expiresAt: "2026-07-23T01:10:00.000Z",
          },
        ],
      };
    },

    async resolveCurrentLocation(input) {
      calls.current.push(input);
      candidateSequence += 1;
      const candidateToken = `candidate_${String(candidateSequence).padStart(16, "0")}`;
      candidates.set(candidateToken, {
        ownerSessionId: input.ownerSessionId,
        regionLabel: "경기도 수원시 영통구 원천동",
      });
      return {
        candidates: [
          {
            candidateToken,
            displayName: "경기도 수원시 영통구 원천동",
            resolutionMode: "ADDRESS_RESOLVED",
            expiresAt: "2026-07-23T01:10:00.000Z",
          },
        ],
      };
    },

    async createAnalysis(input) {
      calls.create.push(input);
      const candidate = candidates.get(input.input.candidateToken);
      if (!candidate || candidate.ownerSessionId !== input.ownerSessionId) {
        const error = new Error("candidate is missing or owned elsewhere");
        error.code = "LOCATION_TOKEN_INVALID";
        throw error;
      }
      const result = {
        analysisId: input.analysisId,
        createdAt: "2026-07-23T01:00:00.000Z",
        inputSummary: {
          crop: input.input.crop,
          regionLabel: candidate.regionLabel,
        },
        state: "PARTIAL",
        report: {
          state: "NOT_REQUESTED",
          value: null,
        },
        dataSources: [],
      };
      analyses.set(input.analysisId, {
        ownerSessionId: input.ownerSessionId,
        result,
      });
      return structuredClone(result);
    },

    async getAnalysis(input) {
      calls.get.push(input);
      const record = analyses.get(input.analysisId);
      if (!record || record.ownerSessionId !== input.ownerSessionId) {
        return null;
      }
      if (record.result.report.state === "PENDING") {
        record.result.report = {
          state: "READY",
          value: { summary: "검증된 템플릿 보고서" },
        };
      }
      return structuredClone(record.result);
    },

    async requestReport(input) {
      calls.report.push(input);
      const record = analyses.get(input.analysisId);
      if (!record || record.ownerSessionId !== input.ownerSessionId) {
        throw notFoundError();
      }
      if (
        record.result.report.state === "READY" ||
        record.result.report.state === "FALLBACK"
      ) {
        return {
          analysis: structuredClone(record.result),
          started: false,
        };
      }
      record.result.report = { state: "PENDING", value: null };
      return {
        analysis: structuredClone(record.result),
        started: true,
      };
    },

    async answerAnalysisQuestion(input) {
      calls.assistant.push(input);
      const record = analyses.get(input.analysisId);
      if (!record || record.ownerSessionId !== input.ownerSessionId) {
        return null;
      }
      return {
        mode: "FALLBACK",
        grounded: true,
        answer: "확인된 내용\n현재 분석 근거만 설명합니다.",
        itemIds: ["ITEM_1"],
      };
    },

    async getPreflight(input) {
      calls.preflight.push(input);
      return {
        status: "READY",
        capabilities: {
          persistence: "NOT_AVAILABLE",
          satellite: "UNSUPPORTED",
        },
        contracts: {
          weather: "DISABLED_UNTIL_VERIFIED",
        },
      };
    },
  };
}

test("ephemeral HTTP server supports the complete owner-bound API flow", async (t) => {
  const services = makeFlowServices();
  const logEntries = [];
  const { baseUrl } = await openServer(t, {
    services,
    config: {
      logger: {
        info(entry) {
          logEntries.push(entry);
        },
        error(entry) {
          logEntries.push(entry);
        },
      },
    },
  });

  const started = await startSession(baseUrl);
  assert.match(
    started.response.headers.get("set-cookie"),
    /HttpOnly; SameSite=Lax/,
  );
  assert.doesNotMatch(started.response.headers.get("set-cookie"), /Secure/);
  assert.equal(
    started.response.headers.get("access-control-allow-origin"),
    ALLOWED_ORIGIN,
  );
  assert.equal(
    started.response.headers.get("x-content-type-options"),
    "nosniff",
  );
  assert.equal(started.response.headers.get("cache-control"), "no-store");
  assert.match(started.session.csrfToken, /^[A-Za-z0-9_-]+$/);
  assert.ok(Date.parse(started.session.expiresAt));

  const currentLocationResponse = await fetch(
    `${baseUrl}/api/locations/current`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: started.cookie,
        Origin: ALLOWED_ORIGIN,
        "X-CSRF-Token": started.session.csrfToken,
      },
      body: JSON.stringify({ latitude: 37.285, longitude: 127.045 }),
    },
  );
  assert.equal(currentLocationResponse.status, 200);
  const currentLocationBody = await currentLocationResponse.json();
  assert.equal(currentLocationBody.candidates.length, 1);
  assert.equal("latitude" in currentLocationBody.candidates[0], false);
  assert.equal("longitude" in currentLocationBody.candidates[0], false);

  const locationResponse = await fetch(
    `${baseUrl}/api/locations?q=${encodeURIComponent("FULL_ADDRESS_SENTINEL")}`,
    {
      headers: {
        Cookie: started.cookie,
        Origin: ALLOWED_ORIGIN,
      },
    },
  );
  assert.equal(locationResponse.status, 200);
  const locationBody = await locationResponse.json();
  assert.equal(locationBody.candidates.length, 1);
  assert.equal("latitude" in locationBody.candidates[0], false);
  const candidateToken = locationBody.candidates[0].candidateToken;

  const analysisInput = {
    candidateToken,
    crop: "STRAWBERRY",
    cultivationMode: "GREENHOUSE",
    exactCoordinateThatMustNotBeLogged: "SENSITIVE_COORDINATE_SENTINEL",
  };
  const createResponse = await fetch(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: started.cookie,
      "Idempotency-Key": "flow-001",
      Origin: ALLOWED_ORIGIN,
      "X-CSRF-Token": started.session.csrfToken,
    },
    body: JSON.stringify(analysisInput),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.match(created.analysisId, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(
    createResponse.headers.get("location"),
    `/api/analyses/${created.analysisId}`,
  );
  assert.equal(
    JSON.stringify(created).includes("SENSITIVE_COORDINATE_SENTINEL"),
    false,
  );

  const getResponse = await fetch(
    `${baseUrl}${createResponse.headers.get("location")}`,
    {
      headers: {
        Cookie: started.cookie,
        Origin: ALLOWED_ORIGIN,
      },
    },
  );
  assert.equal(getResponse.status, 200);
  assert.equal((await getResponse.json()).analysisId, created.analysisId);

  const assistantResponse = await fetch(
    `${baseUrl}/api/analyses/${created.analysisId}/assistant`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: started.cookie,
        Origin: ALLOWED_ORIGIN,
        "X-CSRF-Token": started.session.csrfToken,
      },
      body: JSON.stringify({ question: "오늘 무엇을 해야 하나요?" }),
    },
  );
  assert.equal(assistantResponse.status, 200);
  const assistantBody = await assistantResponse.json();
  assert.equal(assistantBody.grounded, true);
  assert.equal(assistantBody.mode, "FALLBACK");
  assert.doesNotMatch(assistantBody.answer, /FULL_ADDRESS_SENTINEL/);

  const reportResponse = await fetch(
    `${baseUrl}/api/analyses/${created.analysisId}/report`,
    {
      method: "POST",
      headers: {
        Cookie: started.cookie,
        Origin: ALLOWED_ORIGIN,
        "X-CSRF-Token": started.session.csrfToken,
      },
    },
  );
  assert.equal(reportResponse.status, 202);
  assert.equal((await reportResponse.json()).report.state, "PENDING");

  const completedResponse = await fetch(
    `${baseUrl}/api/analyses/${created.analysisId}`,
    {
      headers: {
        Cookie: started.cookie,
        Origin: ALLOWED_ORIGIN,
      },
    },
  );
  assert.equal(completedResponse.status, 200);
  assert.equal((await completedResponse.json()).report.state, "READY");

  const preflightResponse = await fetch(
    `${baseUrl}/api/health/preflight`,
    {
      headers: {
        Cookie: started.cookie,
        Origin: ALLOWED_ORIGIN,
      },
    },
  );
  assert.equal(preflightResponse.status, 200);
  const preflight = await preflightResponse.json();
  assert.equal(preflight.capabilities.persistence, "NOT_AVAILABLE");
  assert.equal(/secret|token|https?:\/\//i.test(JSON.stringify(preflight)), false);

  const ownerIds = [
    services.calls.current[0].ownerSessionId,
    services.calls.search[0].ownerSessionId,
    services.calls.create[0].ownerSessionId,
    services.calls.get[0].ownerSessionId,
    services.calls.report[0].ownerSessionId,
    services.calls.assistant[0].ownerSessionId,
  ];
  assert.equal(new Set(ownerIds).size, 1);
  assert.ok(services.calls.create[0].signal instanceof AbortSignal);
  assert.equal(services.calls.create[0].requestId.length, 22);

  await new Promise((resolve) => setImmediate(resolve));
  const serializedLogs = JSON.stringify(logEntries);
  assert.equal(serializedLogs.includes("FULL_ADDRESS_SENTINEL"), false);
  assert.equal(
    serializedLogs.includes("SENSITIVE_COORDINATE_SENTINEL"),
    false,
  );
  assert.equal(serializedLogs.includes(candidateToken), false);
  assert.equal(serializedLogs.includes(started.session.csrfToken), false);
  assert.deepEqual(
    Object.keys(logEntries.at(-1)).sort(),
    ["durationMs", "method", "requestId", "route", "statusCode"].sort(),
  );
});

test("same-owner lookup succeeds while another owner and arbitrary IDs share one 404 contract", async (t) => {
  const services = makeFlowServices();
  const { baseUrl } = await openServer(t, { services });
  const ownerA = await startSession(baseUrl);
  const ownerB = await startSession(baseUrl);

  const location = await fetch(`${baseUrl}/api/locations?q=수원`, {
    headers: { Cookie: ownerA.cookie },
  }).then((response) => response.json());
  const foreignCandidate = await fetch(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: ownerB.cookie,
      Origin: ALLOWED_ORIGIN,
      "X-CSRF-Token": ownerB.session.csrfToken,
    },
    body: JSON.stringify({
      candidateToken: location.candidates[0].candidateToken,
      crop: "TOMATO",
    }),
  });
  assert.equal(foreignCandidate.status, 400);
  assert.equal(
    (await foreignCandidate.json()).code,
    "LOCATION_TOKEN_INVALID",
  );

  const createResponse = await fetch(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: ownerA.cookie,
      Origin: ALLOWED_ORIGIN,
      "X-CSRF-Token": ownerA.session.csrfToken,
    },
    body: JSON.stringify({
      candidateToken: location.candidates[0].candidateToken,
      crop: "TOMATO",
    }),
  });
  const created = await createResponse.json();

  const owned = await fetch(
    `${baseUrl}/api/analyses/${created.analysisId}`,
    { headers: { Cookie: ownerA.cookie } },
  );
  assert.equal(owned.status, 200);

  const foreign = await fetch(
    `${baseUrl}/api/analyses/${created.analysisId}`,
    { headers: { Cookie: ownerB.cookie } },
  );
  const arbitrary = await fetch(
    `${baseUrl}/api/analyses/${"A".repeat(22)}`,
    { headers: { Cookie: ownerB.cookie } },
  );
  assert.equal(foreign.status, 404);
  assert.equal(arbitrary.status, 404);
  const foreignError = await foreign.json();
  const arbitraryError = await arbitrary.json();
  assert.equal(foreignError.code, "ANALYSIS_NOT_FOUND");
  assert.equal(arbitraryError.code, "ANALYSIS_NOT_FOUND");
  assert.equal(foreignError.message, arbitraryError.message);
  assert.equal(foreignError.retryable, false);

  const foreignReport = await fetch(
    `${baseUrl}/api/analyses/${created.analysisId}/report`,
    {
      method: "POST",
      headers: {
        Cookie: ownerB.cookie,
        Origin: ALLOWED_ORIGIN,
        "X-CSRF-Token": ownerB.session.csrfToken,
      },
    },
  );
  assert.equal(foreignReport.status, 404);
  assert.equal((await foreignReport.json()).code, "ANALYSIS_NOT_FOUND");
});

test("CORS preflight is allowlisted and does not create a session", async (t) => {
  const { baseUrl } = await openServer(t, {
    services: makeFlowServices(),
  });
  const response = await fetch(`${baseUrl}/api/analyses`, {
    method: "OPTIONS",
    headers: {
      Origin: ALLOWED_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers":
        "content-type,x-csrf-token,idempotency-key",
    },
  });
  assert.equal(response.status, 204);
  assert.match(
    response.headers.get("access-control-allow-methods"),
    /POST/,
  );
  assert.match(
    response.headers.get("access-control-allow-headers"),
    /X-CSRF-Token/,
  );
  assert.equal(response.headers.get("set-cookie"), null);

  const rejected = await fetch(`${baseUrl}/api/session`, {
    headers: { Origin: "https://evil.example.test" },
  });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).code, "ORIGIN_REJECTED");
  assert.equal(rejected.headers.get("access-control-allow-origin"), null);
});
