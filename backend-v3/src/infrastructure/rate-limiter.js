import {
  StoreCapacityError,
  TtlMemoryStore,
} from "./ttl-memory-store.js";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_BUCKETS = 50_000;

export class FixedWindowRateLimiter {
  #clock;
  #store;

  constructor({
    clock = Date.now,
    maxEntries = DEFAULT_MAX_BUCKETS,
    store,
  } = {}) {
    if (typeof clock !== "function") {
      throw new TypeError("clock must be a function");
    }
    this.#clock = clock;
    this.#store =
      store ??
      new TtlMemoryStore({
        capacityPolicy: "reject",
        clock,
        maxEntries,
      });
  }

  consume(key, { limit, windowMs = DEFAULT_WINDOW_MS }) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError("rate limit must be a positive integer");
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new TypeError("rate-limit windowMs must be positive");
    }

    const now = this.#clock();
    let bucket = this.#store.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = {
        count: 0,
        resetAt: now + windowMs,
      };
    }

    if (bucket.count >= limit) {
      return {
        allowed: false,
        capacityLimited: false,
        limit,
        remaining: 0,
        resetAt: bucket.resetAt,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((bucket.resetAt - now) / 1_000),
        ),
      };
    }

    bucket.count += 1;
    try {
      this.#store.set(key, bucket, Math.max(1, bucket.resetAt - now));
    } catch (error) {
      if (!(error instanceof StoreCapacityError)) {
        throw error;
      }
      return {
        allowed: false,
        capacityLimited: true,
        limit,
        remaining: 0,
        resetAt: now + windowMs,
        retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1_000)),
      };
    }
    return {
      allowed: true,
      capacityLimited: false,
      limit,
      remaining: limit - bucket.count,
      resetAt: bucket.resetAt,
      retryAfterSeconds: 0,
    };
  }
}

export const rateLimitDefaults = Object.freeze({
  maxEntries: DEFAULT_MAX_BUCKETS,
  windowMs: DEFAULT_WINDOW_MS,
});
