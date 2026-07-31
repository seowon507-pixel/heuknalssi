import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("사진 기록 UI는 중앙 촬영 가이드와 사용자 확인을 제공한다", async () => {
  const html = await readProductUi();

  assert.match(html, /class="photo-capture-guide"/);
  assert.match(html, /화면 중앙/);
  assert.match(
    html,
    /id="journal-subject-confirmed"[^>]*name="subjectConfirmed"[^>]*required/,
  );
  assert.match(html, /작물이 안내선 안을 충분히 채웠/);
});

test("사진 저장 UI는 크기 상한과 중앙 배치 확인을 실제 저장 흐름에서 검사한다", async () => {
  const client = await readFile(
    path.join(import.meta.dirname, "backend-client.mjs"),
    "utf8",
  );

  assert.match(client, /LOCAL_PHOTO_MAX_BYTES/);
  assert.match(client, /file\.size > LOCAL_PHOTO_MAX_BYTES/);
  assert.match(client, /10MB 이하 이미지/);
  assert.match(client, /form\.elements\.subjectConfirmed\?\.checked !== true/);
  assert.match(client, /subjectConfirmed: true/);
});

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
