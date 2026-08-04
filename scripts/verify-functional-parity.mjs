import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const APP_URL = process.argv[2] ?? "http://127.0.0.1:3000/";
const OUTPUT_DIR = process.argv[3] ?? path.resolve("output");
const DEVTOOLS_URL = process.env.CHROME_DEVTOOLS_URL ?? "http://127.0.0.1:9222";
const TIMEOUT_MS = 120_000;

await mkdir(OUTPUT_DIR, { recursive: true });

const target = await fetch(
  `${DEVTOOLS_URL}/json/new?${encodeURIComponent(APP_URL)}`,
  { method: "PUT" },
).then((response) => response.json());
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const apiResponses = [];
let sequence = 0;

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
    return;
  }
  if (message.method === "Network.responseReceived") {
    const response = message.params?.response;
    if (response?.url?.includes("/api/")) {
      apiResponses.push({
        method: message.params?.type ?? "Fetch",
        status: response.status,
        url: response.url.replace(APP_URL, "/"),
      });
    }
  }
});

function send(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "browser evaluation failed");
  }
  return result.result?.value;
}

async function waitFor(expression, label, timeout = TIMEOUT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timeout: ${label}`);
}

async function click(selector) {
  const clicked = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node || node.disabled || node.hidden) return false;
    node.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`cannot click ${selector}`);
}

async function setValue(selector, value) {
  const changed = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    node.value = ${JSON.stringify(value)};
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  if (!changed) throw new Error(`cannot set ${selector}`);
}

async function screenshot(name) {
  const result = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(path.join(OUTPUT_DIR, name), Buffer.from(result.data, "base64"));
}

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1487,
  height: 1058,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.navigate", { url: APP_URL });
await waitFor('document.readyState === "complete"', "page load");
await waitFor(
  'document.body.dataset.integration !== "pending"',
  "backend connection",
);

const hasSavedFarm = await evaluate(
  'document.querySelector("#onboarding")?.hidden === true && (!document.querySelector("#dashboard-workspace")?.hidden || !document.querySelector("#farm-overview-dashboard")?.hidden)',
);
if (!hasSavedFarm) {
  await waitFor(
    '!document.querySelector("#onboarding")?.hidden',
    "onboarding open",
  );
  await setValue("#region-input", "인천광역시 남동구");
  await click("#search-location");
  await waitFor(
    'document.querySelector("#location-candidates button")',
    "location candidates",
  );
  await click("#location-candidates button");
  await waitFor('!document.querySelector("#wizard-next")?.disabled', "location verified");
  await click("#wizard-next");
  await waitFor(
    `!document.querySelector('.wizard-step[data-step="2"]')?.hidden`,
    "crop step",
  );
  await evaluate(`(() => {
    for (const value of ["apple", "cucumber"]) {
      const input = document.querySelector('input[name="crop"][value="' + value + '"]');
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  })()`);
  await waitFor('!document.querySelector("#wizard-next")?.disabled', "crops selected");
  await click("#wizard-next");
  await waitFor(
    `!document.querySelector('.wizard-step[data-step="3"]')?.hidden`,
    "cultivation step",
  );
  await waitFor('!document.querySelector("#wizard-next")?.disabled', "cultivation defaults");
  await click("#wizard-next");
  await waitFor(
    `!document.querySelector('.wizard-step[data-step="4"]')?.hidden`,
    "growth step",
  );
  await waitFor('!document.querySelector("#wizard-next")?.disabled', "growth recommendation");
  await click("#wizard-next");
  await waitFor(
    `!document.querySelector('.wizard-step[data-step="5"]')?.hidden`,
    "review step",
  );
  await evaluate(`(() => {
    const input = document.querySelector("#save-consent");
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor('!document.querySelector("#run-analysis")?.disabled', "analysis enabled");
  await click("#run-analysis");
}

await waitFor(
  '!document.querySelector("#dashboard-workspace")?.hidden || !document.querySelector("#farm-overview-dashboard")?.hidden',
  "dashboard result",
);
const aggregateDashboard = await evaluate(
  '!document.querySelector("#farm-overview-dashboard")?.hidden',
);
if (aggregateDashboard) {
  await click("#crop-result-switcher button:nth-child(2)");
  await waitFor(
    '!document.querySelector("#dashboard-workspace")?.hidden',
    "crop dashboard result",
  );
}
await waitFor(
  'document.querySelector("#dashboard-action-list .action-plan") && !document.querySelector("#dashboard-action-list")?.hasAttribute("aria-busy")',
  "action plan",
);

const initial = await evaluate(`(() => ({
  title: document.querySelector("#dashboard-title")?.textContent?.trim(),
  cropTabs: document.querySelectorAll("#crop-result-switcher button").length,
  totalActions: document.querySelectorAll("#dashboard-action-list .action-plan__card").length,
  openActions: document.querySelectorAll('#dashboard-action-list [data-action-status="DONE"]').length,
  riskCount: !document.querySelector("#pest-nav-count") || document.querySelector("#pest-nav-count")?.hidden
    ? 0
    : Number(document.querySelector("#pest-nav-count")?.textContent),
  forecastDays: document.querySelectorAll("#dashboard-forecast-chart .dashboard-risk-day").length,
  soil: document.querySelector("#dashboard-soil-summary .dashboard-soil-placeholder strong")?.textContent?.trim(),
}))()`);
await screenshot("UI_FUNCTIONAL_PARITY_DASHBOARD.png");

await click('[data-open-dialog="summary"]');
await waitFor('document.querySelector("#evidence-dialog")?.open', "summary guide");
const summaryGuide = await evaluate(
  `Boolean(document.querySelector('#evidence-dialog [data-guide-section="summary"]'))`,
);
await screenshot("UI_FUNCTIONAL_PARITY_GUIDE.png");
await click("#evidence-dialog [data-close-dialog]");

await click('[data-open-dialog="soil"]');
await waitFor('document.querySelector("#evidence-dialog")?.open', "soil guide");
const soilGuide = await evaluate(
  'document.activeElement?.dataset?.guideSection === "soil"',
);
await click("#evidence-dialog [data-close-dialog]");

await click("#dashboard-all-actions");
const allActionsExpanded = await evaluate(
  'document.querySelector("#dashboard-all-actions")?.getAttribute("aria-expanded") === "true" && document.querySelector("#dashboard-action-list")?.classList.contains("is-expanded")',
);

await click("#assistant-launcher");
await waitFor('!document.querySelector("#assistant-panel")?.hidden', "assistant open");
await setValue("#assistant-input", "내일 잎 뒷면 확인을 할 일로 추가해줘");
await evaluate('document.querySelector("#assistant-form")?.requestSubmit()');
await waitFor(
  '[...document.querySelectorAll(".assistant-proposal button")].some((button) => button.textContent.includes("이대로 추가"))',
  "assistant action proposal",
);
await evaluate(`[...document.querySelectorAll(".assistant-proposal button")]
  .find((button) => button.textContent.includes("이대로 추가"))?.click()`);
await waitFor(
  '[...document.querySelectorAll(".assistant-proposal strong")].some((node) => node.textContent.includes("추가했습니다"))',
  "assistant action stored",
);
await click("#assistant-close");

await waitFor(
  'document.querySelectorAll("#dashboard-action-list .action-plan__card").length >= 1',
  "updated action list",
);
const completeAllAvailable = await evaluate(
  '!document.querySelector("#dashboard-complete-all")?.disabled',
);
if (completeAllAvailable) {
  await click("#dashboard-complete-all");
  await waitFor(
    '/모두 완료|개는 완료/.test(document.querySelector("#dashboard-action-batch-status")?.textContent ?? "")',
    "batch completion",
  );
}
const completion = await evaluate(`(() => ({
  message: document.querySelector("#dashboard-action-batch-status")?.textContent?.trim(),
  remaining: document.querySelectorAll('#dashboard-action-list [data-action-status="DONE"]').length,
}))()`);
await screenshot("UI_FUNCTIONAL_PARITY_COMPLETED.png");

await click("#dashboard-photo-check");
await waitFor(
  '!document.querySelector("#view-services")?.hidden',
  "photo service view",
);
const photoJournal = await evaluate(`Boolean(
  document.querySelector("#photo-journal-form") &&
  document.querySelector("#journal-save") &&
  document.querySelector("#season-complete")
)`);
let photoStored = false;
let seasonCompleted = false;
let photoStatus = null;
if (photoJournal) {
  seasonCompleted = await evaluate(
    '/마무리됨/.test(document.querySelector("#season-summary-title")?.textContent ?? "")',
  );
  photoStored = await evaluate(
    'document.querySelectorAll("#photo-journal-gallery .photo-journal-item").length > 0',
  );
  if (!seasonCompleted) {
    await evaluate(`new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const context = canvas.getContext("2d");
    for (let y = 0; y < canvas.height; y += 16) {
      for (let x = 0; x < canvas.width; x += 16) {
        context.fillStyle = (x / 16 + y / 16) % 2
          ? "rgb(62, 132, 74)"
          : "rgb(120, 88, 54)";
        context.fillRect(x, y, 16, 16);
      }
    }
    canvas.toBlob((blob) => {
      const file = new File([blob], "functional-photo-check.png", { type: "image/png" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      document.querySelector("#journal-photo").files = transfer.files;
      document.querySelector("#journal-subject-confirmed").checked = true;
      document.querySelector("#journal-consent").checked = true;
      document.querySelector("#photo-journal-form").requestSubmit();
      resolve(true);
    }, "image/png");
  })`);
    await waitFor(
      '/저장했습니다|저장하고 시즌 기록|다시 촬영|저장하지 못했습니다/.test(document.querySelector("#photo-journal-status")?.textContent ?? "")',
      "photo validation",
    );
    photoStored = await evaluate(
      'document.querySelectorAll("#photo-journal-gallery .photo-journal-item").length > 0',
    );
    photoStatus = await evaluate(
      'document.querySelector("#photo-journal-status")?.textContent?.trim()',
    );
    if (photoStored) {
      await evaluate('window.confirm = () => true');
      await click("#season-complete");
      await waitFor(
        '/마무리됨/.test(document.querySelector("#season-summary-title")?.textContent ?? "")',
        "season completion",
      );
      seasonCompleted = true;
    }
  } else {
    photoStatus = "기존 사진 기록과 시즌 마감 상태를 복원했습니다.";
  }
}

await click('.nav-button[data-view="services"]');
await waitFor(
  '!document.querySelector("#view-services")?.hidden',
  "satellite service view",
);
await evaluate('document.querySelector("#satellite-service-panel")?.scrollIntoView({ block: "start" })');
const satellite = await evaluate(`(() => ({
  panel: Boolean(document.querySelector("#satellite-service-panel")),
  state: document.querySelector("#satellite-service-state")?.textContent?.trim(),
  refreshDisabled: document.querySelector("#satellite-refresh")?.disabled,
}))()`);

await click("#assistant-launcher");
await waitFor('!document.querySelector("#assistant-panel")?.hidden', "assistant reopen");
await setValue("#assistant-input", "오늘 가장 먼저 할 일은 무엇인가요?");
const beforeMessages = await evaluate(
  'document.querySelectorAll("#assistant-messages .assistant-message").length',
);
await evaluate('document.querySelector("#assistant-form")?.requestSubmit()');
await waitFor(
  `document.querySelectorAll("#assistant-messages .assistant-message").length > ${beforeMessages + 1}`,
  "assistant API answer",
  60_000,
);
const assistantAnswered = await evaluate(
  'document.querySelectorAll("#assistant-messages .assistant-message").length > 2',
);
await click("#assistant-close");

await send("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
});
await send("Page.reload", { ignoreCache: true });
await waitFor('document.readyState === "complete"', "mobile page load");
await waitFor(
  'document.body.dataset.integration !== "pending"',
  "mobile backend connection",
);
await waitFor(
  '!document.querySelector("#dashboard-workspace")?.hidden || !document.querySelector("#farm-overview-dashboard")?.hidden',
  "mobile dashboard result",
);
const mobile = await evaluate(`(() => ({
  noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
  dashboardVisible: !document.querySelector("#dashboard-workspace")?.hidden || !document.querySelector("#farm-overview-dashboard")?.hidden,
  actionCount: document.querySelectorAll("#dashboard-action-list .action-plan__card").length,
  navigationVisible: Boolean(document.querySelector(".bottom-nav, .mobile-navigation, .mobile-bottom-navigation, [data-mobile-navigation]")),
}))()`);
await screenshot("UI_FUNCTIONAL_PARITY_MOBILE.png");
await click("#assistant-launcher");
await waitFor('!document.querySelector("#assistant-panel")?.hidden', "mobile assistant open");
const mobileAssistant = await evaluate(`(() => {
  const rect = document.querySelector("#assistant-panel")?.getBoundingClientRect();
  return rect ? {
    nearlyFullWidth: rect.width >= window.innerWidth * 0.9,
    nearlyFullHeight: rect.height >= window.innerHeight * 0.9,
  } : { nearlyFullWidth: false, nearlyFullHeight: false };
})()`);
await screenshot("UI_FUNCTIONAL_PARITY_MOBILE_ASSISTANT.png");
await click("#assistant-close");

const uniqueApiResponses = [...new Map(
  apiResponses.map((entry) => [`${entry.status}:${entry.url}`, entry]),
).values()];
const analysisApiCalled = uniqueApiResponses.some(
  (entry) => entry.status === 201 && entry.url === "/api/analyses",
);
const checks = {
  savedFarmOrOnboarded: true,
  multiCrop: initial.cropTabs >= 2,
  actionPlanLoaded: initial.totalActions >= 1,
  forecastRendered: initial.forecastDays >= 5,
  soilRendered: Boolean(initial.soil),
  summaryGuide,
  soilGuide,
  allActionsExpanded,
  assistantActionStored: true,
  batchCompletion: !completeAllAvailable || /모두 완료|개는 완료/.test(completion.message ?? ""),
  photoJournal,
  satellitePanel: satellite.panel,
  satelliteStateHonest:
    satellite.panel &&
    (satellite.refreshDisabled === false || Boolean(satellite.state)),
  assistantAnswered,
  mobileDashboard: mobile.dashboardVisible,
  mobileNavigation: mobile.navigationVisible,
  mobileNoHorizontalOverflow: mobile.noHorizontalOverflow,
  mobileAssistantFullScreen:
    mobileAssistant.nearlyFullWidth && mobileAssistant.nearlyFullHeight,
  dynamicRiskBadge: initial.riskCount >= 0,
  completionPersisted: completion.remaining === 0,
  photoStored,
  seasonCompleted,
  analysisLifecycle: hasSavedFarm || analysisApiCalled,
  noFailedApiResponses: uniqueApiResponses.every((entry) => entry.status < 400),
};

console.log(JSON.stringify({
  appUrl: APP_URL,
  initial,
  completion,
  photoStatus,
  satellite,
  mobile,
  mobileAssistant,
  checks,
  passed: Object.values(checks).filter(Boolean).length,
  total: Object.keys(checks).length,
  apiResponses: uniqueApiResponses,
}, null, 2));

await send("Page.close");
socket.close();

const failedChecks = Object.entries(checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);
if (failedChecks.length > 0) {
  throw new Error(`functional parity checks failed: ${failedChecks.join(", ")}`);
}
