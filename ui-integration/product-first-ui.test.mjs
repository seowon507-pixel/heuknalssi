import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function readProductUi() {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const names = await readdir(projectRoot);
  const uiName = names.find((name) => {
    const normalized = name.normalize("NFC");
    return (
      normalized.endsWith(".html") &&
      normalized.includes("UI_") &&
      normalized.includes("샘플")
    );
  });
  assert.ok(uiName, "제품 UI HTML을 찾을 수 있어야 합니다.");
  return readFile(path.join(projectRoot, uiName), "utf8");
}

async function readUiShell() {
  return readFile(path.join(import.meta.dirname, "ui-shell.mjs"), "utf8");
}

async function readDashboardCss() {
  return readFile(path.join(import.meta.dirname, "dashboard-workspace.css"), "utf8");
}

function visibleMarkup(html) {
  return html
    .replaceAll(/<style[\s\S]*?<\/style>/gi, "")
    .replaceAll(/<script[\s\S]*?<\/script>/gi, "");
}

test("첫 화면은 재배 중 생육 점검을 기본으로 하고 재배 전 분석은 예정 기능으로 구분한다", async () => {
  const html = await readProductUi();
  const markup = visibleMarkup(html);

  assert.match(markup, /분석할 위치와 목적을 선택해 주세요/);
  assert.match(
    markup,
    /name="situation" value="planning" disabled/,
  );
  assert.match(
    markup,
    /name="situation" value="growing" checked/,
  );
  assert.match(markup, /재배 전 환경 분석/);
  assert.match(markup, /추후 업데이트 예정/);
  assert.match(markup, /재배 중 생육 점검/);
  assert.match(markup, /현재 재배 중인 농장의 위치·작물·재배 환경과 생육 상태를 확인합니다/);
  assert.match(markup, /현재 위치 사용/);
  assert.match(markup, /시·도 이름을 입력하면 아래에 시·군·구 후보가 표시됩니다/);
  assert.match(markup, /입력한 지역 확인/);
  assert.match(markup, /role="combobox"/);
  assert.match(markup, /aria-autocomplete="list"/);
  assert.match(markup, /aria-controls="location-candidates"/);
  assert.match(html, /name="situation" value="growing"/);
  assert.doesNotMatch(markup, /이미 재배 중인 농가를 위한 오늘의 선제 점검/);
  assert.doesNotMatch(markup, /지금 농장 위치부터 확인할게요/);
  assert.doesNotMatch(markup, /가장 쉬운 방법/);
  assert.doesNotMatch(markup, /주소 후보 찾기/);
  assert.doesNotMatch(markup, /상세 주소를 잘 모르겠어요/);
});

test("현재 제품 범위와 재배 전 분석 예정 상태를 구현 문서에 명시한다", async () => {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const [readme, implementationPlan] = await Promise.all([
    readFile(path.join(projectRoot, "README.md"), "utf8"),
    readFile(
      path.join(projectRoot, "13_흙날씨진단_구현기준_기획서.md"),
      "utf8",
    ),
  ]);

  assert.match(readme, /현재 제공 범위는 재배 중 생육 점검/);
  assert.match(readme, /재배 전 환경 분석은 추후 업데이트 예정/);
  assert.match(implementationPlan, /현재 제품은 `재배 중 생육 점검`만 제공/);
  assert.match(implementationPlan, /재배 전 환경 분석.*추후 업데이트 예정/s);
});

test("직접 입력 주소는 행정구역 후보를 표시한 뒤 실제 위치 API로 확인한다", async () => {
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(client, /suggestAdministrativeAddresses/);
  assert.match(client, /ADDRESS_SUGGESTION_DELAY_MS = 180/);
  assert.match(client, /function queueAddressSuggestions/);
  assert.match(client, /function renderAdministrativeSuggestions/);
  assert.match(client, /searchLocations\(\{ autoSelectSingle: true \}\)/);
  assert.match(client, /event\.key === "ArrowDown"/);
  assert.match(client, /event\.key === "Escape"/);
  assert.match(client, /aria-expanded/);
});

test("온보딩은 복수 작물의 작기와 생육 상태를 사용자 확인값으로 받는다", async () => {
  const html = await readProductUi();
  const shell = await readUiShell();
  const markup = visibleMarkup(html);

  assert.equal(
    (markup.match(/type="checkbox" name="crop"/g) ?? []).length,
    5,
  );
  assert.match(markup, /작물별 재배 조건을 확인해 주세요/);
  assert.match(markup, /분석 날짜는 오늘로 자동 적용/);
  assert.match(shell, /장기 기후는 보류하고 가까운 예보만 확인/);
  assert.doesNotMatch(markup, /작물별 결과는 대시보드에서 바꿔 봅니다/);
  assert.doesNotMatch(markup, /검수된 연간 기준/);
  assert.match(markup, /id="growth-photo"[^>]*accept="image\/\*"/);
  assert.match(markup, /id="growth-settings"/);
  assert.match(shell, /function recommendedGrowthStage/);
  assert.match(shell, /`growth-\$\{crop\}`/);
  assert.match(shell, /날짜 기준 AI 예상/);
  assert.match(shell, /`season-\$\{crop\}`/);
  assert.match(shell, /cropGrowthState\[crop\] \|\| recommendation/);
  assert.match(shell, /function wizardRoute/);
  assert.match(shell, /\? \[1, 2, 3, 5\]/);
  assert.match(html, /id="review-growth-row"/);
  assert.match(shell, /초기 생육/);
  assert.match(shell, /한창 자라는 중/);
  assert.match(shell, /수확 무렵/);
  assert.match(shell, /잘 모름/);
  assert.match(
    markup,
    /id="run-analysis"[^>]*form="onboarding-form"[^>]*hidden/,
  );
});

test("현재 재배 분석은 작기를 명시적으로 선택하고 모르면 unknown으로 전달한다", async () => {
  const html = await readProductUi();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(html, /재배 조건/);
  assert.match(client, /selectedRadioValue\(`season-\$\{crop\}`\)/);
  assert.match(client, /\["apple", "pear"\].*"annual".*"unknown"/s);
});

test("완료한 농장 설정은 이 기기에 저장하고 다음 방문에 자동 복원한다", async () => {
  const html = await readProductUi();
  const shell = await readUiShell();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(html, /data-profile-state="checking"/);
  assert.match(html, /id="onboarding"[^>]*hidden/);
  assert.match(shell, /function hasSavedFarmProfile/);
  assert.match(shell, /function openSavedFarmDashboard/);
  assert.match(shell, /if \(hasSavedFarmProfile\(\)\) openSavedFarmDashboard\(\)/);
  assert.match(client, /writeStoredSession\(formValues/);
  assert.match(client, /if \(formValues\.saveConsent === true\)/);
  assert.match(client, /if \(!storage \|\| saveConsent\?\.checked !== true\) return/);
  assert.doesNotMatch(client, /rememberRegion\(candidate\.displayName\)/);
  assert.match(client, /const restored = await submitAnalysis\(\)/);
  assert.match(client, /if \(!restored\) throw new Error/);
  assert.match(client, /저장한 농장 정보를 갱신하지 못했습니다/);
  assert.match(client, /const FARMS_STORAGE_KEY = "heuknalssi\.farms\.v1"/);
  assert.match(client, /function renderFarmList/);
  assert.match(client, /function selectStoredFarm/);
  assert.match(client, /function startNewFarm/);
  assert.match(client, /if \(mobileFarmDialog\?\.open\) mobileFarmDialog\.close\(\)/);
  assert.match(client, /＋ 농장 추가/);
  assert.match(html, /id="mobile-farm-trigger"/);
  assert.match(html, /id="mobile-farm-dialog"/);
  assert.match(shell, /heuknalssi:open-new-farm/);
});

test("입력 중 위치 토큰이 만료되면 같은 확인 지역만 갱신해 분석을 한 번 재시도한다", async () => {
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(client, /refreshExpiredLocation = true/);
  assert.match(client, /candidate\.displayName === confirmedName/);
  assert.match(client, /submitAnalysis\(\{ refreshExpiredLocation: false \}\)/);
  assert.match(client, /matches\.length !== 1/);
});

test("농장 저장 ID를 행동·사진·위성 렌더링 전에 확정한다", async () => {
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );
  const submitStart = client.indexOf("async function submitAnalysis(");
  const submitEnd = client.indexOf("function collectUiAnalysisContexts", submitStart);
  const submit = client.slice(submitStart, submitEnd);
  assert.ok(submit.indexOf("writeStoredSession(formValues") > 0);
  assert.ok(submit.indexOf("renderAnalysis(currentAnalysis)") > 0);
  assert.ok(
    submit.indexOf("writeStoredSession(formValues") <
      submit.indexOf("renderAnalysis(currentAnalysis)"),
  );
});

test("생육점수는 백엔드 결과를 표시하고 세 축은 독립 값을 유지한다", async () => {
  const html = await readProductUi();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(client, /function renderDashboardWorkspace/);
  assert.match(html, /오늘의 농장 상태/);
  assert.match(client, /오늘 할 일을 불러오고 있습니다/);
  assert.match(client, /7일 작물 위험 변화/);
  assert.match(client, /setConnectionState\("hold", "부분 분석 가능"\)/);
  assert.match(client, /runtimeModeLabel\.textContent = "부분 분석 가능"/);
  assert.match(client, /serviceBanner\.hidden = false/);
  assert.doesNotMatch(client, /runtimeModeLabel\.textContent = ready \? "실시간 분석" : "분석 준비됨"/);
  const renderAnalysisStart = client.indexOf("function renderAnalysis(analysis)");
  const renderAnalysisEnd = client.indexOf("async function refreshActionPlan", renderAnalysisStart);
  const renderAnalysisBody = client.slice(renderAnalysisStart, renderAnalysisEnd);
  assert.match(renderAnalysisBody, /renderDashboardWorkspace\(analysis\)/);
  assert.doesNotMatch(
    renderAnalysisBody,
    /renderLiveOutlook|renderDecisionPanel|renderStateOverview|renderActionsAndReport/,
  );
  assert.match(client, /dashboard-state-badge/);
  assert.match(html, /data-dashboard-axis="climate"[\s\S]*?<dt>날씨<\/dt>/);
  assert.match(client, /function dashboardStatusIndicators/);
  assert.match(client, /function dashboardSoilIndicator/);
  assert.match(html, /data-dashboard-axis="soil"[\s\S]*?<dt>토양<\/dt>/);
  assert.match(html, /data-dashboard-axis="forecast"[\s\S]*?<dt>예보<\/dt>/);
  assert.match(client, /READY: "확인 완료"/);
  assert.doesNotMatch(client, /function dashboardStatusIndex\(status\)/);
  assert.match(client, /analysis\?\.growthScore/);
  assert.match(client, /`\$\{status\.score\}점`/);
  assert.match(client, /현재 작물 생육점수/);
  assert.doesNotMatch(client, /날씨 60%|calculateCropConditionScore/);
  assert.doesNotMatch(
    client,
    /\[\s*"\.overview-score",\s*"\.metric-strip"/,
  );
});

test("복수 작물 중 하나가 실패해도 완료된 분석은 보존한다", async () => {
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(client, /Promise\.allSettled/);
  assert.match(client, /if \(completed\.length === 0\) throw/);
  assert.match(client, /완료된 결과는 그대로 보존했습니다/);
});

test("일반 대시보드는 행동 중심이고 기술 정보는 마이페이지로 분리한다", async () => {
  const html = await readProductUi();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );
  const markup = visibleMarkup(html);

  assert.doesNotMatch(markup, /data-view="analyses"/);
  assert.doesNotMatch(markup, />내 분석</);
  assert.match(markup, /id="technical-analysis-settings"/);
  assert.match(markup, /분석 기준 및 데이터 출처/);
  const dashboard = html.match(
    /<section class="view" id="view-dashboard"[\s\S]*?<section class="view product-feature-view" id="view-crop-management"/,
  )?.[0] ?? "";
  assert.match(dashboard, /id="dashboard-workspace"/);
  assert.match(dashboard, /id="dashboard-action-list"/);
  assert.doesNotMatch(dashboard, /분석 기준 및 데이터 출처|backend-evidence-table/);
  assert.match(client, /function renderTechnicalSettings/);
  assert.match(client, /같은 농장 위치의 날씨 원자료는 모든 작물에 공통/);
  assert.match(client, /필지 토양검정값은 모든 작물에 동일/);
  assert.doesNotMatch(
    client.match(/function renderEvidenceDialog[\s\S]*?function renderTechnicalSettings/)?.[0] ?? "",
    /evidenceTable|sourceGrid|limitationList/,
  );
});

test("작물 관리와 병해충 정보는 대시보드 스크롤 링크가 아닌 독립 제품 화면이다", async () => {
  const html = await readProductUi();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(html, /data-view="crop-management">작물 관리<\/button>/);
  assert.match(html, /data-view="pest-alerts">병해충 경보/);
  assert.match(html, /id="view-crop-management"[^>]*data-view-panel="crop-management"/);
  assert.match(html, /id="view-pest-alerts"[^>]*data-view-panel="pest-alerts"/);
  assert.doesNotMatch(html, /data-dashboard-anchor="crop-management"/);
  assert.doesNotMatch(html, /data-dashboard-anchor="pest-alerts"/);
  assert.match(client, /function renderCropManagementView\(analysis\)/);
  assert.match(client, /function renderPestInformationView\(analysis,/);
  assert.match(client, /getPestGuidance\(analysisId\)/);
  assert.doesNotMatch(client, /PEST_OBSERVATION_PROFILES/);
  assert.match(html, /id="pest-source-link"/);
  assert.match(client, /기상 위험이 병해충 발생을 뜻하지는 않습니다/);
  assert.doesNotMatch(client, /희석배수|살포량|다이센엠/u);
});

test("저장된 농장의 조건 변경과 농장 추가는 첫 단계에서 돌아갈 수 있다", async () => {
  const shell = await readUiShell();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(shell, /wizardCanReturn = hasSavedFarmProfile\(\)/u);
  assert.match(
    shell,
    /previousButton\.textContent = isFirstStep && wizardCanReturn \? '돌아가기' : '이전'/u,
  );
  assert.match(shell, /if \(currentIndex === 0 && wizardCanReturn\)/u);
  assert.match(shell, /function closeWizard\(\)/u);
  assert.match(shell, /heuknalssi:wizard-cancelled/u);
  assert.match(client, /heuknalssi:wizard-cancelled/u);
  assert.match(
    client,
    /document\.addEventListener\("heuknalssi:wizard-cancelled", \(\) => \{\s*creatingNewFarm = false;\s*pendingAttempt = null;/u,
  );
});

test("무료 흙 검사는 추가 서비스로 분리하고 즉시 행동과 구분한다", async () => {
  const html = await readProductUi();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );
  const services = html.match(
    /<section class="view" id="view-services"[\s\S]*?<\/section>\s*<section class="view" id="view-mypage"/,
  )?.[0] ?? "";
  const mypage = html.match(
    /<section class="view" id="view-mypage"[\s\S]*?<\/main>/,
  )?.[0] ?? "";

  assert.match(html, /data-view="services">추가 서비스/);
  assert.match(services, /흙 검사 무료로 받는 방법/);
  assert.doesNotMatch(mypage, /흙 검사 무료로 받는 방법/);
  assert.match(client, /오늘 바로 할 일/);
  assert.match(client, /정확도를 높이는 방법/);
  assert.match(client, /import \{ hasMissingSoilExamHistory \}/);
  assert.match(client, /토양검정 이력 없음/);
  assert.match(client, /무료 토양검정 받으러 가기/);
  assert.match(client, /detail: \{ targetId: "soil-exam-title" \}/);
  assert.doesNotMatch(client, /무료 흙 검사 안내 보기/);
  assert.match(
    client,
    /action\?\.actionId !== "REQUEST_FIELD_SOIL_TEST"/,
  );
});

test("농장 분석 도우미는 데스크톱 패널과 모바일 전체 화면으로 제공된다", async () => {
  const html = await readProductUi();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(html, /id="assistant-launcher"/);
  assert.match(html, /id="assistant-panel"/);
  assert.match(html, /width: clamp\(320px, 20vw, 380px\)/);
  assert.match(html, /height: clamp\(510px, 51vh, 660px\)/);
  assert.match(html, /max-height: calc\(100dvh - 128px\)/);
  assert.match(html, /width: 100vw/);
  assert.match(html, /height: 100dvh/);
  assert.match(client, /async askAssistant\(analysisId, question\)/);
  assert.match(client, /function submitAssistantQuestion/);
  assert.match(client, /현재 분석 근거를 확인하고 있습니다/);
});

test("예보 시각화는 최고기온·강수확률·날짜별 작물 위험을 한 축으로 보여준다", async () => {
  const html = await readProductUi();
  const css = await readDashboardCss();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(client, /temperatureRangeChart\(days, threshold\)/);
  assert.match(client, /precipitation-probability-line/);
  assert.match(client, /forecastRiskLevelRow\(days, risks, analysis\)/);
  assert.match(client, /FAVORABLE: \{ className: "favorable", label: "양호" \}/);
  assert.match(client, /NORMAL: \{ className: "normal", label: "보통" \}/);
  assert.match(client, /risk-threshold-line/);
  assert.match(html, /id="dashboard-forecast-chart"/);
  assert.match(html, /id="dashboard-priority-action"/);
  assert.match(css, /#dashboard-forecast-chart \.forecast-temperature-chart/);
  assert.match(css, /\.forecast-risk-chip/);
  assert.match(css, /\.is-favorable \.forecast-risk-chip/);
  assert.match(css, /\.is-normal \.forecast-risk-chip/);
  assert.match(css, /\.dashboard-priority-action h3/);
});

test("행동과 주간 위험은 중복·모호한 날짜·과거 기한을 사용자 문구로 정리한다", async () => {
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(client, /filterWeeklyRisksForOpenAction/);
  assert.match(client, /오늘 할 일 외 추가 주의 없음/);
  assert.match(client, /formatExplicitForecastDate/);
  assert.match(client, /formatActionDueLabelForAction\(/);
  assert.match(client, /actionHasForecastRisk\(action, analysis\)/);
  assert.match(client, /forecastRiskCause\(analysis, action\)/);
  assert.match(client, /composeForecastActionReason\(cause, reason\)/);
});

test("목표 대시보드 조작은 실제 저장·가이드·기능 화면으로 연결된다", async () => {
  const html = await readProductUi();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );
  const markup = visibleMarkup(html);

  assert.match(markup, /id="dashboard-complete-all"/);
  assert.match(markup, /id="dashboard-all-actions"[^>]*aria-expanded="false"/);
  assert.match(markup, /id="dashboard-photo-check"/);
  assert.doesNotMatch(markup, /data-dashboard-anchor=/);
  assert.match(markup, /data-view="services">기록 &amp; 리포트/);
  assert.match(markup, /id="satellite-service-panel"/);
  assert.match(markup, /data-service-anchor="photo-journal-panel"/);
  assert.match(markup, /data-open-dialog="weather"/);
  assert.match(markup, /data-open-dialog="soil"/);
  assert.doesNotMatch(markup, /aria-label="주의 3건"/);

  assert.match(client, /async function completeAllOpenActions/);
  assert.match(client, /for \(const action of openActions\)/);
  assert.match(client, /await api\.updateAction\(scope\.farmId, action\.actionId, "DONE"/);
  assert.match(client, /저장하지 못한 \$\{failures\.length\}개는 그대로 남겨 두었습니다/);
  assert.match(client, /function toggleFullActionPlan/);
  assert.match(client, /switcher\.hidden = analyses\.length === 0/);
  assert.doesNotMatch(client, /function updateRiskNavigation/);
  assert.match(client, /guideButton\.addEventListener\("click", \(\) => openEvidenceDialog\("weather"\)\)/);
  assert.match(client, /currentActionPlan = plan/);
});

test("상태 상세는 선택한 날씨·토양 영역으로 이동하고 기술 규칙을 대시보드에 노출하지 않는다", async () => {
  const shell = await readUiShell();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(shell, /data-guide-section/);
  assert.match(
    client,
    /conditionFactCard\("날씨", weather, "weather", \{ hideCaveat: regional \}\)/,
  );
  assert.match(
    client,
    /conditionFactCard\("농장 토양", soil, "soil", \{ hideCaveat: regional \}\)/,
  );
  assert.match(client, /actionBox\.dataset\.guideSection = "summary"/);
  assert.match(client, /function openEvidenceDialog\(section = "summary"\)/);
});

test("시군구 위치는 지역 참고 분석을 한 번만 알리고 확보된 값을 완료 결과로 표시한다", async () => {
  const html = await readProductUi();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(html, /id="dashboard-scope-label"[^>]*hidden>지역 참고 분석<\/span>/);
  assert.equal((html.match(/>지역 참고 분석<\/span>/g) ?? []).length, 1);
  assert.match(client, /function hasRegionalReferenceCoverage/);
  assert.match(client, /label: "지역 기준 양호"/);
  assert.match(client, /label: "지역 기준 완료"/);
  assert.match(client, /label: "분석 완료"/);
  assert.match(client, /analysis\.dataSources\.filter\(sourceUsedInAnalysis\)/);
  assert.match(client, /지역 예보와 지역 토양 통계를 기준으로 현재 적용할 주의 신호와 행동을 분석했습니다/);
  assert.match(client, /actionRelevantForDisplay\(action, analysis\)/);
});

test("행동 유형별 원인과 NOW 기한, 주간 위험 압축을 서로 섞지 않는다", async () => {
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(client, /action\?\.actionId === "CONFIRM_SEASON"/);
  assert.match(client, /재배 시기와 생육 단계가 확인되지 않아/);
  assert.match(client, /재배 시기와 현재 생육 단계를 확인한 뒤 다시 분석/);
  assert.match(client, /formatActionDueLabelForAction/);
  assert.match(client, /label === "지금 확인" \|\| label\.startsWith\("지연됨"\)/);
  assert.match(client, /groupWeeklyRiskRanges/);
  assert.match(client, /composeForecastActionReason/);
  const weekly = client.slice(
    client.indexOf("function renderDashboardWeeklyRisks"),
    client.indexOf("function renderDashboardSoil"),
  );
  assert.doesNotMatch(weekly, /slice\(0, 2\)/);
});

test("결과 첫 화면은 실제 예보 배열을 가까운 예보 시각 자료로 렌더링한다", async () => {
  const html = await readProductUi();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(html, /id="dashboard-risk-timeline"/);
  assert.match(html, /id="dashboard-forecast-chart"/);
  assert.match(client, /function renderDashboardRiskTimeline/);
  assert.match(client, /temperatureRangeChart\(days, threshold\)/);
  assert.match(client, /mergedDisplayDays/);
  assert.match(client, /slice\(0, 7\)/);
  assert.match(client, /7일 작물 위험 변화/);
});

test("예보가 있으면 대기 문구 대신 검수된 사용자 행동과 입력 조건을 표시한다", async () => {
  const html = await readProductUi();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.doesNotMatch(
    client,
    /예보가 준비되면 오늘 점검 항목을 표시합니다/,
  );
  assert.match(client, /function resolveDisplayAction/);
  assert.match(client, /function activeForecastRisks/);
  assert.match(client, /function forecastRiskGuide/);
  assert.match(client, /function soilConditionGuide/);
  assert.match(client, /function combinedGuideSummary/);
  assert.match(client, /function renderFarmConditionGuide/);
  assert.match(client, /왜 주의해야 하나요/);
  assert.match(client, /오늘 바로 할 일/);
  assert.match(client, /농장 토양/);
  assert.match(
    client,
    /const landUse = \["APPLE", "PEAR"\]\.includes\(crop\) \? "과수원" : "밭"/,
  );
  assert.match(client, /analysis\?\.inputSummary\?\.regionLabel\?\.trim\(\)/);
  assert.match(client, /\$\{region \? `\$\{region\} ` : ""\}\$\{landUse\} 지역 pH 통계/);
  assert.match(client, /이 작물의 pH 적정 범위와 비교했습니다/);
  assert.match(client, /summarizeForecastEvaluation/);
  assert.doesNotMatch(client, /작물별 위험 판정 확인 필요/);
  assert.match(client, /지역 토양 분포를 함께 반영했습니다/);
  assert.match(client, /실제 밭의 토양검정 결과에서 pH와 EC를 확인합니다/);
  assert.match(client, /가까운 농업기술센터에 토양검정을 신청합니다/);
  assert.match(client, /지역 통계는 실제 밭의 측정값이 아닙니다/);
  assert.doesNotMatch(client, /주의 예보 날짜 확인/);
  assert.match(client, /시설 내부 온도 센서와 환기 상태 확인/);
  assert.match(client, /function collectUiAnalysisContexts/);
  assert.match(client, /재배 환경/);
  assert.match(client, /생육 상태/);
  assert.match(client, /단기 예보/);
  assert.match(client, /중기 예보/);
  assert.match(html, /\.summary-context-list/);
});

test("SmartFarm은 현재 제품 범위에서 비활성화되어 노출되지 않는다", async () => {
  const html = await readProductUi();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(
    html,
    /id="smartfarm-reference-panel"[^>]*hidden/,
  );
  assert.match(client, /function renderSmartfarmReference/);
  assert.match(client, /const module = null;/);
  assert.match(client, /smartfarmAvailable: false/);
});

test("모바일 첫 화면은 가까운 예보보다 오늘의 점검 항목을 먼저 보여준다", async () => {
  const html = await readProductUi();
  const css = await readDashboardCss();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(html, /id="dashboard-action-list"/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /\.dashboard-overview-grid,\s*\n\s*\.dashboard-content-grid \{\s*\n\s*display: contents;/);
  assert.match(css, /\.dashboard-actions \{\s*\n\s*order: 2;/);
  assert.match(css, /\.dashboard-risk-timeline \{\s*\n\s*order: 3;/);
  assert.match(css, /\.dashboard-axis-list \{\s*\n\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.dashboard-axis-list span \{\s*\n\s*display: none;/);
  assert.match(html, /data-dashboard-axis="climate"/);
  assert.match(html, /data-dashboard-axis="soil"/);
});

test("본문과 주요 조작 요소는 고령 사용자를 위한 최소 크기를 지킨다", async () => {
  const html = await readProductUi();
  const css = await readDashboardCss();

  assert.match(html, /html \{[^}]*font-size: 18px;/);
  assert.match(html, /button, input, select \{ min-height: 52px; \}/);
  assert.match(html, /\.button \{ min-height: 44px;/);
  assert.match(html, /\.crop-result-switcher button \{ min-height: 44px;/);
  assert.match(css, /\.dashboard-text-button \{[\s\S]*?min-height: 48px;/);
  assert.match(css, /#dashboard-action-list \.action-plan__controls button \{[\s\S]*?min-height: 48px;/);
  assert.match(css, /\.dashboard-priority-action p,[\s\S]*?font-size: 18px;/);
  assert.doesNotMatch(html, /\.button \{ min-height: 4[0-3]px;/);
});

test("제품 화면은 검증되지 않은 종합점수와 가짜 알림을 노출하지 않는다", async () => {
  const markup = visibleMarkup(await readProductUi());

  assert.doesNotMatch(markup, /55%와 45%|반영 55%|반영 45%|62\/100|참고지수 62점/);
  assert.doesNotMatch(markup, /나중에 알림/);
  assert.match(markup, /id="dashboard-action-list"/);
  assert.match(markup, /오늘 할 일/);
  // 알림은 이제 실제 기능이다. 켜진 척하는 스위치 대신 권한을 직접 요청하고
  // 서비스워커로 발송하는 경로가 있어야 한다.
  assert.doesNotMatch(markup, /알림 설정 <span class="status-label">준비 중<\/span>/);
  assert.match(markup, /id="notification-enable"/);
  assert.match(markup, /id="notification-test"/);
  assert.match(markup, /id="notification-time"[^>]*type="time"/);
});

test("알림은 서비스워커와 매니페스트를 갖춘 실제 경로로만 발송된다", async () => {
  const markup = await readProductUi();
  assert.match(markup, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(markup, /rel="apple-touch-icon"/);

  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );
  assert.match(client, /navigator\.serviceWorker\s*\n?\s*\.register\("\/sw\.js"/);
  assert.match(client, /Notification\.requestPermission\(\)/);
  assert.match(
    client,
    /!notificationsSupported\(\)[\s\S]*?Notification\.permission/u,
  );
  assert.doesNotMatch(client, /Notification\?\./u);
  // 분석에서 뽑은 문구만 쓰고, 없으면 지어내지 않는다.
  assert.match(client, /if \(!headline\) return;/);

  const worker = await readFile(
    path.join(import.meta.dirname, "sw.js"),
    "utf8",
  );
  assert.match(worker, /showNotification/);
  assert.match(worker, /notificationclick/);
});

test("백엔드 결과는 primary action과 사용자용 자동 설명을 사용한다", async () => {
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(client, /function primaryDisplayAction/);
  assert.match(client, /function renderDashboardPriorityAction/);
  assert.match(client, /dashboard-priority-action/);
  assert.match(client, /이유와 근거 보기/);
  assert.match(client, /projectAnalysisAction/);
  assert.match(client, /function renderSummaryPanel[\s\S]*?if \(!panel\) return;/);
  assert.match(client, /function farmStatusSummary[\s\S]*?const primary = primaryDisplayAction\(analysis\);/);
  assert.match(client, /primary\.actionId === "CONFIRM_SEASON" \? "확인 필요" : "점검 필요"/);
  assert.match(client, /분석 요약/);
  assert.match(client, /예보를 다시 확인해 주세요/);
  assert.match(client, /최신 자료만 다시 불러옵니다/);
  assert.match(client, /!\["READY", "PARTIAL"\]\.includes\(module\.state\)/);
  assert.match(client, /automatic: true/);
  assert.match(client, /POST \/api\/locations\/current|\/api\/locations\/current/);
  assert.match(client, /buildAnalysisRequests/);
  assert.match(client, /visibleStep === "1"[\s\S]*!selectedCandidate/);
  assert.match(client, /재배 시기를 선택하지 않아 시기별 기후 위험은 판단하지 않았습니다/);
  assert.match(client, /최근 관측자료가 검수한 형식과 맞지 않아 판단에 사용하지 않았습니다/);
  assert.doesNotMatch(client, /보고서 만들기/);
});

test("배포 빌드는 브라우저에서 import하는 제품 기능 모듈을 모두 포함한다", async () => {
  const buildScript = await readFile(
    path.join(import.meta.dirname, "..", "scripts", "build-vercel.mjs"),
    "utf8",
  );

  for (const asset of [
    "action-plan.mjs",
    "action-projection.mjs",
    "assistant-action-request.mjs",
    "local-photo-journal.mjs",
    "dashboard-workspace.css",
  ]) {
    assert.match(buildScript, new RegExp(`"${asset.replaceAll(".", "\\.")}"`));
  }
});

test("위성 연결이 비활성이면 필지 조작을 잠그고 준비 필요 상태를 알린다", async () => {
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(client, /"READY", "CONFIGURED_UNVERIFIED"/);
  assert.match(client, /연결 준비 필요/);
  assert.match(client, /현재 실행 환경에는 위성 데이터 연결이 설정되지 않았습니다/);
  assert.match(client, /#parcel-use-location/);
});
