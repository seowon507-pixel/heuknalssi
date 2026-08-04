// Vercel 정적 출력 디렉터리(public/)를 구성한다.
// 저장소 루트의 기획 문서(.md)는 배포에 포함하지 않고, UI 실행에 필요한
// HTML 한 개와 ui-integration 브라우저 자산만 복사한다.
import { copyFile, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(projectDirectory, "public");
const integrationDirectory = join(projectDirectory, "ui-integration");

// 브라우저가 직접 받는 파일만 복사한다. 테스트(*.test.mjs)와 서버 전용
// 모듈(dev-server.mjs, runtime-env.mjs)은 제외한다.
const BROWSER_ASSETS = Object.freeze([
  "ui-shell.mjs",
  "backend-client.mjs",
  "api-contract.mjs",
  "address-suggestions.mjs",
  "forecast-presentation.mjs",
  "soil-service-guidance.mjs",
  "action-plan.mjs",
  "assistant-action-request.mjs",
  "assistant-cycle-answer.mjs",
  "pest-observation-guide.mjs",
  "device-backup-payload.mjs",
  "action-projection.mjs",
  "crop-cycle.mjs",
  "harvest-forecast.mjs",
  "farm-overview.mjs",
  "local-photo-journal.mjs",
  "backend-integration.css",
  "dashboard-workspace.css",
]);

const uiFile = await findUiFile();

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(join(outputDirectory, "ui-integration"), { recursive: true });

await copyFile(join(projectDirectory, uiFile), join(outputDirectory, "index.html"));
for (const asset of BROWSER_ASSETS) {
  await copyFile(
    join(integrationDirectory, asset),
    join(outputDirectory, "ui-integration", asset),
  );
}

// 서비스워커는 사이트 전체를 제어해야 하므로 반드시 루트에 둔다.
await copyFile(join(integrationDirectory, "sw.js"), join(outputDirectory, "sw.js"));

// PWA 아이콘과 소형 작물·환경 SVG를 같은 추적 소스에서 배포한다.
// public/은 빌드마다 재생성되므로 자산 원본을 그 아래에 직접 두지 않는다.
await cp(
  join(integrationDirectory, "icons"),
  join(outputDirectory, "icons"),
  { recursive: true },
);

await writeFile(
  join(outputDirectory, "manifest.webmanifest"),
  `${JSON.stringify(
    {
      name: "흙날씨 농지 진단",
      short_name: "흙날씨",
      description: "농장 위치의 기상·토양 자료로 오늘 할 일을 알려 줍니다.",
      lang: "ko",
      start_url: "/",
      scope: "/",
      display: "standalone",
      orientation: "portrait",
      background_color: "#FFFFFF",
      theme_color: "#1F6B36",
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(`public/index.html ← ${uiFile}`);
console.log(`public/ui-integration/ ← ${BROWSER_ASSETS.join(", ")}`);
console.log("public/sw.js · manifest.webmanifest · icons/ 생성");

// dev-server.mjs와 동일한 규칙으로 UI HTML을 하나로 확정한다.
async function findUiFile() {
  const entries = await readdir(projectDirectory, { withFileTypes: true });
  const matches = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith("08_") &&
        entry.name.endsWith(".html") &&
        entry.name.includes("UI"),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "ko"));
  if (matches.length !== 1) {
    throw new Error(
      `UI HTML을 하나로 확정할 수 없습니다. 발견 개수: ${matches.length}`,
    );
  }
  return matches[0];
}
