import { randomBytes as nodeRandomBytes } from 'node:crypto';

import {
  ALLOWED_CULTIVATION_MODES,
  calculateGrowthScore,
  createRuleRegistry,
  Crop,
  decideGuidance,
  evaluateAnalysisStates,
  evaluateClimate,
  evaluateForecast,
  estimateFieldConditions,
  evaluateObservation,
  evaluateSoil,
  mergeAndRankActions,
  MODULE_APPLICABILITY,
  RAW_WEIGHT_BY_TIER,
  validateAndNormalizeRequest,
} from '../domain/index.js';
import {
  createDataEnvelope,
  createUnavailableEnvelope,
  validateDataEnvelope,
} from '../adapters/data-envelope.js';
import { createOpaqueId, TtlMemoryStore } from '../infrastructure/index.js';
import {
  collectSourceDisclosures,
  envelopeHasUsableData,
  notApplicableModule,
  unavailableModule,
} from './disclosure.js';
import { latestKmaMidIssue, latestKmaShortIssue } from './forecast-issue.js';
import {
  resolveLocationKeys,
  validateVerifiedLocationMappings,
} from './location-keys.js';
import {
  buildDeterministicReport,
  renderActionTitle,
  renderDecisionMessage,
  resolveEligibleEvidence,
} from './templates.js';
import {
  answerGroundedQuestion,
  normalizeQuestion,
} from './assistant.js';

const CANDIDATE_TTL_MS = 10 * 60 * 1000;
const ANALYSIS_TTL_MS = 60 * 60 * 1000;
const REPORT_LOCK_TTL_MS = 15 * 1000;
const STORE_CAPACITY_POLICY = 'reject';
const ANALYSIS_LIFECYCLE_ORDER = Object.freeze([
  'RECEIVED',
  'VALIDATING',
  'RESOLVING_LOCATION',
  'FETCHING_MODULES',
  'CALCULATING',
  'CORE_READY',
  'REPORT_PENDING',
  'COMPLETE',
]);

const SOURCE_BASES = Object.freeze({
  locationCatalog: Object.freeze({
    sourceId: 'kma-location-catalog',
    sourceName: '기상청 지상관측 지점·예보구역 정보',
    sourceUrl:
      'https://apihub.kma.go.kr/apiList.do?seqApi=10&seqApiSub=321',
    spatialLevel: 'FORECAST_REGION',
    spatialLabel: '전국 공식 지점·예보구역 목록',
    provenance: {
      adapterId: 'kma-location-catalog',
      adapterVersion: 'unconfigured',
      operationId: 'get-current-stations-and-forecast-zones',
      contractVersion: null,
      providerIssueTime: null,
    },
  }),
  climate: Object.freeze({
    sourceId: 'kma-climate-normal',
    sourceName: '기상청 기후평년',
    sourceUrl: 'https://data.kma.go.kr/',
    spatialLevel: 'NORMAL_STATION',
    spatialLabel: '기후평년 지점',
    provenance: {
      adapterId: 'kma-climate-normal',
      adapterVersion: 'unconfigured',
      operationId: 'climate-normal',
      contractVersion: null,
      providerIssueTime: null,
    },
  }),
  observations: Object.freeze({
    sourceId: 'kma-asos-observations',
    sourceName: '기상청 ASOS 최근 관측',
    sourceUrl: 'https://data.kma.go.kr/',
    spatialLevel: 'OBSERVATION_STATION',
    spatialLabel: '최근 관측 지점',
    provenance: {
      adapterId: 'kma-asos-observations',
      adapterVersion: 'unconfigured',
      operationId: 'recent-seven-days',
      contractVersion: null,
      providerIssueTime: null,
    },
  }),
  soil: Object.freeze({
    sourceId: 'soil-v2',
    sourceName: '농경지화학성 통계 V2',
    sourceUrl: 'https://www.data.go.kr/data/15144685/openapi.do',
    spatialLevel: 'REGIONAL_SOIL_STAT',
    spatialLabel: '지역 토양 면적통계',
    provenance: {
      adapterId: 'soil-v2',
      adapterVersion: 'unconfigured',
      operationId: 'soil-distribution',
      contractVersion: null,
      providerIssueTime: null,
    },
  }),
  soilTest: Object.freeze({
    sourceId: 'user-soil-test',
    sourceName: '사용자 등록 토양검정 결과',
    sourceUrl: 'https://soil.rda.go.kr/',
    spatialLevel: 'FIELD',
    spatialLabel: '사용자가 등록한 검정 필지',
    provenance: {
      adapterId: 'user-soil-test',
      adapterVersion: '1',
      operationId: 'user-submitted-soil-exam',
      contractVersion: 'user-soil-test-v1',
      providerIssueTime: null,
    },
  }),
  soilExam: Object.freeze({
    sourceId: 'soil-exam-v2',
    sourceName: '토양검정 화학성 상세정보 V2',
    sourceUrl: 'https://www.data.go.kr/data/15144647/openapi.do',
    spatialLevel: 'FIELD',
    spatialLabel: '선택 필지 최근 토양검정',
    provenance: {
      adapterId: 'soil-exam-v2',
      adapterVersion: 'unconfigured',
      operationId: 'getSoilExam',
      contractVersion: null,
      providerIssueTime: null,
    },
  }),
  fieldSoil: Object.freeze({
    sourceId: 'soil-field-v3',
    sourceName: '토양도 기반 토양특성 상세정보 V3',
    sourceUrl: 'https://www.data.go.kr/data/15144225/openapi.do',
    spatialLevel: 'FIELD',
    spatialLabel: '선택 필지 1:5,000 토양도',
    provenance: {
      adapterId: 'soil-field-v3',
      adapterVersion: 'unconfigured',
      operationId: 'getSoilCharacter',
      contractVersion: null,
      providerIssueTime: null,
    },
  }),
  shortForecast: Object.freeze({
    sourceId: 'kma-short-forecast',
    sourceName: '기상청 단기예보',
    sourceUrl:
      'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst',
    spatialLevel: 'FORECAST_GRID',
    spatialLabel: '단기예보 격자',
    provenance: {
      adapterId: 'kma-short-forecast',
      adapterVersion: 'unconfigured',
      operationId: 'get-vilage-forecast',
      contractVersion: null,
      providerIssueTime: null,
    },
  }),
  midForecast: Object.freeze({
    sourceId: 'kma-mid-forecast',
    sourceName: '기상청 중기예보',
    sourceUrl: 'https://apis.data.go.kr/1360000/MidFcstInfoService/getMidTa',
    spatialLevel: 'FORECAST_REGION',
    spatialLabel: '중기예보 지역',
    provenance: {
      adapterId: 'kma-mid-forecast',
      adapterVersion: 'unconfigured',
      operationId: 'get-mid-forecast',
      contractVersion: null,
      providerIssueTime: null,
    },
  }),
  smartfarm: Object.freeze({
    sourceId: 'smartfarm-reference',
    sourceName: '스마트팜코리아 공개 비교자료',
    sourceUrl:
      'https://smartfarmkorea.net/openApi/openApiList.do?menuId=M1104030101',
    spatialLevel: 'REFERENCE_DATASET',
    spatialLabel: '동종 작물 공개 농가 코호트',
    provenance: {
      adapterId: 'smartfarm-reference',
      adapterVersion: 'unconfigured',
      operationId: 'public-peer-cohort',
      contractVersion: null,
      providerIssueTime: null,
    },
  }),
});

export function createApplicationServices({
  adapters = {},
  assistant = null,
  rules = [],
  ruleRegistry = createRuleRegistry(rules),
  verifiedLocationMappings = {},
  clock = Date.now,
  randomBytes = nodeRandomBytes,
  candidateStore = new TtlMemoryStore({
    clock,
    capacityPolicy: STORE_CAPACITY_POLICY,
  }),
  analysisStore = new TtlMemoryStore({
    clock,
    capacityPolicy: STORE_CAPACITY_POLICY,
  }),
  candidateTtlMs = CANDIDATE_TTL_MS,
  analysisTtlMs = ANALYSIS_TTL_MS,
  reportLockTtlMs = REPORT_LOCK_TTL_MS,
  coreDeadlineMs = 5_000,
  runtimeStatus = null,
  sharedStateProbe = null,
  minimumVerifiedMappingCount = 6,
  capabilities = {
    smartfarm: 'DISABLED',
    satellite: 'DISABLED',
    persistence: 'NOT_AVAILABLE',
    assistant: 'FALLBACK',
    deviceBackup: 'NOT_AVAILABLE',
    pestReference: 'REVIEWED_REFERENCE',
    pestLiveOccurrence: 'NOT_CONNECTED',
  },
} = {}) {
  validateDependencies({
    ruleRegistry,
    clock,
    randomBytes,
    candidateStore,
    analysisStore,
  });
  assertPositiveDuration(candidateTtlMs, 'candidateTtlMs');
  assertPositiveDuration(analysisTtlMs, 'analysisTtlMs');
  assertPositiveDuration(reportLockTtlMs, 'reportLockTtlMs');
  assertPositiveDuration(coreDeadlineMs, 'coreDeadlineMs');
  if (
    !Number.isInteger(minimumVerifiedMappingCount) ||
    minimumVerifiedMappingCount < 1
  ) {
    throw new TypeError(
      'minimumVerifiedMappingCount must be a positive integer',
    );
  }
  if (sharedStateProbe !== null && typeof sharedStateProbe !== 'function') {
    throw new TypeError('sharedStateProbe must be a function or null');
  }
  const startupMappingValidation = validateVerifiedLocationMappings(
    verifiedLocationMappings,
    { now: () => new Date(clock()) },
  );
  if (!startupMappingValidation.valid) {
    throw new TypeError(
      `verifiedLocationMappings failed validation: ${startupMappingValidation.errors.join('; ')}`,
    );
  }

  async function searchLocations({ ownerSessionId, query, signal }) {
    const envelope = await callLocationAdapter(adapters.kakao, query, signal, clock);
    if (signal?.aborted) throw signal.reason;
    return issueLocationCandidates(ownerSessionId, envelope);
  }

  async function resolveCurrentLocation({
    ownerSessionId,
    latitude,
    longitude,
    signal,
  }) {
    if (
      !Number.isFinite(latitude) ||
      latitude < 32 ||
      latitude > 39.5 ||
      !Number.isFinite(longitude) ||
      longitude < 123 ||
      longitude > 133
    ) {
      throw serviceError(
        'CURRENT_LOCATION_INVALID',
        'Current location must be finite coordinates within the supported area.',
        400,
      );
    }
    const envelope = await callCurrentLocationAdapter(
      adapters.kakao,
      { latitude, longitude },
      signal,
      clock,
    );
    if (signal?.aborted) throw signal.reason;
    return issueLocationCandidates(ownerSessionId, envelope);
  }

  async function issueLocationCandidates(ownerSessionId, envelope) {
    const expiresAtMs = clock() + candidateTtlMs;
    const candidates = [];
    const insertedTokens = [];
    try {
      if (envelopeHasUsableData(envelope)) {
        for (const candidate of envelope.data.candidates) {
          const candidateToken = createOpaqueId(randomBytes, 16);
          const storedValue = {
            ownerSessionId,
            resolvedLocation: normalizeResolvedLocation(candidate),
          };
          let inserted;
          if (typeof candidateStore.setIfAbsent === 'function') {
            inserted = await Promise.resolve(
              candidateStore.setIfAbsent(
                candidateToken,
                storedValue,
                candidateTtlMs,
              ),
            );
          } else if (
            (await Promise.resolve(candidateStore.get(candidateToken))) ===
            undefined
          ) {
            await Promise.resolve(
              candidateStore.set(
                candidateToken,
                storedValue,
                candidateTtlMs,
              ),
            );
            inserted = true;
          } else {
            inserted = false;
          }
          if (!inserted) {
            throw serviceError(
              'LOCATION_TOKEN_COLLISION',
              'A unique location candidate token could not be allocated.',
              500,
            );
          }
          insertedTokens.push(candidateToken);
          candidates.push({
            candidateToken,
            displayName: candidate.displayName,
            resolutionMode: candidate.resolutionMode,
            expiresAt: new Date(expiresAtMs).toISOString(),
          });
        }
      }
    } catch (error) {
      for (const candidateToken of insertedTokens) {
        await Promise.resolve(candidateStore.delete(candidateToken));
      }
      throw error;
    }

    return {
      candidates,
      sourceState: envelope.adapterState,
      limitations:
        envelope.adapterState === 'SUCCESS'
          ? []
          : ['LOCATION_PROVIDER_UNAVAILABLE_OR_NO_DATA'],
    };
  }

  async function createAnalysis({
    ownerSessionId,
    analysisId,
    input,
    signal,
  }) {
    const lifecycle = createLifecycleTracker(clock);
    lifecycle.transition('RECEIVED');
    lifecycle.transition('VALIDATING');
    const request = normalizeAnalysisInput(input);
    lifecycle.transition('RESOLVING_LOCATION');
    const candidate = await Promise.resolve(
      candidateStore.get(request.location.candidateToken),
    );
    if (!candidate || candidate.ownerSessionId !== ownerSessionId) {
      throw serviceError(
        'LOCATION_TOKEN_INVALID',
        'The location candidate is invalid or expired.',
        400,
      );
    }

    const resolvedLocation = candidate.resolvedLocation;
    const catalogDeadlineAt = clock() + Math.min(coreDeadlineMs, 3_000);
    const catalogEnvelope = await callSource(
      adapters.locationCatalog?.getCatalog,
      adapters.locationCatalog,
      {},
      SOURCE_BASES.locationCatalog,
      signal,
      catalogDeadlineAt,
      clock,
      'LOCATION_CATALOG_UNAVAILABLE',
    );
    const locationKeys = resolveLocationKeys(
      resolvedLocation,
      verifiedLocationMappings,
      {
        now: () => new Date(clock()),
        officialCatalog: envelopeHasUsableData(catalogEnvelope)
          ? catalogEnvelope.data
          : null,
      },
    );
    const moduleRules = {
      climate: ruleRegistry.resolve(request, 'CLIMATE'),
      soil: ruleRegistry.resolve(request, 'SOIL'),
      forecast: ruleRegistry.resolve(request, 'FORECAST'),
    };
    lifecycle.transition('FETCHING_MODULES');
    const envelopes = await collectCoreEnvelopes({
      adapters,
      locationKeys,
      request,
      regionLabel: generalizeRegionLabel(resolvedLocation.displayName),
      fieldParcelLookupKey: resolvedLocation.fieldParcelLookupKey,
      signal,
      clock,
      coreDeadlineMs,
    });
    envelopes.shortForecast = attachForecastScope(
      envelopes.shortForecast,
      locationKeys.shortForecastScope,
    );
    envelopes.observations = attachVerifiedDistance(
      envelopes.observations,
      locationKeys.observationDistanceKm,
    );

    lifecycle.transition('CALCULATING');
    const climate = withEvidence(
      evaluateClimate({
        request,
        rules: moduleRules.climate,
        observations: envelopes.climate.data?.observations ?? [],
      }),
      buildClimateEvidence,
      moduleRules.climate,
      envelopes.climate,
    );
    // 필지 실측값은 지역 면적통계보다 우선한다. 사용자 등록값이 있으면 가장
    // 먼저 사용하고, 없으면 공공 API의 최신 검정값을 사용한다. 자료끼리
    // 평균하거나 빈 값을 지역값으로 채우지 않는다.
    const soilMeasurement = buildSoilTestEnvelope(request.soilTest, clock);
    const providerSoilMeasurement = envelopeHasUsableData(envelopes.soilExam)
      ? envelopes.soilExam
      : null;
    const soilBasisEnvelope =
      soilMeasurement ?? providerSoilMeasurement ?? envelopes.soil;
    const soilMeasurementBasis = soilMeasurement
      ? 'USER_SOIL_TEST'
      : providerSoilMeasurement
        ? 'PROVIDER_SOIL_TEST'
        : 'REGIONAL_STATISTICS';
    const soilRulesForAvailableBasis = selectSoilRulesForBasis(
      moduleRules.soil,
      soilMeasurementBasis,
    );
    let soil = withEvidence(
      evaluateSoil({
        request,
        rules: soilRulesForAvailableBasis,
        metrics: soilBasisEnvelope.data?.metrics ?? [],
      }),
      buildSoilEvidence,
      soilRulesForAvailableBasis,
      soilBasisEnvelope,
    );
    soil = attachSoilMeasurement(soil, {
      userSoilTest: request.soilTest,
      providerEnvelope: envelopes.soilExam,
      regionalEnvelope: envelopes.soil,
    });
    soil = attachFieldSoilProfile(soil, envelopes.fieldSoil);
    if (soilMeasurement !== null) envelopes.soilTest = soilMeasurement;
    const shortDays = decorateForecastDays(
      envelopes.shortForecast.data?.days ?? [],
      envelopes.shortForecast,
    );
    const midDays = decorateForecastDays(
      envelopes.midForecast.data?.days ?? [],
      envelopes.midForecast,
    );
    const forecast = withEvidence(
      evaluateForecast({
        request,
        rules: moduleRules.forecast,
        shortForecast: shortDays,
        midForecast: midDays,
        unitsByMetric: forecastUnits(),
      }),
      buildForecastEvidence,
      moduleRules.forecast,
      [envelopes.shortForecast, envelopes.midForecast],
    );
    const observations = envelopeHasUsableData(envelopes.observations)
      ? withEvidence(
          evaluateObservation({
            stationId: locationKeys.observationStationId,
            stationName: envelopes.observations.data?.stationName,
            distanceKm: locationKeys.observationDistanceKm,
            readings: envelopes.observations.data?.readings,
            monthlyNormals: envelopes.observations.data?.monthlyNormals,
            now: new Date(clock()),
          }),
          buildObservationEvidence,
          envelopes.observations,
        )
      : unavailableModule(
          `RECENT_OBSERVATIONS_UNAVAILABLE:${envelopes.observations?.adapterState ?? 'UNAVAILABLE'}`,
        );

    applyEnvelopeQuality(climate, envelopes.climate);
    applyEnvelopeQuality(soil, soilBasisEnvelope);
    applyObservationEnvelopeQuality(observations, envelopes.observations);
    applyEnvelopeQuality(forecast, [
      envelopes.shortForecast,
      envelopes.midForecast,
    ]);

    const estimateCoordinates = resolvedLocation.administrativeRepresentative ??
      resolvedLocation;
    const fieldConditionsEstimate = estimateFieldConditions({
      cultivationMode: request.cultivationMode,
      latitude: estimateCoordinates.latitude,
      recentDays: observations.result?.days ?? [],
      forecastDays: forecast.result?.mergedDisplayDays ?? [],
      observationDistanceKm: locationKeys.observationDistanceKm,
      fieldProfile: soil.result?.fieldProfile ?? null,
    });

    const internalModules = {
      climate,
      soil,
      observations,
      shortForecast: moduleFromEnvelope(
        envelopes.shortForecast,
        envelopes.shortForecast.data,
        'SHORT_FORECAST_UNAVAILABLE',
      ),
      midForecast: moduleFromEnvelope(
        envelopes.midForecast,
        envelopes.midForecast.data,
        'MID_FORECAST_UNAVAILABLE',
      ),
      forecast,
    };
    const analysisStates = evaluateAnalysisStates({
      request,
      modules: internalModules,
    });
    const rawDecision = decideGuidance({
      request,
      modules: internalModules,
      analysisStates,
    });
    const decision = {
      ...rawDecision,
      message: renderDecisionMessage(request, rawDecision.code),
    };
    const growthScore = calculateGrowthScore({
      request,
      climate,
      soil,
      forecast,
      now: new Date(clock()).toISOString(),
    });
    const actionCandidates = createActionCandidates({
      request,
      decision,
      modules: internalModules,
    });
    const actionProjection = mergeAndRankActions({
      request,
      actions: actionCandidates,
    });
    const actions = actionProjection.displayActions.map((action) => ({
      ...action,
      title: renderActionTitle(action.actionId),
    }));

    const nowIso = new Date(clock()).toISOString();
    lifecycle.transition('CORE_READY');
    const result = {
      analysisId: analysisId || createOpaqueId(randomBytes, 16),
      createdAt: nowIso,
      inputSummary: {
        usageMode: request.usageMode,
        regionLabel: generalizeRegionLabel(resolvedLocation.displayName),
        crop: request.crop,
        cultivationMode: request.cultivationMode,
        seasonLabel: request.season.profileId,
        growthStage: request.growthStage,
        locationPrecision: resolvedLocation.resolutionMode,
        parcelState: request.parcel
          ? 'POLYGON_REGISTERED'
          : resolvedLocation.resolutionMode === 'ADMIN_AREA_BROAD'
            ? 'ADMIN_AREA_ONLY'
            : 'UNREGISTERED',
      },
      state: analysisStates.analysisState,
      conditionState: analysisStates.conditionState,
      riskState: analysisStates.riskState,
      growthScore,
      decision,
      primaryAction: actionProjection.primaryAction,
      actions,
      climate,
      soil,
      observations,
      forecast,
      fieldConditionsEstimate,
      smartfarm: null,
      satellite: request.options.includeSatelliteObservation
        ? unavailableModule('SATELLITE_P2_NOT_ENABLED', 'UNSUPPORTED')
        : null,
      dataSources: collectSourceDisclosures(Object.values(envelopes)),
      capabilities: {
        smartfarm: capabilities.smartfarm ?? 'DISABLED',
        satellite: capabilities.satellite ?? 'DISABLED',
        persistence: capabilities.persistence ?? 'NOT_AVAILABLE',
        deviceBackup: capabilities.deviceBackup ?? 'NOT_AVAILABLE',
      },
      persistenceState: request.options.saveConsent
        ? 'NOT_AVAILABLE'
        : 'NOT_REQUESTED',
      limitations: collectLimitations({
        request,
        decision,
        modules: internalModules,
        envelopes,
      }),
      ruleVersion: combineRuleVersions(moduleRules),
      lifecycle: lifecycle.snapshot(),
      report: {
        state: 'NOT_REQUESTED',
        value: null,
      },
    };

    const expiresAtMs = clock() + analysisTtlMs;
    await persistAnalysisRecord(
      result.analysisId,
      {
        ownerSessionId,
        result: structuredClone(result),
        reportPending: false,
        reportLockExpiresAtMs: null,
        expiresAtMs,
      },
    );
    return structuredClone(result);
  }

  function normalizeAnalysisInput(input) {
    return validateAndNormalizeRequest(input, { ruleRegistry });
  }

  async function getAnalysis({ ownerSessionId, analysisId }) {
    const record = await Promise.resolve(analysisStore.get(analysisId));
    if (!record || record.ownerSessionId !== ownerSessionId) return null;
    return structuredClone(record.result);
  }

  async function answerAnalysisQuestion({
    ownerSessionId,
    analysisId,
    question,
    signal,
  }) {
    const record = await Promise.resolve(analysisStore.get(analysisId));
    if (!record || record.ownerSessionId !== ownerSessionId) return null;
    const normalizedQuestion = normalizeQuestion(question);
    if (!normalizedQuestion) {
      throw serviceError(
        'INVALID_INPUT',
        'Assistant question must not be empty.',
        400,
      );
    }
    return answerGroundedQuestion({
      analysis: record.result,
      question: normalizedQuestion,
      assistant,
      signal,
      deadlineAt: clock() + Math.min(coreDeadlineMs, 8_000),
    });
  }

  async function requestReport({ ownerSessionId, analysisId }) {
    const storedRecord = await Promise.resolve(analysisStore.get(analysisId));
    if (!storedRecord || storedRecord.ownerSessionId !== ownerSessionId) {
      return null;
    }
    const record = structuredClone(storedRecord);
    if (['READY', 'FALLBACK'].includes(record.result.report.state)) {
      return { analysis: structuredClone(record.result), started: false };
    }
    if (
      record.reportPending &&
      Number.isFinite(record.reportLockExpiresAtMs) &&
      record.reportLockExpiresAtMs > clock()
    ) {
      return { analysis: structuredClone(record.result), started: true };
    }

    record.reportPending = true;
    record.reportLockExpiresAtMs = clock() + reportLockTtlMs;
    record.result.report = { state: 'PENDING', value: null };
    if (record.result.lifecycle?.currentState !== 'REPORT_PENDING') {
      appendLifecycleTransition(
        record.result,
        'REPORT_PENDING',
        clock,
      );
    }
    record.expiresAtMs = Math.max(
      record.expiresAtMs,
      record.reportLockExpiresAtMs,
    );
    let acquired;
    if (typeof analysisStore.compareAndSet === 'function') {
      acquired = await Promise.resolve(
        analysisStore.compareAndSet(
          analysisId,
          storedRecord,
          record,
          Math.max(1, record.expiresAtMs - clock()),
        ),
      );
    } else {
      acquired = await persistAnalysisRecord(analysisId, record);
    }
    if (!acquired) {
      const latest = await Promise.resolve(analysisStore.get(analysisId));
      if (!latest || latest.ownerSessionId !== ownerSessionId) return null;
      return {
        analysis: structuredClone(latest.result),
        started: !['READY', 'FALLBACK'].includes(latest.result.report.state),
      };
    }

    queueMicrotask(() => {
      void completeDeterministicReport({ ownerSessionId, analysisId });
    });
    return { analysis: structuredClone(record.result), started: true };
  }

  async function completeDeterministicReport({ ownerSessionId, analysisId }) {
    try {
      const storedRecord = await Promise.resolve(
        analysisStore.get(analysisId),
      );
      if (!storedRecord || storedRecord.ownerSessionId !== ownerSessionId) {
        return;
      }
      const current = structuredClone(storedRecord);
      current.result.report = {
        state: 'FALLBACK',
        value: buildDeterministicReport(current.result),
      };
      appendLifecycleTransition(current.result, 'COMPLETE', clock);
      current.reportPending = false;
      current.reportLockExpiresAtMs = null;
      if (typeof analysisStore.compareAndSet === 'function') {
        await Promise.resolve(
          analysisStore.compareAndSet(
            analysisId,
            storedRecord,
            current,
            Math.max(1, current.expiresAtMs - clock()),
          ),
        );
      } else {
        await persistAnalysisRecord(analysisId, current);
      }
    } catch {
      // The request already returned PENDING. A transient store failure keeps
      // that state until the short lock/record TTL instead of fabricating a
      // completed report in process memory.
    }
  }

  async function persistAnalysisRecord(analysisId, record) {
    const remainingTtlMs = record.expiresAtMs - clock();
    if (remainingTtlMs <= 0) {
      await Promise.resolve(analysisStore.delete(analysisId));
      return false;
    }
    await Promise.resolve(
      analysisStore.set(analysisId, record, remainingTtlMs),
    );
    return true;
  }

  async function getPreflight() {
    const persistenceHealth = await verifySharedStateCapability({
      configuredState: capabilities.persistence ?? 'NOT_AVAILABLE',
      probe: sharedStateProbe,
    });
    const mappingValidation = validateVerifiedLocationMappings(
      verifiedLocationMappings,
      { now: () => new Date(clock()) },
    );
    const adapterStates = {
      kakao: adapterCapability(
        adapters.kakao,
        runtimeStatus?.adapters?.kakao,
        'searchLocations',
      ),
      climate: adapterCapability(
        adapters.climate,
        runtimeStatus?.adapters?.climate,
        'getNormals',
      ),
      observations: adapterCapability(
        adapters.observations,
        runtimeStatus?.adapters?.observations,
        'getRecent',
      ),
      soilV2: adapterCapability(
        adapters.soilV2,
        runtimeStatus?.adapters?.soilV2,
        'getDistribution',
      ),
      kmaShort: adapterCapability(
        adapters.kmaShort,
        runtimeStatus?.adapters?.kmaShort,
        'getForecast',
      ),
      kmaMid: adapterCapability(
        adapters.kmaMid,
        runtimeStatus?.adapters?.kmaMid,
        'getForecast',
      ),
    };
    const activeRuleCount = ruleRegistry.rules.length;
    const decisionRules = ruleRegistry.rules.filter(isDecisionCapableRule);
    const decisionRuleCount = decisionRules.length;
    const registeredCrops = [
      ...new Set(ruleRegistry.rules.map((rule) => rule.crop)),
    ].sort();
    const contextCoverage = buildRuleContextCoverage(ruleRegistry);
    const cropCoverage = buildCropRuleCoverage(contextCoverage);
    const configuredCrops = cropCoverage
      .filter(({ status }) => status === 'CONFIGURED')
      .map(({ crop }) => crop);
    const completeCropCount = configuredCrops.length;
    const verifiedLocationMappingCount = mappingValidation.verifiedCount;
    const p0ReadyLocationMappingCount = mappingValidation.p0ReadyCount;
    const requiredAdaptersReady = Object.values(adapterStates).every(
      isReadyCapability,
    );
    const rulesReady =
      decisionRuleCount > 0 &&
      completeCropCount === Crop.length &&
      (ruleRegistry.invalidRules?.length ?? 0) === 0;
    const mappingsReady =
      mappingValidation.valid &&
      p0ReadyLocationMappingCount >= minimumVerifiedMappingCount;
    const ready = requiredAdaptersReady && rulesReady && mappingsReady;
    const sharedStateReady = persistenceHealth.ready;
    return {
      ready,
      serviceState: ready ? 'READY' : 'HOLD',
      deploymentReady: ready && sharedStateReady,
      deploymentState: ready && sharedStateReady ? 'READY' : 'HOLD',
      serviceVersion: '3.0.0',
      ruleRegistry: {
        activeRuleCount,
        decisionRuleCount,
        registeredCrops,
        configuredCrops,
        completeCropCount,
        cropCoverage,
        contextCoverage,
        minimumRequiredCropCount: Crop.length,
        invalidRuleCount: ruleRegistry.invalidRules?.length ?? 0,
        status: rulesReady ? 'CONFIGURED' : 'HOLD',
      },
      locationMappings: {
        valid: mappingValidation.valid,
        validationErrors: [...mappingValidation.errors],
        verifiedCount: verifiedLocationMappingCount,
        p0ReadyCount: p0ReadyLocationMappingCount,
        p0IncompleteAreaCodes: [
          ...mappingValidation.p0IncompleteAreaCodes,
        ],
        minimumRequired: minimumVerifiedMappingCount,
        status: mappingsReady ? 'CONFIGURED' : 'HOLD',
      },
      adapters: adapterStates,
      optionalAdapters: {
        soilExam: adapterCapability(
          adapters.soilExam,
          runtimeStatus?.adapters?.soilExam,
          'getLatestExam',
        ),
        soilField: adapterCapability(
          adapters.soilField,
          runtimeStatus?.adapters?.soilField,
          'getFieldProfile',
        ),
      },
      contracts: sanitizeRuntimeContracts(runtimeStatus?.contracts),
      capabilities: {
        smartfarm: 'DISABLED',
        pestReference:
          capabilities.pestReference ?? 'REVIEWED_REFERENCE',
        pestLiveOccurrence:
          capabilities.pestLiveOccurrence ?? 'NOT_CONNECTED',
        satellite: capabilities.satellite ?? 'DISABLED',
        persistence: persistenceHealth.capability,
        deviceBackup: capabilities.deviceBackup ?? 'NOT_AVAILABLE',
        report: 'DETERMINISTIC_TEMPLATE',
        assistant: capabilities.assistant ?? assistant?.state ?? 'FALLBACK',
      },
      guarantees: {
        growthScoreCalculation: 'EVIDENCE_WEIGHTED_MEAN_WITH_GUARDRAILS',
        growthScoreConfidenceSeparated: true,
        growthScoreMinimumEvidenceStrength: 0.35,
        regionalSoilMaximumEffectiveShare: 0.12,
        fieldSoilContinuousGuardrail: true,
        hydroponicRequiresIndoorEnvironment: true,
        missingValuesBecomeZero: false,
        regionalSoilCreatesScoreCap: false,
        unverifiedSoilRepresentativeValue: false,
        freeFormLlm: false,
      },
      storage: {
        state: persistenceHealth.state,
        verifiedAt: persistenceHealth.verifiedAt,
        probe: 'ATOMIC_WRITE_READ_DELETE',
      },
      blockers: [
        ...(!rulesReady ? ['VERIFIED_RULES_NOT_CONFIGURED'] : []),
        ...(completeCropCount < Crop.length
          ? [
              'VERIFIED_RULE_COVERAGE_INSUFFICIENT',
              'VERIFIED_RULE_CONTEXT_COVERAGE_INSUFFICIENT',
            ]
          : []),
        ...(!mappingValidation.valid
          ? ['VERIFIED_LOCATION_MAPPINGS_INVALID']
          : []),
        ...(!mappingsReady
          ? ['VERIFIED_LOCATION_MAPPINGS_INSUFFICIENT']
          : []),
        ...Object.entries(adapterStates)
          .filter(([, state]) => !isReadyCapability(state))
          .map(([name, state]) => `ADAPTER_${name}:${state}`),
      ],
      deploymentBlockers: [
        ...(!sharedStateReady
          ? [
              persistenceHealth.state === 'NOT_CONFIGURED'
                ? 'SHARED_STATE_NOT_CONFIGURED'
                : 'SHARED_STATE_PROBE_FAILED',
            ]
          : []),
      ],
    };
  }

  return Object.freeze({
    searchLocations,
    resolveCurrentLocation,
    normalizeAnalysisInput,
    createAnalysis,
    getAnalysis,
    answerAnalysisQuestion,
    requestReport,
    getPreflight,
  });
}

async function collectCoreEnvelopes({
  adapters,
  locationKeys,
  request,
  regionLabel,
  fieldParcelLookupKey,
  signal,
  clock,
  coreDeadlineMs,
}) {
  const deadlineAt = clock() + coreDeadlineMs;
  const shortIssue = latestKmaShortIssue(new Date(clock()));
  const midIssue = latestKmaMidIssue(new Date(clock()));
  const calls = {
    climate: callSource(
      adapters.climate?.getNormals,
      adapters.climate,
      locationKeys.normalStationId
        ? {
            stationId: locationKeys.normalStationId,
            season: request.season,
          }
        : null,
      SOURCE_BASES.climate,
      signal,
      deadlineAt,
      clock,
      'NORMAL_STATION_KEY_UNAVAILABLE',
    ),
    observations: callSource(
      adapters.observations?.getRecent,
      adapters.observations,
      locationKeys.observationStationId
        ? {
            stationId: locationKeys.observationStationId,
            completedDays: 7,
          }
        : null,
      SOURCE_BASES.observations,
      signal,
      deadlineAt,
      clock,
      'OBSERVATION_STATION_KEY_UNAVAILABLE',
    ),
    soil: callSource(
      adapters.soilV2?.getDistribution,
      adapters.soilV2,
      locationKeys.verifiedSoilAreaCode
        ? {
            verifiedSoilAreaCode: locationKeys.verifiedSoilAreaCode,
            landUse: soilLandUseFor(request),
          }
        : null,
      SOURCE_BASES.soil,
      signal,
      deadlineAt,
      clock,
      'VERIFIED_SOIL_AREA_KEY_UNAVAILABLE',
    ),
    fieldSoil: callSource(
      adapters.soilField?.getFieldProfile,
      adapters.soilField,
      fieldParcelLookupKey
        ? { pnuCode: fieldParcelLookupKey }
        : null,
      SOURCE_BASES.fieldSoil,
      signal,
      deadlineAt,
      clock,
      'FIELD_PNU_UNAVAILABLE',
    ),
    soilExam: callSource(
      adapters.soilExam?.getLatestExam,
      adapters.soilExam,
      !request.soilTest && fieldParcelLookupKey
        ? { pnuCode: fieldParcelLookupKey }
        : null,
      SOURCE_BASES.soilExam,
      signal,
      deadlineAt,
      clock,
      request.soilTest
        ? 'USER_SOIL_TEST_ALREADY_PROVIDED'
        : 'FIELD_PNU_UNAVAILABLE',
    ),
    shortForecast: callSource(
      adapters.kmaShort?.getForecast,
      adapters.kmaShort,
      locationKeys.shortForecastGrid
        ? { ...locationKeys.shortForecastGrid, ...shortIssue }
        : null,
      SOURCE_BASES.shortForecast,
      signal,
      deadlineAt,
      clock,
      'FORECAST_GRID_UNAVAILABLE',
    ),
    midForecast: callSource(
      adapters.kmaMid?.getForecast,
      adapters.kmaMid,
      locationKeys.midForecastRegionIds
        ? { ...locationKeys.midForecastRegionIds, ...midIssue }
        : null,
      SOURCE_BASES.midForecast,
      signal,
      deadlineAt,
      clock,
      'VERIFIED_MID_FORECAST_REGION_UNAVAILABLE',
    ),
  };
  const entries = await Promise.all(
    Object.entries(calls).map(async ([key, promise]) => [key, await promise]),
  );
  if (signal?.aborted) throw signal.reason;
  return Object.fromEntries(entries);
}

/**
 * 사용자가 등록한 검정 pH를 토양 규칙이 읽는 면적통계 형태로 바꾼다.
 * 실측값은 폭이 없는 값이므로 도메인이 이미 지원하는 점 구간
 * (lower === upper, 양끝 포함)으로 표현한다. 면적 비율을 꾸며내지 않으므로
 * 경계 불확실 면적은 0이 되고 적합/이탈이 분명하게 갈린다.
 */
// 검정 항목 → 검수된 규칙이 읽는 지표 이름·단위. 흙토람 결과지 표기를 따른다.
const SOIL_TEST_METRICS = Object.freeze([
  { field: 'ph', metric: 'PH', unit: 'pH' },
  { field: 'electricalConductivity', metric: 'EC', unit: 'dS/m' },
  { field: 'organicMatter', metric: 'ORGANIC_MATTER', unit: 'g/kg' },
  { field: 'availablePhosphate', metric: 'AVAILABLE_PHOSPHATE', unit: 'mg/kg' },
  { field: 'exchangeableK', metric: 'EXCHANGEABLE_K', unit: 'cmol+/kg' },
  { field: 'exchangeableCa', metric: 'EXCHANGEABLE_CA', unit: 'cmol+/kg' },
  { field: 'exchangeableMg', metric: 'EXCHANGEABLE_MG', unit: 'cmol+/kg' },
]);

function measuredPointMetric({ metric, unit }, value) {
  return {
    metric,
    unit,
    boundarySemanticsVerified: true,
    totalValidArea: 1,
    areaUnit: 'MEASURED_POINT',
    intervals: [
      {
        lower: value,
        upper: value,
        lowerInclusive: true,
        upperInclusive: true,
        area: 1,
        areaUnit: 'MEASURED_POINT',
      },
    ],
  };
}

/**
 * 지역 통계 API는 작물 판정에 필요한 핵심 pH 분포만 제공한다. 필지 토양검정용
 * 보조 화학성 규칙을 지역 통계의 결측으로 계산하면, 정상 수신한 핵심 pH까지
 * HOLD로 내려가므로 지역 통계에서는 검수된 핵심 규칙만 평가한다.
 * 실제 필지·사용자 검사값에서는 보조 화학성 규칙도 그대로 평가한다.
 */
function selectSoilRulesForBasis(rules, measurementBasis) {
  const safeRules = Array.isArray(rules) ? rules : [];
  if (measurementBasis !== 'REGIONAL_STATISTICS') return safeRules;
  const criticalRules = safeRules.filter((rule) => rule?.critical === true);
  return criticalRules.length > 0 ? criticalRules : safeRules;
}

function buildSoilTestEnvelope(soilTest, clock) {
  if (!soilTest || typeof soilTest !== 'object') return null;
  const ph = soilTest.ph;
  if (!Number.isFinite(ph)) return null;

  const envelope = createDataEnvelope(
    {
      ...SOURCE_BASES.soilTest,
      observedAt: `${soilTest.sampledOn}T00:00:00.000Z`,
      issuedAt: null,
      validFrom: null,
      validTo: null,
      distanceKm: null,
      unit: 'pH',
      adapterState: 'SUCCESS',
      deliveryState: 'LIVE',
      qualityFlags: ['SOIL_VALUE_FROM_USER_SUBMITTED_EXAM'],
      data: {
        dataRole: 'USER_SOIL_TEST',
        sampledOn: soilTest.sampledOn,
        issuer: soilTest.issuer ?? null,
        // 등록된 항목만 싣는다. 비어 있는 항목을 추정해서 채우지 않는다.
        metrics: SOIL_TEST_METRICS.filter((entry) =>
          Number.isFinite(soilTest[entry.field]),
        ).map((entry) => measuredPointMetric(entry, soilTest[entry.field])),
      },
    },
    { now: () => new Date(clock()) },
  );
  return envelope;
}

/**
 * 실측 검정값과 지역 면적통계를 구분해서 남긴다. 같은 필드에 합치지 않는다.
 */
function attachSoilMeasurement(
  module,
  { userSoilTest, providerEnvelope, regionalEnvelope },
) {
  if (!module || typeof module !== 'object') return module;
  const regionalStatistics = envelopeHasUsableData(regionalEnvelope)
    ? { state: regionalEnvelope.adapterState, usedForDecision: false }
    : {
        state: regionalEnvelope?.adapterState ?? 'UNAVAILABLE',
        usedForDecision: false,
      };
  if (userSoilTest) {
    const { userConfirmed, ...measured } = userSoilTest;
    return {
      ...module,
      result: {
        ...(module.result ?? {}),
        measurementBasis: 'USER_SOIL_TEST',
        userSoilTest: measured,
        providerSoilTest: null,
        regionalStatistics,
      },
    };
  }
  if (envelopeHasUsableData(providerEnvelope)) {
    const providerData = providerEnvelope.data;
    return {
      ...module,
      result: {
        ...(module.result ?? {}),
        measurementBasis: 'PROVIDER_SOIL_TEST',
        userSoilTest: null,
        providerSoilTest: {
          sampledOn: providerData.sampledOn,
          examType: providerData.examType,
          measurements: providerData.metrics.map((metric) => ({
            metric: metric.metric,
            unit: metric.unit,
            value: metric.intervals[0]?.lower ?? null,
          })),
        },
        regionalStatistics,
      },
    };
  }
  return {
    ...module,
    result: {
      ...(module.result ?? {}),
      measurementBasis: 'REGIONAL_STATISTICS',
      userSoilTest: null,
      providerSoilTest: null,
      regionalStatistics: {
        ...regionalStatistics,
        usedForDecision: envelopeHasUsableData(regionalEnvelope),
      },
    },
  };
}

function attachFieldSoilProfile(module, envelope) {
  if (!module || typeof module !== 'object') return module;
  const fieldProfile = envelopeHasUsableData(envelope)
    ? structuredClone(envelope.data)
    : null;
  return {
    ...module,
    result: {
      ...(module.result ?? {}),
      fieldProfile,
      fieldProfileState: envelope?.adapterState ?? 'UNAVAILABLE',
    },
  };
}

function soilLandUseFor(request) {
  if (request.cultivationMode === 'FACILITY_SOIL') return 'FACHS';
  if (['APPLE', 'PEAR'].includes(request.crop)) return 'FRUIT';
  return 'PFLD';
}

async function callLocationAdapter(adapter, query, signal, clock) {
  const locationSource = {
    sourceId: 'kakao-location',
    sourceName: 'Kakao Local',
    sourceUrl: 'https://dapi.kakao.com/v2/local/search/address.json',
    spatialLevel: 'FIELD',
    spatialLabel: '위치 후보',
    provenance: {
      adapterId: 'kakao-location',
      adapterVersion: 'unconfigured',
      operationId: 'search-address',
      contractVersion: null,
      providerIssueTime: null,
    },
  };
  if (!adapter || typeof adapter.searchLocations !== 'function') {
    return unavailableEnvelope(
      locationSource,
      'UNSUPPORTED',
      'LOCATION_ADAPTER_UNAVAILABLE',
      clock,
    );
  }
  try {
    const returned = await adapter.searchLocations(query, { signal });
    if (returned === null || returned === undefined) {
      return unavailableEnvelope(
        locationSource,
        'INTERNAL_ERROR',
        'ADAPTER_RETURNED_NO_ENVELOPE',
        clock,
      );
    }
    if (!validateDataEnvelope(returned).valid) {
      return unavailableEnvelope(
        locationSource,
        'SCHEMA_CHANGED',
        'ADAPTER_ENVELOPE_SCHEMA_CHANGED',
        clock,
      );
    }
    return returned;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return unavailableEnvelope(
      locationSource,
      'INTERNAL_ERROR',
      'LOCATION_ADAPTER_ERROR',
      clock,
    );
  }
}

async function callCurrentLocationAdapter(adapter, coordinates, signal, clock) {
  const locationSource = {
    sourceId: 'kakao-location',
    sourceName: 'Kakao Local',
    sourceUrl:
      'https://dapi.kakao.com/v2/local/geo/coord2regioncode.json',
    spatialLevel: 'FIELD',
    spatialLabel: '현재 위치의 법정동',
    provenance: {
      adapterId: 'kakao-location',
      adapterVersion: 'unconfigured',
      operationId: 'reverse-region',
      contractVersion: null,
      providerIssueTime: null,
    },
  };
  if (!adapter || typeof adapter.resolveCurrentLocation !== 'function') {
    return unavailableEnvelope(
      locationSource,
      'UNSUPPORTED',
      'CURRENT_LOCATION_ADAPTER_UNAVAILABLE',
      clock,
    );
  }
  try {
    const returned = await adapter.resolveCurrentLocation(coordinates, {
      signal,
    });
    if (returned === null || returned === undefined) {
      return unavailableEnvelope(
        locationSource,
        'INTERNAL_ERROR',
        'ADAPTER_RETURNED_NO_ENVELOPE',
        clock,
      );
    }
    if (!validateDataEnvelope(returned).valid) {
      return unavailableEnvelope(
        locationSource,
        'SCHEMA_CHANGED',
        'ADAPTER_ENVELOPE_SCHEMA_CHANGED',
        clock,
      );
    }
    return returned;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return unavailableEnvelope(
      locationSource,
      'INTERNAL_ERROR',
      'CURRENT_LOCATION_ADAPTER_ERROR',
      clock,
    );
  }
}

async function callSource(
  method,
  receiver,
  params,
  sourceBase,
  signal,
  deadlineAt,
  clock,
  unavailableReason,
) {
  if (params === null || typeof method !== 'function') {
    return unavailableEnvelope(
      sourceBase,
      'UNSUPPORTED',
      unavailableReason,
      clock,
    );
  }
  const remainingMs = deadlineAt - clock();
  if (remainingMs <= 0) {
    return unavailableEnvelope(
      sourceBase,
      'TIMEOUT',
      'CORE_DEADLINE_EXCEEDED',
      clock,
    );
  }
  const controller = new AbortController();
  const forwardAbort = () => {
    controller.abort(signal.reason ?? new Error('request aborted'));
  };
  if (signal?.aborted) {
    forwardAbort();
  } else {
    signal?.addEventListener('abort', forwardAbort, { once: true });
  }
  const deadlineError = Object.assign(new Error('core deadline exceeded'), {
    code: 'CORE_DEADLINE_EXCEEDED',
  });
  let timeout;
  try {
    const deadlinePromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort(deadlineError);
        reject(deadlineError);
      }, remainingMs);
      timeout.unref?.();
    });
    const returned = await Promise.race([
      Promise.resolve(
        method.call(receiver, params, {
          signal: controller.signal,
          deadlineAt,
        }),
      ),
      deadlinePromise,
    ]);
    if (returned === null || returned === undefined) {
      return unavailableEnvelope(
        sourceBase,
        'INTERNAL_ERROR',
        'ADAPTER_RETURNED_NO_ENVELOPE',
        clock,
      );
    }
    if (!validateDataEnvelope(returned).valid) {
      return unavailableEnvelope(
        sourceBase,
        'SCHEMA_CHANGED',
        'ADAPTER_ENVELOPE_SCHEMA_CHANGED',
        clock,
      );
    }
    return returned;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (
      error?.code === 'CORE_DEADLINE_EXCEEDED' ||
      controller.signal.reason?.code === 'CORE_DEADLINE_EXCEEDED'
    ) {
      return unavailableEnvelope(
        sourceBase,
        'TIMEOUT',
        'CORE_DEADLINE_EXCEEDED',
        clock,
      );
    }
    return unavailableEnvelope(
      sourceBase,
      'INTERNAL_ERROR',
      'ADAPTER_UNEXPECTED_ERROR',
      clock,
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

function unavailableEnvelope(sourceBase, adapterState, flag, clock) {
  return createUnavailableEnvelope(
    {
      ...sourceBase,
      observedAt: null,
      issuedAt: null,
      validFrom: null,
      validTo: null,
      distanceKm: null,
      unit: null,
    },
    {
      adapterState,
      qualityFlags: [flag],
      now: () => new Date(clock()),
    },
  );
}

function attachVerifiedDistance(envelope, distanceKm) {
  if (!envelope || !Number.isFinite(distanceKm) || distanceKm < 0) {
    return envelope;
  }
  return Object.freeze({
    ...envelope,
    distanceKm,
  });
}

function attachForecastScope(envelope, scope) {
  if (!envelope || scope !== 'ADMIN_AREA_REPRESENTATIVE') {
    return envelope;
  }
  return Object.freeze({
    ...envelope,
    spatialLabel: '시·군 대표 예보 격자',
    qualityFlags: Object.freeze([
      ...new Set([
        ...(envelope.qualityFlags ?? []),
        'ADMIN_AREA_REPRESENTATIVE',
      ]),
    ]),
  });
}

function normalizeResolvedLocation(candidate) {
  const broad = candidate.resolutionMode === 'ADMIN_AREA_BROAD';
  const administrativeRepresentative =
    broad &&
    candidate.administrativeRepresentative?.purpose ===
      'REGIONAL_FORECAST_ONLY' &&
    Number.isFinite(candidate.administrativeRepresentative.latitude) &&
    Number.isFinite(candidate.administrativeRepresentative.longitude)
      ? Object.freeze({
          latitude: candidate.administrativeRepresentative.latitude,
          longitude: candidate.administrativeRepresentative.longitude,
          purpose: 'REGIONAL_FORECAST_ONLY',
        })
      : null;
  return Object.freeze({
    resolutionMode: broad ? 'ADMIN_AREA_BROAD' : 'ADDRESS_RESOLVED',
    provider: 'KAKAO',
    displayName: candidate.displayName,
    latitude: broad ? null : candidate.latitude,
    longitude: broad ? null : candidate.longitude,
    administrativeRepresentative,
    legalDongCode:
      candidate.legalDongCode10 ?? candidate.legalDongCode ?? null,
    adminAreaCode:
      candidate.adminAreaCode ??
      candidate.legalDongCode10 ??
      candidate.legalDongCode ??
      '',
    fieldParcelLookupKey:
      typeof candidate.fieldParcelLookupKey === 'string' &&
      /^\d{19}$/u.test(candidate.fieldParcelLookupKey)
        ? candidate.fieldParcelLookupKey
        : null,
  });
}

function moduleFromEnvelope(envelope, result, reason) {
  if (!envelopeHasUsableData(envelope)) {
    return unavailableModule(
      `${reason}:${envelope?.adapterState ?? 'UNAVAILABLE'}`,
      'UNAVAILABLE',
    );
  }
  const partialReasons = envelopePartialReasons(envelope);
  const partial = partialReasons.length > 0;
  return {
    state: partial ? 'PARTIAL' : 'READY',
    coverage: null,
    blockingReasons: partialReasons,
    missingInputs: [],
    qualityFlags: [...(envelope.qualityFlags ?? [])],
    result,
    evidence: [],
  };
}

function smartfarmContextSupported(request) {
  if (
    request.crop === 'CUCUMBER' &&
    ['FACILITY_SOIL', 'FACILITY_HYDRO'].includes(
      request.cultivationMode,
    )
  ) {
    return true;
  }
  return (
    ['APPLE', 'POTATO'].includes(request.crop) &&
    request.cultivationMode === 'OPEN_FIELD'
  );
}

function smartfarmModule(request, envelope) {
  if (!request.options.includeSmartfarmBenchmark) return null;
  if (!smartfarmContextSupported(request)) {
    return notApplicableModule();
  }
  const module = moduleFromEnvelope(
    envelope,
    envelope?.data ?? null,
    'SMARTFARM_REFERENCE_UNAVAILABLE',
  );
  return {
    ...module,
    decisionUse: 'REFERENCE_ONLY',
    affectsDecision: false,
    affectsScore: false,
  };
}

function decorateForecastDays(days, envelope) {
  return days.map((day) => ({
    ...day,
    freshness: envelope.freshness,
    deliveryState: envelope.deliveryState,
    qualityFlags: [...(envelope.qualityFlags ?? [])],
    units: {
      ...forecastUnits(),
      ...(day.units ?? {}),
    },
  }));
}

function forecastUnits() {
  return {
    minTemperature: '℃',
    maxTemperature: '℃',
    precipitationProbability: '%',
    precipitationAmount: 'mm',
    windSpeed: 'm/s',
    minRelativeHumidity: '%',
    maxRelativeHumidity: '%',
    meanRelativeHumidity: '%',
  };
}

function applyEnvelopeQuality(module, envelopeOrEnvelopes) {
  if (!module || Object.isFrozen(module)) return;
  const envelopes = Array.isArray(envelopeOrEnvelopes)
    ? envelopeOrEnvelopes
    : [envelopeOrEnvelopes];
  module.qualityFlags = [
    ...new Set([
      ...(module.qualityFlags ?? []),
      ...envelopes.flatMap((envelope) => envelope?.qualityFlags ?? []),
    ]),
  ];
  const qualityReasons = [
    ...new Set(envelopes.flatMap(envelopePartialReasons)),
  ];
  if (qualityReasons.length > 0) {
    if (module.state === 'READY') {
      module.state = 'PARTIAL';
    }
    module.blockingReasons = [
      ...new Set([...(module.blockingReasons ?? []), ...qualityReasons]),
    ];
  }
}

function envelopePartialReasons(envelope) {
  const reasons = [];
  if (
    envelope?.freshness !== 'CURRENT' ||
    envelope?.deliveryState === 'SAMPLE' ||
    envelope?.qualityFlags?.includes('STALE')
  ) {
    reasons.push('NON_CURRENT_SOURCE');
  }
  if (envelope?.qualityFlags?.includes('PARTIAL_PROVIDER_FAILURE')) {
    reasons.push('PARTIAL_PROVIDER_FAILURE');
  }
  return reasons;
}

function applyObservationEnvelopeQuality(module, envelope) {
  applyEnvelopeQuality(module, envelope);
  if (
    module.result &&
    envelopePartialReasons(envelope).length > 0
  ) {
    module.result.trendSummaryAvailable = false;
    module.qualityFlags = [
      ...new Set([
        ...(module.qualityFlags ?? []),
        'TREND_WITHHELD_NON_CURRENT_SOURCE',
      ]),
    ];
  }
}

function withEvidence(module, builder, rules, envelopes) {
  return {
    ...module,
    evidence: builder(module.result, rules, envelopes),
  };
}

function buildClimateEvidence(result, rules, envelope) {
  const byRule = new Map(rules.map((rule) => [rule.ruleId, rule]));
  const deviations = (result?.deviations ?? []).map((deviation) => {
    const rule = byRule.get(deviation.ruleId);
    return evidenceFromRule({
      evidenceId: `CLIMATE_${deviation.ruleId}`,
      module: 'CLIMATE',
      metric: deviation.metric,
      value: deviation.observedValue,
      unit: deviation.unit,
      reference: deviation.optimalRange,
      effect: deviation.physicalDeviation.direction,
      rawWeight: deviation.rawWeight,
      rule,
      envelope,
      calculation: {
        physicalDeviation: deviation.physicalDeviation,
        normalizedDeviation: deviation.normalizedDeviation,
        weightedContribution:
          deviation.rawWeight * deviation.normalizedDeviation,
      },
    });
  });
  const singleTargets = (result?.singleTargetDeviations ?? []).map(
    (deviation) => {
      const rule = byRule.get(deviation.ruleId);
      return evidenceFromRule({
        evidenceId: `CLIMATE_SINGLE_TARGET_${deviation.ruleId}`,
        module: 'CLIMATE',
        metric: rule?.metric ?? 'unknown',
        value: deviation.observedValue,
        unit: deviation.unit,
        reference: deviation.target,
        effect: 'ABSOLUTE_DEVIATION',
        rawWeight: null,
        rule,
        envelope,
        evidenceStatus: 'SINGLE_TARGET',
        calculation: {
          absoluteDeviation: deviation.absoluteDeviation,
        },
      });
    },
  );
  const excluded = (result?.excludedRules ?? []).map((item) => {
    const rule = byRule.get(item.ruleId);
    return evidenceFromRule({
      evidenceId: `CLIMATE_EXCLUDED_${item.ruleId}`,
      module: 'CLIMATE',
      metric: rule?.metric ?? 'unknown',
      value: null,
      unit: rule?.unit ?? null,
      reference: rule?.optimalRange ?? rule?.target ?? null,
      effect: 'NOT_USED',
      rawWeight:
        rule?.use === 'DEVIATION'
          ? RAW_WEIGHT_BY_TIER[rule?.sensitivityTier] ?? null
          : null,
      rule,
      envelope,
      inclusion: 'EXCLUDED',
      exclusionReason: item.reason,
    });
  });
  const derivedRule = (result?.deviations ?? [])
    .map(({ ruleId }) => byRule.get(ruleId))
    .find(Boolean);
  const coverage = Number.isFinite(result?.coverage)
    ? [
        evidenceFromRule({
          evidenceId: 'CLIMATE_COVERAGE',
          module: 'CLIMATE',
          metric: 'coverage',
          value: result.coverage,
          unit: 'ratio',
          reference: null,
          effect: 'DERIVED_COVERAGE',
          rawWeight: null,
          rule: derivedRule,
          envelope,
          calculation: {
            denominator: result.aggregation?.denominator ?? null,
            plannedDenominator:
              result.aggregation?.plannedDenominator ?? null,
          },
        }),
      ]
    : [];
  const aggregate =
    Number.isFinite(result?.aggregateDeviation) && result?.aggregation
      ? [
          evidenceFromRule({
            evidenceId: 'CLIMATE_AGGREGATE',
            module: 'CLIMATE',
            metric: 'aggregateDeviation',
            value: result.aggregateDeviation,
            unit: 'normalized_deviation',
            reference: null,
            effect: 'WEIGHTED_AGGREGATE',
            rawWeight: null,
            rule: derivedRule,
            envelope,
            calculation: {
              numerator: result.aggregation.numerator,
              denominator: result.aggregation.denominator,
              plannedDenominator: result.aggregation.plannedDenominator,
              coverage: result.coverage,
            },
          }),
        ]
      : [];
  return [
    ...deviations,
    ...singleTargets,
    ...excluded,
    ...coverage,
    ...aggregate,
  ];
}

function buildSoilEvidence(result, rules, envelope) {
  const byRule = new Map(rules.map((rule) => [rule.ruleId, rule]));
  const included = (result?.metrics ?? []).map((metric) => {
    const rule = byRule.get(metric.ruleId);
    return evidenceFromRule({
      evidenceId: `SOIL_${metric.ruleId}`,
      module: 'SOIL',
      metric: `${metric.metric}.fitRatio`,
      value: metric.fitRatio,
      unit: 'ratio',
      reference: null,
      effect: metric.summaryEligible ? 'SUMMARY_ELIGIBLE' : 'UNCERTAINTY_TOO_HIGH',
      rawWeight: metric.rawWeight,
      rule,
      envelope,
      calculation: {
        classifiedMetric: {
          metric: metric.metric,
          unit: rule?.unit ?? null,
          reviewedOptimalRange: rule?.optimalRange ?? null,
        },
        areas: {
          totalValid: metric.totalValidArea,
          fit: metric.fitRatio * metric.totalValidArea,
          uncertain: metric.uncertainRatio * metric.totalValidArea,
          outside: metric.outsideRatio * metric.totalValidArea,
          unit: metric.areaUnit,
        },
        ratios: {
          fit: metric.fitRatio,
          uncertain: metric.uncertainRatio,
          outside: metric.outsideRatio,
        },
      },
    });
  });
  const excluded = (result?.excludedRules ?? []).map((item) => {
    const rule = byRule.get(item.ruleId);
    return evidenceFromRule({
      evidenceId: `SOIL_EXCLUDED_${item.ruleId}`,
      module: 'SOIL',
      metric: rule?.metric ?? 'unknown',
      value: null,
      unit: rule?.unit ?? null,
      reference: rule?.optimalRange ?? null,
      effect: 'NOT_USED',
      rawWeight:
        rule?.use === 'DEVIATION'
          ? RAW_WEIGHT_BY_TIER[rule?.sensitivityTier] ?? null
          : null,
      rule,
      envelope,
      inclusion: 'EXCLUDED',
      exclusionReason: item.reason,
    });
  });
  const denominator = rules
    .filter(
      (rule) =>
        rule.module === 'SOIL' &&
        rule.use === 'DEVIATION',
    )
    .reduce(
      (sum, rule) =>
        sum + (RAW_WEIGHT_BY_TIER[rule.sensitivityTier] ?? 0),
      0,
    );
  const numerator = (result?.metrics ?? []).reduce(
    (sum, metric) => sum + metric.rawWeight,
    0,
  );
  const derivedRule = (result?.metrics ?? [])
    .map(({ ruleId }) => byRule.get(ruleId))
    .find(Boolean);
  const coverage = Number.isFinite(result?.coverage)
    ? [
        evidenceFromRule({
          evidenceId: 'SOIL_COVERAGE',
          module: 'SOIL',
          metric: 'coverage',
          value: result.coverage,
          unit: 'ratio',
          reference: null,
          effect: 'DERIVED_COVERAGE',
          rawWeight: null,
          rule: derivedRule,
          envelope,
          calculation: {
            numerator,
            denominator,
            coverage: result.coverage,
          },
        }),
      ]
    : [];
  return [...included, ...excluded, ...coverage];
}

function buildObservationEvidence(result, envelope) {
  const metrics = [
    ['minTemperature', '℃', true],
    ['maxTemperature', '℃', true],
    ['meanTemperature', '℃', true],
    ['precipitationAmount', 'mm', true],
    ['averageRelativeHumidity', '%', false],
    ['minimumRelativeHumidity', '%', false],
    ['sunshineDuration', 'hour', false],
    ['solarRadiation', 'MJ/m²', false],
    ['groundTemperature', '℃', false],
    ['soilTemperature5cm', '℃', false],
    ['meanWindSpeed', 'm/s', false],
    ['evaporationAmount', 'mm', false],
  ];
  return (result?.days ?? []).flatMap((day) => {
    const rawItems = metrics.flatMap(([metric, unit, required]) => {
      const included = Number.isFinite(day[metric]);
      if (!required && !included) {
        return [];
      }
      return [
        observationEvidenceItem({
          day,
          envelope,
          result,
          suffix: metric,
          metric,
          value: included ? day[metric] : null,
          unit,
          reference: null,
          effect: 'RAW_DAILY_OBSERVATION',
          inclusion: included ? 'INCLUDED' : 'EXCLUDED',
          exclusionReason: included ? null : 'MISSING_DAILY_VALUE',
        }),
      ];
    });
    const hasDeviation = Number.isFinite(day.monthlyNormalDeviation);
    const normalMeanTemperature = monthlyNormalValue(
      envelope,
      result.stationId,
      day.date,
    );
    return [
      ...rawItems,
      observationEvidenceItem({
        day,
        envelope,
        result,
        suffix: 'monthlyNormalDeviation',
        metric: 'monthlyNormalDeviation',
        value: hasDeviation ? day.monthlyNormalDeviation : null,
        unit: '℃',
        reference: 'MONTHLY_NORMAL_1991_2020',
        effect: 'MONTHLY_NORMAL_COMPARISON',
        calculation: {
          observedMeanTemperature: Number.isFinite(day.meanTemperature)
            ? day.meanTemperature
            : null,
          normalMeanTemperature,
          deviation: hasDeviation ? day.monthlyNormalDeviation : null,
          comparisonBasis: result.comparisonBasis,
        },
        inclusion: hasDeviation ? 'INCLUDED' : 'EXCLUDED',
        exclusionReason: hasDeviation
          ? null
          : 'SAME_STATION_MONTHLY_NORMAL_UNAVAILABLE',
      }),
    ];
  });
}

function monthlyNormalValue(envelope, stationId, date) {
  const month = Number(date.slice(5, 7));
  const matches = (envelope?.data?.monthlyNormals ?? []).filter(
    (normal) =>
      normal?.stationId === stationId &&
      normal.month === month &&
      Number.isFinite(normal.meanTemperature) &&
      (normal.normalPeriod === undefined ||
        normal.normalPeriod === '1991-2020'),
  );
  return matches.length === 1 ? matches[0].meanTemperature : null;
}

function observationEvidenceItem({
  day,
  envelope,
  result,
  suffix,
  metric,
  value,
  unit,
  reference,
  effect,
  calculation = null,
  inclusion,
  exclusionReason,
}) {
  return {
    evidenceId: `OBSERVATION_${result.stationId}_${day.date}_${suffix}`,
    module: 'OBSERVATION',
    metric,
    value,
    unit,
    reference,
    effect,
    calculation,
    rawWeight: null,
    inclusion,
    exclusionReason,
    evidenceStatus: 'RISK_ONLY',
    spatialLevel: envelope?.spatialLevel ?? null,
    distanceKm: result.distanceKm,
    observedAt: envelope?.observedAt ?? null,
    issuedAt: null,
    sourceName: envelope?.sourceName ?? 'Unknown',
    sourceUrl: envelope?.sourceUrl ?? null,
    sourceVersion:
      envelope?.provenance?.contractVersion ?? 'UNVERIFIED',
    deliveryState: envelope?.deliveryState ?? 'UNAVAILABLE',
    freshness: envelope?.freshness ?? 'NOT_APPLICABLE',
    qualityFlags: [...(envelope?.qualityFlags ?? [])],
  };
}

function buildForecastEvidence(result, rules, envelopes) {
  const byRule = new Map(rules.map((rule) => [rule.ruleId, rule]));
  const byType = {
    SHORT_GRID: envelopes[0],
    MID_REGIONAL: envelopes[1],
  };
  const risks = (result?.risks ?? []).map((risk) => {
    const rule = byRule.get(risk.ruleId);
    const sourceDays =
      risk.sourceType === 'SHORT_GRID'
        ? result?.shortDays ?? []
        : result?.midDays ?? [];
    const readings = forecastReadings(
      sourceDays.filter(
        (day) =>
          day.date >= risk.dateRange.from &&
          day.date <= risk.dateRange.to,
      ),
      rule,
    );
    return evidenceFromRule({
      evidenceId: risk.riskId,
      module: 'FORECAST',
      metric: rule?.metric ?? 'forecastRisk',
      value: evidenceReadingValue(readings),
      unit: rule?.unit ?? null,
      reference: renderForecastComparison(rule?.comparison),
      effect: risk.severity,
      rawWeight: null,
      rule,
      envelope: byType[risk.sourceType],
      evidenceStatus: 'RISK_ONLY',
      sourceType: risk.sourceType,
      calculation: {
        readings,
        comparison: rule?.comparison ?? null,
        duration: rule?.duration ?? null,
        domainEvidenceIds: [...(risk.evidenceIds ?? [])],
      },
    });
  });
  const evaluations = (result?.ruleEvaluations ?? []).flatMap((evaluation) => {
    const rule = byRule.get(evaluation.ruleId);
    return [
      ['SHORT_GRID', result?.shortDays ?? [], envelopes[0]],
      ['MID_REGIONAL', result?.midDays ?? [], envelopes[1]],
    ].map(([sourceType, days, envelope]) => {
      const readings = forecastReadings(days, rule);
      const included = readings.length > 0;
      return evidenceFromRule({
        evidenceId: `FORECAST_EVALUATION_${evaluation.ruleId}_${sourceType}`,
        module: 'FORECAST',
        metric: rule?.metric ?? 'forecastRisk',
        value: evidenceReadingValue(readings),
        unit: rule?.unit ?? null,
        reference: renderForecastComparison(rule?.comparison),
        effect: forecastEvaluationEffect(
          evaluation.status,
          readings,
          rule?.comparison,
        ),
        rawWeight: null,
        rule,
        envelope,
        evidenceStatus: 'RISK_ONLY',
        inclusion: included ? 'INCLUDED' : 'EXCLUDED',
        exclusionReason: included ? null : 'NO_SOURCE_READINGS',
        sourceType,
        calculation: {
          readings,
          comparison: rule?.comparison ?? null,
          duration: rule?.duration ?? null,
          evaluationStatus: evaluation.status,
          evaluatedDayCount: evaluation.evaluatedDayCount,
          missingDayCount: evaluation.missingDayCount,
        },
      });
    });
  });
  return [...risks, ...evaluations];
}

function forecastReadings(days, rule) {
  if (!rule) return [];
  return days
    .filter((day) => Number.isFinite(day?.[rule.metric]))
    .map((day) => ({
      date: day.date,
      value: day[rule.metric],
      sourceType: day.sourceType,
    }));
}

function evidenceReadingValue(readings) {
  if (readings.length === 0) return null;
  if (readings.length === 1) return readings[0].value;
  return readings
    .map(({ date, value, sourceType }) => `${date}:${value}:${sourceType}`)
    .join('|');
}

function renderForecastComparison(comparison) {
  if (!comparison) return null;
  if (comparison.operator === 'BETWEEN') {
    return `BETWEEN ${comparison.lower} AND ${comparison.upper}`;
  }
  return `${comparison.operator} ${comparison.threshold}`;
}

function forecastEvaluationEffect(status, readings, comparison) {
  if (
    comparison &&
    readings.some(({ value }) => comparisonMatches(value, comparison))
  ) {
    return 'ACTIVE_RISK_INPUT';
  }
  if (status === 'EVALUATED_NO_RISK') return 'NO_ACTIVE_RISK';
  if (status.startsWith('TRIGGERED')) return 'BELOW_TRIGGER_IN_THIS_SOURCE';
  return 'NOT_EVALUATED_COMPLETELY';
}

function comparisonMatches(value, comparison) {
  if (comparison.operator === 'GT') return value > comparison.threshold;
  if (comparison.operator === 'GTE') return value >= comparison.threshold;
  if (comparison.operator === 'LT') return value < comparison.threshold;
  if (comparison.operator === 'LTE') return value <= comparison.threshold;
  return value >= comparison.lower && value <= comparison.upper;
}

function evidenceFromRule({
  evidenceId,
  module,
  metric,
  value,
  unit,
  reference,
  effect,
  rawWeight,
  rule,
  envelope,
  evidenceStatus,
  inclusion = 'INCLUDED',
  exclusionReason = null,
  calculation = null,
  sourceType = null,
}) {
  return {
    evidenceId,
    ruleId: rule?.ruleId ?? null,
    module,
    metric,
    value,
    unit,
    reference,
    effect,
    rawWeight,
    inclusion,
    exclusionReason,
    calculation,
    sourceType,
    evidenceStatus: evidenceStatus ?? rule?.evidenceStatus ?? 'UNCONFIRMED',
    spatialLevel: envelope?.spatialLevel ?? null,
    distanceKm: envelope?.distanceKm ?? null,
    observedAt: envelope?.observedAt ?? null,
    issuedAt: envelope?.issuedAt ?? null,
    sourceName: rule?.sourceTitle ?? envelope?.sourceName ?? 'Unknown',
    sourceUrl: rule?.sourceUrl ?? envelope?.sourceUrl ?? null,
    sourceVersion:
      rule?.sourceVersion ??
      envelope?.provenance?.contractVersion ??
      'UNVERIFIED',
    deliveryState: envelope?.deliveryState ?? 'UNAVAILABLE',
    freshness: envelope?.freshness ?? 'NOT_APPLICABLE',
    qualityFlags: [...(envelope?.qualityFlags ?? [])],
  };
}

function createActionCandidates({ request, decision, modules }) {
  const candidates = [];
  const common = {
    usageModes: ['LAND_SEARCH', 'ACTIVE_GROWING'],
    cultivationModes: ['OPEN_FIELD', 'FACILITY_SOIL', 'FACILITY_HYDRO'],
  };
  const decisionAction = decisionActionFor(decision.code, {
    triggerIds: decision.triggerIds,
    modules,
  });
  candidates.push({
    ...common,
    ...decisionAction,
    titleTemplateId: `ACTION.${decisionAction.actionId}`,
    triggerIds: [...decision.triggerIds],
    ruleOrder: 10,
  });

  if (request.season.kind === 'UNKNOWN') {
    candidates.push({
      ...common,
      actionId: 'CONFIRM_SEASON',
      titleTemplateId: 'ACTION.CONFIRM_SEASON',
      triggerIds: ['input:season:unknown'],
      blocking: true,
      severity: 'CAUTION',
      dueWindow: 'BEFORE_DECISION',
      evidenceStrength: 'UNCONFIRMED',
      sourceFreshness: 'NOT_APPLICABLE',
      ruleOrder: 1,
    });
  }

  for (const risk of modules.forecast?.result?.risks ?? []) {
    const evidenceQuality = actionEvidenceQuality({
      triggerIds: [risk.riskId],
      modules,
    });
    candidates.push({
      ...common,
      actionId:
        request.cultivationMode === 'OPEN_FIELD'
          ? 'CHECK_CURRENT_FORECAST_RISK'
          : 'CHECK_FACILITY_WEATHER',
      titleTemplateId:
        request.cultivationMode === 'OPEN_FIELD'
          ? 'ACTION.CHECK_CURRENT_FORECAST_RISK'
          : 'ACTION.CHECK_FACILITY_WEATHER',
      triggerIds: [risk.riskId],
      blocking: false,
      severity: risk.severity,
      dueWindow:
        risk.sourceType === 'SHORT_GRID' ? '1_TO_3_DAYS' : '4_TO_10_DAYS',
      evidenceStrength: evidenceQuality.evidenceStrength,
      sourceFreshness: evidenceQuality.sourceFreshness,
      ruleOrder: 20,
    });
  }
  return candidates;
}

function decisionActionFor(code, evidenceContext) {
  let action;
  if (code === 'DATA_NEEDED') {
    action = {
      actionId: 'COLLECT_REQUIRED_DATA',
      blocking: true,
      severity: 'CAUTION',
      dueWindow: 'BEFORE_DECISION',
      evidenceStrength: 'UNCONFIRMED',
      sourceFreshness: 'NOT_APPLICABLE',
    };
  } else if (code === 'FACILITY_DATA_NEEDED') {
    action = {
      actionId: 'CHECK_INTERNAL_SENSORS',
      blocking: false,
      severity: 'CAUTION',
      dueWindow: 'NOW',
      evidenceStrength: 'UNCONFIRMED',
      sourceFreshness: 'NOT_APPLICABLE',
    };
  } else if (code === 'CHECK_FIRST') {
    action = {
      actionId: 'REVIEW_CONDITION_EVIDENCE',
      blocking: true,
      severity: 'CAUTION',
      dueWindow: 'BEFORE_DECISION',
      evidenceStrength: 'CONFIRMED_RANGE',
      sourceFreshness: 'CURRENT',
    };
  } else if (code === 'FIELD_TEST_NEXT') {
    action = {
      actionId: 'REQUEST_FIELD_SOIL_TEST',
      blocking: false,
      severity: 'INFO',
      dueWindow: 'BEFORE_DECISION',
      evidenceStrength: 'CONFIRMED_RANGE',
      sourceFreshness: 'CURRENT',
    };
  } else if (code === 'FACILITY_CHECK_FIRST') {
    action = {
      actionId: 'CHECK_FACILITY_WEATHER',
      blocking: false,
      severity: 'WARNING',
      dueWindow: 'NOW',
      evidenceStrength: 'RISK_ONLY',
      sourceFreshness: 'CURRENT',
    };
  } else if (code === 'FACILITY_SENSOR_NEXT') {
    action = {
      actionId: 'CHECK_INTERNAL_SENSORS',
      blocking: false,
      severity: 'INFO',
      dueWindow: 'NOW',
      evidenceStrength: 'RISK_ONLY',
      sourceFreshness: 'CURRENT',
    };
  } else {
    action = {
      actionId: 'COLLECT_REQUIRED_DATA',
      blocking: true,
      severity: 'CAUTION',
      dueWindow: 'NOW',
      evidenceStrength: 'UNCONFIRMED',
      sourceFreshness: 'NOT_APPLICABLE',
    };
  }
  return {
    ...action,
    ...actionEvidenceQuality(evidenceContext),
  };
}

function actionEvidenceQuality({ triggerIds = [], modules = {} } = {}) {
  const {
    evidence: matched,
    unresolvedTriggerIds,
  } = resolveEligibleEvidence(modules, triggerIds);
  if (
    unresolvedTriggerIds.length > 0 ||
    matched.length === 0
  ) {
    return {
      evidenceStrength: 'UNCONFIRMED',
      sourceFreshness: 'NOT_APPLICABLE',
    };
  }
  const evidenceStrength = weakestEvidenceStrength(
    matched.map((item) => item.evidenceStatus),
  );
  const freshness = matched.map((item) => item.freshness);
  const sourceFreshness = freshness.includes('SAMPLE')
    ? 'SAMPLE'
    : freshness.includes('STALE')
      ? 'STALE'
      : freshness.every((value) => value === 'CURRENT')
        ? 'CURRENT'
        : 'NOT_APPLICABLE';
  return { evidenceStrength, sourceFreshness };
}

function weakestEvidenceStrength(values) {
  const priority = {
    UNCONFIRMED: 0,
    SINGLE_TARGET: 1,
    RISK_ONLY: 2,
    CONFIRMED_RANGE: 3,
  };
  return values
    .filter((value) => Object.hasOwn(priority, value))
    .sort(
      (left, right) =>
        priority[left] - priority[right] || left.localeCompare(right),
    )[0] ?? 'UNCONFIRMED';
}

function collectLimitations({ request, decision, modules, envelopes }) {
  const values = [
    ...decision.limitations,
    ...Object.values(modules).flatMap((module) => module?.blockingReasons ?? []),
    ...Object.entries(envelopes).flatMap(([key, envelope]) =>
      key === 'smartfarm' || envelope.adapterState === 'SUCCESS'
        ? []
        : [`${envelope.sourceId}:${envelope.adapterState}`],
    ),
  ];
  if (request.cultivationMode !== 'OPEN_FIELD') {
    values.push('OUTDOOR_DATA_IS_NOT_INTERNAL_FACILITY_MEASUREMENT');
  }
  return [...new Set(values)];
}

function combineRuleVersions(moduleRules) {
  const versions = [
    ...new Set(
      Object.values(moduleRules)
        .flat()
        .map((rule) => rule.ruleVersion)
        .filter(Boolean),
    ),
  ].sort();
  return versions.length ? versions.join('+') : 'NO_ACTIVE_VERIFIED_RULES';
}

function generalizeRegionLabel(displayName) {
  const parts = String(displayName ?? '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (parts.length <= 2) return parts.join(' ');
  return parts.slice(0, 2).join(' ');
}

function adapterCapability(adapter, declaredState, requiredMethod) {
  if (!adapter) return 'UNSUPPORTED';
  if (typeof adapter[requiredMethod] !== 'function') {
    return 'INVALID_CONTRACT';
  }
  if (typeof declaredState !== 'string' || declaredState.trim() === '') {
    return 'UNVERIFIED';
  }
  return declaredState.trim().toUpperCase();
}

function isReadyCapability(state) {
  return state === 'READY';
}

async function verifySharedStateCapability({ configuredState, probe }) {
  const configured = ![
    'NOT_AVAILABLE',
    'DISABLED',
    'UNSUPPORTED',
  ].includes(configuredState);
  if (typeof probe !== 'function') {
    return {
      ready: false,
      state: configured ? 'CONFIGURED_UNVERIFIED' : 'NOT_CONFIGURED',
      capability: configured ? 'CONFIGURED_UNVERIFIED' : 'NOT_AVAILABLE',
      verifiedAt: null,
    };
  }
  try {
    const result = await probe();
    if (result?.ready === true && result.state === 'READY') {
      return {
        ready: true,
        state: 'READY',
        capability: 'READY',
        verifiedAt:
          typeof result.verifiedAt === 'string' ? result.verifiedAt : null,
      };
    }
    return {
      ready: false,
      state:
        typeof result?.state === 'string'
          ? result.state
          : 'PROBE_FAILED',
      capability: 'CONFIGURED_UNVERIFIED',
      verifiedAt: null,
    };
  } catch {
    return {
      ready: false,
      state: 'UNAVAILABLE',
      capability: 'CONFIGURED_UNVERIFIED',
      verifiedAt: null,
    };
  }
}

function isDecisionCapableRule(rule) {
  return decisionModuleForRule(rule) !== null;
}

function decisionModuleForRule(rule) {
  if (
    rule?.module === 'CLIMATE' &&
    ((rule.use === 'DEVIATION' &&
      rule.evidenceStatus === 'CONFIRMED_RANGE') ||
      (rule.use === 'SINGLE_TARGET' &&
        rule.evidenceStatus === 'SINGLE_TARGET'))
  ) {
    return 'CLIMATE';
  }
  if (
    rule?.module === 'SOIL' &&
    rule.use === 'DEVIATION' &&
    rule.evidenceStatus === 'CONFIRMED_RANGE'
  ) {
    return 'SOIL';
  }
  if (
    rule?.module === 'FORECAST' &&
    rule.use === 'FORECAST_RISK' &&
    rule.evidenceStatus === 'RISK_ONLY'
  ) {
    return 'FORECAST';
  }
  return null;
}

function buildRuleContextCoverage(ruleRegistry) {
  return Crop.flatMap((crop) =>
    ALLOWED_CULTIVATION_MODES[crop].flatMap((cultivationMode) =>
      readinessSeasonCandidates(ruleRegistry, crop, cultivationMode).map(
        (seasonCandidate) =>
          evaluateRuleContext({
            ruleRegistry,
            crop,
            cultivationMode,
            seasonCandidate,
          }),
      ),
    ),
  );
}

function readinessSeasonCandidates(ruleRegistry, crop, cultivationMode) {
  const fullSupportModules = requiredDecisionModules(cultivationMode);
  if (crop === 'APPLE' || crop === 'PEAR') {
    return [
      {
        seasonInputs: [{ season: undefined, month: null }],
        fallbackKind: 'DEFAULT_REVIEWED_ANNUAL',
        fallbackProfileId: null,
        expectedSupportModules: fullSupportModules,
        expectedHoldModules: [],
        expectedPartial: false,
        summarizeMonthCoverage: false,
        reviewedAnnualProfileCount: ruleRegistry
          .seasonProfilesFor(crop, cultivationMode)
          .filter(
            (profileId) =>
              !['CUSTOM', 'UNKNOWN', 'NOT_APPLICABLE'].includes(profileId),
          ).length,
      },
    ];
  }

  if (cultivationMode === 'OPEN_FIELD') {
    const reviewedProfiles = ruleRegistry
      .seasonProfilesFor(crop, cultivationMode)
      .filter(
        (profileId) =>
          !['CUSTOM', 'UNKNOWN', 'NOT_APPLICABLE'].includes(profileId),
      );
    return [
      {
        seasonInputs: singleMonthSeasonInputs('CUSTOM'),
        fallbackKind: 'CUSTOM',
        fallbackProfileId: 'CUSTOM',
        expectedSupportModules: fullSupportModules,
        expectedHoldModules: [],
        expectedPartial: false,
        summarizeMonthCoverage: true,
        reviewedAnnualProfileCount: null,
      },
      ...(reviewedProfiles.length === 0
        ? []
        : [
            {
              seasonInputs: reviewedProfiles.map((profileId) => ({
                season: readinessSeason('VERIFIED_PROFILE', profileId),
                month: null,
              })),
              fallbackKind: 'VERIFIED_PROFILE',
              fallbackProfileId:
                reviewedProfiles.length === 1
                  ? reviewedProfiles[0]
                  : 'MULTIPLE_REVIEWED_PROFILES',
              expectedSupportModules: fullSupportModules,
              expectedHoldModules: [],
              expectedPartial: false,
              summarizeMonthCoverage: false,
              summarizeReviewedProfiles: true,
              reviewedProfileCount: reviewedProfiles.length,
              reviewedAnnualProfileCount: null,
            },
          ]),
      {
        seasonInputs: [
          {
            season: readinessSeason('UNKNOWN', 'UNKNOWN'),
            month: null,
          },
        ],
        fallbackKind: 'UNKNOWN',
        fallbackProfileId: 'UNKNOWN',
        expectedSupportModules: ['SOIL', 'FORECAST'],
        expectedHoldModules: ['CLIMATE'],
        expectedPartial: true,
        summarizeMonthCoverage: false,
        summarizeReviewedProfiles: false,
        reviewedProfileCount: 0,
        reviewedAnnualProfileCount: null,
      },
    ];
  }

  return [
    {
      seasonInputs: [{ season: undefined, month: null }],
      fallbackKind: 'NOT_APPLICABLE',
      fallbackProfileId: 'NOT_APPLICABLE',
      expectedSupportModules: fullSupportModules,
      expectedHoldModules: [],
      expectedPartial: false,
      summarizeMonthCoverage: false,
      summarizeReviewedProfiles: false,
      reviewedProfileCount: 0,
      reviewedAnnualProfileCount: null,
    },
    {
      seasonInputs: singleMonthSeasonInputs('CUSTOM'),
      fallbackKind: 'CUSTOM',
      fallbackProfileId: 'CUSTOM',
      expectedSupportModules: fullSupportModules,
      expectedHoldModules: [],
      expectedPartial: false,
      summarizeMonthCoverage: true,
      summarizeReviewedProfiles: false,
      reviewedProfileCount: 0,
      reviewedAnnualProfileCount: null,
    },
    {
      seasonInputs: [
        {
          season: readinessSeason('UNKNOWN', 'UNKNOWN'),
          month: null,
        },
      ],
      fallbackKind: 'UNKNOWN',
      fallbackProfileId: 'UNKNOWN',
      expectedSupportModules: fullSupportModules,
      expectedHoldModules: [],
      expectedPartial: false,
      summarizeMonthCoverage: false,
      summarizeReviewedProfiles: false,
      reviewedProfileCount: 0,
      reviewedAnnualProfileCount: null,
    },
  ];
}

function singleMonthSeasonInputs(profileId) {
  return Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    return {
      season: {
        kind: 'CUSTOM',
        profileId,
        startMonth: month,
        endMonth: month,
        userConfirmed: true,
      },
      month,
    };
  });
}

function readinessSeason(kind, profileId) {
  return {
    kind,
    profileId,
    startMonth: null,
    endMonth: null,
    userConfirmed: true,
  };
}

function evaluateRuleContext({
  ruleRegistry,
  crop,
  cultivationMode,
  seasonCandidate,
}) {
  const allCheckedModules = ['CLIMATE', 'SOIL', 'FORECAST'].filter(
    (module) =>
      seasonCandidate.expectedSupportModules.includes(module) ||
      seasonCandidate.expectedHoldModules.includes(module),
  );
  const samples = seasonCandidate.seasonInputs.map(({ season, month }) =>
    evaluateRuleContextSample({
      ruleRegistry,
      crop,
      cultivationMode,
      season,
      month,
      checkedModules: allCheckedModules,
    }),
  );
  const validSamples = samples.filter(({ request }) => request !== null);
  const firstValidRequest = validSamples[0]?.request;
  const requestErrorCodes = [
    ...new Set(
      samples
        .map(({ requestErrorCode }) => requestErrorCode)
        .filter(Boolean),
    ),
  ];
  const seasonKind =
    firstValidRequest?.season?.kind ?? seasonCandidate.fallbackKind;
  const seasonProfileId =
    seasonCandidate.summarizeReviewedProfiles
      ? seasonCandidate.fallbackProfileId
      : firstValidRequest?.season?.profileId ??
        seasonCandidate.fallbackProfileId;
  const modules = Object.fromEntries(
    allCheckedModules.map((module) => {
      const counts = samples.map(
        ({ moduleCounts }) => moduleCounts[module] ?? 0,
      );
      const minimumDecisionRuleCount =
        counts.length === 0 ? 0 : Math.min(...counts);
      return [
        module,
        {
          decisionRuleCount: minimumDecisionRuleCount,
          status:
            minimumDecisionRuleCount > 0 ? 'CONFIGURED' : 'HOLD',
        },
      ];
    }),
  );
  const requiredModules = [...seasonCandidate.expectedSupportModules];
  const missingModules = requiredModules.filter(
    (module) => modules[module].status !== 'CONFIGURED',
  );
  const unexpectedActiveModules = seasonCandidate.expectedHoldModules.filter(
    (module) =>
      samples.some(({ moduleCounts }) => (moduleCounts[module] ?? 0) > 0),
  );
  const requiredMonths = seasonCandidate.summarizeMonthCoverage
    ? Array.from({ length: 12 }, (_, index) => index + 1)
    : [];
  const coveredMonths = seasonCandidate.summarizeMonthCoverage
    ? samples
        .filter(
          ({ moduleCounts, month, request }) =>
            request !== null &&
            month !== null &&
            requiredModules.every(
              (module) => (moduleCounts[module] ?? 0) > 0,
            ) &&
            seasonCandidate.expectedHoldModules.every(
              (module) => (moduleCounts[module] ?? 0) === 0,
            ),
        )
        .map(({ month }) => month)
    : [];
  const missingMonths = requiredMonths.filter(
    (month) => !coveredMonths.includes(month),
  );
  const missingReasons = [];
  if (
    seasonCandidate.reviewedAnnualProfileCount !== null &&
    seasonCandidate.reviewedAnnualProfileCount !== 1
  ) {
    missingReasons.push(
      `REVIEWED_ANNUAL_PROFILE_COUNT_NOT_ONE:${seasonCandidate.reviewedAnnualProfileCount}`,
    );
  }
  missingReasons.push(
    ...requestErrorCodes.map(
      (code) => `REQUEST_CONTEXT_INVALID:${code}`,
    ),
    ...missingModules.map(
      (module) => `NO_ACTIVE_DECISION_RULE:${module}`,
    ),
    ...unexpectedActiveModules.map(
      (module) => `UNEXPECTED_ACTIVE_DECISION_RULE:${module}`,
    ),
  );
  if (missingMonths.length > 0) {
    missingReasons.push('CUSTOM_MONTH_COVERAGE_INCOMPLETE');
  }
  const contractSatisfied =
    requestErrorCodes.length === 0 &&
    missingModules.length === 0 &&
    unexpectedActiveModules.length === 0 &&
    missingMonths.length === 0;
  const status = contractSatisfied
    ? seasonCandidate.expectedPartial
      ? 'EXPECTED_PARTIAL'
      : 'CONFIGURED'
    : 'HOLD';
  return {
    contextId: [
      crop,
      cultivationMode,
      seasonKind,
      seasonProfileId ?? 'NONE',
      'UNSPECIFIED',
    ].join('|'),
    crop,
    cultivationMode,
    seasonKind,
    seasonProfileId,
    reviewedProfileCount: seasonCandidate.reviewedProfileCount ?? 0,
    growthStage: 'UNSPECIFIED',
    requiredModules,
    expectedHoldModules: [...seasonCandidate.expectedHoldModules],
    modules,
    missingModules,
    unexpectedActiveModules,
    monthCoverage: seasonCandidate.summarizeMonthCoverage
      ? {
          requiredMonths,
          coveredMonths,
          missingMonths,
        }
      : null,
    missingMonths,
    seasonKinds: [seasonKind],
    missingSeasonKinds: contractSatisfied ? [] : [seasonKind],
    missingReasons,
    requestValidation:
      requestErrorCodes.length === 0 ? 'VALID' : 'INVALID',
    requestErrorCode: requestErrorCodes[0] ?? null,
    status,
  };
}

function evaluateRuleContextSample({
  ruleRegistry,
  crop,
  cultivationMode,
  season,
  month,
  checkedModules,
}) {
  try {
    const request = validateAndNormalizeRequest(
      {
        usageMode: 'LAND_SEARCH',
        location: {
          candidateToken: 'preflight-context',
          userConfirmed: true,
        },
        crop,
        cultivationMode,
        ...(season === undefined ? {} : { season }),
        growthStage: 'UNSPECIFIED',
      },
      { ruleRegistry },
    );
    return {
      request,
      requestErrorCode: null,
      month,
      moduleCounts: Object.fromEntries(
        checkedModules.map((module) => [
          module,
          ruleRegistry
            .resolve(request, module)
            .filter(isDecisionCapableRule).length,
        ]),
      ),
    };
  } catch (error) {
    return {
      request: null,
      requestErrorCode:
        typeof error?.code === 'string' ? error.code : 'INVALID_CONTEXT',
      month,
      moduleCounts: Object.fromEntries(
        checkedModules.map((module) => [module, 0]),
      ),
    };
  }
}

function requiredDecisionModules(cultivationMode) {
  const applicability =
    MODULE_APPLICABILITY[cultivationMode] ??
    MODULE_APPLICABILITY.OPEN_FIELD;
  const requiredModules = [];
  if (applicability.climate !== 'NOT_APPLICABLE') {
    requiredModules.push('CLIMATE');
  }
  if (applicability.soil !== 'NOT_APPLICABLE') {
    requiredModules.push('SOIL');
  }
  if (
    applicability.shortForecast !== 'NOT_APPLICABLE' ||
    applicability.midForecast !== 'NOT_APPLICABLE'
  ) {
    requiredModules.push('FORECAST');
  }
  return requiredModules;
}

function buildCropRuleCoverage(contextCoverage) {
  return Crop.map((crop) => {
    const requiredCultivationModes = [...ALLOWED_CULTIVATION_MODES[crop]];
    const cropContexts = contextCoverage.filter(
      (context) => context.crop === crop,
    );
    const configuredCultivationModes = requiredCultivationModes.filter(
      (cultivationMode) => {
        const modeContexts = cropContexts.filter(
          (context) => context.cultivationMode === cultivationMode,
        );
        return (
          modeContexts.length > 0 &&
          modeContexts.every((context) =>
            ['CONFIGURED', 'EXPECTED_PARTIAL'].includes(context.status),
          )
        );
      },
    );
    const missingCultivationModes = requiredCultivationModes.filter(
      (cultivationMode) =>
        !configuredCultivationModes.includes(cultivationMode),
    );
    return {
      crop,
      requiredCultivationModes,
      configuredCultivationModes,
      missingCultivationModes,
      status:
        missingCultivationModes.length === 0 ? 'CONFIGURED' : 'HOLD',
    };
  });
}

function createLifecycleTracker(clock) {
  const lifecycle = {
    currentState: null,
    transitions: [],
  };
  return {
    transition(state) {
      appendLifecycleTransition({ lifecycle }, state, clock);
    },
    snapshot() {
      return structuredClone(lifecycle);
    },
  };
}

function appendLifecycleTransition(result, state, clock) {
  if (!ANALYSIS_LIFECYCLE_ORDER.includes(state)) {
    throw new TypeError(`unsupported analysis lifecycle state: ${state}`);
  }
  const lifecycle = result.lifecycle;
  if (
    !lifecycle ||
    !Array.isArray(lifecycle.transitions)
  ) {
    throw new TypeError('analysis lifecycle is not initialized');
  }
  const previousIndex = lifecycle.currentState
    ? ANALYSIS_LIFECYCLE_ORDER.indexOf(lifecycle.currentState)
    : -1;
  const nextIndex = ANALYSIS_LIFECYCLE_ORDER.indexOf(state);
  if (nextIndex !== previousIndex + 1) {
    throw new TypeError(
      `invalid analysis lifecycle transition: ${lifecycle.currentState ?? 'NONE'} -> ${state}`,
    );
  }
  const at = new Date(clock()).toISOString();
  lifecycle.currentState = state;
  lifecycle.transitions.push({ state, at });
}

function sanitizeRuntimeContracts(contracts) {
  if (!contracts || typeof contracts !== 'object' || Array.isArray(contracts)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(contracts)
      .filter(
        ([key, value]) =>
          /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key) &&
          (typeof value === 'string' ||
            typeof value === 'boolean' ||
            value === null),
      )
      .map(([key, value]) => [key, value]),
  );
}

function validateDependencies({
  ruleRegistry,
  clock,
  randomBytes,
  candidateStore,
  analysisStore,
}) {
  if (
    !ruleRegistry ||
    typeof ruleRegistry.resolve !== 'function' ||
    typeof ruleRegistry.seasonProfilesFor !== 'function' ||
    !Array.isArray(ruleRegistry.rules)
  ) {
    throw new TypeError(
      'ruleRegistry must be a validated registry with context introspection',
    );
  }
  if (typeof clock !== 'function' || typeof randomBytes !== 'function') {
    throw new TypeError('clock and randomBytes must be functions');
  }
  for (const [name, store] of [
    ['candidateStore', candidateStore],
    ['analysisStore', analysisStore],
  ]) {
    if (
      !store ||
      typeof store.get !== 'function' ||
      typeof store.set !== 'function' ||
      typeof store.delete !== 'function'
    ) {
      throw new TypeError(`${name} must support get, set, and delete`);
    }
  }
}

function assertPositiveDuration(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite duration`);
  }
}

function serviceError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.expose = true;
  error.retryable = false;
  return error;
}

export const applicationDefaults = Object.freeze({
  candidateTtlMs: CANDIDATE_TTL_MS,
  analysisTtlMs: ANALYSIS_TTL_MS,
  reportLockTtlMs: REPORT_LOCK_TTL_MS,
  storeCapacityPolicy: STORE_CAPACITY_POLICY,
});
