import {
  ContractValidationError,
  buildAnalysisRequest,
  createIdempotencyKey,
  requestFingerprint,
} from "./api-contract.mjs";

window.__BACKEND_INTEGRATION_ENABLED__ = true;

const REQUEST_TIMEOUT_MS = 12_000;
const REPORT_POLL_DELAYS_MS = Object.freeze([150, 250, 400, 650, 1_000, 1_000]);

const CROP_LABELS = Object.freeze({
  APPLE: "사과",
  PEAR: "배",
  CUCUMBER: "오이",
  POTATO: "감자",
  LETTUCE: "상추",
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
  LOCATION_TOKEN_INVALID: "주소 후보가 만료되었습니다. 후보를 다시 찾아 선택해 주세요.",
  LOCATION_NOT_CONFIRMED: "주소 후보를 직접 선택해 주세요.",
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

let connected = false;
let sampleData = false;
let preflight = null;
let selectedCandidate = null;
let currentAnalysis = null;
let pendingAttempt = null;
let connectionPromise = null;

scrubLegacyMockSurfaces();
setDashboardResultVisibility(false);
resetDashboard();
wireInteractions();
void connectBackend();

function wireInteractions() {
  retryConnectionButton.addEventListener("click", () => {
    void connectBackend(true);
  });
  wizardRetryConnectionButton.addEventListener("click", () => {
    void connectBackend(true);
  });
  searchLocationButton.addEventListener("click", () => {
    void searchLocations();
  });
  regionInput.addEventListener("input", () => {
    clearSelectedCandidate("입력한 지역이 바뀌었습니다. 주소 후보를 다시 찾아 주세요.");
    updateLocationSearchAvailability();
    pendingAttempt = null;
  });
  document.querySelector("#use-broad-region")?.addEventListener("click", () => {
    clearSelectedCandidate("군 단위 주소 후보를 찾아 직접 선택해 주세요.");
    updateLocationSearchAvailability();
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
      if (visibleStep === "2" && !selectedCandidate) {
        event.preventDefault();
        event.stopImmediatePropagation();
        showRegionError("주소 후보를 찾아 하나를 선택해야 다음으로 갈 수 있습니다.");
        if (regionInput.value.trim()) void searchLocations();
        else regionInput.focus();
      }
      if (
        visibleStep === "3" &&
        selectedRadioValue("cultivation") === "unknown" &&
        ["cucumber", "lettuce"].includes(selectedRadioValue("crop"))
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        showFieldError(
          "cultivation-error",
          "노지·시설흙·시설물 중 하나를 확인한 뒤 선택해 주세요.",
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
  setConnectionState("loading", "안전한 분석 세션을 준비하고 있습니다.");
  setServiceBanner(
    "loading",
    "백엔드 연결을 확인하고 있습니다.",
    "세션과 운영 준비 상태를 안전하게 확인하는 중입니다.",
  );
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
    setServiceBanner("error", "백엔드 연결 실패", message);
    retryConnectionButton.hidden = false;
    wizardRetryConnectionButton.hidden = false;
    runtimeModeLabel.textContent = "API 연결 실패";
    runtimeModeLabel.closest(".test-mode")?.classList.add("danger");
  } finally {
    document.body.dataset.integration = connected ? "ready" : "error";
    updateLocationSearchAvailability();
    updateSubmitAvailability();
  }
}

function renderRuntimeState() {
  const ready = preflight?.ready === true || preflight?.serviceState === "READY";
  const blockers = [...new Set(preflight?.blockers ?? [])];
  const blockerCopy = blockers.length
    ? blockers.slice(0, 4).map(preflightBlockerLabel).join(" · ")
    : "운영 준비 차단 사유가 제공되지 않았습니다.";
  runtimeSafetyNotice.className = "notice notice-warning";
  retryConnectionButton.hidden = true;
  wizardRetryConnectionButton.hidden = true;
  setLocationStatus(
    regionInput.value.trim()
      ? "입력한 지역의 주소 후보를 찾아 하나를 선택해 주세요."
      : "지역을 입력한 뒤 주소 후보 찾기를 눌러 주세요.",
  );
  configurePersistenceControl();

  if (sampleData) {
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
    setConnectionState("ready", "백엔드 연결됨 · 운영 준비 완료");
    setServiceBanner(
      "ready",
      "API 연결 및 운영 준비 완료",
      `백엔드 ${preflight?.serviceVersion ?? ""} · 자료가 부족하면 판단을 보류합니다.`,
    );
    runtimeModeLabel.textContent = "실제 API 연결";
    replaceNotice(
      runtimeSafetyNotice,
      "실제 백엔드 분석을 요청합니다.",
      "자료가 부족하면 값을 추측하지 않고 보류 상태와 필요한 다음 확인만 표시합니다.",
    );
  } else {
    setConnectionState("hold", "백엔드 연결됨 · 운영 준비 보류(HOLD)");
    setServiceBanner(
      "hold",
      "운영 준비 보류(HOLD)",
      `${blockerCopy} API 연결은 유지하며 결과는 백엔드 상태 그대로 보수적으로 표시합니다.`,
    );
    runtimeModeLabel.textContent = "운영 준비 보류";
    replaceNotice(
      runtimeSafetyNotice,
      "운영 배포 준비가 보류된 백엔드입니다.",
      `${blockerCopy} 분석을 요청해도 준비되지 않은 자료는 임의로 채우지 않습니다.`,
    );
  }
}

function configurePersistenceControl() {
  const input = document.querySelector("#save-consent");
  const label = document.querySelector('label[for="save-consent"]');
  if (!input || !label) return;
  const persistence = preflight?.capabilities?.persistence;
  const available = ["READY", "AVAILABLE"].includes(persistence);
  input.disabled = !available;
  if (!available) input.checked = false;
  label.textContent = available
    ? "이 지역·작물 조합 저장에 동의합니다. (선택, 기본 꺼짐)"
    : "분석 목록 영구 저장은 현재 지원하지 않습니다.";
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
  setLocationStatus("주소 후보를 확인하고 있습니다.");
  locationCandidates.hidden = true;
  locationCandidates.replaceChildren();

  try {
    const response = await api.searchLocations(query);
    const candidates = Array.isArray(response?.candidates)
      ? response.candidates.filter(isLocationCandidate)
      : [];
    if (candidates.length === 0) {
      setLocationStatus(
        "일치하는 주소 후보가 없습니다. 시·군·읍·면을 포함해 다시 입력해 주세요.",
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
    setBusy(searchLocationButton, false, "주소 후보 찾기");
    updateLocationSearchAvailability();
  }
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
  regionInput.value = candidate.displayName;
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
  announce("주소 후보를 선택했습니다. 다음 단계로 진행할 수 있습니다.");
}

async function submitAnalysis() {
  if (!connected) {
    showSubmitError("백엔드 연결을 먼저 복구해 주세요.");
    return;
  }
  if (!selectedCandidate) {
    showRegionError("주소 후보를 찾아 하나를 직접 선택해 주세요.");
    navigateToWizardStep(2);
    return;
  }

  let payload;
  try {
    payload = buildAnalysisRequest(readFormValues(), selectedCandidate.candidateToken);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      showContractError(error);
      return;
    }
    throw error;
  }

  const fingerprint = requestFingerprint(payload);
  if (!pendingAttempt || pendingAttempt.fingerprint !== fingerprint) {
    pendingAttempt = {
      fingerprint,
      idempotencyKey: createIdempotencyKey(),
    };
  }

  setBusy(runAnalysisButton, true, "분석하는 중…");
  form.setAttribute("aria-busy", "true");
  replaceNotice(
    runtimeSafetyNotice,
    "지역 자료와 검토 규칙을 연결하고 있습니다.",
    "같은 요청이 중복 처리되지 않도록 보호한 뒤 결과를 확인합니다.",
  );

  try {
    const created = await api.createAnalysis(payload, pendingAttempt.idempotencyKey);
    const analysisId = created?.analysisId;
    if (typeof analysisId !== "string" || analysisId === "") {
      throw new ApiRequestError({ code: "INVALID_API_RESPONSE", status: 502 });
    }
    currentAnalysis = await api.getAnalysis(analysisId);
    renderAnalysis(currentAnalysis);
    pendingAttempt = null;
    closeWizardAfterAnalysis();
  } catch (error) {
    if (error?.code === "LOCATION_TOKEN_INVALID") {
      clearSelectedCandidate("주소 후보가 만료되었습니다. 다시 찾아 선택해 주세요.");
      navigateToWizardStep(2);
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
  const decisionMessage =
    analysis?.decision?.message ??
    "현재 자료만으로는 다음 판단을 확정할 수 없습니다.";

  renderSummaryPanel(analysis, regionLabel, cropLabel);
  document.querySelector("#sidebar-context-value").textContent = context;
  document.querySelector("#topbar-context-value").textContent = context;
  document.querySelector("#dashboard-title").textContent = `${regionLabel} ${cropLabel} 브리핑`;
  document.querySelector("#dashboard-mode-copy").textContent =
    summary.usageMode === "ACTIVE_GROWING"
      ? "현재 재배 조건의 가까운 위험과 다음 확인을 백엔드 결과 그대로 보여드립니다."
      : "후보지 판단에 필요한 자료 상태와 다음 확인을 백엔드 결과 그대로 보여드립니다.";
  document.querySelector("#sidebar-mode-value").textContent =
    summary.usageMode === "ACTIVE_GROWING" ? "이미 농사 중" : "농지를 알아보는 중";

  renderDecisionPanel(analysis, decisionMessage);
  renderStateOverview(analysis);
  renderMetricStrip(analysis);
  renderActionsAndReport(analysis);
  renderExplanation(analysis, decisionMessage);
  renderEvidenceWorkspace(analysis);
  renderEvidenceDialog(analysis);
  setDashboardResultVisibility(true);
}

function renderSummaryPanel(analysis, regionLabel, cropLabel) {
  const panel = document.querySelector(".summary-panel");
  const meta = element("div", "summary-meta");
  const title = element("div", "summary-primary");
  const region = element("span", "", regionLabel);
  region.id = "result-region";
  const crop = element("span", "", cropLabel);
  crop.id = "result-crop";
  title.append(region, document.createTextNode(" · "), crop);
  const created = element("div");
  created.append(
    element("span", "meta-label", "분석 시각"),
    element("span", "meta-value", formatDateTime(analysis?.createdAt)),
  );
  const status = element(
    "span",
    `status-label ${toneForState(analysis?.state)}`,
    stateLabel(analysis?.state),
  );
  const persistence = element("div", "persistence-state");
  persistence.append(
    element("span", "meta-label", "분석 저장"),
    element(
      "span",
      "meta-value",
      persistenceStateLabel(analysis?.persistenceState),
    ),
  );
  const headline = element(
    "span",
    "headline-status",
    `현재 판단 · ${decisionLabel(analysis?.decision?.code)}`,
  );
  meta.append(title, created, persistence, status, headline);
  panel.replaceChildren(meta);
}

function renderDecisionPanel(analysis, decisionMessage) {
  const panel = document.querySelector(".risk-panel");
  const eyebrow = element(
    "p",
    "risk-date",
    `판단 코드 · ${decisionLabel(analysis?.decision?.code)}`,
  );
  const title = element("h2", "risk-title", decisionMessage);
  title.id = "risk-title";
  const context = element(
    "p",
    "",
    analysis?.riskState === "READY"
      ? "가까운 위험 자료가 준비되었습니다. 아래 근거와 행동을 함께 확인하세요."
      : "가까운 위험 자료가 충분하지 않습니다. 확인되지 않은 위험을 없다고 단정하지 않습니다.",
  );
  panel.replaceChildren(eyebrow, title, context);
}

function renderStateOverview(analysis) {
  const overview = document.querySelector(".overview-score");
  const inner = element("div", "backend-state-grid");
  const title = element("h2", "", "전체 분석 상태");
  title.id = "score-title";
  const state = element(
    "div",
    "backend-state-word",
    stateLabel(analysis?.state),
  );
  state.dataset.tone = toneForState(analysis?.state);
  const condition = element(
    "p",
    "backend-state-caption",
    `재배환경 ${stateLabel(analysis?.conditionState)} · 가까운 위험 ${stateLabel(
      analysis?.riskState,
    )}`,
  );
  inner.append(title, state, condition);

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
    ["전체 분석", analysis?.state],
    ["재배환경 자료", analysis?.conditionState],
    ["가까운 위험", analysis?.riskState],
    ["보고서", analysis?.report?.state],
  ];
  strip.replaceChildren(
    ...metrics.map(([label, value]) => {
      const cell = element("div", "metric-cell");
      cell.append(
        element("span", "metric-label", label),
        element(
          "div",
          "metric-value backend-metric",
          stateLabel(value),
        ),
        element("p", "backend-state-caption", stateHelp(value)),
      );
      return cell;
    }),
  );
}

function renderActionsAndReport(analysis) {
  const workspace = document.querySelector(".action-workspace");
  const actionMain = element("section", "action-main");
  const heading = element("div", "section-heading");
  const headingCopy = element("div");
  headingCopy.append(
    element("h2", "", "지금 확인할 행동"),
    element("p", "muted", "백엔드가 근거 상태와 시급성을 확인해 정렬했습니다."),
  );
  heading.append(
    headingCopy,
    element(
      "span",
      `status-label ${analysis?.actions?.length ? "info" : "warning"}`,
      `${analysis?.actions?.length ?? 0}개`,
    ),
  );
  actionMain.append(heading, actionList(analysis?.actions));

  const report = element("section", "backend-report");
  report.id = "backend-report-panel";
  renderReportPanel(report, analysis);
  workspace.replaceChildren(actionMain, report);
}

function renderExplanation(analysis, decisionMessage) {
  const grid = document.querySelector(".insight-grid");
  const explanation = element("article", "panel ai-panel");
  const title = element("h2", "ai-title", "백엔드 판단 요약");
  explanation.append(
    title,
    element("p", "", decisionMessage),
    actionList(analysis?.actions, "plain-steps"),
    element(
      "p",
      "formula-note",
      "단일 종합점수나 숨은 재가중치는 사용하지 않습니다. 각 자료의 상태와 한계를 분리해 표시합니다.",
    ),
  );

  const limitations = element("aside", "panel insight-reasons");
  limitations.append(
    element("h2", "", "확인된 한계"),
    limitationList(analysis?.limitations),
  );
  grid.replaceChildren(explanation, limitations);
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
  const dialogTitle = element("h2", "", "근거와 자료 상세");
  dialogTitle.id = "evidence-dialog-title";
  titleGroup.replaceChildren(
    dialogTitle,
    element(
      "p",
      "muted no-margin",
      `규칙 버전 · ${analysis?.ruleVersion ?? "제공되지 않음"}`,
    ),
  );
  const body = dialog.querySelector(".dialog-body");
  const warning = element(
    "div",
    `notice ${sampleData ? "notice-warning runtime-sample-warning" : "notice-warning"}`,
  );
  warning.append(
    element(
      "p",
      "",
      sampleData
        ? "개발 샘플 근거입니다. 농업 의사결정에 사용하지 마세요."
        : "단일 종합점수 없이 모듈별 상태와 원자료 근거를 표시합니다.",
    ),
    element(
      "p",
      "",
      "결측값은 임의로 채우지 않으며 제외된 근거도 제외 사유와 함께 표시합니다.",
    ),
  );

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
  body.replaceChildren(warning, evidenceSection, sourceSection, limits);
}

function renderReportPanel(panel, analysis) {
  const header = element("div", "backend-report-header");
  const heading = element("h2", "", "판단 보고서");
  const button = element("button", "button button-secondary", "보고서 만들기");
  button.type = "button";
  button.id = "backend-report-button";
  const reportState = analysis?.report?.state ?? "NOT_REQUESTED";
  button.disabled = reportState === "PENDING";
  if (["READY", "FALLBACK"].includes(reportState)) {
    button.textContent = "보고서 다시 확인";
  }
  button.addEventListener("click", () => {
    void requestAndPollReport(button);
  });
  header.append(heading, button);
  const status = element(
    "p",
    "backend-report-status",
    `현재 상태 · ${stateLabel(reportState)}`,
  );
  status.id = "backend-report-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const content = element("div", "backend-report-content");
  content.id = "backend-report-content";
  if (["READY", "FALLBACK"].includes(reportState) && analysis?.report?.value) {
    content.replaceChildren(...reportSections(analysis.report.value));
  } else {
    content.append(
      element(
        "p",
        "backend-empty",
        reportState === "PENDING"
          ? "보고서를 생성하고 있습니다."
          : "분석 근거에 연결된 결정형 보고서를 만들 수 있습니다.",
      ),
    );
  }
  panel.replaceChildren(header, status, content);
}

async function requestAndPollReport(button) {
  if (!currentAnalysis?.analysisId) return;
  setBusy(button, true, "보고서 만드는 중…");
  const status = document.querySelector("#backend-report-status");
  status.textContent = "보고서 생성을 요청했습니다.";

  try {
    currentAnalysis = await api.requestReport(currentAnalysis.analysisId);
    renderMetricStrip(currentAnalysis);
    if (["READY", "FALLBACK"].includes(currentAnalysis?.report?.state)) {
      renderActionsAndReport(currentAnalysis);
      announce("판단 보고서가 준비되었습니다.");
      return;
    }
    for (const delayMs of REPORT_POLL_DELAYS_MS) {
      await delay(delayMs);
      currentAnalysis = await api.getAnalysis(currentAnalysis.analysisId);
      status.textContent = `보고서 상태 · ${stateLabel(currentAnalysis?.report?.state)}`;
      if (["READY", "FALLBACK"].includes(currentAnalysis?.report?.state)) {
        renderMetricStrip(currentAnalysis);
        renderActionsAndReport(currentAnalysis);
        announce("판단 보고서가 준비되었습니다.");
        return;
      }
    }
    status.textContent =
      "보고서 생성이 계속 진행 중입니다. 잠시 뒤 다시 확인해 주세요.";
    button.textContent = "상태 다시 확인";
  } catch (error) {
    status.textContent = errorMessage(error);
    button.textContent = "보고서 다시 시도";
  } finally {
    setBusy(button, false, button.textContent);
  }
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
  if (textOf(summary)) {
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
    ["limitations", "한계"],
  ].forEach(([key, label]) => {
    const items = Array.isArray(report?.[key])
      ? report[key]
          .map(textOf)
          .filter(Boolean)
          .map((text) => (key === "limitations" ? limitationLabel(text) : text))
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
          "보고서에 표시할 검증된 문장이 없습니다.",
        ),
      ];
}

function actionList(actions, className = "backend-action-list") {
  const safeActions = Array.isArray(actions) ? actions : [];
  if (!safeActions.length) {
    return element(
      "p",
      "backend-empty",
      "확정된 행동이 없습니다. 자료 상태와 한계를 먼저 확인해 주세요.",
    );
  }
  const list = element("ol", className);
  list.replaceChildren(
    ...safeActions.map((action) => {
      const item = element("li", "", action.title ?? "근거 상태 확인");
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
      "지역과 작물을 입력하면 자료 상태와 다음 확인을 보여드립니다.";
  }

  const recent = document.querySelector(".sidebar-recent");
  if (recent) {
    recent.replaceChildren(
      element("h2", "", "최근 분석"),
      element(
        "p",
        "recent-analysis",
        "현재 백엔드는 분석 목록을 영구 저장하지 않습니다.",
      ),
    );
  }

  const analysisSurface = document.querySelector(
    "#view-analyses .analysis-list-surface",
  );
  if (analysisSurface) {
    const panel = element("section", "panel");
    panel.append(
      element("h2", "", "현재 세션 분석"),
      element(
        "p",
        "",
        "분석 결과는 생성 후 60분 동안 현재 익명 세션에서만 조회할 수 있습니다.",
      ),
      element(
        "p",
        "muted",
        "목록 조회와 영구 저장은 아직 지원하지 않습니다. 저장됐다고 추측해 표시하지 않습니다.",
      ),
    );
    analysisSurface.replaceChildren(panel);
  }

  const profileRegion = document.querySelector("#profile-region");
  if (profileRegion) profileRegion.textContent = "저장된 기본 지역 없음";
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
    ".decision-flow",
    ".metric-strip",
    ".action-workspace",
    ".insight-grid",
    ".evidence-workspace",
  ].forEach((selector) => {
    const target = document.querySelector(selector);
    if (target) target.hidden = !visible;
  });
}

function updateLocationSearchAvailability() {
  searchLocationButton.disabled = !connected || regionInput.value.trim().length < 2;
}

function updateSubmitAvailability() {
  runAnalysisButton.disabled = !connected || !selectedCandidate;
  runAnalysisButton.textContent = selectedCandidate
    ? "이 조건으로 분석하기"
    : "주소 후보를 확인한 뒤 분석하기";
}

function clearSelectedCandidate(statusMessage = "") {
  selectedCandidate = null;
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
  if (visibleStep === "2" && wizardNextButton) {
    wizardNextButton.disabled = !selectedCandidate;
  }
}

function resetNewAnalysisState() {
  selectedCandidate = null;
  pendingAttempt = null;
  locationCandidates.hidden = true;
  locationCandidates.replaceChildren();
  setLocationStatus(
    connected
      ? "새 분석 지역을 입력한 뒤 주소 후보를 찾아 선택해 주세요."
      : "백엔드 연결을 기다리는 중입니다.",
  );
  updateLocationSearchAvailability();
  updateSubmitAvailability();
  syncWizardNextState();
}

function showContractError(error) {
  if (error.field === "region") {
    showRegionError(error.message);
    navigateToWizardStep(2);
    return;
  }
  if (error.field === "cultivation" || error.field === "crop") {
    showFieldError(
      error.field === "cultivation" ? "cultivation-error" : "crop-error",
      error.message,
    );
    navigateToWizardStep(3);
    return;
  }
  if (error.field === "season" || error.field === "growth") {
    showFieldError(
      error.field === "growth" ? "growth-error" : "season-error",
      error.message,
    );
    navigateToWizardStep(4);
    return;
  }
  showFieldError("situation-error", error.message);
  navigateToWizardStep(1);
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

function readFormValues() {
  return {
    situation: selectedRadioValue("situation"),
    crop: selectedRadioValue("crop"),
    cultivation: selectedRadioValue("cultivation"),
    season: selectedRadioValue("season"),
    growth: selectedRadioValue("growth"),
    saveConsent: document.querySelector("#save-consent")?.checked === true,
  };
}

function selectedRadioValue(name) {
  return form.querySelector(`input[name="${name}"]:checked`)?.value ?? "";
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
