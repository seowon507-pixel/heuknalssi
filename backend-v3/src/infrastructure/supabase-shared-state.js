import { createHash, randomUUID } from "node:crypto";

import { createSupabaseServerHeaders } from "./supabase-server-headers.js";

const NAMESPACE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
const MAX_KEY_LENGTH = 512;
const DEFAULT_TIMEOUT_MS = 6_000;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function assertNamespace(namespace) {
  if (typeof namespace !== "string" || !NAMESPACE_PATTERN.test(namespace)) {
    throw new TypeError("shared-state namespace is invalid");
  }
}

function assertKey(key) {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > MAX_KEY_LENGTH
  ) {
    throw new TypeError("shared-state key must contain 1-512 characters");
  }
}

function assertTtl(ttlMs, label = "shared-state ttlMs") {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function hashKey(prefix, value) {
  return createHash("sha256")
    .update(`${prefix}:${value}`, "utf8")
    .digest("hex");
}

export class SharedStateError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "SharedStateError";
    this.code = code;
  }
}

/**
 * Server-only Supabase Data API client for short-lived correctness state.
 * All public-schema objects are reached through explicitly granted RPCs; the
 * secret/service-role value is accepted only by this backend composition.
 */
export function createSupabaseSharedState({
  url,
  serviceKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
  probeId = randomUUID,
} = {}) {
  const configured =
    typeof url === "string" &&
    url.trim() !== "" &&
    typeof serviceKey === "string" &&
    serviceKey.trim() !== "";
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("shared-state timeoutMs must be a positive integer");
  }
  if (typeof now !== "function" || typeof probeId !== "function") {
    throw new TypeError("now and probeId must be functions");
  }

  const endpoint = configured
    ? `${url.trim().replace(/\/$/u, "")}/rest/v1/rpc`
    : null;

  async function callRpc(name, args) {
    if (!configured) {
      throw new SharedStateError(
        "SHARED_STATE_NOT_CONFIGURED",
        "shared state is not configured",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${endpoint}/${name}`, {
        method: "POST",
        body: JSON.stringify(args),
        signal: controller.signal,
        headers: createSupabaseServerHeaders(serviceKey),
      });
      if (!response.ok) {
        throw new SharedStateError(
          "SHARED_STATE_RPC_REJECTED",
          "shared state rejected the operation",
        );
      }
      const text = await response.text();
      if (text === "") return null;
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new SharedStateError(
          "SHARED_STATE_INVALID_RESPONSE",
          "shared state returned an invalid response",
          { cause: error },
        );
      }
    } catch (error) {
      if (error instanceof SharedStateError) throw error;
      throw new SharedStateError(
        "SHARED_STATE_UNAVAILABLE",
        "shared state is unavailable",
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  function createTtlStore(namespace) {
    assertNamespace(namespace);
    return Object.freeze({
      async get(key) {
        assertKey(key);
        const value = await callRpc("heuknalssi_shared_state_get", {
          p_namespace: namespace,
          p_key: key,
        });
        return value === null ? undefined : clone(value);
      },

      async set(key, value, ttlMs) {
        assertKey(key);
        assertTtl(ttlMs);
        await callRpc("heuknalssi_shared_state_set", {
          p_namespace: namespace,
          p_key: key,
          p_value: value,
          p_ttl_ms: ttlMs,
        });
        return clone(value);
      },

      async delete(key) {
        assertKey(key);
        return Boolean(
          await callRpc("heuknalssi_shared_state_delete", {
            p_namespace: namespace,
            p_key: key,
          }),
        );
      },

      async setIfAbsent(key, value, ttlMs) {
        assertKey(key);
        assertTtl(ttlMs);
        return Boolean(
          await callRpc("heuknalssi_shared_state_set_if_absent", {
            p_namespace: namespace,
            p_key: key,
            p_value: value,
            p_ttl_ms: ttlMs,
          }),
        );
      },

      async compareAndSet(key, expected, value, ttlMs) {
        assertKey(key);
        assertTtl(ttlMs);
        return Boolean(
          await callRpc("heuknalssi_shared_state_compare_and_set", {
            p_namespace: namespace,
            p_key: key,
            p_expected: expected,
            p_value: value,
            p_ttl_ms: ttlMs,
          }),
        );
      },
    });
  }

  function createIdempotencyStore({ ttlMs = 10 * 60 * 1_000 } = {}) {
    assertTtl(ttlMs, "idempotency ttlMs");

    function scopeKey({ ownerSessionId, route, key }) {
      return hashKey(
        "heuknalssi-idempotency",
        JSON.stringify([ownerSessionId, route, key]),
      );
    }

    return Object.freeze({
      async begin({ ownerSessionId, route, key, payloadHash, location }) {
        const scope = scopeKey({ ownerSessionId, route, key });
        const result = await callRpc("heuknalssi_idempotency_begin", {
          p_namespace: "idempotency",
          p_key: scope,
          p_payload_hash: payloadHash,
          p_location: location,
          p_ttl_ms: ttlMs,
        });
        if (!result || typeof result.kind !== "string") {
          throw new SharedStateError(
            "SHARED_STATE_INVALID_RESPONSE",
            "idempotency RPC returned an invalid response",
          );
        }
        if (result.kind === "started") {
          return {
            kind: "started",
            location,
            token: Object.freeze({ scope, payloadHash }),
          };
        }
        if (result.kind === "replay") {
          return { kind: "replay", response: clone(result.response) };
        }
        if (result.kind === "in_progress") {
          return { kind: "in_progress", location: result.location };
        }
        if (result.kind === "conflict") return { kind: "conflict" };
        throw new SharedStateError(
          "SHARED_STATE_INVALID_RESPONSE",
          "idempotency RPC returned an unsupported state",
        );
      },

      async complete(token, response) {
        return Boolean(
          await callRpc("heuknalssi_idempotency_complete", {
            p_namespace: "idempotency",
            p_key: token.scope,
            p_payload_hash: token.payloadHash,
            p_response: response,
            p_ttl_ms: ttlMs,
          }),
        );
      },

      async fail(token) {
        return Boolean(
          await callRpc("heuknalssi_idempotency_fail", {
            p_namespace: "idempotency",
            p_key: token.scope,
            p_payload_hash: token.payloadHash,
          }),
        );
      },
    });
  }

  function createRateLimiter() {
    return Object.freeze({
      async consume(key, { limit, windowMs }) {
        if (!Number.isSafeInteger(limit) || limit <= 0) {
          throw new TypeError("rate limit must be a positive integer");
        }
        assertTtl(windowMs, "rate-limit windowMs");
        const result = await callRpc("heuknalssi_rate_limit_consume", {
          p_bucket_key: hashKey("heuknalssi-rate-limit", key),
          p_limit: limit,
          p_window_ms: windowMs,
        });
        if (!result || typeof result.allowed !== "boolean") {
          throw new SharedStateError(
            "SHARED_STATE_INVALID_RESPONSE",
            "rate-limit RPC returned an invalid response",
          );
        }
        return {
          allowed: result.allowed,
          capacityLimited: false,
          limit,
          remaining: Number.isSafeInteger(result.remaining)
            ? Math.max(0, result.remaining)
            : 0,
          resetAt: Number.isFinite(result.resetAt)
            ? result.resetAt
            : now() + windowMs,
          retryAfterSeconds: result.allowed
            ? 0
            : Number.isSafeInteger(result.retryAfterSeconds)
              ? Math.max(1, result.retryAfterSeconds)
              : Math.max(1, Math.ceil(windowMs / 1_000)),
        };
      },
    });
  }

  async function probe() {
    if (!configured) {
      return {
        ready: false,
        state: "NOT_CONFIGURED",
        verifiedAt: null,
      };
    }
    try {
      const ready = await callRpc("heuknalssi_shared_state_probe", {
        p_probe_id: String(probeId()),
      });
      return ready === true
        ? {
            ready: true,
            state: "READY",
            verifiedAt: new Date(now()).toISOString(),
          }
        : {
            ready: false,
            state: "PROBE_FAILED",
            verifiedAt: null,
          };
    } catch {
      return {
        ready: false,
        state: "UNAVAILABLE",
        verifiedAt: null,
      };
    }
  }

  return Object.freeze({
    configured,
    createIdempotencyStore,
    createRateLimiter,
    createTtlStore,
    probe,
  });
}

export const supabaseSharedStateDefaults = Object.freeze({
  timeoutMs: DEFAULT_TIMEOUT_MS,
});
