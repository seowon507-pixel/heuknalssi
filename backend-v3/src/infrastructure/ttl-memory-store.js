import { isDeepStrictEqual } from "node:util";

function defaultClock() {
  return Date.now();
}

const DEFAULT_MAX_ENTRIES = 10_000;
const CAPACITY_POLICIES = new Set(["evict-soonest", "reject"]);

function assertPositiveTtl(ttlMs) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError("ttlMs must be a positive finite number");
  }
}

export class StoreCapacityError extends Error {
  constructor(maxEntries) {
    super("The in-memory store has reached its configured capacity.");
    this.name = "StoreCapacityError";
    this.code = "STORE_CAPACITY_EXCEEDED";
    this.maxEntries = maxEntries;
  }
}

/**
 * Process-local TTL storage for the MVP. Expired values are removed lazily,
 * and callers may invoke sweep() at convenient boundaries. At capacity it
 * either rejects the new key or deterministically evicts the entry that
 * expires soonest (oldest insertion wins ties).
 */
export class TtlMemoryStore {
  #capacityPolicy;
  #clock;
  #entries = new Map();
  #maxEntries;
  #sequence = 0;

  constructor({
    capacityPolicy = "evict-soonest",
    clock = defaultClock,
    maxEntries = DEFAULT_MAX_ENTRIES,
  } = {}) {
    if (typeof clock !== "function") {
      throw new TypeError("clock must be a function");
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new TypeError("maxEntries must be a positive safe integer");
    }
    if (!CAPACITY_POLICIES.has(capacityPolicy)) {
      throw new TypeError(
        'capacityPolicy must be "evict-soonest" or "reject"',
      );
    }
    this.#capacityPolicy = capacityPolicy;
    this.#clock = clock;
    this.#maxEntries = maxEntries;
  }

  set(key, value, ttlMs) {
    assertPositiveTtl(ttlMs);
    const now = this.#clock();
    const current = this.#entries.get(key);
    if (current?.expiresAt <= now) {
      this.#entries.delete(key);
    }

    if (!this.#entries.has(key) && this.#entries.size >= this.#maxEntries) {
      this.#sweepAt(now);
      if (this.#entries.size >= this.#maxEntries) {
        if (this.#capacityPolicy === "reject") {
          throw new StoreCapacityError(this.#maxEntries);
        }
        this.#evictOne();
      }
    }

    this.#sequence += 1;
    this.#entries.set(key, {
      value,
      expiresAt: now + ttlMs,
      sequence: this.#sequence,
    });
    return value;
  }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.#clock()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key) {
    const entry = this.#entries.get(key);
    if (!entry) {
      return false;
    }
    if (entry.expiresAt <= this.#clock()) {
      this.#entries.delete(key);
      return false;
    }
    return true;
  }

  delete(key) {
    return this.#entries.delete(key);
  }

  setIfAbsent(key, value, ttlMs) {
    if (this.has(key)) return false;
    this.set(key, value, ttlMs);
    return true;
  }

  compareAndSet(key, expected, value, ttlMs) {
    const current = this.get(key);
    if (!isDeepStrictEqual(current, expected)) return false;
    this.set(key, value, ttlMs);
    return true;
  }

  clear() {
    this.#entries.clear();
  }

  sweep() {
    return this.#sweepAt(this.#clock());
  }

  #sweepAt(now) {
    let deleted = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  #evictOne() {
    let hasSelection = false;
    let selectedKey;
    let selectedEntry;
    for (const [key, entry] of this.#entries) {
      if (
        !hasSelection ||
        entry.expiresAt < selectedEntry.expiresAt ||
        (entry.expiresAt === selectedEntry.expiresAt &&
          entry.sequence < selectedEntry.sequence)
      ) {
        hasSelection = true;
        selectedKey = key;
        selectedEntry = entry;
      }
    }
    if (hasSelection) {
      this.#entries.delete(selectedKey);
    }
  }

  get size() {
    this.sweep();
    return this.#entries.size;
  }

  get maxEntries() {
    return this.#maxEntries;
  }

  get capacityPolicy() {
    return this.#capacityPolicy;
  }
}

export const ttlStoreDefaults = Object.freeze({
  capacityPolicy: "evict-soonest",
  maxEntries: DEFAULT_MAX_ENTRIES,
});
