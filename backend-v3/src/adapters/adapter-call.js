import {
  createDataEnvelope,
  createUnavailableEnvelope
} from "./data-envelope.js";
import { classifyProviderError } from "./errors.js";

export const VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION =
  "fixture-kakao-address-v1";
export const VERIFIED_KMA_SHORT_CONTRACT_VERSION =
  "fixture-kma-short-v1";
export const VERIFIED_KMA_MID_CONTRACT_VERSION =
  "fixture-kma-mid-dual-v1";
export const VERIFIED_KMA_ASOS_CONTRACT_VERSION =
  "data-go-asos-daily-v1-2025-09-17";
// 실시간 API 허브 호출을 걷어내고 기상청 배포 엑셀(1991-2020)을 변환한
// 정적 데이터셋으로 전환했으므로 계약 버전도 새 출처를 가리킨다.
export const VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION =
  "kma-climate-normal-monthly-1991-2020-local-v1";
export const VERIFIED_SOIL_V2_CONTRACT_VERSION =
  "data-go-15144685-v1.0.0-2025-11-04";
export const VERIFIED_SOIL_FIELD_CONTRACT_VERSION =
  "data-go-15144225-v1.0.0-2025-11-04";
export const VERIFIED_SMARTFARM_REFERENCE_CONTRACT_VERSION =
  "smartfarm-reference-v1";
export const PARTIAL_PROVIDER_FAILURE = "PARTIAL_PROVIDER_FAILURE";

export function hasUsableCredential(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function hasFrozenContractVersion(value, allowedVersions) {
  const allowlist =
    allowedVersions instanceof Set
      ? allowedVersions
      : Array.isArray(allowedVersions)
        ? new Set(allowedVersions)
        : new Set();
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    allowlist.has(value)
  );
}

/**
 * Capability gates are evaluated before operation/url construction, which
 * guarantees disabled or unconfigured live adapters perform zero fetches.
 */
export async function runAdapterCall({
  enabled,
  credential,
  credentialRequired = true,
  envelopeBase,
  operation,
  now = () => new Date()
}) {
  if (enabled !== true) {
    return createUnavailableEnvelope(envelopeBase, {
      adapterState: "UNSUPPORTED",
      qualityFlags: ["LIVE_FEATURE_DISABLED"],
      now
    });
  }

  if (credentialRequired && !hasUsableCredential(credential)) {
    return createUnavailableEnvelope(envelopeBase, {
      adapterState: "INTERNAL_ERROR",
      qualityFlags: ["CREDENTIAL_UNAVAILABLE"],
      now
    });
  }

  try {
    const result = await operation();
    return createDataEnvelope(
      {
        ...envelopeBase,
        ...result,
        deliveryState: result.deliveryState ?? "LIVE",
        adapterState: result.adapterState ?? "SUCCESS",
        qualityFlags: [
          ...(envelopeBase.qualityFlags ?? []),
          ...(result.qualityFlags ?? [])
        ]
      },
      { now }
    );
  } catch (error) {
    const classified = classifyProviderError(error, {
      now: () => new Date(now()).getTime()
    });
    return createUnavailableEnvelope(envelopeBase, {
      adapterState: classified.adapterState,
      qualityFlags: [classified.code],
      now
    });
  }
}

/**
 * Coordinates a live adapter call through a bounded fresh-only cache and a
 * per-key single flight. Capability and contract gates run before cache/key
 * access, so an unfrozen adapter cannot accidentally call or reuse live data.
 */
export async function runCachedAdapterCall({
  enabled,
  credential,
  credentialRequired = true,
  contractVersion,
  allowedContractVersions,
  envelopeBase,
  operation,
  now = () => new Date(),
  cache,
  singleFlight,
  executionGuard,
  cacheKey,
  cacheFreshForMs,
  signal,
  deadlineAt,
  cacheable = (envelope) =>
    envelope.adapterState === "SUCCESS" &&
    envelope.deliveryState === "LIVE"
}) {
  if (enabled !== true) {
    return createUnavailableEnvelope(envelopeBase, {
      adapterState: "UNSUPPORTED",
      qualityFlags: ["LIVE_FEATURE_DISABLED"],
      now
    });
  }
  if (credentialRequired && !hasUsableCredential(credential)) {
    return createUnavailableEnvelope(envelopeBase, {
      adapterState: "INTERNAL_ERROR",
      qualityFlags: ["CREDENTIAL_UNAVAILABLE"],
      now
    });
  }
  if (!hasFrozenContractVersion(contractVersion, allowedContractVersions)) {
    return createUnavailableEnvelope(envelopeBase, {
      adapterState: "UNSUPPORTED",
      qualityFlags: ["PROVIDER_CONTRACT_UNSUPPORTED"],
      now
    });
  }

  const useCache =
    cache &&
    typeof cache.get === "function" &&
    typeof cache.set === "function" &&
    Number.isFinite(cacheFreshForMs) &&
    cacheFreshForMs > 0;
  const useSingleFlight =
    singleFlight &&
    typeof singleFlight.run === "function" &&
    typeof cacheKey === "string" &&
    cacheKey.length > 0;
  const useExecutionGuard =
    executionGuard && typeof executionGuard.run === "function";

  if (useCache) {
    const cached = cache.get(cacheKey);
    if (cached) return cached;
  }

  const execute = async (upstreamSignal, upstreamDeadlineAt) => {
    if (useCache) {
      const cached = cache.get(cacheKey);
      if (cached) return cached;
    }
    const envelope = await runAdapterCall({
      enabled,
      credential,
      credentialRequired,
      envelopeBase,
      operation: () => {
        const invoke = () =>
          operation({
            signal: upstreamSignal,
            deadlineAt: upstreamDeadlineAt
          });
        return useExecutionGuard
          ? executionGuard.run(invoke, { signal: upstreamSignal })
          : invoke();
      },
      now
    });
    if (useCache && cacheable(envelope)) {
      cache.set(cacheKey, envelope, {
        freshForMs: cacheFreshForMs,
        staleForMs: 0
      });
    }
    return envelope;
  };

  try {
    const result = useSingleFlight
      ? await singleFlight.run(
          cacheKey,
          (upstreamSignal) => execute(upstreamSignal, undefined),
          {
            signal,
            deadlineAt,
            now: () => new Date(now()).getTime()
          }
        )
      : await execute(signal, deadlineAt);
    return structuredClone(result);
  } catch (error) {
    const classified = classifyProviderError(error, {
      now: () => new Date(now()).getTime()
    });
    return createUnavailableEnvelope(envelopeBase, {
      adapterState: classified.adapterState,
      qualityFlags: [classified.code],
      now
    });
  }
}
