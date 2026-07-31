import {
  ContractValidationError,
  buildAnalysisRequest,
  buildAnalysisRequests,
  createIdempotencyKey,
  requestFingerprint,
} from "./api-contract.mjs";
import { summarizeForecastEvaluation } from "./forecast-presentation.mjs";
import { hasMissingSoilExamHistory } from "./soil-service-guidance.mjs";
import { suggestAdministrativeAddresses } from "./address-suggestions.mjs";
import { mountActionPlan } from "./action-plan.mjs";
import {
  LOCAL_PHOTO_MAX_BYTES,
  analyzePhotoPixels,
  assessPhotoQuality,
  createLocalPhotoJournal,
  reviewPhotoComparison,
} from "./local-photo-journal.mjs";
import { parseAssistantActionRequest } from "./assistant-action-request.mjs";
import {
  canReconcileProjectedActions,
  projectAnalysisAction,
} from "./action-projection.mjs";

window.__BACKEND_INTEGRATION_ENABLED__ = true;

// ── 사용자 토양검정 결과 (이 기기에만 저장) ──────────────────────────
const SOIL_TEST_STORAGE_KEY = "heuknalssi.soilTest.v1";
const REGION_STORAGE_KEY = "heuknalssi.region.v1";
const ACCOUNT_KEY_STORAGE_KEY = "heuknalssi.accountKey.v1";
const SESSION_STORAGE_KEY = "heuknalssi.session.v1";
const FARMS_STORAGE_KEY = "heuknalssi.farms.v1";
const ACTIVE_FARM_STORAGE_KEY = "heuknalssi.activeFarm.v1";
const ALARM_STORAGE_KEY = "heuknalssi.alarm.v1";
// 알림 모듈 상태는 초기화 중에 접근되므로 반드시 사용처보다 위에 둔다.
let serviceWorkerReady = null;
let alarmTimer = null;
const TODO_STORAGE_KEY = "heuknalssi.todo.v1";
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

  async requestReport(analysisId) {
    return this.request(
      `/api/analyses/${encodeURIComponent(analysisId)}/report`,
      { method: "POST", csrf: true },
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

  async getParcel(farmId) {
    return this.request(`/api/farms/${encodeURIComponent(farmId)}/parcel`);
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
let currentUiContexts = new Map();
let pendingAttempt = null;
let connectionPromise = null;
let assistantAnalysisId = null;
let creatingNewFarm = false;
let disposeActionPlan = null;
let pendingParcelGeometry = null;
const photoJournal = createLocalPhotoJournal();
let photoObjectUrls = [];
const savedSessionAtBoot = readStoredSession();

initializeDashboardSurfaces();
setDashboardResultVisibility(false);
resetDashboard();
if (savedSessionAtBoot) renderStoredSessionLoading(savedSessionAtBoot);
syncAssistantContext(null);
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
  form.addEventListener("change", () => {
    pendingAttempt = null;
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
    queueMicrotask(resetNewAnalysisState);
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
    }

    regionInput.value = saved.region;
    await searchLocations();
    const firstCandidate = locationCandidates.querySelector(
      ".location-candidate",
    );
    if (!firstCandidate) throw new Error("saved region no longer resolves");
    firstCandidate.click();

    if (!selectedCandidate) throw new Error("candidate was not selected");
    // 폼 이벤트를 흉내내지 않고 제출 함수를 직접 불러 완료까지 기다린다.
    const restored = await submitAnalysis();
    if (!restored) throw new Error("saved analysis refresh failed");
    renderRuntimeState();
    document.body.dataset.sessionRestore = "ok";
  } catch (error) {
    // 저장된 설정은 보존한다. 일시적인 API 장애 때문에 다시 입력시키지 않는다.
    document.body.dataset.sessionRestore = `failed:${error?.message ?? "unknown"}`;
    document.body.classList.remove("session-restoring");
    document.body.classList.add("session-restore-failed");
    setConnectionState("error", "저장한 농장을 다시 불러오지 못했습니다.");
    setServiceBanner(
      "error",
      "저장한 농장 정보를 갱신하지 못했습니다",
      "입력한 농장 설정은 이 기기에 남아 있습니다. ‘다시 불러오기’를 눌러 최신 자료만 다시 확인해 주세요.",
    );
    serviceBanner.hidden = false;
    retryConnectionButton.textContent = "다시 불러오기";
    retryConnectionButton.hidden = false;
  }
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
    const firstButton = locationCandidates.querySelector(".location-candidate");
    selectLocationCandidate(candidates[0], firstButton);
    setCurrentLocationStatus(
      `${candidates[0].displayName}을(를) 현재 농장 지역으로 확인했습니다. 다르면 아래에서 직접 바꿀 수 있습니다.`,
      "success",
    );
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
      enableHighAccuracy: false,
      timeout: 10_000,
      maximumAge: 5 * 60 * 1_000,
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
    `${candidate.displayName} 후보를 분석 지역으로 확인했습니다.`,
    "success",
  );
  document.querySelector("#region-error").hidden = true;
  pendingAttempt = null;
  updateSubmitAvailability();
  syncWizardNextState();
  announce("농장 지역을 선택했습니다. 다음 단계로 진행할 수 있습니다.");
}

async function submitAnalysis() {
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
    // 행동·사진·위성 기능이 첫 렌더부터 같은 농장 ID를 사용하도록
    // 사용자가 요청한 기기 저장을 기능 렌더링보다 먼저 확정한다.
    if (formValues.saveConsent === true) {
      writeStoredSession(formValues, selectedCandidate?.displayName ?? null);
    }
    renderAnalysis(currentAnalysis);
    renderCropResultSwitcher();
    pendingAttempt = null;
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
    }
    if ((currentAnalysis?.report?.state ?? "NOT_REQUESTED") === "NOT_REQUESTED") {
      const automaticReportButton = document.querySelector("#backend-report-button");
      if (automaticReportButton) {
        void requestAndPollReport(automaticReportButton, { automatic: true });
      }
    }
    return true;
  } catch (error) {
    if (error?.code === "LOCATION_TOKEN_INVALID") {
      clearSelectedCandidate("확인한 지역 정보가 만료되었습니다. 지역을 다시 확인해 주세요.");
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

function renderAnalysis(analysis) {
  const summary = analysis?.inputSummary ?? {};
  const cropLabel = CROP_LABELS[summary.crop] ?? summary.crop ?? "작물";
  const regionLabel = summary.regionLabel ?? selectedCandidate?.displayName ?? "선택 지역";
  const context = `${regionLabel} · ${cropLabel}`;
  renderSummaryPanel(analysis, regionLabel, cropLabel);
  document.querySelector("#sidebar-context-value").textContent = context;
  document.querySelector("#topbar-context-value").textContent = context;
  document.querySelector("#dashboard-title").textContent =
    `${regionLabel} · ${cropLabel} 농장 분석`;
  document.querySelector("#dashboard-mode-copy").textContent =
    summary.usageMode === "ACTIVE_GROWING"
      ? "재배 중 생육 기준 날씨·토양·예보 분석"
      : "재배 전 환경 기준 기후·토양·예보 분석";
  document.querySelector("#sidebar-mode-value").textContent =
    summary.usageMode === "ACTIVE_GROWING"
      ? "재배 중 생육 점검"
      : "재배 전 환경 분석";

  renderLiveOutlook(analysis);
  renderDecisionPanel(analysis);
  renderStateOverview(analysis);
  renderActionsAndReport(analysis);
  renderSmartfarmReference(analysis);
  renderExplanation(analysis);
  renderEvidenceDialog(analysis);
  renderTechnicalSettings(analysis);
  syncAssistantContext(analysis);
  writeStoredTodo(analysis);
  void refreshActionPlan(analysis);
  void refreshSatellitePanel(analysis);
  void refreshPhotoJournal(analysis);
  setDashboardResultVisibility(true);
}

async function refreshActionPlan(analysis, { ensureRules = true } = {}) {
  const root = document.querySelector("#action-plan-panel");
  const scope = currentFeatureScope(analysis);
  if (!root || !scope || !connected) return;
  root.hidden = false;
  root.setAttribute("aria-busy", "true");
  if (!root.childElementCount) {
    root.replaceChildren(element("p", "backend-empty", "오늘 할 일을 준비하고 있습니다."));
  }
  try {
    let plan = await api.listActions(scope.farmId, scope);
    if (ensureRules) {
      const drafts = actionDraftsFromAnalysis(analysis, scope);
      await Promise.all(
        drafts.map(({ draft, ruleId }) =>
          api.createAction(
            scope.farmId,
            { draft, ruleId, projection: "SYSTEM_RULE" },
            createIdempotencyKey(),
          ),
        ),
      );
      if (canReconcileProjectedActions(analysis)) {
        await api.reconcileRuleActions(
          scope.farmId,
          {
            cropId: scope.cropId,
            seasonId: scope.seasonId,
            activeRuleIds: [...new Set(drafts.map(({ ruleId }) => ruleId))],
          },
          createIdempotencyKey(),
        );
      }
      plan = await api.listActions(scope.farmId, scope);
    }
    disposeActionPlan?.();
    disposeActionPlan = mountActionPlan(root, plan, {
      onStatusChange: async ({ actionId, status }) => {
        await api.updateAction(scope.farmId, actionId, status, createIdempotencyKey());
        await refreshActionPlan(analysis, { ensureRules: false });
      },
    });
  } catch (error) {
    root.replaceChildren(
      element(
        "p",
        "backend-empty",
        `할 일 기록을 불러오지 못했습니다. ${errorMessage(error)}`,
      ),
    );
  } finally {
    root.removeAttribute("aria-busy");
  }
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
  return { farmId, cropId, seasonId: `season-${year}-${String(summary.crop).toLowerCase()}` };
}

function actionDraftsFromAnalysis(analysis, scope) {
  const actions = Array.isArray(analysis?.actions) ? analysis.actions : [];
  return actions.slice(0, 5).flatMap((action, index) => {
    const title = userActionTitle(action, analysis);
    if (!title) return [];
    const projection = projectAnalysisAction(action, analysis);
    return [{
      ruleId: projection.ruleId || `analysis-action-${index}`,
      draft: {
        ...scope,
        title,
        instruction: actionDetail(action.actionId, analysis) || title,
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
  const weather = forecastRiskGuide(analysis);
  const soil = soilConditionGuide(analysis);
  if (weather.risk && action.triggerIds?.some((id) => String(id).includes("forecast"))) {
    return weather.reason || weather.summary || "예보 위험 규칙에서 확인된 행동입니다.";
  }
  if (soil.risk) return soil.reason || soil.summary || "토양 조건 확인이 필요한 행동입니다.";
  return resolveDisplayAction(analysis).detail || "현재 분석 근거에서 우선 확인할 행동입니다.";
}

function renderLiveOutlook(analysis) {
  const outlook = document.querySelector("#live-outlook");
  if (!outlook) return;
  const days = forecastDisplayDays(analysis).slice(0, 7);
  const forecastCard = element("article", "live-outlook-card");
  const header = element("div", "live-outlook-header");
  const headerCopy = element("div");
  headerCopy.append(
    element("span", "live-outlook-kicker", "기상 전망"),
    element(
      "h2",
      "",
      days.length
        ? `${days.length}일 기온·강수 예보`
        : "이번 주 예보",
    ),
  );
  header.append(
    headerCopy,
    element(
      "span",
      "forecast-source-badge",
      "기상청 단기·중기 예보",
    ),
  );
  forecastCard.append(header);

  if (days.length > 0) {
    const activeRisks = activeForecastRisks(analysis);
    const threshold = forecastTemperatureThreshold(
      analysis,
      activeRisks,
      days,
    );
    const chartShell = element("div", "forecast-chart-shell");
    chartShell.append(
      temperatureRangeChart(days, threshold),
      forecastChartSummary(days),
      forecastChartLegend(threshold),
    );
    const dayList = element("div", "forecast-day-list");
    dayList.setAttribute("role", "list");
    dayList.setAttribute("aria-label", "날짜별 예보");
    dayList.append(
      ...days.map((day) =>
        forecastDayCard(day, activeRisks.some((risk) => riskCoversDate(risk, day.date))),
      ),
    );
    forecastCard.append(
      chartShell,
      dayList,
      element("p", "forecast-scroll-hint", "옆으로 밀어 나머지 날짜 보기"),
    );
  } else {
    const empty = element("div", "forecast-empty");
    const retry = element("button", "button button-secondary", "예보 다시 불러오기");
    retry.type = "button";
    retry.addEventListener("click", () => {
      void submitAnalysis();
    });
    empty.append(
      element("div", "", ""),
      element("strong", "", "현재 예보를 불러오지 못했습니다."),
      element(
        "span",
        "",
        "같은 농장 조건으로 예보만 다시 확인할 수 있습니다.",
      ),
      retry,
    );
    forecastCard.append(empty);
  }

  const actionCard = element("aside", "live-action-card");
  const actionHeader = element("div", "live-action-header");
  const actionHeaderCopy = element("div");
  actionHeaderCopy.append(
    element("span", "live-action-kicker", "우선 조치"),
    element("h2", "", "오늘의 점검 항목"),
  );
  const displayAction = resolveDisplayAction(analysis);
  const weatherGuide = forecastRiskGuide(analysis);
  const soilGuide = soilConditionGuide(analysis);
  const conditionRow = element("div", "live-action-condition-row");
  conditionRow.setAttribute("aria-label", "날씨와 토양 상태");
  conditionRow.append(
    actionConditionSummary("날씨", weatherGuide.condition),
    actionConditionSummary("토양", soilGuide.condition),
  );
  actionHeader.append(
    actionHeaderCopy,
    element("span", "live-action-status", displayAction.status),
  );
  const visual = actionVisual(analysis, weatherGuide, soilGuide);
  const meta = element("div", "live-action-meta");
  meta.append(
    element(
      "span",
      "",
      `${formatKoreanDate(new Date())} · 오늘 예보 기준`,
    ),
    element(
      "span",
      "",
      days.length
        ? `예보 기간 ${days.length}일`
        : "예보 다시 확인 필요",
    ),
    element(
      "span",
      "",
      "농장별 안내",
    ),
  );
  const actionButton = element(
    "button",
    "live-action-button",
    "이유와 행동 보기",
  );
  actionButton.type = "button";
  actionButton.addEventListener("click", () => openEvidenceDialog());
  actionCard.append(
    actionHeader,
    conditionRow,
    visual,
    element("p", "live-action-title", displayAction.title),
    element(
      "p",
      "live-action-context",
      displayAction.detail,
    ),
    actionStepList(displayAction.actions, "live-action-steps"),
    actionButton,
    meta,
  );
  outlook.replaceChildren(
    forecastCard,
    actionCard,
    renderFarmConditionGuide(analysis),
  );
  outlook.hidden = false;
}

function actionConditionSummary(label, condition) {
  const item = element("div", "live-action-condition");
  item.append(
    element("span", "", label),
    element("strong", "", condition || "확인 필요"),
  );
  return item;
}

function renderFarmConditionGuide(analysis, idSuffix = "dashboard") {
  const guide = element("section", "farm-condition-guide");
  const titleId = `farm-condition-guide-title-${idSuffix}`;
  const missingSoilExamHistory = hasMissingSoilExamHistory(analysis);
  guide.setAttribute("aria-labelledby", titleId);
  const weather = forecastRiskGuide(analysis);
  const soil = soilConditionGuide(analysis);
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
      weather.risk ? "주의 항목 있음" : "확인 항목",
    ),
  );

  const facts = element("div", "farm-condition-facts");
  facts.append(
    conditionFactCard("날씨", weather),
    conditionFactCard("농장 토양", soil),
  );

  const actionBox = element(
    "section",
    "farm-condition-actions action-priority-card",
  );
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

function conditionFactCard(label, guide) {
  const fullReason =
    typeof guide.reason === "string" ? guide.reason.trim() : "";
  const summaryReason = conditionFactSummary(fullReason);
  const card = element(
    "article",
    `condition-fact-card ${guide.tone ? `is-${guide.tone}` : ""}`.trim(),
  );
  card.append(
    element("span", "condition-fact-label", label),
    element("strong", "condition-fact-title", guide.condition),
    element(
      "h3",
      "",
      guide.tone === "good"
        ? "무엇을 알 수 있나요"
        : guide.tone === "unknown"
          ? "왜 확인이 필요한가요"
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
  if (guide.caveat) {
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
  svg.setAttribute("viewBox", "0 0 560 150");
  svg.setAttribute("role", "img");
  const highs = days.map((day) =>
    Number.isFinite(day.maxTemperature) ? day.maxTemperature : null,
  );
  const lows = days.map((day) =>
    Number.isFinite(day.minTemperature) ? day.minTemperature : null,
  );
  const available = [...highs, ...lows, threshold?.value].filter(Number.isFinite);
  svg.setAttribute(
    "aria-label",
    available.length
      ? `최고·최저기온과 강수확률 흐름. 최고기온 ${highs
          .filter(Number.isFinite)
          .map((value) => `${formatNumber(value)}도`)
          .join(", ")}${
            Number.isFinite(threshold?.value)
              ? `, 작물 주의 기준 ${formatNumber(threshold.value)}도`
              : ""
          }`
      : "기온 자료 없음",
  );
  [22, 52, 82, 118].forEach((y) => {
    const line = document.createElementNS(svgNamespace, "line");
    line.setAttribute("class", "grid-line");
    line.setAttribute("x1", "8");
    line.setAttribute("x2", "552");
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    svg.append(line);
  });
  if (available.length === 0) return svg;
  const minimum = Math.min(...available);
  const maximum = Math.max(...available);
  const span = Math.max(maximum - minimum, 4);
  const pointFor = (value, index) => {
    if (!Number.isFinite(value)) return null;
    const x = days.length === 1 ? 280 : 18 + (index * 524) / (days.length - 1);
    const y = 82 - ((value - minimum) / span) * 58;
    return { x, y, value, index };
  };
  const highPoints = highs.map(pointFor);
  const lowPoints = lows.map(pointFor);
  const paired = highPoints
    .map((high, index) => ({ high, low: lowPoints[index] }))
    .filter(({ high, low }) => high && low);

  if (Number.isFinite(threshold?.value)) {
    const thresholdY = 82 - ((threshold.value - minimum) / span) * 58;
    const thresholdLine = document.createElementNS(svgNamespace, "line");
    thresholdLine.setAttribute("class", "risk-threshold-line");
    thresholdLine.setAttribute("x1", "8");
    thresholdLine.setAttribute("x2", "552");
    thresholdLine.setAttribute("y1", String(thresholdY));
    thresholdLine.setAttribute("y2", String(thresholdY));
    const thresholdLabel = document.createElementNS(svgNamespace, "text");
    thresholdLabel.setAttribute("class", "risk-threshold-label");
    thresholdLabel.setAttribute("x", "548");
    thresholdLabel.setAttribute("y", String(Math.max(thresholdY - 5, 12)));
    thresholdLabel.setAttribute("text-anchor", "end");
    thresholdLabel.textContent =
      `주의 기준 ${formatNumber(threshold.value)}°`;
    svg.append(thresholdLine, thresholdLabel);
  }

  if (paired.length > 1) {
    const band = document.createElementNS(svgNamespace, "polygon");
    band.setAttribute("class", "temperature-band");
    band.setAttribute(
      "points",
      [
        ...paired.map(({ high }) => `${high.x},${high.y}`),
        ...[...paired]
          .reverse()
          .map(({ low }) => `${low.x},${low.y}`),
      ].join(" "),
    );
    svg.append(band);
  }

  days.forEach((day, index) => {
    if (!Number.isFinite(day.precipitationProbability)) return;
    const x = days.length === 1 ? 280 : 18 + (index * 524) / (days.length - 1);
    const height = Math.max(
      day.precipitationProbability > 0 ? 3 : 0,
      Math.min(26, (day.precipitationProbability / 100) * 26),
    );
    const bar = document.createElementNS(svgNamespace, "rect");
    bar.setAttribute("class", "precipitation-bar");
    bar.setAttribute("x", String(x - 9));
    bar.setAttribute("y", String(118 - height));
    bar.setAttribute("width", "18");
    bar.setAttribute("height", String(height));
    bar.setAttribute("rx", "5");
    svg.append(bar);
  });

  [
    ["temperature-line is-high", highPoints],
    ["temperature-line is-low", lowPoints],
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
    const dateLabel = document.createElementNS(svgNamespace, "text");
    dateLabel.setAttribute("class", "temperature-date-label");
    dateLabel.setAttribute("x", String(x));
    dateLabel.setAttribute("y", "144");
    dateLabel.setAttribute("text-anchor", "middle");
    dateLabel.textContent = formatForecastDate(days[index].date);
    svg.append(point, valueLabel, dateLabel);
  });

  lowPoints.filter(Boolean).forEach(({ x, y }) => {
    const point = document.createElementNS(svgNamespace, "circle");
    point.setAttribute("class", "temperature-point is-low");
    point.setAttribute("cx", String(x));
    point.setAttribute("cy", String(y));
    point.setAttribute("r", "3.2");
    svg.append(point);
  });
  return svg;
}

function forecastChartLegend(threshold = null) {
  const legend = element("div", "forecast-chart-legend");
  legend.setAttribute("aria-label", "예보 그래프 범례");
  [
    ["is-high", "최고기온"],
    ["is-low", "최저기온"],
    ["is-rain", "강수확률"],
    ...(Number.isFinite(threshold?.value)
      ? [["is-threshold", "작물 주의 기준"]]
      : []),
  ].forEach(([className, label]) => {
    const item = element("span", className, label);
    item.prepend(element("i", ""));
    legend.append(item);
  });
  return legend;
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

function renderCropResultSwitcher() {
  const switcher = document.querySelector("#crop-result-switcher");
  if (!switcher) return;
  const analyses = [...currentAnalyses.values()];
  switcher.replaceChildren(
    ...analyses.map((analysis) => {
      const crop = analysis?.inputSummary?.crop;
      const button = element(
        "button",
        "",
        CROP_LABELS[crop] ?? crop ?? "작물",
      );
      button.type = "button";
      button.setAttribute(
        "aria-pressed",
        String(analysis?.analysisId === currentAnalysis?.analysisId),
      );
      button.addEventListener("click", () => {
        currentAnalysis = analysis;
        renderAnalysis(analysis);
        renderCropResultSwitcher();
        if ((analysis?.report?.state ?? "NOT_REQUESTED") === "NOT_REQUESTED") {
          const reportButton = document.querySelector("#backend-report-button");
          if (reportButton) {
            void requestAndPollReport(reportButton, { automatic: true });
          }
        }
      });
      return button;
    }),
  );
  switcher.hidden = analyses.length < 2;
}

function renderSummaryPanel(analysis, regionLabel, cropLabel) {
  const panel = document.querySelector(".summary-panel");
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
  contextList.append(
    element(
      "span",
      "summary-context-chip",
      `재배 환경 · ${
        uiContext?.cultivationLabel ??
        CULTIVATION_LABELS[summary.cultivationMode] ??
        "확인 필요"
      }`,
    ),
    element(
      "span",
      "summary-context-chip",
      `생육 상태 · ${uiContext?.growthLabel ?? "단계 공통 안내"}`,
    ),
    ...(uiContext?.growthRecommended
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
  const title = element("h2", "", "오늘의 작물 상태");
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
    `오늘의 작물 상태 ${status.label}`,
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
      label: "기후 조건",
      state: analysis?.climate?.state,
      valueLabel: stateLabel(analysis?.climate?.state),
      help: "선택한 작기와 장기 기후 비교",
    },
    {
      label: "토양 조건",
      state: analysis?.soil?.state,
      valueLabel: stateLabel(analysis?.soil?.state),
      help: soilConditionHelp(analysis),
    },
    {
      label: "가까운 예보",
      state: analysis?.forecast?.result?.riskState ?? analysis?.forecast?.state,
      valueLabel: stateLabel(analysis?.forecast?.result?.riskState ?? analysis?.forecast?.state),
      help: forecastConditionHelp(analysis),
    },
  ].forEach(({ label, state, valueLabel, help }) => {
    const tone = toneForState(state);
    const card = element(
      "article",
      `axis-status ${tone === "good" ? "" : "is-caution"}`.trim(),
    );
    const scoreValue = element(
      "strong",
      `axis-score-value${tone === "good" ? "" : " is-unavailable"}`,
    );
    scoreValue.append(element("b", "", valueLabel ?? "확인 필요"));
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
    "서로 다른 자료를 하나의 점수로 합치지 않습니다. 확인된 축만 행동 판단에 사용합니다.",
  );
  const sourceStatus = renderOverviewSourceStatus(analysis?.dataSources);
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

function renderOverviewSourceStatus(sources) {
  const section = element("section", "overview-source-status");
  section.setAttribute("aria-label", "사용한 자료 상태");
  section.append(element("strong", "", "사용한 자료"));
  const list = element("div", "overview-source-chips");
  const safeSources = Array.isArray(sources) ? sources : [];
  if (safeSources.length === 0) {
    list.append(element("span", "source-status-chip is-warning", "자료 확인 필요"));
  } else {
    safeSources.forEach((source) => {
      const chip = element(
        "span",
        `source-status-chip is-${sourceTone(source)}`,
        `${source.sourceName ?? "공공자료"} · ${sourceStateLabel(source)}`,
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
  const weather = forecastRiskGuide(analysis);
  const soil = soilConditionGuide(analysis);
  const detail = resolveDisplayAction(analysis).title;
  if (weather.risk && weather.severity === "WARNING") {
    return { label: "주의", tone: "danger", detail };
  }
  if (weather.risk || soil.tone === "caution") {
    return { label: "점검 필요", tone: "caution", detail };
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
  const metrics = [
    ["기후 조건", analysis?.climate?.state, "작물·작기 기준과 비교"],
    ["토양 조건", analysis?.soil?.state, "필지 실측 여부를 함께 확인"],
    [
      "가까운 예보",
      analysis?.forecast?.result?.riskState ?? analysis?.forecast?.state,
      "날짜·지속기간이 있는 작물별 신호",
    ],
    ["자료 전체", analysis?.state, "결측과 출처 한계를 포함한 상태"],
  ];
  strip.replaceChildren(
    ...metrics.map(([label, value, help]) => {
      const cell = element("div", "metric-cell");
      cell.append(
        element("span", "metric-label", label),
        element(
          "div",
          "metric-value backend-metric",
          stateLabel(value),
        ),
        element("p", "backend-state-caption", `${help} · ${stateHelp(value)}`),
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

function isCurrentAnalysis(analysisId) {
  return currentAnalysis?.analysisId === analysisId;
}

function storeUpdatedAnalysis(analysis, expectedAnalysisId) {
  if (analysis?.analysisId !== expectedAnalysisId) return;
  const crop = analysis?.inputSummary?.crop;
  if (crop) currentAnalyses.set(crop, analysis);
  if (isCurrentAnalysis(expectedAnalysisId)) currentAnalysis = analysis;
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
    ? analysis.actions.filter(isPrimaryUserAction)
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

function soilConditionGuide(analysis) {
  const soil = analysis?.soil;
  const missingSoilExamHistory = hasMissingSoilExamHistory(analysis);
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
  const reading = Array.isArray(trigger.readings) ? trigger.readings[0] : null;
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
    : "값 확인 필요";
  const threshold = comparisonSummary(trigger.comparison, trigger.unit);
  const date = reading?.date
    ? formatForecastDate(reading.date)
    : formatForecastDate(risk?.dateRange?.from);
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
    : "확인 필요";
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
    CHECK_FACILITY_WEATHER: "시설 외기와 내부 온도·환기 상태 확인",
    CHECK_INTERNAL_SENSORS: "시설 내부 온도 센서와 환기 상태 확인",
  };
  return labels[action.actionId] ?? action.title ?? null;
}

function actionDetail(actionId, analysis) {
  const days = forecastDisplayDays(analysis).slice(0, 7);
  const period = days.length ? `${days.length}일 기상청 예보` : "현재 자료";
  if (actionId === "CHECK_CURRENT_FORECAST_RISK") {
    return `${period}에서 검토된 작물 기준의 주의 신호가 확인됐습니다. 해당 날짜의 작물 상태를 먼저 확인해 주세요.`;
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
    : "기온 확인 필요";
  const rainCopy = rain.length
    ? `최대 강수확률 ${formatNumber(Math.max(...rain))}%`
    : "강수확률 확인 필요";
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
      : "재배 전 환경 분석";
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
  setupSatelliteService();
  setupPhotoJournal();
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

function setupSatelliteService() {
  const useLocation = document.querySelector("#parcel-use-location");
  const save = document.querySelector("#parcel-save");
  const refresh = document.querySelector("#satellite-refresh");
  useLocation?.addEventListener("click", () => void prepareParcelFromLocation());
  save?.addEventListener("click", () => void savePreparedParcel());
  refresh?.addEventListener("click", () => void refreshSatellite());
  applySatelliteAvailability();
}

function satelliteIsAvailable() {
  return preflight?.capabilities?.satellite === "READY";
}

function applySatelliteAvailability() {
  if (satelliteIsAvailable()) {
    const size = document.querySelector("#parcel-size");
    const useLocation = document.querySelector("#parcel-use-location");
    if (size) size.disabled = false;
    if (useLocation) useLocation.disabled = false;
    return true;
  }
  const state = document.querySelector("#satellite-service-state");
  const status = document.querySelector("#parcel-status");
  if (state) state.textContent = "연결 준비 필요";
  if (status) {
    status.textContent =
      "현재 실행 환경에는 위성 데이터 연결이 설정되지 않았습니다.";
  }
  for (const selector of [
    "#parcel-size",
    "#parcel-use-location",
    "#parcel-save",
    "#satellite-refresh",
  ]) {
    const control = document.querySelector(selector);
    if (control) control.disabled = true;
  }
  return false;
}

async function prepareParcelFromLocation() {
  if (!applySatelliteAvailability()) return;
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
    document.querySelector("#parcel-save").disabled = false;
    updateParcelPreview(`${size}m × ${size}m 경계 준비됨`);
    if (status) {
      status.textContent =
        "경계를 저장하기 전에 실제 농장 안에서 만든 범위가 맞는지 확인해 주세요.";
    }
  } catch {
    if (status) status.textContent = "현재 위치를 확인하지 못했습니다. 위치 권한을 확인해 주세요.";
  } finally {
    setBusy(button, false, "현재 위치로 경계 만들기");
  }
}

async function savePreparedParcel() {
  if (!applySatelliteAvailability()) return;
  const scope = currentFeatureScope(currentAnalysis);
  const status = document.querySelector("#parcel-status");
  const button = document.querySelector("#parcel-save");
  if (!scope || !pendingParcelGeometry) return;
  setBusy(button, true, "저장 중…");
  try {
    const parcel = await api.saveParcel(scope.farmId, pendingParcelGeometry);
    pendingParcelGeometry = parcel.geometry;
    document.querySelector("#satellite-refresh").disabled = false;
    document.querySelector("#satellite-service-state").textContent = "필지 등록됨";
    updateParcelPreview(`${formatNumber(parcel.areaSquareMeters)}㎡ 경계 저장됨`);
    if (status) status.textContent = "필지 경계를 저장했습니다. 최신 위성 자료를 확인할 수 있습니다.";
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
  if (!scope || !connected || !applySatelliteAvailability()) return;
  try {
    const [{ parcel }, { observation }] = await Promise.all([
      api.getParcel(scope.farmId),
      api.getSatelliteObservation(scope.farmId),
    ]);
    if (parcel) {
      pendingParcelGeometry = parcel.geometry;
      updateParcelPreview(`${formatNumber(parcel.areaSquareMeters)}㎡ 경계 저장됨`);
      document.querySelector("#parcel-save").disabled = false;
      document.querySelector("#satellite-refresh").disabled = false;
      document.querySelector("#satellite-service-state").textContent = "필지 등록됨";
      if (status) status.textContent = "저장된 필지 경계를 사용합니다.";
    } else {
      pendingParcelGeometry = null;
      document.querySelector("#parcel-save").disabled = true;
      document.querySelector("#satellite-refresh").disabled = true;
      document.querySelector("#satellite-service-state").textContent = "필지 미등록";
      if (status) status.textContent = "현재 위치에서 농장 경계를 먼저 만들어 주세요.";
    }
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
    await photoJournal.addPhoto({
      scope,
      file,
      observedAt: form.elements.observedAt?.value,
      growthStage: form.elements.growthStage?.value,
      note: form.elements.note?.value,
      visualSignals,
    });
    form.reset();
    form.elements.observedAt.value = new Date().toISOString().slice(0, 10);
    setPhotoJournalStatus("사진을 이 기기에 비공개로 저장했습니다.", "success");
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
    let completedActionCount = 0;
    if (connected) {
      const plan = await api.listActions(scope.farmId, scope);
      const actions = [...(plan?.today ?? []), ...(plan?.upcoming ?? [])];
      completedActionCount = actions.filter((action) => action.status === "DONE").length;
    }
    await photoJournal.completeSeason(scope, { completedActionCount });
    setPhotoJournalStatus("이번 시즌의 사진과 완료 기록을 정리했습니다.", "success");
    await refreshPhotoJournal(currentAnalysis);
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
    const [photos, season] = await Promise.all([
      photoJournal.listPhotos(scope),
      photoJournal.getSeason(scope),
    ]);
    const state = document.querySelector("#photo-journal-state");
    if (state) state.textContent = photos.length ? `${photos.length}장 기록` : "기록 없음";
    const status = document.querySelector("#photo-journal-status");
    if (status?.textContent?.includes("농장 분석을 완료하면")) {
      setPhotoJournalStatus("사진과 저장 동의를 확인한 뒤 기록해 주세요.");
    }
    renderPhotoJournalGallery(gallery, photos, scope);
    const completed = season?.status === "COMPLETED";
    document.querySelector("#season-complete").disabled = completed;
    document.querySelector("#journal-save").disabled = completed;
    document.querySelector("#season-summary-title").textContent = completed
      ? "이번 재배 시즌 마무리됨"
      : "이번 재배 시즌 진행 중";
    document.querySelector("#season-summary-copy").textContent = completed
      ? `${photos.length}장 사진 · 완료한 할 일 ${season.completedActionCount ?? 0}건 · ${formatPhotoDate(season.completedAt)} 정리`
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
  const url = URL.createObjectURL(photo.blob);
  photoObjectUrls.push(url);
  const image = document.createElement("img");
  image.src = url;
  image.alt = `${formatPhotoDate(photo.observedAt)}에 기록한 작물 사진`;
  const body = element("div", "photo-journal-item-body");
  const actions = element("div", "photo-journal-item-actions");
  const remove = element("button", "button button-quiet", "삭제");
  remove.type = "button";
  remove.addEventListener("click", async () => {
    if (!window.confirm("이 기기에 저장한 사진을 삭제할까요?")) return;
    await photoJournal.deletePhoto(scope, photo.photoId);
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
  item.append(image, body);
  return item;
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

function updateParcelPreview(label) {
  const target = document.querySelector("#parcel-preview-label");
  if (target) target.textContent = label;
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
    "#live-outlook",
    ".decision-flow",
    ".risk-panel",
    ".action-workspace",
    ".overview-score",
  ].forEach((selector) => {
    const target = document.querySelector(selector);
    if (target) target.hidden = !visible;
  });
  [
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
  assistantInput.disabled = true;
  assistantSend.disabled = true;
  assistantSend.textContent = "확인 중";
  const pending = appendAssistantMessage("현재 분석 근거를 확인하고 있습니다.");
  try {
    const response = await api.askAssistant(expectedAnalysisId, question);
    if (expectedAnalysisId !== currentAnalysis?.analysisId) return;
    pending?.remove();
    appendAssistantMessage(response?.answer ?? "설명할 근거를 찾지 못했습니다.", {
      note: assistantOutcomeNote(response?.outcome, response?.notice),
    });
  } catch (error) {
    pending?.remove();
    appendAssistantMessage(assistantErrorMessage(error));
  } finally {
    if (expectedAnalysisId === currentAnalysis?.analysisId) {
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
      reason: "사용자가 농장 분석 도우미에서 직접 요청한 할 일입니다.",
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

function appendAssistantMessage(text, { user = false, note = null } = {}) {
  if (!assistantMessages) return null;
  const message = element(
    "p",
    `assistant-message${user ? " is-user" : ""}`,
    text,
  );
  if (note && !user) message.append(element("small", "", note));
  assistantMessages.append(message);
  assistantMessages.scrollTop = assistantMessages.scrollHeight;
  return message;
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

function readStoredSoilTest() {
  const raw = safeStorage()?.getItem(SOIL_TEST_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && Number.isFinite(parsed.ph)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function writeStoredSoilTest(value) {
  const storage = safeStorage();
  if (!storage) return;
  if (value === null) storage.removeItem(SOIL_TEST_STORAGE_KEY);
  else storage.setItem(SOIL_TEST_STORAGE_KEY, JSON.stringify(value));
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
    profile?.situation === "growing" &&
    Array.isArray(profile?.crops) &&
    profile.crops.length > 0
  );
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
        farm.situation === "growing" ? "재배 관리" : "재배 전 진단",
      ),
    );
    button.addEventListener("click", () => selectStoredFarm(farm));
    list.append(button);
  }
  const add = element("button", "farm-add-button", "＋ 농장 추가");
  add.type = "button";
  add.id = "add-farm";
  add.addEventListener("click", startNewFarm);
  target.replaceChildren(
    ...(includeHeading ? [element("h2", "", "내 농장")] : []),
    ...(farms.length
      ? [list]
      : [element("p", "recent-analysis", "저장된 농장이 없습니다.")]),
    add,
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
  document.dispatchEvent(new CustomEvent("heuknalssi:open-new-farm"));
}

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
  const region = analysis?.inputSummary?.regionLabel ?? readStoredRegion();
  if (!headline) return;
  try {
    storage.setItem(
      TODO_STORAGE_KEY,
      JSON.stringify({ headline, decision, crop, region }),
    );
  } catch {
    /* 저장소가 막혀 있으면 알림 본문만 일반 문구가 된다. */
  }
}

function readStoredTodo() {
  const raw = safeStorage()?.getItem(TODO_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
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
  return {
    title: `오늘 먼저 할 일 — ${todo.headline}`,
    body: [where, todo.decision].filter(Boolean).join(" | ") || "흙날씨 농지 진단",
  };
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

  document.querySelector("#notification-save")?.addEventListener("click", () => {
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
function setupAccountKeyPanel() {
  const createButton = document.querySelector("#account-key-create");
  const restoreButton = document.querySelector("#account-key-restore");
  if (!createButton && !restoreButton) return;

  const valueLabel = document.querySelector("#account-key-value");
  const hint = document.querySelector("#account-key-hint");
  const status = document.querySelector("#account-key-status");
  const copyButton = document.querySelector("#account-key-copy");
  const errorLine = document.querySelector("#account-key-error");
  const storage = safeStorage();

  const showKey = (key) => {
    if (valueLabel) valueLabel.textContent = key ?? "—";
    if (hint) {
      hint.textContent = key
        ? "이 열쇠를 종이에 적어 두세요."
        : "아직 만들지 않았습니다.";
    }
    if (copyButton) copyButton.hidden = !key;
  };
  showKey(storage?.getItem(ACCOUNT_KEY_STORAGE_KEY) ?? null);

  const backupPayload = () => {
    const soilTest = readStoredSoilTest();
    const region = readStoredRegion();
    const payload = {};
    if (soilTest) payload.soilTest = soilTest;
    if (region) payload.region = region;
    return payload;
  };

  createButton?.addEventListener("click", async () => {
    if (status) status.textContent = "열쇠를 만드는 중입니다…";
    const payload = backupPayload();
    if (Object.keys(payload).length === 0) {
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
          "보관했습니다. 새 휴대폰에서 이 열쇠를 넣으면 그대로 이어서 쓰실 수 있습니다.";
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
      if (payload.soilTest) writeStoredSoilTest(payload.soilTest);
      if (payload.region) rememberRegion(payload.region);
      storage?.setItem(ACCOUNT_KEY_STORAGE_KEY, typed.toUpperCase());
      showKey(typed.toUpperCase());
      renderSoilTestState();
      renderRegionLabels();
      renderDashboardSoilTest();
      if (status) status.textContent = "불러왔습니다. 이 기기에도 저장했습니다.";
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
      return Boolean(selectedRadioValue(`cultivation-${crop}`));
    }
    return true;
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

function stateHelp(state) {
  if (state === "READY" || state === "COMPLETE") return "필요한 자료 흐름 완료";
  if (state === "PARTIAL") return "일부 자료의 추가 확인 필요";
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
  return mode === "ADMIN_AREA_BROAD" ? "행정구역 단위" : "주소 확인";
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

function openEvidenceDialog() {
  const dialog = document.querySelector("#evidence-dialog");
  if (!dialog.open) dialog.showModal();
  dialog.querySelector("[data-close-dialog]")?.focus();
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
