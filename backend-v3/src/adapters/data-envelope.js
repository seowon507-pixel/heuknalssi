import { SchemaChangedError } from "./errors.js";
import { parseIsoInstant } from "./strict-values.js";

export const DELIVERY_STATES = Object.freeze([
  "LIVE",
  "CACHE",
  "SAMPLE",
  "UNAVAILABLE"
]);

export const ADAPTER_STATES = Object.freeze([
  "SUCCESS",
  "NO_DATA",
  "TIMEOUT",
  "RATE_LIMITED",
  "AUTH_ERROR",
  "SCHEMA_CHANGED",
  "UNSUPPORTED",
  "INTERNAL_ERROR"
]);

export const FRESHNESS_STATES = Object.freeze([
  "CURRENT",
  "STALE",
  "SAMPLE",
  "NOT_APPLICABLE"
]);

export const SPATIAL_LEVELS = Object.freeze([
  "NORMAL_STATION",
  "OBSERVATION_STATION",
  "REGIONAL_SOIL_STAT",
  "FORECAST_GRID",
  "FORECAST_REGION",
  "REFERENCE_DATASET",
  "FIELD"
]);

const DELIVERY_STATE_SET = new Set(DELIVERY_STATES);
const ADAPTER_STATE_SET = new Set(ADAPTER_STATES);
const FRESHNESS_STATE_SET = new Set(FRESHNESS_STATES);
const SPATIAL_LEVEL_SET = new Set(SPATIAL_LEVELS);

function uniqueFlags(flags) {
  if (!Array.isArray(flags)) return [];
  return [...new Set(flags.filter((flag) => typeof flag === "string" && flag))];
}

function isoOrNull(value) {
  if (value === null || value === undefined) return null;
  return value;
}

function currentIso(now) {
  const result = now();
  const date = result instanceof Date ? result : new Date(result);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("The envelope clock returned an invalid date.");
  }
  return date.toISOString();
}

function normalizeFreshness(input, nowMs) {
  let {
    adapterState,
    deliveryState,
    data,
    cacheMeta,
    freshness,
    qualityFlags
  } = input;
  const flags = uniqueFlags(qualityFlags);

  if (deliveryState === "SAMPLE") {
    freshness = "SAMPLE";
    flags.push("SAMPLE");
  } else if (deliveryState === "UNAVAILABLE") {
    freshness = "NOT_APPLICABLE";
    data = null;
  } else if (deliveryState === "CACHE") {
    const freshUntilMs = Date.parse(cacheMeta?.freshUntil);
    const staleUntilMs = Date.parse(cacheMeta?.staleUntil);

    if (Number.isFinite(staleUntilMs) && nowMs > staleUntilMs) {
      deliveryState = "UNAVAILABLE";
      freshness = "STALE";
      data = null;
      if (adapterState === "SUCCESS") adapterState = "NO_DATA";
      flags.push("STALE", "CACHE_EXPIRED");
    } else if (Number.isFinite(freshUntilMs) && nowMs > freshUntilMs) {
      freshness = "STALE";
      flags.push("STALE");
    } else {
      freshness = "CURRENT";
    }
  } else {
    freshness = freshness ?? "CURRENT";
  }

  return {
    adapterState,
    deliveryState,
    data,
    cacheMeta,
    freshness,
    qualityFlags: uniqueFlags(flags)
  };
}

/**
 * Creates the common provider envelope. Times are never substituted for one
 * another; every caller must supply the provider time with its real meaning.
 */
export function createDataEnvelope(input, { now = () => new Date() } = {}) {
  if (!input || typeof input !== "object") {
    throw new TypeError("DataEnvelope input must be an object.");
  }

  const retrievedAt = input.retrievedAt ?? currentIso(now);
  const nowMs = new Date(currentIso(now)).getTime();
  const normalized = normalizeFreshness(
    {
      adapterState: input.adapterState ?? "SUCCESS",
      deliveryState: input.deliveryState ?? "LIVE",
      data: input.data ?? null,
      cacheMeta: input.cacheMeta ?? null,
      freshness: input.freshness,
      qualityFlags: input.qualityFlags
    },
    nowMs
  );

  const envelope = {
    sourceId: input.sourceId,
    sourceName: input.sourceName,
    sourceUrl: input.sourceUrl,
    retrievedAt,
    observedAt: isoOrNull(input.observedAt),
    issuedAt: isoOrNull(input.issuedAt),
    validFrom: isoOrNull(input.validFrom),
    validTo: isoOrNull(input.validTo),
    spatialLevel: input.spatialLevel,
    spatialLabel: input.spatialLabel,
    distanceKm: input.distanceKm ?? null,
    unit: input.unit ?? null,
    deliveryState: normalized.deliveryState,
    adapterState: normalized.adapterState,
    freshness: normalized.freshness,
    provenance: {
      adapterId: input.provenance?.adapterId,
      adapterVersion: input.provenance?.adapterVersion,
      operationId: input.provenance?.operationId,
      contractVersion: input.provenance?.contractVersion ?? null,
      providerIssueTime: input.provenance?.providerIssueTime ?? null
    },
    qualityFlags: normalized.qualityFlags,
    cacheMeta: normalized.cacheMeta,
    data: normalized.data
  };

  assertDataEnvelope(envelope);
  return envelope;
}

function isIsoTimestamp(value) {
  try {
    parseIsoInstant(value);
    return true;
  } catch {
    return false;
  }
}

function requireString(errors, value, field, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field} must be a non-empty string${nullable ? " or null" : ""}.`);
  }
}

export function validateDataEnvelope(envelope) {
  const errors = [];
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { valid: false, errors: ["DataEnvelope must be an object."] };
  }

  requireString(errors, envelope.sourceId, "sourceId");
  requireString(errors, envelope.sourceName, "sourceName");
  requireString(errors, envelope.sourceUrl, "sourceUrl");
  if (typeof envelope.sourceUrl === "string") {
    try {
      if (new URL(envelope.sourceUrl).protocol !== "https:") {
        errors.push("sourceUrl must use HTTPS.");
      }
    } catch {
      errors.push("sourceUrl must be a valid URL.");
    }
  }

  for (const field of [
    "retrievedAt",
    "observedAt",
    "issuedAt",
    "validFrom",
    "validTo"
  ]) {
    const value = envelope[field];
    if (field !== "retrievedAt" && value === null) continue;
    if (!isIsoTimestamp(value)) {
      errors.push(`${field} must be an ISO-8601 timestamp${field === "retrievedAt" ? "" : " or null"}.`);
    }
  }

  if (!SPATIAL_LEVEL_SET.has(envelope.spatialLevel)) {
    errors.push("spatialLevel is not supported.");
  }
  requireString(errors, envelope.spatialLabel, "spatialLabel");
  if (
    envelope.distanceKm !== null &&
    (!Number.isFinite(envelope.distanceKm) || envelope.distanceKm < 0)
  ) {
    errors.push("distanceKm must be a non-negative finite number or null.");
  }
  if (envelope.unit !== null && typeof envelope.unit !== "string") {
    errors.push("unit must be a string or null.");
  }
  if (!DELIVERY_STATE_SET.has(envelope.deliveryState)) {
    errors.push("deliveryState is not supported.");
  }
  if (!ADAPTER_STATE_SET.has(envelope.adapterState)) {
    errors.push("adapterState is not supported.");
  }
  if (!FRESHNESS_STATE_SET.has(envelope.freshness)) {
    errors.push("freshness is not supported.");
  }
  if (
    !Array.isArray(envelope.qualityFlags) ||
    envelope.qualityFlags.some((flag) => typeof flag !== "string")
  ) {
    errors.push("qualityFlags must be an array of strings.");
  }

  if (
    !envelope.provenance ||
    typeof envelope.provenance !== "object" ||
    Array.isArray(envelope.provenance)
  ) {
    errors.push("provenance must be an object.");
  } else {
    requireString(errors, envelope.provenance.adapterId, "provenance.adapterId");
    requireString(
      errors,
      envelope.provenance.adapterVersion,
      "provenance.adapterVersion"
    );
    requireString(
      errors,
      envelope.provenance.operationId,
      "provenance.operationId"
    );
    if (
      envelope.provenance.contractVersion !== null &&
      (typeof envelope.provenance.contractVersion !== "string" ||
        envelope.provenance.contractVersion.trim() === "")
    ) {
      errors.push("provenance.contractVersion must be a non-empty string or null.");
    }
    if (
      envelope.provenance.providerIssueTime !== null &&
      !isIsoTimestamp(envelope.provenance.providerIssueTime)
    ) {
      errors.push(
        "provenance.providerIssueTime must be an ISO-8601 timestamp or null."
      );
    }
  }

  if (envelope.cacheMeta !== null) {
    const cache = envelope.cacheMeta;
    if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
      errors.push("cacheMeta must be an object or null.");
    } else {
      for (const field of ["storedAt", "freshUntil", "staleUntil"]) {
        if (!isIsoTimestamp(cache[field])) {
          errors.push(`cacheMeta.${field} must be an ISO-8601 timestamp.`);
        }
      }
      const stored = Date.parse(cache.storedAt);
      const fresh = Date.parse(cache.freshUntil);
      const stale = Date.parse(cache.staleUntil);
      if (
        Number.isFinite(stored) &&
        Number.isFinite(fresh) &&
        Number.isFinite(stale) &&
        !(stored <= fresh && fresh <= stale)
      ) {
        errors.push("cacheMeta times must satisfy storedAt <= freshUntil <= staleUntil.");
      }
    }
  }
  if (envelope.deliveryState === "CACHE" && envelope.cacheMeta === null) {
    errors.push("CACHE delivery requires cacheMeta.");
  }
  if (envelope.deliveryState === "UNAVAILABLE" && envelope.data !== null) {
    errors.push("UNAVAILABLE delivery cannot include data.");
  }

  return { valid: errors.length === 0, errors };
}

export function assertDataEnvelope(envelope) {
  const result = validateDataEnvelope(envelope);
  if (!result.valid) {
    throw new SchemaChangedError(
      `Invalid DataEnvelope: ${result.errors.join(" ")}`
    );
  }
  return envelope;
}

export function createUnavailableEnvelope(
  base,
  {
    adapterState = "UNSUPPORTED",
    qualityFlags = [],
    retrievedAt,
    now
  } = {}
) {
  return createDataEnvelope(
    {
      ...base,
      retrievedAt,
      deliveryState: "UNAVAILABLE",
      adapterState,
      freshness: "NOT_APPLICABLE",
      qualityFlags,
      cacheMeta: null,
      data: null
    },
    now ? { now } : undefined
  );
}
