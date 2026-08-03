import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SessionManager,
  createSupabaseSharedState,
} from "../src/infrastructure/index.js";

const SUPABASE_URL = "https://project.supabase.co";
const SECRET = "server-only-secret-for-shared-state-tests";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createRpcFixture() {
  const entries = new Map();
  const rateBuckets = new Map();
  let probeReady = true;

  const entryKey = (namespace, key) => JSON.stringify([namespace, key]);
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.apikey, SECRET);
    assert.equal(options.headers.Authorization, `Bearer ${SECRET}`);
    const rpc = new URL(url).pathname.split("/").at(-1);
    const body = JSON.parse(options.body);
    const key = entryKey(body.p_namespace, body.p_key);

    if (rpc === "heuknalssi_shared_state_get") {
      return jsonResponse(entries.get(key)?.value ?? null);
    }
    if (rpc === "heuknalssi_shared_state_set") {
      entries.set(key, { value: structuredClone(body.p_value) });
      return jsonResponse(body.p_value);
    }
    if (rpc === "heuknalssi_shared_state_delete") {
      return jsonResponse(entries.delete(key));
    }
    if (rpc === "heuknalssi_shared_state_set_if_absent") {
      if (entries.has(key)) return jsonResponse(false);
      entries.set(key, { value: structuredClone(body.p_value) });
      return jsonResponse(true);
    }
    if (rpc === "heuknalssi_shared_state_compare_and_set") {
      const current = entries.get(key)?.value;
      if (JSON.stringify(current) !== JSON.stringify(body.p_expected)) {
        return jsonResponse(false);
      }
      entries.set(key, { value: structuredClone(body.p_value) });
      return jsonResponse(true);
    }
    if (rpc === "heuknalssi_idempotency_begin") {
      const current = entries.get(key)?.value;
      if (!current) {
        entries.set(key, {
          value: {
            state: "in_progress",
            payloadHash: body.p_payload_hash,
            location: body.p_location,
          },
        });
        return jsonResponse({ kind: "started" });
      }
      if (current.payloadHash !== body.p_payload_hash) {
        return jsonResponse({ kind: "conflict" });
      }
      if (current.state === "completed") {
        return jsonResponse({ kind: "replay", response: current.response });
      }
      return jsonResponse({ kind: "in_progress", location: current.location });
    }
    if (rpc === "heuknalssi_idempotency_complete") {
      const current = entries.get(key)?.value;
      if (
        !current ||
        current.state !== "in_progress" ||
        current.payloadHash !== body.p_payload_hash
      ) {
        return jsonResponse(false);
      }
      entries.set(key, {
        value: { ...current, state: "completed", response: body.p_response },
      });
      return jsonResponse(true);
    }
    if (rpc === "heuknalssi_idempotency_fail") {
      const current = entries.get(key)?.value;
      const matches =
        current?.state === "in_progress" &&
        current.payloadHash === body.p_payload_hash;
      if (matches) entries.delete(key);
      return jsonResponse(matches);
    }
    if (rpc === "heuknalssi_rate_limit_consume") {
      const current = rateBuckets.get(body.p_bucket_key) ?? 0;
      if (current >= body.p_limit) {
        return jsonResponse({
          allowed: false,
          limit: body.p_limit,
          remaining: 0,
          retryAfterSeconds: 60,
        });
      }
      rateBuckets.set(body.p_bucket_key, current + 1);
      return jsonResponse({
        allowed: true,
        limit: body.p_limit,
        remaining: body.p_limit - current - 1,
        retryAfterSeconds: 0,
      });
    }
    if (rpc === "heuknalssi_shared_state_probe") {
      return jsonResponse(probeReady);
    }
    return jsonResponse({ message: "unknown RPC" }, 404);
  };

  return {
    fetchImpl,
    setProbeReady(value) {
      probeReady = value;
    },
  };
}

function deterministicRandomBytes(size) {
  return Buffer.alloc(size, 7);
}

test("Supabase state is disabled unless both server-only values exist", async () => {
  const state = createSupabaseSharedState({
    url: SUPABASE_URL,
    serviceKey: null,
    fetchImpl: async () => {
      throw new Error("must not call the network");
    },
  });

  assert.equal(state.configured, false);
  assert.deepEqual(await state.probe(), {
    ready: false,
    state: "NOT_CONFIGURED",
    verifiedAt: null,
  });
});

test("opaque secret keys use apikey only while legacy service-role JWTs keep Authorization", async () => {
  const calls = [];
  const state = createSupabaseSharedState({
    url: SUPABASE_URL,
    serviceKey: "sb_secret_opaque-test-value",
    fetchImpl: async (_url, options) => {
      calls.push(options.headers);
      return jsonResponse(true);
    },
  });
  assert.equal((await state.probe()).ready, true);
  assert.equal(calls[0].apikey, "sb_secret_opaque-test-value");
  assert.equal(Object.hasOwn(calls[0], "Authorization"), false);
});

test("independent server instances share sessions, state, idempotency, and rate limits", async () => {
  const fixture = createRpcFixture();
  const first = createSupabaseSharedState({
    url: SUPABASE_URL,
    serviceKey: SECRET,
    fetchImpl: fixture.fetchImpl,
    now: () => Date.parse("2026-07-31T01:00:00.000Z"),
  });
  const second = createSupabaseSharedState({
    url: SUPABASE_URL,
    serviceKey: SECRET,
    fetchImpl: fixture.fetchImpl,
    now: () => Date.parse("2026-07-31T01:00:00.000Z"),
  });

  const candidatesA = first.createTtlStore("candidates");
  const candidatesB = second.createTtlStore("candidates");
  assert.equal(
    await candidatesA.setIfAbsent("candidate-1", { owner: "session-1" }, 1000),
    true,
  );
  assert.equal(
    await candidatesB.setIfAbsent("candidate-1", { owner: "other" }, 1000),
    false,
  );
  assert.deepEqual(await candidatesB.get("candidate-1"), {
    owner: "session-1",
  });

  const analysesA = first.createTtlStore("analyses");
  const analysesB = second.createTtlStore("analyses");
  const originalAnalysis = { owner: "session-1", state: "CORE_READY" };
  await analysesA.set("analysis-1", originalAnalysis, 60_000);
  assert.equal(
    await analysesB.compareAndSet(
      "analysis-1",
      originalAnalysis,
      { owner: "session-1", state: "REPORT_PENDING" },
      60_000,
    ),
    true,
  );
  assert.deepEqual(await analysesA.get("analysis-1"), {
    owner: "session-1",
    state: "REPORT_PENDING",
  });

  const sessionOptions = {
    secret: "a-session-secret-with-at-least-thirty-two-bytes",
    randomBytes: deterministicRandomBytes,
  };
  const sessionsA = new SessionManager({
    ...sessionOptions,
    store: first.createTtlStore("sessions"),
  });
  const sessionsB = new SessionManager({
    ...sessionOptions,
    store: second.createTtlStore("sessions"),
  });
  const issued = await sessionsA.resolve();
  const cookie = issued.setCookie.split(";", 1)[0];
  const resumed = await sessionsB.resolve(cookie);
  assert.equal(resumed.isNew, false);
  assert.equal(resumed.session.id, issued.session.id);
  assert.equal(resumed.session.csrfToken, issued.session.csrfToken);

  const idemA = first.createIdempotencyStore({ ttlMs: 60_000 });
  const idemB = second.createIdempotencyStore({ ttlMs: 60_000 });
  const request = {
    ownerSessionId: "session-1",
    route: "analyses.create",
    key: "same-request",
    payloadHash: "payload-hash",
    location: "/api/analyses/analysis-1",
  };
  const begun = await idemA.begin(request);
  assert.equal(begun.kind, "started");
  assert.equal((await idemB.begin(request)).kind, "in_progress");
  await idemA.complete(begun.token, {
    status: 201,
    body: { analysisId: "analysis-1" },
    location: request.location,
  });
  assert.equal((await idemB.begin(request)).kind, "replay");

  const limiterA = first.createRateLimiter();
  const limiterB = second.createRateLimiter();
  assert.equal(
    (await limiterA.consume("198.51.100.1", { limit: 2, windowMs: 60_000 }))
      .allowed,
    true,
  );
  assert.equal(
    (await limiterB.consume("198.51.100.1", { limit: 2, windowMs: 60_000 }))
      .allowed,
    true,
  );
  assert.equal(
    (await limiterA.consume("198.51.100.1", { limit: 2, windowMs: 60_000 }))
      .allowed,
    false,
  );
});

test("storage health is READY only after the transactional capability probe succeeds", async () => {
  const fixture = createRpcFixture();
  const state = createSupabaseSharedState({
    url: SUPABASE_URL,
    serviceKey: SECRET,
    fetchImpl: fixture.fetchImpl,
    now: () => Date.parse("2026-07-31T01:02:03.000Z"),
  });

  fixture.setProbeReady(false);
  assert.deepEqual(await state.probe(), {
    ready: false,
    state: "PROBE_FAILED",
    verifiedAt: null,
  });
  fixture.setProbeReady(true);
  assert.deepEqual(await state.probe(), {
    ready: true,
    state: "READY",
    verifiedAt: "2026-07-31T01:02:03.000Z",
  });
});

test("reviewed setup SQL keeps shared tables server-only with explicit grants and RLS", async () => {
  const sql = await readFile(
    new URL("../supabase/shared-state-setup.sql", import.meta.url),
    "utf8",
  );

  for (const table of [
    "heuknalssi_shared_state",
    "heuknalssi_rate_limits",
    "heuknalssi_device_backups",
  ]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, "i"));
    assert.match(sql, new RegExp(`grant select, insert, update, delete on table public\\.${table} to service_role`, "i"));
  }
  assert.doesNotMatch(sql, /grant\s+.+\s+to\s+(?:anon|authenticated)/iu);
  assert.match(sql, /security invoker/iu);
  assert.match(sql, /revoke all on function public\.heuknalssi_shared_state_probe/iu);
  assert.match(sql, /grant execute on function public\.heuknalssi_shared_state_probe/iu);
  assert.match(sql, /revoke all on function public\.save_device_backup/iu);
  assert.match(sql, /grant execute on function public\.load_device_backup/iu);
  assert.match(sql, /insert into storage\.buckets/iu);
  assert.match(sql, /'farm-photos'[\s\S]*false[\s\S]*10485760/iu);
  assert.match(sql, /array\['image\/jpeg', 'image\/png', 'image\/webp'\]/iu);
});
