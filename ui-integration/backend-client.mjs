import {
  ContractValidationError,
  buildAnalysisRequest,
  buildAnalysisRequests,
  buildCropCycleRequests,
  createIdempotencyKey,
  requestFingerprint,
} from "./api-contract.mjs";
import { summarizeForecastEvaluation } from "./forecast-presentation.mjs";
import { hasMissingSoilExamHistory } from "./soil-service-guidance.mjs";
import { suggestAdministrativeAddresses } from "./address-suggestions.mjs";
import {
  composeForecastActionReason,
  filterWeeklyRisksForOpenAction,
  formatActionDueLabelForAction,
  groupWeeklyRiskRanges,
  mountActionPlan,
} from "./action-plan.mjs";
import {
  LOCAL_PHOTO_MAX_BYTES,
  analyzePhotoPixels,
  assessPhotoQuality,
  createLocalPhotoJournal,
  reviewPhotoComparison,
} from "./local-photo-journal.mjs";
import { parseAssistantActionRequest } from "./assistant-action-request.mjs";
import { buildAssistantCycleAnswer } from "./assistant-cycle-answer.mjs";
import {
  buildReviewedPestObservationFallback,
  selectPestRecoveryAnalysis,
} from "./pest-observation-guide.mjs";
import {
  sanitizeFarmForDeviceBackup,
  sanitizeFarmsFromDeviceBackup,
} from "./device-backup-payload.mjs";
import {
  canReconcileProjectedActions,
  projectAnalysisAction,
} from "./action-projection.mjs";
import { mergeTodayActionPlans } from "./farm-overview.mjs";
import {
  createCropCycleAdapter,
  createDefaultCropCycleInput,
  cropCycleAnchorOptions,
  normalizeCropCycleInput,
  projectLocalCropCycle,
} from "./crop-cycle.mjs";
import { buildHarvestForecast } from "./harvest-forecast.mjs";

window.__BACKEND_INTEGRATION_ENABLED__ = true;

// ── 사용자 토양검정 결과 (이 기기에만 저장) ──────────────────────────
const SOIL_TEST_STORAGE_KEY = "heuknalssi.soilTest.v1";
const SOIL_TESTS_STORAGE_KEY = "heuknalssi.soilTests.v2";
const REGION_STORAGE_KEY = "heuknalssi.region.v1";
const ACCOUNT_KEY_STORAGE_KEY = "heuknalssi.accountKey.v1";
const SESSION_STORAGE_KEY = "heuknalssi.session.v1";
const FARMS_STORAGE_KEY = "heuknalssi.farms.v1";
const ACTIVE_FARM_STORAGE_KEY = "heuknalssi.activeFarm.v1";
const ANALYSIS_SNAPSHOT_STORAGE_KEY = "heuknalssi.analysisSnapshots.v1";
const HARVEST_ASSESSMENTS_STORAGE_KEY = "heuknalssi.harvestAssessments.v1";
const HARVEST_ASSESSMENTS_MAX_BYTES = 64 * 1024;
const ALARM_STORAGE_KEY = "heuknalssi.alarm.v1";
// 알림 모듈 상태는 초기화 중에 접근되므로 반드시 사용처보다 위에 둔다.
let serviceWorkerReady = null;
let alarmTimer = null;
const TODO_STORAGE_KEY = "heuknalssi.todo.v1";
const TODOS_STORAGE_KEY = "heuknalssi.todos.v2";
const SOIL_TEST_NUMERIC_FIELDS = Object.freeze([
  "ph",
  "electricalConductivity",
  "organicMatter",
  "availablePhosphate",
  "exchangeableK",
  "exchangeableCa",
  "exchangeableMg",
]);
const SOIL_TEST_LABELS = Object.freeze({
  ph: ["산도 pH", ""],
  electricalConductivity: ["전기전도도", "dS/m"],
  organicMatter: ["유기물", "g/kg"],
  availablePhosphate: ["유효인산", "mg/kg"],
  exchangeableK: ["칼륨 K", "cmol⁺/kg"],
  exchangeableCa: ["칼슘 Ca", "cmol⁺/kg"],
  exchangeableMg: ["마그네슘 Mg", "cmol⁺/kg"],
});

const REQUEST_TIMEOUT_MS = 14_000;
const ANALYSIS_REFRESH_COOLDOWN_MS = 60_000;
const ANALYSIS_SNAPSHOT_MAX_BYTES = 2_500_000;
const REPORT_POLL_DELAYS_MS = Object.freeze([150, 250, 400, 650, 1_000, 1_000]);
const ADDRESS_SUGGESTION_DELAY_MS = 180;
let addressSuggestionTimer = null;

const CROP_LABELS = Object.freeze({
  APPLE: "사과",
  PEAR: "배",
  CUCUMBER: "오이",
  POTATO: "감자",
  LETTUCE: "상추",
});

const CULTIVATION_LABELS = Object.freeze({
  OPEN_FIELD: "노지",
  FACILITY_SOIL: "시설흙",
  FACILITY_HYDRO: "시설물",
});

const GROWTH_LABELS = Object.freeze({
  early: "초기 생육",
  middle: "한창 자라는 중",
  harvest: "수확 무렵",
  unknown: "잘 모름",
  flowering: "꽃이 피는 중",
  "tuber-bulking": "감자알이 굵어지는 중",
  "flower-differentiation": "꽃눈이 생기기 시작함",
});

const STATE_LABELS = Object.freeze({
  COMPLETE: "확인 완료",
  READY: "확인 완료",
  PARTIAL: "일부 확인",
  HOLD: "판단 보류",
  UNAVAILABLE: "자료 없음",
  UNSUPPORTED: "지원 안 함",
  NOT_APPLICABLE: "해당 없음",
  NOT_REQUESTED: "요청 전",
  PENDING: "생성 중",
  FALLBACK: "결정형 보고서",
});

const LIMITATION_LABELS = Object.freeze({
  SEASON_UNKNOWN:
    "재배 시기를 선택하지 않아 시기별 기후 위험은 판단하지 않았습니다.",
  INVALID_OBSERVATION_CONTRACT:
    "최근 관측자료가 검수한 형식과 맞지 않아 판단에 사용하지 않았습니다.",
  OBSERVATION_DATE_OUTSIDE_COMPLETED_WINDOW:
    "최근 관측자료의 날짜가 검수한 완료 기간 밖이라 판단에 사용하지 않았습니다.",
  PUBLIC_DATA_INSUFFICIENT_FOR_OPEN_FIELD_CONDITION:
    "지역 공개자료만으로 노지 재배환경을 확정할 수 없습니다.",
  REGIONAL_PUBLIC_DATA_IS_NOT_A_FIELD_MEASUREMENT:
    "지역 공개자료는 내 필지의 실측값이 아닙니다.",
  FIELD_TEST_NEXT_REQUIREMENTS_NOT_CONFIRMED:
    "현장 확인 조건이 아직 충족되지 않았습니다.",
  OUTDOOR_FORECAST_IS_NOT_INTERNAL_FACILITY_CONDITION:
    "실외 예보는 시설 내부 환경을 대신하지 않습니다.",
  OUTDOOR_DATA_IS_NOT_INTERNAL_FACILITY_MEASUREMENT:
    "실외 자료는 시설 내부의 실제 측정값을 대신하지 않습니다.",
  NO_CURRENT_FACILITY_OPERATION_RISK_CONFIRMATION:
    "현재 시설 운영 위험을 확정할 자료가 없습니다.",
  INTERNAL_FACILITY_ENVIRONMENT_REQUIRES_SENSOR_CONFIRMATION:
    "시설 내부 환경은 센서 또는 현장 기록으로 확인해야 합니다.",
  NO_RISK_CANNOT_BE_CONFIRMED:
    "현재 자료만으로 위험이 없다고 확인할 수 없습니다.",
  SOIL_SUMMARY_NOT_READY:
    "토양 요약을 확정할 자료가 아직 충분하지 않습니다.",
  NON_CURRENT_SOURCE:
    "현재 시점 자료가 아닌 출처가 포함되어 판단 범위가 제한됩니다.",
  NO_CURRENT_FORECAST_VALUES:
    "현재 사용할 수 있는 예보 값이 없어 가까운 위험을 확정하지 않습니다.",
});

const PREFLIGHT_BLOCKER_LABELS = Object.freeze({
  VERIFIED_RULES_NOT_CONFIGURED: "검토된 작물 규칙이 모두 설정되지 않음",
  VERIFIED_RULE_COVERAGE_INSUFFICIENT: "검토된 작물 규칙 범위가 부족함",
  VERIFIED_RULE_CONTEXT_COVERAGE_INSUFFICIENT:
    "작물·재배환경별 규칙 범위가 부족함",
  VERIFIED_LOCATION_MAPPINGS_INVALID: "지역 연결표 검증 실패",
  VERIFIED_LOCATION_MAPPINGS_INSUFFICIENT: "검증된 지역 연결표가 부족함",
});

const ERROR_MESSAGES = Object.freeze({
  NETWORK_ERROR: "백엔드에 연결하지 못했습니다. 서버 실행 상태를 확인해 주세요.",
  REQUEST_TIMEOUT: "응답이 늦어 요청을 중단했습니다. 잠시 뒤 다시 시도해 주세요.",
  SESSION_REQUIRED: "분석 세션이 만료되었습니다. 다시 연결해 주세요.",
  SESSION_INVALID: "분석 세션이 만료되었습니다. 다시 연결해 주세요.",
  CSRF_REJECTED: "안전한 요청 확인에 실패했습니다. 세션을 새로 준비해 주세요.",
  ORIGIN_REJECTED: "허용된 웹 주소에서 접속했는지 확인해 주세요.",
  RATE_LIMITED: "요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.",
  SERVICE_BUSY: "분석 요청이 몰려 있습니다. 잠시 뒤 다시 시도해 주세요.",
  LOCATION_QUERY_INVALID: "시·군·읍·면을 포함해 지역을 다시 입력해 주세요.",
  CURRENT_LOCATION_INVALID:
    "현재 위치가 지원 범위를 벗어났습니다. 지역을 직접 입력해 주세요.",
  LOCATION_TOKEN_INVALID: "확인한 지역 정보가 만료되었습니다. 지역을 다시 확인해 주세요.",
  LOCATION_NOT_CONFIRMED: "검색 결과에서 농장 지역을 선택해 주세요.",
  ANALYSIS_NOT_FOUND: "현재 세션에서 분석 결과를 찾을 수 없습니다.",
  INVALID_CULTIVATION_MODE: "선택한 작물에 맞는 재배 환경을 확인해 주세요.",
  INVALID_GROWTH_STAGE: "현재 지원하는 생육단계를 다시 선택해 주세요.",
  UNVERIFIED_SEASON_PROFILE: "검토된 작기 규칙이 없어 판단을 보류했습니다.",
  FEATURE_NOT_CONFIGURED:
    "이 기능은 현재 서버에 설정되지 않았습니다. 운영 설정을 확인해 주세요.",
  PARCEL_REQUIRED: "위성 자료를 확인하려면 농장 경계를 먼저 저장해 주세요.",
  CONFIRMATION_REQUIRED: "저장 또는 변경 내용을 먼저 확인해 주세요.",
  ACTION_CONFIRMATION_REQUIRED: "할 일 변경 내용을 먼저 확인해 주세요.",
  ACTION_UPDATE_CONFLICT:
    "다른 화면에서 할 일이 변경되었습니다. 최신 목록을 다시 불러옵니다.",
  ACTION_NOT_FOUND: "변경할 할 일을 찾지 못했습니다. 목록을 새로 확인해 주세요.",
  PHOTO_UPLOAD_INVALID: "JPEG, PNG 또는 WebP 사진을 다시 선택해 주세요.",
  PHOTO_UPLOAD_TOO_LARGE: "사진은 10MB 이하 파일만 저장할 수 있습니다.",
  PHOTO_UPLOAD_TOKEN_INVALID: "사진 저장 준비가 만료되었습니다. 다시 선택해 주세요.",
  PHOTO_STORAGE_UNAVAILABLE: "사진 서버 저장소에 잠시 연결할 수 없습니다.",
  PHOTO_STORAGE_REJECTED: "사진 서버 저장소가 요청을 거절했습니다.",
  PHOTO_NOT_FOUND: "삭제할 사진 기록을 찾지 못했습니다.",
  HARVEST_PHOTO_INVALID: "JPEG, PNG 또는 WebP 수확 사진을 다시 선택해 주세요.",
  HARVEST_PHOTO_TOO_LARGE: "수확 판정 사진은 6MB 이하로 선택해 주세요.",
  HARVEST_ASSESSMENT_UNAVAILABLE: "사진 수확 판정을 잠시 사용할 수 없습니다.",
  SEASON_NOT_ACTIVE: "이미 마무리한 시즌에는 사진을 추가할 수 없습니다.",
});

class ApiRequestError extends Error {
  constructor({ code, status = 0, requestId = null, details = null }) {
    super(code || "API_ERROR");
    this.name = "ApiRequestError";
    this.code = code || "API_ERROR";
    this.status = status;
    this.requestId = requestId;
    this.details = details;
  }
}

class BackendApi {
  constructor(baseUrl = "") {
    this.baseUrl = baseUrl;
    this.csrfToken = null;
  }

  async startSession(force = false) {
    if (this.csrfToken && !force) return;
    const session = await this.request("/api/session");
    if (typeof session?.csrfToken !== "string" || session.csrfToken === "") {
      throw new ApiRequestError({ code: "SESSION_INVALID", status: 502 });
    }
    this.csrfToken = session.csrfToken;
  }

  async preflight() {
    return this.request("/api/health/preflight");
  }

  async searchLocations(query) {
    return this.request(`/api/locations?q=${encodeURIComponent(query)}`);
  }

  async resolveCurrentLocation(latitude, longitude) {
    return this.request("/api/locations/current", {
      method: "POST",
      body: { latitude, longitude },
      csrf: true,
    });
  }

  async createAnalysis(payload, idempotencyKey) {
    return this.request("/api/analyses", {
      method: "POST",
      body: payload,
      csrf: true,
      headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  async getAnalysis(analysisId) {
    return this.request(`/api/analyses/${encodeURIComponent(analysisId)}`);
  }

  async getCropCycle(farmId, cropId, seasonId) {
    const query = new URLSearchParams({ seasonId });
    return this.request(
      `/api/farms/${encodeURIComponent(farmId)}/crops/${encodeURIComponent(cropId)}/cycle?${query}`,
    );
  }

  async putCropCycle(farmId, cropId, payload) {
    return this.request(
      `/api/farms/${encodeURIComponent(farmId)}/crops/${encodeURIComponent(cropId)}/cycle`,
      { method: "PUT", body: payload, csrf: true },
    );
  }

  async getHarvestWeather(farmId, cropId, { seasonId, analysisId }) {
    const query = new URLSearchParams({ seasonId, analysisId });
    return this.request(
      `/api/farms/${encodeURIComponent(farmId)}/crops/${encodeURIComponent(cropId)}/harvest-weather?${query}`,
    );
  }

  async requestReport(analysisId) {
    return this.request(
      `/api/analyses/${encodeURIComponent(analysisId)}/report`,
      { method: "POST", csrf: true },
    );
  }

  async saveReportHistory(farmId, payload) {
    return this.request(`/api/farms/${encodeURIComponent(farmId)}/reports`, {
      method: "POST",
      body: payload,
      csrf: true,
    });
  }

  async listReportHistory(farmId, { cropId = null } = {}) {
    const query = cropId ? `?cropId=${encodeURIComponent(cropId)}` : "";
    return this.request(
      `/api/farms/${encodeURIComponent(farmId)}/reports${query}`,
    );
  }

  async getSavedReport(farmId, reportId) {
    return this.request(
      `/api/farms/${encodeURIComponent(farmId)}/reports/${encodeURIComponent(reportId)}`,
    );
  }

  async saveDeviceBackup(payload, accountKey) {
    return this.request("/api/device-backup", {
      method: "POST",
      body: { payload, ...(accountKey ? { accountKey } : {}) },
      csrf: true,
    });
  }

  async restoreDeviceBackup(accountKey) {
    return this.request("/api/device-backup/restore", {
      method: "POST",
      body: { accountKey },
      csrf: true,
    });
  }

  /**
   * 재배 참고 이미지의 프록시 주소. imageId는 서버 레지스트리 키이며 외부 URL이
   * 아니다. 브라우저는 이 주소만 호출하고 외부 기관 서버에 직접 접속하지 않는다.
   */
  knowledgeImageUrl(imageId) {
    return `${this.baseUrl}/api/knowledge-images/${encodeURIComponent(imageId)}`;
  }

  async askAssistant(analysisId, question) {
    return this.request(
      `/api/analyses/${encodeURIComponent(analysisId)}/assistant`,
      {
        method: "POST",
        body: { question },
        csrf: true,
      },
    );
  }

  async getPestGuidance(analysisId) {
    return this.request(
      `/api/analyses/${encodeURIComponent(analysisId)}/pest-guidance`,
    );
  }

  async listActions(farmId, { cropId = null, seasonId = null } = {}) {
    const query = new URLSearchParams();
    if (cropId) query.set("cropId", cropId);
    if (seasonId) query.set("seasonId", seasonId);
    const suffix = query.size ? `?${query}` : "";
    return this.request(`/api/farms/${encodeURIComponent(farmId)}/actions${suffix}`);
  }

  async createAction(farmId, payload, idempotencyKey) {
    return this.request(`/api/farms/${encodeURIComponent(farmId)}/actions`, {
      method: "POST",
      body: payload,
      csrf: true,
      headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  async reconcileRuleActions(
    farmId,
    { cropId, seasonId, activeRuleIds },
    idempotencyKey,
  ) {
    return this.request(
      `/api/farms/${encodeURIComponent(farmId)}/actions/rules/reconcile`,
      {
        method: "POST",
        body: {
          cropId,
          seasonId,
          activeRuleIds,
          projection: "SYSTEM_RULE",
        },
        csrf: true,
        headers: { "Idempotency-Key": idempotencyKey },
      },
    );
  }

  async syncRuleActions(
    farmId,
    { cropId, seasonId, projections, reconcile = true },
    idempotencyKey,
  ) {
    return this.request(
      `/api/farms/${encodeURIComponent(farmId)}/actions/rules/sync`,
      {
        method: "POST",
        body: { cropId, seasonId, projections, reconcile },
        csrf: true,
        headers: { "Idempotency-Key": idempotencyKey },
      },
    );
  }

  async updateAction(farmId, actionId, status, idempotencyKey) {
    return this.request(
      `/api/farms/${encodeURIComponent(farmId)}/actions/${encodeURIComponent(actionId)}`,
      {
        method: "PATCH",
        body: { status, confirmed: true },
        csrf: true,
        headers: { "Idempotency-Key": idempotencyKey },
      },
    );
  }

  async snoozeAction(farmId, actionId, snoozedUntil, idempotencyKey) {
    return this.request(
      `/api/farms/${encodeURIComponent(farmId)}/actions/${encodeURIComponent(actionId)}`,
      {
        method: "PATCH",
        body: { snoozedUntil, confirmed: true },
        csrf: true,
        headers: { "Idempotency-Key": idempotencyKey },
      },
    );
  }

  async getParcel(farmId) {
    return this.request(`/api/farms/${encodeURIComponent(farmId)}/parcel`);
  }

  async searchFarmmapParcels(analysisId, radiusMeters = 250) {
    return this.request("/api/farmmap/parcels/search", {
      method: "POST",
      body: { analysisId, radiusMeters },
      csrf: true,
    });
  }

  async saveParcel(farmId, geometry) {
    return this.request(`/api/farms/${encodeURIComponent(farmId)}/parcel`, {
      method: "PUT",
      body: { geometry, confirmed: true },
      csrf: true,
    });
  }

  async getSatelliteObservation(farmId) {
    return this.request(
      `/api/farms/${encodeURIComponent(farmId)}/satellite/observations`,
    );
  }

  async refreshSatelliteObservation(farmId) {
    return this.request(
      `/api/farms/${encodeURIComponent(farmId)}/satellite/observations`,
      { method: "POST", body: { confirmed: true }, csrf: true },
    );
  }

  async preparePhotoUpload(farmId, payload) {
    return this.request(
      `/api/farms/${encodeURIComponent(farmId)}/photo-uploads`,
      { method: "POST", body: payload, csrf: true },
    );
  }

  async addPhoto(farmId, payload) {
    return this.request(`/api/farms/${encodeURIComponent(farmId)}/photos`, {
      method: "POST",
      body: payload,
      csrf: true,
    });
  }

  async getPhotoTimeline(farmId, { cropId, seasonId }) {
    const query = new URLSearchParams({ cropId, seasonId });
    return this.request(
      `/api/farms/${encodeURIComponent(farmId)}/photos?${query}`,
    );
  }

  async comparePhotos(farmId, payload) {
    return this.request(
      `/api/farms/${encodeURIComponent(farmId)}/photos/compare`,
      { method: "POST", body: payload, csrf: true },
    );
  }

  async deletePhoto(farmId, photoId) {
    return this.request(
      `/api/farms/${encodeURIComponent(farmId)}/photos/${encodeURIComponent(photoId)}`,
      { method: "DELETE", body: { confirmed: true }, csrf: true },
    );
  }

  async completePhotoSeason(farmId, { cropId, seasonId }) {
    return this.request(
      `/api/farms/${encodeURIComponent(farmId)}/seasons/${encodeURIComponent(seasonId)}/complete`,
      {
        method: "POST",
        body: { cropId, confirmed: true },
        csrf: true,
      },
    );
  }

  async assessHarvestPhoto(farmId, payload) {
    return this.request(
      `/api/farms/${encodeURIComponent(farmId)}/harvest-assessments`,
      { method: "POST", body: payload, csrf: true },
    );
  }

  async request(path, options = {}, canRefreshSession = true) {
    if (options.csrf && !this.csrfToken) await this.startSession();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
      REQUEST_TIMEOUT_MS,
    );
    const headers = new Headers(options.headers);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.csrf) headers.set("X-CSRF-Token", this.csrfToken);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        credentials: "include",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const body = await readResponseBody(response);
      if (!response.ok) {
        const apiError = new ApiRequestError({
          code: body?.error?.code ?? body?.code ?? `HTTP_${response.status}`,
          status: response.status,
          requestId: body?.error?.requestId ?? body?.requestId ?? null,
          details: body?.error?.details ?? body?.details ?? null,
        });
        const sessionExpired = ["SESSION_REQUIRED", "SESSION_INVALID"].includes(
          apiError.code,
        );
        const csrfExpired = options.csrf && apiError.code === "CSRF_REJECTED";
        if (canRefreshSession && (sessionExpired || csrfExpired)) {
          await this.startSession(true);
          return this.request(path, options, false);
        }
        throw apiError;
      }
      return body;
    } catch (error) {
      if (error instanceof ApiRequestError) throw error;
      if (controller.signal.aborted) {
        throw new ApiRequestError({ code: "REQUEST_TIMEOUT" });
      }
      throw new ApiRequestError({ code: "NETWORK_ERROR" });
    } finally {
      clearTimeout(timeout);
    }
  }
}

const api = new BackendApi();
const cropCycleAdapter = createCropCycleAdapter({
  getCycle: (farmId, cropId, seasonId) =>
    api.getCropCycle(farmId, cropId, seasonId),
  putCycle: (farmId, cropId, payload) =>
    api.putCropCycle(farmId, cropId, payload),
});
const form = document.querySelector("#onboarding-form");
const onboarding = document.querySelector("#onboarding");
const regionInput = document.querySelector("#region-input");
const searchLocationButton = document.querySelector("#search-location");
const currentLocationButton = document.querySelector("#use-current-location");
const currentLocationStatus = document.querySelector("#current-location-status");
const locationCandidates = document.querySelector("#location-candidates");
const regionSearchStatus = document.querySelector("#region-search-status");
const runAnalysisButton = document.querySelector("#run-analysis");
const connectionStatus = document.querySelector("#backend-connection-status");
const connectionCopy = document.querySelector("#backend-connection-copy");
const serviceBanner = document.querySelector("#backend-service-banner");
const serviceTitle = document.querySelector("#backend-service-title");
const serviceDetail = document.querySelector("#backend-service-detail");
const retryConnectionButton = document.querySelector("#retry-backend-connection");
const wizardRetryConnectionButton = document.querySelector(
  "#retry-backend-connection-wizard",
);
const runtimeModeLabel = document.querySelector("#runtime-mode-label");
const runtimeSafetyNotice = document.querySelector("#runtime-safety-notice");
const liveRegion = document.querySelector("#live-region");
const wizardNextButton = document.querySelector("#wizard-next");
const assistantLauncher = document.querySelector("#assistant-launcher");
const assistantPanel = document.querySelector("#assistant-panel");
const assistantClose = document.querySelector("#assistant-close");
const assistantForm = document.querySelector("#assistant-form");
const assistantInput = document.querySelector("#assistant-input");
const assistantSend = document.querySelector("#assistant-send");
const assistantMessages = document.querySelector("#assistant-messages");
const assistantContext = document.querySelector("#assistant-context");

let connected = false;
let preflight = null;
let selectedCandidate = null;
let currentAnalysis = null;
let currentAnalyses = new Map();
let dashboardMode = "overview";
let currentUiContexts = new Map();
const cropCycleProjections = new Map();
const cropCycleDrafts = new Map();
const harvestPhotoAssessments = new Map();
const harvestSeasonWeather = new Map();
const pestGuidanceByAnalysis = new Map();
const pestGuidanceRequests = new Map();
let pendingAttempt = null;
let connectionPromise = null;
let backupSyncPromise = null;
let assistantAnalysisId = null;
let creatingNewFarm = false;
let pendingNewSeasonDraft = null;
let disposeActionPlan = null;
let disposeOverviewActionPlan = null;
let currentActionPlan = null;
const actionPlanCache = new Map();
const actionPlanRequests = new Map();
let overviewActionScopes = new Map();
let overviewRequestVersion = 0;
let actionPlanBusy = false;
let lastAnalysisRequestAt = 0;
let pendingParcelGeometry = null;
let parcelDraftMode = "farmmap";
let parcelDraftPoints = [];
let savedParcelAvailable = false;
const photoJournal = createLocalPhotoJournal();
let photoObjectUrls = [];
const savedSessionAtBoot = readStoredSession();

initializeDashboardSurfaces();
setDashboardResultVisibility(false);
resetDashboard();
if (savedSessionAtBoot) renderStoredSessionLoading(savedSessionAtBoot);
syncAssistantContext(null);
if (savedSessionAtBoot && restoreAnalysisSnapshot(savedSessionAtBoot)) {
  document.body.dataset.sessionRestore = "snapshot-local";
}
wireInteractions();
void connectBackend();

function wireInteractions() {
  retryConnectionButton.addEventListener("click", () => {
    void connectBackend(true);
  });
  wizardRetryConnectionButton.addEventListener("click", () => {
    void connectBackend(true);
  });
  assistantLauncher?.addEventListener("click", openAssistant);
  document.querySelectorAll("[data-open-assistant]").forEach((button) => {
    button.addEventListener("click", openAssistant);
  });
  document.querySelector("#pest-assistant-trigger")?.addEventListener("click", openAssistant);
  const sidebarFarmTrigger = document.querySelector("#sidebar-farm-trigger");
  const sidebarFarmList = document.querySelector("#sidebar-farm-list");
  sidebarFarmTrigger?.addEventListener("click", () => {
    if (!sidebarFarmList) return;
    const expanding = sidebarFarmList.hidden;
    sidebarFarmList.hidden = !expanding;
    sidebarFarmTrigger.setAttribute("aria-expanded", String(expanding));
    sidebarFarmTrigger.setAttribute(
      "aria-label",
      expanding ? "내 농장 목록 접기" : "내 농장 목록 펼치기",
    );
    if (expanding) {
      sidebarFarmList.querySelector("button")?.focus({ preventScroll: true });
    }
  });
  document.querySelector("#dashboard-refresh")?.addEventListener("click", (event) => {
    void refreshCurrentAnalysis(event.currentTarget);
  });
  document.querySelector("#crop-cycle-edit")?.addEventListener("click", openCropCycleEditor);
  document.querySelector("#crop-cycle-complete")?.addEventListener("click", (event) => {
    const cropCode = currentAnalysis?.inputSummary?.crop;
    const completed = currentUiContexts.get(cropCode)?.cycleInput?.status === "COMPLETED";
    if (completed) startNewCurrentCropCycle(event.currentTarget);
    else void completeCurrentCropCycle(event.currentTarget);
  });
  document.querySelectorAll("[data-dashboard-anchor]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelector('[data-view="dashboard"]')?.click();
      requestAnimationFrame(() => {
        document
          .querySelector(`#${button.dataset.dashboardAnchor}`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  });
  document.querySelectorAll("[data-service-anchor]").forEach((button) => {
    button.addEventListener("click", () => {
      requestAnimationFrame(() => {
        document
          .querySelector(`#${button.dataset.serviceAnchor}`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  });
  document.querySelector("#dashboard-photo-check")?.addEventListener("click", () => {
    document.querySelector('[data-view="services"]')?.click();
    requestAnimationFrame(() => {
      document.querySelector("#photo-journal-panel")?.scrollIntoView({ block: "start" });
    });
  });
  document.querySelector("#dashboard-complete-all")?.addEventListener("click", (event) => {
    void completeAllOpenActions(event.currentTarget);
  });
  document.querySelector("#dashboard-all-actions")?.addEventListener("click", () => {
    toggleFullActionPlan();
  });
  assistantClose?.addEventListener("click", closeAssistant);
  assistantPanel?.addEventListener("keydown", trapAssistantFocus);
  assistantForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitAssistantQuestion(assistantInput?.value ?? "");
  });
  document.querySelectorAll("[data-assistant-question]").forEach((button) => {
    button.addEventListener("click", () => {
      void submitAssistantQuestion(button.dataset.assistantQuestion ?? "");
    });
  });
  document.addEventListener("heuknalssi:show-services", () => {
    if (document.querySelector("#view-services")?.hidden) {
      document.querySelector('[data-view="services"]')?.click();
    }
  });
  document.addEventListener("heuknalssi:wizard-cancelled", () => {
    creatingNewFarm = false;
    pendingAttempt = null;
    if (pendingNewSeasonDraft) {
      cropCycleDrafts.set(
        pendingNewSeasonDraft.crop,
        pendingNewSeasonDraft.previousInput,
      );
      pendingNewSeasonDraft = null;
      renderCropCycleSettings({ rememberExisting: false });
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && assistantPanel && !assistantPanel.hidden) {
      closeAssistant();
    }
  });
  searchLocationButton.addEventListener("click", () => {
    void searchLocations();
  });
  currentLocationButton.addEventListener("click", () => {
    void useCurrentLocation();
  });
  regionInput.addEventListener("input", () => {
    clearSelectedCandidate();
    updateLocationSearchAvailability();
    pendingAttempt = null;
    queueAddressSuggestions();
  });
  regionInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !locationCandidates.hidden) {
      hideLocationCandidates();
    }
    if (
      event.key === "ArrowDown" &&
      !locationCandidates.hidden
    ) {
      event.preventDefault();
      locationCandidates.querySelector("button")?.focus();
    }
  });
  form.addEventListener("change", (event) => {
    pendingAttempt = null;
    if (["situation", "crop"].includes(event.target?.name)) {
      queueMicrotask(() => {
        renderCropCycleSettings();
        syncWizardNextState();
      });
    }
    if (String(event.target?.name ?? "").startsWith("cycle-")) {
      const error = document.querySelector("#cycle-error");
      if (error) error.hidden = true;
    }
    updateSubmitAvailability();
    syncWizardNextState();
  });
  wizardNextButton?.addEventListener(
    "click",
    (event) => {
      const visibleStep = document.querySelector(
        '.wizard-step[data-step]:not([hidden])',
      )?.dataset.step;
      if (visibleStep === "1" && !selectedCandidate) {
        event.preventDefault();
        event.stopImmediatePropagation();
        showRegionError("현재 위치를 사용하거나 검색 결과에서 농장 지역을 선택해 주세요.");
        if (regionInput.value.trim()) void searchLocations();
        else currentLocationButton.focus();
      }
      if (
        visibleStep === "3" &&
        !cropSettingsComplete()
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        showFieldError(
          "cultivation-error",
          "선택한 작물의 재배 환경과 시기를 모두 확인해 주세요.",
        );
      }
    },
    true,
  );
  wizardNextButton?.addEventListener("click", () => {
    requestAnimationFrame(syncWizardNextState);
  });
  document.querySelector("#wizard-prev")?.addEventListener("click", () => {
    requestAnimationFrame(syncWizardNextState);
  });
  document.querySelectorAll("[data-edit-step]").forEach((button) => {
    button.addEventListener("click", () => {
      requestAnimationFrame(syncWizardNextState);
    });
  });
  form.addEventListener("reset", () => {
    cropCycleDrafts.clear();
    queueMicrotask(() => {
      renderCropCycleSettings();
      resetNewAnalysisState();
    });
  });
  form.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      void submitAnalysis();
    },
    true,
  );
  const stepObserver = new MutationObserver(syncWizardNextState);
  document.querySelectorAll(".wizard-step[data-step]").forEach((step) => {
    stepObserver.observe(step, {
      attributes: true,
      attributeFilter: ["hidden"],
    });
  });
  renderCropCycleSettings();
  syncWizardNextState();
}

async function connectBackend(force = false) {
  if (connectionPromise && !force) return connectionPromise;
  connectionPromise = performConnection();
  try {
    await connectionPromise;
  } finally {
    connectionPromise = null;
  }
}

async function performConnection() {
  connected = false;
  setConnectionState("loading", "위치 확인을 준비하고 있습니다.");
  serviceBanner.hidden = true;
  retryConnectionButton.hidden = true;
  wizardRetryConnectionButton.hidden = true;
  updateLocationSearchAvailability();
  updateSubmitAvailability();

  try {
    await api.startSession(true);
    preflight = await api.preflight();
    connected = true;
    renderRuntimeState();
    applySatelliteAvailability();
    configureDeviceBackupControl();
  } catch (error) {
    const message = errorMessage(error);
    setConnectionState("error", message);
    setServiceBanner("error", "연결하지 못했어요", message);
    serviceBanner.hidden = false;
    retryConnectionButton.hidden = false;
    wizardRetryConnectionButton.hidden = false;
    runtimeModeLabel.textContent = "API 연결 실패";
    runtimeModeLabel.closest(".test-mode")?.classList.add("danger");
  } finally {
    document.body.dataset.integration = connected ? "ready" : "error";
    updateLocationSearchAvailability();
    updateSubmitAvailability();
  }
  if (connected) await restoreSavedSession();
}

/**
 * 지난번 분석 조건을 되살린다. 후보 토큰은 만료되므로 저장해 둔 지역명으로
 * 다시 검색해 새 토큰을 받은 뒤 같은 제출 흐름을 그대로 태운다.
 * 어느 단계든 실패하면 조용히 평소의 입력 마법사로 돌아간다.
 */
async function restoreSavedSession(
  loadingCopy = "지난번 설정을 불러오는 중입니다.",
) {
  const saved = readStoredSession();
  if (!saved) return;
  try {
    setConnectionState("loading", loadingCopy);
    const saveConsent = document.querySelector("#save-consent");
    if (saveConsent) saveConsent.checked = true;

    const situationInput = form.querySelector(
      `[name="situation"][value="${saved.situation}"]`,
    );
    if (situationInput) {
      situationInput.checked = true;
      situationInput.dispatchEvent(new Event("change", { bubbles: true }));
    }

    for (const box of form.querySelectorAll('[name="crop"]')) {
      const wanted = saved.crops.includes(box.value);
      if (box.checked !== wanted) {
        box.checked = wanted;
        box.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    // 작물 설정은 체크 이벤트를 받은 뒤에 그려지므로 한 틱 기다린다.
    await delay(0);
    for (const [crop, setting] of Object.entries(saved.cropSettings ?? {})) {
      for (const [group, value] of [
        [`cultivation-${crop}`, setting.cultivation],
        [`season-${crop}`, setting.season],
        [`growth-${crop}`, setting.growth],
      ]) {
        if (!value) continue;
        const input = form.querySelector(`[name="${group}"][value="${value}"]`);
        if (input) {
          input.checked = true;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      if (setting?.cycle) {
        try {
          const cycle = normalizeCropCycleInput(setting.cycle, {
            crop,
            situation: saved.situation,
          });
          cropCycleDrafts.set(crop, cycle);
          for (const [field, value] of Object.entries(cycle)) {
            const input = form.querySelector(`[name="cycle-${field}-${crop}"]`);
            if (input) input.value = value;
          }
        } catch {
          // 이전 저장값이 손상됐으면 현재 날짜 기본값을 보여 준다.
        }
      }
    }

    regionInput.value = saved.region;
    const restored = restoreAnalysisSnapshot(saved);
    if (restored) {
      setConnectionState("ready", "저장된 최근 분석을 불러왔습니다.");
      document.body.dataset.sessionRestore = "snapshot";
      void refreshCropCycleProjections(cropCycleRequestsForProfile(saved)).catch((error) => {
        setServiceBanner(
          "hold",
          "저장한 재배일정을 서버에서 불러오지 못했습니다",
          `이 기기의 저장 입력 기준 예상을 표시합니다. ${errorMessage(error)}`,
        );
        serviceBanner.hidden = false;
      });
    } else {
      setConnectionState("ready", "최근 분석 결과가 없습니다.");
      const dashboardTitle = document.querySelector("#dashboard-title");
      if (dashboardTitle) dashboardTitle.textContent = farmDisplayName(saved);
      setServiceBanner(
        "hold",
        "저장된 농장 설정을 불러왔습니다",
        "처음 한 번만 ‘새로 분석’을 눌러 최신 결과를 저장해 주세요. 이후에는 페이지를 다시 열어도 저장된 결과가 먼저 표시됩니다.",
      );
      serviceBanner.hidden = false;
      document.body.dataset.sessionRestore = "profile-only";
    }
    document.body.classList.remove("session-restoring", "session-restore-failed");
    // 재분석 버튼을 누를 때 바로 사용할 수 있도록 위치 후보만 준비한다.
    // 위치 준비 실패는 저장된 결과 표시를 막지 않는다.
    void prepareStoredLocationCandidate(saved.region);
  } catch (error) {
    // 저장된 설정은 보존한다. 일시적인 API 장애 때문에 다시 입력시키지 않는다.
    document.body.dataset.sessionRestore = `failed:${error?.message ?? "unknown"}`;
    document.body.classList.remove("session-restoring");
    document.body.classList.add("session-restore-failed");
    setConnectionState("error", "저장한 농장을 다시 불러오지 못했습니다.");
    setServiceBanner(
      "error",
      "저장한 농장 결과를 불러오지 못했습니다",
      "입력한 농장 설정은 이 기기에 남아 있습니다. ‘새로 분석’을 눌러 최신 결과를 다시 만들어 주세요.",
    );
    serviceBanner.hidden = false;
    retryConnectionButton.hidden = true;
  }
}

async function prepareStoredLocationCandidate(region) {
  if (typeof region !== "string" || region.trim() === "") return false;
  if (selectedCandidate?.displayName === region.trim()) return true;
  regionInput.value = region.trim();
  await searchLocations();
  const firstCandidate = locationCandidates.querySelector(
    ".location-candidate",
  );
  if (!firstCandidate) return false;
  firstCandidate.click();
  return Boolean(selectedCandidate);
}

function renderRuntimeState() {
  const ready = preflight?.ready === true || preflight?.serviceState === "READY";
  const blockers = [...new Set(preflight?.blockers ?? [])];
  const blockerCopy = blockers.length
    ? blockers.slice(0, 4).map(preflightBlockerLabel).join(" · ")
    : "운영 준비 차단 사유가 제공되지 않았습니다.";
  runtimeSafetyNotice.className = "notice notice-warning";
  runtimeSafetyNotice.hidden = false;
  retryConnectionButton.hidden = true;
  wizardRetryConnectionButton.hidden = true;
  setLocationStatus(
    regionInput.value.trim()
      ? "입력한 지역을 확인한 뒤 검색 결과에서 농장 지역을 선택해 주세요."
      : "지역을 입력한 뒤 ‘입력한 지역 확인’을 눌러 주세요.",
  );
  setCurrentLocationStatus(
    navigator.geolocation
      ? "버튼을 누르면 기기의 위치 권한을 요청합니다."
      : "이 기기에서는 현재 위치를 사용할 수 없습니다. 지역을 직접 입력해 주세요.",
    navigator.geolocation ? "" : "error",
  );
  configurePersistenceControl();

  if (ready) {
    setConnectionState("ready", "자료 연결 확인 완료");
    runtimeModeLabel.textContent = "자료별 확인";
    serviceBanner.hidden = true;
    runtimeSafetyNotice.hidden = true;
    return;
  }

  setConnectionState("hold", "부분 분석 가능");
  runtimeModeLabel.textContent = "부분 분석 가능";
  setServiceBanner(
    "hold",
    "일부 자료만 연결됨",
    "분석을 시작하면 실제로 받은 기상·토양 자료만 사용합니다. 연결되지 않은 자료는 결과에서 별도로 표시합니다.",
  );
  serviceBanner.hidden = false;
  runtimeSafetyNotice.hidden = false;
  replaceNotice(
    runtimeSafetyNotice,
    "부분 분석 결과만 제공합니다.",
    "자료 연결은 분석할 때 다시 확인합니다. 빠진 값은 추정하지 않고 결과에서 별도로 표시합니다.",
  );
}

function configurePersistenceControl() {
  const input = document.querySelector("#save-consent");
  const label = document.querySelector('label[for="save-consent"]');
  if (!input || !label) return;
  const container = input.closest(".inline-check");
  input.disabled = safeStorage() === null;
  if (container) container.hidden = false;
  label.textContent = "이 기기에 농장 설정을 저장합니다. (선택)";
}

function configureDeviceBackupControl() {
  const createButton = document.querySelector("#account-key-create");
  const restoreButton = document.querySelector("#account-key-restore");
  const input = document.querySelector("#account-key-input");
  const status = document.querySelector("#account-key-status");
  if (!createButton && !restoreButton) return;

  const available = ["READY", "AVAILABLE"].includes(
    preflight?.capabilities?.deviceBackup,
  );
  if (createButton) createButton.disabled = !available;
  if (restoreButton) restoreButton.disabled = !available;
  if (input) input.disabled = !available;
  if (!available && status) {
    status.textContent =
      "기기 이관 저장소가 연결되지 않아 현재 입력은 이 기기에만 저장됩니다.";
  }
}

async function searchLocations({ autoSelectSingle = false } = {}) {
  const query = regionInput.value.trim();
  if (!connected) {
    showRegionError("먼저 백엔드에 다시 연결해 주세요.");
    return;
  }
  if (query.length < 2) {
    showRegionError("시·군·읍·면을 두 글자 이상 입력해 주세요.");
    regionInput.focus();
    return;
  }

  clearSelectedCandidate();
  setBusy(searchLocationButton, true, "후보 찾는 중…");
  setLocationStatus("입력한 지역을 확인하고 있습니다.");
  locationCandidates.hidden = true;
  locationCandidates.replaceChildren();

  try {
    const response = await api.searchLocations(query);
    const candidates = Array.isArray(response?.candidates)
      ? response.candidates.filter(isLocationCandidate)
      : [];
    if (candidates.length === 0) {
      setLocationStatus(
        "일치하는 지역이 없습니다. 시·군·구를 포함해 다시 입력해 주세요.",
        "error",
      );
      searchLocationButton.textContent = "다시 찾기";
      return;
    }
    renderLocationCandidates(candidates);
    if (autoSelectSingle && candidates.length === 1) {
      selectLocationCandidate(
        candidates[0],
        locationCandidates.querySelector(".location-candidate"),
      );
      return;
    }
    setLocationStatus(
      `${candidates.length}개의 후보를 찾았습니다. 실제 지역과 맞는 항목을 선택해 주세요.`,
    );
  } catch (error) {
    setLocationStatus(errorMessage(error), "error");
    if (error?.code === "SESSION_INVALID") connected = false;
    searchLocationButton.textContent = "다시 찾기";
  } finally {
    setBusy(searchLocationButton, false, "입력한 지역 확인");
    updateLocationSearchAvailability();
  }
}

function queueAddressSuggestions() {
  clearTimeout(addressSuggestionTimer);
  const query = regionInput.value.trim();
  if (query.length < 2) {
    hideLocationCandidates();
    setLocationStatus("시·도 또는 시·군·구를 두 글자 이상 입력해 주세요.");
    return;
  }
  setLocationStatus("입력한 지역의 주소 후보를 찾고 있습니다.");
  addressSuggestionTimer = setTimeout(() => {
    if (regionInput.value.trim() !== query || selectedCandidate) return;
    const suggestions = suggestAdministrativeAddresses(query);
    if (suggestions.length === 0) {
      hideLocationCandidates();
      setLocationStatus(
        "행정구역 후보가 없으면 상세 주소를 계속 입력한 뒤 ‘입력한 지역 확인’을 눌러 주세요.",
      );
      return;
    }
    renderAdministrativeSuggestions(suggestions);
    setLocationStatus(
      `${suggestions.length}개의 시·군·구 후보가 있습니다. 농장 지역을 선택해 주세요.`,
    );
  }, ADDRESS_SUGGESTION_DELAY_MS);
}

function renderAdministrativeSuggestions(suggestions) {
  const fragments = suggestions.map((displayName) => {
    const item = element("div");
    item.setAttribute("role", "listitem");
    const button = element("button", "location-candidate location-suggestion");
    button.type = "button";
    const copy = element("span");
    copy.append(
      element("strong", "", displayName),
      element("small", "", "시·군·구 주소 후보"),
    );
    const action = element("span", "candidate-check", "선택");
    action.setAttribute("aria-hidden", "true");
    button.append(copy, action);
    button.addEventListener("click", () => {
      regionInput.value = displayName;
      hideLocationCandidates();
      setLocationStatus(`${displayName}의 실제 위치를 확인하고 있습니다.`);
      void searchLocations({ autoSelectSingle: true });
    });
    item.append(button);
    return item;
  });
  locationCandidates.replaceChildren(...fragments);
  locationCandidates.hidden = false;
  regionInput.setAttribute("aria-expanded", "true");
}

async function useCurrentLocation() {
  if (!connected) {
    showRegionError("먼저 백엔드에 다시 연결해 주세요.");
    return;
  }
  if (!navigator.geolocation) {
    setCurrentLocationStatus(
      "이 기기에서는 현재 위치를 사용할 수 없습니다. 아래에서 지역을 직접 입력해 주세요.",
      "error",
    );
    regionInput.focus();
    return;
  }

  clearSelectedCandidate();
  setBusy(currentLocationButton, true, "현재 위치 확인 중…");
  setCurrentLocationStatus(
    "기기의 위치 권한을 확인하고 있습니다. 정확한 좌표는 화면이나 분석 결과에 표시하지 않습니다.",
  );

  try {
    const position = await getCurrentPosition();
    setCurrentLocationStatus("현재 위치를 농장 지역으로 변환하고 있습니다.");
    const response = await api.resolveCurrentLocation(
      position.coords.latitude,
      position.coords.longitude,
    );
    const candidates = Array.isArray(response?.candidates)
      ? response.candidates.filter(isLocationCandidate)
      : [];
    if (candidates.length === 0) {
      setCurrentLocationStatus(
        "현재 위치에서 지원 지역을 찾지 못했습니다. 아래에서 지역을 직접 입력해 주세요.",
        "error",
      );
      return;
    }
    renderLocationCandidates(candidates);
    const exactCandidate = candidates.find(
      (candidate) => candidate.resolutionMode === "ADDRESS_RESOLVED",
    );
    const rawAccuracy = Number(position.coords.accuracy);
    const accuracyMeters = Number.isFinite(rawAccuracy)
      ? Math.max(0, Math.round(rawAccuracy))
      : null;
    if (
      exactCandidate &&
      (accuracyMeters === null || accuracyMeters <= 100)
    ) {
      const exactIndex = candidates.indexOf(exactCandidate);
      const exactButton = locationCandidates.querySelectorAll(
        ".location-candidate",
      )[exactIndex];
      selectLocationCandidate(exactCandidate, exactButton);
      setCurrentLocationStatus(
        `${exactCandidate.displayName}을(를) 상세 지번 주소로 확인했습니다. 필지 토양과 가까운 기상 관측소를 자동으로 연결합니다.`,
        "success",
      );
      return;
    }
    if (exactCandidate) {
      setCurrentLocationStatus(
        `현재 위치 오차가 약 ${accuracyMeters}m입니다. 아래 주소가 맞는지 선택해 주세요.`,
      );
      return;
    }
    setCurrentLocationStatus(
      "현재 위치에서는 행정구역까지만 확인했습니다. 필지 확정을 위해 지번 또는 도로명 주소를 확인해 주세요.",
      "error",
    );
    regionInput.focus();
  } catch (error) {
    const message = geolocationErrorMessage(error);
    setCurrentLocationStatus(message, "error");
    announce(message);
  } finally {
    setBusy(currentLocationButton, false, "현재 위치로 농장 찾기");
    updateLocationSearchAvailability();
  }
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15_000,
      maximumAge: 0,
    });
  });
}

function geolocationErrorMessage(error) {
  if (error?.code === 1) {
    return "위치 권한이 꺼져 있습니다. 브라우저에서 허용하거나 아래에서 지역을 직접 입력해 주세요.";
  }
  if (error?.code === 2) {
    return "현재 위치를 확인하지 못했습니다. 잠시 뒤 다시 시도하거나 지역을 직접 입력해 주세요.";
  }
  if (error?.code === 3) {
    return "위치 확인 시간이 오래 걸려 중단했습니다. 지역을 직접 입력해 주세요.";
  }
  return errorMessage(error);
}

function renderLocationCandidates(candidates) {
  const fragments = candidates.map((candidate) => {
    const item = element("div");
    item.setAttribute("role", "listitem");
    const button = element("button", "location-candidate");
    button.type = "button";
    button.setAttribute("aria-pressed", "false");
    const copy = element("span");
    copy.append(
      element("strong", "", candidate.displayName),
      element(
        "small",
        "",
        [
          locationResolutionLabel(candidate.resolutionMode),
          candidate.expiresAt ? `유효 ${formatDateTime(candidate.expiresAt)}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    const check = element("span", "candidate-check", "선택");
    check.setAttribute("aria-hidden", "true");
    button.append(copy, check);
    button.addEventListener("click", () => selectLocationCandidate(candidate, button));
    item.append(button);
    return item;
  });
  locationCandidates.replaceChildren(...fragments);
  locationCandidates.hidden = false;
  regionInput.setAttribute("aria-expanded", "true");
}

function selectLocationCandidate(candidate, button) {
  selectedCandidate = candidate;
  regionInput.value = candidate.displayName;
  regionInput.dataset.candidateVerified = "true";
  locationCandidates.querySelectorAll(".location-candidate").forEach((item) => {
    item.setAttribute("aria-pressed", String(item === button));
    item.querySelector(".candidate-check").textContent =
      item === button ? "선택됨" : "선택";
  });
  setLocationStatus(
    `${candidate.displayName}을(를) ${locationResolutionLabel(candidate.resolutionMode)}으로 선택했습니다.`,
    "success",
  );
  document.querySelector("#region-error").hidden = true;
  pendingAttempt = null;
  updateSubmitAvailability();
  syncWizardNextState();
  announce("농장 지역을 선택했습니다. 다음 단계로 진행할 수 있습니다.");
}

async function submitAnalysis({ refreshExpiredLocation = true } = {}) {
  if (!connected) {
    showSubmitError("백엔드 연결을 먼저 복구해 주세요.");
    return false;
  }
  if (!selectedCandidate) {
    showRegionError("현재 위치를 사용하거나 검색 결과에서 농장 지역을 선택해 주세요.");
    navigateToWizardStep(1);
    return false;
  }

  let payloads;
  let formValues;
  try {
    formValues = readFormValues();
    payloads = buildAnalysisRequests(
      formValues,
      selectedCandidate.candidateToken,
    );
  } catch (error) {
    if (error instanceof ContractValidationError) {
      showContractError(error);
      return false;
    }
    throw error;
  }

  const fingerprint = requestFingerprint(payloads);
  if (!pendingAttempt || pendingAttempt.fingerprint !== fingerprint) {
    pendingAttempt = {
      fingerprint,
      idempotencyKeys: payloads.map(() => createIdempotencyKey()),
    };
  }

  setBusy(
    runAnalysisButton,
    true,
    payloads.length > 1 ? `작물 ${payloads.length}종 분석 중…` : "분석하는 중…",
  );
  form.setAttribute("aria-busy", "true");
  replaceNotice(
    runtimeSafetyNotice,
    "지역 자료와 검토 규칙을 연결하고 있습니다.",
    "같은 요청이 중복 처리되지 않도록 보호한 뒤 결과를 확인합니다.",
  );

  try {
    const results = await Promise.allSettled(payloads.map(async (payload, index) => {
      const created = await api.createAnalysis(
        payload,
        pendingAttempt.idempotencyKeys[index],
      );
      const analysisId = created?.analysisId;
      if (typeof analysisId !== "string" || analysisId === "") {
        throw new ApiRequestError({ code: "INVALID_API_RESPONSE", status: 502 });
      }
      return api.getAnalysis(analysisId);
    }));
    const completed = results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    const failed = results
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.status === "rejected");
    if (completed.length === 0) throw failed[0]?.result.reason;

    currentUiContexts = collectUiAnalysisContexts(formValues, payloads);
    currentAnalyses = new Map(
      completed.map((analysis) => [analysis?.inputSummary?.crop, analysis]),
    );
    currentAnalysis = completed[0];
    const cycleRequests = buildCropCycleRequests(formValues);
    seedLocalCropCycleProjections(cycleRequests);
    let cropCycleSaveError = null;
    // 행동·사진·위성 기능이 첫 렌더부터 같은 농장 ID를 사용하도록
    // 사용자가 요청한 기기 저장을 기능 렌더링보다 먼저 확정한다.
    if (formValues.saveConsent === true) {
      writeStoredSession(formValues, selectedCandidate?.displayName ?? null);
      lastAnalysisRequestAt = writeAnalysisSnapshot(completed) ?? Date.now();
      try {
        await refreshCropCycleProjections(cycleRequests, { save: true });
      } catch (error) {
        cropCycleSaveError = error;
      }
    } else {
      lastAnalysisRequestAt = Date.now();
    }
    actionPlanCache.clear();
    actionPlanRequests.clear();
    await Promise.allSettled(
      completed.map((analysis) =>
        loadActionPlan(analysis, { ensureRules: true, force: true })
      ),
    );
    renderAnalysis(currentAnalysis);
    dashboardMode = "overview";
    renderFarmOverview();
    renderCropResultSwitcher();
    pendingAttempt = null;
    pendingNewSeasonDraft = null;
    closeWizardAfterAnalysis();
    if (failed.length > 0) {
      const failedCrops = failed.map(({ index }) =>
        CROP_LABELS[payloads[index]?.crop] ?? payloads[index]?.crop ?? "작물"
      );
      setServiceBanner(
        "hold",
        `${completed.length}개 작물 분석 완료`,
        `${failedCrops.join("·")} 분석은 완료하지 못했습니다. 완료된 결과는 그대로 보존했습니다.`,
      );
      serviceBanner.hidden = false;
    } else if (cropCycleSaveError) {
      setServiceBanner(
        "hold",
        "분석은 완료했지만 재배일정을 서버에 저장하지 못했습니다",
        `입력한 기준일은 이 기기에 남아 있으며 미리보기로 표시합니다. ${errorMessage(cropCycleSaveError)}`,
      );
      serviceBanner.hidden = false;
    } else {
      serviceBanner.hidden = true;
    }
    if ((currentAnalysis?.report?.state ?? "NOT_REQUESTED") === "NOT_REQUESTED") {
      const automaticReportButton = document.querySelector("#backend-report-button");
      if (automaticReportButton) {
        void requestAndPollReport(automaticReportButton, { automatic: true });
      }
    }
    return true;
  } catch (error) {
    if (
      error?.code === "LOCATION_TOKEN_INVALID" &&
      refreshExpiredLocation &&
      await refreshConfirmedLocationCandidate()
    ) {
      return submitAnalysis({ refreshExpiredLocation: false });
    }
    if (error?.code === "LOCATION_TOKEN_INVALID") {
      clearSelectedCandidate("확인한 지역을 자동 갱신하지 못했습니다. 지역을 다시 확인해 주세요.");
      navigateToWizardStep(1);
    }
    showSubmitError(errorMessage(error));
    return false;
  } finally {
    form.removeAttribute("aria-busy");
    setBusy(runAnalysisButton, false, "이 조건으로 분석하기");
    updateSubmitAvailability();
  }
}

async function refreshCurrentAnalysis(button) {
  if (!connected) {
    announce("백엔드 연결을 먼저 확인해 주세요.");
    return;
  }
  const elapsed = Date.now() - lastAnalysisRequestAt;
  if (lastAnalysisRequestAt > 0 && elapsed < ANALYSIS_REFRESH_COOLDOWN_MS) {
    const seconds = Math.max(
      1,
      Math.ceil((ANALYSIS_REFRESH_COOLDOWN_MS - elapsed) / 1_000),
    );
    announce(`최신 분석을 방금 완료했습니다. ${seconds}초 뒤 다시 시도해 주세요.`);
    return;
  }
  const saved = readStoredSession();
  if (
    !selectedCandidate &&
    !(await prepareStoredLocationCandidate(saved?.region))
  ) {
    announce("농장 위치를 다시 확인한 뒤 새로 분석해 주세요.");
    return;
  }
  pendingAttempt = null;
  actionPlanCache.clear();
  actionPlanRequests.clear();
  setBusy(button, true, "분석 중…");
  try {
    const refreshed = await submitAnalysis();
    announce(
      refreshed
        ? "최신 날씨와 토양 자료로 다시 분석했습니다."
        : "분석을 새로고침하지 못했습니다.",
    );
  } finally {
    setBusy(button, false, "↻ 새로 분석");
  }
}

async function refreshConfirmedLocationCandidate() {
  const confirmedName = selectedCandidate?.displayName;
  if (typeof confirmedName !== "string" || confirmedName.trim() === "") {
    return false;
  }
  try {
    setLocationStatus("확인한 지역 정보를 갱신하고 있습니다.");
    const response = await api.searchLocations(confirmedName);
    const matches = Array.isArray(response?.candidates)
      ? response.candidates
        .filter(isLocationCandidate)
        .filter((candidate) => candidate.displayName === confirmedName)
      : [];
    if (matches.length !== 1) return false;
    selectedCandidate = matches[0];
    regionInput.value = confirmedName;
    regionInput.dataset.candidateVerified = "true";
    pendingAttempt = null;
    setLocationStatus(`${confirmedName} 지역 확인을 갱신했습니다.`, "success");
    announce("확인한 농장 지역을 갱신하고 분석을 계속합니다.");
    return true;
  } catch {
    return false;
  }
}

function renderAnalysis(analysis) {
  const summary = analysis?.inputSummary ?? {};
  const cropLabel = CROP_LABELS[summary.crop] ?? summary.crop ?? "작물";
  const regionLabel = summary.regionLabel ?? selectedCandidate?.displayName ?? "선택 지역";
  const compactRegion = compactDashboardRegionLabel(regionLabel);
  const context = `${compactRegion} ${cropLabel} 농장`;
  renderSummaryPanel(analysis, regionLabel, cropLabel);
  document.querySelector("#sidebar-context-value").textContent = context;
  document.querySelector("#topbar-context-value").textContent = context;
  document.querySelector("#dashboard-title").textContent =
    context;
  const scopeLabel = document.querySelector("#dashboard-scope-label");
  if (scopeLabel) {
    scopeLabel.hidden = !isRegionalReferenceAnalysis(analysis);
  }
  const updatedAt = formatDashboardUpdate(analysis?.createdAt);
  const topbarUpdatedAt = document.querySelector("#topbar-updated-at");
  const sidebarUpdatedAt = document.querySelector("#sidebar-updated-at");
  if (topbarUpdatedAt) topbarUpdatedAt.textContent = updatedAt;
  if (sidebarUpdatedAt) sidebarUpdatedAt.textContent = updatedAt;
  document.querySelector("#dashboard-mode-copy").textContent =
    summary.usageMode === "ACTIVE_GROWING"
      ? "재배 중 생육 기준 날씨·토양·예보 분석"
      : "재배 준비 기준 기후·토양·예보 분석";
  document.querySelector("#sidebar-mode-value").textContent =
    summary.usageMode === "ACTIVE_GROWING"
      ? "재배 중 생육 점검"
      : "재배 준비 진단";

  renderAnalysisScopeNotice(analysis);
  renderDashboardWorkspace(analysis);
  renderEvidenceDialog(analysis);
  renderTechnicalSettings(analysis);
  syncAssistantContext(analysis);
  writeStoredTodo(analysis);
  void refreshActionPlan(analysis);
  void refreshSatellitePanel(analysis);
  void refreshPhotoJournal(analysis);
  setDashboardResultVisibility(true);
}

function compactDashboardRegionLabel(value) {
  return String(value ?? "")
    .replace(/^(대한민국|한국)\s*/u, "")
    .replace(/^서울특별시/u, "서울")
    .replace(/^부산광역시/u, "부산")
    .replace(/^대구광역시/u, "대구")
    .replace(/^인천광역시/u, "인천")
    .replace(/^광주광역시/u, "광주")
    .replace(/^대전광역시/u, "대전")
    .replace(/^울산광역시/u, "울산")
    .replace(/^세종특별자치시/u, "세종")
    .replace(/^경기도/u, "경기")
    .replace(/^강원특별자치도/u, "강원")
    .replace(/^충청북도/u, "충북")
    .replace(/^충청남도/u, "충남")
    .replace(/^전북특별자치도/u, "전북")
    .replace(/^전라남도/u, "전남")
    .replace(/^경상북도/u, "경북")
    .replace(/^경상남도/u, "경남")
    .replace(/^제주특별자치도/u, "제주")
    .trim();
}

async function refreshActionPlan(analysis, { ensureRules = false } = {}) {
  const root = document.querySelector("#dashboard-action-list");
  const fallback = document.querySelector("#dashboard-priority-action");
  const scope = currentFeatureScope(analysis);
  if (!root || !scope || !connected) return;
  root.hidden = false;
  root.setAttribute("aria-busy", "true");
  if (!root.childElementCount) {
    root.replaceChildren(element("p", "backend-empty", "오늘 할 일을 준비하고 있습니다."));
  }
  try {
    const plan = await loadActionPlan(analysis, { ensureRules });
    currentActionPlan = plan;
    disposeActionPlan?.();
    disposeActionPlan = mountActionPlan(root, plan, {
      onStatusChange: async ({ actionId, status }) => {
        await api.updateAction(scope.farmId, actionId, status, createIdempotencyKey());
        invalidateActionPlan(analysis);
        await refreshActionPlan(analysis, { ensureRules: false });
        const message = document.querySelector("#dashboard-action-batch-status");
        if (message) {
          message.hidden = true;
          message.classList.remove("is-error");
          message.textContent = "";
        }
      },
      onSnooze: async ({ actionId, snoozedUntil }) => {
        await api.snoozeAction(
          scope.farmId,
          actionId,
          snoozedUntil,
          createIdempotencyKey(),
        );
        invalidateActionPlan(analysis);
        await refreshActionPlan(analysis, { ensureRules: false });
        const message = document.querySelector("#dashboard-action-batch-status");
        if (message) {
          message.hidden = false;
          message.classList.remove("is-error");
          message.textContent = "내일 오전 7시에 다시 확인하도록 옮겼습니다.";
        }
        announce("할 일을 내일 오전 7시로 옮겼습니다.");
      },
      onStatusError: ({ error }) => {
        const status = document.querySelector("#dashboard-action-batch-status");
        if (status) {
          status.hidden = false;
          status.classList.add("is-error");
          status.textContent = `작업 상태를 저장하지 못했습니다. ${errorMessage(error)}`;
        }
        announce(status?.textContent ?? "작업 상태를 저장하지 못했습니다.");
      },
    });
    renderMobileActionPlanSummary(plan);
    renderDashboardWeeklyRisks(analysis, plan);
    writeStoredTodoFromPlan(plan, analysis);
    if (fallback) fallback.hidden = true;
    syncActionHeaderControls(plan);
  } catch (error) {
    currentActionPlan = null;
    root.replaceChildren(
      element(
        "p",
        "backend-empty",
        `할 일 기록을 불러오지 못했습니다. ${errorMessage(error)}`,
      ),
    );
    if (fallback) fallback.hidden = false;
    syncActionHeaderControls(null);
  } finally {
    root.removeAttribute("aria-busy");
  }
}

function actionPlanCacheKey(scope) {
  return [scope.farmId, scope.cropId ?? "", scope.seasonId ?? ""].join("::");
}

function invalidateActionPlan(analysis) {
  const scope = currentFeatureScope(analysis);
  if (!scope) return;
  const key = actionPlanCacheKey(scope);
  actionPlanCache.delete(key);
  actionPlanRequests.delete(key);
}

async function loadActionPlan(
  analysis,
  { ensureRules = false, force = false } = {},
) {
  const scope = currentFeatureScope(analysis);
  if (!scope) throw new ApiRequestError({ code: "INVALID_API_RESPONSE", status: 422 });
  const key = actionPlanCacheKey(scope);
  if (!force && actionPlanCache.has(key)) return actionPlanCache.get(key);
  if (!force && actionPlanRequests.has(key)) return actionPlanRequests.get(key);
  const request = (async () => {
    if (isCompletedCycle(analysis)) {
      const { plan } = await closeCompletedSeasonActions(scope);
      return plan;
    }
    if (!ensureRules) return api.listActions(scope.farmId, scope);
    const projections = actionDraftsFromAnalysis(analysis, scope);
    const reconcile = canReconcileProjectedActions(analysis);
    if (projections.length === 0 && !reconcile) {
      return api.listActions(scope.farmId, scope);
    }
    const result = await api.syncRuleActions(
      scope.farmId,
      { cropId: scope.cropId, seasonId: scope.seasonId, projections, reconcile },
      createIdempotencyKey(),
    );
    return result?.plan;
  })();
  actionPlanRequests.set(key, request);
  try {
    const plan = await request;
    if (!plan || !Array.isArray(plan.today) || !Array.isArray(plan.upcoming)) {
      throw new ApiRequestError({ code: "INVALID_API_RESPONSE", status: 502 });
    }
    actionPlanCache.set(key, plan);
    return plan;
  } finally {
    if (actionPlanRequests.get(key) === request) actionPlanRequests.delete(key);
  }
}

function isCompletedCycle(analysis) {
  const crop = analysis?.inputSummary?.crop;
  return currentUiContexts.get(crop)?.cycleInput?.status === "COMPLETED";
}

async function closeCompletedSeasonActions(scope) {
  const before = await api.listActions(scope.farmId, scope);
  const scoped = [
    ...(before?.today ?? []),
    ...(before?.upcoming ?? []),
    ...(before?.archived ?? []),
  ];
  const unique = new Map(
    scoped
      .filter((action) => typeof action?.actionId === "string")
      .map((action) => [action.actionId, action]),
  );
  const completedActionCount = [...unique.values()]
    .filter((action) => action.status === "DONE").length;

  await api.reconcileRuleActions(
    scope.farmId,
    { cropId: scope.cropId, seasonId: scope.seasonId, activeRuleIds: [] },
    createIdempotencyKey(),
  );
  const userOpenActions = [...unique.values()].filter(
    (action) => action.status === "OPEN" && action.origin !== "RULE",
  );
  const updates = await Promise.allSettled(
    userOpenActions.map((action) =>
      api.updateAction(
        scope.farmId,
        action.actionId,
        "SKIPPED",
        createIdempotencyKey(),
      )
    ),
  );
  const failed = updates.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return {
    completedActionCount,
    plan: await api.listActions(scope.farmId, scope),
  };
}

function planItems(plan) {
  return [...(plan?.today ?? []), ...(plan?.upcoming ?? [])];
}

function syncActionHeaderControls(plan) {
  const items = planItems(plan);
  const openCount = (plan?.today ?? []).filter(
    (item) => item?.status === "OPEN",
  ).length;
  const count = document.querySelector(".dashboard-actions .dashboard-count");
  const completeAll = document.querySelector("#dashboard-complete-all");
  const allActions = document.querySelector("#dashboard-all-actions");
  if (count) {
    count.textContent = `${openCount}개`;
    count.setAttribute("aria-label", `남은 할 일 ${openCount}개`);
  }
  if (completeAll) {
    completeAll.disabled = actionPlanBusy || openCount === 0;
    if (!actionPlanBusy) completeAll.textContent = openCount ? "✓ 모두 완료 표시" : "모두 완료됨";
  }
  if (allActions) {
    allActions.disabled = items.length === 0;
    allActions.setAttribute("aria-label", `전체 작업 ${items.length}개 보기`);
  }
}

async function completeAllOpenActions(button) {
  if (actionPlanBusy || !currentAnalysis) return;
  const scope = currentFeatureScope(currentAnalysis);
  const openActions = (currentActionPlan?.today ?? [])
    .filter((item) => item?.status === "OPEN" && typeof item.actionId === "string");
  if (!scope || openActions.length === 0) {
    announce("완료할 열린 작업이 없습니다.");
    return;
  }
  const status = document.querySelector("#dashboard-action-batch-status");
  actionPlanBusy = true;
  syncActionHeaderControls(currentActionPlan);
  if (button) button.textContent = `0 / ${openActions.length} 저장 중`;
  if (status) {
    status.hidden = false;
    status.textContent = `${openActions.length}개 작업을 순서대로 저장하고 있습니다.`;
  }
  const failures = [];
  let completed = 0;
  for (const action of openActions) {
    try {
      await api.updateAction(scope.farmId, action.actionId, "DONE", createIdempotencyKey());
      completed += 1;
      if (button) button.textContent = `${completed} / ${openActions.length} 저장 중`;
    } catch (error) {
      failures.push({ action, error });
    }
  }
  actionPlanBusy = false;
  invalidateActionPlan(currentAnalysis);
  await refreshActionPlan(currentAnalysis, { ensureRules: false });
  if (status) {
    status.hidden = false;
    status.classList.toggle("is-error", failures.length > 0);
    status.textContent = failures.length
      ? `${completed}개는 완료했습니다. 저장하지 못한 ${failures.length}개는 그대로 남겨 두었습니다.`
      : `${completed}개 작업을 모두 완료했습니다.`;
  }
  announce(status?.textContent ?? "작업 상태를 갱신했습니다.");
}

function toggleFullActionPlan() {
  const root = document.querySelector("#dashboard-action-list");
  const button = document.querySelector("#dashboard-all-actions");
  if (!root || !button || button.disabled) return;
  const expanded = !root.classList.contains("is-expanded");
  root.classList.toggle("is-expanded", expanded);
  button.setAttribute("aria-expanded", String(expanded));
  button.replaceChildren(
    document.createTextNode(expanded ? "오늘 할 일만 보기 " : "전체 작업 목록 보기 "),
    element("span", "", expanded ? "↑" : "→"),
  );
  announce(expanded ? "당분간 주의와 완료 기록까지 펼쳤습니다." : "오늘 할 일만 표시합니다.");
}

function currentFeatureScope(analysis) {
  const summary = analysis?.inputSummary;
  if (!summary?.crop) return null;
  const stored = readStoredSession();
  const safeAnalysisId = String(analysis?.analysisId ?? "current")
    .replace(/[^A-Za-z0-9_-]+/g, "")
    .slice(0, 48);
  const farmId = stored?.id ?? `farm-${safeAnalysisId || "current"}`;
  const cropId = `crop-${String(summary.crop).toLowerCase()}`;
  const year = new Date(analysis?.createdAt ?? Date.now()).getUTCFullYear();
  const seasonId = currentUiContexts.get(summary.crop)?.cycleInput?.seasonId ??
    `season-${year}-${String(summary.crop).toLowerCase()}`;
  return { farmId, cropId, seasonId };
}

function harvestAssessmentKey(analysis) {
  const scope = currentFeatureScope(analysis);
  if (!scope) return null;
  return [scope.farmId, scope.cropId, scope.seasonId].join("::");
}

function readStoredHarvestAssessment(key) {
  if (typeof key !== "string" || key === "") return null;
  const raw = safeStorage()?.getItem(HARVEST_ASSESSMENTS_STORAGE_KEY);
  if (!raw || raw.length > HARVEST_ASSESSMENTS_MAX_BYTES) return null;
  try {
    return normalizeStoredHarvestAssessment(JSON.parse(raw)?.assessments?.[key]);
  } catch {
    return null;
  }
}

function writeStoredHarvestAssessment(key, assessment) {
  const storage = safeStorage();
  const safeAssessment = normalizeStoredHarvestAssessment(assessment);
  if (!storage || typeof key !== "string" || key === "" || !safeAssessment) return;
  let assessments = {};
  try {
    const raw = storage.getItem(HARVEST_ASSESSMENTS_STORAGE_KEY);
    const parsed = raw && raw.length <= HARVEST_ASSESSMENTS_MAX_BYTES
      ? JSON.parse(raw)
      : null;
    if (parsed?.version === 1 && parsed.assessments && typeof parsed.assessments === "object") {
      assessments = parsed.assessments;
    }
  } catch {
    assessments = {};
  }
  const serialized = JSON.stringify({
    version: 1,
    assessments: { ...assessments, [key]: safeAssessment },
  });
  if (serialized.length <= HARVEST_ASSESSMENTS_MAX_BYTES) {
    storage.setItem(HARVEST_ASSESSMENTS_STORAGE_KEY, serialized);
  }
}

function normalizeStoredHarvestAssessment(value) {
  const state = String(value?.state ?? "").toUpperCase();
  const quality = String(value?.quality ?? "").toUpperCase();
  const confidence = Number(value?.confidence);
  const suggestedDelayDays = Number(value?.suggestedDelayDays);
  const recheckInDays = Number(value?.recheckInDays);
  if (
    !["READY", "NOT_READY", "UNCERTAIN"].includes(state) ||
    !["USABLE", "UNUSABLE"].includes(quality) ||
    !Number.isFinite(confidence) || confidence < 0 || confidence > 1 ||
    !Number.isInteger(suggestedDelayDays) || suggestedDelayDays < 0 || suggestedDelayDays > 14 ||
    !Number.isInteger(recheckInDays) || recheckInDays < 1 || recheckInDays > 7
  ) {
    return null;
  }
  const visibleReasons = Array.isArray(value.visibleReasons)
    ? value.visibleReasons
        .filter((reason) => typeof reason === "string" && reason.trim())
        .map((reason) => reason.trim().slice(0, 120))
        .slice(0, 3)
    : [];
  if (visibleReasons.length === 0) return null;
  return {
    state,
    quality,
    confidence,
    suggestedDelayDays: state === "NOT_READY" && quality === "USABLE"
      ? suggestedDelayDays
      : 0,
    recheckInDays,
    visibleReasons,
    assessedAt: typeof value.assessedAt === "string" ? value.assessedAt : null,
  };
}

function actionDraftsFromAnalysis(analysis, scope) {
  const actions = Array.isArray(analysis?.actions)
    ? analysis.actions.filter((action) => actionRelevantForDisplay(action, analysis))
    : [];
  const forecastGuide = forecastRiskGuide(analysis);
  const irrigationGuide = irrigationActionGuide(analysis);
  return actions.slice(0, 5).flatMap((action, index) => {
    const title = userActionTitle(action, analysis);
    if (!title) return [];
    const projection = projectAnalysisAction(action, analysis);
    const practicalInstruction =
      action.actionId === "CHECK_SOIL_MOISTURE_AND_IRRIGATE" &&
      Array.isArray(irrigationGuide?.actions) &&
      irrigationGuide.actions.length > 0
        ? irrigationGuide.actions.slice(0, 2).join(" ")
        : action.actionId === "CHECK_CURRENT_FORECAST_RISK" &&
      Array.isArray(forecastGuide.actions) &&
      forecastGuide.actions.length > 0
        ? forecastGuide.actions.slice(0, 2).join(" ")
        : actionDetail(action.actionId, analysis) || title;
    return [{
      ruleId: projection.ruleId || `analysis-action-${index}`,
      draft: {
        ...scope,
        title,
        instruction: practicalInstruction,
        reason: actionReason(action, analysis),
        horizon: projection.horizon,
        dueAt: projection.dueAt,
        recheckAt: projection.recheckAt,
        evidenceRefs: projection.evidenceRefs,
        origin: "RULE",
      },
    }];
  });
}

function actionReason(action, analysis) {
  if (action?.actionId === "CONFIRM_SEASON") {
    return "재배 시기와 생육 단계가 확인되지 않아 작물별 시기 기준을 정확히 적용할 수 없습니다.";
  }
  if (action?.actionId === "CHECK_SOIL_MOISTURE_AND_IRRIGATE") {
    return irrigationActionGuide(analysis)?.reason ??
      "고온 예보와 최근 강수·증발산 수지에서 건조 경향이 함께 확인됐습니다.";
  }
  const weather = forecastRiskGuide(analysis);
  const soil = soilConditionGuide(analysis);
  if (weather.risk && actionHasForecastRisk(action, analysis)) {
    const reason =
      weather.reason ??
      weather.summary ??
      "예보 위험 규칙에서 확인된 행동입니다.";
    const cause = forecastRiskCause(analysis, action);
    return cause ? composeForecastActionReason(cause, reason) : reason;
  }
  if (soil.risk) return soil.reason || soil.summary || "토양 조건 확인이 필요한 행동입니다.";
  return resolveDisplayAction(analysis).detail || "현재 분석 근거에서 우선 확인할 행동입니다.";
}

function actionHasForecastRisk(action, analysis) {
  if (action?.actionId === "CHECK_CURRENT_FORECAST_RISK") return true;
  const triggerIds = new Set(
    (Array.isArray(action?.triggerIds) ? action.triggerIds : [])
      .filter((value) => typeof value === "string"),
  );
  return activeForecastRisks(analysis).some((risk) => triggerIds.has(risk.riskId));
}

function irrigationActionGuide(analysis) {
  const action = (analysis?.actions ?? []).find(
    (item) => item?.actionId === "CHECK_SOIL_MOISTURE_AND_IRRIGATE",
  );
  const moisture = fieldMoistureSummary(analysis);
  if (!action || !moisture) return null;
  const forecastHighs = forecastDisplayDays(analysis)
    .map((day) => day.maxTemperature)
    .filter(Number.isFinite);
  const hottest = forecastHighs.length ? Math.max(...forecastHighs) : null;
  const heatSummary = Number.isFinite(hottest)
    ? `최고 ${formatNumber(hottest)}℃의 고온 예보와`
    : "고온 예보와";
  const balanceDeficit = Math.abs(Math.min(moisture.cumulativeBalanceMm, 0));
  const cropLabel = CROP_LABELS[analysis?.inputSummary?.crop] ?? "작물";
  return {
    title: "고온 전 토양 수분 확인·관수",
    reason:
      `${heatSummary} 최근 ${moisture.dayCount}일 기상 수지의 건조 부족량 ` +
      `${formatNumber(balanceDeficit)}mm가 함께 확인됐습니다. ` +
      `토양 수분은 센서값이 아닌 기상 기반 지수 ${moisture.central}이므로, 현장에서 마른 상태를 확인한 뒤 물을 주세요.`,
    actions: [
      "오늘 아침이나 해가 진 뒤 뿌리 주변 10cm 안쪽 흙을 손으로 확인합니다.",
      `흙이 쉽게 부서지고 ${cropLabel}이 처져 있다면 한낮을 피해 기존 관수시설로 천천히 물을 공급합니다.`,
      "흙이 이미 젖었거나 물이 고이면 추가 관수를 멈추고 배수 상태를 먼저 확인합니다.",
    ],
  };
}

function projectedOpenActionPlan(analysis) {
  const primary = primaryDisplayAction(analysis);
  if (!primary) return { firstAction: null };
  try {
    const projection = projectAnalysisAction(primary, analysis);
    return {
      firstAction: {
        status: "OPEN",
        ruleId: projection.ruleId,
        evidenceRefs: projection.evidenceRefs,
      },
    };
  } catch {
    return { firstAction: null };
  }
}

function renderDashboardWorkspace(analysis) {
  const workspace = document.querySelector("#dashboard-workspace");
  if (!workspace) return;
  renderDashboardStatus(analysis);
  renderDashboardPriorityAction(analysis);
  renderDashboardRiskTimeline(analysis);
  renderDashboardWeeklyRisks(analysis, projectedOpenActionPlan(analysis));
  renderDashboardSoil(analysis);
  renderCropManagementView(analysis);
  renderPestInformationView(analysis);
  workspace.hidden = false;
}

function renderDashboardStatus(analysis) {
  const root = document.querySelector("#dashboard-status-summary");
  if (!root) return;
  const status = farmStatusSummary(analysis);
  const indicators = dashboardStatusIndicators(analysis);
  const displayAction = resolveDisplayAction(analysis);
  const summary = analysis?.inputSummary ?? {};
  const cropLabel = CROP_LABELS[summary.crop] ?? summary.crop ?? "작물";
  const badge = root.querySelector(".dashboard-state-badge");
  if (badge) {
    const badgeTone = status.label === "주의" ? "caution" : status.tone;
    badge.className = `dashboard-state-badge is-${badgeTone}`;
    badge.textContent = indicators.badge;
  }
  const growth = root.querySelector(".dashboard-growth-state");
  const growthLabel = root.querySelector("#dashboard-growth-state");
  const growthHelp = growth?.querySelector("p");
  if (growth) growth.dataset.state = status.tone;
  if (growthLabel) {
    growthLabel.textContent = Number.isFinite(status.score)
      ? `${status.score}점`
      : status.label;
    growthLabel.setAttribute(
      "aria-label",
      Number.isFinite(status.score)
        ? `현재 작물 생육점수 ${status.score}점, ${status.label}`
        : `현재 농장 상태 ${status.label}`,
    );
  }
  if (growthHelp) {
    growthHelp.textContent = ["danger", "caution"].includes(status.tone)
      ? "예방 관리가 필요한 상태입니다."
      : status.tone === "good"
        ? "현재 큰 위험 신호가 없습니다."
        : status.detail || indicators.summary;
  }
  indicators.axes.forEach(({ key, state, title, value: displayValue, help, tone }) => {
    const item = root.querySelector(`[data-dashboard-axis="${key}"]`);
    const titleNode = item?.querySelector("dt");
    const valueNode = item?.querySelector("dd");
    const helpNode = item?.querySelector("span");
    if (!item || !titleNode || !valueNode || !helpNode) return;
    item.className = `is-${tone}`;
    titleNode.textContent = title;
    valueNode.textContent = displayValue;
    helpNode.textContent = help;
    item.dataset.state = state ?? "UNKNOWN";
  });
  root.setAttribute("data-state", status.tone);
  root.setAttribute("aria-label", `${cropLabel} ${indicators.badge}. ${displayAction.title}`);
}

function dashboardStatusIndicators(analysis) {
  const days = forecastDisplayDays(analysis).slice(0, 7);
  const risks = activeForecastRisks(analysis);
  const soil = soilConditionGuide(analysis);
  const today = days[0] ?? null;
  const threshold = forecastTemperatureThreshold(analysis, risks, days);
  const riskyDayCount = days.filter((day) =>
    risks.some((risk) => riskCoversDate(risk, day.date))
  ).length;
  const firstRisk = risks[0] ?? null;
  const riskName = dashboardRiskName(firstRisk?.trigger?.metric);
  const todayTemperature = Number.isFinite(today?.maxTemperature)
    ? `${formatNumber(today.maxTemperature)}℃`
    : "자료 없음";
  const thresholdCopy = Number.isFinite(threshold?.value)
    ? `작물 기준 ${formatNumber(threshold.value)}℃`
    : "오늘 예보 기준";
  const todayHasRisk = Boolean(
    today && risks.some((risk) => riskCoversDate(risk, today.date)),
  );
  const soilPresentation = dashboardSoilIndicator(analysis, soil);
  const forecastState =
    analysis?.forecast?.result?.riskState ?? analysis?.forecast?.state;
  const forecastAvailable = ["READY", "COMPLETE", "PARTIAL"].includes(forecastState);
  const growthScore = analysis?.growthScore;
  const badge = Number.isFinite(growthScore?.score)
    ? growthScore.label
    : risks.length > 0
      ? "주의"
      : soil.tone === "caution"
        ? "점검 필요"
        : "양호";
  const summary = risks.length > 0
    ? `${riskyDayCount || 1}일간 ${riskName}에 주의하세요.`
    : soil.tone === "caution"
      ? "토양 상태를 점검하세요."
      : "현재 큰 위험 신호가 없습니다.";
  return {
    badge,
    summary,
    axes: [
      {
        key: "climate",
        state: analysis?.climate?.state,
        title: "날씨",
        value: todayTemperature,
        help: thresholdCopy,
        tone: todayHasRisk ? "caution" : Number.isFinite(today?.maxTemperature) ? "good" : "info",
      },
      soilPresentation,
      {
        key: "forecast",
        state: forecastState,
        title: "예보",
        value: forecastAvailable ? `${riskyDayCount}일` : "자료 없음",
        help: risks.length > 0 ? "주의가 예상되는 날짜" : "주의 날짜 없음",
        tone: risks.length > 0 ? "caution" : forecastAvailable ? "good" : "info",
      },
    ],
  };
}

function dashboardSoilIndicator(analysis, guide) {
  const soil = analysis?.soil;
  const basis = soil?.result?.measurementBasis;
  const phMetric = Array.isArray(soil?.result?.metrics)
    ? soil.result.metrics.find((metric) => metric?.metric === "PH")
    : null;
  if (["USER_SOIL_TEST", "PROVIDER_SOIL_TEST"].includes(basis)) {
    const measuredPh = String(guide.condition ?? "").match(/pH\s+([0-9.]+)/u)?.[1];
    return {
      key: "soil",
      state: soil?.state,
      title: "토양",
      value: measuredPh ? `pH ${measuredPh}` : "검사값",
      help: guide.tone === "caution" ? "작물 기준 밖 항목 있음" : "작물 기준 안",
      tone: guide.tone === "caution" ? "caution" : "good",
    };
  }
  if (basis === "REGIONAL_STATISTICS" && Number.isFinite(phMetric?.outsideRatio)) {
    return {
      key: "soil",
      state: soil?.state,
      title: "토양",
      value: formatPercent(phMetric.outsideRatio),
      help: "작물 pH 기준 밖 면적",
      tone: phMetric.outsideRatio > 0 ? "caution" : "good",
    };
  }
  if (soil?.state === "NOT_APPLICABLE") {
    return {
      key: "soil",
      state: soil.state,
      title: "토양",
      value: "양액",
      help: "시설 pH·EC로 관리",
      tone: "good",
    };
  }
  return {
    key: "soil",
    state: soil?.state,
    title: "토양",
    value: "자료 없음",
    help: "연결된 값 없음",
    tone: "info",
  };
}

function dashboardRiskName(metric) {
  return ({
    maxTemperature: "고온",
    minTemperature: "저온",
    precipitationProbability: "비",
    precipitation: "강수",
    precipitationAmount: "강수",
  })[metric] ?? "예보";
}

function renderCropManagementView(analysis) {
  const overview = document.querySelector("#crop-management-overview");
  if (!overview) return;
  renderCropManagementSwitcher(analysis);
  const summary = analysis?.inputSummary ?? {};
  const uiContext = currentUiContexts.get(summary.crop);
  const cropLabel = CROP_LABELS[summary.crop] ?? summary.crop ?? "작물";
  const regionLabel = summary.regionLabel?.trim() || "현재 농장";
  const status = farmStatusSummary(analysis);
  const displayAction = resolveDisplayAction(analysis);
  const stateLabel = ({
    danger: "집중 관리",
    caution: "주의 관리",
    good: "안정",
    loading: "확인 중",
    info: "참고",
  })[status.tone] ?? "확인";
  const title = overview.querySelector("#crop-management-overview-title");
  const state = overview.querySelector("#crop-management-state");
  if (title) title.textContent = `${regionLabel} · ${cropLabel}`;
  if (state) {
    state.className = `feature-status-chip is-${status.tone}`;
    state.textContent = stateLabel;
  }
  const stage = overview.querySelector("#crop-management-stage");
  const environment = overview.querySelector("#crop-management-environment");
  const season = overview.querySelector("#crop-management-season");
  if (stage) {
    stage.textContent = uiContext?.growthLabel ??
      GROWTH_LABELS[summary.growthStage] ??
      "단계 공통 관리";
  }
  if (environment) {
    environment.textContent = uiContext?.cultivationLabel ??
      CULTIVATION_LABELS[summary.cultivationMode] ??
      "재배 환경 확인";
  }
  if (season) {
    season.textContent = uiContext?.growthRecommended
      ? "날짜 기준 AI 예상"
      : summary.seasonLabel
        ? "선택한 재배 시기"
        : "날짜 기준 AI 예상";
  }
  const focusTitle = document.querySelector("#crop-management-focus-title");
  const focusCopy = document.querySelector("#crop-management-focus-copy");
  if (focusTitle) focusTitle.textContent = displayAction.title;
  if (focusCopy) focusCopy.textContent = displayAction.detail;
  const checklist = document.querySelector("#crop-management-checklist");
  if (!checklist) return;
  checklist.replaceChildren(
    ...managementChecklistItems(analysis).map((item, index) => {
      const card = element("article", "management-check-item");
      const number = element("span", "management-check-number", String(index + 1));
      const copy = element("div", "");
      copy.append(
        element("span", "management-check-label", item.label),
        element("strong", "", item.title),
        element("p", "", item.detail),
      );
      card.append(number, copy);
      return card;
    }),
  );
  renderCropCycleCard(analysis);
}

function renderCropManagementSwitcher(activeAnalysis) {
  const root = document.querySelector("#crop-management-switcher");
  if (!root) return;
  const analyses = [...currentAnalyses.values()].filter(Boolean);
  root.hidden = analyses.length === 0;
  root.replaceChildren(...analyses.map((analysis) => {
    const crop = analysis?.inputSummary?.crop;
    const button = element("button", "crop-management-switch-button");
    button.type = "button";
    button.textContent = CROP_LABELS[crop] ?? crop ?? "작물";
    const active = analysis?.analysisId === activeAnalysis?.analysisId;
    button.setAttribute("aria-pressed", String(active));
    button.addEventListener("click", () => {
      currentAnalysis = analysis;
      renderCropManagementView(analysis);
      renderPestInformationView(analysis);
      syncAssistantContext(analysis);
      document.querySelector("#crop-management-title")?.focus({ preventScroll: true });
    });
    return button;
  }));
}

function managementChecklistItems(analysis) {
  const indicators = dashboardStatusIndicators(analysis);
  const climate = indicators.axes.find((axis) => axis.key === "climate");
  const soil = indicators.axes.find((axis) => axis.key === "soil");
  const pestGuidance = pestGuidanceByAnalysis.get(analysis?.analysisId);
  const observation = pestGuidance?.observations?.[0] ?? {
    part: "작물 관찰",
    guidance: "병해충 관찰 기준을 불러오는 중입니다.",
  };
  return [
    {
      label: "날씨 대응",
      title: `${climate?.value ?? "자료 없음"} · ${climate?.help ?? "예보 확인"}`,
      detail: indicators.summary,
    },
    {
      label: "토양·물 관리",
      title: `${soil?.title ?? "토양"} ${soil?.value ?? "자료 없음"}`,
      detail: soilConditionGuide(analysis).condition,
    },
    {
      label: "작물 관찰",
      title: observation.part,
      detail: observation.guidance,
    },
  ];
}

function renderPestInformationView(analysis, { requestGuidance = true } = {}) {
  const overview = document.querySelector("#pest-alert-overview");
  if (!overview) return;
  const crop = analysis?.inputSummary?.crop;
  const cropLabel = CROP_LABELS[crop] ?? crop ?? "작물";
  const groupedRisks = groupWeeklyRiskRanges(activeForecastRisks(analysis));
  const alertCount = groupedRisks.length;
  const state = overview.querySelector("#pest-alert-state");
  const title = overview.querySelector("#pest-alert-overview-title");
  const summary = overview.querySelector("#pest-alert-summary");
  const navCount = document.querySelector("#pest-nav-count");
  if (state) {
    state.className = `feature-status-chip ${alertCount > 0 ? "is-caution" : "is-good"}`;
    state.textContent = alertCount > 0 ? `예방 점검 ${alertCount}건` : "현재 경보 없음";
  }
  if (title) {
    title.textContent = alertCount > 0
      ? `${cropLabel}의 기상 연계 예방 점검`
      : `${cropLabel}의 긴급 기상 신호는 없습니다.`;
  }
  if (summary) {
    summary.textContent = alertCount > 0
      ? "기상 위험이 병해충 발생을 뜻하지는 않습니다. 아래 날짜 전에 작물의 이상 징후를 먼저 확인하세요."
      : "병해충이 없다고 확정한 결과는 아닙니다. 아래 관찰 항목으로 작물 변화를 꾸준히 확인하세요.";
  }
  if (navCount) {
    navCount.textContent = String(Math.min(alertCount, 9));
    navCount.hidden = alertCount === 0;
  }
  const signalRoot = document.querySelector("#pest-weather-signals");
  if (signalRoot) {
    signalRoot.replaceChildren(
      ...(alertCount > 0
        ? groupedRisks.map((risk) => {
            const severity = risk.severity === "WARNING" ? "danger" : "caution";
            const dateLabel = risk.dateRange.from === risk.dateRange.to
              ? formatExplicitForecastDate(risk.dateRange.from)
              : `${formatExplicitForecastDate(risk.dateRange.from)}–${formatExplicitForecastDate(risk.dateRange.to)}`;
            const guide = risk.guidance ?? {};
            const card = element("article", `pest-signal-card is-${severity}`);
            card.append(
              element("span", "pest-signal-date", dateLabel),
              element("strong", "", guide.headline ?? riskTriggerSummary(risk)),
              element("p", "", guide.reason ?? riskTriggerSummary(risk)),
            );
            return card;
          })
        : [
            (() => {
              const card = element("article", "pest-signal-card is-good");
              card.append(
                element("span", "pest-signal-date", "앞으로 7일"),
                element("strong", "", "긴급 기상 위험 신호 없음"),
                element("p", "", "정기 관찰은 계속하고 새 증상이 보이면 사진과 발생 위치를 기록하세요."),
              );
              return card;
            })(),
          ]),
    );
  }
  const observationRoot = document.querySelector("#pest-observation-list");
  if (!observationRoot) return;
  const guidance = pestGuidanceByAnalysis.get(analysis?.analysisId);
  const observations = guidance?.observations ?? [];
  if (observations.length === 0) {
    observationRoot.replaceChildren(
      element("p", "feature-empty", "검수된 작물 관찰 기준을 불러오고 있습니다."),
    );
    if (requestGuidance) void refreshPestGuidance(analysis);
    return;
  }
  observationRoot.replaceChildren(
    ...observations.map(({ part, guidance: observationGuide }, index) => {
      const card = element("article", "pest-observation-card");
      const copy = element("div", "");
      copy.append(
        element("strong", "", part),
        element("p", "", observationGuide),
      );
      card.append(
        element("span", "pest-observation-icon", String(index + 1)),
        copy,
      );
      return card;
    }),
  );
  const sourceNote = document.querySelector("#pest-source-note");
  const sourceLink = document.querySelector("#pest-source-link");
  if (sourceNote) {
    sourceNote.textContent = guidance.liveOccurrenceState === "NOT_CONNECTED"
      ? "검수 가이드 적용 · 실시간 지역 발생정보는 아직 연결 전"
      : "검수 가이드와 지역 발생정보 적용";
  }
  if (sourceLink && guidance.source?.sourceUrl) {
    sourceLink.href = guidance.source.sourceUrl;
    sourceLink.hidden = false;
  }
}

function refreshPestGuidance(analysis, options = {}) {
  const analysisId = analysis?.analysisId;
  if (!connected || !analysisId || pestGuidanceByAnalysis.has(analysisId)) {
    return Promise.resolve();
  }
  const pending = pestGuidanceRequests.get(analysisId);
  if (pending) return pending;
  const request = requestPestGuidance(analysis, options).finally(() => {
    if (pestGuidanceRequests.get(analysisId) === request) {
      pestGuidanceRequests.delete(analysisId);
    }
  });
  pestGuidanceRequests.set(analysisId, request);
  return request;
}

async function requestPestGuidance(
  analysis,
  { refreshExpiredAnalysis = true } = {},
) {
  const analysisId = analysis.analysisId;
  const requestedCrop = analysis?.inputSummary?.crop;
  try {
    const guidance = await api.getPestGuidance(analysisId);
    pestGuidanceByAnalysis.set(analysisId, guidance);
    if (currentAnalysis?.analysisId === analysisId) {
      renderPestInformationView(analysis, { requestGuidance: false });
      renderCropManagementView(analysis);
    }
  } catch (error) {
    if (
      error?.code === "ANALYSIS_NOT_FOUND" &&
      refreshExpiredAnalysis &&
      currentAnalysis?.analysisId === analysisId
    ) {
      const saved = readStoredSession();
      const locationReady = selectedCandidate ||
        await prepareStoredLocationCandidate(saved?.region);
      pendingAttempt = null;
      const refreshed = locationReady && await submitAnalysis();
      const refreshedAnalysis = selectPestRecoveryAnalysis(
        currentAnalyses,
        requestedCrop,
      );
      if (
        refreshed &&
        refreshedAnalysis?.analysisId &&
        refreshedAnalysis.analysisId !== analysisId
      ) {
        activateCropAnalysis(refreshedAnalysis);
        await refreshPestGuidance(refreshedAnalysis, {
          refreshExpiredAnalysis: false,
        });
        return;
      }
      if (currentAnalysis?.analysisId !== analysisId) {
        currentAnalyses.set(String(requestedCrop).toUpperCase(), analysis);
        activateCropAnalysis(analysis);
      }
    }

    const activeAnalysis = currentAnalysis?.analysisId === analysisId
      ? currentAnalysis
      : analysis;
    const fallback = buildReviewedPestObservationFallback(
      activeAnalysis?.inputSummary?.crop,
      { analysisId: activeAnalysis?.analysisId ?? analysisId },
    );
    if (!fallback) return;
    pestGuidanceByAnalysis.set(fallback.analysisId, fallback);
    if (currentAnalysis?.analysisId === fallback.analysisId) {
      renderPestInformationView(currentAnalysis, { requestGuidance: false });
      renderCropManagementView(currentAnalysis);
    }
  }
}

function renderDashboardPriorityAction(analysis) {
  const root = document.querySelector("#dashboard-priority-action");
  const actionList = document.querySelector("#dashboard-action-list");
  const mobileSummary = document.querySelector("#dashboard-mobile-action-summary");
  if (!root) return;
  currentActionPlan = null;
  actionPlanBusy = false;
  const batchStatus = document.querySelector("#dashboard-action-batch-status");
  if (batchStatus) {
    batchStatus.hidden = true;
    batchStatus.classList.remove("is-error");
    batchStatus.textContent = "";
  }
  const displayAction = resolveDisplayAction(analysis);
  const primary = primaryDisplayAction(analysis);
  let projection = null;
  try {
    projection = primary ? projectAnalysisAction(primary, analysis) : null;
  } catch {
    projection = null;
  }
  const copy = element("div", "dashboard-priority-copy");
  copy.append(
    element("span", "dashboard-priority-badge", displayAction.status),
    element("h3", "", displayAction.title),
    element("p", "", displayAction.detail),
  );
  if (Array.isArray(displayAction.actions) && displayAction.actions.length > 0) {
    copy.append(actionStepList(displayAction.actions.slice(0, 3), "dashboard-priority-steps"));
  }
  const timing = element("dl", "dashboard-priority-timing");
  const dueLabel = projection?.dueAt
    ? formatActionDueLabelForAction({
        status: "OPEN",
        ruleId: projection.ruleId,
        createdAt: analysis?.createdAt,
        dueAt: projection.dueAt,
      })
    : null;
  if (projection?.dueAt) {
    appendDefinition(timing, "기한", dueLabel);
  }
  if (projection?.recheckAt) {
    appendDefinition(timing, "재확인", formatDateTime(projection.recheckAt));
  }
  const evidenceButton = element(
    "button",
    "button button-secondary dashboard-priority-evidence",
    "이유와 근거 보기",
  );
  evidenceButton.type = "button";
  evidenceButton.addEventListener("click", () => openEvidenceDialog());
  const row = element("div", "dashboard-action-row");
  const check = element("span", "dashboard-action-check", "");
  check.setAttribute("aria-hidden", "true");
  row.append(check, copy);
  copy.append(timing, evidenceButton);
  root.replaceChildren(row);
  root.hidden = false;
  if (mobileSummary) {
    mobileSummary.replaceChildren(
      element(
        "strong",
        "",
        dueLabel ? dueSummaryLabel(dueLabel) : "오늘 확인",
      ),
      element("span", "", displayAction.title),
    );
    mobileSummary.hidden = false;
  }
  const count = document.querySelector(".dashboard-actions .dashboard-count");
  if (count) {
    count.textContent = "준비 중";
    count.setAttribute("aria-label", "할 일 준비 중");
  }
  if (actionList) {
    actionList.replaceChildren(
      element("p", "dashboard-action-loading", "오늘 할 일을 불러오고 있습니다."),
    );
  }
}

function renderMobileActionPlanSummary(plan) {
  const root = document.querySelector("#dashboard-mobile-action-summary");
  const firstAction = plan?.firstAction;
  if (!root) return;
  if (
    firstAction?.status !== "OPEN" ||
    firstAction?.horizon !== "TODAY"
  ) {
    root.replaceChildren();
    root.hidden = true;
    return;
  }
  const dueLabel = formatActionDueLabelForAction(firstAction);
  root.replaceChildren(
    element(
      "strong",
      "",
      dueSummaryLabel(dueLabel),
    ),
    element("span", "", firstAction.title),
  );
  root.hidden = false;
}

function dueSummaryLabel(label) {
  return label === "지금 확인" || label.startsWith("지연됨")
    ? label
    : `${label}까지`;
}

function renderDashboardRiskTimeline(analysis) {
  const root = document.querySelector("#dashboard-forecast-chart");
  const detailRoot = document.querySelector("#dashboard-forecast-detail-chart");
  if (!root || !detailRoot) return;
  const days = forecastDisplayDays(analysis).slice(0, 7);
  const risks = activeForecastRisks(analysis);
  if (days.length === 0) {
    root.replaceChildren(
      element("p", "dashboard-empty-state", "예보를 다시 확인해 주세요."),
    );
    detailRoot.replaceChildren(
      element("p", "dashboard-empty-state", "표시할 예보 그래프가 없습니다."),
    );
    return;
  }
  const list = element("ol", "dashboard-risk-track");
  list.setAttribute("aria-label", "7일 작물 위험 변화");
  days.forEach((day) => {
    const dayRisks = risks.filter((risk) => riskCoversDate(risk, day.date));
    const outlook = forecastDailyOutlook(analysis, day, dayRisks);
    const severity = outlook.className;
    const item = element("li", `dashboard-risk-day is-${severity}`);
    const dateParts = dashboardDateParts(day.date);
    const time = element("time", "", "");
    time.dateTime = day.date;
    time.append(
      element("span", "dashboard-risk-date", dateParts.date),
      element(
        "span",
        `dashboard-risk-weekday${dateParts.isSunday ? " is-sunday" : ""}`,
        dateParts.weekday,
      ),
    );
    item.append(
      time,
      element("i", "dashboard-risk-marker", ""),
      element(
        "strong",
        "",
        outlook.label,
      ),
      element(
        "span",
        "",
        Number.isFinite(day.maxTemperature)
          ? `최고 ${formatNumber(day.maxTemperature)}℃`
          : "기온 자료 없음",
      ),
    );
    list.append(item);
  });
  const threshold = forecastTemperatureThreshold(analysis, risks, days);
  root.replaceChildren(list);
  detailRoot.replaceChildren(
    forecastChartLegend(threshold),
    temperatureRangeChart(days, threshold),
    forecastRiskLevelRow(days, risks, analysis),
  );
}

function forecastDailyOutlook(analysis, day, dayRisks) {
  const outlooks = analysis?.forecast?.result?.dailyOutlooks;
  const level = Array.isArray(outlooks)
    ? outlooks.find((item) => item?.date === day.date)?.level
    : null;
  const byLevel = {
    DANGER: { className: "danger", label: "위험" },
    CAUTION: { className: "caution", label: "주의" },
    NORMAL: { className: "normal", label: "보통" },
    FAVORABLE: { className: "favorable", label: "양호" },
    UNKNOWN: { className: "unknown", label: "정보 없음" },
  };
  if (byLevel[level]) return byLevel[level];
  if (dayRisks.some((risk) => risk.severity === "WARNING")) {
    return byLevel.DANGER;
  }
  if (dayRisks.length > 0) return byLevel.CAUTION;
  return byLevel.NORMAL;
}

function dashboardDateParts(value) {
  const parsed = new Date(`${String(value)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return { date: String(value), weekday: "", isSunday: false };
  }
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  return {
    date: `${parsed.getUTCMonth() + 1}.${parsed.getUTCDate()}`,
    weekday: weekdays[parsed.getUTCDay()],
    isSunday: parsed.getUTCDay() === 0,
  };
}

function renderDashboardWeeklyRisks(analysis, actionPlan = null) {
  const root = document.querySelector("#dashboard-weekly-risks");
  if (!root) return;
  const allRisks = activeForecastRisks(analysis);
  const visibleRisks = filterWeeklyRisksForOpenAction(allRisks, actionPlan);
  const risks = groupWeeklyRiskRanges(visibleRisks)
    .map((risk) => {
      const guide = risk?.guidance ?? {};
      return {
        severity: risk.severity,
        headline: guide.headline ?? riskTriggerSummary(risk),
        reason: guide.reason ?? riskTriggerSummary(risk),
        from: risk.dateRange.from,
        to: risk.dateRange.to,
      };
    });
  if (risks.length === 0) {
    root.querySelector(".dashboard-loading-copy")?.remove();
    root.querySelector(".dashboard-weekly-list")?.remove();
    root.append(
      element(
        "p",
        "dashboard-loading-copy is-good",
        allRisks.length > 0
          ? "오늘 할 일 외 추가 주의 없음"
          : "현재 예보 범위에서 확인된 주의 신호가 없습니다.",
      ),
    );
    return;
  }
  const list = element("ol", "dashboard-weekly-list");
  risks.forEach((risk) => {
    const item = element(
      "li",
      `dashboard-weekly-item is-${risk.severity === "WARNING" ? "danger" : "caution"}`,
    );
    const copy = element("div", "");
    const dateLabel = risk.from === risk.to
      ? formatExplicitForecastDate(risk.from)
      : `${formatExplicitForecastDate(risk.from)}–${formatExplicitForecastDate(risk.to)}`;
    copy.append(
      element("span", "", dateLabel),
      element("strong", "", risk.headline),
      element("p", "", risk.reason),
    );
    const guideButton = element(
      "button",
      "dashboard-risk-guide-button",
      "대응 가이드",
    );
    guideButton.type = "button";
    guideButton.setAttribute(
      "aria-label",
      `${dateLabel} ${risk.headline} 대응 가이드 보기`,
    );
    guideButton.addEventListener("click", () => openEvidenceDialog("weather"));
    item.append(copy, guideButton);
    list.append(item);
  });
  root.querySelector(".dashboard-loading-copy")?.remove();
  root.querySelector(".dashboard-weekly-list")?.remove();
  root.append(list);
}

function renderDashboardSoil(analysis) {
  const root = document.querySelector("#dashboard-soil-summary");
  if (!root) return;
  const placeholder = root.querySelector(".dashboard-soil-placeholder");
  const badge = root.querySelector(".dashboard-data-badge");
  const measurementBasis = analysis?.soil?.result?.measurementBasis;
  const title = root.querySelector("#dashboard-soil-summary-title");
  if (title) title.textContent = "토양 상태";
  if (badge) {
    badge.textContent = ["USER_SOIL_TEST", "PROVIDER_SOIL_TEST"].includes(measurementBasis)
      ? "내 밭 검사값"
      : "내 밭 검사값 아님";
    badge.hidden = true;
  }
  if (placeholder) {
    placeholder.className = "dashboard-soil-placeholder is-metric-grid";
    placeholder.replaceChildren(
      ...dashboardSoilMetricItems(analysis).map((item) => {
        const metric = element(
          "div",
          `dashboard-soil-metric${item.available ? "" : " is-muted"}`,
        );
        metric.setAttribute(
          "aria-label",
          `${item.label} ${item.value}, ${item.help}`,
        );
        metric.append(
          element("span", "", item.label),
          element("strong", "", item.value),
          element("small", "", item.help),
        );
        return metric;
      }),
    );
  }
  root.querySelector(".dashboard-soil-test-link")?.remove();
  if (analysisHasMissingSoilExamHistory(analysis)) {
    const serviceButton = element(
      "button",
      "button button-secondary dashboard-soil-test-link",
      "무료 토양검정 받기",
    );
    serviceButton.type = "button";
    serviceButton.addEventListener("click", () => {
      document.dispatchEvent(
        new CustomEvent("heuknalssi:show-services", {
          detail: { targetId: "soil-exam-title" },
        }),
      );
    });
    serviceButton.classList.add("dashboard-soil-test-link");
    const details = root.querySelector(".dashboard-text-button");
    root.insertBefore(serviceButton, details ?? null);
  }
}

function dashboardSoilMetricItems(analysis) {
  const soil = analysis?.soil;
  const result = soil?.result ?? {};
  const basis = result.measurementBasis;
  const userMeasured = result.userSoilTest ?? {};
  const providerMeasurements = new Map(
    (result.providerSoilTest?.measurements ?? []).map((item) => [
      item.metric,
      item.value,
    ]),
  );
  const measuredValue = (metric) => {
    if (basis === "USER_SOIL_TEST") {
      return userMeasured[SOIL_METRIC_FIELDS[metric]];
    }
    if (basis === "PROVIDER_SOIL_TEST") {
      return providerMeasurements.get(metric);
    }
    return null;
  };
  const phMetric = Array.isArray(result.metrics)
    ? result.metrics.find((metric) => metric?.metric === "PH")
    : null;
  const measuredPh = measuredValue("PH");
  const measuredEc = measuredValue("EC");
  const regionalPh = basis === "REGIONAL_STATISTICS" &&
    Number.isFinite(phMetric?.outsideRatio)
    ? formatPercent(phMetric.outsideRatio)
    : null;
  const actualBasis = ["USER_SOIL_TEST", "PROVIDER_SOIL_TEST"].includes(basis);
  const moisture = fieldMoistureSummary(analysis);

  return [
    {
      label: "수분",
      value: moisture ? `지수 ${moisture.central}` : "—",
      help: moisture ? `${moisture.trendLabel} · 기상 추정` : "추정 자료 없음",
      available: Boolean(moisture),
    },
    {
      label: "EC",
      value: Number.isFinite(measuredEc) ? `${formatNumber(measuredEc)} dS/m` : "—",
      help: Number.isFinite(measuredEc) ? "검사값" : actualBasis ? "검사값 없음" : "검사 필요",
      available: Number.isFinite(measuredEc),
    },
    {
      label: "pH",
      value: Number.isFinite(measuredPh) ? formatNumber(measuredPh) : regionalPh ?? "—",
      help: Number.isFinite(measuredPh)
        ? "검사값"
        : regionalPh
          ? "지역 기준 밖 면적"
          : "검사 필요",
      available: Number.isFinite(measuredPh) || Boolean(regionalPh),
    },
    {
      label: "온도",
      value: "—",
      help: "미측정",
      available: false,
    },
  ];
}

function fieldMoistureSummary(analysis) {
  const estimate = analysis?.fieldConditionsEstimate;
  const moisture = estimate?.surfaceMoisture;
  if (
    !["READY", "PARTIAL"].includes(estimate?.state) ||
    !Number.isFinite(moisture?.central) ||
    !Number.isFinite(moisture?.cumulativeBalanceMm)
  ) {
    return null;
  }
  const trendLabels = {
    DRYING: "건조 경향",
    WETTING: "습윤 경향",
    STABLE: "변화 적음",
  };
  return {
    central: Math.round(moisture.central),
    lower: Number.isFinite(moisture.lower) ? Math.round(moisture.lower) : null,
    upper: Number.isFinite(moisture.upper) ? Math.round(moisture.upper) : null,
    cumulativeBalanceMm: moisture.cumulativeBalanceMm,
    dayCount: moisture.window?.dayCount ?? estimate.inputsUsed?.recentWeatherDayCount ?? 0,
    trend: moisture.trend,
    trendLabel: trendLabels[moisture.trend] ?? "기상 추정",
    confidence: estimate.confidence?.score ?? null,
  };
}

function renderFarmConditionGuide(analysis, idSuffix = "dashboard") {
  const guide = element("section", "farm-condition-guide");
  const titleId = `farm-condition-guide-title-${idSuffix}`;
  const missingSoilExamHistory = analysisHasMissingSoilExamHistory(analysis);
  guide.setAttribute("aria-labelledby", titleId);
  const weather = forecastRiskGuide(analysis);
  const soil = soilConditionGuide(analysis);
  const regional = isRegionalReferenceAnalysis(analysis);
  const header = element("div", "farm-condition-guide-header");
  const headerCopy = element("div");
  const title = element("h2", "", "토양·날씨 종합 가이드");
  title.id = titleId;
  headerCopy.append(
    element("span", "farm-condition-kicker", "농장 상태에 필요한 안내"),
    title,
    element(
      "p",
      "farm-condition-summary",
      combinedGuideSummary(weather, soil),
    ),
  );
  header.append(
    headerCopy,
    element(
      "span",
      `farm-condition-status ${weather.risk ? "is-caution" : ""}`.trim(),
      weather.risk
        ? "주의 항목 있음"
        : regional
          ? "지역 분석 완료"
          : "분석 완료",
    ),
  );

  const facts = element("div", "farm-condition-facts");
  facts.append(
    conditionFactCard("날씨", weather, "weather", { hideCaveat: regional }),
    conditionFactCard("농장 토양", soil, "soil", { hideCaveat: regional }),
  );

  const actionBox = element(
    "section",
    "farm-condition-actions action-priority-card",
  );
  actionBox.dataset.guideSection = "summary";
  const combinedActions = uniqueText([
    ...weather.actions,
    ...soil.actions,
  ]).slice(0, 3);
  actionBox.append(
    element("span", "farm-condition-action-kicker", "가장 중요한 안내"),
    element("h3", "", "오늘 바로 할 일"),
    actionStepList(combinedActions, "farm-condition-action-list"),
  );
  if (weather.recheck) {
    const recheck = element("p", "farm-condition-recheck");
    recheck.append(
      element("strong", "", "다시 확인할 때 "),
      document.createTextNode(weather.recheck),
    );
    actionBox.append(recheck);
  }
  const verificationActions = uniqueText([
    ...(weather.verificationActions ?? []),
    ...(soil.verificationActions ?? []),
  ]);
  if (verificationActions.length) {
    const verification = element("details", "farm-condition-verification");
    const body = element("div", "farm-condition-verification-body");
    body.append(
      actionStepList(
        verificationActions,
        "farm-condition-verification-list",
      ),
    );
    verification.append(
      element("summary", "", "정확도를 높이는 방법"),
      body,
    );
    actionBox.append(verification);
  }
  guide.append(header, actionBox, facts);
  if (missingSoilExamHistory) {
    const callout = element("section", "soil-exam-service-callout");
    const copy = element("div", "soil-exam-service-copy");
    const copyId = `soil-exam-service-copy-${idSuffix}`;
    copy.id = copyId;
    copy.append(
      element("span", "soil-exam-service-kicker", "토양 정보 보완"),
      element("h3", "", "최근 토양검정 이력 없음"),
      element(
        "p",
        "",
        "이 필지는 공공 토양검정 조회에서 최근 화학성 결과를 찾지 못했습니다. 무료 검사를 받으면 실제 밭의 pH와 EC를 다음 분석에 반영할 수 있습니다.",
      ),
    );
    const serviceButton = element(
      "button",
      "button button-primary soil-exam-service-button",
      "무료 토양검정 받으러 가기",
    );
    serviceButton.type = "button";
    serviceButton.setAttribute("aria-describedby", copyId);
    serviceButton.addEventListener("click", () => {
      document.dispatchEvent(
        new CustomEvent("heuknalssi:show-services", {
          detail: { targetId: "soil-exam-title" },
        }),
      );
    });
    callout.append(copy, serviceButton);
    guide.append(callout);
  }
  return guide;
}

function conditionFactCard(label, guide, section, { hideCaveat = false } = {}) {
  const fullReason =
    typeof guide.reason === "string" ? guide.reason.trim() : "";
  const summaryReason = conditionFactSummary(fullReason);
  const card = element(
    "article",
    `condition-fact-card ${guide.tone ? `is-${guide.tone}` : ""}`.trim(),
  );
  if (section) card.dataset.guideSection = section;
  card.append(
    element("span", "condition-fact-label", label),
    element("strong", "condition-fact-title", guide.condition),
    element(
      "h3",
      "",
      guide.tone === "good"
        ? "분석 결과"
        : guide.tone === "unknown"
          ? "현재 분석 범위"
          : "왜 주의해야 하나요",
    ),
    element("p", "condition-fact-summary", summaryReason),
  );
  const details = element("details", "condition-fact-details");
  const detailsBody = element("div", "condition-fact-details-body");
  if (fullReason && fullReason !== summaryReason) {
    detailsBody.append(
      element("p", "condition-fact-full-reason", fullReason),
    );
  }
  if (guide.caveat && !hideCaveat) {
    detailsBody.append(element("p", "condition-fact-caveat", guide.caveat));
  }
  if (isSafeHttpUrl(guide.sourceUrl)) {
    const link = element("a", "condition-source-link", "검수 출처");
    link.href = guide.sourceUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    detailsBody.append(link);
  }
  if (detailsBody.childNodes.length > 0) {
    details.append(
      element("summary", "", "근거와 한계"),
      detailsBody,
    );
    card.append(details);
  }
  return card;
}

function conditionFactSummary(reason) {
  if (!reason) return "현재 확인 가능한 근거를 정리하고 있습니다.";
  const firstSentence = reason.match(/^.*?[.!?](?:\s|$)/u)?.[0]?.trim();
  const summary = firstSentence || reason;
  return summary.length > 110 ? `${summary.slice(0, 107).trim()}…` : summary;
}

function actionStepList(actions, className) {
  const safeActions = Array.isArray(actions)
    ? actions.filter((action) => typeof action === "string" && action.trim())
    : [];
  if (safeActions.length === 0) return document.createDocumentFragment();
  const list = element("ol", className);
  safeActions.forEach((action) => {
    list.append(element("li", "", action));
  });
  return list;
}

function combinedGuideSummary(weather, soil) {
  if (weather.regional && soil.ready) {
    return weather.risk
      ? "지역 예보와 지역 토양 통계를 함께 분석해 우선 행동을 정리했습니다."
      : "지역 예보와 지역 토양 통계를 기준으로 현재 적용할 주의 신호와 행동을 분석했습니다.";
  }
  const forecastScope = weather.regional
    ? "시·군 대표 예보와 "
    : "농장 위치 예보와 ";
  if (weather.risk && soil.ready) {
    return `${forecastScope}지역 토양 분포를 함께 반영했습니다. 실제 밭의 토양검정값으로 최종 확인이 필요합니다.`;
  }
  if (weather.risk) {
    return `${forecastScope.replace("와 ", "에서 ")}위험은 확인됐습니다. 토양값은 확인되지 않아 토양 상태를 추정하지 않고 필요한 확인 절차를 함께 표시합니다.`;
  }
  if (soil.ready) {
    return "현재 확인된 예보 위험은 없으며 지역 토양 분포와 실제 밭의 차이를 함께 확인합니다.";
  }
  return "날씨와 토양 중 확인되지 않은 값은 추정하지 않습니다. 연결된 자료와 필요한 다음 확인을 구분해 표시합니다.";
}

function forecastDisplayDays(analysis) {
  const days = analysis?.forecast?.result?.mergedDisplayDays;
  return Array.isArray(days)
    ? days.filter(
        (day) =>
          day &&
          typeof day.date === "string" &&
          ["SHORT_GRID", "MID_REGIONAL"].includes(day.sourceType),
      )
    : [];
}

function temperatureRangeChart(days, threshold = null) {
  const svgNamespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("class", "forecast-temperature-chart");
  svg.setAttribute("viewBox", "0 0 640 138");
  svg.setAttribute("role", "img");
  const highs = days.map((day) =>
    Number.isFinite(day.maxTemperature) ? day.maxTemperature : null,
  );
  const lows = days.map((day) =>
    Number.isFinite(day.minTemperature) ? day.minTemperature : null,
  );
  const precipitation = days.map((day) =>
    Number.isFinite(day.precipitationProbability)
      ? day.precipitationProbability
      : null,
  );
  const available = [...highs, threshold?.value].filter(Number.isFinite);
  svg.setAttribute(
    "aria-label",
    available.length
      ? `최고기온과 강수확률 흐름. 최고기온 ${highs
          .filter(Number.isFinite)
          .map((value) => `${formatNumber(value)}도`)
          .join(", ")}, 최저기온 ${lows
          .filter(Number.isFinite)
          .map((value) => `${formatNumber(value)}도`)
          .join(", ")}, 강수확률 ${precipitation
          .filter(Number.isFinite)
          .map((value) => `${formatNumber(value)}퍼센트`)
          .join(", ")}${
            Number.isFinite(threshold?.value)
              ? `, 작물 주의 기준 ${formatNumber(threshold.value)}도`
              : ""
          }`
      : "기온 자료 없음",
  );
  if (available.length === 0) return svg;
  const minimum = Math.min(...available);
  const maximum = Math.max(...available);
  const span = Math.max(maximum - minimum, 4);
  const xFor = (index) =>
    days.length === 1 ? 320 : 28 + (index * 584) / (days.length - 1);
  const temperaturePointFor = (value, index) => {
    if (!Number.isFinite(value)) return null;
    const x = xFor(index);
    const y = 72 - ((value - minimum) / span) * 38;
    return { x, y, value, index };
  };
  const precipitationPointFor = (value, index) => {
    if (!Number.isFinite(value)) return null;
    return {
      x: xFor(index),
      y: 121 - (Math.min(Math.max(value, 0), 100) / 100) * 43,
      value,
      index,
    };
  };
  const highPoints = highs.map(temperaturePointFor);
  const precipitationPoints = precipitation.map(precipitationPointFor);

  const baseline = document.createElementNS(svgNamespace, "line");
  baseline.setAttribute("class", "forecast-chart-baseline");
  baseline.setAttribute("x1", "12");
  baseline.setAttribute("x2", "628");
  baseline.setAttribute("y1", "126");
  baseline.setAttribute("y2", "126");
  svg.append(baseline);

  if (Number.isFinite(threshold?.value)) {
    const thresholdY = 72 - ((threshold.value - minimum) / span) * 38;
    const thresholdLine = document.createElementNS(svgNamespace, "line");
    thresholdLine.setAttribute("class", "risk-threshold-line");
    thresholdLine.setAttribute("x1", "12");
    thresholdLine.setAttribute("x2", "628");
    thresholdLine.setAttribute("y1", String(thresholdY));
    thresholdLine.setAttribute("y2", String(thresholdY));
    const thresholdLabel = document.createElementNS(svgNamespace, "text");
    thresholdLabel.setAttribute("class", "risk-threshold-label");
    thresholdLabel.setAttribute("x", "626");
    thresholdLabel.setAttribute("y", String(Math.max(thresholdY - 5, 12)));
    thresholdLabel.setAttribute("text-anchor", "end");
    thresholdLabel.textContent =
      `주의 기준 ${formatNumber(threshold.value)}°`;
    svg.append(thresholdLine, thresholdLabel);
  }

  [
    ["temperature-line is-high", highPoints],
    ["precipitation-probability-line", precipitationPoints],
  ].forEach(([className, points]) => {
    const visible = points.filter(Boolean);
    if (visible.length === 0) return;
    const polyline = document.createElementNS(svgNamespace, "polyline");
    polyline.setAttribute("class", className);
    polyline.setAttribute(
      "points",
      visible.map(({ x, y }) => `${x},${y}`).join(" "),
    );
    svg.append(polyline);
  });

  highPoints.filter(Boolean).forEach(({ x, y, value, index }) => {
    const point = document.createElementNS(svgNamespace, "circle");
    point.setAttribute("class", "temperature-point is-high");
    point.setAttribute("cx", String(x));
    point.setAttribute("cy", String(y));
    point.setAttribute("r", "4");
    const valueLabel = document.createElementNS(svgNamespace, "text");
    valueLabel.setAttribute("class", "temperature-value-label");
    valueLabel.setAttribute("x", String(x));
    valueLabel.setAttribute("y", String(Math.max(y - 9, 12)));
    valueLabel.setAttribute("text-anchor", "middle");
    valueLabel.textContent = `${formatNumber(value)}°`;
    const title = document.createElementNS(svgNamespace, "title");
    title.textContent = `${formatForecastDate(days[index].date)} 최고 ${formatNumber(value)}℃${
      Number.isFinite(lows[index])
        ? `, 최저 ${formatNumber(lows[index])}℃`
        : ""
    }`;
    point.append(title);
    svg.append(point, valueLabel);
  });

  precipitationPoints.filter(Boolean).forEach(({ x, y, value }) => {
    const point = document.createElementNS(svgNamespace, "circle");
    point.setAttribute("class", "precipitation-probability-point");
    point.setAttribute("cx", String(x));
    point.setAttribute("cy", String(y));
    point.setAttribute("r", "3.2");
    const valueLabel = document.createElementNS(svgNamespace, "text");
    valueLabel.setAttribute("class", "precipitation-value-label");
    valueLabel.setAttribute("x", String(x));
    valueLabel.setAttribute("y", String(Math.min(y + 17, 134)));
    valueLabel.setAttribute("text-anchor", "middle");
    valueLabel.textContent = `${formatNumber(value)}%`;
    svg.append(point, valueLabel);
  });
  return svg;
}

function forecastChartLegend() {
  const legend = element("div", "forecast-chart-legend");
  legend.setAttribute("aria-label", "예보 그래프 범례");
  [
    ["is-high", "최고기온(℃)"],
    ["is-rain", "강수확률(%)"],
  ].forEach(([className, label]) => {
    const item = element("span", className, label);
    item.prepend(element("i", ""));
    legend.append(item);
  });
  return legend;
}

function forecastRiskLevelRow(days, risks, analysis) {
  const root = element("div", "forecast-risk-level-row");
  root.append(element("strong", "forecast-risk-level-label", "위험 수준"));
  const list = element("ol", "forecast-risk-level-list");
  list.setAttribute("aria-label", "날짜별 작물 위험 수준");
  days.forEach((day) => {
    const dayRisks = risks.filter((risk) => riskCoversDate(risk, day.date));
    const outlook = forecastDailyOutlook(analysis, day, dayRisks);
    const severity = outlook.className;
    const label = outlook.label;
    const item = element("li", `is-${severity}`);
    const dateParts = dashboardDateParts(day.date);
    item.append(
      element("span", "forecast-risk-chip", label),
      element("time", "", `${dateParts.date} (${dateParts.weekday})`),
    );
    list.append(item);
  });
  root.append(list);
  return root;
}

function forecastTemperatureThreshold(analysis, risks, days) {
  const temperatureRisk = risks.find(
    (risk) =>
      ["minTemperature", "maxTemperature"].includes(risk?.trigger?.metric) &&
      Number.isFinite(risk?.trigger?.comparison?.threshold),
  );
  if (temperatureRisk) {
    return {
      metric: temperatureRisk.trigger.metric,
      operator: temperatureRisk.trigger.comparison.operator,
      value: temperatureRisk.trigger.comparison.threshold,
    };
  }
  const temperatures = days
    .flatMap((day) => [day?.minTemperature, day?.maxTemperature])
    .filter(Number.isFinite);
  const minimum = temperatures.length ? Math.min(...temperatures) : null;
  const maximum = temperatures.length ? Math.max(...temperatures) : null;
  const candidates = (analysis?.forecast?.evidence ?? [])
    .filter(
      (item) =>
        ["minTemperature", "maxTemperature"].includes(item?.metric) &&
        Number.isFinite(item?.calculation?.comparison?.threshold),
    )
    .map((item) => ({
      metric: item.metric,
      operator: item.calculation.comparison.operator,
      value: item.calculation.comparison.threshold,
    }))
    .filter(
      (candidate, index, all) =>
        all.findIndex(
          (item) =>
            item.metric === candidate.metric &&
            item.operator === candidate.operator &&
            item.value === candidate.value,
        ) === index,
    )
    .map((candidate) => ({
      ...candidate,
      distance:
        !Number.isFinite(minimum) || !Number.isFinite(maximum)
          ? 0
          : candidate.value < minimum
            ? minimum - candidate.value
            : candidate.value > maximum
              ? candidate.value - maximum
              : 0,
    }))
    .sort((left, right) => left.distance - right.distance);
  return candidates[0] ?? null;
}

function forecastChartSummary(days) {
  const summary = element("div", "forecast-chart-summary");
  const highs = days
    .map((day) => day.maxTemperature)
    .filter(Number.isFinite);
  const lows = days
    .map((day) => day.minTemperature)
    .filter(Number.isFinite);
  summary.append(
    element("span", "", "예상 기온 범위"),
    element(
      "strong",
      "",
      highs.length && lows.length
        ? `${formatNumber(Math.min(...lows))}–${formatNumber(Math.max(...highs))}℃`
        : "자료 없음",
    ),
  );
  return summary;
}

function forecastDayCard(day, isRiskDay = false) {
  const card = element(
    "article",
    [
      "forecast-day",
      day.sourceType === "SHORT_GRID" ? "is-short" : "",
      isRiskDay ? "is-risk" : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
  card.setAttribute("role", "listitem");
  const precipitationProbability = Number.isFinite(day.precipitationProbability)
    ? `${formatNumber(day.precipitationProbability)}%`
    : "—";
  card.setAttribute(
    "aria-label",
    `${formatForecastDate(day.date)}, 최저 ${formatNullableTemperature(day.minTemperature)}, 최고 ${formatNullableTemperature(day.maxTemperature)}, 강수확률 ${precipitationProbability}`,
  );
  card.append(
    element("span", "forecast-day-date", formatForecastDate(day.date)),
    forecastGlyph(day),
  );
  if (isRiskDay) {
    card.append(element("span", "forecast-day-alert", "주의"));
  }
  const temperature = element("strong", "forecast-day-temperature");
  temperature.append(
    document.createTextNode(formatNullableTemperature(day.maxTemperature)),
    element("small", "", ` / ${formatNullableTemperature(day.minTemperature)}`),
  );
  card.append(
    temperature,
    element("span", "forecast-day-rain", `비 ${precipitationProbability}`),
    element(
      "span",
      "forecast-day-source",
      day.sourceType === "SHORT_GRID" ? "단기 예보" : "중기 예보",
    ),
  );
  return card;
}

function riskCoversDate(risk, date) {
  const from = risk?.dateRange?.from;
  const to = risk?.dateRange?.to ?? from;
  return (
    typeof from === "string" &&
    typeof to === "string" &&
    date >= from &&
    date <= to
  );
}

function forecastGlyph(day) {
  const wrap = element("span", "forecast-glyph");
  wrap.setAttribute("aria-hidden", "true");
  const svgNamespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const rain =
    (Number.isFinite(day.precipitationProbability) &&
      day.precipitationProbability >= 50) ||
    (Number.isFinite(day.precipitationAmount) && day.precipitationAmount > 0);
  const paths = rain
    ? [
        "M7 15.5h9a4 4 0 0 0 .5-7.97A5.5 5.5 0 0 0 6.24 8.8 3.4 3.4 0 0 0 7 15.5Z",
        "M9 18.5l-1 2",
        "M14 18.5l-1 2",
      ]
    : [
        "M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0Z",
        "M12 9v8",
      ];
  paths.forEach((value) => {
    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute("d", value);
    svg.append(path);
  });
  wrap.append(svg);
  return wrap;
}

function actionVisual(analysis, weatherGuide, soilGuide) {
  const risk = activeForecastRisks(analysis)[0] ?? null;
  const metric = risk?.trigger?.metric;
  const kind =
    metric === "precipitationProbability" ||
    metric === "precipitationAmount"
      ? "rain"
      : weatherGuide.risk
        ? "temperature"
        : soilGuide.tone === "caution"
          ? "soil"
          : "check";
  const labels = {
    rain: "비 예보 점검",
    temperature: "기온 변화 점검",
    soil: "토양 상태 점검",
    check: "현재 범위 양호",
  };
  const paths = {
    rain: [
      "M7 13.5h9a4 4 0 0 0 .5-7.97A5.5 5.5 0 0 0 6.24 6.8 3.4 3.4 0 0 0 7 13.5Z",
      "M9 17l-1 3",
      "M14 17l-1 3",
    ],
    temperature: [
      "M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0Z",
      "M12 9v8",
      "M17.5 4.5h2",
      "M18.5 3.5v2",
    ],
    soil: [
      "M4 7c4 1.8 12 1.8 16 0",
      "M4 12c4 1.8 12 1.8 16 0",
      "M4 17c4 1.8 12 1.8 16 0",
      "M12 7v10",
    ],
    check: ["M5 12.5l4 4L19 6.5"],
  };
  const wrap = element("div", `live-action-visual is-${kind}`);
  wrap.setAttribute("aria-hidden", "true");
  const svgNamespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  paths[kind].forEach((value) => {
    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute("d", value);
    svg.append(path);
  });
  wrap.append(svg, element("span", "", labels[kind]));
  return wrap;
}

function formatForecastDate(value) {
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return value;
  const today = new Date();
  const todayKey = localDateKey(today);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const key = localDateKey(date);
  if (key === todayKey) return "오늘";
  if (key === localDateKey(tomorrow)) return "내일";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function formatCompactForecastDate(value) {
  return formatForecastDate(value).replace(/\.\s+/gu, ".");
}

function formatExplicitForecastDate(value) {
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function localDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatKoreanDate(date) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatNullableTemperature(value) {
  return Number.isFinite(value) ? `${formatNumber(value)}℃` : "—";
}

function renderFarmOverview() {
  const root = document.querySelector("#farm-overview-dashboard");
  const detail = document.querySelector("#dashboard-workspace");
  const analyses = [...currentAnalyses.values()].filter(Boolean);
  if (!root || analyses.length === 0) return;
  dashboardMode = "overview";
  if (detail) detail.hidden = true;
  root.hidden = false;

  const representative = analyses[0];
  currentAnalysis = representative;
  const planning = representative?.inputSummary?.usageMode === "LAND_SEARCH";
  const region = compactDashboardRegionLabel(
    representative?.inputSummary?.regionLabel ?? selectedCandidate?.displayName ?? "현재 농장",
  );
  const title = document.querySelector("#dashboard-title");
  const topbar = document.querySelector("#topbar-context-value");
  const sidebar = document.querySelector("#sidebar-context-value");
  if (title) title.textContent = `${region} 농장 종합`;
  if (topbar) topbar.textContent = `${region} 농장 종합`;
  if (sidebar) sidebar.textContent = `${region} · ${analyses.length}개 품목`;
  const summary = document.querySelector("#farm-overview-summary");
  if (summary) {
    summary.textContent = planning
      ? `${analyses.map(cropLabelForAnalysis).join(" · ")} · 재배 전 적합도와 준비 일정 분석`
      : `${analyses.map(cropLabelForAnalysis).join(" · ")} · 오늘 할 일과 7일 위험 통합 분석`;
  }
  setText("#farm-overview-title", planning ? "전체 작물 재배 준비도" : "전체 작물 관리 현황");
  setText("#farm-overview-crops-title", planning ? "품목별 적합도" : "품목별 점수");
  setText("#farm-overview-crop-count", `${analyses.length}종`);
  renderFarmOverviewWeather(representative);
  renderFarmOverviewCrops(analyses);
  renderFarmOverviewWarnings(analyses);
  renderCropManagementView(representative);
  renderPestInformationView(representative);
  syncAssistantContext(representative);
  void refreshFarmOverviewActions(analyses);
}

function cropLabelForAnalysis(analysis) {
  const crop = analysis?.inputSummary?.crop;
  return CROP_LABELS[crop] ?? crop ?? "작물";
}

function setText(selector, value) {
  const node = document.querySelector(selector);
  if (node) node.textContent = value;
}

function renderAnalysisScopeNotice(analysis) {
  const notice = document.querySelector("#analysis-scope-notice");
  if (!notice) return;
  const commonNotice = analysis?.analysisScope?.summary?.commonNotice;
  const title = String(commonNotice?.title ?? "").trim();
  const message = String(commonNotice?.message ?? "").trim();
  notice.hidden = message === "";
  notice.textContent = [title, message].filter(Boolean).join(" · ");
}

function seedLocalCropCycleProjections(requests) {
  for (const request of requests) {
    const cropCode = request.crop.toUpperCase();
    const projection = projectLocalCropCycle({
      crop: request.crop,
      input: request.input,
    });
    cropCycleProjections.set(cropCode, projection);
    const context = currentUiContexts.get(cropCode);
    if (context) {
      context.cycleInput = request.input;
      context.cycleProjection = projection;
    }
  }
}

async function refreshCropCycleProjections(requests, { save = false } = {}) {
  const farm = readStoredSession();
  if (!farm?.id) return;
  await Promise.all(requests.map(async (request) => {
    const projection = await cropCycleAdapter[save ? "save" : "load"]({
      farmId: farm.id,
      cropId: request.cropId,
      crop: request.crop,
      input: request.input,
    });
    const cropCode = request.crop.toUpperCase();
    cropCycleProjections.set(cropCode, projection);
    const context = currentUiContexts.get(cropCode);
    if (context) {
      context.cycleInput = request.input;
      context.cycleProjection = projection;
    }
  }));
  await refreshHarvestSeasonWeather();
  if (currentAnalysis) renderCropCycleCard(currentAnalysis);
}

async function refreshHarvestSeasonWeather(
  analyses = [...currentAnalyses.values()].filter(Boolean),
) {
  if (!connected || analyses.length === 0) return;
  await Promise.allSettled(analyses.map(async (analysis) => {
    const scope = currentFeatureScope(analysis);
    const cropId = String(analysis?.inputSummary?.crop ?? "").toUpperCase();
    const key = harvestAssessmentKey(analysis);
    if (!scope || !cropId || !key || !analysis?.analysisId) return;
    try {
      const response = await api.getHarvestWeather(scope.farmId, cropId, {
        seasonId: scope.seasonId,
        analysisId: analysis.analysisId,
      });
      if (response?.seasonWeather && typeof response.seasonWeather === "object") {
        harvestSeasonWeather.set(key, response.seasonWeather);
      }
    } catch (error) {
      if (!["NOT_FOUND", "ANALYSIS_NOT_FOUND", "FEATURE_NOT_CONFIGURED"].includes(error?.code)) {
        throw error;
      }
    }
  }));
}

function cropCycleProjectionFor(analysis) {
  const cropCode = analysis?.inputSummary?.crop;
  const context = currentUiContexts.get(cropCode);
  const projection = cropCycleProjections.get(cropCode) ?? context?.cycleProjection;
  if (projection) return projection;
  const crop = String(cropCode ?? "").toLowerCase();
  const profile = readStoredSession();
  const input = storedCropCycleInput(
    profile,
    crop,
    profile?.cropSettings?.[crop]?.cycle,
  );
  return projectLocalCropCycle({
    crop,
    input,
    sourceLabel: hasStoredCropCycle(profile?.cropSettings?.[crop]?.cycle)
      ? "입력 기준 예상"
      : "날짜 기준 AI 예상",
  });
}

function renderCropCycleCard(analysis) {
  const card = document.querySelector("#dashboard-cycle-card");
  if (!card) return;
  const projection = cropCycleProjectionFor(analysis);
  const cropCode = String(analysis?.inputSummary?.crop ?? "").toUpperCase();
  const assessmentKey = harvestAssessmentKey(analysis);
  const photoAssessment = assessmentKey
    ? harvestPhotoAssessments.get(assessmentKey) ?? readStoredHarvestAssessment(assessmentKey)
    : null;
  const seasonWeather = assessmentKey
    ? harvestSeasonWeather.get(assessmentKey) ?? null
    : null;
  if (assessmentKey && photoAssessment && !harvestPhotoAssessments.has(assessmentKey)) {
    harvestPhotoAssessments.set(assessmentKey, photoAssessment);
  }
  const harvestForecast = buildHarvestForecast({
    crop: cropCode,
    projection,
    seasonWeather,
    forecastDays: forecastDisplayDays(analysis),
    photoAssessment,
  });
  const progressPercent = harvestForecast.progressPercent;
  setText("#crop-cycle-progress-value", `${progressPercent}%`);
  setText("#crop-cycle-source", harvestForecast.sourceLabel);
  setText("#crop-cycle-current", displayCurrentCropStage(analysis, projection));
  setText("#crop-cycle-next", milestoneLabel(projection.nextMilestone));
  setText("#crop-cycle-harvest", formatCycleDateRange(harvestForecast.firstHarvestWindow));
  setText("#crop-cycle-harvest-season", formatCycleDateRange(harvestForecast.harvestSeasonWindow));
  setText("#crop-cycle-preparation", formatCycleDateRange(harvestForecast.preparationWindow));
  setText(
    "#crop-cycle-weather-adjustment",
    `${harvestForecast.history.summary} · ${harvestForecast.weather.summary}`,
  );
  const source = document.querySelector("#crop-cycle-source");
  source?.classList.toggle("is-preview", projection.source === "LOCAL_PREVIEW");
  const track = document.querySelector("#crop-cycle-progress-track");
  if (track) {
    track.setAttribute("aria-valuenow", String(progressPercent));
    track.setAttribute("aria-valuetext", `첫 수확 준비도 ${progressPercent}%`);
  }
  const bar = document.querySelector("#crop-cycle-progress-bar");
  if (bar) bar.style.width = `${progressPercent}%`;
  const complete = document.querySelector("#crop-cycle-complete");
  if (complete) {
    complete.hidden = projection.status === "PLANNING";
    complete.disabled = false;
    complete.textContent = projection.status === "COMPLETED" ? "새 시즌 시작" : "시즌 종료";
    complete.setAttribute(
      "aria-label",
      projection.status === "COMPLETED"
        ? "이전 기록을 보존하고 새 재배 시즌 등록"
        : "현재 재배 시즌 종료",
    );
  }
  const status = document.querySelector("#crop-cycle-status");
  if (status) {
    status.textContent = [
      projection.source === "LOCAL_PREVIEW"
        ? "입력한 기준일로 첫 수확 시점을 계산했습니다."
        : "저장한 기준일과 작물 규칙으로 첫 수확 시점을 계산했습니다.",
      harvestForecast.history.summary,
      harvestForecast.weather.summary,
      harvestForecast.photo.summary,
    ].join(" ");
  }
  renderHarvestPhotoAssessment(photoAssessment, harvestForecast);
}

function renderHarvestPhotoAssessment(assessment, harvestForecast) {
  const status = document.querySelector("#harvest-photo-status");
  if (!status) return;
  status.className = "harvest-photo-status";
  if (!assessment) {
    status.textContent = "수확 시기가 가까우면 과실·잎·줄기가 함께 보이는 사진으로 한 번 더 확인할 수 있습니다.";
    return;
  }
  const label = ({
    READY: "수확 가능 신호",
    NOT_READY: "아직 이른 상태",
    UNCERTAIN: "사진 판단 보류",
  })[assessment.state] ?? "사진 확인 결과";
  status.classList.add(`is-${String(assessment.state ?? "uncertain").toLowerCase()}`);
  const reasons = Array.isArray(assessment.visibleReasons)
    ? assessment.visibleReasons.join(" · ")
    : "보이는 생육 상태를 확인했습니다.";
  status.textContent = `${label} · ${reasons} ${harvestForecast.photo.summary}`;
}

function milestoneLabel(milestone) {
  const labels = Array.isArray(milestone?.candidates)
    ? milestone.candidates.map(({ label }) => String(label ?? "").trim()).filter(Boolean)
    : [];
  return labels.length ? labels.join(" 또는 ") : "다음 단계 미정";
}

function displayCurrentCropStage(analysis, projection) {
  const context = currentUiContexts.get(analysis?.inputSummary?.crop);
  const growth = String(context?.growthLabel ?? "").trim();
  if (
    analysis?.inputSummary?.usageMode === "ACTIVE_GROWING" &&
    growth &&
    !["잘 모름", "생육 상태 확인"].includes(growth)
  ) {
    return context?.growthRecommended
      ? `${growth} · 자동 예상 기본값`
      : `${growth} · 사용자 선택`;
  }
  return milestoneLabel(projection.currentMilestone);
}

function formatCycleDateRange(range) {
  const earliest = range?.earliest;
  const latest = range?.latest;
  if (!earliest || !latest) return "확인 필요";
  if (earliest === latest) return formatCycleDate(earliest);
  return `${formatCycleDate(earliest)} ~ ${formatCycleDate(latest)}`;
}

function formatCycleDate(value) {
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return String(value ?? "확인 필요");
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function openCropCycleEditor() {
  document.querySelector("#open-new-analysis")?.click();
  requestAnimationFrame(() => {
    document.querySelector('[data-edit-step="3"]')?.click();
    document.querySelector("#crop-cycle-settings input, #crop-cycle-settings select")?.focus();
  });
}

function startNewCurrentCropCycle(button) {
  const cropCode = currentAnalysis?.inputSummary?.crop;
  const context = currentUiContexts.get(cropCode);
  if (!cropCode || context?.cycleInput?.status !== "COMPLETED" || !button) return;
  if (!globalThis.confirm?.("새 재배 시즌을 등록할까요? 완료한 이전 시즌의 기록은 그대로 남습니다.")) {
    return;
  }
  const crop = cropCode.toLowerCase();
  const profile = readStoredSession();
  const situation = profile?.situation === "planning" ? "planning" : "growing";
  const freshCycle = {
    ...createDefaultCropCycleInput({
      crop,
      situation,
      growth: "unknown",
      seasonId: createCropCycleSeasonId(crop),
    }),
    anchorDate: seoulDateKey(new Date()),
    status: situation === "planning" ? "PLANNING" : "ACTIVE",
  };
  pendingNewSeasonDraft = {
    crop,
    previousInput: { ...context.cycleInput },
  };
  cropCycleDrafts.set(crop, freshCycle);
  document.querySelector("#open-new-analysis")?.click();
  const saveConsent = document.querySelector("#save-consent");
  if (saveConsent) saveConsent.checked = true;
  renderCropCycleSettings({ rememberExisting: false });
  requestAnimationFrame(() => {
    document.querySelector('[data-edit-step="3"]')?.click();
    document.querySelector(
      `[name="cycle-anchorType-${crop}"], [name="cycle-anchorDate-${crop}"]`,
    )?.focus();
    announce("새 시즌의 기준일을 확인해 주세요. 이전 시즌 기록은 보존됩니다.");
  });
}

async function completeCurrentCropCycle(button) {
  const cropCode = currentAnalysis?.inputSummary?.crop;
  const context = currentUiContexts.get(cropCode);
  if (!cropCode || !context?.cycleInput || !button) return;
  if (!globalThis.confirm?.("이 시즌을 종료할까요? 저장한 날짜와 기록은 남아 있습니다.")) return;
  let completed = false;
  setBusy(button, true, "종료 저장 중…");
  try {
    const result = await finalizeCurrentSeasonRecords();
    completed = true;
    announce(
      result.syncWarnings.length
        ? "재배 시즌은 종료했습니다. 일부 기록 동기화는 다음 접속 때 자동으로 다시 확인합니다."
        : "재배 일정과 사진 기록을 한 시즌으로 마무리했습니다.",
    );
  } catch (error) {
    const status = document.querySelector("#crop-cycle-status");
    if (status) status.textContent = `시즌을 종료하지 못했습니다. ${errorMessage(error)}`;
    announce(status?.textContent ?? "시즌을 종료하지 못했습니다.");
  } finally {
    button.setAttribute("aria-busy", "false");
    if (completed) {
      renderCropCycleCard(currentAnalysis);
    } else {
      setBusy(button, false, "시즌 종료");
    }
  }
}

async function finalizeCurrentSeasonRecords() {
  const cropCode = currentAnalysis?.inputSummary?.crop;
  const context = currentUiContexts.get(cropCode);
  const scope = currentFeatureScope(currentAnalysis);
  if (!cropCode || !context?.cycleInput || !scope) {
    throw new ApiRequestError({ code: "INVALID_INPUT" });
  }
  const crop = cropCode.toLowerCase();
  const input = { ...context.cycleInput, status: "COMPLETED" };
  const farm = readStoredSession();
  const projection = farm?.id
    ? await cropCycleAdapter.save({
        farmId: farm.id,
        cropId: cropCode,
        crop,
        input,
      })
    : projectLocalCropCycle({ crop, input });

  let completedActionCount = 0;
  let actionSyncWarning = null;
  if (connected) {
    try {
      const result = await closeCompletedSeasonActions(scope);
      completedActionCount = result.completedActionCount;
    } catch (error) {
      // 작기는 이미 종료됐다. 다음 조회에서도 같은 정리를 재시도한다.
      actionSyncWarning = error;
    }
  }

  let photoSyncWarning = null;
  if (connected) {
    try {
      await api.completePhotoSeason(scope.farmId, scope);
    } catch (error) {
      if (!["FEATURE_NOT_CONFIGURED", "SEASON_NOT_FOUND", "SEASON_NOT_ACTIVE"].includes(error?.code)) {
        photoSyncWarning = error;
      }
    }
  }
  await photoJournal?.completeSeason(scope, { completedActionCount });
  updateStoredCropCycle(crop, input);
  context.cycleInput = input;
  context.cycleProjection = projection;
  cropCycleProjections.set(cropCode, projection);
  writeStoredTodoForActiveFarm(null, safeStorage(), cropCode);
  currentActionPlan = null;
  invalidateActionPlan(currentAnalysis);
  renderCropCycleCard(currentAnalysis);
  await refreshActionPlan(currentAnalysis, { ensureRules: false });
  await refreshPhotoJournal(currentAnalysis);
  return {
    projection,
    photoSyncWarning,
    actionSyncWarning,
    syncWarnings: [actionSyncWarning, photoSyncWarning].filter(Boolean),
  };
}

function updateStoredCropCycle(crop, input) {
  const storage = safeStorage();
  if (!storage) return;
  const farms = readStoredFarms();
  const activeId = storage.getItem(ACTIVE_FARM_STORAGE_KEY);
  const farm = farms.find(({ id }) => id === activeId);
  if (!farm) return;
  farm.cropSettings = {
    ...farm.cropSettings,
    [crop]: { ...farm.cropSettings?.[crop], cycle: input },
  };
  farm.updatedAt = new Date().toISOString();
  storage.setItem(FARMS_STORAGE_KEY, JSON.stringify(farms));
  const { id, name, updatedAt, ...profile } = farm;
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(profile));
  void syncStoredWorkspaceBackup();
}

function renderFarmOverviewWeather(analysis) {
  const root = document.querySelector("#farm-overview-weather-strip");
  if (!root) return;
  const days = forecastDisplayDays(analysis).slice(0, 7);
  const today = days[0];
  setText(
    "#farm-overview-weather-now",
    Number.isFinite(today?.maxTemperature)
      ? `오늘 ${formatNumber(today.maxTemperature)}℃`
      : "예보 확인 중",
  );
  if (days.length === 0) {
    root.replaceChildren(element("p", "dashboard-loading-copy", "현재 표시할 7일 예보가 없습니다."));
    return;
  }
  root.replaceChildren(
    ...days.map((day, index) => {
      const item = element("article", "farm-weather-day");
      const rain = Number.isFinite(day.precipitationProbability)
        ? `${formatNumber(day.precipitationProbability)}%`
        : "—";
      item.append(
        element("span", "farm-weather-date", formatFarmWeatherDate(day.date, index)),
        element("strong", "farm-weather-temperature", formatNullableTemperature(day.maxTemperature)),
        element("span", "farm-weather-rain", `비 ${rain}`),
      );
      item.setAttribute(
        "aria-label",
        `${formatExplicitForecastDate(day.date)} 최고 ${formatNullableTemperature(day.maxTemperature)}, 강수확률 ${rain}`,
      );
      return item;
    }),
  );
}

function formatFarmWeatherDate(value, index) {
  if (index === 0) return "오늘";
  if (index === 1) return "내일";
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return String(value ?? "—");
  return `${date.getMonth() + 1}.${date.getDate()}`;
}

function renderFarmOverviewCrops(analyses) {
  const root = document.querySelector("#farm-overview-crop-grid");
  if (!root) return;
  root.replaceChildren(
    ...analyses.map((analysis) => {
      const status = farmStatusSummary(analysis);
      const indicators = dashboardStatusIndicators(analysis);
      const card = element("button", `farm-crop-score-card is-${status.tone}`);
      card.type = "button";
      card.setAttribute("aria-label", `${cropLabelForAnalysis(analysis)} 상세 분석 보기`);
      const score = Number.isFinite(status.score) ? `${status.score}` : "—";
      const scoreUnit = Number.isFinite(status.score) ? "점" : "";
      const axis = element("dl", "farm-crop-axis");
      indicators.axes.forEach((item) => {
        const row = element("div", "");
        row.append(element("dt", "", item.title), element("dd", "", item.value));
        axis.append(row);
      });
      const heading = element("div", "farm-crop-score-heading");
      heading.append(
        element("strong", "farm-crop-name", cropLabelForAnalysis(analysis)),
        element("span", `farm-crop-state is-${status.tone}`, status.label),
      );
      const scoreWrap = element("div", "farm-crop-score-value");
      scoreWrap.append(element("strong", "", score), element("span", "", scoreUnit));
      card.append(heading, scoreWrap, axis, element("span", "farm-crop-detail-link", "상세 분석 보기 →"));
      card.addEventListener("click", () => activateCropAnalysis(analysis));
      return card;
    }),
  );
}

function renderFarmOverviewWarnings(analyses) {
  const root = document.querySelector("#farm-overview-warning-list");
  const section = document.querySelector("#farm-overview-warnings");
  if (!root || !section) return;
  const warningItems = analyses
    .map((analysis) => ({
      analysis,
      status: farmStatusSummary(analysis),
      action: resolveDisplayAction(analysis),
    }))
    .filter(({ status }) => status.tone !== "good");
  setText("#farm-overview-warning-count", `${warningItems.length}종`);
  if (warningItems.length === 0) {
    root.replaceChildren();
    section.hidden = true;
    return;
  }
  section.hidden = false;
  root.replaceChildren(
    ...warningItems.map(({ analysis, status, action }) => {
      const item = element("button", `farm-warning-item is-${status.tone}`);
      item.type = "button";
      item.append(
        element("span", "farm-warning-crop", cropLabelForAnalysis(analysis)),
        element("strong", "", action.title),
        element("p", "", action.detail || status.detail),
        element("span", "farm-warning-link", "자세히 보기 →"),
      );
      item.addEventListener("click", () => activateCropAnalysis(analysis));
      return item;
    }),
  );
}

async function refreshFarmOverviewActions(analyses) {
  const root = document.querySelector("#farm-overview-action-list");
  if (!root || !connected) return;
  const requestVersion = ++overviewRequestVersion;
  root.setAttribute("aria-busy", "true");
  root.replaceChildren(element("p", "dashboard-loading-copy", "품목별 할 일을 모으고 있습니다."));
  try {
    const results = await Promise.allSettled(
      analyses.map(async (analysis) => ({
        analysis,
        scope: currentFeatureScope(analysis),
        plan: await loadActionPlan(analysis),
      })),
    );
    if (requestVersion !== overviewRequestVersion || dashboardMode !== "overview") return;
    const completed = results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    const merged = mergeTodayActionPlans(completed);
    overviewActionScopes = merged.actionTargets;
    const today = merged.plan.today;
    root.closest(".farm-overview-actions")?.classList.toggle("is-empty", today.length === 0);
    disposeOverviewActionPlan?.();
    disposeOverviewActionPlan = mountActionPlan(root, merged.plan, {
      onStatusChange: async ({ actionId, status }) => {
        const target = overviewActionScopes.get(actionId);
        if (!target?.scope) return;
        await api.updateAction(target.scope.farmId, actionId, status, createIdempotencyKey());
        invalidateActionPlan(target.analysis);
        await refreshFarmOverviewActions(analyses);
      },
      onSnooze: async ({ actionId, snoozedUntil }) => {
        const target = overviewActionScopes.get(actionId);
        if (!target?.scope) return;
        await api.snoozeAction(target.scope.farmId, actionId, snoozedUntil, createIdempotencyKey());
        invalidateActionPlan(target.analysis);
        await refreshFarmOverviewActions(analyses);
      },
      onStatusError: ({ error }) => {
        const status = document.querySelector("#farm-overview-action-status");
        if (!status) return;
        status.hidden = false;
        status.classList.add("is-error");
        status.textContent = `할 일을 저장하지 못했습니다. ${errorMessage(error)}`;
      },
    });
    const openCount = today.filter((item) => item.status === "OPEN").length;
    setText("#farm-overview-action-count", `${openCount}개`);
    setText("#farm-overview-open-count", openCount ? `${openCount}개 남음` : "모두 완료");
    const failedCount = results.length - completed.length;
    if (failedCount > 0) {
      const status = document.querySelector("#farm-overview-action-status");
      if (status) {
        status.hidden = false;
        status.classList.add("is-error");
        status.textContent = `${failedCount}개 품목의 할 일을 불러오지 못했습니다. 나머지 결과만 표시합니다.`;
      }
    }
  } catch (error) {
    root.replaceChildren(element("p", "backend-empty", `오늘 할 일을 불러오지 못했습니다. ${errorMessage(error)}`));
    setText("#farm-overview-action-count", "—");
    setText("#farm-overview-open-count", "불러오기 실패");
  } finally {
    root.removeAttribute("aria-busy");
  }
}

function activateCropAnalysis(analysis) {
  dashboardMode = "crop";
  overviewRequestVersion += 1;
  document.querySelector("#farm-overview-dashboard")?.setAttribute("hidden", "");
  currentAnalysis = analysis;
  renderAnalysis(analysis);
  renderCropResultSwitcher();
  if ((analysis?.report?.state ?? "NOT_REQUESTED") === "NOT_REQUESTED") {
    const reportButton = document.querySelector("#backend-report-button");
    if (reportButton) void requestAndPollReport(reportButton, { automatic: true });
  }
}

function renderCropResultSwitcher() {
  const switcher = document.querySelector("#crop-result-switcher");
  if (!switcher) return;
  const analyses = [...currentAnalyses.values()];
  const overviewButton = element("button", "", "종합");
  overviewButton.type = "button";
  overviewButton.setAttribute("aria-pressed", String(dashboardMode === "overview"));
  overviewButton.addEventListener("click", () => {
    renderFarmOverview();
    renderCropResultSwitcher();
  });
  const cropButton = (analysis) => {
      const crop = analysis?.inputSummary?.crop;
      const button = element(
        "button",
        "",
        CROP_LABELS[crop] ?? crop ?? "작물",
      );
      button.type = "button";
      button.setAttribute(
        "aria-pressed",
        String(dashboardMode === "crop" && analysis?.analysisId === currentAnalysis?.analysisId),
      );
      button.addEventListener("click", () => activateCropAnalysis(analysis));
      return button;
  };
  if (analyses.length <= 2) {
    switcher.replaceChildren(overviewButton, ...analyses.map(cropButton));
  } else {
    const active = analyses.find(
      (analysis) => analysis?.analysisId === currentAnalysis?.analysisId,
    ) ?? analyses[0];
    const others = analyses.filter((analysis) => analysis !== active);
    const select = element("select", "crop-result-more");
    select.setAttribute("aria-label", "다른 작물 분석 선택");
    select.append(element("option", "", `다른 작물 ${others.length}`));
    select.options[0].value = "";
    others.forEach((analysis, index) => {
      const crop = analysis?.inputSummary?.crop;
      const option = element("option", "", CROP_LABELS[crop] ?? crop ?? "작물");
      option.value = String(index);
      select.append(option);
    });
    select.addEventListener("change", () => {
      const analysis = others[Number(select.value)];
      if (analysis) activateCropAnalysis(analysis);
    });
    switcher.replaceChildren(overviewButton, cropButton(active), select);
  }
  switcher.hidden = analyses.length === 0;
}

function renderSummaryPanel(analysis, regionLabel, cropLabel) {
  const panel = document.querySelector(".summary-panel");
  if (!panel) return;
  const summary = analysis?.inputSummary ?? {};
  const uiContext = currentUiContexts.get(summary.crop);
  const meta = element("div", "summary-meta");
  const title = element("div", "summary-primary");
  const region = element("span", "", regionLabel);
  region.id = "result-region";
  const crop = element("span", "", cropLabel);
  crop.id = "result-crop";
  title.append(region, document.createTextNode(" · "), crop);
  const created = element("div");
  created.append(
    element("span", "meta-label", "업데이트"),
    element("span", "meta-value", formatDateTime(analysis?.createdAt)),
  );
  const contextList = element("div", "summary-context-list");
  const planning = summary.usageMode === "LAND_SEARCH";
  contextList.append(
    element(
      "span",
      "summary-context-chip",
      `재배 환경 · ${
        uiContext?.cultivationLabel ??
        CULTIVATION_LABELS[summary.cultivationMode] ??
        "미설정"
      }`,
    ),
    ...(planning
      ? [element("span", "summary-context-chip", "진단 목적 · 재배 전 준비")]
      : [element(
          "span",
          "summary-context-chip",
          `생육 상태 · ${uiContext?.growthLabel ?? "단계 공통 안내"}`,
        )]),
    ...(!planning && uiContext?.growthRecommended
      ? [element("span", "summary-context-chip is-ai", "날짜 기준 AI 예상")]
      : []),
  );
  meta.append(title, contextList, created);
  panel.replaceChildren(meta);
}

function renderDecisionPanel(analysis) {
  const panel = document.querySelector(".risk-panel");
  const briefing = element(
    "p",
    "brief-kicker",
    "오늘 먼저 볼 것",
  );
  const eyebrow = element(
    "p",
    "risk-date",
    "농장 점검",
  );
  const displayAction = resolveDisplayAction(analysis);
  const title = element(
    "h2",
    "risk-title",
    displayAction.title,
  );
  title.id = "risk-title";
  const context = element(
    "p",
    "",
    displayAction.detail,
  );
  panel.replaceChildren(briefing, eyebrow, title, context);
}

function renderStateOverview(analysis) {
  const overview = document.querySelector(".overview-score");
  const inner = element("div", "overview-score-inner");
  const heading = element("div", "overview-heading");
  const planning = analysis?.inputSummary?.usageMode === "LAND_SEARCH";
  const title = element("h2", "", planning ? "재배 준비 상태" : "오늘의 작물 상태");
  title.id = "readiness-title";
  heading.append(
    element("span", "overview-kicker", "현재 상태"),
    title,
  );
  const status = farmStatusSummary(analysis);
  const stateVisual = element("div", "current-state-visual");
  const stateRing = element(
    "div",
    `current-state-ring is-${status.tone}`,
  );
  stateRing.setAttribute("role", "img");
  stateRing.setAttribute(
    "aria-label",
    `${planning ? "재배 준비 상태" : "오늘의 작물 상태"} ${status.label}`,
  );
  stateRing.append(element("strong", "", status.label));
  const stateCopy = element("div", "current-state-copy");
  stateCopy.append(
    element(
      "strong",
      "",
      status.label,
    ),
    element("span", "", status.detail),
  );
  stateVisual.append(stateRing, stateCopy);

  const axes = element("div", "axis-status-list");
  [
    {
      key: "climate",
      label: "기후 조건",
      state: analysis?.climate?.state,
      help: "선택한 작기와 장기 기후 비교",
    },
    {
      key: "soil",
      label: "토양 조건",
      state: analysis?.soil?.state,
      help: soilConditionHelp(analysis),
    },
    {
      key: "forecast",
      label: "가까운 예보",
      state: analysis?.forecast?.result?.riskState ?? analysis?.forecast?.state,
      help: forecastConditionHelp(analysis),
    },
  ].forEach(({ key, label, state, help }) => {
    const presentation = analysisAxisPresentation(analysis, key, state);
    const tone = presentation.tone;
    const card = element(
      "article",
      `axis-status ${tone === "good" ? "" : "is-caution"}`.trim(),
    );
    const scoreValue = element(
      "strong",
      `axis-score-value${tone === "good" ? "" : " is-unavailable"}`,
    );
    scoreValue.append(element("b", "", presentation.label));
    card.append(
      element("span", "", label),
      scoreValue,
      element("small", "", help),
    );
    axes.append(card);
  });
  const overall = element(
    "p",
    "score-state",
    isRegionalReferenceAnalysis(analysis)
      ? "지역 예보와 지역 토양 통계를 같은 범위 안에서 분석했습니다."
      : "서로 다른 자료를 하나의 점수로 합치지 않습니다. 확인된 축만 행동 판단에 사용합니다.",
  );
  const sourceStatus = renderOverviewSourceStatus(analysis);
  inner.append(heading, stateVisual, axes, sourceStatus, overall);

  const button = element(
    "button",
    "button button-secondary score-evidence-button",
    "상태 자세히",
  );
  button.type = "button";
  button.addEventListener("click", () => openEvidenceDialog());
  overview.replaceChildren(inner, button);
}

function renderOverviewSourceStatus(analysis) {
  const section = element("section", "overview-source-status");
  section.setAttribute("aria-label", "사용한 자료 상태");
  section.append(
    element(
      "strong",
      "",
      isRegionalReferenceAnalysis(analysis)
        ? "분석에 사용한 지역자료"
        : "사용한 자료",
    ),
  );
  const list = element("div", "overview-source-chips");
  const safeSources = Array.isArray(analysis?.dataSources)
    ? analysis.dataSources.filter(sourceUsedInAnalysis)
    : [];
  if (safeSources.length === 0) {
    list.append(
      element("span", "source-status-chip is-warning", "사용 가능한 공공자료 없음"),
    );
  } else {
    safeSources.forEach((source) => {
      const chip = element(
        "span",
        "source-status-chip is-good",
        `${source.sourceName ?? "공공자료"} · 적용됨`,
      );
      chip.title = `기준 시각 ${formatSourceTime(source)}`;
      list.append(chip);
    });
  }
  section.append(list);
  return section;
}

function forecastConditionHelp(analysis) {
  const forecastState = analysis?.forecast?.result?.riskState ?? analysis?.forecast?.state;
  if (!["READY", "COMPLETE", "PARTIAL"].includes(forecastState)) {
    return "작물별 예보 판정 완료 후 반영";
  }
  const risks = activeForecastRisks(analysis);
  if (risks.length === 0) return "확인된 예보 범위에서 주의 기준 초과 없음";
  const dates = new Set(
    risks.flatMap((risk) =>
      forecastDisplayDays(analysis)
        .filter((day) => riskCoversDate(risk, day.date))
        .map((day) => day.date),
    ),
  );
  return `주의 날짜 ${dates.size}일 · 기준 초과 정도 반영`;
}

function soilConditionHelp(analysis) {
  const basis = analysis?.soil?.result?.measurementBasis;
  if (basis === "USER_SOIL_TEST") return "등록한 필지 토양검정값 기준";
  if (basis === "PROVIDER_SOIL_TEST") return "공공 API의 최근 필지 토양검정 기준";
  if (basis === "REGIONAL_STATISTICS") {
    return "지역 토양 통계 기준 · 실제 밭과 다를 수 있음";
  }
  return "작물별 토양 적합도 확인 후 반영";
}

function farmStatusSummary(analysis) {
  const growthScore = analysis?.growthScore;
  const planning = analysis?.inputSummary?.usageMode === "LAND_SEARCH";
  if (Number.isFinite(growthScore?.score)) {
    const tone = growthScore.score < 50
      ? "danger"
      : growthScore.score < 85
        ? "caution"
        : "good";
    return {
      label: growthScore.label,
      score: growthScore.score,
      tone,
      detail:
        growthScore.state === "READY"
          ? planning
            ? "희망 지역의 기상·토양·예보와 작물 기준을 비교한 재배 적합도입니다."
            : "기상·토양·예보의 영향도와 자료 신뢰도를 반영한 생육점수입니다."
          : planning
            ? "현재 확인된 지역 환경자료로 계산한 재배 전 참고 적합도입니다."
            : "현재 확인된 환경자료로 계산한 생육점수입니다. 더 정확한 상태 확인에는 작물 사진을 함께 활용할 수 있습니다.",
    };
  }
  const weather = forecastRiskGuide(analysis);
  const soil = soilConditionGuide(analysis);
  const primary = primaryDisplayAction(analysis);
  if (weather.risk && weather.severity === "WARNING") {
    return {
      label: "주의",
      tone: "danger",
      detail: "작물 주의 기준을 넘는 가까운 예보가 있습니다.",
    };
  }
  if (weather.risk) {
    return {
      label: "점검 필요",
      tone: "caution",
      detail: "가까운 예보에서 작물별 주의 신호가 확인됐습니다.",
    };
  }
  if (soil.tone === "caution") {
    return {
      label: "점검 필요",
      tone: "caution",
      detail: "주변 토양 참고값에 작물 기준 밖 구간이 있습니다.",
    };
  }
  if (hasRegionalReferenceCoverage(analysis)) {
    return {
      label: "지역 기준 양호",
      tone: "good",
      detail: `${forecastDisplayDays(analysis).length}일 지역 예보와 지역 토양 통계에서 현재 적용할 주의 신호가 없습니다.`,
    };
  }
  if (primary) {
    return {
      label: primary.actionId === "CONFIRM_SEASON" ? "확인 필요" : "점검 필요",
      tone: primary.actionId === "CONFIRM_SEASON" ? "hold" : "caution",
      detail:
        primary.actionId === "CONFIRM_SEASON"
          ? "분석을 끝내려면 재배 시기를 확인해야 합니다."
          : "현장에서 확인할 재배환경 항목이 남아 있습니다.",
    };
  }
  if (weather.bounded && soil.ready) {
    return {
      label: "현재 범위 양호",
      tone: "good",
      detail: `${weather.evaluatedDayCount}일 예보 범위에서 확인된 주의 신호가 없습니다.`,
    };
  }
  if (weather.ready && soil.ready) {
    return {
      label: "양호",
      tone: "good",
      detail: "현재 확인된 위험 신호가 없습니다.",
    };
  }
  return {
    label: "확인 필요",
    tone: "hold",
    detail: "확인 가능한 자료를 기준으로 우선 행동을 안내합니다.",
  };
}

function renderMetricStrip(analysis) {
  const strip = document.querySelector(".metric-strip");
  const regionalCoverage = hasRegionalReferenceCoverage(analysis);
  const metrics = [
    ["climate", "기후 조건", analysis?.climate?.state, "작물·작기 기준과 비교"],
    ["soil", "토양 조건", analysis?.soil?.state, "지역 토양 통계와 작물 기준 비교"],
    [
      "forecast",
      "가까운 예보",
      analysis?.forecast?.result?.riskState ?? analysis?.forecast?.state,
      "날짜·지속기간이 있는 작물별 신호",
    ],
    ["overall", "자료 전체", analysis?.state, "현재 분석에 적용한 자료 범위"],
  ];
  strip.replaceChildren(
    ...metrics.map(([key, label, value, help]) => {
      const cell = element("div", "metric-cell");
      const presentation =
        key === "overall" && regionalCoverage
          ? { label: "지역 기준 완료", help: "상단에 표시된 지역 참고 범위" }
          : analysisAxisPresentation(analysis, key, value);
      cell.append(
        element("span", "metric-label", label),
        element(
          "div",
          "metric-value backend-metric",
          presentation.label,
        ),
        element(
          "p",
          "backend-state-caption",
          regionalCoverage
            ? `${help} · ${presentation.help ?? "분석 완료"}`
            : `${help} · ${stateHelp(value)}`,
        ),
      );
      return cell;
    }),
  );
}

function renderSmartfarmReference(analysis) {
  const panel = document.querySelector("#smartfarm-reference-panel");
  if (!panel) return;
  const module = null;
  if (
    !module ||
    !["READY", "PARTIAL"].includes(module.state)
  ) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }

  const head = element("div", "smartfarm-reference-head");
  const headCopy = element("div");
  headCopy.append(
    element("span", "smartfarm-reference-eyebrow", "SMARTFARM KOREA"),
    element("h2", "", "동종 작물 공개자료 비교"),
    element(
      "p",
      "smartfarm-reference-subtitle",
      "같은 작물·재배형태의 공개 농가 자료만 분리해 표시합니다.",
    ),
  );
  head.append(
    headCopy,
    element(
      "span",
      `status-label ${toneForState(module.state)}`,
      stateLabel(module.state),
    ),
  );

  const data = module?.result;
  const period = data?.datasetPeriod;
  const periodLabel =
    Number.isInteger(period?.fromYear) && Number.isInteger(period?.toYear)
      ? `${period.fromYear}–${period.toYear}`
      : "기간 확인 필요";
  const grid = element("div", "smartfarm-reference-grid");
  grid.append(
    smartfarmStat(
      "지역 일치",
      smartfarmComparisonLabel(data?.comparisonLevel),
      `같은 시·군 ${formatCount(data?.sameDistrictCount)} · 같은 시·도 ${formatCount(data?.sameProvinceCount)}`,
    ),
    smartfarmStat(
      "공개 표본",
      `${formatCount(data?.farmCount)} 농가`,
      Number.isInteger(data?.seasonCount)
        ? `${formatCount(data.seasonCount)} 작기 · 개인 농가 미선택`
        : `${formatCount(data?.recordCount)} 공개 레코드 · 개인 농가 미선택`,
    ),
    smartfarmStat(
      "자료 범위",
      periodLabel,
      `${smartfarmDatasetLabel(data?.datasetType)} · ${smartfarmUpdateLabel(data?.datasetUpdateCycle)}`,
    ),
  );

  const detail = element("div", "smartfarm-reference-detail");
  const layers = element("div");
  layers.append(
    element("h3", "", "비교 가능한 자료 종류"),
    smartfarmChipList(data?.availableDataTypes),
  );
  const caveat = element("div", "smartfarm-reference-caveat");
  caveat.append(
    element("strong", "", "적합도·위험 판단·점수에 반영하지 않음"),
    document.createTextNode(
      " 다른 농가의 환경값은 내 농장의 센서값이나 공식 적정 기준이 아닙니다. 시설·지역 구성과 자료 존재 여부를 확인하는 참고자료로만 사용합니다.",
    ),
  );
  detail.append(layers, caveat);

  panel.replaceChildren(head, grid, detail);
  panel.hidden = false;
}

function smartfarmStat(label, value, help) {
  const stat = element("div", "smartfarm-reference-stat");
  stat.append(
    element("span", "", label),
    element("strong", "", value),
    element("small", "", help),
  );
  return stat;
}

function smartfarmChipList(values) {
  const list = element("div", "smartfarm-chip-list");
  const labels = {
    CROP_SEASON: "작기",
    ENVIRONMENT: "환경 센서",
    CONTROL: "시설 제어",
    GROWTH: "생육 조사",
    GROWTH_IMAGE: "생육 사진",
    CONSULTING_REPORT: "컨설팅 보고서",
    PRODUCTION: "생산량",
    COST: "생산비",
  };
  const items = Array.isArray(values) ? values : [];
  list.append(
    ...items.map((value) =>
      element(
        "span",
        "smartfarm-chip",
        labels[value] ?? String(value).replaceAll("_", " "),
      ),
    ),
  );
  if (items.length === 0) {
    list.append(element("span", "smartfarm-chip", "확인된 항목 없음"));
  }
  return list;
}

function smartfarmComparisonLabel(level) {
  const labels = {
    SAME_DISTRICT: "같은 시·군 포함",
    SAME_PROVINCE: "같은 시·도 포함",
    NATIONAL: "전국 자료",
  };
  return labels[level] ?? "비교 범위 확인 필요";
}

function smartfarmDatasetLabel(type) {
  const labels = {
    FACILITY_ITEM_DATA: "시설원예 품목별",
    OUTDOOR_BIG_DATA: "노지 빅데이터",
  };
  return labels[type] ?? "SmartFarm 공개자료";
}

function smartfarmUpdateLabel(cycle) {
  const labels = {
    ANNUAL_AFTER_SEASON: "작기 종료 후 연 단위 적재",
    REAL_TIME_COLLECTION: "실시간 수집 데이터셋",
  };
  return labels[cycle] ?? "갱신주기 확인 필요";
}

function formatCount(value) {
  return Number.isInteger(value) && value >= 0
    ? new Intl.NumberFormat("ko-KR").format(value)
    : "—";
}

function renderActionsAndReport(analysis) {
  const workspace = document.querySelector(".action-workspace");
  const actionMain = element("section", "action-main");
  const heading = element("div", "section-heading");
  const headingCopy = element("div");
  const primary = primaryDisplayAction(analysis);
  const followUps = (analysis?.actions ?? []).filter(
    (action) =>
      action?.actionId !== primary?.actionId &&
      isUserFacingAction(action),
  );
  if (followUps.length) {
    headingCopy.append(
      element("h2", "", "다음 확인"),
      element("p", "muted", "오늘 점검 후 이어서 확인할 항목"),
    );
    heading.append(
      headingCopy,
      element("span", "status-label info", `${followUps.length}개`),
    );
    actionMain.append(heading, actionList(followUps, "backend-action-list", analysis));
  }

  const report = element("section", "backend-report");
  report.id = "backend-report-panel";
  renderReportPanel(report, analysis);
  const reportDetails = element("details", "backend-report-details");
  reportDetails.append(
    element("summary", "", "분석 설명 자세히 보기"),
    report,
  );
  workspace.classList.toggle("is-summary-only", followUps.length === 0);
  workspace.replaceChildren(
    ...(followUps.length ? [actionMain, reportDetails] : [reportDetails]),
  );
  workspace.hidden = false;
}

function renderExplanation(analysis) {
  const grid = document.querySelector(".insight-grid");
  const explanation = element("article", "panel ai-panel");
  const title = element("h2", "ai-title", "분석 요약");
  const summary = resolveDisplayAction(analysis);
  explanation.append(
    title,
    element("p", "", summary.title),
    element("p", "muted", summary.detail),
  );
  grid.classList.add("is-user-summary");
  grid.replaceChildren(explanation);
}

function renderEvidenceWorkspace(analysis) {
  const workspace = document.querySelector(".evidence-workspace");
  const header = element("div", "evidence-header");
  const copy = element("div");
  const workspaceTitle = element("h2", "", "분석 근거와 자료");
  workspaceTitle.id = "evidence-workspace-title";
  copy.append(
    workspaceTitle,
    element(
      "p",
      "muted no-margin",
      "출처, 전달 상태, 공간 범위와 판단 한계를 백엔드 응답에서 확인합니다.",
    ),
  );
  const evidenceButton = element("button", "button button-secondary", "근거 상세");
  evidenceButton.type = "button";
  evidenceButton.addEventListener("click", () => openEvidenceDialog());
  header.append(copy, evidenceButton);

  const panel = element("section", "panel");
  const panelHeading = element("div", "section-heading");
  const panelCopy = element("div");
  panelCopy.append(
    element("h2", "", "출처별 상태"),
    element("p", "muted", "자료가 없거나 샘플이면 준비된 자료로 오인하지 않습니다."),
  );
  panelHeading.append(
    panelCopy,
    element(
      "span",
      `status-label ${toneForState(analysis?.state)}`,
      stateLabel(analysis?.state),
    ),
  );
  const notice = element(
    "div",
    `notice ${analysis?.state === "COMPLETE" ? "notice-good" : "notice-warning"}`,
  );
  notice.append(
    element(
      "p",
      "",
      analysis?.state === "COMPLETE"
        ? "백엔드 분석 흐름이 완료되었습니다."
        : "일부 자료가 준비되지 않아 판단 범위가 제한됩니다.",
    ),
    element(
      "p",
      "",
      "아래 상태와 한계를 실제 현장 확인보다 우선하지 마세요.",
    ),
  );
  panel.append(panelHeading, notice, sourceGrid(analysis?.dataSources));

  const limitationPanel = element("section", "panel");
  limitationPanel.id = "dialog-limits-summary";
  limitationPanel.append(
    element("h2", "", "판단 한계와 규칙"),
    limitationList(analysis?.limitations),
    element(
      "p",
      "muted",
      `규칙 버전: ${analysis?.ruleVersion ?? "제공되지 않음"}`,
    ),
  );
  workspace.replaceChildren(header, panel, limitationPanel);
}

function renderEvidenceDialog(analysis) {
  const dialog = document.querySelector("#evidence-dialog");
  const titleGroup = dialog.querySelector(".dialog-header > div");
  const dialogTitle = element("h2", "", "이 안내가 나온 이유");
  dialogTitle.id = "evidence-dialog-title";
  titleGroup.replaceChildren(
    dialogTitle,
    element(
      "p",
      "muted no-margin",
      "확인된 날씨·토양 조건과 필요한 행동",
    ),
  );
  const body = dialog.querySelector(".dialog-body");
  body.replaceChildren(renderFarmConditionGuide(analysis, "dialog"));
}

function renderTechnicalSettings(analysis) {
  const container = document.querySelector("#technical-analysis-settings");
  if (!container) return;

  const sourceDetails = element("details");
  const sourceBody = element("div", "details-body");
  sourceDetails.append(
    element("summary", "", "사용한 공공데이터 출처"),
    sourceBody,
  );
  sourceBody.append(sourceGrid(analysis?.dataSources));

  const ruleDetails = element("details");
  const ruleBody = element("div", "details-body");
  ruleDetails.append(
    element("summary", "", "작물별 판정 기준과 한계"),
    ruleBody,
  );
  ruleBody.append(
    element(
      "p",
      "",
      "같은 농장 위치의 날씨 원자료는 모든 작물에 공통으로 사용합니다. 작물과 생육 단계에 따라 위험 기준과 필요한 행동만 달라집니다.",
    ),
    element(
      "p",
      "",
      "필지 토양검정값은 모든 작물에 동일하게 사용합니다. 필지 검정값이 없을 때만 과수원·밭 지역통계를 구분하고, 각 작물의 적정 범위로 해석합니다.",
    ),
    limitationList(analysis?.limitations),
    element(
      "p",
      "muted",
      `규칙 버전 · ${analysis?.ruleVersion ?? "제공되지 않음"}`,
    ),
  );

  container.replaceChildren(sourceDetails, ruleDetails);
}

function renderReportPanel(panel, analysis) {
  const header = element("div", "backend-report-header");
  const heading = element("h2", "", "핵심 요약");
  const button = element("button", "button button-secondary", "설명 다시 시도");
  button.type = "button";
  button.id = "backend-report-button";
  const reportState = analysis?.report?.state ?? "NOT_REQUESTED";
  button.disabled = reportState === "PENDING";
  button.hidden = true;
  button.addEventListener("click", () => {
    void requestAndPollReport(button);
  });
  header.append(heading, button);
  const status = element(
    "p",
    "backend-report-status",
    reportState === "PENDING"
      ? "설명을 준비하고 있습니다."
      : "설명을 준비하지 못했습니다.",
  );
  status.hidden = ["READY", "FALLBACK"].includes(reportState);
  status.id = "backend-report-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const content = element("div", "backend-report-content");
  content.id = "backend-report-content";
  content.append(element("p", "", forecastUserSummary(analysis)));
  const displayAction = resolveDisplayAction(analysis);
  const action = element("div", "primary-action-card");
  action.append(
    element("span", "", displayAction.status),
    element("strong", "", displayAction.title),
  );
  content.append(action);
  panel.replaceChildren(header, status, content);
}

async function requestAndPollReport(button, { automatic = false } = {}) {
  if (!currentAnalysis?.analysisId) return;
  const targetAnalysisId = currentAnalysis.analysisId;
  setBusy(button, true, "설명 준비 중…");
  const status = document.querySelector("#backend-report-status");
  status.textContent = automatic
    ? "분석이 끝나 자동으로 쉬운 설명을 준비하고 있습니다."
    : "쉬운 설명을 다시 요청했습니다.";

  try {
    let targetAnalysis = await api.requestReport(targetAnalysisId);
    storeUpdatedAnalysis(targetAnalysis, targetAnalysisId);
    if (isCurrentAnalysis(targetAnalysisId)) renderMetricStrip(targetAnalysis);
    if (["READY", "FALLBACK"].includes(targetAnalysis?.report?.state)) {
      if (isCurrentAnalysis(targetAnalysisId)) {
        renderActionsAndReport(targetAnalysis);
      }
      await persistReadyReport(targetAnalysis);
      announce("판단 보고서가 준비되었습니다.");
      return;
    }
    for (const delayMs of REPORT_POLL_DELAYS_MS) {
      await delay(delayMs);
      targetAnalysis = await api.getAnalysis(targetAnalysisId);
      storeUpdatedAnalysis(targetAnalysis, targetAnalysisId);
      if (isCurrentAnalysis(targetAnalysisId)) {
        status.textContent = `보고서 상태 · ${stateLabel(targetAnalysis?.report?.state)}`;
      }
      if (["READY", "FALLBACK"].includes(targetAnalysis?.report?.state)) {
        if (isCurrentAnalysis(targetAnalysisId)) {
          renderMetricStrip(targetAnalysis);
          renderActionsAndReport(targetAnalysis);
        }
        await persistReadyReport(targetAnalysis);
        announce("판단 보고서가 준비되었습니다.");
        return;
      }
    }
    status.textContent =
      "보고서 생성이 계속 진행 중입니다. 잠시 뒤 다시 확인해 주세요.";
    button.textContent = "상태 다시 확인";
  } catch (error) {
    status.textContent = errorMessage(error);
    button.hidden = false;
    button.textContent = "설명 다시 시도";
  } finally {
    setBusy(button, false, button.textContent);
  }
}

async function persistReadyReport(analysis) {
  const scope = currentFeatureScope(analysis);
  if (!connected || !scope || !["READY", "FALLBACK"].includes(analysis?.report?.state)) {
    return false;
  }
  try {
    await api.saveReportHistory(scope.farmId, {
      analysisId: analysis.analysisId,
      cropId: scope.cropId,
      seasonId: scope.seasonId,
    });
    await refreshReportHistory(analysis);
    return true;
  } catch (error) {
    if (error?.code !== "FEATURE_NOT_CONFIGURED") {
      const status = document.querySelector("#report-history-status");
      if (status) status.textContent = "이번 분석 리포트는 화면에서 볼 수 있지만 기록에는 저장하지 못했습니다.";
    }
    return false;
  }
}

function isCurrentAnalysis(analysisId) {
  return currentAnalysis?.analysisId === analysisId;
}

function storeUpdatedAnalysis(analysis, expectedAnalysisId) {
  if (analysis?.analysisId !== expectedAnalysisId) return;
  const crop = analysis?.inputSummary?.crop;
  if (crop) currentAnalyses.set(crop, analysis);
  if (isCurrentAnalysis(expectedAnalysisId)) currentAnalysis = analysis;
  writeAnalysisSnapshot([...currentAnalyses.values()]);
  renderCropResultSwitcher();
}

function sourceGrid(sources) {
  const grid = element("div", "source-grid");
  const safeSources = Array.isArray(sources) ? sources : [];
  if (safeSources.length === 0) {
    grid.append(
      element(
        "p",
        "backend-empty",
        "백엔드가 공개한 출처가 없습니다. 출처 없는 값을 추측해 표시하지 않습니다.",
      ),
    );
    return grid;
  }
  safeSources.forEach((source) => {
    const card = element("article", "source-card");
    const heading = element("h3");
    heading.append(
      document.createTextNode(source.sourceName ?? source.sourceId ?? "자료 출처"),
      element(
        "span",
        `status-label ${sourceTone(source)}`,
        sourceStateLabel(source),
      ),
    );
    const details = element("dl");
    appendDefinition(details, "자료 시각", formatSourceTime(source));
    appendDefinition(
      details,
      "공간 범위",
      [
        source.spatialLabel ?? source.spatialLevel,
        Number.isFinite(source.distanceKm)
          ? `${formatNumber(source.distanceKm)}km`
          : null,
      ]
        .filter(Boolean)
        .join(" · ") || "제공되지 않음",
    );
    appendDefinition(
      details,
      "전달 상태",
      `${source.deliveryState ?? "UNKNOWN"} · ${source.adapterState ?? "UNKNOWN"}`,
    );
    card.append(heading, details);
    if (isSafeHttpUrl(source.sourceUrl)) {
      const link = element("a", "backend-source-link", "원문 출처 열기");
      link.href = source.sourceUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      card.append(link);
    }
    grid.append(card);
  });
  return grid;
}

function evidenceTable(evidence) {
  const wrapper = element("div");
  const table = element("table", "calc-table backend-evidence-table");
  const caption = element(
    "caption",
    "sr-only",
    "백엔드가 반환한 모듈별 분석 근거",
  );
  const head = element("thead");
  const headRow = element("tr");
  ["모듈", "항목", "값·기준", "사용 상태", "출처"].forEach((label) => {
    const cell = element("th", "", label);
    cell.scope = "col";
    headRow.append(cell);
  });
  head.append(headRow);
  const body = element("tbody");
  evidence.forEach((item) => {
    const row = element("tr");
    appendTableCell(row, "모듈", item.module ?? "UNKNOWN");
    appendTableCell(row, "항목", item.metric ?? item.evidenceId ?? "근거");
    appendTableCell(
      row,
      "값·기준",
      [
        formatEvidenceValue(item.value, item.unit),
        item.reference == null ? null : `기준 ${formatValue(item.reference)}`,
      ]
        .filter(Boolean)
        .join(" · ") || "값 없음",
    );
    appendTableCell(
      row,
      "사용 상태",
      [
        item.inclusion ?? "UNKNOWN",
        item.exclusionReason,
        item.evidenceStatus,
      ]
        .filter(Boolean)
        .join(" · "),
    );
    const sourceCell = appendTableCell(
      row,
      "출처",
      item.sourceName ?? "제공되지 않음",
    );
    sourceCell.append(
      element("code", "", ` ${item.evidenceId ?? ""}`),
    );
    body.append(row);
  });
  table.append(caption, head, body);
  wrapper.append(table);
  return wrapper;
}

function reportSections(report) {
  const sections = [];
  const summary = report?.summary;
  if (textOf(summary) && isUserFacingReportItem(summary)) {
    const section = element("section");
    section.append(
      element("h3", "", "요약"),
      element("p", "", textOf(summary)),
    );
    sections.push(section);
  }
  [
    ["strengths", "확인된 강점"],
    ["risks", "확인할 위험"],
    ["nextActions", "다음 행동"],
  ].forEach(([key, label]) => {
    const items = Array.isArray(report?.[key])
      ? report[key]
          .filter(isUserFacingReportItem)
          .map(textOf)
          .filter(Boolean)
      : [];
    if (!items.length) return;
    const section = element("section");
    const list = element("ul", "reason-list");
    list.replaceChildren(...items.map((text) => element("li", "", text)));
    section.append(element("h3", "", label), list);
    sections.push(section);
  });
  return sections.length
    ? sections
    : [
        element(
          "p",
          "backend-empty",
          "예보를 다시 확인하면 필요한 점검 항목을 이곳에 표시합니다.",
        ),
      ];
}

function primaryDisplayAction(analysis) {
  const actions = Array.isArray(analysis?.actions)
    ? analysis.actions.filter(
        (action) =>
          isPrimaryUserAction(action) &&
          actionRelevantForDisplay(action, analysis),
      )
    : [];
  const primaryActionId = analysis?.primaryAction?.actionId;
  if (primaryActionId) {
    const matching = actions.find(
      (action) => action?.actionId === primaryActionId,
    );
    if (matching) return matching;
  }
  return actions[0] ?? null;
}

function actionRelevantForDisplay(action, analysis) {
  if (action?.actionId !== "REVIEW_CONDITION_EVIDENCE") return true;
  if (!hasRegionalReferenceCoverage(analysis)) return true;
  return (
    activeForecastRisks(analysis).length > 0 ||
    soilConditionGuide(analysis).tone === "caution"
  );
}

function isPrimaryUserAction(action) {
  return (
    isUserFacingAction(action) &&
    action?.actionId !== "REQUEST_FIELD_SOIL_TEST"
  );
}

function activeForecastRisks(analysis) {
  const risks = analysis?.forecast?.result?.risks;
  if (!Array.isArray(risks)) return [];
  const severityOrder = { WARNING: 0, CAUTION: 1, INFO: 2 };
  return risks
    .filter(
      (risk) =>
        risk &&
        risk.sourceFreshness === "CURRENT" &&
        typeof risk.dateRange?.from === "string",
    )
    .toSorted(
      (left, right) =>
        (severityOrder[left.severity] ?? 9) -
          (severityOrder[right.severity] ?? 9) ||
        left.dateRange.from.localeCompare(right.dateRange.from),
    );
}

function forecastRiskGuide(analysis) {
  const risk = activeForecastRisks(analysis)[0] ?? null;
  const days = forecastDisplayDays(analysis);
  const evaluation = summarizeForecastEvaluation({
    crop: analysis?.inputSummary?.crop,
    forecastState:
      analysis?.forecast?.result?.riskState ?? analysis?.forecast?.state,
    days,
    risks: activeForecastRisks(analysis),
    missingMetrics: analysis?.forecast?.result?.missingMetrics,
    ruleEvaluations: analysis?.forecast?.result?.ruleEvaluations,
  });
  const regional =
    analysis?.inputSummary?.locationPrecision === "ADMIN_AREA_BROAD";
  const scopeCaveat = regional
    ? "시·군 대표 예보이며 실제 밭의 관측값이 아닙니다."
    : null;
  if (!risk) {
    return {
      risk: false,
      ready: evaluation.ready,
      bounded: evaluation.bounded,
      evaluationKind: evaluation.kind,
      evaluatedDayCount: evaluation.evaluatedDayCount,
      regional,
      tone: evaluation.tone,
      condition: evaluation.condition,
      reason: evaluation.reason,
      actions: evaluation.actions,
      recheck: evaluation.recheck,
      caveat: scopeCaveat,
      sourceUrl: null,
    };
  }
  const guidance = risk.guidance ?? {};
  return {
    risk: true,
    ready: true,
    regional,
    tone: risk.severity === "WARNING" ? "danger" : "caution",
    title: guidance.headline ?? "예보 위험 전에 농장 상태 확인",
    condition: riskTriggerSummary(risk),
    reason:
      guidance.reason ??
      "작물별 검수 기준을 벗어나는 예보값이 확인됐습니다.",
    actions: Array.isArray(guidance.actions) ? guidance.actions : [],
    recheck:
      guidance.recheck ??
      "예보가 갱신되는 날과 위험 기상이 지난 다음 날에 다시 확인합니다.",
    caveat: scopeCaveat,
    sourceUrl: guidance.sourceUrl ?? null,
    severity: risk.severity,
  };
}

function forecastRiskCause(analysis, action = null) {
  const risks = activeForecastRisks(analysis);
  const triggerIds = new Set(
    (Array.isArray(action?.triggerIds) ? action.triggerIds : [])
      .filter((value) => typeof value === "string"),
  );
  const risk =
    risks.find((item) => triggerIds.has(item.riskId)) ?? risks[0];
  const reading = Array.isArray(risk?.trigger?.readings)
    ? risk.trigger.readings.find((item) => Number.isFinite(item?.value))
    : null;
  if (!risk || !reading) return null;
  return riskTriggerSummary(risk);
}

function soilConditionGuide(analysis) {
  const soil = analysis?.soil;
  const missingSoilExamHistory = analysisHasMissingSoilExamHistory(analysis);
  if (soil?.state === "NOT_APPLICABLE") {
    return {
      ready: true,
      tone: "info",
      condition: "토양 대신 양액 pH·EC 확인",
      reason:
        "수경 재배는 지역 토양 통계가 재배환경을 나타내지 않습니다. 시설 센서의 양액 pH와 EC가 필요합니다.",
      caveat: "지역 통계는 실제 시설의 측정값이 아닙니다.",
      actions: [
        "시설 센서에서 현재 양액 pH와 EC를 확인해 기록합니다.",
      ],
      sourceUrl: null,
    };
  }

  const metrics = Array.isArray(soil?.result?.metrics)
    ? soil.result.metrics
    : [];
  const fieldProfile =
    soil?.result?.fieldProfile?.parcelMatched === true
      ? soil.result.fieldProfile
      : null;
  const ph = metrics.find((metric) => metric?.metric === "PH");

  // 필지 토양검정이 판단 근거이면 지역 분포 문구를 쓰지 않는다.
  const measurementBasis = soil?.result?.measurementBasis;
  if (
    ["USER_SOIL_TEST", "PROVIDER_SOIL_TEST"].includes(measurementBasis) &&
    ph
  ) {
    const userMeasured = soil.result.userSoilTest ?? {};
    const providerMeasured = soil.result.providerSoilTest ?? {};
    const providerValues = Object.fromEntries(
      (providerMeasured.measurements ?? []).map((item) => [
        item.metric,
        item.value,
      ]),
    );
    const valueFor = (metric) =>
      measurementBasis === "USER_SOIL_TEST"
        ? userMeasured[SOIL_METRIC_FIELDS[metric]]
        : providerValues[metric];
    const measuredPh = valueFor("PH");
    const withinRange = ph.fitRatio >= 1;
    // 검수된 규칙으로 실제 판정된 항목만 적는다. 판정 못 한 값은 세지 않는다.
    const judged = metrics.map((metric) => ({
      label: SOIL_METRIC_LABELS[metric.metric] ?? metric.metric,
      inside: metric.fitRatio >= 1,
      range: metricOptimalRange(soil, metric.ruleId),
      value: valueFor(metric.metric) ?? null,
    }));
    const outside = judged.filter((item) => !item.inside);
    const phRange = judged.find((item) => item.label === "산도 pH")?.range ?? null;

    return {
      ready: true,
      tone: outside.length === 0 ? "good" : "caution",
      condition: `내 밭 pH ${measuredPh} · ${
        outside.length === 0
          ? `검사 ${judged.length}개 항목 모두 기준 안`
          : `${outside.length}개 항목 기준 밖`
      }`,
      reason:
        `${
          measurementBasis === "USER_SOIL_TEST"
            ? "등록하신"
            : "농촌진흥청에서 확인한 최근"
        } 토양검정 결과로 판단했습니다. 산도 pH ${measuredPh}는 ${
          phRange ? `기준 ${phRange[0]}~${phRange[1]} ` : "작물 기준 "
        }${withinRange ? "안입니다." : "밖입니다."} ` +
        (outside.length === 0
          ? `함께 등록한 ${judged.length - 1}개 항목(${judged
              .filter((item) => item.label !== "산도 pH")
              .map((item) => item.label)
              .join(" · ")})도 모두 기준 안입니다.`
          : `기준을 벗어난 항목: ${outside
              .map(
                (item) =>
                  `${item.label} ${item.value ?? ""}${
                    item.range ? ` (기준 ${item.range[0]}~${item.range[1]})` : ""
                  }`,
              )
              .join(" · ")}.`),
      caveat: `${
        measurementBasis === "USER_SOIL_TEST"
          ? userMeasured.sampledOn
          : providerMeasured.sampledOn
      } 검사${
        measurementBasis === "USER_SOIL_TEST" && userMeasured.issuer
          ? ` · ${userMeasured.issuer}`
          : providerMeasured.examType
            ? ` · ${providerMeasured.examType}`
            : ""
      } 기준입니다. 지역 평균이 아니라 이 필지의 실측값입니다.`,
      actions:
        outside.length === 0
          ? [
              "현재 토양 관리 기록과 검정기관 처방서의 작물별 시비 기준을 유지합니다.",
            ]
          : [
              `처방서에서 ${outside
                .map((item) => item.label)
                .join(" · ")} 관련 시용량을 확인해 조정합니다.`,
            ],
      verificationActions: [
        "토양을 조정했다면 다음 작기 전에 다시 검사해 변화를 확인합니다.",
      ],
      sourceUrl:
        measurementBasis === "PROVIDER_SOIL_TEST"
          ? soilExamSourceUrl(analysis)
          : null,
    };
  }

  if (fieldProfile) {
    const regionalPhSummary = ph
      ? ` 지역 pH 통계에서 기준 밖 면적은 ${formatPercent(ph.outsideRatio)}입니다.`
      : "";
    return {
      ready: true,
      tone:
        missingSoilExamHistory || ph?.outsideRatio > 0
          ? "caution"
          : "info",
      condition: missingSoilExamHistory
        ? "토양검정 이력 없음"
        : "필지 배수·토성·뿌리층 자료 확인됨",
      reason:
        missingSoilExamHistory
          ? `토양검정 화학성 상세정보 V2에서 이 필지의 최근 3년 이내 검사 결과를 찾지 못했습니다. 1:5,000 토양도의 배수·토성·유효토심 자료만 확인됐습니다.${regionalPhSummary}`
          : `선택한 필지의 1:5,000 토양도에서 배수등급, 표토 토성, 유효토심 자료를 확인했습니다.${regionalPhSummary}`,
      caveat:
        "토양도는 필지 토양의 물리 특성 참고자료이며, pH·EC는 최근 토양검정 결과로 별도 확인해야 합니다.",
      actions: [
        "비가 온 뒤 물이 오래 고이는 곳과 흙이 단단해 뿌리가 막히는 곳을 현장에서 확인합니다.",
      ],
      verificationActions: [
        "최근 토양검정 결과에서 pH와 EC를 확인합니다.",
        "필지 토양도에서 배수·토성·뿌리층 정보를 함께 확인합니다.",
      ],
      sourceUrl: soilFieldSourceUrl(analysis) ?? soilSourceUrl(analysis),
    };
  }
  if (ph && ["READY", "PARTIAL"].includes(soil?.state)) {
    const fit = formatPercent(ph.fitRatio);
    const uncertain = formatPercent(ph.uncertainRatio);
    const outside = formatPercent(ph.outsideRatio);
    const regionalBasis = regionalSoilBasisLabel(analysis);
    return {
      ready: true,
      tone:
        missingSoilExamHistory || ph.outsideRatio > 0
          ? "caution"
          : "good",
      condition:
        missingSoilExamHistory
          ? "토양검정 이력 없음"
          : ph.outsideRatio > 0
          ? `${regionalBasis} · 기준 밖 면적 ${outside}`
          : `${regionalBasis} · 기준 범위 면적 ${fit}`,
      reason:
        `${
          missingSoilExamHistory
            ? "토양검정 화학성 상세정보 V2에서 이 필지의 최근 3년 이내 검사 결과를 찾지 못했습니다. 대신 "
            : ""
        }${regionalBasis}를 이 작물의 pH 적정 범위와 비교했습니다. 기준과 겹치는 면적은 ${fit}, 경계에 걸친 면적은 ${uncertain}, 기준 밖 면적은 ${outside}입니다.`,
      caveat:
        `${regionalBasis}이며 실제 밭의 pH·EC 측정값이 아닙니다. 같은 위치라도 과수원·밭 통계와 작물별 적정 범위가 달라 해석이 달라질 수 있습니다.`,
      actions: [],
      verificationActions: [
        "실제 밭의 토양검정 결과에서 pH와 EC를 확인합니다.",
        "검정 결과가 없다면 가까운 농업기술센터에 토양검정을 신청합니다.",
      ],
      sourceUrl: soilSourceUrl(analysis),
    };
  }

  return {
    ready: false,
    tone: "unknown",
    condition: missingSoilExamHistory
      ? "토양검정 이력 없음"
      : "농장 토양 pH·EC 미확인",
    reason:
      missingSoilExamHistory
        ? "토양검정 화학성 상세정보 V2에서 이 필지의 최근 3년 이내 검사 결과를 찾지 못했습니다. 실제 밭의 pH와 EC는 무료 토양검정으로 확인할 수 있습니다."
        : "현재 연결 자료에서 농장 토양의 pH와 EC를 확인하지 못했습니다. 토양 상태를 임의로 추정하지 않습니다.",
    caveat: "지역 통계는 실제 밭의 측정값이 아닙니다.",
    actions: [],
    verificationActions: [
      "기존 토양검정 결과가 있다면 pH와 EC 값을 등록합니다.",
      "검정 결과가 없다면 가까운 농업기술센터에 토양검정을 신청합니다.",
    ],
    sourceUrl: soilSourceUrl(analysis),
  };
}

function regionalSoilBasisLabel(analysis) {
  const crop = analysis?.inputSummary?.crop;
  const region = analysis?.inputSummary?.regionLabel?.trim();
  const landUse = ["APPLE", "PEAR"].includes(crop) ? "과수원" : "밭";
  return `${region ? `${region} ` : ""}${landUse} 지역 pH 통계`;
}

function soilFieldSourceUrl(analysis) {
  const source = (analysis?.dataSources ?? []).find((item) =>
    /soil-field|토양특성/iu.test(
      `${item?.sourceId ?? ""} ${item?.sourceName ?? ""}`,
    ),
  );
  return isSafeHttpUrl(source?.sourceUrl) ? source.sourceUrl : null;
}

function soilExamSourceUrl(analysis) {
  const source = (analysis?.dataSources ?? []).find((item) =>
    /soil-exam|토양검정/iu.test(
      `${item?.sourceId ?? ""} ${item?.sourceName ?? ""}`,
    ),
  );
  return isSafeHttpUrl(source?.sourceUrl) ? source.sourceUrl : null;
}

function soilSourceUrl(analysis) {
  const source = (analysis?.dataSources ?? []).find((item) =>
    /soil|토양|화학성/iu.test(`${item?.sourceId ?? ""} ${item?.sourceName ?? ""}`),
  );
  return isSafeHttpUrl(source?.sourceUrl) ? source.sourceUrl : null;
}

function riskTriggerSummary(risk) {
  const trigger = risk?.trigger ?? {};
  const readings = Array.isArray(trigger.readings) ? trigger.readings : [];
  const reading =
    readings.find((item) => Number.isFinite(item?.value)) ?? readings[0] ?? null;
  const metricLabels = {
    minTemperature: "최저기온",
    maxTemperature: "최고기온",
    precipitationProbability: "강수확률",
    precipitationAmount: "강수량",
    windSpeed: "풍속",
  };
  const metric = metricLabels[trigger.metric] ?? "예보값";
  const value = Number.isFinite(reading?.value)
    ? `${formatNumber(reading.value)}${displayUnit(trigger.unit)}`
    : "예보값 없음";
  const threshold = comparisonSummary(trigger.comparison, trigger.unit);
  const date = reading?.date
    ? formatExplicitForecastDate(reading.date)
    : formatExplicitForecastDate(risk?.dateRange?.from);
  return [date, `${metric} ${value}`, threshold].filter(Boolean).join(" · ");
}

function comparisonSummary(comparison, unit) {
  if (!comparison || typeof comparison !== "object") return "";
  const suffix = displayUnit(unit);
  const labels = {
    GT: "초과",
    GTE: "이상",
    LT: "미만",
    LTE: "이하",
  };
  if (labels[comparison.operator] && Number.isFinite(comparison.threshold)) {
    return `주의 기준 ${formatNumber(comparison.threshold)}${suffix} ${labels[comparison.operator]}`;
  }
  if (
    comparison.operator === "BETWEEN" &&
    Number.isFinite(comparison.lower) &&
    Number.isFinite(comparison.upper)
  ) {
    return `주의 범위 ${formatNumber(comparison.lower)}~${formatNumber(comparison.upper)}${suffix}`;
  }
  return "";
}

function displayUnit(unit) {
  const units = {
    "℃": "℃",
    degC: "℃",
    "%": "%",
    mm: "mm",
    "m/s": "m/s",
  };
  return units[unit] ?? (unit ? ` ${unit}` : "");
}

function formatPercent(ratio) {
  return Number.isFinite(ratio)
    ? `${Math.round(ratio * 100)}%`
    : "자료 없음";
}

function uniqueText(values) {
  return [
    ...new Set(
      values.filter((value) => typeof value === "string" && value.trim()),
    ),
  ];
}

function resolveDisplayAction(analysis) {
  const summary = analysis?.inputSummary ?? {};
  const primary = primaryDisplayAction(analysis);
  const days = forecastDisplayDays(analysis);
  const facility = summary.cultivationMode !== "OPEN_FIELD";
  const cropLabel = CROP_LABELS[summary.crop] ?? "작물";
  const riskGuide = forecastRiskGuide(analysis);
  const irrigationGuide = irrigationActionGuide(analysis);

  if (
    primary?.actionId === "CHECK_SOIL_MOISTURE_AND_IRRIGATE" &&
    irrigationGuide
  ) {
    return {
      title: irrigationGuide.title,
      detail: irrigationGuide.reason,
      status: primary.severity === "WARNING" ? "우선 확인" : "주의",
      actions: irrigationGuide.actions,
    };
  }

  if (riskGuide.risk) {
    return {
      title: riskGuide.title,
      detail: `${riskGuide.condition}. ${riskGuide.reason}`,
      status: riskGuide.severity === "WARNING" ? "우선 확인" : "주의",
      actions: riskGuide.actions,
    };
  }
  if (primary) {
    return {
      title: userActionTitle(primary, analysis) ?? "농장 상태 확인",
      detail: actionDetail(primary.actionId, analysis),
      status: primary.severity === "WARNING" ? "우선 확인" : "오늘 확인",
      actions: [],
    };
  }
  if (facility) {
    return {
      title: "시설 내부 온도 센서와 환기 상태 확인",
      detail: days.length
        ? "실외 예보는 도착했습니다. 시설 내부 값은 센서와 현장 상태로 직접 확인해 주세요."
        : "실외 예보가 부족합니다. 시설 내부 값은 센서와 현장 상태로 직접 확인해 주세요.",
      status: "오늘 확인",
      actions: [],
    };
  }
  if (days.length > 0) {
    return {
      title: `${cropLabel}의 이번 주 기온·강수 변화 확인`,
      detail:
        "예보 수치는 확인됐습니다. 검토된 위험 신호가 생기면 해당 날짜와 점검 항목을 먼저 표시합니다.",
      status: "예보 확인",
      actions: [],
    };
  }
  return {
    title: "농장 위치를 확인한 뒤 예보 다시 받기",
    detail: "현재 예보가 없습니다. 정확한 위치를 확인하고 같은 조건으로 다시 분석해 주세요.",
    status: "재확인",
    actions: [],
  };
}

function isUserFacingAction(action) {
  return !["COLLECT_REQUIRED_DATA", "REQUEST_FIELD_SOIL_TEST"].includes(
    action?.actionId,
  );
}

function userActionTitle(action, analysis = null) {
  if (!action || !isUserFacingAction(action)) return null;
  const cropLabel =
    CROP_LABELS[analysis?.inputSummary?.crop] ?? "작물";
  const labels = {
    CONFIRM_SEASON: "재배 시기 확인 후 다시 분석",
    REVIEW_CONDITION_EVIDENCE: "기후·토양 주의 항목 확인",
    REQUEST_FIELD_SOIL_TEST: "농업기술센터 토양검정 신청",
    CHECK_CURRENT_FORECAST_RISK: `${cropLabel} 예보 위험 전 농장 상태 확인`,
    CHECK_SOIL_MOISTURE_AND_IRRIGATE: "고온 전 토양 수분 확인·관수",
    CHECK_FACILITY_WEATHER: "시설 외기와 내부 온도·환기 상태 확인",
    CHECK_INTERNAL_SENSORS: "시설 내부 온도 센서와 환기 상태 확인",
  };
  return labels[action.actionId] ?? action.title ?? null;
}

function actionDetail(actionId, analysis) {
  const days = forecastDisplayDays(analysis).slice(0, 7);
  const period = days.length ? `${days.length}일 기상청 예보` : "현재 자료";
  if (actionId === "CONFIRM_SEASON") {
    return "재배 시기와 현재 생육 단계를 확인한 뒤 다시 분석해 작물별 시기 기준을 적용합니다.";
  }
  if (actionId === "CHECK_CURRENT_FORECAST_RISK") {
    return `${period}에서 검토된 작물 기준의 주의 신호가 확인됐습니다. 해당 날짜의 작물 상태를 먼저 확인해 주세요.`;
  }
  if (actionId === "CHECK_SOIL_MOISTURE_AND_IRRIGATE") {
    return irrigationActionGuide(analysis)?.reason ??
      "고온이 오기 전 뿌리 주변 토양 수분을 확인하고, 실제로 마른 경우에만 관수합니다.";
  }
  if (actionId === "CHECK_FACILITY_WEATHER") {
    return `${period}의 외기 위험 신호와 시설 내부 온도·환기 상태를 함께 확인해 주세요.`;
  }
  if (actionId === "CHECK_INTERNAL_SENSORS") {
    return `${period}는 실외 기준입니다. 시설 내부 온도 센서와 환기 상태를 직접 확인해 주세요.`;
  }
  if (actionId === "REQUEST_FIELD_SOIL_TEST") {
    return "지역 토양자료는 필지 실측값이 아닙니다. 실제 밭의 토양검정 결과로 확인해 주세요.";
  }
  return "분석 근거를 열어 확인된 값과 필요한 현장 점검을 함께 확인해 주세요.";
}

function forecastUserSummary(analysis) {
  const days = forecastDisplayDays(analysis);
  if (!days.length) {
    return "현재 예보 확인이 필요합니다. 정확한 농장 위치를 확인하거나 잠시 후 다시 분석해 주세요.";
  }
  const highs = days
    .map((day) => day.maxTemperature)
    .filter(Number.isFinite);
  const rain = days
    .map((day) => day.precipitationProbability)
    .filter(Number.isFinite);
  const temperatureCopy = highs.length
    ? `최고기온 ${formatNumber(Math.min(...highs))}~${formatNumber(Math.max(...highs))}℃`
    : "기온 자료 없음";
  const rainCopy = rain.length
    ? `최대 강수확률 ${formatNumber(Math.max(...rain))}%`
    : "강수확률 자료 없음";
  return `앞으로 ${days.length}일 ${temperatureCopy}, ${rainCopy}입니다.`;
}

function isUserFacingReportItem(item) {
  const actionIds = Array.isArray(item?.actionIds) ? item.actionIds : [];
  return !actionIds.includes("COLLECT_REQUIRED_DATA");
}

function actionList(
  actions,
  className = "backend-action-list",
  analysis = null,
) {
  const safeActions = Array.isArray(actions) ? actions : [];
  if (!safeActions.length) {
    return element(
      "p",
      "backend-empty",
      "추가로 확인할 항목이 없습니다.",
    );
  }
  const list = element("ol", className);
  list.replaceChildren(
    ...safeActions.map((action) => {
      const item = element(
        "li",
        "",
        userActionTitle(action, analysis) ?? "농장 상태 확인",
      );
      if (action.actionId) item.dataset.actionId = action.actionId;
      return item;
    }),
  );
  return list;
}

function limitationList(limitations) {
  const safeLimitations = Array.isArray(limitations) ? limitations : [];
  if (!safeLimitations.length) {
    return element(
      "p",
      "backend-empty",
      "백엔드가 별도 한계를 반환하지 않았습니다. 지역 자료는 필지 실측값이 아닙니다.",
    );
  }
  const list = element("ul", "reason-list");
  list.replaceChildren(
    ...safeLimitations.map((limitation) =>
      element("li", "", limitationLabel(limitation)),
    ),
  );
  return list;
}

function closeWizardAfterAnalysis() {
  onboarding.hidden = true;
  document.querySelector(".app-shell").inert = false;
  document.querySelector(".skip-link").inert = false;
  document.body.classList.remove("wizard-open");
  document.body.classList.remove("session-restoring", "session-restore-failed");
  document.body.classList.add("analysis-ready");
  document.body.dataset.profileState = "ready";
  document
    .querySelector('[data-view="dashboard"]')
    ?.click();
  announce("백엔드 분석을 완료했습니다. 자료 상태와 다음 행동을 확인해 주세요.");
}

function resetDashboard() {
  const title = document.querySelector("#dashboard-title");
  if (title) title.textContent = "분석 결과 대기";
  const summary = document.querySelector(".summary-panel");
  if (summary) {
    summary.replaceChildren(
      element(
        "p",
        "backend-empty",
        "지역과 작물을 입력해 백엔드 분석을 시작해 주세요.",
      ),
    );
  }
}

function renderStoredSessionLoading(saved) {
  const region = saved.region.trim();
  const crops = saved.crops
    .map((crop) => CROP_LABELS[String(crop).toUpperCase()] ?? crop)
    .join(", ");
  const context = [region, crops].filter(Boolean).join(" · ");
  document.querySelector("#sidebar-context-value").textContent = context;
  document.querySelector("#topbar-context-value").textContent = context;
  document.querySelector("#sidebar-mode-value").textContent =
    saved.situation === "growing"
      ? "재배 중 생육 점검"
      : "재배 준비 진단";
  document.querySelector("#dashboard-title").textContent =
    `${context} 최신 자료 확인 중`;
  document.querySelector("#dashboard-mode-copy").textContent =
    "저장된 농장 설정으로 기상·토양·예보를 다시 확인하고 있습니다.";
  const summary = document.querySelector(".summary-panel");
  if (summary) {
    summary.replaceChildren(
      element(
        "p",
        "backend-empty",
        "농장 설정은 저장되어 있습니다. 최신 자료만 다시 불러옵니다.",
      ),
    );
  }
}

function initializeDashboardSurfaces() {
  const sidebarContext = document.querySelector("#sidebar-context-value");
  if (sidebarContext) sidebarContext.textContent = "분석 조건을 입력해 주세요";
  const sidebarMode = document.querySelector("#sidebar-mode-value");
  if (sidebarMode) sidebarMode.textContent = "익명 세션";
  const topbarContext = document.querySelector("#topbar-context-value");
  if (topbarContext) topbarContext.textContent = "분석 조건을 입력해 주세요";
  const dashboardMode = document.querySelector("#dashboard-mode-copy");
  if (dashboardMode) {
    dashboardMode.textContent =
      "지역·작물 입력 후 분석 결과가 표시됩니다.";
  }

  const recent = document.querySelector(".sidebar-recent");
  if (recent) renderFarmList(recent);
  const mobileFarmList = document.querySelector(".mobile-farm-list");
  if (mobileFarmList) renderFarmList(mobileFarmList, { includeHeading: false });
  setupMobileFarmDialog();

  renderRegionLabels();
  setupSoilTestPanel();
  setupAccountKeyPanel();
  setupNotificationPanel();
  setupReportHistory();
  setupSatelliteService();
  setupPhotoJournal();
  setupHarvestPhotoAssessment();
  renderDashboardSoilTest();
  const legacyDetailPanel = document
    .querySelector("#detail-map-title")
    ?.closest(".panel");
  if (legacyDetailPanel) legacyDetailPanel.hidden = true;
  const satellitePanel = document
    .querySelector("#satellite-title")
    ?.closest(".panel");
  if (satellitePanel) satellitePanel.hidden = true;
  const legacyScoreNotice = document.querySelector(
    'aside.notice[aria-label="참고지수 이용 안내"]',
  );
  if (legacyScoreNotice) legacyScoreNotice.hidden = true;
}

function setupReportHistory() {
  document.querySelector("#report-history-refresh")?.addEventListener("click", () => {
    void refreshReportHistory(currentAnalysis);
  });
}

async function refreshReportHistory(analysis) {
  const root = document.querySelector("#report-history-list");
  const status = document.querySelector("#report-history-status");
  const scope = currentFeatureScope(analysis);
  if (!root) return;
  if (!scope || !connected) {
    root.replaceChildren(
      element("p", "backend-empty", "농장 분석을 완료하면 저장된 리포트를 확인할 수 있습니다."),
    );
    return;
  }
  if (status) status.textContent = "저장된 리포트를 불러오는 중입니다.";
  try {
    const result = await api.listReportHistory(scope.farmId, {
      cropId: scope.cropId,
    });
    const reports = Array.isArray(result?.reports) ? result.reports : [];
    if (reports.length === 0) {
      root.replaceChildren(
        element("p", "backend-empty", "아직 저장된 리포트가 없습니다. 새 분석이 끝나면 자동으로 기록합니다."),
      );
    } else {
      root.replaceChildren(...reports.map((report) => reportHistoryCard(report, scope)));
    }
    if (status) status.textContent = `${reports.length}개 리포트를 농장별로 보관 중입니다.`;
  } catch (error) {
    root.replaceChildren(
      element(
        "p",
        "backend-empty",
        error?.code === "FEATURE_NOT_CONFIGURED"
          ? "리포트 기록 저장소가 아직 설정되지 않았습니다. 현재 분석 화면은 그대로 사용할 수 있습니다."
          : "저장된 리포트를 불러오지 못했습니다.",
      ),
    );
    if (status) status.textContent = "리포트 기록을 확인하지 못했습니다.";
  }
}

function reportHistoryCard(report, scope) {
  const card = element("article", "report-history-card");
  const copy = element("div", "report-history-copy");
  copy.append(
    element("span", "service-eyebrow", formatDateTime(report.createdAt)),
    element("h3", "", report.headline ?? "농장 분석 리포트"),
    element(
      "p",
      "muted no-margin",
      Number.isFinite(report.score)
        ? `생육점수 ${report.score}점 · ${report.scoreLabel ?? "상태 기록"}`
        : "점수 없이 근거와 행동만 저장된 분석",
    ),
  );
  const download = element("button", "button button-secondary", "리포트 저장");
  download.type = "button";
  download.addEventListener("click", () => void downloadSavedReport(scope, report, download));
  card.append(copy, download);
  return card;
}

async function downloadSavedReport(scope, summary, button) {
  setBusy(button, true, "준비 중…");
  try {
    const report = await api.getSavedReport(scope.farmId, summary.reportId);
    const html = printableReportHtml(report);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `흙날씨-${safeFilenamePart(report?.inputSummary?.regionLabel)}-${safeFilenamePart(report?.cropCode)}-${String(report?.createdAt ?? "").slice(0, 10)}.html`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    announce("리포트를 저장했습니다.");
  } catch (error) {
    const status = document.querySelector("#report-history-status");
    if (status) status.textContent = errorMessage(error);
  } finally {
    setBusy(button, false, "리포트 저장");
  }
}

function printableReportHtml(report) {
  const score = Number.isFinite(report?.growthScore?.score)
    ? `${report.growthScore.score}점 · ${report.growthScore.label ?? ""}`
    : "산정되지 않음";
  const actions = (report?.actions ?? [])
    .map((action) => `<li>${escapeHtml(action?.title ?? "확인 항목")}</li>`)
    .join("");
  const sources = (report?.dataSources ?? [])
    .map((source) => `<li>${escapeHtml(source?.sourceName ?? source?.sourceId ?? "출처")}</li>`)
    .join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>흙날씨 농장 리포트</title><style>body{font-family:system-ui,sans-serif;max-width:820px;margin:48px auto;padding:0 24px;color:#14251b;line-height:1.65}header{border-bottom:2px solid #174c2d;padding-bottom:20px}h1{font-size:2rem}.score{font-size:2.5rem;font-weight:800;color:#174c2d}.card{margin:24px 0;padding:20px;border:1px solid #dce6df;border-radius:16px}small{color:#5b6b61}@media print{body{margin:0}.card{break-inside:avoid}}</style></head><body><header><small>흙날씨 농지 진단 AI</small><h1>${escapeHtml(report?.inputSummary?.regionLabel ?? "농장")} · ${escapeHtml(CROP_LABELS[report?.cropCode] ?? report?.cropCode ?? "작물")}</h1><p>${escapeHtml(formatDateTime(report?.createdAt))}</p><div class="score">${escapeHtml(score)}</div></header><section class="card"><h2>현재 판단</h2><p>${escapeHtml(report?.decision?.headline ?? report?.report?.value?.summary?.text ?? "분석 기록")}</p></section><section class="card"><h2>필요한 행동</h2><ol>${actions || "<li>저장된 행동 없음</li>"}</ol></section><section class="card"><h2>사용한 자료</h2><ul>${sources || "<li>저장된 출처 없음</li>"}</ul></section><p><small>이 리포트는 저장 당시의 공공데이터와 검수 규칙을 기준으로 생성되었습니다. 규칙 버전: ${escapeHtml(report?.ruleVersion ?? "미표시")}</small></p></body></html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeFilenamePart(value) {
  return String(value ?? "기록").replace(/[^0-9A-Za-z가-힣_-]+/gu, "-").slice(0, 40);
}

function setupSatelliteService() {
  const useLocation = document.querySelector("#parcel-use-location");
  const farmmapMode = document.querySelector("#parcel-mode-farmmap");
  const squareMode = document.querySelector("#parcel-mode-square");
  const walkMode = document.querySelector("#parcel-mode-walk");
  const addCorner = document.querySelector("#parcel-add-corner");
  const undoCorner = document.querySelector("#parcel-undo-corner");
  const resetCorners = document.querySelector("#parcel-reset-corners");
  const farmmapSearch = document.querySelector("#parcel-farmmap-search");
  const save = document.querySelector("#parcel-save");
  const refresh = document.querySelector("#satellite-refresh");
  farmmapMode?.addEventListener("click", () => setParcelDraftMode("farmmap"));
  squareMode?.addEventListener("click", () => setParcelDraftMode("square"));
  walkMode?.addEventListener("click", () => setParcelDraftMode("walk"));
  useLocation?.addEventListener("click", () => void prepareParcelFromLocation());
  addCorner?.addEventListener("click", () => void addParcelCorner());
  undoCorner?.addEventListener("click", undoParcelCorner);
  resetCorners?.addEventListener("click", resetParcelCorners);
  farmmapSearch?.addEventListener("click", () => void searchFarmmapParcels());
  save?.addEventListener("click", () => void savePreparedParcel());
  refresh?.addEventListener("click", () => void refreshSatellite());
  setParcelDraftMode("farmmap", { preserveDraft: true });
  applySatelliteAvailability();
}

function satelliteIsAvailable() {
  return ["READY", "CONFIGURED_UNVERIFIED"].includes(
    preflight?.capabilities?.satellite,
  );
}

function farmmapIsAvailable() {
  return ["READY", "CONFIGURED_UNVERIFIED"].includes(
    preflight?.capabilities?.farmmap ?? preflight?.optionalAdapters?.farmmap,
  );
}

function applySatelliteAvailability() {
  const available = satelliteIsAvailable();
  const state = document.querySelector("#satellite-service-state");
  const status = document.querySelector("#parcel-status");
  const refresh = document.querySelector("#satellite-refresh");
  if (refresh) refresh.disabled = !available || !savedParcelAvailable;
  if (!available && state) {
    state.textContent = savedParcelAvailable ? "경계 저장됨" : "경계 등록 가능";
  }
  if (!available && status && currentAnalysis) {
    status.textContent =
      "필지 경계는 지금 저장할 수 있습니다. 위성 변화 확인은 연결 설정 후 사용할 수 있습니다.";
  }
  return available;
}

function setParcelDraftMode(mode, { preserveDraft = false } = {}) {
  parcelDraftMode = ["farmmap", "walk"].includes(mode) ? mode : "square";
  const farmmapMode = document.querySelector("#parcel-mode-farmmap");
  const squareMode = document.querySelector("#parcel-mode-square");
  const walkMode = document.querySelector("#parcel-mode-walk");
  farmmapMode?.classList.toggle("is-active", parcelDraftMode === "farmmap");
  squareMode?.classList.toggle("is-active", parcelDraftMode === "square");
  walkMode?.classList.toggle("is-active", parcelDraftMode === "walk");
  farmmapMode?.setAttribute("aria-pressed", String(parcelDraftMode === "farmmap"));
  squareMode?.setAttribute("aria-pressed", String(parcelDraftMode === "square"));
  walkMode?.setAttribute("aria-pressed", String(parcelDraftMode === "walk"));
  const farmmapControls = document.querySelector("#parcel-farmmap-controls");
  const squareControls = document.querySelector("#parcel-square-controls");
  const walkControls = document.querySelector("#parcel-walk-controls");
  if (farmmapControls) farmmapControls.hidden = parcelDraftMode !== "farmmap";
  if (squareControls) squareControls.hidden = parcelDraftMode !== "square";
  if (walkControls) walkControls.hidden = parcelDraftMode !== "walk";
  if (!preserveDraft) {
    pendingParcelGeometry = null;
    parcelDraftPoints = [];
    const save = document.querySelector("#parcel-save");
    if (save) save.disabled = true;
    updateParcelPreview(
      parcelDraftMode === "farmmap"
        ? "분석한 주소 주변의 팜맵 필지를 찾아 주세요"
        : parcelDraftMode === "walk"
        ? "첫 번째 농장 모서리에서 위치를 기록해 주세요"
        : "현재 위치 중심으로 경계를 만들어 주세요",
    );
  }
  updateParcelCornerControls();
}

async function searchFarmmapParcels() {
  const status = document.querySelector("#parcel-status");
  const button = document.querySelector("#parcel-farmmap-search");
  const list = document.querySelector("#parcel-farmmap-candidates");
  if (!currentAnalysis?.analysisId) {
    if (status) status.textContent = "먼저 상세 주소로 농장 분석을 완료해 주세요.";
    return;
  }
  if (!farmmapIsAvailable()) {
    if (status) {
      status.textContent = "팜맵 API 연결을 확인해 주세요. 간편 경계나 모서리 직접 기록은 계속 사용할 수 있습니다.";
    }
    return;
  }
  setBusy(button, true, "팜맵 필지 찾는 중…");
  try {
    const result = await api.searchFarmmapParcels(currentAnalysis.analysisId);
    const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
    if (candidates.length === 0) {
      list?.replaceChildren();
      if (status) status.textContent = "이 주소 주변에서 팜맵 필지를 찾지 못했습니다. 다른 경계 방식을 사용해 주세요.";
      return;
    }
    renderFarmmapCandidates(candidates);
    if (status) status.textContent = `${candidates.length}개 팜맵 필지를 찾았습니다. 실제 농장 경계를 선택해 주세요.`;
  } catch (error) {
    if (status) {
      status.textContent = error?.code === "EXACT_LOCATION_REQUIRED"
        ? "시·군·구가 아닌 지번 또는 도로명 상세 주소로 다시 분석해 주세요."
        : `팜맵 필지를 찾지 못했습니다. ${errorMessage(error)}`;
    }
  } finally {
    setBusy(button, false, "주변 팜맵 필지 찾기");
  }
}

function renderFarmmapCandidates(candidates) {
  const list = document.querySelector("#parcel-farmmap-candidates");
  if (!list) return;
  const items = candidates.flatMap((candidate, index) => {
    if (
      !candidate?.geometry ||
      !["Polygon", "MultiPolygon"].includes(candidate.geometry.type) ||
      !Number.isFinite(candidate.areaSquareMeters)
    ) {
      return [];
    }
    const item = document.createElement("li");
    const button = element("button", "farmmap-candidate");
    button.type = "button";
    const category = candidate.category ? ` · ${candidate.category}` : "";
    const address = candidate.representativeAddress ?? "분석 주소 주변 필지";
    button.append(
      element("strong", "", `필지 ${index + 1} · ${formatNumber(candidate.areaSquareMeters)}㎡${category}`),
      element("small", "", address),
    );
    button.addEventListener("click", () => {
      pendingParcelGeometry = structuredClone(candidate.geometry);
      parcelDraftPoints = [];
      const save = document.querySelector("#parcel-save");
      if (save) save.disabled = false;
      list.querySelectorAll(".farmmap-candidate").forEach((control) => {
        control.setAttribute("aria-pressed", String(control === button));
      });
      updateParcelPreview(`팜맵 필지 ${formatNumber(candidate.areaSquareMeters)}㎡ 선택됨`);
      const status = document.querySelector("#parcel-status");
      if (status) status.textContent = "선택한 농장 모양이 맞는지 확인한 뒤 경계를 저장해 주세요.";
    });
    item.append(button);
    return [item];
  });
  list.replaceChildren(...items);
}

async function prepareParcelFromLocation() {
  const status = document.querySelector("#parcel-status");
  const button = document.querySelector("#parcel-use-location");
  if (!currentAnalysis) {
    if (status) status.textContent = "먼저 농장 분석을 완료해 주세요.";
    return;
  }
  if (!navigator.geolocation) {
    if (status) status.textContent = "이 기기에서는 현재 위치를 사용할 수 없습니다.";
    return;
  }
  setBusy(button, true, "위치 확인 중…");
  try {
    const position = await getCurrentPosition();
    const size = Number(document.querySelector("#parcel-size")?.value ?? 100);
    pendingParcelGeometry = squareGeometry(
      position.coords.latitude,
      position.coords.longitude,
      size,
    );
    parcelDraftPoints = [];
    document.querySelector("#parcel-save").disabled = false;
    updateParcelPreview(`${size}m × ${size}m 간편 경계 준비됨`);
    if (status) {
      status.textContent =
        "경계를 저장하기 전에 실제 농장 안에서 만든 범위가 맞는지 확인해 주세요.";
    }
  } catch {
    if (status) status.textContent = "현재 위치를 확인하지 못했습니다. 위치 권한을 확인해 주세요.";
  } finally {
    setBusy(button, false, "현재 위치 중심으로 만들기");
  }
}

async function addParcelCorner() {
  const status = document.querySelector("#parcel-status");
  const button = document.querySelector("#parcel-add-corner");
  if (!currentAnalysis) {
    if (status) status.textContent = "먼저 농장 분석을 완료해 주세요.";
    return;
  }
  if (!navigator.geolocation) {
    if (status) status.textContent = "이 기기에서는 현재 위치를 사용할 수 없습니다.";
    return;
  }
  setBusy(button, true, "위치 기록 중…");
  try {
    const position = await getCurrentPosition();
    const point = [position.coords.longitude, position.coords.latitude];
    const previous = parcelDraftPoints.at(-1);
    if (previous && parcelPointDistanceMeters(previous, point) < 1) {
      if (status) status.textContent = "이전 모서리와 같은 위치입니다. 다음 모서리로 이동해 주세요.";
      return;
    }
    parcelDraftPoints.push(point);
    pendingParcelGeometry = parcelDraftPoints.length >= 3
      ? parcelGeometryFromCorners(parcelDraftPoints)
      : null;
    const save = document.querySelector("#parcel-save");
    if (save) save.disabled = !pendingParcelGeometry;
    const accuracy = Number(position.coords.accuracy);
    const accuracyCopy = Number.isFinite(accuracy)
      ? ` · 위치 정확도 약 ±${Math.round(accuracy)}m`
      : "";
    updateParcelPreview(
      parcelDraftPoints.length >= 3
        ? `모서리 ${parcelDraftPoints.length}곳으로 닫힌 경계 준비됨`
        : `모서리 ${parcelDraftPoints.length}곳 기록됨`,
    );
    updateParcelCornerControls();
    if (status) {
      status.textContent = parcelDraftPoints.length >= 3
        ? `경계 모양을 확인한 뒤 저장해 주세요${accuracyCopy}.`
        : `다음 농장 모서리로 이동해 위치를 추가해 주세요${accuracyCopy}.`;
    }
  } catch {
    if (status) status.textContent = "현재 위치를 기록하지 못했습니다. 위치 권한과 GPS 상태를 확인해 주세요.";
  } finally {
    setBusy(button, false, "현재 모서리 추가");
  }
}

function undoParcelCorner() {
  parcelDraftPoints.pop();
  pendingParcelGeometry = parcelDraftPoints.length >= 3
    ? parcelGeometryFromCorners(parcelDraftPoints)
    : null;
  const save = document.querySelector("#parcel-save");
  if (save) save.disabled = !pendingParcelGeometry;
  updateParcelPreview(
    parcelDraftPoints.length
      ? `모서리 ${parcelDraftPoints.length}곳 기록됨`
      : "첫 번째 농장 모서리에서 위치를 기록해 주세요",
  );
  updateParcelCornerControls();
}

function resetParcelCorners() {
  parcelDraftPoints = [];
  pendingParcelGeometry = null;
  const save = document.querySelector("#parcel-save");
  if (save) save.disabled = true;
  updateParcelPreview("첫 번째 농장 모서리에서 위치를 기록해 주세요");
  updateParcelCornerControls();
}

function updateParcelCornerControls() {
  const count = document.querySelector("#parcel-corner-count");
  const undo = document.querySelector("#parcel-undo-corner");
  const reset = document.querySelector("#parcel-reset-corners");
  if (count) {
    count.textContent = parcelDraftPoints.length >= 3
      ? `기록한 모서리 ${parcelDraftPoints.length}곳 · 저장 가능`
      : `기록한 모서리 ${parcelDraftPoints.length}곳 · 3곳 이상 필요`;
  }
  if (undo) undo.disabled = parcelDraftPoints.length === 0;
  if (reset) reset.disabled = parcelDraftPoints.length === 0;
}

async function savePreparedParcel() {
  const scope = currentFeatureScope(currentAnalysis);
  const status = document.querySelector("#parcel-status");
  const button = document.querySelector("#parcel-save");
  if (!scope || !pendingParcelGeometry) return;
  setBusy(button, true, "저장 중…");
  try {
    const parcel = await api.saveParcel(scope.farmId, pendingParcelGeometry);
    pendingParcelGeometry = parcel.geometry;
    savedParcelAvailable = true;
    document.querySelector("#satellite-service-state").textContent = satelliteIsAvailable()
      ? "필지 등록됨"
      : "경계 저장됨";
    updateParcelPreview(`${formatNumber(parcel.areaSquareMeters)}㎡ 경계 저장됨`);
    applySatelliteAvailability();
    if (status) {
      status.textContent = satelliteIsAvailable()
        ? "필지 경계를 저장했습니다. 최신 위성 자료를 확인할 수 있습니다."
        : "필지 경계를 저장했습니다. 위성 연결 전에도 이 경계는 유지됩니다.";
    }
  } catch (error) {
    if (status) status.textContent = errorMessage(error);
  } finally {
    setBusy(button, false, "이 경계 저장");
  }
}

async function refreshSatellite() {
  if (!applySatelliteAvailability()) return;
  const scope = currentFeatureScope(currentAnalysis);
  const status = document.querySelector("#parcel-status");
  const button = document.querySelector("#satellite-refresh");
  if (!scope) return;
  setBusy(button, true, "위성 자료 확인 중…");
  try {
    const observation = await api.refreshSatelliteObservation(scope.farmId);
    renderSatelliteObservation(observation);
    if (status) status.textContent = "같은 필지의 최근 60일 위성 자료를 확인했습니다.";
  } catch (error) {
    if (status) status.textContent = errorMessage(error);
  } finally {
    setBusy(button, false, "최신 위성 자료 확인");
  }
}

async function refreshSatellitePanel(analysis) {
  const scope = currentFeatureScope(analysis);
  const status = document.querySelector("#parcel-status");
  if (!scope || !connected) return;
  const satelliteAvailable = satelliteIsAvailable();
  try {
    const [{ parcel }, observationResponse] = await Promise.all([
      api.getParcel(scope.farmId),
      satelliteAvailable
        ? api.getSatelliteObservation(scope.farmId)
        : Promise.resolve({ observation: null }),
    ]);
    const observation = observationResponse?.observation ?? null;
    if (parcel) {
      savedParcelAvailable = true;
      pendingParcelGeometry = parcel.geometry;
      updateParcelPreview(`${formatNumber(parcel.areaSquareMeters)}㎡ 경계 저장됨`);
      document.querySelector("#parcel-save").disabled = false;
      document.querySelector("#satellite-service-state").textContent = satelliteAvailable
        ? "필지 등록됨"
        : "경계 저장됨";
      if (status) {
        status.textContent = satelliteAvailable
          ? "저장된 필지 경계를 사용합니다."
          : "저장된 필지 경계를 사용합니다. 위성 변화 확인은 연결 설정 후 사용할 수 있습니다.";
      }
    } else {
      savedParcelAvailable = false;
      pendingParcelGeometry = null;
      document.querySelector("#parcel-save").disabled = true;
      document.querySelector("#satellite-service-state").textContent = satelliteAvailable
        ? "필지 미등록"
        : "경계 등록 가능";
      if (status) status.textContent = "간편 경계 또는 모서리 직접 기록으로 농장 경계를 만들어 주세요.";
    }
    applySatelliteAvailability();
    if (observation) renderSatelliteObservation(observation);
  } catch (error) {
    if (status) status.textContent = `위성 기능 상태를 확인하지 못했습니다. ${errorMessage(error)}`;
  }
}

function setupPhotoJournal() {
  const form = document.querySelector("#photo-journal-form");
  const observedAt = document.querySelector("#journal-observed-at");
  const complete = document.querySelector("#season-complete");
  if (observedAt && !observedAt.value) {
    observedAt.value = new Date().toISOString().slice(0, 10);
  }
  form?.addEventListener("submit", (event) => void savePhotoJournalEntry(event));
  complete?.addEventListener("click", () => void completeCurrentSeason());
  if (!photoJournal) {
    setPhotoJournalStatus(
      "이 브라우저에서는 기기 내 사진 저장을 지원하지 않습니다.",
      "error",
    );
    if (form) form.querySelectorAll("input, textarea, button").forEach((control) => {
      control.disabled = true;
    });
  }
}

function setupHarvestPhotoAssessment() {
  const button = document.querySelector("#harvest-photo-assess");
  button?.addEventListener("click", () => void assessCurrentHarvestPhoto());
}

async function assessCurrentHarvestPhoto() {
  const input = document.querySelector("#harvest-photo-input");
  const button = document.querySelector("#harvest-photo-assess");
  const status = document.querySelector("#harvest-photo-status");
  const file = input?.files?.[0] ?? null;
  const scope = currentFeatureScope(currentAnalysis);
  if (!scope || !currentAnalysis) {
    if (status) status.textContent = "먼저 작물 분석을 완료해 주세요.";
    return;
  }
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    if (status) status.textContent = "JPEG, PNG 또는 WebP 수확 사진을 선택해 주세요.";
    return;
  }
  if (file.size > 6 * 1024 * 1024) {
    if (status) status.textContent = "수확 판정 사진은 6MB 이하로 선택해 주세요.";
    return;
  }
  setBusy(button, true, "AI 확인 중…");
  if (status) status.textContent = "사진의 초점과 수확할 부분을 먼저 확인하고 있습니다.";
  try {
    const quality = assessPhotoQuality(await analyzePhotoSignals(file));
    if (!quality.ready) {
      if (status) status.textContent = quality.message;
      return;
    }
    const response = await api.assessHarvestPhoto(scope.farmId, {
      cropId: String(currentAnalysis.inputSummary.crop).toUpperCase(),
      seasonId: scope.seasonId,
      mimeType: file.type,
      dataBase64: await fileToBase64(file),
    });
    const assessment = response?.assessment;
    if (!assessment || !["READY", "NOT_READY", "UNCERTAIN"].includes(assessment.state)) {
      throw new TypeError("invalid harvest assessment");
    }
    const assessmentKey = harvestAssessmentKey(currentAnalysis);
    if (!assessmentKey) throw new TypeError("invalid harvest assessment scope");
    harvestPhotoAssessments.set(assessmentKey, assessment);
    writeStoredHarvestAssessment(assessmentKey, assessment);
    renderCropCycleCard(currentAnalysis);
    if (input) input.value = "";
  } catch (error) {
    if (status) {
      status.className = "harvest-photo-status is-uncertain";
      status.textContent = errorMessage(error);
    }
  } finally {
    setBusy(button, false, "수확 상태 확인");
  }
}

async function savePhotoJournalEntry(event) {
  event.preventDefault();
  const scope = currentFeatureScope(currentAnalysis);
  const form = event.currentTarget;
  const button = document.querySelector("#journal-save");
  const file = form.elements.photo?.files?.[0] ?? null;
  if (!scope) {
    setPhotoJournalStatus("먼저 농장 분석을 완료해 주세요.", "error");
    return;
  }
  if (!file || !file.type.startsWith("image/")) {
    setPhotoJournalStatus("저장할 작물 사진을 선택해 주세요.", "error");
    return;
  }
  if (file.size > LOCAL_PHOTO_MAX_BYTES) {
    setPhotoJournalStatus("10MB 이하 이미지 파일만 저장할 수 있습니다.", "error");
    return;
  }
  if (form.elements.subjectConfirmed?.checked !== true) {
    setPhotoJournalStatus(
      "작물이 화면 중앙 안내선 안을 충분히 채웠는지 확인해 주세요.",
      "error",
    );
    return;
  }
  if (form.elements.consent?.checked !== true) {
    setPhotoJournalStatus("기기 내 비공개 저장 동의를 확인해 주세요.", "error");
    return;
  }
  setBusy(button, true, "사진 확인 중…");
  try {
    if (isCompletedCycle(currentAnalysis)) {
      setPhotoJournalStatus(
        "마무리한 시즌에는 사진을 추가할 수 없습니다. 새 재배 조건으로 분석해 주세요.",
        "error",
      );
      return;
    }
    const season = await photoJournal.getSeason(scope);
    if (season?.status === "COMPLETED") {
      setPhotoJournalStatus(
        "마무리한 시즌에는 사진을 추가할 수 없습니다. 새 재배 조건으로 분석해 주세요.",
        "error",
      );
      return;
    }
    const visualSignals = {
      ...(await analyzePhotoSignals(file)),
      subjectConfirmed: true,
    };
    const photoQuality = assessPhotoQuality(visualSignals);
    if (!photoQuality.ready) {
      setPhotoJournalStatus(photoQuality.message, "error");
      return;
    }
    let serverPhoto = null;
    let serverSyncError = null;
    if (connected) {
      try {
        const prepared = await api.preparePhotoUpload(scope.farmId, {
          cropId: scope.cropId,
          seasonId: scope.seasonId,
          mimeType: file.type,
          dataBase64: await fileToBase64(file),
        });
        serverPhoto = await api.addPhoto(scope.farmId, {
          cropId: scope.cropId,
          seasonId: scope.seasonId,
          uploadToken: prepared.uploadToken,
          observedAt: observedDateToIso(form.elements.observedAt?.value),
          growthStage: form.elements.growthStage?.value || null,
          note: form.elements.note?.value || null,
          consentState: "GRANTED",
        });
      } catch (error) {
        if (error?.code !== "FEATURE_NOT_CONFIGURED") serverSyncError = error;
      }
    }
    await photoJournal.addPhoto({
      scope,
      file,
      photoId: serverPhoto?.photoId ?? null,
      observedAt: form.elements.observedAt?.value,
      growthStage: form.elements.growthStage?.value,
      note: form.elements.note?.value,
      visualSignals,
    });
    form.reset();
    form.elements.observedAt.value = new Date().toISOString().slice(0, 10);
    if (serverPhoto) {
      await syncLatestPhotoComparison(scope).catch(() => {});
      setPhotoJournalStatus("사진을 비공개로 저장하고 시즌 기록에 반영했습니다.", "success");
    } else if (serverSyncError) {
      setPhotoJournalStatus(
        "서버 동기화는 되지 않았지만 사진은 이 기기에 안전하게 저장했습니다.",
        "error",
      );
    } else {
      setPhotoJournalStatus("사진을 이 기기에 비공개로 저장했습니다.", "success");
    }
    await refreshPhotoJournal(currentAnalysis);
  } catch {
    setPhotoJournalStatus(
      "사진을 저장하지 못했습니다. 브라우저 저장 공간과 권한을 확인해 주세요.",
      "error",
    );
  } finally {
    setBusy(button, false, "사진 기록 저장");
  }
}

async function completeCurrentSeason() {
  const scope = currentFeatureScope(currentAnalysis);
  if (!scope || !photoJournal) return;
  const confirmed = window.confirm(
    "이번 재배 시즌을 마무리할까요? 마무리 후에는 같은 시즌에 사진을 더 추가하지 않습니다.",
  );
  if (!confirmed) return;
  const button = document.querySelector("#season-complete");
  setBusy(button, true, "정리 중…");
  try {
    const result = await finalizeCurrentSeasonRecords();
    setPhotoJournalStatus(
      result.syncWarnings.length
        ? "시즌은 마무리했습니다. 일부 기록 동기화는 다음 접속 때 자동으로 다시 확인합니다."
        : "재배 일정과 사진·완료 기록을 한 시즌으로 정리했습니다.",
      result.syncWarnings.length ? "error" : "success",
    );
  } catch {
    setPhotoJournalStatus("시즌 기록을 정리하지 못했습니다. 다시 시도해 주세요.", "error");
  } finally {
    setBusy(button, false, "시즌 마무리");
  }
}

async function refreshPhotoJournal(analysis) {
  const scope = currentFeatureScope(analysis);
  const gallery = document.querySelector("#photo-journal-gallery");
  if (!scope || !gallery || !photoJournal) return;
  revokePhotoObjectUrls();
  try {
    const [localPhotos, season] = await Promise.all([
      photoJournal.listPhotos(scope),
      photoJournal.getSeason(scope),
    ]);
    let serverSummary = null;
    if (connected) {
      try {
        serverSummary = await api.getPhotoTimeline(scope.farmId, scope);
      } catch (error) {
        if (error?.code !== "FEATURE_NOT_CONFIGURED" && error?.code !== "INVALID_INPUT") {
          setPhotoJournalStatus("서버 시즌 기록을 불러오지 못해 이 기기 기록만 표시합니다.", "error");
        }
      }
    }
    const photos = mergePhotoRecords(localPhotos, serverSummary?.photoTimeline);
    const state = document.querySelector("#photo-journal-state");
    if (state) state.textContent = photos.length ? `${photos.length}장 기록` : "기록 없음";
    const status = document.querySelector("#photo-journal-status");
    if (status?.textContent?.includes("농장 분석을 완료하면")) {
      setPhotoJournalStatus("사진과 저장 동의를 확인한 뒤 기록해 주세요.");
    }
    renderPhotoJournalGallery(gallery, photos, scope);
    const completed =
      isCompletedCycle(analysis) ||
      season?.status === "COMPLETED" ||
      serverSummary?.status === "COMPLETED";
    document.querySelector("#season-complete").disabled = completed;
    document.querySelector("#journal-save").disabled = completed;
    document.querySelector("#season-summary-title").textContent = completed
      ? "이번 재배 시즌 마무리됨"
      : "이번 재배 시즌 진행 중";
    document.querySelector("#season-summary-copy").textContent = completed
      ? `${photos.length}장 사진 · 완료한 할 일 ${serverSummary?.completedActionCount ?? season?.completedActionCount ?? 0}건 · ${formatPhotoDate(serverSummary?.endedAt ?? season?.completedAt)} 정리`
      : `${photos.length}장 사진을 촬영일 순서로 보관 중입니다.`;
  } catch {
    gallery.replaceChildren(
      element("div", "photo-journal-empty", "사진 기록을 불러오지 못했습니다."),
    );
  }
}

function renderPhotoJournalGallery(root, photos, scope) {
  if (!photos.length) {
    root.innerHTML = '<div class="photo-journal-empty"><p><strong>아직 저장한 사진이 없습니다.</strong><br>같은 위치와 비슷한 각도로 찍으면 변화를 비교하기 쉽습니다.</p></div>';
    return;
  }
  const list = element("ol", "photo-journal-list");
  list.replaceChildren(
    ...photos.slice().reverse().map((photo) => photoJournalItem(photo, scope)),
  );
  const comparison = reviewPhotoComparison(
    photos.at(-2)?.visualSignals,
    photos.at(-1)?.visualSignals,
  );
  const comparisonCard = element("section", "photo-journal-compare");
  comparisonCard.append(
    element("h3", "", photos.length > 1 ? "최근 두 사진의 화면상 변화" : "비교할 사진이 한 장 더 필요합니다"),
    element(
      "p",
      "muted no-margin",
      "촬영 조명·각도·거리의 영향을 받는 색 신호입니다. 병해나 생육 악화를 확정하지 않습니다.",
    ),
  );
  if (!comparison.ready && photos.length > 1) {
    comparisonCard.append(
      element("p", "photo-quality-guidance", comparison.message),
    );
  } else if (comparison.changes.length) {
    const labels = { INCREASED: "늘어남", DECREASED: "줄어듦", SIMILAR: "비슷함" };
    const changes = element("ul", "");
    changes.replaceChildren(
      ...comparison.changes.map((item) =>
        element("li", "", `${item.label} ${labels[item.direction]}`),
      ),
    );
    comparisonCard.append(changes);
  }
  root.replaceChildren(list, comparisonCard);
}

function photoJournalItem(photo, scope) {
  const item = element("li", "photo-journal-item");
  let preview;
  if (photo.blob instanceof Blob) {
    const url = URL.createObjectURL(photo.blob);
    photoObjectUrls.push(url);
    preview = document.createElement("img");
    preview.src = url;
    preview.alt = `${formatPhotoDate(photo.observedAt)}에 기록한 작물 사진`;
  } else {
    preview = element("div", "photo-journal-empty", "다른 기기에서 저장한 비공개 사진 기록");
  }
  const body = element("div", "photo-journal-item-body");
  const actions = element("div", "photo-journal-item-actions");
  const remove = element("button", "button button-quiet", "삭제");
  remove.type = "button";
  remove.addEventListener("click", async () => {
    if (!window.confirm("저장한 사진 기록을 삭제할까요?")) return;
    if (connected && photo.serverStored !== false) {
      try {
        await api.deletePhoto(scope.farmId, photo.photoId);
      } catch (error) {
        if (!["FEATURE_NOT_CONFIGURED", "PHOTO_NOT_FOUND"].includes(error?.code)) {
          setPhotoJournalStatus(errorMessage(error), "error");
          return;
        }
      }
    }
    await photoJournal.deletePhoto(scope, photo.photoId).catch(() => false);
    await refreshPhotoJournal(currentAnalysis);
  });
  actions.append(
    element("strong", "", formatPhotoDate(photo.observedAt)),
    remove,
  );
  body.append(
    actions,
    element("p", "", [photo.growthStage, photo.note].filter(Boolean).join(" · ") || "현장 메모 없음"),
  );
  item.append(preview, body);
  return item;
}

async function syncLatestPhotoComparison(scope) {
  const photos = await photoJournal.listPhotos(scope);
  if (photos.length < 2) return;
  const baseline = photos.at(-2);
  const current = photos.at(-1);
  const review = reviewPhotoComparison(
    baseline.visualSignals,
    current.visualSignals,
  );
  if (!review.ready) return;
  const observations = review.changes.map(photoChangeObservation).filter(Boolean);
  if (observations.length === 0) return;
  await api.comparePhotos(scope.farmId, {
    cropId: scope.cropId,
    seasonId: scope.seasonId,
    baselinePhotoId: baseline.photoId,
    currentPhotoId: current.photoId,
    observations,
  });
}

function photoChangeObservation(change) {
  if (change.label === "평균 밝기") {
    return {
      aspect: "COLOR",
      change:
        change.direction === "INCREASED"
          ? "LIGHTER"
          : change.direction === "DECREASED"
            ? "DARKER"
            : "NO_VISIBLE_CHANGE",
    };
  }
  if (change.label === "노란색 비율") {
    return {
      aspect: "COLOR",
      change:
        change.direction === "INCREASED"
          ? "MORE_YELLOW"
          : change.direction === "DECREASED"
            ? "LESS_YELLOW"
            : "NO_VISIBLE_CHANGE",
    };
  }
  if (change.label === "초록색 비율") {
    return {
      aspect: "AREA",
      change:
        change.direction === "INCREASED"
          ? "INCREASED"
          : change.direction === "DECREASED"
            ? "DECREASED"
            : "NO_VISIBLE_CHANGE",
    };
  }
  return null;
}

function mergePhotoRecords(localPhotos, serverPhotos) {
  const merged = new Map();
  for (const photo of Array.isArray(serverPhotos) ? serverPhotos : []) {
    merged.set(photo.photoId, { ...photo, serverStored: true });
  }
  for (const photo of Array.isArray(localPhotos) ? localPhotos : []) {
    merged.set(photo.photoId, {
      ...(merged.get(photo.photoId) ?? { serverStored: false }),
      ...photo,
    });
  }
  return [...merged.values()].sort((left, right) =>
    String(left.observedAt).localeCompare(String(right.observedAt)),
  );
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function observedDateToIso(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new TypeError("촬영일을 확인해 주세요.");
  }
  return new Date(`${value}T12:00:00+09:00`).toISOString();
}

async function analyzePhotoSignals(file) {
  const image = await createImageBitmap(file);
  try {
    const width = Math.min(180, image.width);
    const height = Math.max(1, Math.round((image.height / image.width) * width));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);
    return analyzePhotoPixels(context.getImageData(0, 0, width, height));
  } finally {
    image.close?.();
  }
}

function setPhotoJournalStatus(message, state = "") {
  const status = document.querySelector("#photo-journal-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.state = state;
}

function revokePhotoObjectUrls() {
  for (const url of photoObjectUrls) URL.revokeObjectURL(url);
  photoObjectUrls = [];
}

function formatPhotoDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" }).format(date)
    : "날짜 미확인";
}

function squareGeometry(latitude, longitude, sideMeters) {
  const half = sideMeters / 2;
  const latitudeOffset = half / 111_320;
  const longitudeOffset = half /
    (111_320 * Math.max(0.2, Math.cos((latitude * Math.PI) / 180)));
  return {
    type: "Polygon",
    coordinates: [[
      [longitude - longitudeOffset, latitude - latitudeOffset],
      [longitude + longitudeOffset, latitude - latitudeOffset],
      [longitude + longitudeOffset, latitude + latitudeOffset],
      [longitude - longitudeOffset, latitude + latitudeOffset],
      [longitude - longitudeOffset, latitude - latitudeOffset],
    ]],
  };
}

function parcelGeometryFromCorners(points) {
  if (!Array.isArray(points) || points.length < 3) return null;
  return {
    type: "Polygon",
    coordinates: [[...points.map((point) => [...point]), [...points[0]]]],
  };
}

function parcelPointDistanceMeters(left, right) {
  const [leftLongitude, leftLatitude] = left;
  const [rightLongitude, rightLatitude] = right;
  const toRadians = (value) => (value * Math.PI) / 180;
  const latitudeDelta = toRadians(rightLatitude - leftLatitude);
  const longitudeDelta = toRadians(rightLongitude - leftLongitude);
  const originLatitude = toRadians(leftLatitude);
  const destinationLatitude = toRadians(rightLatitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(originLatitude) * Math.cos(destinationLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_008.8 * 2 * Math.atan2(
    Math.sqrt(haversine),
    Math.sqrt(Math.max(0, 1 - haversine)),
  );
}

function parcelPreviewRings(geometry) {
  if (geometry?.type === "Polygon") return [geometry.coordinates?.[0] ?? []];
  if (geometry?.type === "MultiPolygon") {
    return geometry.coordinates?.map((polygon) => polygon?.[0] ?? []) ?? [];
  }
  return [];
}

function projectParcelPreview(rings) {
  const positions = rings.flat().filter(
    (position) =>
      Array.isArray(position) &&
      Number.isFinite(position[0]) &&
      Number.isFinite(position[1]),
  );
  if (positions.length === 0) return { rings: [], points: [] };
  const meanLatitude = positions.reduce((sum, point) => sum + point[1], 0) /
    positions.length;
  const longitudeScale = Math.max(0.2, Math.cos((meanLatitude * Math.PI) / 180));
  const projected = positions.map(([longitude, latitude]) => [
    longitude * longitudeScale,
    latitude,
  ]);
  const minX = Math.min(...projected.map((point) => point[0]));
  const maxX = Math.max(...projected.map((point) => point[0]));
  const minY = Math.min(...projected.map((point) => point[1]));
  const maxY = Math.max(...projected.map((point) => point[1]));
  const rangeX = Math.max(maxX - minX, 1e-8);
  const rangeY = Math.max(maxY - minY, 1e-8);
  const scale = Math.min(360 / rangeX, 150 / rangeY);
  const width = rangeX * scale;
  const height = rangeY * scale;
  const offsetX = 240 - width / 2;
  const offsetY = 105 + height / 2;
  const pointMap = new Map(
    positions.map((position, index) => {
      const [x, y] = projected[index];
      return [
        position,
        [offsetX + (x - minX) * scale, offsetY - (y - minY) * scale],
      ];
    }),
  );
  return {
    rings: rings.map((ring) => ring.map((position) => pointMap.get(position))),
    points: rings.flatMap((ring) => ring.slice(0, -1).map((position) => pointMap.get(position))),
  };
}

function updateParcelPreview(label) {
  const target = document.querySelector("#parcel-preview-label");
  const shape = document.querySelector("#parcel-preview-shape");
  const line = document.querySelector("#parcel-preview-line");
  const pointsRoot = document.querySelector("#parcel-preview-points");
  if (target) {
    target.textContent = label;
    target.setAttribute("y", pendingParcelGeometry || parcelDraftPoints.length ? "238" : "135");
  }
  const previewGeometry = pendingParcelGeometry ?? (
    parcelDraftPoints.length >= 3
      ? parcelGeometryFromCorners(parcelDraftPoints)
      : null
  );
  const sourceRings = previewGeometry
    ? parcelPreviewRings(previewGeometry)
    : parcelDraftPoints.length
    ? [[...parcelDraftPoints, ...(parcelDraftPoints.length > 1 ? [] : [])]]
    : [];
  const projected = projectParcelPreview(sourceRings);
  const hasGeometry = projected.rings.length > 0 && Boolean(previewGeometry);
  if (shape) {
    shape.setAttribute(
      "d",
      hasGeometry
        ? projected.rings
          .map((ring) => ring.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ") + " Z")
          .join(" ")
        : "",
    );
    shape.hidden = !hasGeometry;
  }
  if (line) {
    const openPoints = !previewGeometry && projected.rings[0]
      ? projected.rings[0]
      : [];
    line.setAttribute(
      "points",
      openPoints.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "),
    );
    line.hidden = openPoints.length === 0;
  }
  if (pointsRoot) {
    const pointCoordinates = hasGeometry
      ? projected.points
      : projected.rings[0] ?? [];
    pointsRoot.replaceChildren(
      ...pointCoordinates.map(([x, y], index) => {
        const point = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        point.setAttribute(
          "class",
          `parcel-preview-point${index === 0 ? " is-first" : ""}`,
        );
        point.setAttribute("cx", x.toFixed(1));
        point.setAttribute("cy", y.toFixed(1));
        point.setAttribute("r", "5");
        return point;
      }),
    );
  }
}

function renderSatelliteObservation(observation) {
  const root = document.querySelector("#satellite-result");
  if (!root || !observation) return;
  const latestItem = observation.catalogue?.items?.[0] ?? null;
  const series = Array.isArray(observation.vegetation?.observations)
    ? observation.vegetation.observations
      .filter(
        (item) =>
          Number.isFinite(item?.meanNdvi) &&
          typeof item?.to === "string" &&
          Number.isFinite(Date.parse(item.to)),
      )
      .sort((left, right) => Date.parse(left.to) - Date.parse(right.to))
    : [];
  const grid = element("div", "satellite-result-grid");
  for (const [label, value] of [
    ["촬영일", latestItem?.acquiredAt ? formatDateTime(latestItem.acquiredAt) : "확인되지 않음"],
    ["구름량", Number.isFinite(latestItem?.cloudCoverPercent) ? `${formatNumber(latestItem.cloudCoverPercent)}%` : "확인되지 않음"],
    ["해상도", Number.isFinite(observation.vegetation?.resolutionMeters) ? `${formatNumber(observation.vegetation.resolutionMeters)}m` : "확인되지 않음"],
    ["관측 상태", stateLabel(observation.state)],
  ]) {
    const card = element("div");
    card.append(element("span", "", label), element("strong", "", value));
    grid.append(card);
  }
  const chart = satelliteTrendChart(series);
  root.replaceChildren(
    element("span", "service-eyebrow", "COPERNICUS SENTINEL-2"),
    element("h3", "", observation.summary ?? "위성 관측 결과"),
    element("p", "muted", observation.nextAction ?? "현장 자료와 함께 확인해 주세요."),
    grid,
    ...(chart ? [chart] : []),
    element("p", "formula-note", "식생지수는 같은 필지의 변화 참고값이며 토양 상태·병해·수확량을 단독으로 판정하지 않습니다."),
  );
  root.hidden = false;
  document.querySelector("#satellite-service-state").textContent = stateLabel(observation.state);
}

function satelliteTrendChart(series) {
  if (series.length < 2) return null;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "satellite-trend-chart");
  svg.setAttribute("viewBox", "0 0 520 160");
  svg.setAttribute("role", "img");
  const firstDate = formatShortDate(series[0].to);
  const lastDate = formatShortDate(series.at(-1).to);
  svg.setAttribute(
    "aria-label",
    `같은 필지의 식생지수 변화. ${firstDate} ${formatNumber(series[0].meanNdvi)}에서 ${lastDate} ${formatNumber(series.at(-1).meanNdvi)}까지`,
  );
  const values = series.map((item) => item.meanNdvi);
  const points = values.map((value, index) => {
    const x = 44 + (index / (values.length - 1)) * 448;
    const y = 108 - ((value + 1) / 2) * 80;
    return [x, y];
  });
  for (const [value, y] of [[1, 28], [0, 68], [-1, 108]]) {
    const guide = document.createElementNS(svg.namespaceURI, "path");
    guide.setAttribute("class", "axis");
    guide.setAttribute("d", `M44 ${y}H492`);
    svg.append(guide, satelliteChartText(8, y + 4, String(value), "axis-label"));
  }
  const line = document.createElementNS(svg.namespaceURI, "polyline");
  line.setAttribute("class", "line");
  line.setAttribute("points", points.map(([x, y]) => `${x},${y}`).join(" "));
  svg.append(line);
  for (const [index, [x, y]] of points.entries()) {
    const point = document.createElementNS(svg.namespaceURI, "circle");
    point.setAttribute("class", "point");
    point.setAttribute("cx", String(x));
    point.setAttribute("cy", String(y));
    point.setAttribute("r", "4");
    const title = document.createElementNS(svg.namespaceURI, "title");
    title.textContent = `${formatShortDate(series[index].to)} · ${formatNumber(values[index])}`;
    point.append(title);
    svg.append(point);
  }
  svg.append(
    satelliteChartText(44, 138, firstDate, "date-label"),
    satelliteChartText(492, 138, lastDate, "date-label date-label-end"),
    satelliteChartText(44, 154, `NDVI ${formatNumber(values[0])}`, "value-label"),
    satelliteChartText(492, 154, `NDVI ${formatNumber(values.at(-1))}`, "value-label date-label-end"),
  );
  return svg;
}

function satelliteChartText(x, y, value, className) {
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("x", String(x));
  text.setAttribute("y", String(y));
  text.setAttribute("class", className);
  if (className.includes("date-label-end")) text.setAttribute("text-anchor", "end");
  text.textContent = value;
  return text;
}

function setDashboardResultVisibility(visible) {
  [
    "#dashboard-workspace",
  ].forEach((selector) => {
    const target = document.querySelector(selector);
    if (target) target.hidden = !visible;
  });
  [
    "#live-outlook",
    "#action-plan-panel",
    ".decision-flow",
    ".risk-panel",
    ".action-workspace",
    ".overview-score",
    ".metric-strip",
    ".insight-grid",
    ".evidence-workspace",
  ].forEach(
    (selector) => {
      const target = document.querySelector(selector);
      if (target) target.hidden = true;
    },
  );
  document.querySelector(".decision-flow")?.classList.remove("is-user-focused");
}

function openAssistant() {
  if (!assistantPanel || !assistantLauncher) return;
  assistantPanel.hidden = false;
  assistantLauncher.setAttribute("aria-expanded", "true");
  const mobileModal = window.matchMedia("(max-width: 620px)").matches;
  assistantPanel.setAttribute("aria-modal", String(mobileModal));
  if (mobileModal) {
    document.querySelector(".app-shell").inert = true;
    document.querySelector(".skip-link").inert = true;
  }
  document.body.classList.add("assistant-open");
  requestAnimationFrame(() => assistantInput?.focus());
}

function closeAssistant() {
  if (!assistantPanel || !assistantLauncher) return;
  assistantPanel.hidden = true;
  assistantLauncher.setAttribute("aria-expanded", "false");
  document.body.classList.remove("assistant-open");
  if (!document.body.classList.contains("wizard-open")) {
    document.querySelector(".app-shell").inert = false;
    document.querySelector(".skip-link").inert = false;
  }
  assistantLauncher.focus();
}

function trapAssistantFocus(event) {
  if (
    event.key !== "Tab" ||
    !window.matchMedia("(max-width: 620px)").matches
  ) return;
  const focusable = [...assistantPanel.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )].filter((node) => !node.hidden);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function syncAssistantContext(analysis) {
  if (!assistantInput || !assistantSend || !assistantContext) return;
  const analysisId = analysis?.analysisId ?? null;
  const crop = CROP_LABELS[analysis?.inputSummary?.crop] ?? "현재 작물";
  const region = analysis?.inputSummary?.regionLabel ?? "농장 분석 전";
  const available = Boolean(analysisId && connected);
  assistantInput.disabled = !available;
  assistantSend.disabled = !available;
  document.querySelectorAll("[data-assistant-question]").forEach((button) => {
    button.disabled = !available;
  });
  assistantContext.textContent = available
    ? `${region} · ${crop} 분석 기준`
    : "농장 분석을 먼저 실행해 주세요";
  if (assistantAnalysisId !== analysisId) {
    assistantAnalysisId = analysisId;
    assistantMessages?.replaceChildren();
    appendAssistantMessage(
      available
        ? `${crop} 분석에서 확인된 날씨·토양 근거와 필요한 행동만 설명합니다. 이전 질문은 기억하지 않으므로 작물·날짜·항목을 함께 적어 주세요.`
        : "농장 분석을 실행하면 확인된 근거를 쉽게 설명합니다.",
    );
  }
}

async function submitAssistantQuestion(rawQuestion) {
  const question = String(rawQuestion ?? "").trim();
  const expectedAnalysisId = currentAnalysis?.analysisId;
  if (!question || !expectedAnalysisId || !assistantInput || !assistantSend) {
    if (!expectedAnalysisId) {
      appendAssistantMessage("농장 분석을 먼저 실행해 주세요.");
    }
    return;
  }
  appendAssistantMessage(question, { user: true });
  assistantInput.value = "";
  const actionProposal = buildAssistantActionProposal(question, currentAnalysis);
  if (actionProposal) {
    renderAssistantActionProposal(actionProposal, currentAnalysis);
    assistantInput.focus();
    return;
  }
  const cropCode = currentAnalysis?.inputSummary?.crop;
  const cycleAnswer = buildAssistantCycleAnswer(question, {
    cropLabel: CROP_LABELS[cropCode],
    projection:
      cropCycleProjections.get(cropCode) ??
      currentUiContexts.get(cropCode)?.cycleProjection,
  });
  if (cycleAnswer) {
    appendAssistantMessage(cycleAnswer);
    assistantInput.focus();
    return;
  }
  assistantInput.disabled = true;
  assistantSend.disabled = true;
  assistantSend.textContent = "확인 중";
  let pending = appendAssistantMessage("현재 분석 근거를 확인하고 있습니다.");
  let activeRequestAnalysisId = expectedAnalysisId;
  try {
    let response;
    try {
      response = await api.askAssistant(activeRequestAnalysisId, question);
    } catch (error) {
      if (error?.code !== "ANALYSIS_NOT_FOUND") throw error;
      pending?.remove();
      const saved = readStoredSession();
      const locationReady = selectedCandidate ||
        await prepareStoredLocationCandidate(saved?.region);
      pendingAttempt = null;
      const refreshed = locationReady && await submitAnalysis();
      activeRequestAnalysisId = currentAnalysis?.analysisId;
      if (!refreshed || !activeRequestAnalysisId) throw error;
      // 새 분석 ID로 컨텍스트가 교체되며 대화 로그도 초기화된다.
      // 사용자의 질문을 다시 표시한 뒤 같은 질문을 한 번만 재시도한다.
      appendAssistantMessage(question, { user: true });
      pending = appendAssistantMessage("최신 분석 근거를 확인하고 있습니다.");
      response = await api.askAssistant(activeRequestAnalysisId, question);
    }
    if (activeRequestAnalysisId !== currentAnalysis?.analysisId) return;
    pending?.remove();
    appendAssistantMessage(response?.answer ?? "설명할 근거를 찾지 못했습니다.", {
      note: assistantOutcomeNote(response?.outcome, response?.notice),
      references: Array.isArray(response?.references) ? response.references : [],
    });
  } catch (error) {
    pending?.remove();
    appendAssistantMessage(assistantErrorMessage(error));
  } finally {
    if (activeRequestAnalysisId === currentAnalysis?.analysisId) {
      assistantInput.disabled = false;
      assistantSend.disabled = false;
      assistantSend.textContent = "전송";
      assistantInput.focus();
    }
  }
}

function buildAssistantActionProposal(question, analysis) {
  const parsed = parseAssistantActionRequest(question);
  if (!parsed) return null;
  const scope = currentFeatureScope(analysis);
  if (!scope) return null;
  const now = new Date();
  const { tomorrow, title } = parsed;
  const due = new Date(now);
  if (tomorrow) {
    due.setDate(due.getDate() + 1);
    due.setHours(8, 0, 0, 0);
  } else {
    due.setMinutes(due.getMinutes() + 30, 0, 0);
  }
  return {
    title,
    dueLabel: tomorrow ? "내일 오전" : "오늘",
    draft: {
      ...scope,
      title,
      instruction: `${title}을(를) 확인하고 완료 여부를 기록합니다.`,
      reason: "사용자가 흙톡에서 직접 요청한 할 일입니다.",
      horizon: tomorrow ? "UPCOMING" : "TODAY",
      dueAt: due.toISOString(),
      recheckAt: due.toISOString(),
      evidenceRefs: [{
        sourceKind: "USER",
        sourceId: "assistant-user-request",
        observedAt: now.toISOString(),
        fetchedAt: null,
        spatialLevel: "USER_FARM",
        state: "READY",
        limitationCodes: [],
      }],
      origin: "ASSISTANT_PROPOSAL",
    },
  };
}

function renderAssistantActionProposal(proposal, analysis) {
  const card = element("section", "assistant-message assistant-proposal");
  card.append(
    element("strong", "", "할 일 추가 전 확인"),
    element("span", "", `${proposal.dueLabel} · ${proposal.title}`),
    element("small", "", "확인 버튼을 누르기 전에는 저장되지 않습니다."),
  );
  const controls = element("div", "assistant-proposal-actions");
  const confirm = element("button", "", "이대로 추가");
  const cancel = element("button", "", "취소");
  confirm.type = "button";
  cancel.type = "button";
  confirm.addEventListener("click", async () => {
    const scope = currentFeatureScope(analysis);
    if (!scope) return;
    confirm.disabled = true;
    cancel.disabled = true;
    try {
      await api.createAction(
        scope.farmId,
        { draft: proposal.draft, ruleId: null, confirmed: true },
        createIdempotencyKey(),
      );
      invalidateActionPlan(analysis);
      card.replaceChildren(
        element("strong", "", "할 일에 추가했습니다."),
        element("span", "", `${proposal.dueLabel} · ${proposal.title}`),
      );
      await refreshActionPlan(analysis, { ensureRules: false });
    } catch (error) {
      confirm.disabled = false;
      cancel.disabled = false;
      card.append(element("small", "", assistantErrorMessage(error)));
    }
  });
  cancel.addEventListener("click", () => {
    card.replaceChildren(element("span", "", "추가하지 않았습니다."));
  });
  controls.append(confirm, cancel);
  card.append(controls);
  assistantMessages.append(card);
  assistantMessages.scrollTop = assistantMessages.scrollHeight;
}

function assistantErrorMessage(error) {
  const messages = {
    ANALYSIS_NOT_FOUND:
      "분석 세션이 만료되었습니다. 농장 분석을 다시 실행해 주세요.",
    RATE_LIMITED:
      "질문을 연속으로 많이 보냈습니다. 잠시 뒤 한 문장으로 다시 물어봐 주세요.",
    REQUEST_TIMEOUT:
      "확인 시간을 넘었습니다. 현재 분석은 그대로 유지되므로 질문만 다시 보내 주세요.",
    INVALID_INPUT:
      "질문을 확인하지 못했습니다. 작물·날짜·궁금한 항목을 한 문장으로 적어 주세요."
  };
  return messages[error?.code] ??
    "설명을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
}

function assistantOutcomeNote(outcome, fallbackNotice) {
  const labels = {
    ANSWERED: "현재 분석에서 확인된 근거로 답했습니다.",
    NEEDS_CLARIFICATION: "질문에 필요한 작물·날짜·항목을 다시 확인해 주세요.",
    SAFETY_LIMIT: "안전상 확정 처방을 제공하지 않는 질문입니다.",
    NOT_SUPPORTED: "현재 버전에서 지원하지 않는 판단입니다.",
  };
  return labels[outcome] ?? fallbackNotice;
}

function appendAssistantMessage(
  text,
  { user = false, note = null, references = [] } = {},
) {
  if (!assistantMessages) return null;
  // 참고 자료 카드(figure)를 담을 수 있어야 하므로 p가 아니라 div를 쓴다.
  // 스타일은 모두 .assistant-message 클래스 선택자라 태그 변경 영향이 없다.
  const message = element(
    "div",
    `assistant-message${user ? " is-user" : ""}`,
    text,
  );
  if (!user) {
    for (const reference of references) {
      const card = buildAssistantReference(reference);
      if (card) message.append(card);
    }
    if (note) message.append(element("small", "", note));
  }
  assistantMessages.append(message);
  assistantMessages.scrollTop = assistantMessages.scrollHeight;
  return message;
}

/**
 * 재배 참고 문단 하나를 이미지 카드로 만든다.
 *
 * 이미지는 백엔드 프록시(/api/knowledge-images/{imageId})만 호출한다. 응답에
 * 업스트림 URL이 없으므로 브라우저가 외부 기관 서버로 직접 요청하지 않고 CSP도
 * img-src 'self'로 유지된다. image.available이 false면 자리만 비워 두고 왜
 * 비었는지 적는다. 연결되지 않은 이미지를 <img>로 만들면 깨진 아이콘만 남는다.
 */
function buildAssistantReference(reference) {
  if (!reference || typeof reference !== "object") return null;
  const title = typeof reference.title === "string" ? reference.title : "";
  if (!title) return null;
  const figure = element("figure", "assistant-reference");
  const image = reference.image;

  if (image?.available && typeof image.imageId === "string") {
    const picture = document.createElement("img");
    picture.className = "assistant-reference-image";
    picture.src = api.knowledgeImageUrl(image.imageId);
    // 백엔드가 다른 오리진에 있으면 img 요청에도 세션 쿠키가 실려야 한다.
    if (api.baseUrl) picture.crossOrigin = "use-credentials";
    picture.alt = typeof image.alt === "string" ? image.alt : title;
    picture.loading = "lazy";
    picture.decoding = "async";
    // 프록시가 실패하면 깨진 아이콘 대신 안내 문구로 바꾼다.
    picture.addEventListener("error", () => {
      picture.replaceWith(
        element(
          "p",
          "assistant-reference-missing",
          "참고 이미지를 불러오지 못했습니다.",
        ),
      );
    });
    figure.append(picture);
  } else if (image) {
    figure.append(
      element(
        "p",
        "assistant-reference-missing",
        "이미지 자료 미연결 — 설명으로만 표시합니다.",
      ),
    );
  }

  const caption = element("figcaption", "assistant-reference-caption");
  caption.append(element("strong", "", title));
  if (typeof image?.caption === "string" && image.caption) {
    caption.append(element("span", "", image.caption));
  }
  if (reference.reviewState !== "REVIEWED") {
    caption.append(
      element("span", "assistant-reference-badge", "검수 대기 자료"),
    );
  }
  const credit = [reference.sourceTitle, image?.credit, image?.licence]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" · ");
  if (credit) {
    if (typeof reference.sourceUrl === "string" && reference.sourceUrl) {
      const link = element("a", "assistant-reference-source", `출처: ${credit}`);
      link.href = reference.sourceUrl;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      caption.append(link);
    } else {
      caption.append(
        element("span", "assistant-reference-source", `출처: ${credit}`),
      );
    }
  }
  figure.append(caption);
  return figure;
}

function updateLocationSearchAvailability() {
  searchLocationButton.disabled = !connected || regionInput.value.trim().length < 2;
  currentLocationButton.disabled = !connected || !navigator.geolocation;
  if (connected && !navigator.geolocation) {
    setCurrentLocationStatus(
      "이 기기에서는 현재 위치를 사용할 수 없습니다. 지역을 직접 입력해 주세요.",
      "error",
    );
  }
}

function updateSubmitAvailability() {
  const ready = connected && selectedCandidate && analysisFormComplete();
  runAnalysisButton.disabled = !ready;
  if (!selectedCandidate) {
    runAnalysisButton.textContent = "농장 위치를 확인한 뒤 분석하기";
  } else if (!analysisFormComplete()) {
    runAnalysisButton.textContent = "선택하지 않은 항목을 확인해 주세요";
  } else {
    const count = selectedCheckboxValues("crop").length;
    runAnalysisButton.textContent =
      count > 1 ? `작물 ${count}종 분석하기` : "이 조건으로 분석하기";
  }
}

function clearSelectedCandidate(statusMessage = "") {
  selectedCandidate = null;
  delete regionInput.dataset.candidateVerified;
  hideLocationCandidates();
  updateSubmitAvailability();
  syncWizardNextState();
  if (statusMessage) setLocationStatus(statusMessage);
}

function hideLocationCandidates() {
  locationCandidates.hidden = true;
  locationCandidates.replaceChildren();
  regionInput.setAttribute("aria-expanded", "false");
}

function syncWizardNextState() {
  const visibleStep = document.querySelector(
    '.wizard-step[data-step]:not([hidden])',
  )?.dataset.step;
  if (!wizardNextButton) return;
  if (visibleStep === "1") wizardNextButton.disabled = !selectedCandidate;
  if (visibleStep === "2") {
    wizardNextButton.disabled = selectedCheckboxValues("crop").length === 0;
  }
  if (visibleStep === "3") wizardNextButton.disabled = !cropSettingsComplete();
  if (visibleStep === "4") {
    wizardNextButton.disabled = !growthSettingsComplete();
  }
  if (visibleStep === "5") syncVerifiedReview();
  updateSubmitAvailability();
}

function resetNewAnalysisState() {
  selectedCandidate = null;
  pendingAttempt = null;
  locationCandidates.hidden = true;
  locationCandidates.replaceChildren();
  setLocationStatus(
    connected
      ? "현재 위치를 사용하거나 지역을 입력한 뒤 검색 결과에서 선택해 주세요."
      : "백엔드 연결을 기다리는 중입니다.",
  );
  setCurrentLocationStatus(
    connected
      ? "버튼을 누르면 기기의 위치 권한을 요청합니다."
      : "백엔드 연결을 기다리는 중입니다.",
  );
  updateLocationSearchAvailability();
  updateSubmitAvailability();
  syncWizardNextState();
}

function showContractError(error) {
  if (error.field === "region") {
    showRegionError(error.message);
    navigateToWizardStep(1);
    return;
  }
  if (error.field === "crop") {
    showFieldError("crop-error", error.message);
    navigateToWizardStep(2);
    return;
  }
  if (error.field === "cultivation") {
    showFieldError("cultivation-error", error.message);
    navigateToWizardStep(3);
    return;
  }
  if (error.field === "season") {
    showSubmitError(error.message);
    navigateToWizardStep(3);
    return;
  }
  if (error.field === "growth") {
    showFieldError("growth-error", error.message);
    navigateToWizardStep(4);
    return;
  }
  showSubmitError(error.message);
}

function navigateToWizardStep(step) {
  document.querySelector(`[data-edit-step="${step}"]`)?.click();
  requestAnimationFrame(() => {
    document.querySelector(`.wizard-step[data-step="${step}"] h1`)?.focus();
  });
}

function showRegionError(message) {
  showFieldError("region-error", message);
  setLocationStatus(message, "error");
  announce(message);
}

function showFieldError(id, message) {
  const target = document.querySelector(`#${id}`);
  if (!target) return;
  target.textContent = message;
  target.hidden = false;
  announce(message);
}

function showSubmitError(message) {
  runtimeSafetyNotice.className = "notice notice-danger";
  runtimeSafetyNotice.hidden = false;
  replaceNotice(
    runtimeSafetyNotice,
    "분석을 완료하지 못했습니다.",
    message,
  );
  runAnalysisButton.textContent = "다시 분석하기";
  announce(message);
}

function setConnectionState(state, copy) {
  connectionStatus.className = `wizard-connection is-${state}`;
  connectionCopy.textContent = copy;
}

function setServiceBanner(state, title, detail) {
  serviceBanner.className = `integration-banner is-${state}`;
  serviceTitle.textContent = title;
  serviceDetail.textContent = detail;
}

function setLocationStatus(message, state = "") {
  regionSearchStatus.className = `location-search-status${state ? ` is-${state}` : ""}`;
  regionSearchStatus.textContent = message;
}

function setCurrentLocationStatus(message, state = "") {
  currentLocationStatus.className = `location-search-status${state ? ` is-${state}` : ""}`;
  currentLocationStatus.textContent = message;
}

function replaceNotice(target, title, detail) {
  const titleParagraph = element("p");
  titleParagraph.append(element("strong", "", title));
  target.replaceChildren(titleParagraph, element("p", "", detail));
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  if (label) button.textContent = label;
}

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // 브라우저가 저장소를 막아둔 경우 기능만 비활성화한다.
    return null;
  }
}

function isStoredAnalysisResult(analysis) {
  const crop = analysis?.inputSummary?.crop;
  return (
    typeof analysis?.analysisId === "string" &&
    analysis.analysisId !== "" &&
    typeof crop === "string" &&
    Object.hasOwn(CROP_LABELS, crop)
  );
}

function readAnalysisSnapshot(farmId) {
  if (typeof farmId !== "string" || farmId === "") return null;
  const raw = safeStorage()?.getItem(ANALYSIS_SNAPSHOT_STORAGE_KEY);
  if (!raw || raw.length > ANALYSIS_SNAPSHOT_MAX_BYTES) return null;
  try {
    const parsed = JSON.parse(raw);
    const snapshot = parsed?.version === 1 ? parsed.farms?.[farmId] : null;
    const analyses = Array.isArray(snapshot?.analyses)
      ? snapshot.analyses.filter(isStoredAnalysisResult).slice(0, 5)
      : [];
    if (analyses.length === 0) return null;
    return {
      savedAt: snapshot.savedAt,
      analyses,
      uiContexts:
        snapshot.uiContexts && typeof snapshot.uiContexts === "object"
          ? snapshot.uiContexts
          : {},
    };
  } catch {
    return null;
  }
}

function writeAnalysisSnapshot(analyses) {
  const storage = safeStorage();
  const farmId = storage?.getItem(ACTIVE_FARM_STORAGE_KEY);
  const safeAnalyses = Array.isArray(analyses)
    ? analyses.filter(isStoredAnalysisResult).slice(0, 5)
    : [];
  if (!storage || !farmId || safeAnalyses.length === 0) return null;
  const newestAnalysisTime = Math.max(
    0,
    ...safeAnalyses
      .map((analysis) => Date.parse(analysis.createdAt))
      .filter(Number.isFinite),
  );
  const savedAt = new Date(newestAnalysisTime || Date.now()).toISOString();
  try {
    let parsed = { version: 1, farms: {} };
    const previous = storage.getItem(ANALYSIS_SNAPSHOT_STORAGE_KEY);
    if (previous && previous.length <= ANALYSIS_SNAPSHOT_MAX_BYTES) {
      const candidate = JSON.parse(previous);
      if (candidate?.version === 1 && candidate.farms && typeof candidate.farms === "object") {
        parsed = candidate;
      }
    }
    parsed.farms[farmId] = {
      savedAt,
      analyses: safeAnalyses,
      uiContexts: Object.fromEntries(currentUiContexts),
    };
    const allowedFarmIds = new Set(readStoredFarms().map(({ id }) => id));
    parsed.farms = Object.fromEntries(
      Object.entries(parsed.farms)
        .filter(([id]) => allowedFarmIds.has(id))
        .sort(([, left], [, right]) =>
          String(right?.savedAt ?? "").localeCompare(String(left?.savedAt ?? ""))
        )
        .slice(0, 12),
    );
    let serialized = JSON.stringify(parsed);
    while (
      new TextEncoder().encode(serialized).byteLength > ANALYSIS_SNAPSHOT_MAX_BYTES &&
      Object.keys(parsed.farms).length > 1
    ) {
      const oldestFarmId = Object.keys(parsed.farms).at(-1);
      if (!oldestFarmId || oldestFarmId === farmId) {
        const nextOldestFarmId = Object.keys(parsed.farms).at(-2);
        if (!nextOldestFarmId) break;
        delete parsed.farms[nextOldestFarmId];
      } else {
        delete parsed.farms[oldestFarmId];
      }
      serialized = JSON.stringify(parsed);
    }
    if (new TextEncoder().encode(serialized).byteLength > ANALYSIS_SNAPSHOT_MAX_BYTES) {
      serialized = JSON.stringify({
        version: 1,
        farms: { [farmId]: parsed.farms[farmId] },
      });
    }
    if (new TextEncoder().encode(serialized).byteLength > ANALYSIS_SNAPSHOT_MAX_BYTES) {
      return null;
    }
    storage.setItem(ANALYSIS_SNAPSHOT_STORAGE_KEY, serialized);
    return Date.parse(savedAt);
  } catch {
    // 분석 결과 저장이 불가능해도 현재 화면의 분석은 계속 제공한다.
    return null;
  }
}

function restoreAnalysisSnapshot(profile) {
  const snapshot = readAnalysisSnapshot(profile?.id);
  if (!snapshot) return false;
  const expectedCrops = new Set(
    (profile.crops ?? []).map((crop) => String(crop).toUpperCase()),
  );
  const analyses = snapshot.analyses.filter((analysis) =>
    expectedCrops.has(analysis.inputSummary.crop)
  );
  if (analyses.length === 0) return false;
  currentAnalyses = new Map(
    analyses.map((analysis) => [analysis.inputSummary.crop, analysis]),
  );
  currentAnalysis = analyses[0];
  currentUiContexts = new Map(
    analyses.map((analysis) => {
      const crop = analysis.inputSummary.crop;
      const cropValue = crop.toLowerCase();
      const setting = profile.cropSettings?.[cropValue] ?? {};
      const storedContext = snapshot.uiContexts?.[crop] ?? {};
      const cycleInput = storedCropCycleInput(profile, cropValue, setting.cycle);
      return [
        crop,
        {
          cultivationLabel:
            storedContext.cultivationLabel ??
            CULTIVATION_LABELS[analysis.inputSummary.cultivationMode] ??
            "재배 환경 확인",
          growthLabel:
            storedContext.growthLabel ??
            GROWTH_LABELS[setting.growth] ??
            "생육 상태 확인",
          growthRecommended: storedContext.growthRecommended === true,
          cycleInput,
          cycleProjection: projectLocalCropCycle({
            crop: cropValue,
            input: cycleInput,
            sourceLabel: hasStoredCropCycle(setting.cycle)
              ? "입력 기준 예상"
              : "날짜 기준 AI 예상",
          }),
        },
      ];
    }),
  );
  actionPlanCache.clear();
  actionPlanRequests.clear();
  currentActionPlan = null;
  const savedTime = Date.parse(snapshot.savedAt);
  lastAnalysisRequestAt = Number.isFinite(savedTime) ? savedTime : 0;
  renderAnalysis(currentAnalysis);
  dashboardMode = "overview";
  renderFarmOverview();
  renderCropResultSwitcher();
  closeWizardAfterAnalysis();
  announce("저장된 최근 분석 결과를 불러왔습니다.");
  return true;
}

function readStoredSoilTest() {
  const storage = safeStorage();
  const farmId = storage?.getItem(ACTIVE_FARM_STORAGE_KEY);
  if (!storage || !farmId) return readLegacySoilTest(storage);
  const tests = readStoredSoilTests(storage);
  if (isStoredSoilTest(tests[farmId])) return tests[farmId];
  const legacy = readLegacySoilTest(storage);
  if (!legacy) return null;
  tests[farmId] = legacy;
  storage.setItem(SOIL_TESTS_STORAGE_KEY, JSON.stringify(tests));
  storage.removeItem(SOIL_TEST_STORAGE_KEY);
  return legacy;
}

function writeStoredSoilTest(value) {
  const storage = safeStorage();
  if (!storage) return;
  const farmId = storage.getItem(ACTIVE_FARM_STORAGE_KEY);
  if (!farmId) {
    if (value === null) storage.removeItem(SOIL_TEST_STORAGE_KEY);
    else storage.setItem(SOIL_TEST_STORAGE_KEY, JSON.stringify(value));
    return;
  }
  const tests = readStoredSoilTests(storage);
  if (value === null) delete tests[farmId];
  else if (isStoredSoilTest(value)) tests[farmId] = value;
  storage.setItem(SOIL_TESTS_STORAGE_KEY, JSON.stringify(tests));
  storage.removeItem(SOIL_TEST_STORAGE_KEY);
}

function readStoredSoilTests(storage = safeStorage()) {
  if (!storage) return {};
  try {
    const value = JSON.parse(storage.getItem(SOIL_TESTS_STORAGE_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(([farmId, soilTest]) =>
        typeof farmId === "string" && farmId.length <= 160 && isStoredSoilTest(soilTest)
      ),
    );
  } catch {
    return {};
  }
}

function readLegacySoilTest(storage = safeStorage()) {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(SOIL_TEST_STORAGE_KEY) ?? "null");
    return isStoredSoilTest(value) ? value : null;
  } catch {
    return null;
  }
}

function isStoredSoilTest(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Number.isFinite(value.ph));
}

function restoreScopedSoilTests(value, allowedFarmIds, storage = safeStorage()) {
  if (!storage || !value || typeof value !== "object" || Array.isArray(value)) return;
  const allowed = new Set(allowedFarmIds);
  const tests = Object.fromEntries(
    Object.entries(value).filter(([farmId, soilTest]) =>
      allowed.has(farmId) && isStoredSoilTest(soilTest)
    ),
  );
  storage.setItem(SOIL_TESTS_STORAGE_KEY, JSON.stringify(tests));
  storage.removeItem(SOIL_TEST_STORAGE_KEY);
}

function rememberRegion(displayName) {
  if (typeof displayName !== "string" || displayName.trim() === "") return;
  safeStorage()?.setItem(REGION_STORAGE_KEY, displayName.trim());
  renderRegionLabels();
}

function readStoredRegion() {
  return safeStorage()?.getItem(REGION_STORAGE_KEY) ?? null;
}

/**
 * 마지막으로 분석한 조건을 기억한다. 후보 토큰은 10분이면 만료되므로
 * 토큰 대신 사람이 읽는 지역명을 저장하고, 복원할 때 다시 검색해서
 * 새 토큰을 받는다.
 */
function writeStoredSession(values, region) {
  const storage = safeStorage();
  if (!storage || typeof region !== "string" || !region.trim()) return;
  try {
    const profile = {
      situation: values.situation,
      crops: values.crops,
      cropSettings: values.cropSettings,
      region: region.trim(),
    };
    const farms = readStoredFarms();
    const activeId = storage.getItem(ACTIVE_FARM_STORAGE_KEY);
    const current =
      creatingNewFarm ? null : farms.find((farm) => farm.id === activeId);
    const farm = {
      ...profile,
      id: current?.id ?? createFarmId(),
      name: farmDisplayName(profile),
      updatedAt: new Date().toISOString(),
    };
    const nextFarms = [
      farm,
      ...farms.filter((item) => item.id !== farm.id),
    ].slice(0, 12);
    storage.setItem(FARMS_STORAGE_KEY, JSON.stringify(nextFarms));
    storage.setItem(ACTIVE_FARM_STORAGE_KEY, farm.id);
    // 이전 버전과의 호환을 위해 현재 농장 한 건도 함께 유지한다.
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(profile));
    storage.setItem(REGION_STORAGE_KEY, profile.region);
    creatingNewFarm = false;
    renderFarmLists();
    void syncStoredWorkspaceBackup({ createIfMissing: true });
  } catch {
    // 저장소가 가득 찼거나 막혀 있으면 복원 없이 계속 쓴다.
  }
}

function readStoredSession() {
  const storage = safeStorage();
  const farms = readStoredFarms();
  if (farms.length) {
    const activeId = storage?.getItem(ACTIVE_FARM_STORAGE_KEY);
    return farms.find((farm) => farm.id === activeId) ?? farms[0];
  }
  const raw = storage?.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isStoredFarmProfile(parsed)) return null;
    if (storage) {
      const migrated = {
        ...parsed,
        id: createFarmId(),
        name: farmDisplayName(parsed),
        updatedAt: new Date().toISOString(),
      };
      storage.setItem(FARMS_STORAGE_KEY, JSON.stringify([migrated]));
      storage.setItem(ACTIVE_FARM_STORAGE_KEY, migrated.id);
      return migrated;
    }
    return parsed;
  } catch {
    return null;
  }
}

function clearStoredSession() {
  const storage = safeStorage();
  storage?.removeItem(SESSION_STORAGE_KEY);
  storage?.removeItem(FARMS_STORAGE_KEY);
  storage?.removeItem(ACTIVE_FARM_STORAGE_KEY);
  storage?.removeItem(ANALYSIS_SNAPSHOT_STORAGE_KEY);
}

function readStoredFarms() {
  const raw = safeStorage()?.getItem(FARMS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (farm) => typeof farm?.id === "string" && isStoredFarmProfile(farm),
        )
      : [];
  } catch {
    return [];
  }
}

function isStoredFarmProfile(profile) {
  return (
    typeof profile?.region === "string" &&
    profile.region.trim() !== "" &&
    ["planning", "growing"].includes(profile?.situation) &&
    Array.isArray(profile?.crops) &&
    profile.crops.length > 0
  );
}

function storedCropCycleInput(profile, crop, value) {
  try {
    return normalizeCropCycleInput(value, {
      crop,
      situation: profile?.situation ?? "growing",
    });
  } catch {
    return createDefaultCropCycleInput({
      crop,
      situation: profile?.situation ?? "growing",
      growth: profile?.cropSettings?.[crop]?.growth ?? "unknown",
    });
  }
}

function hasStoredCropCycle(value) {
  return value !== null && typeof value === "object" &&
    typeof value.seasonId === "string" &&
    typeof value.anchorDate === "string";
}

function cropCycleRequestsForProfile(profile) {
  const crops = Array.isArray(profile?.crops) ? profile.crops : [];
  return buildCropCycleRequests({
    situation: profile?.situation ?? "growing",
    crops,
    cropSettings: Object.fromEntries(crops.map((crop) => [
      crop,
      {
        ...profile?.cropSettings?.[crop],
        cycle: storedCropCycleInput(
          profile,
          crop,
          profile?.cropSettings?.[crop]?.cycle,
        ),
      },
    ])),
  });
}

function createFarmId() {
  return globalThis.crypto?.randomUUID?.() ??
    `farm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function farmDisplayName(profile) {
  const region =
    profile?.region
      ?.replace(/^(대한민국|한국)\s*/u, "")
      .split(/\s+/u)
      .slice(-2)
      .join(" ") || "내 농장";
  const cropValues = profile?.crops ?? [];
  const crops = cropValues
    .slice(0, 2)
    .map((crop) => CROP_LABELS[String(crop).toUpperCase()] ?? crop)
    .join("·");
  const remaining = Math.max(0, cropValues.length - 2);
  return crops
    ? `${region} · ${crops}${remaining ? ` 외 ${remaining}종` : ""}`
    : region;
}

function renderFarmList(
  target = document.querySelector(".sidebar-recent"),
  { includeHeading = true } = {},
) {
  if (!target) return;
  const farms = readStoredFarms();
  const activeId = safeStorage()?.getItem(ACTIVE_FARM_STORAGE_KEY);
  const list = element("div", "farm-switcher");
  for (const farm of farms) {
    const button = element(
      "button",
      `farm-switch-button${farm.id === activeId ? " is-active" : ""}`,
    );
    button.type = "button";
    button.dataset.farmId = farm.id;
    if (farm.id === activeId) button.setAttribute("aria-current", "true");
    button.append(
      element("strong", "", farmDisplayName(farm)),
      element(
        "span",
        "",
        farm.situation === "growing" ? "재배 관리" : "재배 준비 진단",
      ),
    );
    button.addEventListener("click", () => selectStoredFarm(farm));
    list.append(button);
  }
  const add = element("button", "farm-add-button", "＋ 농장 추가");
  add.type = "button";
  add.id = includeHeading ? "add-farm" : "add-farm-mobile";
  add.dataset.openNewFarm = "true";
  const heading = element("h2", "", "내 농장");
  if (includeHeading) heading.id = "sidebar-recent-title";
  target.replaceChildren(
    ...(includeHeading ? [heading] : []),
    add,
    ...(farms.length
      ? [list]
      : [element("p", "recent-analysis", "저장된 농장이 없습니다.")]),
  );
}

function renderFarmLists() {
  renderFarmList();
  const mobileFarmList = document.querySelector(".mobile-farm-list");
  if (mobileFarmList) renderFarmList(mobileFarmList, { includeHeading: false });
}

function setupMobileFarmDialog() {
  const dialog = document.querySelector("#mobile-farm-dialog");
  const trigger = document.querySelector("#mobile-farm-trigger");
  const close = document.querySelector("#mobile-farm-close");
  if (!dialog || !trigger || !close) return;
  trigger.addEventListener("click", () => {
    renderFarmList(document.querySelector(".mobile-farm-list"), {
      includeHeading: false,
    });
    dialog.showModal();
    close.focus();
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => trigger.focus());
}

function selectStoredFarm(farm) {
  const storage = safeStorage();
  if (!storage || !isStoredFarmProfile(farm)) return;
  const { id, name, updatedAt, ...profile } = farm;
  storage.setItem(ACTIVE_FARM_STORAGE_KEY, id);
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(profile));
  window.location.reload();
}

function startNewFarm() {
  const mobileFarmDialog = document.querySelector("#mobile-farm-dialog");
  if (mobileFarmDialog?.open) mobileFarmDialog.close();
  creatingNewFarm = true;
  clearSelectedCandidate("");
}

document.addEventListener("heuknalssi:new-farm-started", startNewFarm);

function notificationsSupported() {
  return (
    typeof Notification !== "undefined" &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator
  );
}

async function registerServiceWorker() {
  if (!notificationsSupported()) return null;
  if (serviceWorkerReady) return serviceWorkerReady;
  serviceWorkerReady = navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then(() => navigator.serviceWorker.ready)
    .catch(() => null);
  return serviceWorkerReady;
}

/**
 * 알림 본문은 마지막 분석에서 뽑은 "오늘 먼저 할 일"이다.
 * 분석이 없으면 없는 내용을 지어내지 않고 확인을 권하는 문구만 보낸다.
 */
function writeStoredTodo(analysis) {
  const storage = safeStorage();
  const saveConsent = document.querySelector("#save-consent");
  if (!storage || saveConsent?.checked !== true) return;
  const headline =
    analysis?.primaryAction?.title ??
    analysis?.actions?.[0]?.title ??
    null;
  const decision = analysis?.decision?.headline ?? null;
  const crop = analysis?.inputSummary?.cropLabel ?? null;
  const cropCode = analysis?.inputSummary?.crop ?? null;
  const region = analysis?.inputSummary?.regionLabel ?? readStoredRegion();
  if (!headline) return;
  try {
    writeStoredTodoForActiveFarm({ headline, decision, crop, region }, storage, cropCode);
    void syncStoredWorkspaceBackup();
  } catch {
    /* 저장소가 막혀 있으면 알림 본문만 일반 문구가 된다. */
  }
}

function writeStoredTodoFromPlan(plan, analysis) {
  const storage = safeStorage();
  const saveConsent = document.querySelector("#save-consent");
  if (!storage || saveConsent?.checked !== true) return;
  const action = plan?.firstAction;
  const cropCode = analysis?.inputSummary?.crop ?? null;
  try {
    if (!action || action.status !== "OPEN") {
      writeStoredTodoForActiveFarm(null, storage, cropCode);
      void syncStoredWorkspaceBackup();
      return;
    }
    const crop = analysis?.inputSummary?.cropLabel ?? null;
    const region = analysis?.inputSummary?.regionLabel ?? readStoredRegion();
    writeStoredTodoForActiveFarm({
      headline: action.title,
      decision: action.instruction,
      dueAt: action.dueAt,
      crop,
      region,
    }, storage, cropCode);
    void syncStoredWorkspaceBackup();
  } catch {
    /* 저장소가 막혀 있어도 실제 행동 계획 조회와 저장은 계속 사용할 수 있다. */
  }
}

function readStoredTodo() {
  const storage = safeStorage();
  const farmId = storage?.getItem(ACTIVE_FARM_STORAGE_KEY);
  if (!storage) return null;
  try {
    const todos = JSON.parse(storage.getItem(TODOS_STORAGE_KEY) ?? "{}");
    if (farmId && todos && typeof todos === "object" && !Array.isArray(todos)) {
      const scoped = Object.entries(todos)
        .filter(([key, todo]) =>
          (key === farmId || key.startsWith(`${farmId}::`)) &&
          todo && typeof todo === "object" && !Array.isArray(todo) && todo.headline
        )
        .map(([, todo]) => todo)
        .sort((left, right) => todoDueTime(left) - todoDueTime(right));
      if (scoped.length > 0) return scoped[0];
    }
    const legacy = JSON.parse(storage.getItem(TODO_STORAGE_KEY) ?? "null");
    if (farmId && legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
      writeStoredTodoForActiveFarm(legacy, storage);
      storage.removeItem(TODO_STORAGE_KEY);
      return legacy;
    }
    return null;
  } catch {
    return null;
  }
}

function writeStoredTodoForActiveFarm(todo, storage = safeStorage(), cropCode = todo?.cropCode ?? null) {
  const farmId = storage?.getItem(ACTIVE_FARM_STORAGE_KEY);
  if (!storage || !farmId) return;
  let todos = {};
  try {
    const parsed = JSON.parse(storage.getItem(TODOS_STORAGE_KEY) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) todos = parsed;
  } catch {
    todos = {};
  }
  const normalizedCropCode = String(cropCode ?? "").trim().toUpperCase();
  const storageKey = normalizedCropCode ? `${farmId}::${normalizedCropCode}` : farmId;
  if (normalizedCropCode) delete todos[farmId];
  if (todo === null) delete todos[storageKey];
  else todos[storageKey] = { ...todo, cropCode: normalizedCropCode || null };
  storage.setItem(TODOS_STORAGE_KEY, JSON.stringify(todos));
}

function todoDueTime(todo) {
  const dueAt = Date.parse(todo?.dueAt ?? "");
  return Number.isFinite(dueAt) ? dueAt : Number.POSITIVE_INFINITY;
}

function readStoredTodos(storage = safeStorage()) {
  if (!storage) return {};
  try {
    const value = JSON.parse(storage.getItem(TODOS_STORAGE_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function todoNotificationCopy() {
  const todo = readStoredTodo();
  if (!todo?.headline) {
    return {
      title: "흙날씨 · 오늘 확인할 일",
      body: "앱을 열어 오늘의 기상·토양 상태를 확인해 주세요.",
    };
  }
  const where = [todo.region, todo.crop].filter(Boolean).join(" · ");
  const dueToday = todo.dueAt
    ? seoulDateKey(todo.dueAt) <= seoulDateKey(new Date())
    : true;
  return {
    title: `${dueToday ? "오늘 먼저 할 일" : "다음 할 일"} — ${todo.headline}`,
    body: [where, todo.decision].filter(Boolean).join(" | ") || "흙날씨 농지 진단",
  };
}

function seoulDateKey(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

async function showNotificationNow(copy) {
  const registration = await registerServiceWorker();
  if (registration?.active) {
    registration.active.postMessage({ type: "SHOW_NOTIFICATION", ...copy });
    return true;
  }
  if (registration) {
    await registration.showNotification(copy.title, { body: copy.body, lang: "ko" });
    return true;
  }
  return false;
}

function readStoredAlarm() {
  const raw = safeStorage()?.getItem(ALARM_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return /^\d{2}:\d{2}$/u.test(parsed?.time ?? "") ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredAlarm(alarm) {
  safeStorage()?.setItem(ALARM_STORAGE_KEY, JSON.stringify(alarm));
}

function todayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * 앱이 떠 있는 동안에는 타이머로, 앱을 다시 열었을 때는 지나간 시각을
 * 확인해서 하루 한 번만 보낸다. 완전 종료 상태의 발송은 서버 푸시가 있어야 한다.
 */
function scheduleAlarm() {
  if (alarmTimer !== null) {
    clearTimeout(alarmTimer);
    alarmTimer = null;
  }
  const alarm = readStoredAlarm();
  if (
    !notificationsSupported() ||
    !alarm ||
    Notification.permission !== "granted"
  ) {
    return;
  }

  const now = new Date();
  const [hour, minute] = alarm.time.split(":").map(Number);
  const due = new Date(now);
  due.setHours(hour, minute, 0, 0);

  // 오늘 발송 시각이 이미 지났는데 아직 안 보냈다면 지금 보낸다.
  if (due <= now) {
    if (alarm.lastSentOn !== todayKey(now)) {
      void showNotificationNow(todoNotificationCopy());
      writeStoredAlarm({ ...alarm, lastSentOn: todayKey(now) });
    }
    due.setDate(due.getDate() + 1);
  }

  const waitMs = due.getTime() - now.getTime();
  // setTimeout은 약 24.8일이 상한이라 하루치는 안전하다.
  alarmTimer = setTimeout(() => {
    void showNotificationNow(todoNotificationCopy());
    writeStoredAlarm({ ...readStoredAlarm(), lastSentOn: todayKey(new Date()) });
    scheduleAlarm();
  }, Math.max(waitMs, 0));
}

function renderNotificationState() {
  const badge = document.querySelector("#notification-permission-state");
  const permissionCopy = document.querySelector("#risk-notification-status");
  const status = document.querySelector("#notification-status");
  const enableButton = document.querySelector("#notification-enable");
  const saveButton = document.querySelector("#notification-save");
  const testButton = document.querySelector("#notification-test");
  const timeInput = document.querySelector("#notification-time");
  if (!badge) return;

  if (!notificationsSupported()) {
    badge.textContent = "지원 안 함";
    if (permissionCopy) {
      permissionCopy.textContent =
        "이 브라우저는 알림을 지원하지 않습니다. 크롬이나 사파리에서 열어 주세요.";
    }
    if (enableButton) enableButton.disabled = true;
    if (saveButton) saveButton.disabled = true;
    if (testButton) testButton.disabled = true;
    if (timeInput) timeInput.disabled = true;
    if (status) {
      status.textContent =
        "이 브라우저에서는 알림 시간을 저장하거나 시험할 수 없습니다.";
    }
    return;
  }

  if (enableButton) enableButton.disabled = false;
  if (saveButton) saveButton.disabled = false;
  if (testButton) testButton.disabled = false;
  if (timeInput) timeInput.disabled = false;
  const permission = Notification.permission;
  badge.textContent =
    permission === "granted" ? "켜짐" : permission === "denied" ? "차단됨" : "꺼짐";
  badge.classList.toggle("good", permission === "granted");
  if (enableButton) enableButton.hidden = permission === "granted";
  if (permissionCopy) {
    permissionCopy.textContent =
      permission === "granted"
        ? "알림이 허용되어 있습니다."
        : permission === "denied"
          ? "브라우저에서 알림이 차단되어 있습니다. 사이트 설정에서 허용으로 바꿔 주세요."
          : "휴대폰에서 알림을 받으려면 먼저 허용해 주세요.";
  }

  const alarm = readStoredAlarm();
  if (alarm && timeInput) timeInput.value = alarm.time;
  if (status) {
    status.textContent = alarm
      ? `매일 ${alarm.time}에 오늘 할 일을 보내 드립니다.`
      : "아직 알림 시간을 저장하지 않았습니다.";
  }
}

function setupNotificationPanel() {
  const enableButton = document.querySelector("#notification-enable");
  if (!enableButton) return;
  const status = document.querySelector("#notification-status");

  void registerServiceWorker();
  renderNotificationState();

  enableButton.addEventListener("click", async () => {
    if (!notificationsSupported()) return;
    const permission = await Notification.requestPermission();
    renderNotificationState();
    if (permission === "granted") {
      await registerServiceWorker();
      scheduleAlarm();
      if (status) status.textContent = "알림을 허용했습니다. 시간을 정해 주세요.";
    }
  });

  document.querySelector("#notification-save")?.addEventListener("click", async () => {
    if (!notificationsSupported()) {
      if (status) status.textContent = "이 브라우저는 알림을 지원하지 않습니다.";
      return;
    }
    const time = document.querySelector("#notification-time")?.value ?? "";
    if (!/^\d{2}:\d{2}$/u.test(time)) {
      if (status) status.textContent = "알림 받을 시간을 골라 주세요.";
      return;
    }
    if (Notification.permission !== "granted") {
      if (status) status.textContent = "먼저 위에서 알림을 허용해 주세요.";
      return;
    }
    writeStoredAlarm({ time, lastSentOn: null });
    await syncStoredWorkspaceBackup();
    scheduleAlarm();
    renderNotificationState();
  });

  document.querySelector("#notification-test")?.addEventListener("click", async () => {
    if (!notificationsSupported()) {
      if (status) status.textContent = "이 브라우저는 알림을 지원하지 않습니다.";
      return;
    }
    if (Notification.permission !== "granted") {
      const permission = await Notification.requestPermission();
      renderNotificationState();
      if (permission !== "granted") {
        if (status) status.textContent = "알림이 허용되지 않아 시험 알림을 보낼 수 없습니다.";
        return;
      }
    }
    await registerServiceWorker();
    if (status) status.textContent = "10초 뒤에 시험 알림이 갑니다. 앱을 닫지 마세요.";
    setTimeout(() => {
      const copy = todoNotificationCopy();
      void showNotificationNow({
        ...copy,
        title: `[시험] ${copy.title}`,
        tag: "heuknalssi-test",
      });
      if (status) status.textContent = "시험 알림을 보냈습니다.";
    }, 10_000);
  });

  // 앱으로 돌아왔을 때 밀린 알림을 확인한다.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleAlarm();
  });
  scheduleAlarm();
}

/** "경북 안동시 퇴계로 115" → "안동시" 처럼 센터를 찾을 행정구역만 남긴다. */
function administrativeUnit(displayName) {
  const match = String(displayName ?? "").match(/([가-힣]+(?:시|군|구))/u);
  return match ? match[1] : null;
}

function renderRegionLabels() {
  const region = readStoredRegion() ?? selectedCandidate?.displayName ?? null;
  const profileRegion = document.querySelector("#profile-region");
  if (profileRegion) {
    profileRegion.textContent = region ?? "저장된 기본 지역 없음";
  }
  const center = document.querySelector("#soil-exam-center");
  if (center) {
    const unit = administrativeUnit(region);
    center.textContent = unit ? `${unit} 농업기술센터` : "농업기술센터";
  }
}

function renderSoilTestState() {
  const stored = readStoredSoilTest();
  const badge = document.querySelector("#soil-result-state");
  const status = document.querySelector("#soil-test-status");
  if (badge) {
    badge.textContent = stored ? "등록됨" : "등록 안 됨";
    badge.classList.toggle("good", Boolean(stored));
  }
  if (status) {
    status.textContent = stored
      ? `${stored.sampledOn} 검사 결과(산도 pH ${stored.ph})를 분석에 쓰고 있습니다. 다음 분석부터 내 밭 흙 기준으로 판단합니다.`
      : "아직 등록된 검사 결과가 없습니다. 지금은 동네 평균 토양 자료로 분석합니다.";
  }
  if (!stored) return;
  for (const field of SOIL_TEST_NUMERIC_FIELDS) {
    const input = document.querySelector(`#soil-test-form [name="${field}"]`);
    if (input && stored[field] !== undefined) input.value = String(stored[field]);
  }
  const date = document.querySelector("#soil-test-date");
  if (date && stored.sampledOn) date.value = stored.sampledOn;
  const issuer = document.querySelector("#soil-test-issuer");
  if (issuer && stored.issuer) issuer.value = stored.issuer;
}

function setupSoilTestPanel() {
  const form = document.querySelector("#soil-test-form");
  if (!form) return;
  const errorLine = document.querySelector("#soil-test-error");
  const photoInput = document.querySelector("#soil-test-photo");
  const preview = document.querySelector("#soil-test-photo-preview");
  const previewImage = document.querySelector("#soil-test-photo-image");
  const previewStatus = document.querySelector("#soil-test-photo-status");
  let previewUrl = null;

  const showError = (message) => {
    if (!errorLine) return;
    errorLine.textContent = message;
    errorLine.hidden = message === "";
  };

  photoInput?.addEventListener("change", () => {
    const file = photoInput.files?.[0] ?? null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    if (!file) {
      if (preview) preview.hidden = true;
      return;
    }
    if (previewStatus) {
      previewStatus.textContent = `${file.name} — 이 기기에만 보관합니다.`;
    }
    if (file.type.startsWith("image/") && previewImage) {
      previewUrl = URL.createObjectURL(file);
      previewImage.src = previewUrl;
      previewImage.hidden = false;
    } else if (previewImage) {
      previewImage.hidden = true;
    }
    if (preview) preview.hidden = false;
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    showError("");
    const candidate = { userConfirmed: true };
    for (const field of SOIL_TEST_NUMERIC_FIELDS) {
      const raw = form.querySelector(`[name="${field}"]`)?.value?.trim() ?? "";
      if (raw !== "") candidate[field] = Number(raw);
    }
    candidate.sampledOn = document.querySelector("#soil-test-date")?.value ?? "";
    const issuer = document.querySelector("#soil-test-issuer")?.value?.trim() ?? "";
    if (issuer !== "") candidate.issuer = issuer;

    if (!Number.isFinite(candidate.ph)) {
      showError("산도 pH를 넣어 주세요. 결과지에 pH 또는 산도라고 적혀 있습니다.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(candidate.sampledOn)) {
      showError("검사받은 날짜를 넣어 주세요.");
      return;
    }
    try {
      // 저장 전에 서버와 같은 규칙으로 한 번 걸러 낸다.
      buildAnalysisRequest(
        {
          situation: "planning",
          crop: "potato",
          cultivation: "open-field",
          season: "spring",
          analysisMonth: new Date().getMonth() + 1,
          soilTest: candidate,
        },
        "validation-only-token",
      );
    } catch (error) {
      showError(
        error instanceof ContractValidationError
          ? error.message
          : "입력한 값을 다시 확인해 주세요.",
      );
      return;
    }
    writeStoredSoilTest(candidate);
    renderSoilTestState();
    renderDashboardSoilTest();
    // 등록 즉시 대시보드가 실측 기준으로 바뀌도록 같은 조건으로 다시 분석한다.
    if (readStoredSession()) {
      const status = document.querySelector("#soil-test-status");
      if (status) {
        status.textContent =
          "등록했습니다. 이 검사 결과로 농장 분석을 다시 계산하고 있습니다…";
      }
      void restoreSavedSession("등록한 검사 결과로 다시 분석하는 중입니다.").then(
        () => {
          renderSoilTestState();
          renderDashboardSoilTest();
        },
      );
    }
  });

  document.querySelector("#soil-test-clear")?.addEventListener("click", () => {
    showError("");
    writeStoredSoilTest(null);
    form.reset();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    if (preview) preview.hidden = true;
    renderSoilTestState();
    renderDashboardSoilTest();
  });

  renderSoilTestState();
  renderRegionLabels();
}

// 검정 지표 ↔ 화면 표기. 서버가 쓰는 지표 이름과 짝을 맞춘다.
const SOIL_METRIC_LABELS = Object.freeze({
  PH: "산도 pH",
  EC: "전기전도도",
  ORGANIC_MATTER: "유기물",
  AVAILABLE_PHOSPHATE: "유효인산",
  EXCHANGEABLE_K: "칼륨 K",
  EXCHANGEABLE_CA: "칼슘 Ca",
  EXCHANGEABLE_MG: "마그네슘 Mg",
});
const SOIL_METRIC_FIELDS = Object.freeze({
  PH: "ph",
  EC: "electricalConductivity",
  ORGANIC_MATTER: "organicMatter",
  AVAILABLE_PHOSPHATE: "availablePhosphate",
  EXCHANGEABLE_K: "exchangeableK",
  EXCHANGEABLE_CA: "exchangeableCa",
  EXCHANGEABLE_MG: "exchangeableMg",
});

/** 해당 규칙의 검수된 적정범위를 근거 자료에서 꺼낸다. 없으면 표시하지 않는다. */
function metricOptimalRange(soil, ruleId) {
  const entries = Array.isArray(soil?.evidence) ? soil.evidence : [];
  for (const entry of entries) {
    if (ruleId && entry?.evidenceId !== `SOIL_${ruleId}`) continue;
    const range = entry?.calculation?.classifiedMetric?.reviewedOptimalRange;
    if (Array.isArray(range) && range.length === 2) return range;
  }
  return null;
}

/** 등록된 검사 결과를 대시보드 맨 위 카드에 보여 준다. */
function renderDashboardSoilTest() {
  const card = document.querySelector("#dashboard-soil-test");
  if (!card) return;
  const stored = readStoredSoilTest();
  if (!stored) {
    card.hidden = true;
    return;
  }
  const meta = document.querySelector("#dashboard-soil-test-meta");
  if (meta) {
    meta.textContent = `${stored.sampledOn} 검사${
      stored.issuer ? ` · ${stored.issuer}` : ""
    }`;
  }
  const list = document.querySelector("#dashboard-soil-test-values");
  if (list) {
    const nodes = [];
    for (const field of SOIL_TEST_NUMERIC_FIELDS) {
      if (stored[field] === undefined) continue;
      const [label, unit] = SOIL_TEST_LABELS[field];
      nodes.push(element("dt", "condition-fact-label", label));
      nodes.push(
        element(
          "dd",
          "condition-fact-title",
          unit === "" ? String(stored[field]) : `${stored[field]} ${unit}`,
        ),
      );
    }
    list.replaceChildren(...nodes);
  }
  card.hidden = false;
}

// ── 계정 열쇠(기기 이관) ─────────────────────────────────────────────
function renderAccountKeyValue(key, statusMessage = null) {
  const valueLabel = document.querySelector("#account-key-value");
  const hint = document.querySelector("#account-key-hint");
  const copyButton = document.querySelector("#account-key-copy");
  const status = document.querySelector("#account-key-status");
  if (valueLabel) valueLabel.textContent = key ?? "—";
  if (hint) {
    hint.textContent = key
      ? "다른 기기에서 농장 설정을 복원하려면 이 열쇠를 따로 보관해 주세요."
      : "아직 만들지 않았습니다.";
  }
  if (copyButton) copyButton.hidden = !key;
  if (statusMessage && status) status.textContent = statusMessage;
}

function setupAccountKeyPanel() {
  const createButton = document.querySelector("#account-key-create");
  const restoreButton = document.querySelector("#account-key-restore");
  if (!createButton && !restoreButton) return;

  const status = document.querySelector("#account-key-status");
  const copyButton = document.querySelector("#account-key-copy");
  const errorLine = document.querySelector("#account-key-error");
  const storage = safeStorage();

  const showKey = (key) => renderAccountKeyValue(key);
  showKey(storage?.getItem(ACCOUNT_KEY_STORAGE_KEY) ?? null);

  createButton?.addEventListener("click", async () => {
    if (status) status.textContent = "열쇠를 만드는 중입니다…";
    const payload = buildDeviceBackupPayload(storage);
    if (Object.keys(payload).every((key) => ["version", "savedAt"].includes(key))) {
      if (status) {
        status.textContent =
          "먼저 검사 결과를 등록하거나 분석할 지역을 선택해 주세요.";
      }
      return;
    }
    try {
      const existing = storage?.getItem(ACCOUNT_KEY_STORAGE_KEY) ?? null;
      const result = await api.saveDeviceBackup(payload, existing);
      storage?.setItem(ACCOUNT_KEY_STORAGE_KEY, result.accountKey);
      showKey(result.accountKey);
      if (status) {
        status.textContent =
          "농장 위치·작물·재배 기준일과 설정을 보관했습니다. 분석 결과·할 일 기록·사진·리포트는 이관되지 않습니다.";
      }
    } catch (error) {
      if (status) {
        status.textContent =
          error?.code === "BACKUP_NOT_CONFIGURED"
            ? "지금은 보관 기능을 쓸 수 없습니다. 이 기기에는 그대로 저장되어 있습니다."
            : "보관하지 못했습니다. 잠시 뒤 다시 눌러 주세요.";
      }
    }
  });

  copyButton?.addEventListener("click", async () => {
    const key = storage?.getItem(ACCOUNT_KEY_STORAGE_KEY);
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      if (status) status.textContent = "열쇠를 복사했습니다.";
    } catch {
      if (status) status.textContent = "복사하지 못했습니다. 직접 적어 주세요.";
    }
  });

  restoreButton?.addEventListener("click", async () => {
    const input = document.querySelector("#account-key-input");
    const typed = input?.value?.trim() ?? "";
    const showError = (message) => {
      if (!errorLine) return;
      errorLine.textContent = message;
      errorLine.hidden = message === "";
    };
    showError("");
    if (typed === "") {
      showError("적어 두신 계정 열쇠를 넣어 주세요.");
      return;
    }
    try {
      const result = await api.restoreDeviceBackup(typed);
      const payload = result.payload ?? {};
      if (payload.region) rememberRegion(payload.region);
      const restoredWorkspace = restoreFarmWorkspace(payload, storage);
      if (restoredWorkspace) {
        const restoredSoilTests = payload.soilTestsByFarmId ??
          (payload.soilTest && restoredWorkspace.active?.id
            ? { [restoredWorkspace.active.id]: payload.soilTest }
            : {});
        restoreScopedSoilTests(
          restoredSoilTests,
          restoredWorkspace.farms.map(({ id }) => id),
          storage,
        );
      }
      if (payload.alarm) {
        storage?.setItem(ALARM_STORAGE_KEY, JSON.stringify(payload.alarm));
      }
      storage?.setItem(ACCOUNT_KEY_STORAGE_KEY, typed.toUpperCase());
      showKey(typed.toUpperCase());
      renderSoilTestState();
      renderRegionLabels();
      renderDashboardSoilTest();
      renderFarmLists();
      renderNotificationState();
      scheduleAlarm();
      if (status) status.textContent = "농장 설정을 불러와 이 기기에 저장했습니다.";
    } catch (error) {
      showError(
        error?.code === "BACKUP_NOT_FOUND"
          ? "그 열쇠로 보관된 자료가 없습니다. 열쇠를 다시 확인해 주세요."
          : error?.code === "INVALID_ACCOUNT_KEY"
            ? "열쇠 형식이 맞지 않습니다. 영문과 숫자 12자리입니다."
            : "불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
      );
    }
  });
}

function buildDeviceBackupPayload(storage = safeStorage()) {
  // 이전 단일 토양검정 저장값이 있으면 현재 농장 범위로 먼저 이관한다.
  readStoredSoilTest();
  const region = readStoredRegion();
  const farms = readStoredFarms()
    .map((farm) => sanitizeFarmForDeviceBackup(farm))
    .filter(Boolean);
  const activeFarmId = storage?.getItem(ACTIVE_FARM_STORAGE_KEY) ?? null;
  const alarm = readStoredJson(ALARM_STORAGE_KEY);
  const payload = { version: 2, savedAt: new Date().toISOString() };
  const farmIds = new Set(farms.map(({ id }) => id));
  const soilTestsByFarmId = Object.fromEntries(
    Object.entries(readStoredSoilTests(storage))
      .filter(([farmId]) => farmIds.has(farmId)),
  );
  if (Object.keys(soilTestsByFarmId).length) {
    payload.soilTestsByFarmId = soilTestsByFarmId;
  }
  if (region) payload.region = region;
  if (farms.length) {
    payload.farms = farms;
    payload.activeFarmId = farms.some(({ id }) => id === activeFarmId)
      ? activeFarmId
      : farms[0].id;
  }
  if (alarm) payload.alarm = alarm;
  return payload;
}

async function performStoredWorkspaceBackup({ createIfMissing }) {
  const storage = safeStorage();
  let accountKey = storage?.getItem(ACCOUNT_KEY_STORAGE_KEY) ?? null;
  const available = ["READY", "AVAILABLE"].includes(
    preflight?.capabilities?.deviceBackup,
  );
  if (!connected || !available || (!accountKey && !createIfMissing)) {
    return false;
  }
  try {
    const result = await api.saveDeviceBackup(
      buildDeviceBackupPayload(storage),
      accountKey,
    );
    if (!accountKey && typeof result?.accountKey === "string") {
      accountKey = result.accountKey;
      storage?.setItem(ACCOUNT_KEY_STORAGE_KEY, accountKey);
      renderAccountKeyValue(
        accountKey,
        "농장 위치·작물·재배 기준일과 설정을 보관했습니다. 분석·행동·사진·리포트 기록은 이관되지 않습니다.",
      );
    }
    return true;
  } catch {
    // 로컬 농장·알림·할 일은 유지한다. 다음 설정 변경 때 다시 시도한다.
    return false;
  }
}

async function syncStoredWorkspaceBackup({ createIfMissing = false } = {}) {
  if (backupSyncPromise) return backupSyncPromise;
  backupSyncPromise = performStoredWorkspaceBackup({ createIfMissing });
  try {
    return await backupSyncPromise;
  } finally {
    backupSyncPromise = null;
  }
}

function readStoredJson(key) {
  const raw = safeStorage()?.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function restoreFarmWorkspace(payload, storage) {
  if (!storage || !Array.isArray(payload?.farms) || payload.farms.length === 0) {
    return;
  }
  const farms = sanitizeFarmsFromDeviceBackup(payload.farms).filter(
    (farm) => isStoredFarmProfile(farm),
  );
  if (farms.length === 0) return null;
  const active =
    farms.find(({ id }) => id === payload.activeFarmId) ?? farms[0];
  const { id, name, updatedAt, ...profile } = active;
  storage.setItem(FARMS_STORAGE_KEY, JSON.stringify(farms));
  storage.setItem(ACTIVE_FARM_STORAGE_KEY, id);
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(profile));
  storage.setItem(REGION_STORAGE_KEY, profile.region);
  return { farms, active };
}

function renderCropCycleSettings({ rememberExisting = true } = {}) {
  const root = document.querySelector("#crop-cycle-settings");
  if (!root) return;
  if (rememberExisting) rememberCropCycleDrafts();
  const crops = selectedCheckboxValues("crop");
  const situation = selectedRadioValue("situation") || "growing";
  const cards = crops.map((crop) => {
    let cycle = cropCycleDrafts.get(crop);
    if (!cycle) {
      cycle = createDefaultCropCycleInput({
        crop,
        situation,
        growth: selectedRadioValue(`growth-${crop}`) ?? "unknown",
        seasonId: createCropCycleSeasonId(crop),
      });
      cropCycleDrafts.set(crop, cycle);
    } else if (situation === "growing" && cycle.status === "PLANNING") {
      // 준비 진단에서 실제 재배로 전환해도 같은 시즌의 일정과 기록을 잇는다.
      cycle = { ...cycle, status: "ACTIVE" };
      cropCycleDrafts.set(crop, cycle);
    } else if (situation === "planning" && cycle.status !== "PLANNING") {
      const planning = createDefaultCropCycleInput({
        crop,
        situation,
        seasonId: cycle.seasonId,
      });
      cycle = { ...planning, seasonId: cycle.seasonId };
      cropCycleDrafts.set(crop, cycle);
    }

    const card = element("section", "crop-cycle-input-card");
    const heading = element("div", "crop-cycle-input-heading");
    heading.append(
      element("h3", "", `${CROP_LABELS[crop.toUpperCase()] ?? crop} 재배 기준일`),
      element(
        "p",
        "",
        situation === "planning"
          ? "예정 시작일로 준비·수확 일정 범위를 미리 봅니다."
          : "파종·정식·개화 중 기억하는 날짜 하나를 선택해 주세요.",
      ),
    );

    const fields = element("div", "crop-cycle-input-grid");
    const anchorField = element("label", "crop-cycle-field");
    anchorField.append(element("span", "", situation === "planning" ? "일정 기준" : "기준일 종류"));
    const anchor = element("select");
    anchor.name = `cycle-anchorType-${crop}`;
    anchor.setAttribute("aria-label", `${CROP_LABELS[crop.toUpperCase()] ?? crop} 기준일 종류`);
    for (const optionValue of cropCycleAnchorOptions(crop, situation)) {
      const option = element("option", "", optionValue.label);
      option.value = optionValue.value;
      option.selected = optionValue.value === cycle.anchorType;
      anchor.append(option);
    }
    anchorField.append(anchor);

    const dateField = element("label", "crop-cycle-field");
    dateField.append(element("span", "", situation === "planning" ? "예정 시작일" : "기준 날짜"));
    const date = element("input");
    date.type = "date";
    date.name = `cycle-anchorDate-${crop}`;
    date.value = cycle.anchorDate;
    date.required = true;
    date.setAttribute("aria-label", `${CROP_LABELS[crop.toUpperCase()] ?? crop} ${situation === "planning" ? "예정 시작일" : "재배 기준 날짜"}`);
    dateField.append(date);

    const seasonId = element("input");
    seasonId.type = "hidden";
    seasonId.name = `cycle-seasonId-${crop}`;
    seasonId.value = cycle.seasonId;
    const status = element("input");
    status.type = "hidden";
    status.name = `cycle-status-${crop}`;
    status.value = cycle.status;
    fields.append(anchorField, dateField, seasonId, status);
    card.append(heading, fields);
    return card;
  });
  root.replaceChildren(...cards);
}

function rememberCropCycleDrafts() {
  for (const crop of selectedCheckboxValues("crop")) {
    try {
      cropCycleDrafts.set(crop, readCropCycleForm(crop));
    } catch {
      // 작물 선택 직후에는 필드가 아직 그려지지 않을 수 있다.
    }
  }
}

function readCropCycleForm(crop, situation = selectedRadioValue("situation") || "growing") {
  return normalizeCropCycleInput(
    {
      seasonId: form.querySelector(`[name="cycle-seasonId-${crop}"]`)?.value,
      anchorType: form.querySelector(`[name="cycle-anchorType-${crop}"]`)?.value,
      anchorDate: form.querySelector(`[name="cycle-anchorDate-${crop}"]`)?.value,
      status: form.querySelector(`[name="cycle-status-${crop}"]`)?.value,
    },
    { crop, situation },
  );
}

function createCropCycleSeasonId(crop) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `season-${uuid}`
    : `season-${new Date().getFullYear()}-${crop}-${Date.now()}`;
}

function readFormValues() {
  const crops = selectedCheckboxValues("crop");
  return {
    situation: selectedRadioValue("situation") || "growing",
    crops,
    cropSettings: Object.fromEntries(
      crops.map((crop) => [
        crop,
        {
          cultivation: selectedRadioValue(`cultivation-${crop}`),
          season: selectedRadioValue(`season-${crop}`) ||
            (["apple", "pear"].includes(crop) ? "annual" : "unknown"),
          growth: selectedRadioValue(`growth-${crop}`),
          cycle: readCropCycleForm(crop),
        },
      ]),
    ),
    saveConsent: document.querySelector("#save-consent")?.checked === true,
    smartfarmAvailable: false,
    soilTest: readStoredSoilTest(),
  };
}

function collectUiAnalysisContexts(values, payloads) {
  return new Map(
    payloads.map((payload, index) => {
      const cropValue = values.crops[index];
      const setting = values.cropSettings[cropValue] ?? {};
      const checkedGrowth = form.querySelector(
        `input[name="growth-${cropValue}"]:checked`,
      );
      return [
        payload.crop,
        {
          cultivationLabel:
            CULTIVATION_LABELS[payload.cultivationMode] ?? "재배 환경 확인",
          growthLabel: GROWTH_LABELS[setting.growth] ?? "생육 상태 확인",
          growthRecommended: Boolean(
            checkedGrowth
              ?.closest(".choice-card")
              ?.querySelector(".choice-recommendation"),
          ),
          cycleInput: setting.cycle,
          cycleProjection: projectLocalCropCycle({
            crop: cropValue,
            input: setting.cycle,
          }),
        },
      ];
    }),
  );
}

function selectedRadioValue(name) {
  return form.querySelector(`input[name="${name}"]:checked`)?.value ?? "";
}

function selectedCheckboxValues(name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map(
    (input) => input.value,
  );
}

function cropSettingsComplete() {
  return selectedCheckboxValues("crop").every((crop) => {
    if (crop === "cucumber" || crop === "lettuce") {
      if (!selectedRadioValue(`cultivation-${crop}`)) return false;
    }
    try {
      readCropCycleForm(crop);
      return true;
    } catch {
      return false;
    }
  });
}

function growthSettingsComplete() {
  if ((selectedRadioValue("situation") || "growing") === "planning") {
    return true;
  }
  const crops = selectedCheckboxValues("crop");
  return (
    crops.length > 0 &&
    crops.every((crop) => Boolean(selectedRadioValue(`growth-${crop}`)))
  );
}

function analysisFormComplete() {
  return (
    selectedCheckboxValues("crop").length > 0 &&
    cropSettingsComplete() &&
    growthSettingsComplete()
  );
}

function syncVerifiedReview() {
  const region = document.querySelector("#review-region");
  if (region) {
    region.textContent = selectedCandidate?.displayName ?? "위치 확인 필요";
  }
  const situation = selectedRadioValue("situation") || "growing";
  const situationReview = document.querySelector("#review-situation");
  if (situationReview) {
    situationReview.textContent = situation === "planning"
      ? "재배 준비 진단"
      : "재배 중 생육 점검";
  }
  const cycleReview = document.querySelector("#review-cycle");
  if (cycleReview) {
    cycleReview.textContent = selectedCheckboxValues("crop")
      .map((crop) => {
        try {
          const cycle = readCropCycleForm(crop, situation);
          const anchor = cropCycleAnchorOptions(crop, situation)
            .find(({ value }) => value === cycle.anchorType)?.label ?? "기준일";
          return `${CROP_LABELS[crop.toUpperCase()] ?? crop} · ${anchor} ${formatCycleDate(cycle.anchorDate)}`;
        } catch {
          return `${CROP_LABELS[crop.toUpperCase()] ?? crop} · 확인 필요`;
        }
      })
      .join(" · ");
  }
}

function collectEvidence(analysis) {
  return ["climate", "soil", "observations", "forecast"].flatMap((module) =>
    Array.isArray(analysis?.[module]?.evidence)
      ? analysis[module].evidence
      : [],
  );
}

function stateLabel(state) {
  if (!state) return "제공되지 않음";
  return STATE_LABELS[state] ?? state.replaceAll("_", " ");
}

function isRegionalReferenceAnalysis(analysis) {
  return analysis?.analysisScope?.summary?.regionalReferenceOnly === true ||
    analysis?.inputSummary?.locationPrecision === "ADMIN_AREA_BROAD";
}

function analysisHasMissingSoilExamHistory(analysis) {
  const missingReasons = analysis?.analysisScope?.missingReasons;
  if (Array.isArray(missingReasons)) {
    return missingReasons.some(({ code }) => code === "NO_FIELD_SOIL_EXAM_HISTORY");
  }
  return hasMissingSoilExamHistory(analysis);
}

function stateHasUsableValues(state) {
  return ["READY", "COMPLETE", "PARTIAL"].includes(state);
}

function hasRegionalReferenceCoverage(analysis) {
  return (
    isRegionalReferenceAnalysis(analysis) &&
    stateHasUsableValues(analysis?.climate?.state) &&
    stateHasUsableValues(analysis?.soil?.state) &&
    forecastDisplayDays(analysis).length > 0
  );
}

function analysisAxisPresentation(analysis, key, state) {
  if (hasRegionalReferenceCoverage(analysis)) {
    if (key === "forecast") {
      const days = forecastDisplayDays(analysis).length;
      const risks = activeForecastRisks(analysis);
      return risks.length > 0
        ? {
            label: `${risks.length}건 주의`,
            tone: "warning",
            help: "작물별 위험 기준 적용",
          }
        : {
            label: `${days}일 분석`,
            tone: "good",
            help: "지역 예보 기준 분석 완료",
          };
    }
    if (["climate", "soil"].includes(key)) {
      return {
        label: "분석 완료",
        tone: "good",
        help: "지역자료 기준 분석 완료",
      };
    }
  }
  return {
    label: stateLabel(state),
    tone: toneForState(state),
    help: stateHelp(state),
  };
}

function sourceUsedInAnalysis(source) {
  return (
    ["LIVE", "CACHE"].includes(source?.deliveryState) &&
    source?.adapterState !== "UNSUPPORTED"
  );
}

function stateHelp(state) {
  if (state === "READY" || state === "COMPLETE") return "필요한 자료 흐름 완료";
  if (state === "PARTIAL") return "사용 가능한 자료 범위만 반영";
  if (state === "HOLD") return "핵심 자료 확보 전 판단 보류";
  if (state === "NOT_APPLICABLE") return "현재 조건에는 적용하지 않음";
  if (state === "PENDING") return "백엔드 처리 중";
  return "백엔드가 반환한 현재 상태";
}

function toneForState(state) {
  if (state === "READY" || state === "COMPLETE" || state === "FALLBACK") {
    return "good";
  }
  if (state === "PARTIAL" || state === "HOLD" || state === "PENDING") {
    return "warning";
  }
  if (state === "UNAVAILABLE" || state === "UNSUPPORTED") return "danger";
  return "info";
}

function decisionLabel(code) {
  const labels = {
    FIELD_TEST_NEXT: "현장 확인 단계",
    CHECK_FIRST: "확인 후 판단",
    DATA_NEEDED: "자료 확인 필요",
    FACILITY_CHECK_FIRST: "시설 내부 확인 후 판단",
    FACILITY_DATA_NEEDED: "시설 내부자료 필요",
    FACILITY_SENSOR_NEXT: "시설 센서 확인 단계",
  };
  return labels[code] ?? (code ? code.replaceAll("_", " ") : "판단 보류");
}

function limitationLabel(value) {
  if (typeof value !== "string") return "제공된 한계를 확인해 주세요.";
  return (
    LIMITATION_LABELS[value] ??
    `자료 또는 판단 범위 제한: ${value.replaceAll("_", " ")}`
  );
}

function preflightBlockerLabel(value) {
  if (PREFLIGHT_BLOCKER_LABELS[value]) return PREFLIGHT_BLOCKER_LABELS[value];
  if (value.startsWith("ADAPTER_")) {
    return `자료 연결 준비 안 됨(${value.slice("ADAPTER_".length).replaceAll("_", " ")})`;
  }
  return value.replaceAll("_", " ");
}

function sourceStateLabel(source) {
  if (source?.deliveryState === "UNAVAILABLE") return "자료 없음";
  if (source?.deliveryState === "SAMPLE") return "샘플";
  if (sourceHasQualityWarning(source)) return "일부 확인";
  if (source?.deliveryState === "CACHE") return "캐시 자료";
  if (source?.deliveryState === "LIVE") return "연결됨";
  if (source?.adapterState === "SUCCESS") return "연결됨";
  return source?.adapterState ?? "상태 미상";
}

function sourceTone(source) {
  if (source?.deliveryState === "UNAVAILABLE") return "danger";
  if (source?.deliveryState === "SAMPLE") return "warning";
  if (
    source?.deliveryState === "CACHE" ||
    sourceHasQualityWarning(source)
  ) {
    return "warning";
  }
  if (source?.deliveryState === "LIVE") return "good";
  if (source?.adapterState === "SUCCESS") return "good";
  return "danger";
}

function sourceHasQualityWarning(source) {
  const flags = Array.isArray(source?.qualityFlags) ? source.qualityFlags : [];
  return flags.includes("STALE") || flags.includes("PARTIAL_PROVIDER_FAILURE");
}

function formatSourceTime(source) {
  const value =
    source?.observedAt ??
    source?.issuedAt ??
    source?.retrievedAt ??
    source?.validFrom;
  return value ? formatDateTime(value) : "제공되지 않음";
}

function formatDateTime(value) {
  if (!value) return "제공되지 않음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatDashboardUpdate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const valueOf = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${valueOf("month")}.${valueOf("day")} (${valueOf("weekday")}) ${valueOf("hour")}:${valueOf("minute")}`;
}

function formatEvidenceValue(value, unit) {
  if (value == null) return "";
  return `${formatValue(value)}${unit ? ` ${unit}` : ""}`;
}

function formatValue(value) {
  if (typeof value === "number") return formatNumber(value);
  if (Array.isArray(value)) return value.map(formatValue).join("~");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatNumber(value) {
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(value);
}

function parcelStateLabel(state) {
  const labels = {
    POLYGON_REGISTERED: "필지 경계 등록",
    ADMIN_AREA_ONLY: "행정구역 기준",
    UNREGISTERED: "필지 미등록",
  };
  return labels[state] ?? "필지 상태 미상";
}

function persistenceStateLabel(state) {
  const labels = {
    NOT_REQUESTED: "저장 요청 안 함",
    NOT_AVAILABLE: "저장 미지원 · 현재 세션만",
    SAVED: "저장됨",
    READY: "저장됨",
    FAILED: "저장 실패",
  };
  return labels[state] ?? (state ? state.replaceAll("_", " ") : "상태 미상");
}

function locationResolutionLabel(mode) {
  return mode === "ADMIN_AREA_BROAD"
    ? "시·군·구 · 지역 참고 분석"
    : "상세 주소 · 지점 분석";
}

function errorMessage(error) {
  const code = error?.code ?? "UNKNOWN_ERROR";
  const base =
    ERROR_MESSAGES[code] ??
    (code.startsWith("INVALID_")
      ? "입력 조건을 다시 확인해 주세요."
      : "요청을 완료하지 못했습니다. 다시 시도해 주세요.");
  return error?.requestId ? `${base} (요청 ${error.requestId})` : base;
}

async function readResponseBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiRequestError({
      code: "INVALID_API_RESPONSE",
      status: response.status,
    });
  }
}

function isLocationCandidate(candidate) {
  return (
    candidate &&
    typeof candidate.candidateToken === "string" &&
    candidate.candidateToken !== "" &&
    typeof candidate.displayName === "string" &&
    candidate.displayName !== ""
  );
}

function isSafeHttpUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function appendDefinition(list, term, description) {
  list.append(element("dt", "", term), element("dd", "", description));
}

function appendTableCell(row, label, value) {
  const cell = element("td", "", value);
  cell.dataset.label = label;
  row.append(cell);
  return cell;
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.text === "string") return value.text;
  return "";
}

function openEvidenceDialog(section = "summary") {
  const dialog = document.querySelector("#evidence-dialog");
  if (!dialog.open) dialog.showModal();
  const target = dialog.querySelector(`[data-guide-section="${section}"]`);
  if (target) {
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "start" });
  } else {
    dialog.querySelector("[data-close-dialog]")?.focus();
  }
}

function announce(message) {
  liveRegion.textContent = "";
  requestAnimationFrame(() => {
    liveRegion.textContent = message;
  });
}

function element(tagName, className = "", text = "") {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== "") node.textContent = String(text);
  return node;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
