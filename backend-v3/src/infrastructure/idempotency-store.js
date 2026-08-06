import { createHash } from "node:crypto";

import { TtlMemoryStore } from "./ttl-memory-store.js";

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,64}$/;
const DEFAULT_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 10_000;

function stableSerialize(value, ancestors = new Set()) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (ancestors.has(value)) {
    throw new TypeError("payload must not contain cycles");
  }

  ancestors.add(value);
  let serialized;
  if (Array.isArray(value)) {
    serialized = `[${value.map((item) => stableSerialize(item, ancestors)).join(",")}]`;
  } else {
    const pairs = Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableSerialize(value[key], ancestors)}`,
      );
    serialized = `{${pairs.join(",")}}`;
  }
  ancestors.delete(value);
  return serialized;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function isValidIdempotencyKey(value) {
  return (
    typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value)
  );
}

export function hashNormalizedPayload(payload) {
  return createHash("sha256")
    .update(stableSerialize(payload), "utf8")
    .digest("base64url");
}

export class IdempotencyStore {
  #store;
  #ttlMs;

  constructor({
    clock = Date.now,
    maxEntries = DEFAULT_MAX_ENTRIES,
    store,
    ttlMs = DEFAULT_TTL_MS,
  } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError("idempotency ttlMs must be positive");
    }
    this.#store =
      store ??
      new TtlMemoryStore({
        capacityPolicy: "reject",
        clock,
        maxEntries,
      });
    this.#ttlMs = ttlMs;
  }

  begin({
    ownerSessionId,
    route,
    key,
    payloadHash,
    location,
  }) {
    if (!isValidIdempotencyKey(key)) {
      throw new TypeError("invalid idempotency key");
    }
    const scope = JSON.stringify([ownerSessionId, route, key]);
    const existing = this.#store.get(scope);

    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        return { kind: "conflict" };
      }
      if (existing.state === "completed") {
        return {
          kind: "replay",
          response: clone(existing.response),
        };
      }
      return {
        kind: "in_progress",
        location: existing.location,
      };
    }

    const token = Object.freeze({ scope, payloadHash });
    this.#store.set(
      scope,
      {
        state: "in_progress",
        payloadHash,
        location,
      },
      this.#ttlMs,
    );
    return {
      kind: "started",
      location,
      token,
    };
  }

  complete(token, response) {
    const existing = this.#store.get(token.scope);
    if (
      !existing ||
      existing.state !== "in_progress" ||
      existing.payloadHash !== token.payloadHash
    ) {
      return false;
    }
    this.#store.set(
      token.scope,
      {
        ...existing,
        state: "completed",
        response: clone(response),
      },
      this.#ttlMs,
    );
    return true;
  }

  fail(token) {
    const existing = this.#store.get(token.scope);
    if (
      existing?.state === "in_progress" &&
      existing.payloadHash === token.payloadHash
    ) {
      return this.#store.delete(token.scope);
    }
    return false;
  }
}

export const idempotencyDefaults = Object.freeze({
  maxEntries: DEFAULT_MAX_ENTRIES,
  ttlMs: DEFAULT_TTL_MS,
});
