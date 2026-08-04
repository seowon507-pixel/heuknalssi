import { createServer } from 'node:http';

import {
  VERIFIED_KAKAO_ADDRESS_CONTRACT_VERSION,
  VERIFIED_KMA_ASOS_CONTRACT_VERSION,
  VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION,
  VERIFIED_KMA_LOCATION_CATALOG_CONTRACT_VERSION,
  VERIFIED_KMA_MID_CONTRACT_VERSION,
  VERIFIED_KMA_SHORT_CONTRACT_VERSION,
  VERIFIED_SOIL_FIELD_CONTRACT_VERSION,
  VERIFIED_SOIL_EXAM_CONTRACT_VERSION,
  VERIFIED_SMARTFARM_REFERENCE_CONTRACT_VERSION,
  createAdapterRegistry,
  createGoogleAiSelector,
  validateSoilV2Contract,
} from '../src/adapters/index.js';
import { createHttpHandler } from '../src/api/index.js';
import {
  createActionPlanService,
  createApplicationServices,
  createCropCycleService,
  createHarvestAssessmentService,
  createHarvestWeatherService,
  createPhotoSeasonService,
  createPestGuidanceService,
  createReportHistoryService,
  createSatelliteObservationService,
} from '../src/application/index.js';
import { createRuleRegistry } from '../src/domain/index.js';
import {
  createActionPlanRepository,
  createCropCycleRepository,
  createDeviceBackupStore,
  createPhotoSeasonRepository,
  createReportHistoryRepository,
  createSupabasePhotoStorage,
  createSupabaseSharedState,
  TtlMemoryStore,
} from '../src/infrastructure/index.js';
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
  const sharedState = createSupabaseSharedState({
    url: config.sharedStateConfig.url,
    serviceKey: config.sharedStateConfig.secretKey,
    fetchImpl,
    now: clock,
  });
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
        apiKey: config.adapterConfig.kmaClimate.apiKey,
        contractVersion: config.adapterConfig.kmaClimate.contractVersion,
      },
      kmaLocationCatalog: {
        enabled:
          config.adapterConfig.kmaLocationCatalog.enabled &&
          config.adapterConfig.kmaLocationCatalog.contractVersion ===
            VERIFIED_KMA_LOCATION_CATALOG_CONTRACT_VERSION,
        apiKey: config.adapterConfig.kmaLocationCatalog.apiKey,
        contractVersion:
          config.adapterConfig.kmaLocationCatalog.contractVersion,
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
      soilExam: {
        enabled:
          config.adapterConfig.soilExam.enabled &&
          config.adapterConfig.soilExam.contractVersion ===
            VERIFIED_SOIL_EXAM_CONTRACT_VERSION,
        apiKey: config.adapterConfig.soilExam.serviceKey,
        contractVersion:
          config.adapterConfig.soilExam.contractVersion,
        ...(config.adapterConfig.soilExam.endpoint
          ? { endpoint: config.adapterConfig.soilExam.endpoint }
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
      satellite: {
        enabled: config.adapterConfig.satellite.enabled,
        clientId: config.adapterConfig.satellite.clientId,
        clientSecret: config.adapterConfig.satellite.clientSecret,
        contractVersion: config.adapterConfig.satellite.contractVersion,
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
  const harvestAssessmentService = createHarvestAssessmentService({
    assessor: assistant,
    clock,
  });
  const deviceBackup = createDeviceBackupStore({
    url: config.deviceBackupConfig.url,
    serviceKey: config.deviceBackupConfig.secretKey,
    fetchImpl,
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
    ...(sharedState.configured
      ? {
          candidateStore: sharedState.createTtlStore('candidates'),
          analysisStore: sharedState.createTtlStore('analyses'),
          sharedStateProbe: sharedState.probe,
        }
      : {}),
    ...(deviceBackup.configured
      ? { deviceBackupProbe: deviceBackup.probe }
      : {}),
    runtimeStatus: activeRuntimeStatus,
    capabilities: {
      ...config.capabilities,
      smartfarm:
        activeRuntimeStatus?.adapters?.smartfarm ??
        config.capabilities.smartfarm,
      assistant: assistant.state,
      satellite:
        activeAdapters.satellite?.state ?? config.capabilities.satellite,
    },
  });
  const actionStore = sharedState.configured
    ? sharedState.createTtlStore('farm_actions')
    : new TtlMemoryStore({ clock, capacityPolicy: 'reject' });
  const cropCycleStore = sharedState.configured
    ? sharedState.createTtlStore('crop_cycles')
    : new TtlMemoryStore({ clock, capacityPolicy: 'reject' });
  const satelliteStore = sharedState.configured
    ? sharedState.createTtlStore('satellite')
    : new TtlMemoryStore({ clock, capacityPolicy: 'reject' });
  const actionPlanService = createActionPlanService({
    repository: createActionPlanRepository({ store: actionStore }),
    clock: () => new Date(clock()),
  });
  const cropCycleService = createCropCycleService({
    repository: createCropCycleRepository({ store: cropCycleStore }),
    clock: { now: () => new Date(clock()) },
  });
  const harvestWeatherService = createHarvestWeatherService({
    cropCycleService,
    getAnalysis: services.getAnalysis,
    getAnalysisContext: services.getAnalysisContext,
    observationAdapter: activeAdapters.observations,
    climateAdapter: activeAdapters.climate,
    clock,
  });
  const satelliteService = createSatelliteObservationService({
    adapter: activeAdapters.satellite,
    store: persistentValueStore(satelliteStore),
    clock,
  });
  const pestGuidanceService = createPestGuidanceService({
    getAnalysis: services.getAnalysis,
  });
  const photoSeasonFeature = sharedState.configured
    ? createPhotoSeasonFeature({
        sharedState,
        actionPlanService,
        config,
        fetchImpl,
        clock,
      })
    : null;
  const reportHistoryFeature = sharedState.configured
    ? createReportHistoryService({
        repository: createReportHistoryRepository({
          store: sharedState.createTtlStore('report_history'),
        }),
        getAnalysis: services.getAnalysis,
      })
    : null;
  const handler = createHttpHandler({
    services,
    featureServices: {
      actionPlan: actionPlanService,
      cropCycle: cropCycleService,
      harvestAssessment: harvestAssessmentService,
      harvestWeather: harvestWeatherService,
      pestGuidance: pestGuidanceService,
      satellite: satelliteService,
      ...(photoSeasonFeature ? { photoSeason: photoSeasonFeature } : {}),
      ...(reportHistoryFeature ? { reportHistory: reportHistoryFeature } : {}),
    },
    config: {
      nodeEnv: config.nodeEnv,
      production: config.nodeEnv === 'production',
      allowedOrigins: config.allowedOrigins,
      sessionSecret: config.sessionSecret,
      trustedProxy: config.trustedProxy,
      logger,
      requestTimeoutMs: 15_000,
      ...(sharedState.configured
        ? {
            sessionStore: sharedState.createTtlStore('sessions'),
            rateLimiter: sharedState.createRateLimiter(),
            idempotencyStore: sharedState.createIdempotencyStore(),
          }
        : {}),
      rateLimits: {
        'locations.search': { limit: 30, windowMs: 60_000 },
        'analyses.create': { limit: 10, windowMs: 60_000 },
        'analyses.report': { limit: 5, windowMs: 60_000 },
        'analyses.assistant': { limit: 20, windowMs: 60_000 },
        'health.preflight': { limit: 30, windowMs: 60_000 },
        // 계정키는 12자리 무작위값이라 대입 시도를 막으려면 조회를 조여야 한다.
        'backup.save': { limit: 10, windowMs: 60_000 },
        'backup.restore': { limit: 5, windowMs: 60_000 },
      },
    },
    clock,
    ...(randomBytes ? { randomBytes } : {}),
    deviceBackup,
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

function createPhotoSeasonFeature({
  sharedState,
  actionPlanService,
  config,
  fetchImpl,
  clock,
}) {
  const repository = createPhotoSeasonRepository({
    store: sharedState.createTtlStore('farm_photos'),
  });
  const objectStorage = createSupabasePhotoStorage({
    url: config.photoStorageConfig.url,
    serviceKey: config.photoStorageConfig.secretKey,
    bucket: config.photoStorageConfig.bucket,
    uploadStore: sharedState.createTtlStore('photo_uploads'),
    fetchImpl,
  });
  const photoService = createPhotoSeasonService({
    ...repository,
    objectStorage,
    actionRepository: {
      async listActionsBySeason({
        ownerSessionId,
        farmId,
        cropId,
        seasonId,
      }) {
        const plan = await actionPlanService.listActions({
          accountId: ownerSessionId,
          farmId,
          cropId,
          seasonId,
        });
        return [...plan.today, ...plan.upcoming, ...plan.archived];
      },
    },
    riskRepository: {
      async listRisksBySeason() {
        // Persisted risk history is introduced with report history. Until then
        // an empty list is explicit and does not synthesize risk events.
        return [];
      },
    },
    clock: { now: () => new Date(clock()) },
  });
  return Object.freeze({
    ...photoService,
    prepareUpload: objectStorage.prepareUpload,
  });
}

function persistentValueStore(store) {
  const ttlMs = 365 * 24 * 60 * 60 * 1_000;
  return Object.freeze({
    get(key) {
      return Promise.resolve(store.get(key));
    },
    set(key, value) {
      return Promise.resolve(store.set(key, value, ttlMs));
    },
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
      // 저장소에 포함된 정적 평년값이라 자격증명 없이 계약 버전만 확인한다.
      climate: !config.adapterConfig.kmaClimate.enabled
        ? 'UNSUPPORTED'
        : config.adapterConfig.kmaClimate.contractVersion ===
            VERIFIED_KMA_CLIMATE_NORMAL_CONTRACT_VERSION
          ? 'READY'
          : 'HOLD',
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
      soilExam: configured(
        config.adapterConfig.soilExam.enabled,
        config.adapterConfig.soilExam.serviceKey,
        config.adapterConfig.soilExam.contractVersion,
        VERIFIED_SOIL_EXAM_CONTRACT_VERSION,
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
      soilExam:
        config.adapterConfig.soilExam.contractVersion ?? 'NOT_CONFIGURED',
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
