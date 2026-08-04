import {
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";

import { createOpaqueId } from "./opaque-id.js";
import { TtlMemoryStore } from "./ttl-memory-store.js";

const DEFAULT_CSRF_TTL_MS = 60 * 60 * 1_000;
// 비회원 농가도 한 작기를 수개월 추적한다. 세션을 하루 만에 바꾸면
// 세션 소유권으로 격리한 재배일정·행동 기록을 다시 찾을 수 없으므로,
// 저장 데이터의 2년 수명과 동일하게 유지한다.
const DEFAULT_SESSION_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_SESSIONS = 10_000;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function defaultClock() {
  return Date.now();
}

function parseCookies(header) {
  const cookies = new Map();
  if (typeof header !== "string") {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && !cookies.has(name)) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function normalizeSecret(secret) {
  if (secret === undefined || secret === null) {
    return null;
  }
  if (typeof secret === "string") {
    return Buffer.from(secret, "utf8");
  }
  if (ArrayBuffer.isView(secret) || secret instanceof ArrayBuffer) {
    return Buffer.from(secret);
  }
  throw new TypeError("session secret must be a string or byte buffer");
}

export class SessionManager {
  #clock;
  #cookieName;
  #csrfTtlMs;
  #randomBytes;
  #secret;
  #secure;
  #sessionTtlMs;
  #sessions;

  constructor({
    clock = defaultClock,
    cookieName = "hn_session",
    csrfTtlMs = DEFAULT_CSRF_TTL_MS,
    production = false,
    randomBytes = nodeRandomBytes,
    secret,
    secure = production,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    maxEntries = DEFAULT_MAX_SESSIONS,
    store,
  } = {}) {
    if (typeof clock !== "function") {
      throw new TypeError("clock must be a function");
    }
    if (typeof randomBytes !== "function") {
      throw new TypeError("randomBytes must be a function");
    }
    if (!COOKIE_NAME_PATTERN.test(cookieName)) {
      throw new TypeError("invalid session cookie name");
    }
    if (!Number.isFinite(csrfTtlMs) || csrfTtlMs <= 0) {
      throw new TypeError("csrfTtlMs must be positive");
    }
    if (!Number.isFinite(sessionTtlMs) || sessionTtlMs <= csrfTtlMs) {
      throw new TypeError("sessionTtlMs must be longer than csrfTtlMs");
    }

    let normalizedSecret = normalizeSecret(secret);
    if (!normalizedSecret) {
      if (production) {
        throw new Error("an explicit session secret is required in production");
      }
      normalizedSecret = Buffer.from(randomBytes(32));
    }
    if (normalizedSecret.byteLength < 32) {
      throw new Error("session secret must contain at least 32 bytes");
    }

    this.#clock = clock;
    this.#cookieName = cookieName;
    this.#csrfTtlMs = csrfTtlMs;
    this.#randomBytes = randomBytes;
    this.#secret = normalizedSecret;
    this.#secure = production || Boolean(secure);
    this.#sessionTtlMs = sessionTtlMs;
    this.#sessions =
      store ??
      new TtlMemoryStore({
        capacityPolicy: "reject",
        clock,
        maxEntries,
      });
  }

  async resolve(cookieHeader) {
    const signedCookie = parseCookies(cookieHeader).get(this.#cookieName);
    const sessionId = this.#verifyCookie(signedCookie);
    let session = sessionId
      ? await Promise.resolve(this.#sessions.get(sessionId))
      : undefined;
    let isNew = false;

    if (!session) {
      session = await this.#createAndStoreSession();
      isNew = true;
    } else if (session.csrfExpiresAt <= this.#clock()) {
      const expected = structuredClone(session);
      const rotated = this.#rotateSessionCsrf(session);
      if (typeof this.#sessions.compareAndSet === "function") {
        const replaced = await Promise.resolve(
          this.#sessions.compareAndSet(
            session.id,
            expected,
            rotated,
            this.#sessionTtlMs,
          ),
        );
        if (replaced) {
          session = rotated;
        } else {
          session = await Promise.resolve(this.#sessions.get(session.id));
          if (!session) {
            session = await this.#createAndStoreSession();
            isNew = true;
          }
        }
      } else {
        session = rotated;
        await Promise.resolve(
          this.#sessions.set(session.id, session, this.#sessionTtlMs),
        );
      }
    }

    if (!isNew && session.csrfExpiresAt > this.#clock()) {
      await Promise.resolve(
        this.#sessions.set(session.id, session, this.#sessionTtlMs),
      );
    }
    return {
      session,
      isNew,
      setCookie: isNew ? this.#serializeCookie(session.id) : null,
    };
  }

  csrfDetails(session) {
    return {
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.csrfExpiresAt).toISOString(),
    };
  }

  validateCsrf(session, token) {
    if (
      !session ||
      session.csrfExpiresAt <= this.#clock() ||
      typeof token !== "string"
    ) {
      return false;
    }
    const expected = Buffer.from(session.csrfToken, "utf8");
    const provided = Buffer.from(token, "utf8");
    return (
      expected.byteLength === provided.byteLength &&
      timingSafeEqual(expected, provided)
    );
  }

  async rotateCsrf(sessionId) {
    const session = await Promise.resolve(this.#sessions.get(sessionId));
    if (!session) {
      return undefined;
    }
    const rotated = this.#rotateSessionCsrf(session);
    if (typeof this.#sessions.compareAndSet === "function") {
      const replaced = await Promise.resolve(
        this.#sessions.compareAndSet(
          rotated.id,
          session,
          rotated,
          this.#sessionTtlMs,
        ),
      );
      if (!replaced) {
        return Promise.resolve(this.#sessions.get(sessionId));
      }
    } else {
      await Promise.resolve(
        this.#sessions.set(rotated.id, rotated, this.#sessionTtlMs),
      );
    }
    return rotated;
  }

  async #createAndStoreSession() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = this.#createSession();
      if (typeof this.#sessions.setIfAbsent === "function") {
        const inserted = await Promise.resolve(
          this.#sessions.setIfAbsent(
            session.id,
            session,
            this.#sessionTtlMs,
          ),
        );
        if (inserted) return session;
      } else {
        await Promise.resolve(
          this.#sessions.set(session.id, session, this.#sessionTtlMs),
        );
        return session;
      }
    }
    throw new Error("a unique session id could not be allocated");
  }

  #createSession() {
    const now = this.#clock();
    return {
      id: createOpaqueId(this.#randomBytes, 16),
      csrfToken: createOpaqueId(this.#randomBytes, 32),
      csrfExpiresAt: now + this.#csrfTtlMs,
      createdAt: now,
    };
  }

  #rotateSessionCsrf(session) {
    return {
      ...session,
      csrfToken: createOpaqueId(this.#randomBytes, 32),
      csrfExpiresAt: this.#clock() + this.#csrfTtlMs,
    };
  }

  #sign(sessionId) {
    return createHmac("sha256", this.#secret)
      .update(sessionId, "utf8")
      .digest("base64url");
  }

  #verifyCookie(value) {
    if (typeof value !== "string") {
      return null;
    }
    const separator = value.indexOf(".");
    if (separator <= 0 || separator !== value.lastIndexOf(".")) {
      return null;
    }
    const sessionId = value.slice(0, separator);
    const signature = value.slice(separator + 1);
    if (
      !/^[A-Za-z0-9_-]{22,}$/.test(sessionId) ||
      !/^[A-Za-z0-9_-]+$/.test(signature)
    ) {
      return null;
    }

    const expected = Buffer.from(this.#sign(sessionId), "utf8");
    const provided = Buffer.from(signature, "utf8");
    if (
      expected.byteLength !== provided.byteLength ||
      !timingSafeEqual(expected, provided)
    ) {
      return null;
    }
    return sessionId;
  }

  #serializeCookie(sessionId) {
    const parts = [
      `${this.#cookieName}=${sessionId}.${this.#sign(sessionId)}`,
      "Path=/",
      `Max-Age=${Math.floor(this.#sessionTtlMs / 1_000)}`,
      "HttpOnly",
      "SameSite=Lax",
    ];
    if (this.#secure) {
      parts.push("Secure");
    }
    return parts.join("; ");
  }
}

export const sessionDefaults = Object.freeze({
  csrfTtlMs: DEFAULT_CSRF_TTL_MS,
  maxEntries: DEFAULT_MAX_SESSIONS,
  sessionTtlMs: DEFAULT_SESSION_TTL_MS,
});
