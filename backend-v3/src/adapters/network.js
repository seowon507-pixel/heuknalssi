import {
  AdapterError,
  DeadlineExceededError,
  classifyProviderError,
  toAdapterError
} from "./errors.js";

export const PROVIDER_HOST_ALLOWLIST = Object.freeze({
  KAKAO: Object.freeze(["dapi.kakao.com"]),
  KMA: Object.freeze(["apis.data.go.kr", "apihub.kma.go.kr"]),
  SOIL_V2: Object.freeze(["apis.data.go.kr"]),
  SOIL_FIELD_V3: Object.freeze(["apis.data.go.kr"]),
  SOIL_EXAM_V2: Object.freeze(["apis.data.go.kr"]),
  SMARTFARM: Object.freeze([
    "smartfarmkorea.net",
    "www.smartfarmkorea.net"
  ]),
  GOOGLE_AI: Object.freeze(["generativelanguage.googleapis.com"])
});
export const DEFAULT_PROVIDER_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

export function assertAllowedProviderUrl(urlValue, provider) {
  const hosts = PROVIDER_HOST_ALLOWLIST[provider];
  if (!hosts) {
    throw new TypeError(`Unknown provider allowlist: ${provider}`);
  }

  let url;
  try {
    url = new URL(urlValue);
  } catch {
    throw new TypeError("Provider URL must be a valid absolute URL.");
  }

  if (url.protocol !== "https:") {
    throw new TypeError("Provider URL must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new TypeError("Provider URL must not contain user information.");
  }
  if (url.port && url.port !== "443") {
    throw new TypeError("Provider URL must use the default HTTPS port.");
  }
  if (!hosts.includes(url.hostname.toLowerCase())) {
    throw new TypeError("Provider URL host is not on the fixed allowlist.");
  }
  url.hash = "";
  return url;
}

export function providerDisclosureUrl(urlValue, provider) {
  const url = assertAllowedProviderUrl(urlValue, provider);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function deadlineMilliseconds(deadlineAt) {
  if (deadlineAt === null || deadlineAt === undefined) return Infinity;
  if (typeof deadlineAt === "number") return deadlineAt;
  if (deadlineAt instanceof Date) return deadlineAt.getTime();
  return Date.parse(deadlineAt);
}

function linkAbortSignal(parentSignal, controller) {
  if (!parentSignal) return () => {};
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) {
    abort();
    return () => {};
  }
  parentSignal.addEventListener("abort", abort, { once: true });
  return () => parentSignal.removeEventListener("abort", abort);
}

/**
 * Runs an operation under both a per-provider timeout and an overall request
 * deadline. Parent cancellation is forwarded to the child signal.
 */
export async function runWithDeadline(
  operation,
  {
    signal: parentSignal,
    timeoutMs,
    deadlineAt,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout
  } = {}
) {
  if (typeof operation !== "function") {
    throw new TypeError("operation must be a function.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive finite number.");
  }

  const overallDeadline = deadlineMilliseconds(deadlineAt);
  if (Number.isNaN(overallDeadline)) {
    throw new TypeError("deadlineAt must be a valid timestamp.");
  }
  const remaining = Math.min(timeoutMs, overallDeadline - now());
  if (!(remaining > 0)) {
    throw new DeadlineExceededError();
  }
  if (parentSignal?.aborted) {
    throw parentSignal.reason ?? new DOMException("Aborted", "AbortError");
  }

  const controller = new AbortController();
  const unlink = linkAbortSignal(parentSignal, controller);
  let timedOut = false;
  const timer = setTimer(() => {
    timedOut = true;
    controller.abort(new DeadlineExceededError());
  }, remaining);

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new DeadlineExceededError(undefined, { cause: error });
    }
    if (parentSignal?.aborted) {
      throw parentSignal.reason ?? error;
    }
    throw error;
  } finally {
    clearTimer(timer);
    unlink();
  }
}

export function fetchWithDeadline({
  fetchImpl = globalThis.fetch,
  url,
  provider,
  requestInit = {},
  signal,
  timeoutMs,
  deadlineAt,
  now
}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }
  const allowedUrl = assertAllowedProviderUrl(url, provider);
  return runWithDeadline(
    (childSignal) =>
      fetchImpl(allowedUrl, {
        ...requestInit,
        redirect: "error",
        signal: childSignal
      }),
    { signal, timeoutMs, deadlineAt, now }
  );
}

function canWait(delayMs, deadlineAt, now) {
  if (!Number.isFinite(delayMs) || delayMs < 0) return false;
  const deadline = deadlineMilliseconds(deadlineAt);
  const nowMs = Number(now());
  if (!Number.isFinite(nowMs)) return false;
  return deadline === Infinity || nowMs + delayMs < deadline;
}

function defaultRetryBackoff({ baseDelayMs, random }) {
  const jitter = random();
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new TypeError("retry jitter source must return a number from 0 to 1.");
  }
  return Math.max(0, Math.round(baseDelayMs * (0.5 + jitter)));
}

async function abortableDelay(delayMs, signal) {
  if (delayMs <= 0) return;
  await new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function providerHttpError(response, classified) {
  return new AdapterError("Provider returned an unsuccessful HTTP status.", {
    ...classified
  });
}

function responseTooLargeError() {
  return new AdapterError("Provider response exceeded the configured byte limit.", {
    adapterState: "SCHEMA_CHANGED",
    code: "PROVIDER_RESPONSE_TOO_LARGE",
    retryable: false
  });
}

function responseContentLength(response) {
  const raw = response?.headers?.get?.("content-length");
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : null;
}

async function readBoundedResponse(response, { maxBytes, responseType }) {
  const contentLength = responseContentLength(response);
  if (contentLength !== null && contentLength > maxBytes) {
    throw responseTooLargeError();
  }

  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw responseTooLargeError();
        }
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      reader.releaseLock();
    }
    return {
      text: Buffer.concat(chunks, totalBytes).toString("utf8"),
      parsed: false
    };
  }

  if (typeof response?.text === "function") {
    const text = await response.text();
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text, "utf8") > maxBytes
    ) {
      throw responseTooLargeError();
    }
    return { text, parsed: false };
  }

  // Test doubles and legacy fetch shims sometimes expose only json(). Real
  // Fetch Response objects take the streaming branch above, which enforces the
  // limit before buffering the whole provider response.
  if (responseType === "json" && typeof response?.json === "function") {
    const value = await response.json();
    const serialized = JSON.stringify(value);
    if (
      typeof serialized !== "string" ||
      Buffer.byteLength(serialized, "utf8") > maxBytes
    ) {
      throw responseTooLargeError();
    }
    return { value, parsed: true };
  }

  throw new AdapterError("fetch returned an unreadable response object.", {
    adapterState: "INTERNAL_ERROR",
    code: "INVALID_FETCH_RESPONSE",
    retryable: false
  });
}

/**
 * Fetches JSON with the limited retry policy from §21.2. It never includes a
 * response body in an error object.
 */
export async function requestProviderJson({
  fetchImpl = globalThis.fetch,
  url,
  provider,
  requestInit = {},
  signal,
  timeoutMs,
  deadlineAt,
  now = () => Date.now(),
  networkRetryDelayMs = 15,
  retryBackoff = defaultRetryBackoff,
  random = Math.random,
  delay = abortableDelay,
  maxResponseBytes = DEFAULT_PROVIDER_RESPONSE_MAX_BYTES,
  responseType = "json"
}) {
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new TypeError("maxResponseBytes must be a positive integer.");
  }
  if (responseType !== "json" && responseType !== "text") {
    throw new TypeError("responseType must be json or text.");
  }
  const requestStartedAt = Number(now());
  if (!Number.isFinite(requestStartedAt)) {
    throw new TypeError("Provider request clock is invalid.");
  }
  const requestDeadlineAt =
    deadlineAt ?? requestStartedAt + timeoutMs;

  let attempt = 0;
  while (attempt < 2) {
    try {
      return await runWithDeadline(
        async (childSignal) => {
          const allowedUrl = assertAllowedProviderUrl(url, provider);
          const response = await fetchImpl(allowedUrl, {
            ...requestInit,
            redirect: "error",
            signal: childSignal
          });
          if (!response || typeof response.ok !== "boolean") {
            throw new AdapterError("fetch returned an invalid response object.", {
              adapterState: "INTERNAL_ERROR",
              code: "INVALID_FETCH_RESPONSE",
              retryable: false
            });
          }
          if (!response.ok) {
            const classified = classifyProviderError(response, { now });
            throw providerHttpError(response, classified);
          }
          const bounded = await readBoundedResponse(response, {
            maxBytes: maxResponseBytes,
            responseType
          });
          if (responseType === "text") {
            return bounded.text;
          }
          if (bounded.parsed) return bounded.value;
          try {
            return JSON.parse(bounded.text);
          } catch {
            throw new AdapterError("Provider response was not valid JSON.", {
              adapterState: "SCHEMA_CHANGED",
              code: "PROVIDER_INVALID_JSON",
              retryable: false
            });
          }
        },
        { signal, timeoutMs, deadlineAt: requestDeadlineAt, now }
      );
    } catch (error) {
      const adapterError = toAdapterError(error, { now });
      if (!adapterError.retryable || attempt >= 1) throw adapterError;

      let delayMs;
      if (adapterError.adapterState === "RATE_LIMITED") {
        delayMs = adapterError.retryAfterMs;
      } else {
        delayMs = retryBackoff({
          attempt: attempt + 1,
          baseDelayMs: networkRetryDelayMs,
          random,
          adapterState: adapterError.adapterState,
          code: adapterError.code
        });
      }
      if (!canWait(delayMs, requestDeadlineAt, now)) throw adapterError;
      await delay(delayMs, signal);
      attempt += 1;
    }
  }

  throw new AdapterError("Provider request failed.", {
    adapterState: "INTERNAL_ERROR",
    code: "PROVIDER_NETWORK_ERROR",
    retryable: false
  });
}

export function requestProviderText(options = {}) {
  return requestProviderJson({
    ...options,
    responseType: "text"
  });
}
