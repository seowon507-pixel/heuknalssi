import {
  ContractValidationError,
  buildAnalysisRequest,
  buildAnalysisRequests,
  createIdempotencyKey,
  requestFingerprint,
} from "./api-contract.mjs";

window.__BACKEND_INTEGRATION_ENABLED__ = true;

// ── 사용자 토양검정 결과 (이 기기에만 저장) ──────────────────────────
const SOIL_TEST_STORAGE_KEY = "heuknalssi.soilTest.v1";
const REGION_STORAGE_KEY = "heuknalssi.region.v1";
const ACCOUNT_KEY_STORAGE_KEY = "heuknalssi.accountKey.v1";
const SESSION_STORAGE_KEY = "heuknalssi.session.v1";
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
// 전문 용어에는 쉬운 설명을 함께 붙인다. 초보 귀농인이 단위만 보고
// 뜻을 짐작하게 두지 않는다. [표기, 단위, 쉬운 설명]
const SOIL_TEST_LABELS = Object.freeze({
  ph: ["산도 pH", "", "흙이 산성인지 알칼리성인지"],
  electricalConductivity: ["전기전도도 EC", "dS/m", "흙에 녹아 있는 비료 기운(짠기)"],
  organicMatter: ["유기물", "g/kg", "썩은 낙엽·퇴비처럼 흙을 기름지게 하는 성분"],
  availablePhosphate: ["유효인산", "mg/kg", "뿌리와 열매에 쓰이는 양분"],
  exchangeableK: ["칼륨(칼리)", "cmol⁺/kg", "열매를 굵게 하는 양분"],
  exchangeableCa: ["칼슘", "cmol⁺/kg", "흙의 산성을 눅여 주는 양분"],
  exchangeableMg: ["마그네슘", "cmol⁺/kg", "잎을 푸르게 하는 양분"],
});

const REQUEST_TIMEOUT_MS = 14_000;
const REPORT_POLL_DELAYS_MS = Object.freeze([150, 250, 400, 650, 1_000, 1_000]);

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
  COMPLETE: "분석 완료",
  READY: "자료 준비",
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
let sampleData = false;
let preflight = null;
let selectedCandidate = null;
let currentAnalysis = null;
let currentAnalyses = new Map();
let currentUiContexts = new Map();
let pendingAttempt = null;
let connectionPromise = null;
let assistantAnalysisId = null;

scrubLegacyMockSurfaces();
setDashboardResultVisibility(false);
resetDashboard();
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
  assistantForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitAssistantQuestion(assistantInput?.value ?? "");
  });
  document.querySelectorAll("[data-assistant-question]").forEach((button) => {
    button.addEventListener("click", () => {
      void submitAssistantQuestion(button.dataset.assistantQuestion ?? "");
    });
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
    clearSelectedCandidate("입력한 지역이 바뀌었습니다. 다시 확인해 주세요.");
    updateLocationSearchAvailability();
    pendingAttempt = null;
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

  const configPromise = readIntegrationConfig();
  try {
    await api.startSession(true);
    preflight = await api.preflight();
    const integrationConfig = await configPromise;
    sampleData = integrationConfig.sampleData === true;
    connected = true;
    renderRuntimeState();
  } catch (error) {
    sampleData = (await configPromise).sampleData === true;
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
    await submitAnalysis();
    document.body.dataset.sessionRestore = "ok";
  } catch (error) {
    // 복원은 편의 기능이다. 실패하면 처음부터 입력하도록 둔다.
    document.body.dataset.sessionRestore = `failed:${error?.message ?? "unknown"}`;
    setConnectionState("ready", "분석 조건을 입력해 주세요.");
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

  if (sampleData) {
    serviceBanner.hidden = false;
    setConnectionState(
      ready ? "ready" : "hold",
      "백엔드 연결됨 · 개발 샘플 데이터 사용 중",
    );
    setServiceBanner(
      "sample",
      "개발 샘플 · 농업 의사결정 금지",
      ready
        ? "API 전체 흐름 검증용 샘플입니다. 실제 재배·토지 의사결정에 사용하지 마세요."
        : `API 흐름 검증용 샘플이며 운영 준비는 보류 상태입니다. ${blockerCopy}`,
    );
    runtimeModeLabel.textContent = "개발 샘플 · 의사결정 금지";
    runtimeSafetyNotice.classList.add("runtime-sample-warning");
    replaceNotice(
      runtimeSafetyNotice,
      "개발 샘플 데이터입니다. 농업 의사결정에 사용하지 마세요.",
      ready
        ? "세션·위치 후보·분석·보고서 연결을 검증하기 위한 값입니다."
        : `운영 준비 보류(HOLD): ${blockerCopy}`,
    );
    return;
  }

  if (ready) {
    setConnectionState("ready", "실시간 자료 분석 가능");
    runtimeModeLabel.textContent = "실시간 분석";
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
  const persistence = preflight?.capabilities?.persistence;
  const available = ["READY", "AVAILABLE"].includes(persistence);
  input.disabled = !available;
  if (!available) input.checked = false;
  if (container) container.hidden = !available;
  label.textContent = "이 지역·작물 조합을 내 분석에 저장합니다. (선택)";
}

async function searchLocations() {
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
}

function selectLocationCandidate(candidate, button) {
  selectedCandidate = candidate;
  // 처음 위치 설정을 마이페이지의 주 사용 지역으로 삼는다.
  rememberRegion(candidate.displayName);
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
    return;
  }
  if (!selectedCandidate) {
    showRegionError("현재 위치를 사용하거나 검색 결과에서 농장 지역을 선택해 주세요.");
    navigateToWizardStep(1);
    return;
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
      return;
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
    const completed = [];
    for (const [index, payload] of payloads.entries()) {
      const created = await api.createAnalysis(
        payload,
        pendingAttempt.idempotencyKeys[index],
      );
      const analysisId = created?.analysisId;
      if (typeof analysisId !== "string" || analysisId === "") {
        throw new ApiRequestError({ code: "INVALID_API_RESPONSE", status: 502 });
      }
      completed.push(await api.getAnalysis(analysisId));
    }

    currentUiContexts = collectUiAnalysisContexts(formValues, payloads);
    currentAnalyses = new Map(
      completed.map((analysis) => [analysis?.inputSummary?.crop, analysis]),
    );
    currentAnalysis = completed[0];
    renderAnalysis(currentAnalysis);
    renderCropResultSwitcher();
    pendingAttempt = null;
    // 새로고침해도 같은 조건으로 이어서 볼 수 있게 기억한다.
    writeStoredSession(formValues, selectedCandidate?.displayName ?? null);
    closeWizardAfterAnalysis();
    if ((currentAnalysis?.report?.state ?? "NOT_REQUESTED") === "NOT_REQUESTED") {
      const automaticReportButton = document.querySelector("#backend-report-button");
      if (automaticReportButton) {
        void requestAndPollReport(automaticReportButton, { automatic: true });
      }
    }
  } catch (error) {
    if (error?.code === "LOCATION_TOKEN_INVALID") {
      clearSelectedCandidate("확인한 지역 정보가 만료되었습니다. 지역을 다시 확인해 주세요.");
      navigateToWizardStep(1);
    }
    showSubmitError(errorMessage(error));
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
      ? "현재 재배 조건 기준 기상·토양·예보 분석"
      : "후보지 기준 기상·토양·예보 분석";
  document.querySelector("#sidebar-mode-value").textContent =
    summary.usageMode === "ACTIVE_GROWING" ? "이미 농사 중" : "농지를 알아보는 중";

  renderLiveOutlook(analysis);
  renderDecisionPanel(analysis);
  renderStateOverview(analysis);
  renderActionsAndReport(analysis);
  renderSmartfarmReference(analysis);
  renderExplanation(analysis);
  renderEvidenceDialog(analysis);
  syncAssistantContext(analysis);
  writeStoredTodo(analysis);
  setDashboardResultVisibility(true);
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
      sampleData ? "개발 샘플 예보" : "기상청 단기·중기 예보",
    ),
  );
  forecastCard.append(header);

  if (days.length > 0) {
    const chartShell = element("div", "forecast-chart-shell");
    chartShell.append(
      temperatureChart(days),
      forecastChartSummary(days),
    );
    const dayList = element("div", "forecast-day-list");
    dayList.setAttribute("role", "list");
    dayList.setAttribute("aria-label", "날짜별 예보");
    dayList.append(...days.map(forecastDayCard));
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
  const visual = element("div", "live-action-visual");
  visual.setAttribute("aria-hidden", "true");
  visual.append(element("span", "live-action-stem"));
  const meta = element("div", "live-action-meta");
  meta.append(
    element(
      "span",
      "",
      `${formatKoreanDate(new Date())} · 날짜 기준 AI 예상`,
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
      sampleData ? "샘플 값 · 농업 의사결정 금지" : "농장별 안내",
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

  const actionBox = element("section", "farm-condition-actions");
  const combinedActions = uniqueText([
    ...weather.actions,
    ...soil.actions,
  ]).slice(0, 5);
  actionBox.append(
    element("h3", "", "필요한 행동"),
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
  guide.append(header, facts, actionBox);
  return guide;
}

function conditionFactCard(label, guide) {
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
    element("p", "", guide.reason),
  );
  if (guide.caveat) {
    card.append(element("p", "condition-fact-caveat", guide.caveat));
  }
  if (isSafeHttpUrl(guide.sourceUrl)) {
    const link = element("a", "condition-source-link", "검수 출처");
    link.href = guide.sourceUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    card.append(link);
  }
  return card;
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

function temperatureChart(days) {
  const svgNamespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("class", "forecast-temperature-chart");
  svg.setAttribute("viewBox", "0 0 560 116");
  svg.setAttribute("role", "img");
  const temperatures = days.map((day) =>
    Number.isFinite(day.maxTemperature) ? day.maxTemperature : null,
  );
  const available = temperatures.filter(Number.isFinite);
  svg.setAttribute(
    "aria-label",
    available.length
      ? `최고기온 흐름 ${available.map((value) => `${formatNumber(value)}도`).join(", ")}`
      : "최고기온 자료 없음",
  );
  [22, 50, 78].forEach((y) => {
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
  const points = temperatures.map((value, index) => {
    if (!Number.isFinite(value)) return null;
    const x = days.length === 1 ? 280 : 18 + (index * 524) / (days.length - 1);
    const y = 70 - ((value - minimum) / span) * 48;
    return { x, y, value, index };
  });
  const visiblePoints = points.filter(Boolean);
  const polyline = document.createElementNS(svgNamespace, "polyline");
  polyline.setAttribute("class", "temperature-line");
  polyline.setAttribute(
    "points",
    visiblePoints.map(({ x, y }) => `${x},${y}`).join(" "),
  );
  svg.append(polyline);
  visiblePoints.forEach(({ x, y, value, index }) => {
    const point = document.createElementNS(svgNamespace, "circle");
    point.setAttribute("class", "temperature-point");
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
    dateLabel.setAttribute("y", "108");
    dateLabel.setAttribute("text-anchor", "middle");
    dateLabel.textContent = formatForecastDate(days[index].date);
    svg.append(point, valueLabel, dateLabel);
  });
  return svg;
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

function forecastDayCard(day) {
  const card = element(
    "article",
    `forecast-day ${day.sourceType === "SHORT_GRID" ? "is-short" : ""}`.trim(),
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
      day.sourceType === "SHORT_GRID" ? "오늘~3일 예보" : "4일 이후 예보",
    ),
  );
  return card;
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
  const title = element("h2", "", "현재 농장 상태");
  title.id = "readiness-title";
  heading.append(
    element("span", "overview-kicker", "현재 확인 결과"),
    title,
  );
  const currentState = analysis?.state ?? "UNAVAILABLE";
  const stateVisual = element("div", "current-state-visual");
  const stateRing = element(
    "div",
    `current-state-ring ${
      ["COMPLETE", "READY"].includes(currentState)
        ? "is-good"
        : currentState === "PARTIAL"
          ? ""
          : "is-hold"
    }`.trim(),
  );
  stateRing.setAttribute("role", "img");
  stateRing.setAttribute(
    "aria-label",
    `현재 농장 상태 ${stateLabel(currentState)}`,
  );
  // 생육 적합도 점수. 자료가 모자라 점수를 못 내면 숫자 대신 상태를 보여 준다.
  const suitability = analysis?.suitability ?? null;
  const scored = suitability?.scored === true;
  stateRing.append(
    element("span", "", scored ? `${suitability.score}점` : stateLabel(currentState)),
  );
  const stateCopy = element("div", "current-state-copy");
  if (scored) {
    stateCopy.append(
      element("strong", "", `생육 적합도 ${suitability.score}점 · ${suitability.grade}`),
      element(
        "span",
        "",
        suitability.modules
          .map((item) => `${item.label} ${item.score}점`)
          .join(" · "),
      ),
    );
  } else {
    stateCopy.append(
      element("strong", "", stateLabel(currentState)),
      element(
        "span",
        "",
        suitability?.blockedReason ??
          "기상·토양·예보를 각각 확인한 현재 상태입니다.",
      ),
    );
  }
  stateVisual.append(stateRing, stateCopy);
  const axes = element("div", "axis-status-list");
  [
    ["기후 조건", analysis?.climate?.state, "작물·작기별 규칙과 비교"],
    ["토양 조건", analysis?.soil?.state, "지역 대표자료와 필지 실측을 구분"],
    ["가까운 예보", analysis?.forecast?.state, "장기 적합성과 분리한 위험 신호"],
  ].forEach(([label, value, help]) => {
    const state = value ?? "UNAVAILABLE";
    const card = element(
      "article",
      `axis-status ${toneForState(state) === "good" ? "" : "is-caution"}`.trim(),
    );
    card.append(
      element("span", "", label),
      element("strong", "", stateLabel(state)),
      element("small", "", help),
    );
    axes.append(card);
  });
  const overall = element(
    "p",
    "score-state",
    scored
      ? `${suitability.modules.map((m) => `${m.label} ${m.itemCount}개 항목`).join(" · ")} 비교 결과입니다. 확인되지 않은 항목은 아래에서 별도로 표시합니다.`
      : "확인되지 않은 항목은 아래에서 별도로 표시합니다.",
  );
  inner.append(heading, stateVisual, axes, overall);

  // 점수를 어떻게 냈는지 감추지 않는다.
  if (scored) {
    const how = element("details", "score-method");
    how.append(element("summary", "", "점수는 어떻게 계산했나요"));
    const body = element("div", "details-body");
    const list = element("ul", "reason-list");
    list.append(
      element(
        "li",
        "",
        `항목 편차 = ${suitability.method.itemDeviation}`,
      ),
      element(
        "li",
        "",
        `항목 중요도 = 매우 중요 ${suitability.method.weights.CRITICAL} · 중요 ${suitability.method.weights.IMPORTANT} · 보조 ${suitability.method.weights.SUPPORTING}`,
      ),
      element("li", "", `항목별 점수 = ${suitability.method.moduleScore}`),
      element("li", "", `종합 점수 = ${suitability.method.totalScore}`),
      element("li", "", suitability.method.note),
    );
    body.append(list);
    if (suitability.nearTermRiskDays > 0) {
      body.append(
        element(
          "p",
          "formula-note",
          `가까운 예보 위험 ${suitability.nearTermRiskDays}건은 지금 당장의 주의 사항이라 적합도 점수에 섞지 않고 따로 표시합니다.`,
        ),
      );
    }
    how.append(body);
    inner.append(how);
  }

  const button = element("button", "button button-secondary score-evidence-button", "분석 근거 보기");
  button.type = "button";
  button.addEventListener("click", () => openEvidenceDialog());

  const spatial = element("section", "overview-spatial");
  const spatialTitle = element(
    "h3",
    "overview-spatial-title",
    `자료 공간 범위 · ${parcelStateLabel(analysis?.inputSummary?.parcelState)}`,
  );
  const distanceList = element("dl", "distance-list");
  const distanceSources = (analysis?.dataSources ?? [])
    .filter((source) => Number.isFinite(source?.distanceKm))
    .slice(0, 3);
  if (distanceSources.length) {
    distanceSources.forEach((source) => {
      const row = element("div", "distance-row");
      row.append(
        element("dt", "", source.sourceName ?? source.sourceId ?? "자료"),
        element("dd", "", `${formatNumber(source.distanceKm)}km`),
      );
      distanceList.append(row);
    });
  } else {
    const row = element("div", "distance-row");
    row.append(
      element("dt", "", "거리 정보"),
      element("dd", "", "제공되지 않음"),
    );
    distanceList.append(row);
  }
  spatial.append(
    spatialTitle,
    distanceList,
    element("p", "spatial-caveat", "지역 자료는 필지 실측값이 아닙니다."),
  );
  overview.replaceChildren(inner, button, spatial);
}

function renderMetricStrip(analysis) {
  const strip = document.querySelector(".metric-strip");
  const metrics = [
    ["기후 조건", analysis?.climate?.state, "작물·작기 기준과 비교"],
    ["토양 조건", analysis?.soil?.state, "필지 실측 여부를 함께 확인"],
    ["가까운 예보", analysis?.forecast?.state, "날짜·지속기간이 있는 별도 신호"],
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
  const module = analysis?.smartfarm;
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
      sampleData ? "개발 샘플 비교" : stateLabel(module.state),
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

  // 확정된 분석 문장을 쉬운 말로 다시 쓴 결과. 검증을 통과한 경우에만 붙인다.
  const plain = analysis?.report?.plainLanguage;
  if (plain?.state === "READY" && plain.paragraphs?.length) {
    const easy = element("div", "plain-report");
    easy.append(
      element("h3", "", "쉬운 말로 다시 읽기 "),
      ...plain.paragraphs.map((text) => element("p", "", text)),
      element(
        "p",
        "formula-note",
        "위 분석 결과를 초보 농업인이 읽기 쉬운 말로 다시 쓴 것입니다. 새로운 진단이나 처방은 만들지 않으며, 분석에 없는 숫자가 나오면 자동으로 버려집니다.",
      ),
    );
    explanation.append(easy);
  }

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

  const evidenceSection = element("section");
  evidenceSection.append(element("h3", "", "모듈별 근거"));
  const evidence = collectEvidence(analysis);
  if (evidence.length === 0) {
    evidenceSection.append(
      element(
        "p",
        "backend-empty",
        "표시할 근거가 없습니다. 자료 상태와 한계를 확인해 주세요.",
      ),
    );
  } else {
    evidenceSection.append(evidenceTable(evidence.slice(0, 80)));
    if (evidence.length > 80) {
      evidenceSection.append(
        element(
          "p",
          "muted",
          `화면에는 ${evidence.length}개 중 앞의 80개 근거를 표시합니다.`,
        ),
      );
    }
  }

  const sourceSection = element("section", "panel");
  sourceSection.append(
    element("h3", "", "출처"),
    sourceGrid(analysis?.dataSources),
  );
  const limits = element("section", "panel");
  limits.id = "dialog-limits";
  limits.tabIndex = -1;
  limits.append(element("h3", "", "원자료와 한계"), limitationList(analysis?.limitations));
  const technical = element("details", "evidence-technical-details");
  const technicalBody = element("div", "evidence-technical-body");
  technical.append(
    element("summary", "", "원자료·출처·규칙 보기"),
    technicalBody,
  );
  technicalBody.append(
    element(
      "p",
      "muted",
      `규칙 버전 · ${analysis?.ruleVersion ?? "제공되지 않음"}`,
    ),
    evidenceSection,
    sourceSection,
    limits,
  );
  const content = [renderFarmConditionGuide(analysis, "dialog")];
  if (sampleData) {
    const warning = element(
      "div",
      "notice notice-warning runtime-sample-warning",
    );
    warning.append(
      element(
        "p",
        "",
        "개발 샘플 근거입니다. 농업 의사결정에 사용하지 마세요.",
      ),
    );
    content.unshift(warning);
  }
  body.replaceChildren(...content, technical);
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
    ? analysis.actions.filter(isUserFacingAction)
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
  const noRiskConfirmed =
    analysis?.forecast?.state === "READY" &&
    analysis?.forecast?.result?.noActiveRisksConfirmed === true;
  const regional =
    analysis?.inputSummary?.locationPrecision === "ADMIN_AREA_BROAD";
  const scopeCaveat = regional
    ? "시·군 대표 예보이며 실제 밭의 관측값이 아닙니다."
    : null;
  if (!risk) {
    return {
      risk: false,
      ready: noRiskConfirmed,
      regional,
      tone: noRiskConfirmed ? "good" : "unknown",
      condition: noRiskConfirmed
        ? "현재 확인된 작물 위험 신호 없음"
        : days.length > 0
          ? "일부 예보만 확인됨"
          : "예보 자료 확인 필요",
      reason: noRiskConfirmed
        ? "연결된 예보를 작물별 검수 기준과 비교했으며 현재 활성화된 위험 규칙은 없습니다."
        : days.length > 0
          ? "확인되지 않은 날짜나 값이 있어 위험이 없다고 단정할 수 없습니다."
        : "현재 예보값이 없어 작물별 가까운 위험을 확인하지 못했습니다.",
      actions: noRiskConfirmed
        ? ["예보가 갱신되면 같은 농장 조건으로 다시 확인합니다."]
        : ["농장 위치를 확인한 뒤 예보를 다시 불러옵니다."],
      recheck: noRiskConfirmed
        ? "다음 예보 갱신 뒤 같은 조건으로 다시 확인합니다."
        : "예보 연결을 복구한 뒤 다시 확인합니다.",
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

  // 사용자가 등록한 토양검정 결과가 판단 근거이면 지역 분포 문구를 쓰지 않는다.
  if (soil?.result?.measurementBasis === "USER_SOIL_TEST" && ph) {
    const measured = soil.result.userSoilTest ?? {};
    const withinRange = ph.fitRatio >= 1;
    // 검수된 규칙으로 실제 판정된 항목만 적는다. 판정 못 한 값은 세지 않는다.
    const judged = metrics.map((metric) => ({
      label: SOIL_METRIC_LABELS[metric.metric] ?? metric.metric,
      inside: metric.fitRatio >= 1,
      range: metricOptimalRange(soil, metric.ruleId),
      value: measured[SOIL_METRIC_FIELDS[metric.metric]] ?? null,
    }));
    const outside = judged.filter((item) => !item.inside);
    const phRange = judged.find((item) => item.label === "산도 pH")?.range ?? null;

    return {
      ready: true,
      tone: outside.length === 0 ? "good" : "caution",
      condition: `내 밭 pH ${measured.ph} · ${
        outside.length === 0
          ? `검사 ${judged.length}개 항목 모두 기준 안`
          : `${outside.length}개 항목 기준 밖`
      }`,
      reason:
        `등록하신 토양검정 결과로 판단했습니다. 산도 pH ${measured.ph}는 ${
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
      caveat: `${measured.sampledOn} 검사${
        measured.issuer ? ` · ${measured.issuer}` : ""
      } 기준입니다. 지역 평균이 아니라 이 필지의 실측값입니다.`,
      actions:
        outside.length === 0
          ? [
              "모든 항목이 기준 안이므로 처방서의 시용량을 그대로 지키면 됩니다.",
              "다음 작기 전에 토양검정을 다시 받아 변화를 확인합니다.",
            ]
          : [
              `처방서에서 ${outside
                .map((item) => item.label)
                .join(" · ")} 관련 시용량을 확인해 조정합니다.`,
              "조정 후 다음 작기 전에 토양검정을 다시 받아 확인합니다.",
            ],
      sourceUrl: null,
    };
  }

  if (fieldProfile) {
    const regionalPhSummary = ph
      ? ` 지역 pH 통계에서 기준 밖 면적은 ${formatPercent(ph.outsideRatio)}입니다.`
      : "";
    return {
      ready: true,
      tone: ph?.outsideRatio > 0 ? "caution" : "info",
      condition: "필지 배수·토성·뿌리층 자료 확인됨",
      reason:
        `선택한 필지의 1:5,000 토양도에서 배수등급, 표토 토성, 유효토심 자료를 확인했습니다.${regionalPhSummary}`,
      caveat:
        "토양도는 필지 토양의 물리 특성 참고자료이며, pH·EC는 최근 토양검정 결과로 별도 확인해야 합니다.",
      actions: [
        "배수가 나쁘거나 뿌리층이 얕은지 농업기술센터에서 필지 토양도 코드의 의미를 확인합니다.",
        "최근 토양검정 결과에서 pH와 EC를 확인합니다.",
      ],
      sourceUrl: soilFieldSourceUrl(analysis) ?? soilSourceUrl(analysis),
    };
  }
  if (ph && ["READY", "PARTIAL"].includes(soil?.state)) {
    const fit = formatPercent(ph.fitRatio);
    const uncertain = formatPercent(ph.uncertainRatio);
    const outside = formatPercent(ph.outsideRatio);
    return {
      ready: true,
      tone: ph.outsideRatio > 0 ? "caution" : "good",
      condition:
        ph.outsideRatio > 0
          ? `지역 pH 기준 밖 면적 ${outside}`
          : `지역 pH 기준 범위 면적 ${fit}`,
      reason:
        `지역 토양 통계에서 작물 pH 기준과 겹치는 면적은 ${fit}, 경계에 걸친 면적은 ${uncertain}, 기준 밖 면적은 ${outside}입니다.`,
      caveat:
        "지역 pH 분포이며 실제 밭의 pH·EC 측정값은 아닙니다.",
      actions: [
        "실제 밭의 토양검정 결과에서 pH와 EC를 확인합니다.",
        "검정 결과가 없다면 가까운 농업기술센터에 토양검정을 신청합니다.",
      ],
      sourceUrl: soilSourceUrl(analysis),
    };
  }

  return {
    ready: false,
    tone: "unknown",
    condition: "농장 토양 pH·EC 미확인",
    reason:
      "현재 연결 자료에서 농장 토양의 pH와 EC를 확인하지 못했습니다. 토양 상태를 임의로 추정하지 않습니다.",
    caveat: "지역 통계는 실제 밭의 측정값이 아닙니다.",
    actions: [
      "기존 토양검정 결과가 있다면 pH와 EC 값을 등록합니다.",
      "검정 결과가 없다면 가까운 농업기술센터에 토양검정을 신청합니다.",
    ],
    sourceUrl: soilSourceUrl(analysis),
  };
}

function soilFieldSourceUrl(analysis) {
  const source = (analysis?.dataSources ?? []).find((item) =>
    /soil-field|토양특성/iu.test(
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
  return action?.actionId !== "COLLECT_REQUIRED_DATA";
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
  const days = forecastDisplayDays(analysis);
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
  document.body.classList.add("analysis-ready");
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

function scrubLegacyMockSurfaces() {
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
  if (recent) {
    recent.replaceChildren(
      element("h2", "", "최근 분석"),
      element(
        "p",
        "recent-analysis",
        "새 분석을 시작하면 방금 확인한 결과를 다시 볼 수 있습니다.",
      ),
    );
  }

  const analysisSurface = document.querySelector(
    "#view-analyses .analysis-list-surface",
  );
  if (analysisSurface) {
    const panel = element("section", "panel");
    panel.append(
      element("h2", "", "최근 분석"),
      element(
        "p",
        "",
        "새 분석을 시작하면 이 화면에서 최근 결과를 확인할 수 있습니다.",
      ),
    );
    analysisSurface.replaceChildren(panel);
  }

  renderRegionLabels();
  setupSoilTestPanel();
  setupAccountKeyPanel();
  setupNotificationPanel();
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

function setDashboardResultVisibility(visible) {
  [
    "#live-outlook",
    ".decision-flow",
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
  document.querySelector(".decision-flow")?.classList.add("is-user-focused");
}

function openAssistant() {
  if (!assistantPanel || !assistantLauncher) return;
  assistantPanel.hidden = false;
  assistantLauncher.setAttribute("aria-expanded", "true");
  assistantPanel.setAttribute(
    "aria-modal",
    String(window.matchMedia("(max-width: 620px)").matches),
  );
  document.body.classList.add("assistant-open");
  requestAnimationFrame(() => assistantInput?.focus());
}

function closeAssistant() {
  if (!assistantPanel || !assistantLauncher) return;
  assistantPanel.hidden = true;
  assistantLauncher.setAttribute("aria-expanded", "false");
  document.body.classList.remove("assistant-open");
  assistantLauncher.focus();
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
        ? `${crop} 분석에서 확인된 날씨·토양 근거와 필요한 행동만 설명합니다.`
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
  assistantInput.disabled = true;
  assistantSend.disabled = true;
  assistantSend.textContent = "확인 중";
  const pending = appendAssistantMessage("현재 분석 근거를 확인하고 있습니다.");
  try {
    const response = await api.askAssistant(expectedAnalysisId, question);
    if (expectedAnalysisId !== currentAnalysis?.analysisId) return;
    pending?.remove();
    appendAssistantMessage(response?.answer ?? "설명할 근거를 찾지 못했습니다.", {
      note: response?.notice,
    });
  } catch (error) {
    pending?.remove();
    appendAssistantMessage(
      error?.code === "ANALYSIS_NOT_FOUND"
        ? "분석 세션이 만료되었습니다. 농장 분석을 다시 실행해 주세요."
        : "설명을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
    );
  } finally {
    if (expectedAnalysisId === currentAnalysis?.analysisId) {
      assistantInput.disabled = false;
      assistantSend.disabled = false;
      assistantSend.textContent = "전송";
      assistantInput.focus();
    }
  }
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
  locationCandidates.hidden = true;
  locationCandidates.replaceChildren();
  updateSubmitAvailability();
  syncWizardNextState();
  if (statusMessage) setLocationStatus(statusMessage);
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
  if (!storage) return;
  try {
    storage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        situation: values.situation,
        crops: values.crops,
        cropSettings: values.cropSettings,
        region,
      }),
    );
  } catch {
    // 저장소가 가득 찼거나 막혀 있으면 복원 없이 계속 쓴다.
  }
}

function readStoredSession() {
  const raw = safeStorage()?.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.region === "string" &&
      Array.isArray(parsed?.crops) &&
      parsed.crops.length > 0
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function clearStoredSession() {
  safeStorage()?.removeItem(SESSION_STORAGE_KEY);
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
  if (!storage) return;
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
  if (!alarm || Notification?.permission !== "granted") return;

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
  if (!badge) return;

  if (!notificationsSupported()) {
    badge.textContent = "지원 안 함";
    if (permissionCopy) {
      permissionCopy.textContent =
        "이 브라우저는 알림을 지원하지 않습니다. 크롬이나 사파리에서 열어 주세요.";
    }
    if (enableButton) enableButton.disabled = true;
    return;
  }

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
  const timeInput = document.querySelector("#notification-time");
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
  EC: "전기전도도(짠기)",
  ORGANIC_MATTER: "유기물",
  AVAILABLE_PHOSPHATE: "유효인산",
  EXCHANGEABLE_K: "칼륨(칼리)",
  EXCHANGEABLE_CA: "칼슘",
  EXCHANGEABLE_MG: "마그네슘",
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
      const [label, unit, plain] = SOIL_TEST_LABELS[field];
      const term = element("dt", "condition-fact-label", label);
      if (plain) term.title = plain;
      nodes.push(term);
      const value = element("dd", "condition-fact-title");
      value.append(
        element(
          "span",
          "",
          unit === "" ? String(stored[field]) : `${stored[field]} ${unit}`,
        ),
      );
      if (plain) value.append(element("small", "muted", plain));
      nodes.push(value);
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
    situation: selectedRadioValue("situation") || "planning",
    crops,
    analysisMonth: new Date().getMonth() + 1,
    cropSettings: Object.fromEntries(
      crops.map((crop) => [
        crop,
        {
          cultivation: selectedRadioValue(`cultivation-${crop}`),
          season: "current",
          growth: selectedRadioValue(`growth-${crop}`),
        },
      ]),
    ),
    saveConsent: document.querySelector("#save-consent")?.checked === true,
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
  if ((selectedRadioValue("situation") || "planning") === "planning") {
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

async function readIntegrationConfig() {
  try {
    const response = await fetch("/__integration/config", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return { sampleData: false };
    const config = await response.json();
    return config && typeof config === "object"
      ? config
      : { sampleData: false };
  } catch {
    return { sampleData: false };
  }
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
