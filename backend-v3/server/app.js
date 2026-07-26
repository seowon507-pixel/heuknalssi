import { createServer } from 'node:http';

import {
  VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
  VERIFIED_KMA_ASOS_CONTRACT_VERSION,
  VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
  VERIFIED_KMA_MID_CONTRACT_VERSION,
  VERIFIED_KMA_SHORT_CONTRACT_VERSION,
  VERIFIED_SOIL_FIELD_CONTRACT_VERSION,
  VERIFIED_SMARTFARM_REFERENCE_CONTRACT_VERSION,
  createAdapterRegistry,
  createGoogleAiSelector,
  validateSoilV2Contract,
} from '../src/adapters/index.js';
import { createHttpHandler } from '../src/api/index.js';
import { createApplicationServices } from '../src/application/index.js';
import { createRuleRegistry } from '../src/domain/index.js';
import { loadConfig } from './config.js';

export function createBackend({
  env = process.env,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  randomBytes,
  logger = console,
  adapters,
  rules = [],
  ruleRegistry,
  verifiedLocationMappings = {},
  runtimeStatus,
  soilContract = null,
} = {}) {
  const config = loadConfig(env);
  const activeRuleRegistry = ruleRegistry ?? createRuleRegistry(rules);
  const activeAdapters =
    adapters ??
    createAdapterRegistry({
      common: {
        fetchImpl,
        now: () => new Date(clock()),
        timeoutMs: config.sourceTimeoutMs,
      },
      kakao: {
        enabled:
          config.adapterConfig.kakao.enabled &&
          config.adapterConfig.kakao.contractVersion ===
            VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
        apiKey: config.adapterConfig.kakao.apiKey,
        contractVersion: config.adapterConfig.kakao.contractVersion,
      },
      kmaShort: {
        enabled:
          config.adapterConfig.kmaShort.enabled &&
          config.adapterConfig.kmaShort.contractVersion ===
            VERIFIED_KMA_SHORT_CONTRACT_VERSION,
        apiKey: config.adapterConfig.kmaShort.serviceKey,
        contractVersion: config.adapterConfig.kmaShort.contractVersion,
      },
      kmaMid: {
        enabled:
          config.adapterConfig.kmaMid.enabled &&
          config.adapterConfig.kmaMid.contractVersion ===
            VERIFIED_KMA_MID_CONTRACT_VERSION,
        apiKey: config.adapterConfig.kmaMid.serviceKey,
        contractVersion: config.adapterConfig.kmaMid.contractVersion,
      },
      kmaAsos: {
        enabled:
          config.adapterConfig.kmaAsos.enabled &&
          config.adapterConfig.kmaAsos.contractVersion ===
            VERIFIED_KMA_ASOS_CONTRACT_VERSION,
        apiKey: config.adapterConfig.kmaAsos.serviceKey,
        contractVersion: config.adapterConfig.kmaAsos.contractVersion,
      },
      kmaClimate: {
        enabled:
          config.adapterConfig.kmaClimate.enabled &&
          config.adapterConfig.kmaClimate.contractVersion ===
            VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
        apiKey: config.adapterConfig.kmaClimate.authKey,
        contractVersion: config.adapterConfig.kmaClimate.contractVersion,
      },
      soilV2: {
        enabled: config.adapterConfig.soilV2.enabled,
        apiKey: config.adapterConfig.soilV2.serviceKey,
        contract: soilContract,
        ...(config.adapterConfig.soilV2.endpoint
          ? { endpoint: config.adapterConfig.soilV2.endpoint }
          : {}),
      },
      soilField: {
        enabled:
          config.adapterConfig.soilField.enabled &&
          config.adapterConfig.soilField.contractVersion ===
            VERIFIED_SOIL_FIELD_CONTRACT_VERSION,
        apiKey: config.adapterConfig.soilField.serviceKey,
        contractVersion:
          config.adapterConfig.soilField.contractVersion,
        ...(config.adapterConfig.soilField.endpoint
          ? { endpoint: config.adapterConfig.soilField.endpoint }
          : {}),
      },
      smartfarm: {
        enabled:
          config.adapterConfig.smartfarm.enabled &&
          config.adapterConfig.smartfarm.contractVersion ===
            VERIFIED_SMARTFARM_REFERENCE_CONTRACT_VERSION,
        serviceKey: config.adapterConfig.smartfarm.serviceKey,
        contractVersion:
          config.adapterConfig.smartfarm.contractVersion,
      },
    });
  const activeRuntimeStatus =
    runtimeStatus ??
    (adapters === undefined
      ? buildRuntimeStatus(config, {
          soilContract,
        })
      : null);
  const assistant = createGoogleAiSelector({
    enabled: config.assistantConfig.enabled,
    apiKey: config.assistantConfig.apiKey,
    model: config.assistantConfig.model,
    fetchImpl,
    timeoutMs: Math.min(config.sourceTimeoutMs, 8_000),
    now: clock,
  });
  const services = createApplicationServices({
    adapters: activeAdapters,
    assistant,
    ruleRegistry: activeRuleRegistry,
    verifiedLocationMappings,
    clock,
    ...(randomBytes ? { randomBytes } : {}),
    coreDeadlineMs: config.coreDeadlineMs,
    candidateTtlMs: config.candidateTtlMs,
    analysisTtlMs: config.analysisTtlMs,
    reportLockTtlMs: config.reportLockTtlMs,
    runtimeStatus: activeRuntimeStatus,
    capabilities: {
      ...config.capabilities,
      smartfarm:
        activeRuntimeStatus?.adapters?.smartfarm ??
        config.capabilities.smartfarm,
      assistant: assistant.state,
    },
  });
  const handler = createHttpHandler({
    services,
    config: {
      nodeEnv: config.nodeEnv,
      production: config.nodeEnv === 'production',
      allowedOrigins: config.allowedOrigins,
      sessionSecret: config.sessionSecret,
      trustedProxy: config.trustedProxy,
      logger,
      requestTimeoutMs: 15_000,
      rateLimits: {
        'locations.search': { limit: 30, windowMs: 60_000 },
        'analyses.create': { limit: 10, windowMs: 60_000 },
        'analyses.report': { limit: 5, windowMs: 60_000 },
        'analyses.assistant': { limit: 20, windowMs: 60_000 },
        'health.preflight': { limit: 30, windowMs: 60_000 },
      },
    },
    clock,
    ...(randomBytes ? { randomBytes } : {}),
  });

  return Object.freeze({
    config,
    adapters: activeAdapters,
    ruleRegistry: activeRuleRegistry,
    services,
    handler,
    server: createServer(handler),
  });
}

function buildRuntimeStatus(
  config,
  { soilContract = null } = {},
) {
  const configured = (enabled, credential, actualVersion, expectedVersion) => {
    if (!enabled) return 'UNSUPPORTED';
    return credential && actualVersion === expectedVersion
      ? 'READY'
      : 'HOLD';
  };
  const soilContractReady = isVerifiedSoilContract(soilContract);
  return Object.freeze({
    adapters: Object.freeze({
      kakao: configured(
        config.adapterConfig.kakao.enabled,
        config.adapterConfig.kakao.apiKey,
        config.adapterConfig.kakao.contractVersion,
        VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
      ),
      climate: configured(
        config.adapterConfig.kmaClimate.enabled,
        config.adapterConfig.kmaClimate.authKey,
        config.adapterConfig.kmaClimate.contractVersion,
        VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
      ),
      observations: configured(
        config.adapterConfig.kmaAsos.enabled,
        config.adapterConfig.kmaAsos.serviceKey,
        config.adapterConfig.kmaAsos.contractVersion,
        VERIFIED_KMA_ASOS_CONTRACT_VERSION,
      ),
      soilV2: !config.adapterConfig.soilV2.enabled
        ? 'UNSUPPORTED'
        : config.adapterConfig.soilV2.serviceKey && soilContractReady
          ? 'READY'
          : 'HOLD',
      soilField: configured(
        config.adapterConfig.soilField.enabled,
        config.adapterConfig.soilField.serviceKey,
        config.adapterConfig.soilField.contractVersion,
        VERIFIED_SOIL_FIELD_CONTRACT_VERSION,
      ),
      kmaShort: configured(
        config.adapterConfig.kmaShort.enabled,
        config.adapterConfig.kmaShort.serviceKey,
        config.adapterConfig.kmaShort.contractVersion,
        VERIFIED_KMA_SHORT_CONTRACT_VERSION,
      ),
      kmaMid: configured(
        config.adapterConfig.kmaMid.enabled,
        config.adapterConfig.kmaMid.serviceKey,
        config.adapterConfig.kmaMid.contractVersion,
        VERIFIED_KMA_MID_CONTRACT_VERSION,
      ),
      smartfarm: configured(
        config.adapterConfig.smartfarm.enabled,
        config.adapterConfig.smartfarm.serviceKey,
        config.adapterConfig.smartfarm.contractVersion,
        VERIFIED_SMARTFARM_REFERENCE_CONTRACT_VERSION,
      ),
    }),
    contracts: Object.freeze({
      kakao:
        config.adapterConfig.kakao.contractVersion ?? 'NOT_CONFIGURED',
      climate:
        config.adapterConfig.kmaClimate.contractVersion ?? 'NOT_CONFIGURED',
      observations:
        config.adapterConfig.kmaAsos.contractVersion ?? 'NOT_CONFIGURED',
      soilV2:
        soilContract?.version ?? 'NOT_CONFIGURED',
      soilField:
        config.adapterConfig.soilField.contractVersion ?? 'NOT_CONFIGURED',
      kmaShort:
        config.adapterConfig.kmaShort.contractVersion ?? 'NOT_CONFIGURED',
      kmaMid:
        config.adapterConfig.kmaMid.contractVersion ?? 'NOT_CONFIGURED',
      smartfarm:
        config.adapterConfig.smartfarm.contractVersion ?? 'NOT_CONFIGURED',
    }),
  });
}

function isVerifiedSoilContract(contract) {
  try {
    validateSoilV2Contract(contract);
    return true;
  } catch {
    return false;
  }
}
