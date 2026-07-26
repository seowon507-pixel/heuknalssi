import { createKakaoAdapter } from "./kakao.js";
import {
  createKmaMidForecastAdapter,
  createKmaShortForecastAdapter
} from "./kma.js";
import {
  createKmaAsosObservationAdapter,
  createKmaClimateNormalAdapter
} from "./kma-observation.js";
import { ProviderExecutionGuard } from "./provider-control.js";
import { createSoilV2Adapter } from "./soil-v2.js";
import { createSoilFieldAdapter } from "./soil-field.js";
import { createSmartfarmAdapter } from "./smartfarm.js";

export {
  ADAPTER_STATES,
  DELIVERY_STATES,
  FRESHNESS_STATES,
  SPATIAL_LEVELS,
  assertDataEnvelope,
  createDataEnvelope,
  createUnavailableEnvelope,
  validateDataEnvelope
} from "./data-envelope.js";
export {
  AdapterError,
  DeadlineExceededError,
  NoDataError,
  SchemaChangedError,
  UnsupportedContractError,
  classifyProviderError,
  toAdapterError
} from "./errors.js";
export {
  kmaDateTimeToIso,
  parseIsoDate,
  parseIsoInstant,
  parseStrictBoolean,
  parseStrictFiniteNumber,
  requireFiniteNumber,
  requireNonEmptyString
} from "./strict-values.js";
export {
  DEFAULT_PROVIDER_RESPONSE_MAX_BYTES,
  PROVIDER_HOST_ALLOWLIST,
  assertAllowedProviderUrl,
  fetchWithDeadline,
  providerDisclosureUrl,
  requestProviderJson,
  requestProviderText,
  runWithDeadline
} from "./network.js";
export {
  PARTIAL_PROVIDER_FAILURE,
  VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
  VERIFIED_KMA_MID_CONTRACT_VERSION,
  VERIFIED_KMA_ASOS_CONTRACT_VERSION,
  VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
  VERIFIED_KMA_SHORT_CONTRACT_VERSION,
  VERIFIED_SOIL_V2_CONTRACT_VERSION,
  VERIFIED_SOIL_FIELD_CONTRACT_VERSION,
  VERIFIED_SMARTFARM_REFERENCE_CONTRACT_VERSION,
  hasFrozenContractVersion,
  hasUsableCredential,
  runAdapterCall,
  runCachedAdapterCall
} from "./adapter-call.js";
export {
  InMemoryAdapterCache,
  SingleFlight,
  hmacCacheValue,
  makeAdapterCacheKey
} from "./cache.js";
export { ProviderExecutionGuard } from "./provider-control.js";
export {
  createKakaoAdapter,
  parseKakaoCandidates,
  parseKakaoRegionCandidates
} from "./kakao.js";
export {
  createKmaAsosObservationAdapter,
  createKmaClimateNormalAdapter,
  parseKmaAsosDaily,
  parseKmaClimateNormals
} from "./kma-observation.js";
export {
  createKmaMidForecastAdapter,
  createKmaShortForecastAdapter,
  joinKmaMidForecast,
  parseKmaMidLandForecast,
  parseKmaMidForecast,
  parseKmaMidTemperature,
  parseKmaShortForecast,
  validateKmaMidRegionMapping
} from "./kma.js";
export {
  createSoilV2Adapter,
  parseSoilV2,
  VERIFIED_SOIL_V2_CONTRACT,
  validateSoilV2Contract
} from "./soil-v2.js";
export {
  createSoilFieldAdapter,
  parseSoilFieldCharacteristics
} from "./soil-field.js";
export {
  createSmartfarmAdapter,
  parseSmartfarmFacilityReference,
  parseSmartfarmOutdoorReference,
  resolveSmartfarmReferenceProfile
} from "./smartfarm.js";

export const adapterFactories = Object.freeze({
  kakao: createKakaoAdapter,
  kmaShort: createKmaShortForecastAdapter,
  kmaMid: createKmaMidForecastAdapter,
  kmaAsos: createKmaAsosObservationAdapter,
  kmaClimate: createKmaClimateNormalAdapter,
  soilV2: createSoilV2Adapter,
  soilField: createSoilFieldAdapter,
  smartfarm: createSmartfarmAdapter
});

/**
 * Builds the P0 adapter registry without reading process.env. Every live
 * capability and credential must be injected explicitly by the application.
 */
export function createAdapterRegistry({
  common = {},
  kakao = {},
  kmaShort = {},
  kmaMid = {},
  kmaAsos = {},
  kmaClimate = {},
  soilV2 = {},
  soilField = {},
  smartfarm = {}
} = {}) {
  const kmaProviderControl = {
    ...(common.providerControl ?? {}),
    ...(kmaShort.providerControl ?? {}),
    ...(kmaMid.providerControl ?? {}),
    ...(kmaAsos.providerControl ?? {}),
    ...(kmaClimate.providerControl ?? {})
  };
  const registryNow =
    kmaMid.now ??
    kmaShort.now ??
    kmaAsos.now ??
    kmaClimate.now ??
    common.now ??
    (() => Date.now());
  const commonKmaExecutionGuard =
    common.executionGuard ??
    kmaShort.executionGuard ??
    kmaMid.executionGuard ??
    kmaAsos.executionGuard ??
    kmaClimate.executionGuard ??
    new ProviderExecutionGuard({
      maxConcurrency: 4,
      maxQueue: 8,
      failureThreshold: 3,
      circuitCooldownMs: 1000,
      ...kmaProviderControl,
      provider: "KMA",
      now:
        kmaProviderControl.now ??
        (() => {
          const value = registryNow();
          return value instanceof Date ? value.getTime() : Number(value);
        })
    });

  return Object.freeze({
    kakao: createKakaoAdapter({ ...common, ...kakao }),
    kmaShort: createKmaShortForecastAdapter({
      ...common,
      ...kmaShort,
      executionGuard:
        kmaShort.executionGuard ?? commonKmaExecutionGuard
    }),
    kmaMid: createKmaMidForecastAdapter({
      ...common,
      ...kmaMid,
      executionGuard: kmaMid.executionGuard ?? commonKmaExecutionGuard
    }),
    observations: createKmaAsosObservationAdapter({
      ...common,
      ...kmaAsos,
      executionGuard: kmaAsos.executionGuard ?? commonKmaExecutionGuard
    }),
    climate: createKmaClimateNormalAdapter({
      ...common,
      ...kmaClimate,
      executionGuard: kmaClimate.executionGuard ?? commonKmaExecutionGuard
    }),
    soilV2: createSoilV2Adapter({ ...common, ...soilV2 }),
    soilField: createSoilFieldAdapter({ ...common, ...soilField }),
    smartfarm: createSmartfarmAdapter({ ...common, ...smartfarm })
  });
}
