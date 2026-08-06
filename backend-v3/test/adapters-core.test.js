import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AdapterError,
  DEFAULT_PROVIDER_RESPONSE_MAX_BYTES,
  InMemoryAdapterCache,
  ProviderExecutionGuard,
  SchemaChangedError,
  SingleFlight,
  assertAllowedProviderUrl,
  classifyProviderError,
  createAdapterRegistry,
  createDataEnvelope,
  fetchWithDeadline,
  makeAdapterCacheKey,
  parseStrictFiniteNumber,
  requestProviderJson,
  requestProviderText,
  validateDataEnvelope
} from "../src/adapters/index.js";

const FIXED_NOW = new Date("2026-07-23T00:00:00.000Z");

function envelope(overrides = {}) {
  return createDataEnvelope(
    {
      sourceId: "fixture",
      sourceName: "Fixture Provider",
      sourceUrl: "https://apis.data.go.kr/fixture",
      retrievedAt: "2026-07-22T23:59:00.000Z",
      observedAt: null,
      issuedAt: "2026-07-22T23:00:00.000Z",
      validFrom: "2026-07-23T00:00:00.000Z",
      validTo: "2026-07-23T03:00:00.000Z",
      spatialLevel: "FORECAST_REGION",
      spatialLabel: "fixture region",
      distanceKm: null,
      unit: null,
      deliveryState: "LIVE",
      adapterState: "SUCCESS",
      qualityFlags: ["VERIFIED_FIXTURE"],
      cacheMeta: null,
      data: { days: [] },
      provenance: {
        adapterId: "fixture",
        adapterVersion: "1",
        operationId: "fixture-operation",
        contractVersion: "fixture-v1",
        providerIssueTime: "2026-07-22T23:00:00.000Z"
      },
      ...overrides
    },
    { now: () => FIXED_NOW }
  );
}

test("strict finite-number parser preserves official missing values as null", () => {
  assert.equal(parseStrictFiniteNumber(null), null);
  assert.equal(parseStrictFiniteNumber(undefined), null);
  assert.equal(parseStrictFiniteNumber(""), null);
  assert.equal(parseStrictFiniteNumber("   "), null);
  assert.equal(parseStrictFiniteNumber("-"), null);
  assert.equal(parseStrictFiniteNumber("0"), 0);
  assert.equal(parseStrictFiniteNumber(0), 0);
  assert.equal(parseStrictFiniteNumber("-1.25e2"), -125);
});

test("strict finite-number parser rejects non-finite, malformed, and out-of-range values", () => {
  for (const value of [NaN, Infinity, "Infinity", "0x10", true, [], {}]) {
    assert.throws(
      () => parseStrictFiniteNumber(value),
      SchemaChangedError,
      String(value)
    );
  }
  assert.throws(
    () => parseStrictFiniteNumber("101", { min: 0, max: 100 }),
    SchemaChangedError
  );
});

test("DataEnvelope validates provenance and keeps timestamps semantically separate", () => {
  const result = envelope();
  assert.equal(result.observedAt, null);
  assert.equal(result.issuedAt, "2026-07-22T23:00:00.000Z");
  assert.equal(result.freshness, "CURRENT");
  assert.deepEqual(validateDataEnvelope(result), { valid: true, errors: [] });

  const invalid = structuredClone(result);
  invalid.provenance.adapterVersion = "";
  assert.equal(validateDataEnvelope(invalid).valid, false);
});

test("official reference datasets remain usable without being labeled live", () => {
  const result = envelope({
    deliveryState: "REFERENCE",
    spatialLevel: "REFERENCE_DATASET",
    spatialLabel: "KMA 1991-2020 climate normals",
  });

  assert.equal(result.deliveryState, "REFERENCE");
  assert.equal(result.freshness, "CURRENT");
  assert.deepEqual(validateDataEnvelope(result), { valid: true, errors: [] });
});

test("cached envelopes mark stale metadata and expire without returning data", () => {
  const stale = createDataEnvelope(
    {
      ...envelope(),
      deliveryState: "CACHE",
      cacheMeta: {
        storedAt: "2026-07-22T20:00:00.000Z",
        freshUntil: "2026-07-22T23:00:00.000Z",
        staleUntil: "2026-07-23T01:00:00.000Z"
      }
    },
    { now: () => FIXED_NOW }
  );
  assert.equal(stale.freshness, "STALE");
  assert.ok(stale.qualityFlags.includes("STALE"));
  assert.notEqual(stale.data, null);

  const expired = createDataEnvelope(
    {
      ...envelope(),
      deliveryState: "CACHE",
      cacheMeta: {
        storedAt: "2026-07-22T20:00:00.000Z",
        freshUntil: "2026-07-22T21:00:00.000Z",
        staleUntil: "2026-07-22T22:00:00.000Z"
      }
    },
    { now: () => FIXED_NOW }
  );
  assert.equal(expired.deliveryState, "UNAVAILABLE");
  assert.equal(expired.data, null);
  assert.ok(expired.qualityFlags.includes("CACHE_EXPIRED"));
});

test("provider classification is sanitized and follows retry boundaries", () => {
  const cases = [
    [401, "AUTH_ERROR", false],
    [403, "AUTH_ERROR", false],
    [429, "RATE_LIMITED", true],
    [500, "INTERNAL_ERROR", true],
    [503, "INTERNAL_ERROR", true],
    [400, "INTERNAL_ERROR", false]
  ];
  for (const [status, adapterState, retryable] of cases) {
    const result = classifyProviderError({
      status,
      headers: new Headers(status === 429 ? { "retry-after": "2" } : {})
    });
    assert.equal(result.adapterState, adapterState);
    assert.equal(result.retryable, retryable);
    assert.equal("body" in result, false);
    assert.equal("url" in result, false);
  }
  assert.equal(
    classifyProviderError(new SchemaChangedError()).adapterState,
    "SCHEMA_CHANGED"
  );
  assert.equal(
    classifyProviderError(new DOMException("aborted", "AbortError")).adapterState,
    "TIMEOUT"
  );
});

test("provider URLs require HTTPS and an exact fixed host allowlist", () => {
  assert.equal(
    assertAllowedProviderUrl(
      "https://dapi.kakao.com/v2/local/search/address.json",
      "KAKAO"
    ).hostname,
    "dapi.kakao.com"
  );
  assert.throws(
    () =>
      assertAllowedProviderUrl(
        "http://dapi.kakao.com/v2/local/search/address.json",
        "KAKAO"
      ),
    /HTTPS/
  );
  assert.throws(
    () =>
      assertAllowedProviderUrl(
        "https://dapi.kakao.com.attacker.invalid/path",
        "KAKAO"
      ),
    /allowlist/
  );
  assert.throws(
    () =>
      assertAllowedProviderUrl(
        "https://user:secret@dapi.kakao.com/path",
        "KAKAO"
      ),
    /user information/
  );
});

test("JSON and XML provider reads enforce the default response byte cap", async () => {
  for (const [label, request, bodyMethod] of [
    ["JSON", requestProviderJson, "json"],
    ["XML", requestProviderText, "text"]
  ]) {
    let bodyReads = 0;
    await assert.rejects(
      request({
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: new Headers({
            "content-length": String(
              DEFAULT_PROVIDER_RESPONSE_MAX_BYTES + 1
            )
          }),
          async [bodyMethod]() {
            bodyReads += 1;
            return bodyMethod === "json" ? {} : "<response/>";
          }
        }),
        url: "https://dapi.kakao.com/v2/local/search/address.json",
        provider: "KAKAO",
        timeoutMs: 100
      }),
      (error) =>
        error.adapterState === "SCHEMA_CHANGED" &&
        error.code === "PROVIDER_RESPONSE_TOO_LARGE",
      label
    );
    assert.equal(bodyReads, 0, `${label} body should not be buffered`);
  }
});

test("streamed provider bodies are cancelled when the byte cap is crossed", async () => {
  for (const [request, body] of [
    [requestProviderJson, JSON.stringify({ value: "x".repeat(64) })],
    [requestProviderText, `<response>${"x".repeat(64)}</response>`]
  ]) {
    await assert.rejects(
      request({
        fetchImpl: async () => new Response(body),
        url: "https://dapi.kakao.com/v2/local/search/address.json",
        provider: "KAKAO",
        timeoutMs: 100,
        maxResponseBytes: 32
      }),
      (error) =>
        error.adapterState === "SCHEMA_CHANGED" &&
        error.code === "PROVIDER_RESPONSE_TOO_LARGE"
    );
  }
});

test("invalid JSON classification does not retain provider body text", async () => {
  const secretBody = "secret-provider-body";
  await assert.rejects(
    requestProviderJson({
      fetchImpl: async () => new Response(secretBody),
      url: "https://dapi.kakao.com/v2/local/search/address.json",
      provider: "KAKAO",
      timeoutMs: 100
    }),
    (error) => {
      assert.equal(error.code, "PROVIDER_INVALID_JSON");
      assert.equal(error.adapterState, "SCHEMA_CHANGED");
      assert.equal(error.cause, undefined);
      assert.equal(error.message.includes(secretBody), false);
      return true;
    }
  );
});

test("network and 5xx retry uses one injected short jittered backoff", async () => {
  let calls = 0;
  const delays = [];
  const backoffInputs = [];
  const result = await requestProviderJson({
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response("temporary", { status: 503 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    url: "https://dapi.kakao.com/v2/local/search/address.json",
    provider: "KAKAO",
    timeoutMs: 100,
    deadlineAt: 1100,
    now: () => 1000,
    retryBackoff: (input) => {
      backoffInputs.push(input);
      return 7;
    },
    delay: async (delayMs) => {
      delays.push(delayMs);
    }
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [7]);
  assert.equal(backoffInputs.length, 1);
  assert.equal(backoffInputs[0].attempt, 1);
});

test("retry backoff never starts when it cannot fit inside the deadline", async () => {
  let calls = 0;
  let delays = 0;
  await assert.rejects(
    requestProviderJson({
      fetchImpl: async () => {
        calls += 1;
        return new Response("temporary", { status: 503 });
      },
      url: "https://dapi.kakao.com/v2/local/search/address.json",
      provider: "KAKAO",
      timeoutMs: 100,
      deadlineAt: 1020,
      now: () => 1000,
      retryBackoff: () => 20,
      delay: async () => {
        delays += 1;
      }
    }),
    (error) => error.code === "PROVIDER_SERVER_ERROR"
  );
  assert.equal(calls, 1);
  assert.equal(delays, 0);
});

test("deadline helper aborts the child fetch and forwards parent cancellation", async () => {
  let timeoutSignal;
  const neverFetch = (_url, { signal }) => {
    timeoutSignal = signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true }
      );
    });
  };

  await assert.rejects(
    fetchWithDeadline({
      fetchImpl: neverFetch,
      url: "https://dapi.kakao.com/v2/local/search/address.json",
      provider: "KAKAO",
      timeoutMs: 5
    }),
    (error) => error.adapterState === "TIMEOUT"
  );
  assert.equal(timeoutSignal.aborted, true);

  const parent = new AbortController();
  let childSignal;
  const parentFetch = (_url, { signal }) => {
    childSignal = signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true
      });
    });
  };
  const pending = fetchWithDeadline({
    fetchImpl: parentFetch,
    url: "https://dapi.kakao.com/v2/local/search/address.json",
    provider: "KAKAO",
    timeoutMs: 1000,
    signal: parent.signal
  });
  parent.abort(new Error("caller cancelled"));
  await assert.rejects(pending, /caller cancelled/);
  assert.equal(childSignal.aborted, true);
});

test("an already elapsed overall deadline performs zero fetches", async () => {
  let calls = 0;
  await assert.rejects(
    fetchWithDeadline({
      fetchImpl: async () => {
        calls += 1;
      },
      url: "https://dapi.kakao.com/v2/local/search/address.json",
      provider: "KAKAO",
      timeoutMs: 100,
      deadlineAt: Date.now() - 1
    }),
    (error) => error.adapterState === "TIMEOUT"
  );
  assert.equal(calls, 0);
});

test("default-disabled registry and enabled adapter without a key make zero calls", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("must not be called");
  };
  const disabled = createAdapterRegistry({ common: { fetchImpl } });
  const disabledResult = await disabled.kakao.searchLocations("서울");
  assert.equal(disabledResult.adapterState, "UNSUPPORTED");
  assert.equal(disabledResult.deliveryState, "UNAVAILABLE");

  const unconfigured = createAdapterRegistry({
    common: { fetchImpl },
    kakao: { enabled: true }
  });
  const missingKeyResult = await unconfigured.kakao.searchLocations("서울");
  assert.equal(missingKeyResult.deliveryState, "UNAVAILABLE");
  assert.ok(missingKeyResult.qualityFlags.includes("CREDENTIAL_UNAVAILABLE"));
  assert.equal(calls, 0);
});

test("cache key isolates period and issue time and rejects sensitive material", () => {
  const base = {
    adapterVersion: "1",
    operationId: "forecast",
    verifiedLocationKey: { nx: 60, ny: 127 },
    requestedPeriod: { from: "2026-07-23", to: "2026-07-25" },
    providerIssueTime: "2026-07-23T00:00:00.000Z",
    normalizedParameters: { crop: "APPLE" }
  };
  const first = makeAdapterCacheKey(base);
  const second = makeAdapterCacheKey({
    ...base,
    providerIssueTime: "2026-07-23T06:00:00.000Z"
  });
  assert.notEqual(first, second);
  for (const variant of [
    { ...base, adapterVersion: "2" },
    { ...base, operationId: "forecast-other-operation" },
    { ...base, verifiedLocationKey: { nx: 61, ny: 127 } },
    {
      ...base,
      requestedPeriod: { from: "2026-07-24", to: "2026-07-25" }
    },
    {
      ...base,
      normalizedParameters: {
        crop: "APPLE",
        contractVersion: "provider-contract-v2"
      }
    }
  ]) {
    assert.notEqual(first, makeAdapterCacheKey(variant));
  }
  assert.throws(
    () =>
      makeAdapterCacheKey({
        ...base,
        normalizedParameters: { apiKey: "do-not-store" }
      }),
    /forbidden/
  );
});

test("in-memory cache requires explicit stale use and preserves warning metadata", () => {
  let clock = Date.parse("2026-07-23T00:00:00.000Z");
  const cache = new InMemoryAdapterCache({ now: () => clock });
  assert.equal(
    cache.set("forecast", envelope(), {
      freshForMs: 1000,
      staleForMs: 1000
    }),
    true
  );
  assert.equal(cache.get("forecast").freshness, "CURRENT");

  clock += 1500;
  assert.equal(cache.get("forecast"), null);
  const stale = cache.get("forecast", { allowStale: true });
  assert.equal(stale.freshness, "STALE");
  assert.ok(stale.qualityFlags.includes("STALE"));
  assert.ok(stale.qualityFlags.includes("VERIFIED_FIXTURE"));

  clock += 1000;
  assert.equal(cache.get("forecast", { allowStale: true }), null);
});

test("in-memory cache rejects TTLs above its configured bound", () => {
  const cache = new InMemoryAdapterCache({ maxTtlMs: 1000 });
  assert.throws(
    () =>
      cache.set("forecast", envelope(), {
        freshForMs: 1001,
        staleForMs: 0
      }),
    /TTL exceeds/
  );
});

test("single-flight shares upstream work while isolating waiter cancellation", async () => {
  const flight = new SingleFlight();
  let calls = 0;
  let upstreamSignal;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const operation = async (signal) => {
    calls += 1;
    upstreamSignal = signal;
    await gate;
    return { ok: true };
  };
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = flight.run("same", operation, {
    signal: firstController.signal
  });
  const second = flight.run("same", operation, {
    signal: secondController.signal
  });
  assert.notStrictEqual(first, second);
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  firstController.abort();
  await assert.rejects(first, (error) => error.name === "AbortError");
  assert.equal(upstreamSignal.aborted, false);
  release();
  assert.deepEqual(await second, { ok: true });
  assert.equal(calls, 1);
  assert.equal(flight.size, 0);
});

test("single-flight aborts upstream only after every waiter leaves", async () => {
  const flight = new SingleFlight();
  let upstreamAborted = false;
  const firstController = new AbortController();
  const secondController = new AbortController();
  const operation = (signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          upstreamAborted = true;
          reject(signal.reason);
        },
        { once: true }
      );
    });

  const first = flight.run("same", operation, {
    signal: firstController.signal
  });
  const second = flight.run("same", operation, {
    signal: secondController.signal
  });
  await Promise.resolve();
  firstController.abort();
  await assert.rejects(first, (error) => error.name === "AbortError");
  assert.equal(upstreamAborted, false);
  secondController.abort();
  await assert.rejects(second, (error) => error.name === "AbortError");
  await Promise.resolve();
  assert.equal(upstreamAborted, true);
  assert.equal(flight.size, 0);
});

test("single-flight waiter deadline expires without aborting a live peer", async () => {
  const flight = new SingleFlight();
  let upstreamSignal;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const operation = async (signal) => {
    upstreamSignal = signal;
    await gate;
    return "done";
  };
  const first = flight.run("same", operation, {
    deadlineAt: Date.now() + 5
  });
  const second = flight.run("same", operation, {
    deadlineAt: Date.now() + 1000
  });

  await assert.rejects(first, (error) => error.adapterState === "TIMEOUT");
  assert.equal(upstreamSignal.aborted, false);
  release();
  assert.equal(await second, "done");
});

test("provider execution guard bounds concurrency and fails closed at queue capacity", async () => {
  const guard = new ProviderExecutionGuard({
    provider: "KMA",
    maxConcurrency: 1,
    maxQueue: 1
  });
  let firstRelease;
  let secondRelease;
  let secondStarted = false;
  const first = guard.run(
    () =>
      new Promise((resolve) => {
        firstRelease = resolve;
      })
  );
  await Promise.resolve();
  const second = guard.run(
    () =>
      new Promise((resolve) => {
        secondStarted = true;
        secondRelease = resolve;
      })
  );
  await assert.rejects(
    guard.run(async () => "must not run"),
    (error) =>
      error.adapterState === "RATE_LIMITED" &&
      error.code === "PROVIDER_CONCURRENCY_SATURATED"
  );
  assert.equal(secondStarted, false);

  firstRelease("first");
  assert.equal(await first, "first");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondStarted, true);
  secondRelease("second");
  assert.equal(await second, "second");
});

test("provider execution guard opens after bounded failures and recovers after cooldown", async () => {
  let clock = 1000;
  let calls = 0;
  const guard = new ProviderExecutionGuard({
    provider: "KAKAO",
    maxConcurrency: 1,
    maxQueue: 0,
    failureThreshold: 2,
    circuitCooldownMs: 100,
    now: () => clock
  });
  const fail = async () => {
    calls += 1;
    throw new AdapterError("fixture transient failure", {
      adapterState: "INTERNAL_ERROR",
      code: "PROVIDER_SERVER_ERROR",
      retryable: true
    });
  };
  await assert.rejects(guard.run(fail), /fixture transient/);
  await assert.rejects(guard.run(fail), /fixture transient/);
  await assert.rejects(
    guard.run(async () => {
      calls += 1;
      return "must not run";
    }),
    (error) =>
      error.adapterState === "RATE_LIMITED" &&
      error.code === "PROVIDER_CIRCUIT_OPEN"
  );
  assert.equal(calls, 2);

  clock += 101;
  const recovered = await guard.run(async () => {
    calls += 1;
    return "recovered";
  });
  assert.equal(recovered, "recovered");
  assert.equal(calls, 3);
});
