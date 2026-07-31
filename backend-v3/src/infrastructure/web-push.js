import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createSign,
  randomBytes as nodeRandomBytes,
} from "node:crypto";

/**
 * Web Push 발송.
 *
 * 앱이 꺼져 있어도 알림이 뜨려면 브라우저 제조사의 푸시 서비스(FCM·APNs 등)를
 * 거쳐야 한다. 그 서비스는 본문을 볼 수 없어야 하므로 RFC 8291(aes128gcm)로
 * 단말 공개키에 대고 암호화하고, RFC 8292(VAPID)로 발신자를 서명한다.
 *
 * 라이브러리를 쓰지 않고 node:crypto만으로 구현한다. 이 프로젝트는 런타임
 * 의존성을 두지 않는다.
 */

const P256 = "prime256v1";
const AES_KEY_BYTES = 16;
const NONCE_BYTES = 12;
const SALT_BYTES = 16;
const PUBLIC_KEY_BYTES = 65; // 비압축 P-256 점: 0x04 || X(32) || Y(32)
const AUTH_SECRET_BYTES = 16;
const RECORD_SIZE = 4096;
// 본문은 한 레코드에 담는다. 태그 16 + 구분자 1 을 뺀 만큼만 쓸 수 있다.
const MAX_PAYLOAD_BYTES = RECORD_SIZE - 16 - 1;
const VAPID_TTL_SECONDS = 12 * 60 * 60;

export class WebPushError extends Error {
  constructor(code, message, { statusCode = 0, expired = false } = {}) {
    super(message);
    this.name = "WebPushError";
    this.code = code;
    this.statusCode = statusCode;
    // 단말이 앱을 지웠거나 구독이 끊긴 경우. 저장소에서 지워야 한다.
    this.expired = expired;
  }
}

export function base64UrlDecode(value) {
  const normalized = String(value ?? "").replace(/-/gu, "+").replace(/_/gu, "/");
  return Buffer.from(normalized, "base64");
}

export function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function hkdf(salt, ikm, info, length) {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  const output = createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest();
  return output.subarray(0, length);
}

/**
 * RFC 8291 §3.3. 두 공개키를 붙여 만든 정보로 공유 비밀을 묶는다.
 * 이 값이 없으면 다른 구독의 키로 복호화가 될 수 있다.
 */
function deriveKeyInfo(userAgentPublicKey, serverPublicKey) {
  return Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    userAgentPublicKey,
    serverPublicKey,
  ]);
}

export function encryptPayload({
  payload,
  userAgentPublicKey,
  authSecret,
  randomBytes = nodeRandomBytes,
  // 시험값 검증용. 평소에는 매번 새 임시 키를 만든다.
  createEphemeralKeys = () => {
    const ecdh = createECDH(P256);
    ecdh.generateKeys();
    return ecdh;
  },
}) {
  const plaintext = Buffer.from(String(payload), "utf8");
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new WebPushError(
      "PAYLOAD_TOO_LARGE",
      `payload must be at most ${MAX_PAYLOAD_BYTES} bytes`,
    );
  }
  const uaPublic = base64UrlDecode(userAgentPublicKey);
  if (uaPublic.length !== PUBLIC_KEY_BYTES || uaPublic[0] !== 0x04) {
    throw new WebPushError("INVALID_SUBSCRIPTION", "p256dh must be an uncompressed P-256 point");
  }
  const auth = base64UrlDecode(authSecret);
  if (auth.length !== AUTH_SECRET_BYTES) {
    throw new WebPushError("INVALID_SUBSCRIPTION", "auth secret must be 16 bytes");
  }

  const ecdh = createEphemeralKeys();
  const serverPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  // 단말의 auth 비밀을 소금으로 써서 공유 비밀을 한 번 더 묶는다.
  const ikm = hkdf(auth, sharedSecret, deriveKeyInfo(uaPublic, serverPublic), 32);
  const salt = Buffer.from(randomBytes(SALT_BYTES));
  const contentEncryptionKey = hkdf(
    salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), AES_KEY_BYTES,
  );
  const nonce = hkdf(
    salt, ikm, Buffer.from("Content-Encoding: nonce\0", "utf8"), NONCE_BYTES,
  );

  // 마지막(이자 유일한) 레코드라서 구분자는 0x02다.
  const cipher = createCipheriv("aes-128-gcm", contentEncryptionKey, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(SALT_BYTES + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_BYTES);
  header.writeUInt8(serverPublic.length, SALT_BYTES + 4);
  return Buffer.concat([header, serverPublic, ciphertext]);
}

/** VAPID 개인키(raw d)와 공개키(비압축 점)로 서명용 키를 복원한다. */
function importVapidPrivateKey(publicKey, privateKey) {
  const publicPoint = base64UrlDecode(publicKey);
  if (publicPoint.length !== PUBLIC_KEY_BYTES || publicPoint[0] !== 0x04) {
    throw new WebPushError("INVALID_VAPID_KEY", "VAPID public key must be an uncompressed P-256 point");
  }
  const d = base64UrlDecode(privateKey);
  if (d.length !== 32) {
    throw new WebPushError("INVALID_VAPID_KEY", "VAPID private key must be 32 bytes");
  }
  return createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: base64UrlEncode(publicPoint.subarray(1, 33)),
      y: base64UrlEncode(publicPoint.subarray(33, 65)),
      d: base64UrlEncode(d),
    },
  });
}

export function createVapidHeader({ endpoint, subject, publicKey, privateKey, now = Date.now }) {
  const audience = new URL(endpoint).origin;
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" }), "utf8"));
  const claims = base64UrlEncode(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(now() / 1000) + VAPID_TTL_SECONDS,
        sub: subject,
      }),
      "utf8",
    ),
  );
  const signingInput = `${header}.${claims}`;
  // JOSE는 DER이 아니라 r||s 원시 형식을 요구한다.
  const signature = createSign("sha256")
    .update(signingInput)
    .sign({ key: importVapidPrivateKey(publicKey, privateKey), dsaEncoding: "ieee-p1363" });
  return `vapid t=${signingInput}.${base64UrlEncode(signature)}, k=${publicKey}`;
}

export function createWebPushSender({
  publicKey,
  privateKey,
  subject,
  fetchImpl = globalThis.fetch,
  randomBytes = nodeRandomBytes,
  now = Date.now,
  timeoutMs = 8000,
} = {}) {
  const configured =
    typeof publicKey === "string" && publicKey.trim() !== "" &&
    typeof privateKey === "string" && privateKey.trim() !== "" &&
    typeof subject === "string" && subject.trim() !== "";

  return Object.freeze({
    configured,
    publicKey: configured ? publicKey.trim() : null,

    async send(subscription, payload, { ttlSeconds = 3600, urgency = "normal" } = {}) {
      if (!configured) {
        throw new WebPushError("PUSH_NOT_CONFIGURED", "VAPID keys are not configured");
      }
      const endpoint = subscription?.endpoint;
      if (typeof endpoint !== "string" || !/^https:\/\//u.test(endpoint)) {
        throw new WebPushError("INVALID_SUBSCRIPTION", "endpoint must be an https URL");
      }
      const body = encryptPayload({
        payload,
        userAgentPublicKey: subscription?.keys?.p256dh,
        authSecret: subscription?.keys?.auth,
        randomBytes,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: createVapidHeader({
              endpoint, subject: subject.trim(), publicKey: publicKey.trim(),
              privateKey: privateKey.trim(), now,
            }),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: String(ttlSeconds),
            Urgency: urgency,
          },
          body,
        });
      } catch (error) {
        throw new WebPushError("PUSH_UNREACHABLE", `push service is unreachable: ${error?.message ?? error}`);
      } finally {
        clearTimeout(timer);
      }
      // 404·410은 구독이 사라졌다는 뜻이다. 재시도하면 안 되고 지워야 한다.
      if (response.status === 404 || response.status === 410) {
        throw new WebPushError("SUBSCRIPTION_EXPIRED", "subscription is gone", {
          statusCode: response.status, expired: true,
        });
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new WebPushError(
          "PUSH_REJECTED",
          `push service responded with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
          { statusCode: response.status },
        );
      }
      return { statusCode: response.status };
    },
  });
}
