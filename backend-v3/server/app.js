import { createServer } from 'node:http';

import {
  VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
  VERIFIED_KMA_MID_CONTRACT_VERSION,
  VERIFIED_KMA_SHORT_CONTRACT_VERSION,
  createAdapterRegistry,
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
  soilDefaultYear = null,
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
      soilV2: {
        enabled: config.adapterConfig.soilV2.enabled,
        apiKey: config.adapterConfig.soilV2.serviceKey,
        contract: soilContract,
        defaultYear:
          soilDefaultYear ?? config.adapterConfig.soilV2.defaultYear,
        ...(config.adapterConfig.soilV2.endpoint
          ? { endpoint: config.adapterConfig.soilV2.endpoint }
          : {}),
      },
    });
  const activeRuntimeStatus =
    runtimeStatus ??
    (adapters === undefined
      ? buildRuntimeStatus(config, {
          soilContract,
          soilDefaultYear:
            soilDefaultYear ?? config.adapterConfig.soilV2.defaultYear,
        })
      : null);
  const services = createApplicationServices({
    adapters: activeAdapters,
    ruleRegistry: activeRuleRegistry,
    verifiedLocationMappings,
    clock,
    ...(randomBytes ? { randomBytes } : {}),
    coreDeadlineMs: config.coreDeadlineMs,
    candidateTtlMs: config.candidateTtlMs,
    analysisTtlMs: config.analysisTtlMs,
    reportLockTtlMs: config.reportLockTtlMs,
    runtimeStatus: activeRuntimeStatus,
    capabilities: config.capabilities,
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
  { soilContract = null, soilDefaultYear = null } = {},
) {
  const configured = (enabled, credential, actualVersion, expectedVersion) =>
    enabled && credential && actualVersion === expectedVersion
      ? 'READY'
      : 'HOLD';
  const soilContractReady = isVerifiedSoilContract(
    soilContract,
    soilDefaultYear,
  );
  return Object.freeze({
    adapters: Object.freeze({
      kakao: configured(
        config.adapterConfig.kakao.enabled,
        config.adapterConfig.kakao.apiKey,
        config.adapterConfig.kakao.contractVersion,
        VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
      ),
      climate: 'UNSUPPORTED',
      observations: 'UNSUPPORTED',
      soilV2:
        config.adapterConfig.soilV2.enabled &&
        config.adapterConfig.soilV2.serviceKey &&
        soilContractReady
          ? 'READY'
          : 'HOLD',
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
    }),
    contracts: Object.freeze({
      kakao:
        config.adapterConfig.kakao.contractVersion ?? 'NOT_CONFIGURED',
      climate: 'NOT_CONFIGURED',
      observations: 'NOT_CONFIGURED',
      soilV2:
        soilContract?.version ?? 'NOT_CONFIGURED',
      kmaShort:
        config.adapterConfig.kmaShort.contractVersion ?? 'NOT_CONFIGURED',
      kmaMid:
        config.adapterConfig.kmaMid.contractVersion ?? 'NOT_CONFIGURED',
    }),
  });
}

function isVerifiedSoilContract(contract, defaultYear) {
  if (
    !Number.isInteger(defaultYear) ||
    defaultYear < 1900 ||
    defaultYear > 2200
  ) {
    return false;
  }
  try {
    validateSoilV2Contract(contract);
    return true;
  } catch {
    return false;
  }
}
