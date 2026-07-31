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

test("온보딩은 복수 작물과 작물별 생육 상태를 날짜 추천값으로 제공한다", async () => {
  const html = await readProductUi();
  const shell = await readUiShell();
  const markup = visibleMarkup(html);

  assert.equal(
    (markup.match(/type="checkbox" name="crop"/g) ?? []).length,
    5,
  );
  assert.match(markup, /작물별 재배 조건을 확인해 주세요/);
  assert.match(markup, /분석 날짜는 오늘로 자동 적용/);
  assert.match(shell, /날짜 기준 AI 예상/);
  assert.doesNotMatch(markup, /작물별 결과는 대시보드에서 바꿔 봅니다/);
  assert.doesNotMatch(markup, /검수된 연간 기준/);
  assert.match(markup, /id="growth-photo"[^>]*accept="image\/\*"/);
  assert.match(markup, /id="growth-settings"/);
  assert.match(shell, /function recommendedGrowthStage/);
  assert.match(shell, /`growth-\$\{crop\}`/);
  assert.match(shell, /날짜 기준 AI 예상/);
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

test("현재 재배 분석은 계절을 다시 묻지 않고 기기 월을 계약에 전달한다", async () => {
  const html = await readProductUi();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.doesNotMatch(html, /const seasonDefinitions =/);
  assert.match(client, /analysisMonth:\s*new Date\(\)\.getMonth\(\) \+ 1/);
  assert.match(client, /season:\s*"current"/);
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
  assert.match(client, /const restored = await submitAnalysis\(\)/);
  assert.match(client, /if \(!restored\) throw new Error/);
  assert.match(client, /저장한 농장 정보를 갱신하지 못했습니다/);
  assert.match(client, /const FARMS_STORAGE_KEY = "heuknalssi\.farms\.v1"/);
  assert.match(client, /function renderFarmList/);
  assert.match(client, /function selectStoredFarm/);
  assert.match(client, /function startNewFarm/);
  assert.match(client, /＋ 농장 추가/);
  assert.match(shell, /heuknalssi:open-new-farm/);
});

test("생육점수는 자료 충족률이 아니라 작물별 날씨·토양 상태를 표시한다", async () => {
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(client, /오늘 먼저 볼 것/);
  assert.match(client, /이번 주 예보/);
  assert.match(client, /오늘의 점검 항목/);
  assert.match(client, /setConnectionState\("hold", "부분 분석 가능"\)/);
  assert.match(client, /runtimeModeLabel\.textContent = "부분 분석 가능"/);
  assert.match(client, /serviceBanner\.hidden = false/);
  assert.doesNotMatch(client, /runtimeModeLabel\.textContent = ready \? "실시간 분석" : "분석 준비됨"/);
  assert.match(client, /renderStateOverview\(analysis\)/);
  assert.match(client, /current-state-ring/);
  assert.match(client, /오늘의 작물 상태/);
  assert.match(client, /생육점수/);
  assert.match(client, /기후 적합/);
  assert.match(client, /토양 적합/);
  // 예보 위험은 적합도 점수에 섞지 않고 별도 축으로만 보여 준다.
  assert.match(client, /가까운 위험/);
  assert.match(client, /예보 위험은 점수에 섞지 않고 따로 표시합니다/);
  assert.doesNotMatch(client, /날씨 60% · 토양 40%/);
  assert.match(client, /calculateCropConditionScore/);
  // 할 일 목록은 상위 3건이 아니라 기한별 전체를 보여 주고, 항목마다
  // 근거를 붙이며, 저장 실패 시 체크를 되돌린다.
  assert.match(client, /function renderTaskList/);
  assert.match(client, /analysis\.taskList/);
  assert.match(client, /DUE_WINDOW_ORDER/);
  assert.match(client, /function taskEvidence/);
  assert.match(client, /checkbox\.checked = !checkbox\.checked/);
  assert.match(client, /완료 기록을 저장하지 못했습니다/);
  // 챗봇: 음성 입출력은 브라우저 내장 기능만 쓰고, 근거를 펼쳐 볼 수 있으며,
  // 다시 쓴 답이 검증에서 걸리면 그 사실을 숨기지 않는다.
  assert.match(client, /webkitSpeechRecognition/);
  assert.match(client, /lang = "ko-KR"/);
  assert.match(client, /speechSynthesis/);
  assert.match(client, /이 답변의 근거 \$\{evidence\.length\}개/);
  assert.match(client, /검증을 통과하지 못해 버렸습니다/);
  assert.doesNotMatch(client, /cdn\.jsdelivr\.net\/npm\/.*speech/i);
  // 생육 기록: 사진은 기기 안에서만 처리하고, 사진으로 진단하지 않는다.
  assert.match(client, /function renderGrowthTimeline/);
  assert.match(client, /readGreenCoverFromFile/);
  assert.match(client, /summarizeSeason/);
  assert.match(client, /서버로 보내지 않습니다/);
  assert.match(client, /생육량이나 수확량이 아니며, 병해 진단도 하지 않습니다/);
  // 사진을 업로드하거나 비전 모델에 넘기는 경로가 없어야 한다.
  assert.doesNotMatch(client, /photo[^\n]*FormData/i);
  assert.doesNotMatch(client, /generativelanguage[^\n]*image/i);
  assert.doesNotMatch(client, /자료 확인 점수/);
  assert.doesNotMatch(client, /환경 기준 예상 점수/);
  assert.doesNotMatch(client, /작물별 위험 판정 확인 필요/);
  assert.doesNotMatch(
    client,
    /\[\s*"\.overview-score",\s*"\.metric-strip"/,
  );
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
  assert.match(html, /class="evidence-workspace"[^>]*hidden/);
  assert.match(client, /function renderTechnicalSettings/);
  assert.match(client, /같은 농장 위치의 날씨 원자료는 모든 작물에 공통/);
  assert.match(client, /필지 토양검정값은 모든 작물에 동일/);
  assert.doesNotMatch(
    client.match(/function renderEvidenceDialog[\s\S]*?function renderTechnicalSettings/)?.[0] ?? "",
    /evidenceTable|sourceGrid|limitationList/,
  );
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

test("예보 시각화는 최고·최저기온과 강수 가능성을 함께 보여준다", async () => {
  const html = await readProductUi();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(client, /temperatureRangeChart\(days, threshold\)/);
  assert.match(client, /temperature-band/);
  assert.match(client, /precipitation-bar/);
  assert.match(client, /risk-threshold-line/);
  assert.match(html, /forecast-chart-legend/);
  assert.match(html, /action-priority-card/);
  assert.match(html, /font-size: 17px/);
});

test("결과 첫 화면은 실제 예보 배열을 가까운 예보 시각 자료로 렌더링한다", async () => {
  const html = await readProductUi();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(html, /id="live-outlook"/);
  assert.match(html, /forecast-temperature-chart/);
  assert.match(client, /function renderLiveOutlook/);
  assert.match(client, /mergedDisplayDays/);
  assert.match(client, /slice\(0, 7\)/);
  assert.match(client, /기상청 단기·중기 예보/);
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
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(
    html,
    /@media \(max-width: 620px\)[\s\S]*?\.live-action-card \{[\s\S]*?order: -1;/,
  );
  assert.match(
    html,
    /@media \(max-width: 620px\)[\s\S]*?\.live-action-visual \{ display: none; \}/,
  );
  assert.match(client, /aria-label", "날씨와 토양 상태"/);
  assert.match(client, /actionConditionSummary\("날씨"/);
  assert.match(client, /actionConditionSummary\("토양"/);
});

test("본문과 주요 조작 요소는 고령 사용자를 위한 최소 크기를 지킨다", async () => {
  const html = await readProductUi();

  assert.match(html, /html \{[^}]*font-size: 18px;/);
  assert.match(html, /button, input, select \{ min-height: 52px; \}/);
  assert.match(html, /\.button \{ min-height: 44px;/);
  assert.match(html, /\.crop-result-switcher button \{ min-height: 44px;/);
  assert.match(html, /\.live-action-button \{[\s\S]*?min-height: 44px;/);
  assert.doesNotMatch(html, /\.button \{ min-height: 4[0-3]px;/);
});

test("제품 화면은 검증되지 않은 종합점수와 가짜 알림을 노출하지 않는다", async () => {
  const markup = visibleMarkup(await readProductUi());

  assert.doesNotMatch(markup, /55%와 45%|반영 55%|반영 45%|62\/100|참고지수 62점/);
  assert.doesNotMatch(markup, /나중에 알림/);
  assert.match(markup, /이번 화면에서 나중에 보기/);
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
  assert.match(client, /우선 조치/);
  assert.match(client, /분석 요약/);
  assert.match(client, /현재 예보를 불러오지 못했습니다/);
  assert.match(client, /예보 다시 불러오기/);
  assert.match(client, /!\["READY", "PARTIAL"\]\.includes\(module\.state\)/);
  assert.match(client, /automatic: true/);
  assert.match(client, /POST \/api\/locations\/current|\/api\/locations\/current/);
  assert.match(client, /buildAnalysisRequests/);
  assert.match(client, /visibleStep === "1"[\s\S]*!selectedCandidate/);
  assert.match(client, /재배 시기를 선택하지 않아 시기별 기후 위험은 판단하지 않았습니다/);
  assert.match(client, /최근 관측자료가 검수한 형식과 맞지 않아 판단에 사용하지 않았습니다/);
  assert.doesNotMatch(client, /보고서 만들기/);
});
