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

test("코퍼스에 등록된 이미지 URL은 모두 허용 호스트에 있다", () => {
  for (const [imageId, entry] of Object.entries(KNOWLEDGE_IMAGES)) {
    assert.ok(entry.alt, `alt 필요: ${imageId}`);
    assert.ok(entry.credit, `credit 필요: ${imageId}`);
    if (!entry.url) continue;
    const url = new URL(entry.url);
    assert.equal(url.protocol, "https:", `https 필요: ${imageId}`);
    assert.ok(
      KNOWLEDGE_IMAGE_HOST_ALLOWLIST.includes(url.hostname),
      `허용되지 않은 호스트: ${imageId} (${url.hostname})`,
    );
    // 상업적 이용금지 자료를 모르고 배포하지 않도록 라이선스 표기를 요구한다.
    assert.ok(entry.licence, `licence 표기 필요: ${imageId}`);
  }
});
