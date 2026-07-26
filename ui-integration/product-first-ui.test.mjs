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

function visibleMarkup(html) {
  return html
    .replaceAll(/<style[\s\S]*?<\/style>/gi, "")
    .replaceAll(/<script[\s\S]*?<\/script>/gi, "");
}

test("첫 화면은 LAND_SEARCH를 기본값으로 두고 ACTIVE_GROWING을 분리한다", async () => {
  const html = await readProductUi();
  const markup = visibleMarkup(html);

  assert.match(markup, /분석할 위치와 목적을 선택해 주세요/);
  assert.match(
    markup,
    /name="situation" value="planning" checked/,
  );
  assert.match(markup, /농사를 시작할 곳 알아보기/);
  assert.match(markup, /이미 재배 중인 농장 점검/);
  assert.match(markup, /현재 위치 사용/);
  assert.match(markup, /상세 주소를 몰라도 시·군·구까지만 입력할 수 있습니다/);
  assert.match(markup, /입력한 지역 확인/);
  assert.match(html, /name="situation" value="growing"/);
  assert.doesNotMatch(markup, /이미 재배 중인 농가를 위한 오늘의 선제 점검/);
  assert.doesNotMatch(markup, /지금 농장 위치부터 확인할게요/);
  assert.doesNotMatch(markup, /가장 쉬운 방법/);
  assert.doesNotMatch(markup, /주소 후보 찾기/);
  assert.doesNotMatch(markup, /상세 주소를 잘 모르겠어요/);
});

test("온보딩은 복수 작물과 작물별 생육 상태를 날짜 추천값으로 제공한다", async () => {
  const html = await readProductUi();
  const markup = visibleMarkup(html);

  assert.equal(
    (markup.match(/type="checkbox" name="crop"/g) ?? []).length,
    5,
  );
  assert.match(markup, /작물별 재배 조건을 확인해 주세요/);
  assert.match(markup, /분석 날짜는 오늘로 자동 적용/);
  assert.match(html, /날짜 기준 AI 예상/);
  assert.doesNotMatch(markup, /작물별 결과는 대시보드에서 바꿔 봅니다/);
  assert.doesNotMatch(markup, /검수된 연간 기준/);
  assert.match(markup, /id="growth-photo"[^>]*accept="image\/\*"/);
  assert.match(markup, /id="growth-settings"/);
  assert.match(html, /function recommendedGrowthStage/);
  assert.match(html, /`growth-\$\{crop\}`/);
  assert.match(html, /날짜 기준 AI 예상/);
  assert.match(html, /function wizardRoute/);
  assert.match(html, /\? \[1, 2, 3, 5\]/);
  assert.match(html, /id="review-growth-row"/);
  assert.match(html, /초기 생육/);
  assert.match(html, /한창 자라는 중/);
  assert.match(html, /수확 무렵/);
  assert.match(html, /잘 모름/);
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

test("HOLD 상태는 부분 분석으로 정직하게 표시한다", async () => {
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
  assert.doesNotMatch(
    client,
    /\[\s*"\.overview-score",\s*"\.metric-strip"/,
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
  assert.match(html, /height: clamp\(340px, 34vh, 440px\)/);
  assert.match(html, /width: 100vw/);
  assert.match(html, /height: 100dvh/);
  assert.match(client, /async askAssistant\(analysisId, question\)/);
  assert.match(client, /function submitAssistantQuestion/);
  assert.match(client, /현재 분석 근거를 확인하고 있습니다/);
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
  assert.match(client, /개발 샘플 예보/);
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
  assert.match(client, /필요한 행동/);
  assert.match(client, /농장 토양/);
  assert.match(client, /지역 토양 통계에서 작물 pH 기준과 겹치는 면적/);
  assert.match(client, /지역 토양 분포를 함께 반영했습니다/);
  assert.match(client, /실제 밭의 토양검정 결과에서 pH와 EC를 확인합니다/);
  assert.match(client, /가까운 농업기술센터에 토양검정을 신청합니다/);
  assert.match(client, /지역 통계는 실제 밭의 측정값이 아닙니다/);
  assert.doesNotMatch(client, /주의 예보 날짜 확인/);
  assert.match(client, /시설 내부 온도 센서와 환기 상태 확인/);
  assert.match(client, /function collectUiAnalysisContexts/);
  assert.match(client, /재배 환경/);
  assert.match(client, /생육 상태/);
  assert.match(client, /오늘~3일 예보/);
  assert.match(html, /\.summary-context-list/);
});

test("SmartFarm 공개자료는 별도 비교 패널이며 판단과 점수에 반영하지 않는다", async () => {
  const html = await readProductUi();
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(html, /id="smartfarm-reference-panel"/);
  assert.match(client, /function renderSmartfarmReference/);
  assert.match(client, /동종 작물 공개자료 비교/);
  assert.match(client, /개발 샘플 비교/);
  assert.match(client, /적합도·위험 판단·점수에 반영하지 않음/);
  assert.match(client, /다른 농가의 환경값은 내 농장의 센서값이나 공식 적정 기준이 아닙니다/);
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
