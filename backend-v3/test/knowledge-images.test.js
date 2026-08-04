import assert from "node:assert/strict";
import test from "node:test";

import {
  KNOWLEDGE_IMAGE_HOST_ALLOWLIST,
  KnowledgeImageError,
  createKnowledgeImageService,
} from "../src/application/knowledge-images.js";
import { KNOWLEDGE_IMAGES } from "../runtime/reviewed-knowledge-base.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function imageResponse(body = JPEG, contentType = "image/jpeg", headers = {}) {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": contentType, ...headers },
  });
}

function service({ images, fetchImpl = async () => imageResponse(), ...rest } = {}) {
  return createKnowledgeImageService({
    images: images ?? {
      TEST_OK: { url: "https://ncpms.rda.go.kr/a.jpg", alt: "설명" },
    },
    fetchImpl,
    ...rest,
  });
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof KnowledgeImageError, `타입: ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("등록된 이미지를 허용 호스트에서 받아 전달한다", async () => {
  const proxy = service();
  assert.equal(proxy.state, "READY");

  const image = await proxy.fetchImage("TEST_OK");
  assert.equal(image.contentType, "image/jpeg");
  assert.deepEqual(image.body, JPEG);
});

test("레지스트리에 없는 식별자는 어떤 요청도 만들지 않는다", async () => {
  let called = false;
  const proxy = service({
    fetchImpl: async () => {
      called = true;
      return imageResponse();
    },
  });

  await rejectsWith(proxy.fetchImage("TEST_MISSING"), "KNOWLEDGE_IMAGE_NOT_FOUND");
  assert.equal(called, false);
});

test("식별자로 위장한 URL과 경로 이탈은 형식 검사에서 막힌다", async () => {
  let called = false;
  const proxy = service({
    fetchImpl: async () => {
      called = true;
      return imageResponse();
    },
  });

  for (const candidate of [
    "https://evil.test/a.jpg",
    "../../etc/passwd",
    "TEST_OK/../../secret",
    "http://169.254.169.254/latest/meta-data",
    "test_ok",
    "",
    null,
    undefined,
    42,
  ]) {
    await assert.rejects(
      proxy.fetchImage(candidate),
      (error) =>
        error instanceof KnowledgeImageError &&
        ["KNOWLEDGE_IMAGE_INVALID_ID", "KNOWLEDGE_IMAGE_NOT_FOUND"].includes(
          error.code,
        ),
      `거절해야 한다: ${String(candidate)}`,
    );
  }
  assert.equal(called, false);
});

test("허용 목록 밖 호스트는 등록되어 있어도 요청하지 않는다", async () => {
  let called = false;
  const proxy = service({
    images: { TEST_EVIL: { url: "https://evil.test/a.jpg" } },
    fetchImpl: async () => {
      called = true;
      return imageResponse();
    },
  });

  await rejectsWith(
    proxy.fetchImage("TEST_EVIL"),
    "KNOWLEDGE_IMAGE_HOST_NOT_ALLOWED",
  );
  assert.equal(called, false);
});

// 허용 호스트 목록이 사설 주소·평문 HTTP 방어를 함께 담당한다. 프록시는 코퍼스에
// 등록된 URL만 보고, 그 URL도 목록에 없으면 요청 자체를 만들지 않는다.
test("https가 아니거나 목록 밖인 대상은 요청하지 않는다", async () => {
  for (const url of [
    "http://ncpms.rda.go.kr/a.jpg",
    "file:///etc/passwd",
    "https://127.0.0.1/a.jpg",
    "https://localhost/a.jpg",
    "not-a-url",
  ]) {
    let called = false;
    const proxy = service({
      images: { TEST_BAD: { url } },
      fetchImpl: async () => {
        called = true;
        return imageResponse();
      },
    });
    await assert.rejects(
      proxy.fetchImage("TEST_BAD"),
      (error) => error instanceof KnowledgeImageError,
      `거절해야 한다: ${url}`,
    );
    assert.equal(called, false, `요청하면 안 된다: ${url}`);
  }
});

test("URL이 비어 있는 이미지는 미연결로 구분된다", async () => {
  const proxy = service({ images: { TEST_EMPTY: { url: null, alt: "설명" } } });

  assert.equal(proxy.state, "NOT_CONNECTED");
  assert.equal(proxy.registeredCount, 1);
  assert.equal(proxy.connectedCount, 0);
  await rejectsWith(
    proxy.fetchImage("TEST_EMPTY"),
    "KNOWLEDGE_IMAGE_NOT_CONNECTED",
  );
});

test("이미지가 아닌 응답은 그대로 흘려보내지 않는다", async () => {
  const proxy = service({
    fetchImpl: async () => imageResponse("<html>", "text/html"),
  });

  await rejectsWith(
    proxy.fetchImage("TEST_OK"),
    "KNOWLEDGE_IMAGE_UNSUPPORTED_TYPE",
  );
});

test("선언된 크기와 실제 크기 모두 상한을 넘으면 거절한다", async () => {
  const declared = service({
    maxBytes: 8,
    fetchImpl: async () =>
      imageResponse(JPEG, "image/jpeg", { "Content-Length": "999999" }),
  });
  await rejectsWith(declared.fetchImage("TEST_OK"), "KNOWLEDGE_IMAGE_TOO_LARGE");

  // Content-Length를 거짓으로 보내도 실제 바이트에서 걸린다.
  const actual = service({
    maxBytes: 4,
    fetchImpl: async () =>
      imageResponse(JPEG, "image/jpeg", { "Content-Length": "1" }),
  });
  await rejectsWith(actual.fetchImage("TEST_OK"), "KNOWLEDGE_IMAGE_TOO_LARGE");
});

test("빈 응답 본문은 이미지로 취급하지 않는다", async () => {
  const proxy = service({
    fetchImpl: async () => imageResponse(Buffer.alloc(0)),
  });
  await rejectsWith(proxy.fetchImage("TEST_OK"), "KNOWLEDGE_IMAGE_TOO_LARGE");
});

test("업스트림 오류와 네트워크 실패는 같은 범주로만 노출된다", async () => {
  const failing = service({
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });
  await rejectsWith(failing.fetchImage("TEST_OK"), "KNOWLEDGE_IMAGE_UNAVAILABLE");

  const throwing = service({
    fetchImpl: async () => {
      throw new Error("upstream secret detail");
    },
  });
  await assert.rejects(throwing.fetchImage("TEST_OK"), (error) => {
    assert.equal(error.code, "KNOWLEDGE_IMAGE_UNAVAILABLE");
    assert.doesNotMatch(String(error.message), /secret/);
    return true;
  });
});

test("리다이렉트를 따라가지 않도록 요청한다", async () => {
  let redirectOption = null;
  const proxy = service({
    fetchImpl: async (_url, init) => {
      redirectOption = init.redirect;
      return imageResponse();
    },
  });

  await proxy.fetchImage("TEST_OK");
  assert.equal(redirectOption, "error");
});

test("describe는 업스트림 URL을 노출하지 않는다", () => {
  const proxy = service();
  const described = proxy.describe("TEST_OK");

  assert.equal(described.available, true);
  assert.equal(described.imageId, "TEST_OK");
  assert.equal(Object.hasOwn(described, "url"), false);
  assert.doesNotMatch(JSON.stringify(described), /ncpms|\.jpg/);
  assert.equal(proxy.describe("TEST_MISSING"), null);
});

test("코퍼스에 등록된 모든 이미지는 표기와 출처 규칙을 지킨다", () => {
  for (const [imageId, entry] of Object.entries(KNOWLEDGE_IMAGES)) {
    assert.ok(entry.alt, `alt 필요: ${imageId}`);
    assert.ok(entry.credit, `credit 필요: ${imageId}`);
    // 상업적 이용금지 자료를 모르고 배포하지 않도록 라이선스 표기를 요구한다.
    assert.ok(entry.licence, `licence 표기 필요: ${imageId}`);
    if (!entry.url) continue;
    const url = new URL(entry.url);
    assert.equal(url.protocol, "https:", `https 필요: ${imageId}`);
    assert.ok(
      KNOWLEDGE_IMAGE_HOST_ALLOWLIST.includes(url.hostname),
      `허용되지 않은 호스트: ${imageId} (${url.hostname})`,
    );
  }
});

// ── 자체 제작 도해 ──────────────────────────────────────────

test("자체 제작 도해는 네트워크 호출 없이 전달된다", async () => {
  const proxy = service({
    images: {
      TEST_DIAGRAM: {
        body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
        contentType: "image/svg+xml",
        alt: "도해",
        credit: "자체 제작",
        licence: "프로젝트 소유",
      },
    },
    fetchImpl: async () => {
      throw new Error("도해는 네트워크를 쓰지 않아야 한다");
    },
  });

  assert.equal(proxy.state, "READY");
  assert.equal(proxy.diagramCount, 1);
  assert.equal(proxy.externalCount, 0);

  const image = await proxy.fetchImage("TEST_DIAGRAM");
  assert.equal(image.contentType, "image/svg+xml");
  assert.match(image.body.toString("utf8"), /^<svg/);
  assert.equal(proxy.describe("TEST_DIAGRAM").source, "DIAGRAM");
  assert.equal(proxy.describe("TEST_DIAGRAM").available, true);
});

test("도해가 있으면 같은 항목의 외부 URL보다 먼저 쓴다", async () => {
  let fetched = false;
  const proxy = service({
    images: {
      TEST_BOTH: {
        body: Buffer.from("<svg/>"),
        contentType: "image/svg+xml",
        url: "https://ncpms.rda.go.kr/a.jpg",
      },
    },
    fetchImpl: async () => {
      fetched = true;
      return imageResponse();
    },
  });

  const image = await proxy.fetchImage("TEST_BOTH");
  assert.equal(image.contentType, "image/svg+xml");
  assert.equal(fetched, false);
});

test("허용되지 않은 형식이나 빈 본문은 도해로 취급하지 않는다", async () => {
  for (const entry of [
    { body: Buffer.from("<html>"), contentType: "text/html" },
    { body: Buffer.alloc(0), contentType: "image/svg+xml" },
    { body: "문자열", contentType: "image/svg+xml" },
  ]) {
    const proxy = service({ images: { TEST_BAD: entry } });
    assert.equal(proxy.diagramCount, 0);
    assert.equal(proxy.describe("TEST_BAD").available, false);
    await rejectsWith(
      proxy.fetchImage("TEST_BAD"),
      "KNOWLEDGE_IMAGE_NOT_CONNECTED",
    );
  }
});

test("상한을 넘는 도해는 거절한다", async () => {
  const proxy = service({
    maxBytes: 8,
    images: {
      TEST_BIG: {
        body: Buffer.alloc(64, 0x20),
        contentType: "image/svg+xml",
      },
    },
  });
  await rejectsWith(proxy.fetchImage("TEST_BIG"), "KNOWLEDGE_IMAGE_TOO_LARGE");
});

test("코퍼스 도해는 실행 가능한 내용이나 외부 참조를 담지 않는다", () => {
  const banned = [
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
  ];
  let diagrams = 0;
  for (const [imageId, entry] of Object.entries(KNOWLEDGE_IMAGES)) {
    if (entry.contentType !== "image/svg+xml") continue;
    diagrams += 1;
    const svg = entry.body.toString("utf8");
    for (const token of banned) {
      assert.equal(svg.includes(token), false, `${imageId}에 ${token}`);
    }
    assert.match(svg, /viewBox="0 0 400 220"/, `${imageId} viewBox`);
    assert.match(svg, /<title>[^<]+<\/title>/u, `${imageId} title`);
    // 사진이 아니라 도해임을 화면에서 알 수 있어야 한다.
    assert.ok(svg.includes("관찰 지점 도해"), `${imageId} 도해 라벨`);
    assert.ok(entry.body.length < 8 * 1024, `${imageId} 크기`);
  }
  assert.ok(diagrams >= 11, `도해 개수: ${diagrams}`);
});

test("도해 설명은 사용자가 스스로 병을 확정하도록 유도하지 않는다", () => {
  for (const [imageId, entry] of Object.entries(KNOWLEDGE_IMAGES)) {
    if (entry.contentType !== "image/svg+xml") continue;
    for (const text of [entry.alt, entry.caption]) {
      assert.doesNotMatch(
        text,
        /병명|진단|이 병|무슨 병/u,
        `병명·진단 표현 금지: ${imageId}`,
      );
    }
  }
});
