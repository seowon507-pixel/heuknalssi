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

test("제품 UI는 실행 코드를 외부 모듈로 분리한다", async () => {
  const html = await readProductUi();
  const scripts = [
    ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu),
  ];

  assert.ok(scripts.length >= 2, "UI 모듈이 선언되어야 합니다.");
  for (const [, attributes, body] of scripts) {
    assert.match(attributes, /\bsrc="[^"]+"/u);
    assert.equal(body.trim(), "", "인라인 실행 코드는 없어야 합니다.");
  }
  assert.match(html, /src="\/ui-integration\/ui-shell\.mjs"/u);
  assert.match(html, /src="\/ui-integration\/backend-client\.mjs"/u);
});

test("UI 셸에는 실제 백엔드와 경쟁하는 체험용 분석값이 없다", async () => {
  const shell = await readFile(
    path.join(import.meta.dirname, "ui-shell.mjs"),
    "utf8",
  );

  for (const forbidden of [
    "cropResults",
    "dataStates",
    "renderResult",
    "setDataState",
    "참고지수",
    "pH 5.1",
    "비 18mm",
  ]) {
    assert.doesNotMatch(
      shell,
      new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      `UI 셸에 체험용 분석값이 남아 있습니다: ${forbidden}`,
    );
  }
});

test("첫 페인트는 저장 설정 확인 전 화면을 잠그고 온보딩 깜빡임을 막는다", async () => {
  const html = await readProductUi();

  assert.match(
    html,
    /<body data-integration="pending" data-profile-state="checking">/u,
  );
  assert.match(html, /<div class="app-shell" inert>/u);
  assert.match(html, /id="onboarding"[^>]*\bhidden\b/u);
  assert.match(
    html,
    /<section class="panel risk-panel"[^>]*\bhidden\b[^>]*>/u,
  );
});

test("정적 ID는 중복되지 않고 모듈의 고정 ID 참조가 모두 존재한다", async () => {
  const html = await readProductUi();
  const modules = await Promise.all(
    ["ui-shell.mjs", "backend-client.mjs"].map((name) =>
      readFile(path.join(import.meta.dirname, name), "utf8"),
    ),
  );
  const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], [], "중복된 HTML ID가 있습니다.");

  const knownIds = new Set(ids);
  for (const moduleSource of modules) {
    for (const [, dynamicId] of moduleSource.matchAll(
      /\.id\s*=\s*["']([A-Za-z][\w-]*)["']/gu,
    )) {
      knownIds.add(dynamicId);
    }
  }
  const missing = new Set();
  for (const moduleSource of modules) {
    const selectors = moduleSource.matchAll(
      /document\.querySelector(?:All)?\(\s*["'`]([^"'`$]+)["'`]\s*\)/gu,
    );
    for (const [, selector] of selectors) {
      for (const match of selector.matchAll(/#([A-Za-z][\w-]*)/gu)) {
        if (!knownIds.has(match[1])) missing.add(match[1]);
      }
    }
  }
  assert.deepEqual(
    [...missing].sort(),
    [],
    "모듈이 존재하지 않는 고정 ID를 참조합니다.",
  );
});
