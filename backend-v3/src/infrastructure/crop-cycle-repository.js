const DEFAULT_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1_000;

export function createCropCycleRepository({
  store,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  assertStore(store);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError("crop cycle ttlMs must be a positive integer");
  }

  return Object.freeze({ insertCycle, findCycle, replaceCycle });

  async function insertCycle(cycle, { ownerSessionId } = {}) {
    const scope = scopeFrom({ ownerSessionId, ...cycle });
    const key = cycleKey(scope);
    return Boolean(
      await Promise.resolve(
        store.setIfAbsent(key, structuredClone(cycle), ttlMs),
      ),
    );
  }

  async function findCycle(input = {}) {
    const key = cycleKey(scopeFrom(input));
    const stored = await Promise.resolve(store.get(key));
    return stored === undefined ? null : structuredClone(stored);
  }

  async function replaceCycle(
    cycle,
    { ownerSessionId, expectedRevision } = {},
  ) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      throw new TypeError("expectedRevision must be a positive integer");
    }
    const scope = scopeFrom({ ownerSessionId, ...cycle });
    const key = cycleKey(scope);
    const current = await Promise.resolve(store.get(key));
    if (current === undefined || current?.revision !== expectedRevision) {
      return false;
    }
    if (cycle?.revision !== expectedRevision + 1) {
      throw new TypeError("replacement revision must increment by one");
    }
    return Boolean(
      await Promise.resolve(
        store.compareAndSet(key, current, structuredClone(cycle), ttlMs),
      ),
    );
  }
}

function cycleKey({ ownerSessionId, farmId, cropId, seasonId }) {
  return JSON.stringify([
    "crop-cycle-v1",
    ownerSessionId,
    farmId,
    cropId,
    seasonId,
  ]);
}

function scopeFrom(input) {
  return {
    ownerSessionId: requiredIdentifier(input.ownerSessionId, "ownerSessionId"),
    farmId: requiredIdentifier(input.farmId, "farmId"),
    cropId: requiredIdentifier(input.cropId, "cropId"),
    seasonId: requiredIdentifier(input.seasonId, "seasonId"),
  };
}

function requiredIdentifier(value, field) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 180
  ) {
    throw new TypeError(`${field} must be a non-empty identifier`);
  }
  return value;
}

function assertStore(store) {
  for (const method of ["get", "setIfAbsent", "compareAndSet"]) {
    if (typeof store?.[method] !== "function") {
      throw new TypeError(`crop cycle store.${method} is required`);
    }
  }
}

export const cropCycleRepositoryDefaults = Object.freeze({
  ttlMs: DEFAULT_TTL_MS,
});
