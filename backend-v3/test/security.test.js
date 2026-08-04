import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
} from "node:http";
import test from "node:test";

import {
  createHttpHandler,
  requestValidationCodes,
} from "../src/api/index.js";
import { DomainError } from "../src/domain/errors.js";
import {
  FixedWindowRateLimiter,
  StoreCapacityError,
  TtlMemoryStore,
  canonicalizeIp,
  createClientIpResolver,
  createOpaqueId,
} from "../src/infrastructure/index.js";
import { loadConfig } from "../server/config.js";

const ORIGIN = "https://app.example.test";
const SECRET = "security-test-session-secret-with-at-least-32-bytes";

function randomSequence() {
  let counter = 7;
  return (size) => {
    const result = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1) {
      result[index] = (counter + index) % 256;
    }
    counter += 17;
    return result;
  };
}

function baseServices(overrides = {}) {
  return {
    async searchLocations() {
      return { candidates: [] };
    },
    async createAnalysis({ analysisId }) {
      return { analysisId, report: { state: "NOT_REQUESTED", value: null } };
    },
    async getAnalysis() {
      return null;
    },
    async requestReport() {
      return null;
    },
    async getPreflight() {
      return { status: "READY" };
    },
    ...overrides,
  };
}

async function serve(
  t,
  {
    services = baseServices(),
    config = {},
    clock = Date.now,
    randomBytes = randomSequence(),
  } = {},
) {
  const handler = createHttpHandler({
    services,
    clock,
    randomBytes,
    config: {
      allowedOrigins: [ORIGIN],
      logger: { info() {}, error() {} },
      sessionSecret: SECRET,
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
  return `http://127.0.0.1:${server.address().port}`;
}

function cookieFrom(response) {
  const setCookie =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()[0]
      : response.headers.get("set-cookie");
  return setCookie?.split(";", 1)[0];
}

async function sessionAt(baseUrl, cookie) {
  const response = await fetch(`${baseUrl}/api/session`, {
    headers: {
      Origin: ORIGIN,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  assert.equal(response.status, 200);
  return {
    cookie: cookieFrom(response) ?? cookie,
    data: await response.json(),
    response,
  };
}

function rawHttpRequest(url, { bodyChunks = [], headers = {}, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers, method }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          body,
          headers: response.headers,
          status: response.statusCode,
        });
      });
    });
    request.once("error", reject);
    for (const chunk of bodyChunks) {
      request.write(chunk);
    }
    request.end();
  });
}

function postHeaders(session, extra = {}) {
  return {
    "Content-Type": "application/json",
    Cookie: session.cookie,
    Origin: ORIGIN,
    "X-CSRF-Token": session.data.csrfToken,
    ...extra,
  };
}

test("opaque IDs use at least 128 bits and TTL storage expires at the boundary", () => {
  let now = 1_000;
  const store = new TtlMemoryStore({ clock: () => now });
  store.set("candidate", { exactCoordinate: "private" }, 600_000);
  assert.deepEqual(store.get("candidate"), {
    exactCoordinate: "private",
  });
  now += 599_999;
  assert.equal(store.has("candidate"), true);
  now += 1;
  assert.equal(store.get("candidate"), undefined);
  assert.equal(store.size, 0);

  const id = createOpaqueId(randomSequence(), 16);
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.throws(
    () => createOpaqueId(randomSequence(), 15),
    /at least 16 random bytes/,
  );
});

test("bounded stores evict deterministically or reject new capacity", () => {
  let now = 1_000;
  const evicting = new TtlMemoryStore({
    clock: () => now,
    maxEntries: 2,
  });
  evicting.set("later", 1, 200);
  evicting.set("sooner", 2, 100);
  evicting.set("new", 3, 300);
  assert.equal(evicting.size, 2);
  assert.equal(evicting.get("sooner"), undefined);
  assert.equal(evicting.get("later"), 1);
  assert.equal(evicting.get("new"), 3);

  const tie = new TtlMemoryStore({
    clock: () => now,
    maxEntries: 2,
  });
  tie.set("first", 1, 100);
  tie.set("second", 2, 100);
  tie.set("third", 3, 100);
  assert.equal(tie.get("first"), undefined);
  assert.equal(tie.get("second"), 2);
  assert.equal(tie.get("third"), 3);

  const rejecting = new TtlMemoryStore({
    capacityPolicy: "reject",
    clock: () => now,
    maxEntries: 1,
  });
  rejecting.set("preserved", 1, 100);
  assert.throws(
    () => rejecting.set("rejected", 2, 100),
    StoreCapacityError,
  );
  assert.equal(rejecting.get("preserved"), 1);
  assert.equal(rejecting.size, 1);

  const limiter = new FixedWindowRateLimiter({
    clock: () => now,
    maxEntries: 1,
  });
  assert.equal(
    limiter.consume("first-ip", { limit: 5, windowMs: 60_000 }).allowed,
    true,
  );
  const capacityLimited = limiter.consume("second-ip", {
    limit: 5,
    windowMs: 60_000,
  });
  assert.equal(capacityLimited.allowed, false);
  assert.equal(capacityLimited.capacityLimited, true);

  now += 60_000;
  assert.equal(
    limiter.consume("second-ip", { limit: 5, windowMs: 60_000 }).allowed,
    true,
  );
});

test("client IPs are canonicalized and proxy chains stop at the nearest untrusted hop", () => {
  assert.equal(canonicalizeIp("192.0.2.10"), "192.0.2.10");
  assert.equal(canonicalizeIp("::ffff:192.0.2.10"), "192.0.2.10");
  assert.equal(
    canonicalizeIp("2001:0db8:0000:0000:0000:0000:0000:0001"),
    "2001:db8::1",
  );
  assert.equal(canonicalizeIp("192.168.001.001"), null);
  assert.equal(canonicalizeIp("198.51.100.1:443"), null);

  const resolve = createClientIpResolver({
    mode: "allowlist",
    ranges: ["127.0.0.0/8", "2001:db8::/32"],
  });
  assert.equal(
    resolve({
      headers: {
        "x-forwarded-for":
          "192.0.2.99, 198.51.100.25, 2001:db8::2",
      },
      socket: { remoteAddress: "::ffff:127.0.0.1" },
    }),
    "198.51.100.25",
  );
  assert.equal(
    resolve({
      headers: { "x-forwarded-for": "192.0.2.99" },
      socket: { remoteAddress: "203.0.113.8" },
    }),
    "203.0.113.8",
  );
  assert.equal(
    resolve({
      headers: { "x-forwarded-for": "invalid, 198.51.100.25" },
      socket: { remoteAddress: "127.0.0.1" },
    }),
    "127.0.0.1",
  );
});

test("server proxy configuration defaults direct and rejects unsafe production trust", () => {
  const direct = loadConfig({});
  assert.deepEqual(direct.trustedProxy, {
    mode: "direct",
    ranges: [],
  });
  assert.equal(Object.isFrozen(direct.trustedProxy), true);
  assert.equal(Object.isFrozen(direct.trustedProxy.ranges), true);

  const allowlisted = loadConfig({
    TRUSTED_PROXY_RANGES:
      "127.0.0.1,10.0.0.0/8,2001:0db8:0:0::/32",
  });
  assert.deepEqual(allowlisted.trustedProxy, {
    mode: "allowlist",
    ranges: ["127.0.0.1", "10.0.0.0/8", "2001:db8::/32"],
  });

  assert.throws(
    () => loadConfig({ TRUSTED_PROXY_RANGES: "not-an-ip" }),
    /TRUSTED_PROXY_RANGES/,
  );
  assert.throws(
    () => loadConfig({ TRUSTED_PROXY_RANGES: "0.0.0.0\/0" }),
    /must not trust every address/,
  );
  assert.throws(
    () => loadConfig({ TRUST_PROXY: "true" }),
    /TRUST_PROXY is unsupported/,
  );
});

test("signed sessions enforce Origin and CSRF, rotate expired tokens, and reject tampered cookies", async (t) => {
  let now = Date.parse("2026-07-23T01:00:00.000Z");
  let creates = 0;
  const baseUrl = await serve(t, {
    clock: () => now,
    services: baseServices({
      async createAnalysis({ analysisId }) {
        creates += 1;
        return {
          analysisId,
          report: { state: "NOT_REQUESTED", value: null },
        };
      },
    }),
  });
  const session = await sessionAt(baseUrl);
  assert.match(session.response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(session.response.headers.get("set-cookie"), /SameSite=Lax/);

  const missingOrigin = await fetch(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.data.csrfToken,
    },
    body: "{}",
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal((await missingOrigin.json()).code, "CSRF_REJECTED");

  const badOrigin = await fetch(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      Origin: "https://attacker.example.test",
      "X-CSRF-Token": session.data.csrfToken,
    },
    body: "{}",
  });
  assert.equal(badOrigin.status, 403);
  assert.equal((await badOrigin.json()).code, "CSRF_REJECTED");

  const badToken = await fetch(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      Origin: ORIGIN,
      "X-CSRF-Token": `${session.data.csrfToken}x`,
    },
    body: "{}",
  });
  assert.equal(badToken.status, 403);
  assert.equal((await badToken.json()).code, "CSRF_REJECTED");
  assert.equal(creates, 0);

  const accepted = await fetch(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: postHeaders(session),
    body: "{}",
  });
  assert.equal(accepted.status, 201);
  assert.equal(creates, 1);

  now += 60 * 60 * 1_000;
  const expired = await fetch(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: postHeaders(session),
    body: "{}",
  });
  assert.equal(expired.status, 403);
  assert.equal((await expired.json()).code, "CSRF_REJECTED");
  assert.equal(creates, 1);

  const refreshed = await sessionAt(baseUrl, session.cookie);
  assert.notEqual(refreshed.data.csrfToken, session.data.csrfToken);
  assert.equal(
    Date.parse(refreshed.data.expiresAt),
    now + 60 * 60 * 1_000,
  );

  const separator = session.cookie.lastIndexOf("=");
  const originalValue = session.cookie.slice(separator + 1);
  const tamperedValue = `${originalValue.slice(0, -1)}${
    originalValue.endsWith("A") ? "B" : "A"
  }`;
  const tampered = await sessionAt(
    baseUrl,
    `${session.cookie.slice(0, separator + 1)}${tamperedValue}`,
  );
  assert.notEqual(tampered.cookie, session.cookie);
  assert.ok(tampered.response.headers.get("set-cookie"));
});

test("production sessions force Secure cookies and HSTS", async (t) => {
  const baseUrl = await serve(t, {
    config: { production: true, secureCookies: false },
  });
  const session = await sessionAt(baseUrl);
  assert.match(session.response.headers.get("set-cookie"), /; Secure(?:;|$)/);
  assert.match(
    session.response.headers.get("strict-transport-security"),
    /max-age=31536000/,
  );
});

test("an independent IP bucket blocks cookie rotation and ignores forwarded IP by default", async (t) => {
  let searches = 0;
  const baseUrl = await serve(t, {
    config: {
      rateLimits: {
        "locations.search": { limit: 2, windowMs: 60_000 },
      },
    },
    services: baseServices({
      async searchLocations() {
        searches += 1;
        return { candidates: [] };
      },
    }),
  });

  const requestWithoutCookie = (forwardedFor) =>
    fetch(`${baseUrl}/api/locations?q=sentinel`, {
      headers: { "X-Forwarded-For": forwardedFor },
    });

  const first = await requestWithoutCookie("198.51.100.10");
  const second = await requestWithoutCookie("198.51.100.11");
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(cookieFrom(first), cookieFrom(second));

  const blocked = await requestWithoutCookie("198.51.100.12");
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).code, "RATE_LIMITED");
  assert.equal(blocked.headers.get("retry-after"), "60");
  assert.equal(blocked.headers.get("set-cookie"), null);
  assert.equal(searches, 2);
});

test("only an allowlisted socket proxy may supply a spoof-resistant X-Forwarded-For chain", async (t) => {
  const services = baseServices({
    async searchLocations() {
      return { candidates: [] };
    },
  });
  const trustedUrl = await serve(t, {
    config: {
      rateLimits: {
        "locations.search": { limit: 1, windowMs: 60_000 },
      },
      trustedProxy: {
        mode: "allowlist",
        ranges: ["127.0.0.0/8"],
      },
    },
    services,
  });

  const first = await fetch(`${trustedUrl}/api/locations?q=sentinel`, {
    headers: {
      "X-Forwarded-For": "192.0.2.1, 198.51.100.50",
    },
  });
  assert.equal(first.status, 200);
  const spoofedLeft = await fetch(
    `${trustedUrl}/api/locations?q=sentinel`,
    {
      headers: {
        "X-Forwarded-For": "203.0.113.77, 198.51.100.50",
      },
    },
  );
  assert.equal(spoofedLeft.status, 429);

  const differentClient = await fetch(
    `${trustedUrl}/api/locations?q=sentinel`,
    {
      headers: {
        "X-Forwarded-For": "192.0.2.1, 198.51.100.51",
      },
    },
  );
  assert.equal(differentClient.status, 200);

  const untrustedUrl = await serve(t, {
    config: {
      rateLimits: {
        "locations.search": { limit: 1, windowMs: 60_000 },
      },
      trustedProxy: {
        mode: "allowlist",
        ranges: ["10.0.0.0/8"],
      },
    },
    services,
  });
  const untrustedFirst = await fetch(
    `${untrustedUrl}/api/locations?q=sentinel`,
    { headers: { "X-Forwarded-For": "198.51.100.80" } },
  );
  assert.equal(untrustedFirst.status, 200);
  const untrustedSpoof = await fetch(
    `${untrustedUrl}/api/locations?q=sentinel`,
    { headers: { "X-Forwarded-For": "198.51.100.81" } },
  );
  assert.equal(untrustedSpoof.status, 429);
});

test("/api/session is IP-rate-limited before a new session is allocated", async (t) => {
  const baseUrl = await serve(t, {
    config: {
      rateLimits: {
        "session.get": { limit: 2, windowMs: 60_000 },
      },
    },
  });

  const first = await fetch(`${baseUrl}/api/session`);
  const second = await fetch(`${baseUrl}/api/session`);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.ok(cookieFrom(first));
  assert.ok(cookieFrom(second));

  const blocked = await fetch(`${baseUrl}/api/session`);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("set-cookie"), null);
  assert.equal((await blocked.json()).code, "RATE_LIMITED");
});

test("matched invalid-Origin requests are IP-rate-limited before CORS without allocating sessions", async (t) => {
  const baseUrl = await serve(t, {
    config: {
      ipRateLimits: {
        "session.get": { limit: 2, windowMs: 60_000 },
      },
      rateLimits: {
        "session.get": false,
      },
    },
  });
  const rejected = (forwardedFor) =>
    fetch(`${baseUrl}/api/session`, {
      headers: {
        Origin: "https://attacker.example.test",
        "X-Forwarded-For": forwardedFor,
      },
    });

  const first = await rejected("198.51.100.10");
  const second = await rejected("198.51.100.11");
  assert.equal(first.status, 403);
  assert.equal(second.status, 403);
  assert.equal((await first.json()).code, "ORIGIN_REJECTED");
  assert.equal((await second.json()).code, "ORIGIN_REJECTED");
  assert.equal(first.headers.get("set-cookie"), null);
  assert.equal(second.headers.get("set-cookie"), null);
  assert.equal(first.headers.get("access-control-allow-origin"), null);

  const blocked = await rejected("198.51.100.12");
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).code, "RATE_LIMITED");
  assert.equal(blocked.headers.get("retry-after"), "60");
  assert.equal(blocked.headers.get("set-cookie"), null);
  assert.equal(blocked.headers.get("access-control-allow-origin"), null);

  const allowedButLimited = await fetch(`${baseUrl}/api/session`, {
    headers: { Origin: ORIGIN },
  });
  assert.equal(allowedButLimited.status, 429);
  assert.equal(
    allowedButLimited.headers.get("access-control-allow-origin"),
    ORIGIN,
  );
  assert.equal(
    allowedButLimited.headers.get("access-control-allow-credentials"),
    "true",
  );
  assert.equal(allowedButLimited.headers.get("set-cookie"), null);
});

test("normal GET, POST, and OPTIONS consume their route ingress bucket exactly once", async (t) => {
  const consumed = [];
  const rateLimiter = {
    consume(key) {
      consumed.push(JSON.parse(key));
      return { allowed: true };
    },
  };
  const baseUrl = await serve(t, {
    config: { rateLimiter },
  });
  const session = await sessionAt(baseUrl);

  const assertSingleIngress = (routeName, sessionBucketCount) => {
    const ingress = consumed.filter(([scope]) => scope === "ip");
    const sessionBuckets = consumed.filter(
      ([scope]) => scope === "session-ip",
    );
    assert.equal(ingress.length, 1);
    assert.equal(ingress[0][1], routeName);
    assert.equal(sessionBuckets.length, sessionBucketCount);
  };

  consumed.length = 0;
  const getResponse = await fetch(
    `${baseUrl}/api/locations?q=sentinel`,
    { headers: { Cookie: session.cookie } },
  );
  assert.equal(getResponse.status, 200);
  assertSingleIngress("locations.search", 1);

  consumed.length = 0;
  const postResponse = await fetch(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: postHeaders(session),
    body: "{}",
  });
  assert.equal(postResponse.status, 201);
  assertSingleIngress("analyses.create", 1);

  consumed.length = 0;
  const optionsResponse = await fetch(`${baseUrl}/api/analyses`, {
    method: "OPTIONS",
    headers: {
      Origin: ORIGIN,
      "Access-Control-Request-Method": "POST",
    },
  });
  assert.equal(optionsResponse.status, 204);
  assertSingleIngress("analyses.create", 0);
  assert.equal(optionsResponse.headers.get("set-cookie"), null);
});

test("allowlisted OPTIONS requests consume an IP bucket without allocating sessions", async (t) => {
  const baseUrl = await serve(t, {
    config: {
      rateLimits: {
        "analyses.create": { limit: 2, windowMs: 60_000 },
      },
    },
  });
  const preflight = () =>
    fetch(`${baseUrl}/api/analyses`, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
      },
    });

  const first = await preflight();
  const second = await preflight();
  assert.equal(first.status, 204);
  assert.equal(second.status, 204);
  assert.equal(first.headers.get("set-cookie"), null);
  assert.equal(second.headers.get("set-cookie"), null);

  const blocked = await preflight();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "60");
  assert.equal(blocked.headers.get("set-cookie"), null);
  assert.equal((await blocked.json()).code, "RATE_LIMITED");
});

test("idempotency hashes the service-normalized domain payload before creation", async (t) => {
  const order = [];
  let createCalls = 0;
  let normalizeCalls = 0;
  const baseUrl = await serve(t, {
    services: baseServices({
      normalizeAnalysisInput(input) {
        normalizeCalls += 1;
        order.push("normalize");
        return {
          crop: input.crop.trim().toUpperCase(),
          options: {
            includeSatellite: input.options?.includeSatellite ?? false,
          },
        };
      },
      async createAnalysis({ analysisId, input }) {
        createCalls += 1;
        order.push("create");
        return {
          analysisId,
          crop: input.crop,
          report: { state: "NOT_REQUESTED", value: null },
        };
      },
    }),
  });
  const session = await sessionAt(baseUrl);
  const create = (body) =>
    fetch(`${baseUrl}/api/analyses`, {
      method: "POST",
      headers: postHeaders(session, {
        "Idempotency-Key": "semantic-normalization",
      }),
      body: JSON.stringify(body),
    });

  const first = await create({ crop: " tomato " });
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.deepEqual(order, ["normalize", "create"]);

  const replay = await create({
    crop: "TOMATO",
    options: { includeSatellite: false },
  });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.deepEqual(await replay.json(), firstBody);
  assert.equal(normalizeCalls, 2);
  assert.equal(createCalls, 1);

  const conflict = await create({
    crop: "TOMATO",
    options: { includeSatellite: true },
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "IDEMPOTENCY_CONFLICT");
  assert.equal(normalizeCalls, 3);
  assert.equal(createCalls, 1);
});

test("idempotency replays normalized payloads, rejects conflicts, and does not retain 4xx failures", async (t) => {
  let calls = 0;
  let failOnce = true;
  const baseUrl = await serve(t, {
    services: baseServices({
      async createAnalysis({ analysisId, input }) {
        calls += 1;
        if (input.failOnce && failOnce) {
          failOnce = false;
          throw new DomainError(
            "INVALID_INPUT",
            "expected validation failure",
          );
        }
        return {
          analysisId,
          crop: input.crop,
          nested: input.nested,
          report: { state: "NOT_REQUESTED", value: null },
        };
      },
    }),
  });
  const session = await sessionAt(baseUrl);

  const first = await fetch(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: postHeaders(session, {
      "Idempotency-Key": "normalized-1",
    }),
    body: JSON.stringify({
      crop: "TOMATO",
      nested: { b: 2, a: 1 },
    }),
  });
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  const firstLocation = first.headers.get("location");

  const replay = await fetch(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: postHeaders(session, {
      "Idempotency-Key": "normalized-1",
    }),
    body: JSON.stringify({
      nested: { a: 1, b: 2 },
      crop: "TOMATO",
    }),
  });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.equal(replay.headers.get("location"), firstLocation);
  assert.deepEqual(await replay.json(), firstBody);
  assert.equal(calls, 1);

  const conflict = await fetch(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: postHeaders(session, {
      "Idempotency-Key": "normalized-1",
    }),
    body: JSON.stringify({
      crop: "STRAWBERRY",
      nested: { a: 1, b: 2 },
    }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "IDEMPOTENCY_CONFLICT");
  assert.equal(calls, 1);

  const failed = await fetch(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: postHeaders(session, {
      "Idempotency-Key": "retry-after-4xx",
    }),
    body: JSON.stringify({ failOnce: true }),
  });
  assert.equal(failed.status, 400);
  assert.equal((await failed.json()).code, "INVALID_INPUT");

  const retried = await fetch(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: postHeaders(session, {
      "Idempotency-Key": "retry-after-4xx",
    }),
    body: JSON.stringify({ failOnce: true }),
  });
  assert.equal(retried.status, 201);
  assert.equal(calls, 3);

  const invalidKey = await fetch(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: postHeaders(session, {
      "Idempotency-Key": "contains space",
    }),
    body: "{}",
  });
  assert.equal(invalidKey.status, 400);
  const invalidBody = await invalidKey.json();
  assert.equal(invalidBody.code, "INVALID_INPUT");
  assert.ok(invalidBody.fieldErrors.idempotencyKey);
});

test("session and rate-store capacity fail closed without evicting an active session", async (t) => {
  const sessionCapacityUrl = await serve(t, {
    config: {
      ipRateLimits: {
        "session.get": { limit: 10, windowMs: 60_000 },
      },
      sessionMaxEntries: 1,
    },
  });
  const active = await sessionAt(sessionCapacityUrl);

  const rejectedSession = await fetch(
    `${sessionCapacityUrl}/api/session`,
    { headers: { Origin: ORIGIN } },
  );
  assert.equal(rejectedSession.status, 503);
  assert.equal(rejectedSession.headers.get("set-cookie"), null);
  const capacityError = await rejectedSession.json();
  assert.equal(capacityError.code, "SERVICE_BUSY");
  assert.equal(capacityError.retryable, true);

  const existingSession = await sessionAt(sessionCapacityUrl, active.cookie);
  assert.equal(
    existingSession.data.csrfToken,
    active.data.csrfToken,
  );

  let searches = 0;
  const rateCapacityUrl = await serve(t, {
    config: {
      rateLimitMaxEntries: 1,
    },
    services: baseServices({
      async searchLocations() {
        searches += 1;
        return { candidates: [] };
      },
    }),
  });
  const session = await sessionAt(rateCapacityUrl);
  const rateCapacity = await fetch(
    `${rateCapacityUrl}/api/locations?q=sentinel`,
    { headers: { Cookie: session.cookie } },
  );
  assert.equal(rateCapacity.status, 429);
  assert.equal(rateCapacity.headers.get("retry-after"), "60");
  assert.equal(rateCapacity.headers.get("set-cookie"), null);
  assert.equal(searches, 0);
});

test("idempotency capacity preserves an existing record and returns a safe 503", async (t) => {
  let creates = 0;
  const baseUrl = await serve(t, {
    config: {
      idempotencyMaxEntries: 1,
      ipRateLimits: {
        "analyses.create": { limit: 10, windowMs: 60_000 },
      },
      rateLimits: {
        "analyses.create": { limit: 10, windowMs: 60_000 },
      },
    },
    services: baseServices({
      async createAnalysis({ analysisId }) {
        creates += 1;
        return {
          analysisId,
          report: { state: "NOT_REQUESTED", value: null },
        };
      },
    }),
  });
  const session = await sessionAt(baseUrl);
  const create = (key) =>
    fetch(`${baseUrl}/api/analyses`, {
      method: "POST",
      headers: postHeaders(session, { "Idempotency-Key": key }),
      body: "{}",
    });

  const first = await create("capacity-1");
  assert.equal(first.status, 201);
  const firstBody = await first.json();

  const blocked = await create("capacity-2");
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).code, "SERVICE_BUSY");
  assert.equal(creates, 1);

  const replay = await create("capacity-1");
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.deepEqual(await replay.json(), firstBody);
  assert.equal(creates, 1);
});

test("candidate and analysis TTLs expire exactly at 10 and 60 minute boundaries over HTTP", async (t) => {
  let now = 0;
  let candidateSequence = 0;
  const candidateStore = new TtlMemoryStore({ clock: () => now });
  const analysisStore = new TtlMemoryStore({ clock: () => now });
  const services = baseServices({
    async searchLocations({ ownerSessionId }) {
      candidateSequence += 1;
      const candidateToken = `candidate-${candidateSequence}`;
      candidateStore.set(
        candidateToken,
        { ownerSessionId },
        10 * 60 * 1_000,
      );
      return {
        candidates: [
          {
            candidateToken,
            displayName: "REGION_SENTINEL",
            expiresAt: new Date(now + 10 * 60 * 1_000).toISOString(),
            resolutionMode: "ADDRESS_RESOLVED",
          },
        ],
      };
    },
    async createAnalysis({ analysisId, input, ownerSessionId }) {
      const candidate = candidateStore.get(input.candidateToken);
      if (!candidate || candidate.ownerSessionId !== ownerSessionId) {
        const error = new Error("candidate expired");
        error.code = "LOCATION_TOKEN_INVALID";
        throw error;
      }
      const result = {
        analysisId,
        report: { state: "NOT_REQUESTED", value: null },
      };
      analysisStore.set(
        analysisId,
        { ownerSessionId, result },
        60 * 60 * 1_000,
      );
      return result;
    },
    async getAnalysis({ analysisId, ownerSessionId }) {
      const record = analysisStore.get(analysisId);
      return record?.ownerSessionId === ownerSessionId
        ? structuredClone(record.result)
        : null;
    },
  });
  const baseUrl = await serve(t, {
    clock: () => now,
    services,
  });
  const session = await sessionAt(baseUrl);
  const location = await fetch(`${baseUrl}/api/locations?q=sentinel`, {
    headers: { Cookie: session.cookie },
  }).then((response) => response.json());
  const candidateToken = location.candidates[0].candidateToken;
  const create = () =>
    fetch(`${baseUrl}/api/analyses`, {
      method: "POST",
      headers: postHeaders(session),
      body: JSON.stringify({ candidateToken }),
    });

  now = 10 * 60 * 1_000 - 1;
  const createdResponse = await create();
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();

  now = 10 * 60 * 1_000;
  const expiredCandidate = await create();
  assert.equal(expiredCandidate.status, 400);
  assert.equal(
    (await expiredCandidate.json()).code,
    "LOCATION_TOKEN_INVALID",
  );

  const analysisExpiresAt =
    10 * 60 * 1_000 - 1 + 60 * 60 * 1_000;
  now = analysisExpiresAt - 1;
  const beforeExpiry = await fetch(
    `${baseUrl}/api/analyses/${created.analysisId}`,
    { headers: { Cookie: session.cookie } },
  );
  assert.equal(beforeExpiry.status, 200);

  now = analysisExpiresAt;
  const atExpiry = await fetch(
    `${baseUrl}/api/analyses/${created.analysisId}`,
    { headers: { Cookie: session.cookie } },
  );
  assert.equal(atExpiry.status, 404);
  assert.equal((await atExpiry.json()).code, "ANALYSIS_NOT_FOUND");
});

test("idempotency records replay before and expire exactly at ten minutes", async (t) => {
  let now = 0;
  let creates = 0;
  const baseUrl = await serve(t, {
    clock: () => now,
    services: baseServices({
      async createAnalysis({ analysisId }) {
        creates += 1;
        return {
          analysisId,
          report: { state: "NOT_REQUESTED", value: null },
        };
      },
    }),
  });
  const session = await sessionAt(baseUrl);
  const create = () =>
    fetch(`${baseUrl}/api/analyses`, {
      method: "POST",
      headers: postHeaders(session, {
        "Idempotency-Key": "ttl-boundary",
      }),
      body: "{}",
    });

  const first = await create();
  assert.equal(first.status, 201);
  const firstBody = await first.json();

  now = 10 * 60 * 1_000 - 1;
  const replay = await create();
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.deepEqual(await replay.json(), firstBody);
  assert.equal(creates, 1);

  now = 10 * 60 * 1_000;
  const afterExpiry = await create();
  assert.equal(afterExpiry.status, 201);
  assert.equal(afterExpiry.headers.get("idempotency-replayed"), null);
  assert.notEqual((await afterExpiry.json()).analysisId, firstBody.analysisId);
  assert.equal(creates, 2);
});

test("a concurrent idempotent request receives 202 and the reserved analysis Location", async (t) => {
  let release;
  let called;
  const entered = new Promise((resolve) => {
    called = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let createCalls = 0;
  const baseUrl = await serve(t, {
    services: baseServices({
      async createAnalysis({ analysisId }) {
        createCalls += 1;
        called();
        await gate;
        return {
          analysisId,
          report: { state: "NOT_REQUESTED", value: null },
        };
      },
    }),
  });
  const session = await sessionAt(baseUrl);
  const request = () =>
    fetch(`${baseUrl}/api/analyses`, {
      method: "POST",
      headers: postHeaders(session, {
        "Idempotency-Key": "concurrent-1",
      }),
      body: JSON.stringify({ crop: "PEPPER" }),
    });

  const firstPromise = request();
  await called;
  const second = await request();
  assert.equal(second.status, 202);
  const secondBody = await second.json();
  assert.equal(
    second.headers.get("location"),
    `/api/analyses/${secondBody.analysisId}`,
  );
  assert.equal(secondBody.state, "PENDING");

  release();
  const first = await firstPromise;
  assert.equal(first.status, 201);
  assert.equal(first.headers.get("location"), second.headers.get("location"));
  assert.equal(createCalls, 1);
});

test("session+IP rate limits return Retry-After and JSON bodies are bounded", async (t) => {
  let now = 5_000;
  const baseUrl = await serve(t, {
    clock: () => now,
    config: {
      bodyLimitBytes: 48,
      rateLimits: {
        "locations.search": { limit: 1, windowMs: 60_000 },
      },
    },
  });
  const session = await sessionAt(baseUrl);

  const first = await fetch(`${baseUrl}/api/locations?q=서울`, {
    headers: { Cookie: session.cookie },
  });
  assert.equal(first.status, 200);
  const limited = await fetch(`${baseUrl}/api/locations?q=부산`, {
    headers: { Cookie: session.cookie },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  const limitedBody = await limited.json();
  assert.equal(limitedBody.code, "RATE_LIMITED");
  assert.equal(limitedBody.retryable, true);
  assert.match(limitedBody.requestId, /^[A-Za-z0-9_-]{22}$/);

  now += 60_000;
  const afterWindow = await fetch(`${baseUrl}/api/locations?q=부산`, {
    headers: { Cookie: session.cookie },
  });
  assert.equal(afterWindow.status, 200);

  const oversized = await fetch(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: postHeaders(session),
    body: JSON.stringify({ value: "x".repeat(100) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).code, "PAYLOAD_TOO_LARGE");
});

test("chunked JSON bodies are rejected as soon as the inbound byte limit is crossed", async (t) => {
  let creates = 0;
  const logs = [];
  const baseUrl = await serve(t, {
    config: {
      bodyLimitBytes: 48,
      logger: {
        error(entry) {
          logs.push(entry);
        },
        info(entry) {
          logs.push(entry);
        },
      },
    },
    services: baseServices({
      async createAnalysis({ analysisId }) {
        creates += 1;
        return {
          analysisId,
          report: { state: "NOT_REQUESTED", value: null },
        };
      },
    }),
  });
  const session = await sessionAt(baseUrl);
  const sensitiveSentinel = "CHUNKED_SENSITIVE_COORDINATE_SENTINEL";
  const response = await rawHttpRequest(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      Origin: ORIGIN,
      "Transfer-Encoding": "chunked",
      "X-CSRF-Token": session.data.csrfToken,
    },
    bodyChunks: [
      '{"value":"',
      sensitiveSentinel.repeat(4),
      '"}',
    ],
  });
  assert.equal(response.status, 413);
  assert.equal(JSON.parse(response.body).code, "PAYLOAD_TOO_LARGE");
  assert.equal(creates, 0);
  assert.equal(JSON.stringify(logs).includes(sensitiveSentinel), false);
});

test("every approved request-validation DomainError becomes a safe structured HTTP 400", async (t) => {
  assert.deepEqual(
    [...requestValidationCodes].sort(),
    [
      "CROP_CYCLE_ACTIVE_DATE_INVALID",
      "CROP_CYCLE_ANCHOR_INVALID",
      "CROP_CYCLE_COMPLETION_DATE_INVALID",
      "CROP_CYCLE_CROP_INVALID",
      "CROP_CYCLE_DATE_INVALID",
      "CROP_CYCLE_REVISION_INVALID",
      "CROP_CYCLE_SCOPE_INVALID",
      "CROP_CYCLE_STATUS_INVALID",
      "CROP_CYCLE_TIMESTAMP_INVALID",
      "INVALID_CULTIVATION_MODE",
      "INVALID_GROWTH_STAGE",
      "INVALID_GROWTH_STAGE_CONTEXT",
      "INVALID_INPUT",
      "INVALID_LOCATION_SELECTION",
      "INVALID_LOCATION_TOKEN",
      "INVALID_OPTIONS",
      "INVALID_PARCEL",
      "INVALID_SATELLITE_CONTEXT",
      "INVALID_SEASON",
      "INVALID_SEASON_CONTEXT",
      "INVALID_SEASON_MONTH",
      "INVALID_SEASON_PROFILE",
      "LOCATION_NOT_CONFIRMED",
      "PARCEL_NOT_CONFIRMED",
      "PARCEL_REQUIRED",
      "PARCEL_TOO_COMPLEX",
      "SEASON_NOT_CONFIRMED",
      "SEASON_REQUIRED",
      "UNVERIFIED_SEASON_PROFILE",
    ].sort(),
  );
  const unsafeMessage = "UNSAFE_PROVIDER_DETAIL_WITH_SECRET";
  const baseUrl = await serve(t, {
    config: {
      ipRateLimits: {
        "analyses.create": { limit: 100, windowMs: 60_000 },
      },
      rateLimits: {
        "analyses.create": { limit: 100, windowMs: 60_000 },
      },
    },
    services: baseServices({
      async createAnalysis({ input }) {
        if (input.kind === "plain-error") {
          const error = new Error(unsafeMessage);
          error.code = "INVALID_INPUT";
          error.expose = true;
          error.status = 400;
          throw error;
        }
        throw new DomainError(input.code, unsafeMessage, {
          expose: input.expose,
          status: input.status ?? 422,
        });
      },
    }),
  });
  const session = await sessionAt(baseUrl);
  const request = (body) =>
    fetch(`${baseUrl}/api/analyses`, {
      method: "POST",
      headers: postHeaders(session),
      body: JSON.stringify(body),
    });

  for (const code of requestValidationCodes) {
    const response = await request({ code });
    assert.equal(response.status, 400, code);
    const body = await response.json();
    assert.equal(body.code, code);
    assert.equal(body.retryable, false);
    assert.match(body.requestId, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(body.message.includes(unsafeMessage), false);
  }

  const unknown = await request({ code: "ARBITRARY_DOMAIN_CODE" });
  assert.equal(unknown.status, 400);
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.code, "INVALID_INPUT");
  assert.equal(unknownBody.message, "The request input is invalid.");
  assert.equal(JSON.stringify(unknownBody).includes(unsafeMessage), false);

  const notExposed = await request({
    code: "INVALID_INPUT",
    expose: false,
  });
  assert.equal(notExposed.status, 500);
  assert.equal((await notExposed.json()).code, "INTERNAL_ERROR");

  const serverSide = await request({
    code: "INVALID_INPUT",
    expose: true,
    status: 500,
  });
  assert.equal(serverSide.status, 500);
  assert.equal((await serverSide.json()).code, "INTERNAL_ERROR");

  const plain = await request({ kind: "plain-error" });
  assert.equal(plain.status, 500);
  const plainBody = await plain.json();
  assert.equal(plainBody.code, "INTERNAL_ERROR");
  assert.equal(JSON.stringify(plainBody).includes(unsafeMessage), false);
});

test("request deadlines abort the application signal and return a retryable timeout", async (t) => {
  let observedSignal;
  let aborted;
  const signalAborted = new Promise((resolve) => {
    aborted = resolve;
  });
  const baseUrl = await serve(t, {
    config: { requestTimeoutMs: 30 },
    services: baseServices({
      async createAnalysis({ signal }) {
        observedSignal = signal;
        signal.addEventListener("abort", aborted, { once: true });
        return new Promise(() => {});
      },
    }),
  });
  const session = await sessionAt(baseUrl);
  const responsePromise = fetch(`${baseUrl}/api/analyses`, {
    method: "POST",
    headers: postHeaders(session),
    body: "{}",
  });
  await signalAborted;
  const response = await responsePromise;
  assert.equal(observedSignal.aborted, true);
  assert.equal(response.status, 504);
  const body = await response.json();
  assert.equal(body.code, "REQUEST_TIMEOUT");
  assert.equal(body.retryable, true);
});
