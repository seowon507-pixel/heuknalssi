import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ICONS = Object.freeze([
  "crops/apple.svg",
  "crops/pear.svg",
  "crops/cucumber.svg",
  "crops/potato.svg",
  "crops/lettuce.svg",
  "environment/weather.svg",
  "environment/soil.svg",
  "environment/forecast.svg",
  "environment/water.svg",
]);

async function readIcon(relativePath) {
  return readFile(path.join(import.meta.dirname, "icons", relativePath), "utf8");
}

test("작물·환경 아이콘은 농장 다이어리용 24px 스티커 SVG 규칙을 지킨다", async () => {
  for (const relativePath of ICONS) {
    const svg = await readIcon(relativePath);
    assert.match(svg, /<svg\b/u, `${relativePath}: SVG 루트가 필요합니다.`);
    assert.match(svg, /width="24"/u, `${relativePath}: 24px 너비여야 합니다.`);
    assert.match(svg, /height="24"/u, `${relativePath}: 24px 높이여야 합니다.`);
    assert.match(svg, /viewBox="0 0 24 24"/u, `${relativePath}: 24px 좌표계를 써야 합니다.`);
    assert.match(svg, /aria-hidden="true"/u, `${relativePath}: 장식 아이콘이어야 합니다.`);
    assert.match(svg, /focusable="false"/u, `${relativePath}: 키보드 초점을 받지 않아야 합니다.`);
    const colors = new Set(svg.match(/#[\dA-F]{6}/giu) ?? []);
    assert.ok(colors.size <= 4, `${relativePath}: 다이어리 스티커 아이콘은 최대 4색만 사용해야 합니다.`);
    assert.match(
      svg,
      /stroke-width="1\.(?:1|15|2|25|35)"/u,
      `${relativePath}: 24px 규격에 맞는 1.1~1.35px 잉크선을 사용해야 합니다.`,
    );
    assert.match(svg, /stroke="#FFFDF8"/u, `${relativePath}: 종이 스티커 외곽선이 필요합니다.`);
    assert.doesNotMatch(svg, /<(?:script|foreignObject|image|text|title|filter)\b/iu);
    assert.doesNotMatch(svg, /<(?:linearGradient|radialGradient|pattern|mask)\b/iu);
    assert.doesNotMatch(svg, /(?:href|src)=["'](?:https?:|data:)/iu);
  }
});

test("아이콘은 온보딩과 실제 제품 화면에 연결되고 빌드에 포함된다", async () => {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const [html, client, shell, css, buildScript, devServer] = await Promise.all([
    readFile(path.join(projectRoot, "08_흙날씨진단_UI_샘플.html"), "utf8"),
    readFile(path.join(import.meta.dirname, "backend-client.mjs"), "utf8"),
    readFile(path.join(import.meta.dirname, "ui-shell.mjs"), "utf8"),
    readFile(path.join(import.meta.dirname, "dashboard-workspace.css"), "utf8"),
    readFile(path.join(projectRoot, "scripts", "build-vercel.mjs"), "utf8"),
    readFile(path.join(import.meta.dirname, "dev-server.mjs"), "utf8"),
  ]);

  for (const crop of ["apple", "pear", "cucumber", "potato", "lettuce"]) {
    assert.match(html, new RegExp(`crop-icon--${crop}`, "u"));
    assert.match(css, new RegExp(`/icons/crops/${crop}\\.svg`, "u"));
  }
  for (const kind of ["weather", "soil", "forecast", "water"]) {
    assert.match(css, new RegExp(`/icons/environment/${kind}\\.svg`, "u"));
  }

  assert.match(shell, /crop-setting-heading/u);
  assert.match(client, /function decorativeCropIcon/u);
  assert.match(client, /function decorativeEnvironmentIcon/u);
  assert.match(client, /crop-management-switch-button/u);
  assert.match(client, /farm-crop-name-wrap/u);
  assert.match(buildScript, /join\(integrationDirectory, "icons"\)/u);
  assert.match(buildScript, /\{ recursive: true \}/u);
  assert.match(devServer, /url\.pathname\.startsWith\("\/icons\/"\)/u);
  assert.match(css, /\.crop-management-switch-button\s*\{[\s\S]*?min-height:\s*44px/u);
  assert.match(
    css,
    /\.crop-management-switch-button\[aria-pressed="true"\] \.crop-icon[\s\S]*?background-color:\s*#f8faf7/u,
  );
});
