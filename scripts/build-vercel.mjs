// Vercel 정적 출력 디렉터리(public/)를 구성한다.
// 저장소 루트의 기획 문서(.md)는 배포에 포함하지 않고, UI 실행에 필요한
// HTML 한 개와 ui-integration 브라우저 자산만 복사한다.
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { decodePng } from "./png.mjs";
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
  "crop-condition-score.mjs",
  "forecast-presentation.mjs",
  "soil-service-guidance.mjs",
  "forecast-accuracy.json",
  "backend-integration.css",
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

await mkdir(join(outputDirectory, "icons"), { recursive: true });
// 홈 화면에 씌워지는 아이콘은 네 모서리가 불투명해야 한다. 투명하면
// 런처·iOS가 자기 모양을 씌울 때 초록 사각형의 모서리가 잘려 나간다.
async function assertOpaqueCorners(path) {
  const { width, height, rgba } = decodePng(await readFile(path));
  for (const [x, y] of [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ]) {
    const alpha = rgba[(y * width + x) * 4 + 3];
    if (alpha !== 255) {
      throw new Error(
        `${path}: (${x},${y}) 모서리가 투명하다(alpha ${alpha}). 홈 화면에서 잘린다.`,
      );
    }
  }
}

for (const icon of [
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "icon-fullbleed-512.png",
  "icon-fullbleed-192.png",
  "icon-apple-180.png",
]) {
  const target = join(outputDirectory, "icons", icon);
  await copyFile(join(integrationDirectory, "icons", icon), target);
  if (
    icon.includes("maskable") ||
    icon.includes("apple") ||
    icon.includes("fullbleed")
  ) {
    await assertOpaqueCorners(target);
  }
}

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
        // maskable에는 모서리까지 꽉 찬 아이콘을 따로 쓴다. 모서리가 투명한
        // 둥근 사각형을 maskable로 주면 런처가 바깥을 잘라내 아이콘이 깨진다.
        { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
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
