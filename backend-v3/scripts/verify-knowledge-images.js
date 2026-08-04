// 흙톡 재배 참고 이미지 검증.
//
// 두 종류를 함께 본다.
//   자체 제작 도해 — SVG가 잘 만들어졌고, 스크립트나 외부 참조가 없고,
//                    뷰박스와 도해 라벨 규칙을 지키는지 확인한다.
//   외부 이미지    — 등록한 URL이 실제로 존재하고, 허용 호스트에 있고, 이미지
//                    형식이며, 크기 상한 안에 있는지 확인한다.
//
// 배포 전에 여기서 걸러야 화면에 깨진 이미지가 나가지 않는다.
//
// 실행:
//   node scripts/verify-knowledge-images.js
//   node scripts/verify-knowledge-images.js --strict   # 미연결 이미지도 실패로 본다

import { KNOWLEDGE_IMAGE_HOST_ALLOWLIST } from "../src/application/knowledge-images.js";
import {
  KNOWLEDGE_IMAGES,
  REVIEWED_KNOWLEDGE_BASE,
} from "../runtime/reviewed-knowledge-base.js";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// SVG 도해에 들어가면 안 되는 것들. 우리 오리진에서 서빙되므로 외부 참조와
// 실행 가능한 내용을 원천적으로 막는다.
const BANNED_SVG_TOKENS = Object.freeze([
  "<script",
  "<foreignObject",
  "<image",
  "<use",
  "xlink:href",
  "@import",
  "data:",
  "javascript:",
  "onload=",
  "onerror=",
]);
const EXPECTED_VIEWBOX = "0 0 400 220";
const DIAGRAM_LABEL = "관찰 지점 도해";

const strict = process.argv.includes("--strict");
const failures = [];
const notConnected = [];
const verified = [];

function fail(imageId, reason) {
  failures.push(`${imageId}: ${reason}`);
}

// 어느 문단이 이 이미지를 참조하는지 알려 주면 검수자가 찾기 쉽다.
const referencedBy = new Map();
for (const passage of REVIEWED_KNOWLEDGE_BASE) {
  if (!passage.imageId) continue;
  const list = referencedBy.get(passage.imageId) ?? [];
  list.push(passage.id);
  referencedBy.set(passage.imageId, list);
}

for (const [imageId, entry] of Object.entries(KNOWLEDGE_IMAGES)) {
  if (!referencedBy.has(imageId)) {
    fail(imageId, "어떤 문단도 참조하지 않는 이미지입니다.");
  }
  if (!entry.alt?.trim()) fail(imageId, "alt 텍스트가 없습니다.");
  if (!entry.credit?.trim()) fail(imageId, "credit(출처 표기)이 없습니다.");

  // 자체 제작 도해는 네트워크 없이 내용만 검사한다.
  if (Buffer.isBuffer(entry.body) && entry.body.length > 0) {
    if (!entry.licence?.trim()) {
      fail(imageId, "licence 표기가 필요합니다.");
    }
    if (entry.contentType !== "image/svg+xml") {
      // 래스터 도해를 넣었다면 크기만 확인하고 넘어간다.
      if (entry.body.length > MAX_IMAGE_BYTES) {
        fail(imageId, `크기 상한 초과: ${(entry.body.length / 1024).toFixed(0)} KiB`);
      } else {
        verified.push(
          `${imageId} — 자체 제작 ${entry.contentType}, ${(entry.body.length / 1024).toFixed(1)} KiB`,
        );
      }
      continue;
    }
    const svg = entry.body.toString("utf8");
    let broken = false;
    for (const token of BANNED_SVG_TOKENS) {
      if (svg.includes(token)) {
        fail(imageId, `도해에 금지된 내용이 있습니다: ${token}`);
        broken = true;
      }
    }
    if (!svg.includes(`viewBox="${EXPECTED_VIEWBOX}"`)) {
      fail(imageId, `viewBox가 "${EXPECTED_VIEWBOX}"가 아닙니다.`);
      broken = true;
    }
    if (!/<title>[^<]+<\/title>/u.test(svg)) {
      fail(imageId, "<title>이 없습니다.");
      broken = true;
    }
    if (!svg.includes(DIAGRAM_LABEL)) {
      fail(
        imageId,
        `사진이 아님을 밝히는 "${DIAGRAM_LABEL}" 라벨이 없습니다.`,
      );
      broken = true;
    }
    if (entry.body.length > MAX_IMAGE_BYTES) {
      fail(imageId, `크기 상한 초과: ${(entry.body.length / 1024).toFixed(0)} KiB`);
      broken = true;
    }
    if (!broken) {
      verified.push(
        `${imageId} — 자체 제작 도해 SVG, ${(entry.body.length / 1024).toFixed(1)} KiB, ${entry.licence}`,
      );
    }
    continue;
  }

  const url = typeof entry.url === "string" ? entry.url.trim() : "";
  if (!url) {
    notConnected.push(
      `${imageId} (참조: ${referencedBy.get(imageId)?.join(", ") ?? "없음"})`,
    );
    continue;
  }
  if (!entry.licence?.trim()) {
    fail(imageId, "URL이 있으면 licence 표기가 필요합니다.");
  }

  let target;
  try {
    target = new URL(url);
  } catch {
    fail(imageId, `URL 형식이 아닙니다: ${url}`);
    continue;
  }
  if (target.protocol !== "https:") {
    fail(imageId, `https가 아닙니다: ${url}`);
    continue;
  }
  if (!KNOWLEDGE_IMAGE_HOST_ALLOWLIST.includes(target.hostname)) {
    fail(
      imageId,
      `허용 호스트가 아닙니다: ${target.hostname} (허용: ${KNOWLEDGE_IMAGE_HOST_ALLOWLIST.join(", ")})`,
    );
    continue;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // HEAD를 지원하지 않는 서버가 있어 GET으로 받고 실제 바이트를 확인한다.
    const response = await fetch(target.href, {
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
      headers: { Accept: "image/jpeg,image/png,image/webp" },
    });
    if (!response.ok) {
      fail(imageId, `HTTP ${response.status}`);
      continue;
    }
    const contentType = String(response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      fail(imageId, `이미지 형식이 아닙니다: ${contentType || "(없음)"}`);
      continue;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      fail(imageId, "응답 본문이 비어 있습니다.");
      continue;
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      fail(
        imageId,
        `크기 상한 초과: ${(bytes.length / 1024).toFixed(0)} KiB > ${MAX_IMAGE_BYTES / 1024} KiB`,
      );
      continue;
    }
    verified.push(
      `${imageId} — ${contentType}, ${(bytes.length / 1024).toFixed(0)} KiB, ${entry.licence}`,
    );
  } catch (error) {
    fail(
      imageId,
      error?.name === "AbortError"
        ? `${TIMEOUT_MS}ms 안에 응답이 없습니다.`
        : `요청 실패: ${error?.message ?? "알 수 없는 오류"}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

const danglingReferences = [...referencedBy.entries()].filter(
  ([imageId]) => !Object.hasOwn(KNOWLEDGE_IMAGES, imageId),
);
for (const [imageId, passages] of danglingReferences) {
  fail(imageId, `등록되지 않은 imageId를 참조합니다: ${passages.join(", ")}`);
}

console.log(
  `등록 ${Object.keys(KNOWLEDGE_IMAGES).length}건 · 연결 확인 ${verified.length}건 · 미연결 ${notConnected.length}건`,
);
for (const line of verified) console.log(`  OK    ${line}`);
for (const line of notConnected) console.log(`  미연결 ${line}`);
for (const line of failures) console.error(`  실패  ${line}`);

if (notConnected.length > 0 && !strict) {
  console.log(
    "\n미연결 이미지는 설명만 표시되고 깨진 이미지로 나가지 않습니다.\n" +
      "자체 제작 도해를 붙이려면 runtime/knowledge-images/README.md의 절차를,\n" +
      "외부 실사진을 붙이려면 사람이 확인한 공개 URL과 licence를 채운 뒤\n" +
      "이 스크립트를 다시 실행하세요.",
  );
}

if (failures.length > 0 || (strict && notConnected.length > 0)) {
  process.exitCode = 1;
}
