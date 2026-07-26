import { createHash, createHmac } from "node:crypto";

import {
  assertDataEnvelope,
  createDataEnvelope
} from "./data-envelope.js";
import { DeadlineExceededError } from "./errors.js";

const FORBIDDEN_CACHE_KEY_NAMES =
  /(?:api.?key|authorization|credential|password|secret|token|full.?address|latitude|longitude|raw.?coordinate)/i;

function assertNoSensitiveKeyMaterial(value, path = "cacheKey") {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoSensitiveKeyMaterial(entry, `${path}[${index}]`)
    );
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_CACHE_KEY_NAMES.test(key)) {
      throw new TypeError(`${path}.${key} is forbidden in an adapter cache key.`);
    }
    assertNoSensitiveKeyMaterial(entry, `${path}.${key}`);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

export function makeAdapterCacheKey({
  adapterVersion,
  operationId,
  verifiedLocationKey,
  requestedPeriod,
  providerIssueTime,
  normalizedParameters
}) {
  if (
    typeof adapterVersion !== "string" ||
    !adapterVersion ||
    typeof operationId !== "string" ||
    !operationId
  ) {
    throw new TypeError("adapterVersion and operationId are required.");
  }
  const material = {
    adapterVersion,
    operationId,
    verifiedLocationKey: verifiedLocationKey ?? null,
    requestedPeriod: requestedPeriod ?? null,
    providerIssueTime: providerIssueTime ?? null,
    normalizedParameters: normalizedParameters ?? null
  };
  assertNoSensitiveKeyMaterial(material);
  const digest = createHash("sha256")
    .update(JSON.stringify(stableValue(material)))
    .digest("hex");
  return `${adapterVersion}:${operationId}:${digest}`;
}

export function hmacCacheValue(value, secret) {
  if (
    !(
      (typeof secret === "string" && secret.length >= 16) ||
      (ArrayBuffer.isView(secret) && secret.byteLength >= 16)
    )
  ) {
    throw new TypeError("A cache HMAC secret of at least 16 bytes is required.");
  }
  return createHmac("sha256", secret).update(String(value)).digest("hex");
}

function clockMs(now) {
  const value = now();
  const ms = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(ms)) throw new TypeError("Cache clock is invalid.");
  return ms;
}

function clone(value) {
  return structuredClone(value);
}

export class InMemoryAdapterCache {
  #entries = new Map();
  #maxEntries;
  #maxTtlMs;
  #now;

  constructor({
    maxEntries = 100,
    maxTtlMs = 7 * 24 * 60 * 60 * 1000,
    now = () => Date.now()
  } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("maxEntries must be a positive integer.");
    }
    if (!Number.isFinite(maxTtlMs) || maxTtlMs <= 0) {
      throw new TypeError("maxTtlMs must be a positive finite number.");
    }
    this.#maxEntries = maxEntries;
    this.#maxTtlMs = maxTtlMs;
    this.#now = now;
  }

  get size() {
    return this.#entries.size;
  }

  set(
    key,
    envelope,
    { freshForMs, staleForMs = 0, allowNegative = false } = {}
  ) {
    if (typeof key !== "string" || key === "") {
      throw new TypeError("Cache key must be a non-empty string.");
    }
    assertDataEnvelope(envelope);
    if (!Number.isFinite(freshForMs) || freshForMs < 0) {
      throw new TypeError("freshForMs must be a non-negative finite number.");
    }
    if (!Number.isFinite(staleForMs) || staleForMs < 0) {
      throw new TypeError("staleForMs must be a non-negative finite number.");
    }
    if (freshForMs + staleForMs > this.#maxTtlMs) {
      throw new TypeError("Adapter cache TTL exceeds its configured bound.");
    }
    if (
      envelope.deliveryState !== "LIVE" ||
      (envelope.adapterState !== "SUCCESS" &&
        !(allowNegative && envelope.adapterState === "NO_DATA"))
    ) {
      return false;
    }

    const storedMs = clockMs(this.#now);
    const cacheMeta = {
      storedAt: new Date(storedMs).toISOString(),
      freshUntil: new Date(storedMs + freshForMs).toISOString(),
      staleUntil: new Date(storedMs + freshForMs + staleForMs).toISOString()
    };
    this.#entries.delete(key);
    this.#entries.set(key, { envelope: clone(envelope), cacheMeta });
    while (this.#entries.size > this.#maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
    return true;
  }

  get(key, { allowStale = false } = {}) {
    const entry = this.#entries.get(key);
    if (!entry) return null;

    const nowMs = clockMs(this.#now);
    if (nowMs > Date.parse(entry.cacheMeta.staleUntil)) {
      this.#entries.delete(key);
      return null;
    }
    const cached = createDataEnvelope(
      {
        ...clone(entry.envelope),
        deliveryState: "CACHE",
        cacheMeta: clone(entry.cacheMeta)
      },
      { now: () => new Date(nowMs) }
    );
    if (cached.freshness === "STALE" && !allowStale) return null;

    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return cached;
  }

  delete(key) {
    return this.#entries.delete(key);
  }

  clear() {
    this.#entries.clear();
  }
}

export class SingleFlight {
  #inFlight = new Map();

  get size() {
    return this.#inFlight.size;
  }

  run(
    key,
    operation,
    {
      signal,
      deadlineAt,
      now = () => Date.now(),
      setTimer = setTimeout,
      clearTimer = clearTimeout
    } = {}
  ) {
    if (typeof key !== "string" || key === "") {
      throw new TypeError("Single-flight key must be a non-empty string.");
    }
    if (typeof operation !== "function") {
      throw new TypeError("Single-flight operation must be a function.");
    }
    const deadlineMs = normalizeDeadline(deadlineAt);
    const nowMs = Number(now());
    if (!Number.isFinite(nowMs)) {
      throw new TypeError("Single-flight clock is invalid.");
    }
    if (signal?.aborted) {
      return Promise.reject(waiterAbortError(signal));
    }
    if (deadlineMs <= nowMs) {
      return Promise.reject(new DeadlineExceededError());
    }

    let entry = this.#inFlight.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = {
        controller,
        promise: null,
        settled: false,
        waiters: new Set()
      };
      entry.promise = Promise.resolve()
        .then(() => operation(controller.signal))
        .finally(() => {
          entry.settled = true;
          if (this.#inFlight.get(key) === entry) {
            this.#inFlight.delete(key);
          }
        });
      this.#inFlight.set(key, entry);
    }

    return new Promise((resolve, reject) => {
      let timer = null;
      let finished = false;
      const waiter = {};
      const cleanup = () => {
        if (timer !== null) clearTimer(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (callback, value) => {
        if (finished) return;
        finished = true;
        cleanup();
        entry.waiters.delete(waiter);
        callback(value);
        if (entry.waiters.size === 0 && !entry.settled) {
          if (this.#inFlight.get(key) === entry) {
            this.#inFlight.delete(key);
          }
          entry.controller.abort(
            new DOMException("No active single-flight waiters.", "AbortError")
          );
        }
      };
      const onAbort = () => finish(reject, waiterAbortError(signal));
      entry.waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });

      if (deadlineMs !== Infinity) {
        timer = setTimer(
          () => finish(reject, new DeadlineExceededError()),
          Math.max(0, deadlineMs - nowMs)
        );
      }
      entry.promise.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      );
    });
  }
}

function normalizeDeadline(deadlineAt) {
  if (deadlineAt === null || deadlineAt === undefined) return Infinity;
  const value =
    deadlineAt instanceof Date
      ? deadlineAt.getTime()
      : typeof deadlineAt === "number"
        ? deadlineAt
        : Date.parse(deadlineAt);
  if (!Number.isFinite(value)) {
    throw new TypeError("Single-flight deadlineAt must be valid.");
  }
  return value;
}

function waiterAbortError(signal) {
  const reason = signal?.reason;
  if (reason?.name === "AbortError") return reason;
  return new DOMException("Adapter waiter aborted.", "AbortError");
}
