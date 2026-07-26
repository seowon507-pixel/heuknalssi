import assert from "node:assert/strict";
import test from "node:test";
import { createECDH, createPublicKey, createVerify } from "node:crypto";

import {
  base64UrlDecode,
  base64UrlEncode,
  createVapidHeader,
  createWebPushSender,
  encryptPayload,
  WebPushError,
} from "../src/infrastructure/web-push.js";

// RFC 8291 §5의 공식 시험값. 임시키와 소금을 고정해 결과 바이트를 그대로 맞춘다.
const RFC8291 = Object.freeze({
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  expected:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
});

function fixedEphemeralKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(base64UrlDecode(RFC8291.asPrivate));
  return ecdh;
}

test("RFC 8291 시험값과 암호문이 바이트 단위로 같다", () => {
  const body = encryptPayload({
    payload: RFC8291.plaintext,
    userAgentPublicKey: RFC8291.uaPublic,
    authSecret: RFC8291.authSecret,
    randomBytes: () => base64UrlDecode(RFC8291.salt),
    createEphemeralKeys: fixedEphemeralKeys,
  });
  assert.equal(base64UrlEncode(body), RFC8291.expected);
});

test("임시키가 시험값과 같은 공개키를 만든다", () => {
  assert.equal(base64UrlEncode(fixedEphemeralKeys().getPublicKey()), RFC8291.asPublic);
});

test("같은 본문이라도 매번 다른 암호문이 나온다", () => {
  const args = {
    payload: "같은 본문",
    userAgentPublicKey: RFC8291.uaPublic,
    authSecret: RFC8291.authSecret,
  };
  assert.notEqual(
    base64UrlEncode(encryptPayload(args)),
    base64UrlEncode(encryptPayload(args)),
  );
});

test("구독 키가 규격에 맞지 않으면 암호화하지 않는다", () => {
  for (const [uaPublic, auth] of [
    ["", RFC8291.authSecret],
    [RFC8291.uaPublic, "짧다"],
    [base64UrlEncode(Buffer.alloc(65)), RFC8291.authSecret], // 0x04로 시작하지 않는다
  ]) {
    assert.throws(
      () => encryptPayload({ payload: "x", userAgentPublicKey: uaPublic, authSecret: auth }),
      (error) => error instanceof WebPushError && error.code === "INVALID_SUBSCRIPTION",
    );
  }
});

test("한 레코드에 담을 수 없는 본문은 거부한다", () => {
  assert.throws(
    () => encryptPayload({
      payload: "가".repeat(4096),
      userAgentPublicKey: RFC8291.uaPublic,
      authSecret: RFC8291.authSecret,
    }),
    (error) => error instanceof WebPushError && error.code === "PAYLOAD_TOO_LARGE",
  );
});

// ── VAPID ────────────────────────────────────────────────────────
const VAPID = Object.freeze({
  publicKey: base64UrlEncode(
    (() => {
      const ecdh = createECDH("prime256v1");
      ecdh.setPrivateKey(base64UrlDecode(RFC8291.asPrivate));
      return ecdh.getPublicKey();
    })(),
  ),
  privateKey: RFC8291.asPrivate,
  subject: "mailto:seowon507@gmail.com",
});

test("VAPID 헤더의 서명을 공개키로 검증할 수 있다", () => {
  const header = createVapidHeader({
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    subject: VAPID.subject,
    publicKey: VAPID.publicKey,
    privateKey: VAPID.privateKey,
    now: () => 1_700_000_000_000,
  });
  const [, token] = /^vapid t=([^,]+), k=(.+)$/u.exec(header);
  const [encodedHeader, encodedClaims, signature] = token.split(".");

  assert.deepEqual(JSON.parse(base64UrlDecode(encodedHeader).toString("utf8")), {
    typ: "JWT", alg: "ES256",
  });
  const claims = JSON.parse(base64UrlDecode(encodedClaims).toString("utf8"));
  // 수신처 오리진만 담아야 한다. 경로가 들어가면 푸시 서비스가 거부한다.
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, VAPID.subject);
  assert.equal(claims.exp, 1_700_000_000 + 12 * 60 * 60);

  const point = base64UrlDecode(VAPID.publicKey);
  const verifier = createVerify("sha256").update(`${encodedHeader}.${encodedClaims}`);
  assert.equal(
    verifier.verify(
      {
        key: createPublicKey({
          format: "jwk",
          key: {
            kty: "EC", crv: "P-256",
            x: base64UrlEncode(point.subarray(1, 33)),
            y: base64UrlEncode(point.subarray(33, 65)),
          },
        }),
        dsaEncoding: "ieee-p1363",
      },
      base64UrlDecode(signature),
    ),
    true,
  );
});

test("VAPID 헤더의 aud는 수신처마다 달라진다", () => {
  const common = { subject: VAPID.subject, publicKey: VAPID.publicKey, privateKey: VAPID.privateKey, now: () => 0 };
  const fcm = createVapidHeader({ endpoint: "https://fcm.googleapis.com/fcm/send/a", ...common });
  const apple = createVapidHeader({ endpoint: "https://web.push.apple.com/x", ...common });
  assert.notEqual(fcm, apple);
});

// ── 발송 ─────────────────────────────────────────────────────────
const SUBSCRIPTION = Object.freeze({
  endpoint: "https://web.push.apple.com/abcdef",
  keys: { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret },
});

test("발송 요청에 규격 헤더와 암호문 본문이 담긴다", async () => {
  let captured = null;
  const sender = createWebPushSender({
    ...VAPID,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 201, text: async () => "" };
    },
  });
  assert.equal(sender.configured, true);
  const result = await sender.send(SUBSCRIPTION, JSON.stringify({ title: "제목" }), { ttlSeconds: 60 });

  assert.equal(result.statusCode, 201);
  assert.equal(captured.url, SUBSCRIPTION.endpoint);
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["Content-Encoding"], "aes128gcm");
  assert.equal(captured.init.headers.TTL, "60");
  assert.match(captured.init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/u);
  // 본문은 평문이 남아 있으면 안 된다.
  assert.ok(Buffer.isBuffer(captured.init.body));
  assert.equal(captured.init.body.includes(Buffer.from("제목", "utf8")), false);
});

test("410은 구독 만료로 구분해 되살리지 않는다", async () => {
  const sender = createWebPushSender({
    ...VAPID,
    fetchImpl: async () => ({ ok: false, status: 410, text: async () => "" }),
  });
  await assert.rejects(
    sender.send(SUBSCRIPTION, "본문"),
    (error) =>
      error instanceof WebPushError &&
      error.code === "SUBSCRIPTION_EXPIRED" &&
      error.expired === true,
  );
});

test("그 밖의 실패는 만료로 취급하지 않는다", async () => {
  const sender = createWebPushSender({
    ...VAPID,
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => "too many" }),
  });
  await assert.rejects(
    sender.send(SUBSCRIPTION, "본문"),
    (error) => error instanceof WebPushError && error.code === "PUSH_REJECTED" && error.expired === false,
  );
});

test("VAPID 키가 없으면 발송하지 않는다", async () => {
  const sender = createWebPushSender({});
  assert.equal(sender.configured, false);
  await assert.rejects(
    sender.send(SUBSCRIPTION, "본문"),
    (error) => error instanceof WebPushError && error.code === "PUSH_NOT_CONFIGURED",
  );
});

test("https가 아닌 수신처로는 보내지 않는다", async () => {
  const sender = createWebPushSender({
    ...VAPID,
    fetchImpl: async () => { throw new Error("불려서는 안 된다"); },
  });
  await assert.rejects(
    sender.send({ ...SUBSCRIPTION, endpoint: "http://example.com/x" }, "본문"),
    (error) => error instanceof WebPushError && error.code === "INVALID_SUBSCRIPTION",
  );
});
