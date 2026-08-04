import { randomBytes as nodeRandomBytes } from "node:crypto";

import {
  DeviceBackupError,
  FixedWindowRateLimiter,
  IdempotencyStore,
  SessionManager,
  createClientIpResolver,
  createOpaqueId,
  generateAccountKey,
  hashNormalizedPayload,
  isValidIdempotencyKey,
  normalizeAccountKey,
} from "../infrastructure/index.js";
import { KnowledgeImageError } from "../application/knowledge-images.js";
import {
  ApiError,
  normalizeApiError,
  serializeApiError,
} from "./errors.js";

const DEFAULT_BODY_LIMIT_BYTES = 64 * 1_024;
const DEFAULT_PHOTO_BODY_LIMIT_BYTES = 14 * 1_024 * 1_024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const DEFAULT_RATE_LIMITS = Object.freeze({
  "locations.search": { limit: 30, windowMs: 60_000 },
  "locations.current": { limit: 10, windowMs: 60_000 },
  "farmmap.search": { limit: 10, windowMs: 60_000 },
  "analyses.create": { limit: 10, windowMs: 60_000 },
  "analyses.report": { limit: 5, windowMs: 60_000 },
  "analyses.assistant": { limit: 20, windowMs: 60_000 },
  "analyses.pestGuidance": { limit: 30, windowMs: 60_000 },
  "knowledgeImages.get": { limit: 60, windowMs: 60_000 },
  "health.preflight": { limit: 30, windowMs: 60_000 },
  "actions.list": { limit: 60, windowMs: 60_000 },
  "actions.sync": { limit: 10, windowMs: 60_000 },
  "actions.create": { limit: 20, windowMs: 60_000 },
  "actions.reconcile": { limit: 20, windowMs: 60_000 },
  "actions.update": { limit: 30, windowMs: 60_000 },
  "cropCycle.get": { limit: 60, windowMs: 60_000 },
  "cropCycle.put": { limit: 20, windowMs: 60_000 },
  "harvestWeather.get": { limit: 20, windowMs: 60_000 },
  "harvestAssessment.create": { limit: 6, windowMs: 60_000 },
  "parcel.get": { limit: 60, windowMs: 60_000 },
  "parcel.put": { limit: 10, windowMs: 60_000 },
  "satellite.get": { limit: 30, windowMs: 60_000 },
  "satellite.refresh": { limit: 5, windowMs: 60_000 },
  "photoUploads.create": { limit: 6, windowMs: 60_000 },
  "photos.list": { limit: 30, windowMs: 60_000 },
  "photos.create": { limit: 12, windowMs: 60_000 },
  "photos.compare": { limit: 12, windowMs: 60_000 },
  "photos.delete": { limit: 12, windowMs: 60_000 },
  "seasons.timeline": { limit: 30, windowMs: 60_000 },
  "seasons.complete": { limit: 6, windowMs: 60_000 },
  "reports.list": { limit: 30, windowMs: 60_000 },
  "reports.create": { limit: 12, windowMs: 60_000 },
  "reports.get": { limit: 30, windowMs: 60_000 },
});

const DEFAULT_IP_RATE_LIMITS = Object.freeze({
  "session.get": { limit: 30, windowMs: 60_000 },
  "locations.search": { limit: 30, windowMs: 60_000 },
  "locations.current": { limit: 10, windowMs: 60_000 },
  "farmmap.search": { limit: 10, windowMs: 60_000 },
  "analyses.create": { limit: 10, windowMs: 60_000 },
  "analyses.get": { limit: 60, windowMs: 60_000 },
  "analyses.report": { limit: 5, windowMs: 60_000 },
  "analyses.assistant": { limit: 20, windowMs: 60_000 },
  "analyses.pestGuidance": { limit: 30, windowMs: 60_000 },
  "knowledgeImages.get": { limit: 60, windowMs: 60_000 },
  "health.preflight": { limit: 30, windowMs: 60_000 },
  "actions.list": { limit: 60, windowMs: 60_000 },
  "actions.sync": { limit: 10, windowMs: 60_000 },
  "actions.create": { limit: 20, windowMs: 60_000 },
  "actions.reconcile": { limit: 20, windowMs: 60_000 },
  "actions.update": { limit: 30, windowMs: 60_000 },
  "cropCycle.get": { limit: 60, windowMs: 60_000 },
  "cropCycle.put": { limit: 20, windowMs: 60_000 },
  "harvestWeather.get": { limit: 20, windowMs: 60_000 },
  "harvestAssessment.create": { limit: 6, windowMs: 60_000 },
  "parcel.get": { limit: 60, windowMs: 60_000 },
  "parcel.put": { limit: 10, windowMs: 60_000 },
  "satellite.get": { limit: 30, windowMs: 60_000 },
  "satellite.refresh": { limit: 5, windowMs: 60_000 },
  "photoUploads.create": { limit: 6, windowMs: 60_000 },
  "photos.list": { limit: 30, windowMs: 60_000 },
  "photos.create": { limit: 12, windowMs: 60_000 },
  "photos.compare": { limit: 12, windowMs: 60_000 },
  "photos.delete": { limit: 12, windowMs: 60_000 },
  "seasons.timeline": { limit: 30, windowMs: 60_000 },
  "seasons.complete": { limit: 6, windowMs: 60_000 },
  "reports.list": { limit: 30, windowMs: 60_000 },
  "reports.create": { limit: 12, windowMs: 60_000 },
  "reports.get": { limit: 30, windowMs: 60_000 },
});

const ROUTES = Object.freeze([
  {
    name: "session.get",
    pattern: /^\/api\/session$/,
    methods: ["GET"],
  },
  {
    name: "locations.search",
    pattern: /^\/api\/locations$/,
    methods: ["GET"],
  },
  {
    name: "locations.current",
    pattern: /^\/api\/locations\/current$/,
    methods: ["POST"],
  },
  {
    name: "farmmap.search",
    pattern: /^\/api\/farmmap\/parcels\/search$/,
    methods: ["POST"],
  },
  {
    name: "analyses.create",
    pattern: /^\/api\/analyses$/,
    methods: ["POST"],
  },
  {
    name: "analyses.report",
    pattern: /^\/api\/analyses\/([^/]+)\/report$/,
    methods: ["POST"],
    parameter: "analysisId",
  },
  {
    name: "analyses.assistant",
    pattern: /^\/api\/analyses\/([^/]+)\/assistant$/,
    methods: ["POST"],
    parameter: "analysisId",
  },
  {
    name: "analyses.pestGuidance",
    pattern: /^\/api\/analyses\/([^/]+)\/pest-guidance$/,
    methods: ["GET"],
    parameter: "analysisId",
  },
  {
    // 흙톡 재배 참고 이미지. 경로 매개변수는 레지스트리 키라서 임의 URL을
    // 받지 않는다. 패턴에서 대문자·숫자·밑줄만 허용해 한 번 더 좁힌다.
    name: "knowledgeImages.get",
    pattern: /^\/api\/knowledge-images\/([A-Z][A-Z0-9_]{2,63})$/,
    methods: ["GET"],
    parameter: "imageId",
  },
  {
    name: "analyses.get",
    pattern: /^\/api\/analyses\/([^/]+)$/,
    methods: ["GET"],
    parameter: "analysisId",
  },
  {
    name: "backup.save",
    pattern: /^\/api\/device-backup$/,
    methods: ["POST"],
  },
  {
    name: "backup.restore",
    // 계정키를 URL·로그에 남기지 않으려고 본문으로 받는다.
    pattern: /^\/api\/device-backup\/restore$/,
    methods: ["POST"],
  },
  {
    name: "health.preflight",
    pattern: /^\/api\/health\/preflight$/,
    methods: ["GET"],
  },
  {
    name: "actions.list",
    pattern: /^\/api\/farms\/([^/]+)\/actions$/,
    methods: ["GET", "POST"],
    parameter: "farmId",
  },
  {
    name: "actions.sync",
    pattern: /^\/api\/farms\/([^/]+)\/actions\/rules\/sync$/,
    methods: ["POST"],
    parameter: "farmId",
  },
  {
    name: "actions.reconcile",
    pattern: /^\/api\/farms\/([^/]+)\/actions\/rules\/reconcile$/,
    methods: ["POST"],
    parameter: "farmId",
  },
  {
    name: "actions.update",
    pattern: /^\/api\/farms\/([^/]+)\/actions\/([^/]+)$/,
    methods: ["PATCH"],
    parameters: ["farmId", "actionId"],
  },
  {
    name: "cropCycle.get",
    pattern: /^\/api\/farms\/([^/]+)\/crops\/([^/]+)\/cycle$/,
    methods: ["GET", "PUT"],
    parameters: ["farmId", "cropId"],
  },
  {
    name: "harvestWeather.get",
    pattern: /^\/api\/farms\/([^/]+)\/crops\/([^/]+)\/harvest-weather$/,
    methods: ["GET"],
    parameters: ["farmId", "cropId"],
  },
  {
    name: "harvestAssessment.create",
    pattern: /^\/api\/farms\/([^/]+)\/harvest-assessments$/,
    methods: ["POST"],
    parameter: "farmId",
  },
  {
    name: "photoUploads.create",
    pattern: /^\/api\/farms\/([^/]+)\/photo-uploads$/,
    methods: ["POST"],
    parameter: "farmId",
  },
  {
    name: "photos.compare",
    pattern: /^\/api\/farms\/([^/]+)\/photos\/compare$/,
    methods: ["POST"],
    parameter: "farmId",
  },
  {
    name: "photos.delete",
    pattern: /^\/api\/farms\/([^/]+)\/photos\/([^/]+)$/,
    methods: ["DELETE"],
    parameters: ["farmId", "photoId"],
  },
  {
    name: "photos.list",
    pattern: /^\/api\/farms\/([^/]+)\/photos$/,
    methods: ["GET", "POST"],
    parameter: "farmId",
  },
  {
    name: "seasons.timeline",
    pattern: /^\/api\/farms\/([^/]+)\/seasons\/([^/]+)\/timeline$/,
    methods: ["GET"],
    parameters: ["farmId", "seasonId"],
  },
  {
    name: "seasons.complete",
    pattern: /^\/api\/farms\/([^/]+)\/seasons\/([^/]+)\/complete$/,
    methods: ["POST"],
    parameters: ["farmId", "seasonId"],
  },
  {
    name: "reports.get",
    pattern: /^\/api\/farms\/([^/]+)\/reports\/([^/]+)$/,
    methods: ["GET"],
    parameters: ["farmId", "reportId"],
  },
  {
    name: "reports.list",
    pattern: /^\/api\/farms\/([^/]+)\/reports$/,
    methods: ["GET", "POST"],
    parameter: "farmId",
  },
  {
    name: "parcel.get",
    pattern: /^\/api\/farms\/([^/]+)\/parcel$/,
    methods: ["GET", "PUT"],
    parameter: "farmId",
  },
  {
    name: "satellite.get",
    pattern: /^\/api\/farms\/([^/]+)\/satellite\/observations$/,
    methods: ["GET", "POST"],
    parameter: "farmId",
  },
]);

function normalizeAllowedOrigins(origins) {
  if (origins === undefined) {
    return new Set();
  }
  if (!Array.isArray(origins) && !(origins instanceof Set)) {
    throw new TypeError("allowedOrigins must be an array or Set");
  }
  const normalized = new Set();
  for (const origin of origins) {
    if (typeof origin !== "string" || origin.length === 0) {
      throw new TypeError("allowedOrigins entries must be non-empty strings");
    }
    if (origin === "null") {
      throw new TypeError("the opaque null origin cannot be allowlisted");
    }
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new TypeError(`invalid allowed origin: ${origin}`);
    }
    if (
      parsed.origin !== origin ||
      !["http:", "https:"].includes(parsed.protocol)
    ) {
      throw new TypeError(`allowed origin must be an exact HTTP(S) origin: ${origin}`);
    }
    normalized.add(origin);
  }
  return normalized;
}

function matchRoute(pathname) {
  for (const route of ROUTES) {
    const match = route.pattern.exec(pathname);
    if (!match) {
      continue;
    }
    const parameters = {};
    if (route.parameters) {
      route.parameters.forEach((parameter, index) => {
        try {
          parameters[parameter] = decodeURIComponent(match[index + 1]);
        } catch {
          parameters[parameter] = match[index + 1];
        }
      });
    } else if (route.parameter) {
      try {
        parameters[route.parameter] = decodeURIComponent(match[1]);
      } catch {
        parameters[route.parameter] = match[1];
      }
    }
    return { ...route, parameters };
  }
  return null;
}

function operationName(route, method) {
  if (!route) return "unmatched";
  const mutationNames = {
    "actions.list:POST": "actions.create",
    "cropCycle.get:PUT": "cropCycle.put",
    "parcel.get:PUT": "parcel.put",
    "satellite.get:POST": "satellite.refresh",
    "photos.list:POST": "photos.create",
    "reports.list:POST": "reports.create",
  };
  return mutationNames[`${route.name}:${method}`] ?? route.name;
}

function appendVary(res, value) {
  const current = res.getHeader("Vary");
  if (!current) {
    res.setHeader("Vary", value);
    return;
  }
  const values = String(current)
    .split(",")
    .map((item) => item.trim().toLowerCase());
  if (!values.includes(value.toLowerCase())) {
    res.setHeader("Vary", `${current}, ${value}`);
  }
}

function setSecurityHeaders(res, { production }) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  if (production) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
}

function setCorsHeaders(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Location, Retry-After, X-Request-Id",
  );
  appendVary(res, "Origin");
}

function sendJson(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  const serialized = JSON.stringify(body);
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) {
      res.setHeader(name, value);
    }
  }
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(serialized));
  res.end(serialized);
}

function sendImage(res, { contentType, body, cacheSeconds }) {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", body.length);
  // setSecurityHeaders가 걸어 둔 no-store를 이미지에만 완화한다. 검수된 참고
  // 이미지는 사용자별 자료가 아니므로 브라우저가 다시 받지 않아도 된다.
  res.setHeader("Cache-Control", `private, max-age=${cacheSeconds}`);
  res.end(body);
}

function sendEmpty(res, status) {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  res.statusCode = status;
  res.setHeader("Content-Length", "0");
  res.end();
}

function ensureJsonContentType(req) {
  const contentType = req.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^(application\/json|application\/[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(
      contentType,
    )
  ) {
    throw new ApiError("INVALID_INPUT", {
      fieldErrors: {
        body: "Content-Type must be application/json.",
      },
    });
  }
}

function readJsonBody(req, limitBytes, signal) {
  ensureJsonContentType(req);
  const contentLength = req.headers["content-length"];
  if (
    typeof contentLength === "string" &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > limitBytes
  ) {
    req.resume();
    throw new ApiError("PAYLOAD_TOO_LARGE");
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteLength = 0;
    let settled = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      signal?.removeEventListener("abort", onSignalAbort);
    };
    const fail = (error, drain = false) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (drain) {
        req.resume();
      }
      reject(error);
    };
    const onData = (chunk) => {
      byteLength += chunk.byteLength;
      if (byteLength > limitBytes) {
        fail(new ApiError("PAYLOAD_TOO_LARGE"), true);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (byteLength === 0) {
        reject(
          new ApiError("INVALID_INPUT", {
            fieldErrors: { body: "A JSON object is required." },
          }),
        );
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new ApiError("INVALID_INPUT", {
            fieldErrors: { body: "The JSON body must be an object." },
          });
        }
        resolve(parsed);
      } catch (error) {
        reject(
          error instanceof ApiError
            ? error
            : new ApiError("INVALID_INPUT", {
                fieldErrors: { body: "The JSON body is malformed." },
              }),
        );
      }
    };
    const onError = (error) => fail(error);
    const onAborted = () =>
      fail(new ApiError("INTERNAL_ERROR", { message: "Request aborted." }));
    const onSignalAbort = () => fail(signal.reason ?? new Error("aborted"));

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
    signal?.addEventListener("abort", onSignalAbort, { once: true });
  });
}

function getHeader(req, name) {
  const value = req.headers[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

function normalizeRateLimit(config, routeName, defaults = DEFAULT_RATE_LIMITS) {
  const defaultValue = defaults[routeName];
  const override = config?.[routeName];
  if (override === false || (!defaultValue && override === undefined)) {
    return null;
  }
  if (typeof override === "number") {
    return {
      limit: override,
      windowMs: defaultValue?.windowMs ?? 60_000,
    };
  }
  return {
    ...defaultValue,
    ...(override ?? {}),
  };
}

function selectIpRateConfig(config, routeName) {
  if (
    config.ipRateLimits &&
    Object.hasOwn(config.ipRateLimits, routeName)
  ) {
    return config.ipRateLimits;
  }
  return config.rateLimits;
}

async function consumeRateLimit(rateLimiter, key, rateLimit) {
  if (!rateLimit) {
    return null;
  }
  return Promise.resolve(rateLimiter.consume(key, rateLimit));
}

function enforceRateLimitOutcome(res, outcome) {
  if (!outcome.allowed) {
    res.setHeader("Retry-After", String(outcome.retryAfterSeconds));
    throw new ApiError("RATE_LIMITED");
  }
}

async function enforceRateLimit(res, rateLimiter, key, rateLimit) {
  const outcome = await consumeRateLimit(rateLimiter, key, rateLimit);
  if (outcome) {
    enforceRateLimitOutcome(res, outcome);
  }
}

function createAbortContext(req, res, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new ApiError("REQUEST_TIMEOUT"));
  }, timeoutMs);
  timeout.unref?.();

  const abortForDisconnect = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort(new Error("client disconnected"));
    }
  };
  req.once("aborted", abortForDisconnect);
  res.once("close", abortForDisconnect);

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cleanup() {
      clearTimeout(timeout);
      req.off("aborted", abortForDisconnect);
      res.off("close", abortForDisconnect);
    },
  };
}

function invokeService(service, services, input, signal) {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => service.call(services, input))
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function assertServiceResult(value, predicate) {
  if (!predicate(value)) {
    throw new ApiError("INTERNAL_ERROR");
  }
  return value;
}

function logSafely(logger, level, payload) {
  try {
    const method =
      typeof logger?.[level] === "function"
        ? logger[level]
        : typeof logger?.info === "function"
          ? logger.info
          : null;
    method?.call(logger, payload);
  } catch {
    // Operational logging must never alter an API response.
  }
}

function validateServices(services) {
  if (!services || typeof services !== "object") {
    throw new TypeError("services must be an object");
  }
  for (const method of [
    "searchLocations",
    "createAnalysis",
    "getAnalysis",
    "requestReport",
    "getPreflight",
  ]) {
    if (typeof services[method] !== "function") {
      throw new TypeError(`services.${method} must be a function`);
    }
  }
  if (
    services.normalizeAnalysisInput !== undefined &&
    typeof services.normalizeAnalysisInput !== "function"
  ) {
    throw new TypeError(
      "services.normalizeAnalysisInput must be a function when provided",
    );
  }
}

export function createHttpHandler({
  services,
  featureServices = {},
  config = {},
  clock = Date.now,
  randomBytes = nodeRandomBytes,
  deviceBackup = null,
  knowledgeImages = null,
} = {}) {
  validateServices(services);
  validateFeatureServices(featureServices);
  if (typeof clock !== "function") {
    throw new TypeError("clock must be a function");
  }
  if (typeof randomBytes !== "function") {
    throw new TypeError("randomBytes must be a function");
  }

  const production =
    config.production ?? (config.nodeEnv === "production");
  const allowedOrigins = normalizeAllowedOrigins(config.allowedOrigins);
  const bodyLimitBytes =
    config.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  const requestTimeoutMs =
    config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(bodyLimitBytes) || bodyLimitBytes <= 0) {
    throw new TypeError("bodyLimitBytes must be a positive integer");
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new TypeError("requestTimeoutMs must be positive");
  }

  const sessionManager =
    config.sessionManager ??
    new SessionManager({
      clock,
      cookieName: config.sessionCookieName,
      csrfTtlMs: config.csrfTtlMs,
      production,
      randomBytes,
      secret: config.sessionSecret ?? config.sessionCookieSecret,
      secure: production || config.secureCookies === true,
      sessionTtlMs: config.sessionTtlMs,
      maxEntries: config.sessionMaxEntries,
      store: config.sessionStore,
    });
  const rateLimiter =
    config.rateLimiter ??
    new FixedWindowRateLimiter({
      clock,
      maxEntries: config.rateLimitMaxEntries,
    });
  const idempotencyStore =
    config.idempotencyStore ??
    new IdempotencyStore({
      clock,
      maxEntries: config.idempotencyMaxEntries,
      ttlMs: config.idempotencyTtlMs,
    });
  const logger = config.logger ?? console;
  if (
    config.trustedProxy !== undefined &&
    config.trustProxy !== undefined
  ) {
    throw new TypeError(
      "configure trustedProxy only; trustProxy is a legacy option",
    );
  }
  const resolveClientIp = createClientIpResolver(
    config.trustedProxy ?? config.trustProxy,
  );

  return async function httpHandler(req, res) {
    const startedAt = clock();
    const requestId = createOpaqueId(randomBytes, 16);
    let routeName = "unmatched";
    let errorCode;
    setSecurityHeaders(res, { production });
    res.setHeader("X-Request-Id", requestId);

    res.once("finish", () => {
      logSafely(logger, errorCode === "INTERNAL_ERROR" ? "error" : "info", {
        requestId,
        method: req.method,
        route: routeName,
        statusCode: res.statusCode,
        durationMs: Math.max(0, clock() - startedAt),
        ...(errorCode ? { errorCode } : {}),
      });
    });

    let abortContext;
    let idempotencyToken;
    try {
      let url;
      try {
        url = new URL(req.url ?? "/", "http://transport.invalid");
      } catch {
        throw new ApiError("INVALID_INPUT");
      }
      const route = matchRoute(url.pathname);
      routeName = operationName(route, req.method);

      let clientIp;
      let ingressRateOutcome;
      if (route) {
        clientIp = resolveClientIp(req);
        const ipRateLimit = normalizeRateLimit(
          selectIpRateConfig(config, routeName),
          routeName,
          DEFAULT_IP_RATE_LIMITS,
        );
        ingressRateOutcome = await consumeRateLimit(
          rateLimiter,
          JSON.stringify(["ip", routeName, clientIp]),
          ipRateLimit,
        );
      }

      const origin = getHeader(req, "origin");
      const originAllowed = origin
        ? allowedOrigins.has(origin)
        : false;
      if (originAllowed) {
        setCorsHeaders(res, origin);
      }
      if (ingressRateOutcome) {
        enforceRateLimitOutcome(res, ingressRateOutcome);
      }
      if (origin && !originAllowed) {
        throw new ApiError(
          isMutationMethod(req.method) ? "CSRF_REJECTED" : "ORIGIN_REJECTED",
        );
      }

      if (!route) {
        throw new ApiError("NOT_FOUND");
      }

      if (req.method === "OPTIONS") {
        if (!originAllowed) {
          throw new ApiError("ORIGIN_REJECTED");
        }
        res.setHeader(
          "Access-Control-Allow-Methods",
          `${route.methods.join(", ")}, OPTIONS`,
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Idempotency-Key, X-CSRF-Token",
        );
        res.setHeader("Access-Control-Max-Age", "600");
        sendEmpty(res, 204);
        return;
      }

      if (!route.methods.includes(req.method)) {
        res.setHeader("Allow", `${route.methods.join(", ")}, OPTIONS`);
        throw new ApiError("METHOD_NOT_ALLOWED");
      }

      abortContext = createAbortContext(req, res, requestTimeoutMs);

      const { session, setCookie } = await sessionManager.resolve(
        getHeader(req, "cookie"),
      );
      if (setCookie) {
        res.setHeader("Set-Cookie", setCookie);
      }

      const rateLimit = normalizeRateLimit(config.rateLimits, routeName);
      await enforceRateLimit(
        res,
        rateLimiter,
        JSON.stringify([
          "session-ip",
          routeName,
          session.id,
          clientIp,
        ]),
        rateLimit,
      );

      if (isMutationMethod(req.method)) {
        if (
          !origin ||
          !allowedOrigins.has(origin) ||
          !sessionManager.validateCsrf(
            session,
            getHeader(req, "x-csrf-token"),
          )
        ) {
          throw new ApiError("CSRF_REJECTED");
        }
      }

      const serviceContext = {
        ownerSessionId: session.id,
        requestId,
        signal: abortContext.signal,
      };

      if (route.name === "session.get") {
        sendJson(res, 200, sessionManager.csrfDetails(session));
        return;
      }

      if (route.name === "locations.search") {
        const values = url.searchParams.getAll("q");
        const query = values[0]?.trim();
        if (
          values.length !== 1 ||
          !query ||
          query.length > (config.locationQueryMaxLength ?? 200)
        ) {
          throw new ApiError("INVALID_INPUT", {
            fieldErrors: {
              q: "Provide one non-empty q value of at most 200 characters.",
            },
          });
        }
        const result = await invokeService(
          services.searchLocations,
          services,
          { ...serviceContext, query },
          abortContext.signal,
        );
        assertServiceResult(
          result,
          (value) => value && Array.isArray(value.candidates),
        );
        sendJson(res, 200, result);
        return;
      }

      if (route.name === "locations.current") {
        const body = await readJsonBody(
          req,
          config.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
          abortContext.signal,
        );
        const { latitude, longitude } = body;
        if (
          typeof latitude !== "number" ||
          !Number.isFinite(latitude) ||
          latitude < 32 ||
          latitude > 39.5 ||
          typeof longitude !== "number" ||
          !Number.isFinite(longitude) ||
          longitude < 123 ||
          longitude > 133
        ) {
          throw new ApiError("INVALID_INPUT", {
            fieldErrors: {
              location:
                "Provide finite latitude and longitude within the supported area.",
            },
          });
        }
        const result = await invokeService(
          services.resolveCurrentLocation,
          services,
          { ...serviceContext, latitude, longitude },
          abortContext.signal,
        );
        assertServiceResult(
          result,
          (value) => value && Array.isArray(value.candidates),
        );
        sendJson(res, 200, result);
        return;
      }

      if (route.name === "farmmap.search") {
        const body = await readJsonBody(
          req,
          config.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
          abortContext.signal,
        );
        const allowedKeys = new Set(["analysisId", "radiusMeters"]);
        if (
          !body ||
          Array.isArray(body) ||
          Object.keys(body).some((key) => !allowedKeys.has(key)) ||
          typeof body.analysisId !== "string" ||
          !body.analysisId.trim() ||
          (body.radiusMeters !== undefined &&
            (!Number.isFinite(body.radiusMeters) ||
              body.radiusMeters < 50 ||
              body.radiusMeters > 1_000))
        ) {
          throw new ApiError("INVALID_INPUT");
        }
        const result = await invokeService(
          services.searchFarmmapParcels,
          services,
          {
            ...serviceContext,
            analysisId: body.analysisId.trim(),
            radiusMeters: body.radiusMeters ?? 250,
          },
          abortContext.signal,
        );
        if (!result) throw new ApiError("ANALYSIS_NOT_FOUND");
        assertServiceResult(
          result,
          (value) => value && Array.isArray(value.candidates),
        );
        sendJson(res, 200, result);
        return;
      }

      if (route.name === "analyses.create") {
        const input = await readJsonBody(
          req,
          bodyLimitBytes,
          abortContext.signal,
        );
        const analysisId = createOpaqueId(randomBytes, 16);
        const location = `/api/analyses/${analysisId}`;
        const idempotencyKey = getHeader(req, "idempotency-key");

        if (idempotencyKey !== undefined) {
          if (!isValidIdempotencyKey(idempotencyKey)) {
            throw new ApiError("INVALID_INPUT", {
              fieldErrors: {
                idempotencyKey:
                  "Idempotency-Key must be 1-64 visible ASCII characters.",
              },
            });
          }
          let normalizedInput = input;
          if (services.normalizeAnalysisInput) {
            normalizedInput = await invokeService(
              services.normalizeAnalysisInput,
              services,
              input,
              abortContext.signal,
            );
            assertServiceResult(
              normalizedInput,
              (value) =>
                value &&
                typeof value === "object" &&
                !Array.isArray(value),
            );
          }
          const beginning = await idempotencyStore.begin({
            ownerSessionId: session.id,
            route: route.name,
            key: idempotencyKey,
            payloadHash: hashNormalizedPayload(normalizedInput),
            location,
          });
          if (beginning.kind === "conflict") {
            throw new ApiError("IDEMPOTENCY_CONFLICT");
          }
          if (beginning.kind === "replay") {
            sendJson(
              res,
              beginning.response.status,
              beginning.response.body,
              {
                Location: beginning.response.location,
                "Idempotency-Replayed": "true",
              },
            );
            return;
          }
          if (beginning.kind === "in_progress") {
            const pendingId = beginning.location.split("/").at(-1);
            sendJson(
              res,
              202,
              { analysisId: pendingId, state: "PENDING" },
              { Location: beginning.location },
            );
            return;
          }
          idempotencyToken = beginning.token;
        }

        const result = await invokeService(
          services.createAnalysis,
          services,
          {
            ...serviceContext,
            analysisId,
            input,
          },
          abortContext.signal,
        );
        assertServiceResult(
          result,
          (value) =>
            value &&
            typeof value === "object" &&
            value.analysisId === analysisId,
        );

        const response = {
          status: 201,
          body: result,
          location,
        };
        if (idempotencyToken) {
          const completed = await idempotencyStore.complete(
            idempotencyToken,
            response,
          );
          if (!completed) {
            throw new ApiError("INTERNAL_ERROR");
          }
          idempotencyToken = undefined;
        }
        sendJson(res, response.status, response.body, {
          Location: response.location,
        });
        return;
      }

      if (route.name === "analyses.get") {
        const result = await invokeService(
          services.getAnalysis,
          services,
          {
            ...serviceContext,
            analysisId: route.parameters.analysisId,
          },
          abortContext.signal,
        );
        if (result === null || result === undefined) {
          throw new ApiError("ANALYSIS_NOT_FOUND");
        }
        assertServiceResult(
          result,
          (value) => value && typeof value === "object",
        );
        sendJson(res, 200, result);
        return;
      }

      if (route.name === "analyses.pestGuidance") {
        const pestService = featureServices.pestGuidance;
        if (!pestService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        const result = await pestService.getGuidance({
          ownerSessionId: session.id,
          analysisId: route.parameters.analysisId,
        });
        if (!result) throw new ApiError("ANALYSIS_NOT_FOUND");
        sendJson(res, 200, result);
        return;
      }

      if (route.name === "analyses.report") {
        const result = await invokeService(
          services.requestReport,
          services,
          {
            ...serviceContext,
            analysisId: route.parameters.analysisId,
          },
          abortContext.signal,
        );
        if (result === null || result === undefined) {
          throw new ApiError("ANALYSIS_NOT_FOUND");
        }
        assertServiceResult(
          result,
          (value) =>
            value &&
            typeof value === "object" &&
            typeof value.started === "boolean" &&
            value.analysis &&
            typeof value.analysis === "object",
        );
        sendJson(res, result.started ? 202 : 200, result.analysis, {
          Location: `/api/analyses/${route.parameters.analysisId}`,
        });
        return;
      }

      if (route.name === "analyses.assistant") {
        if (typeof services.answerAnalysisQuestion !== "function") {
          throw new ApiError("INTERNAL_ERROR");
        }
        const body = await readJsonBody(
          req,
          bodyLimitBytes,
          abortContext.signal,
        );
        const question =
          body && !Array.isArray(body) ? body.question : undefined;
        if (
          !body ||
          Array.isArray(body) ||
          Object.keys(body).some((key) => key !== "question") ||
          typeof question !== "string" ||
          question.trim().length === 0 ||
          question.length > 400
        ) {
          throw new ApiError("INVALID_INPUT", {
            fieldErrors: {
              question:
                "Provide one non-empty question of at most 400 characters.",
            },
          });
        }
        const result = await invokeService(
          services.answerAnalysisQuestion,
          services,
          {
            ...serviceContext,
            analysisId: route.parameters.analysisId,
            question,
          },
          abortContext.signal,
        );
        if (result === null || result === undefined) {
          throw new ApiError("ANALYSIS_NOT_FOUND");
        }
        assertServiceResult(
          result,
          (value) =>
            value &&
            typeof value.answer === "string" &&
            typeof value.mode === "string" &&
            value.grounded === true,
        );
        sendJson(res, 200, result);
        return;
      }

      if (route.name === "knowledgeImages.get") {
        if (!knowledgeImages || knowledgeImages.state !== "READY") {
          throw new ApiError("KNOWLEDGE_IMAGE_NOT_CONNECTED");
        }
        try {
          const image = await knowledgeImages.fetchImage(
            route.parameters.imageId,
            { signal: abortContext.signal },
          );
          sendImage(res, {
            contentType: image.contentType,
            body: image.body,
            cacheSeconds: config.knowledgeImageCacheSeconds ?? 86_400,
          });
          return;
        } catch (error) {
          if (error instanceof KnowledgeImageError) {
            throw new ApiError(error.code);
          }
          throw error;
        }
      }

      if (route.name === "backup.save" || route.name === "backup.restore") {
        if (!deviceBackup || deviceBackup.configured !== true) {
          throw new ApiError("BACKUP_NOT_CONFIGURED");
        }
        const body = await readJsonBody(
          req,
          config.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
          abortContext.signal,
        );
        try {
          if (route.name === "backup.save") {
            const accountKey =
              body.accountKey === undefined || body.accountKey === null
                ? generateAccountKey()
                : normalizeAccountKey(body.accountKey);
            const { savedAt } = await deviceBackup.save(accountKey, body.payload);
            sendJson(res, 200, { accountKey, savedAt });
            return;
          }
          const accountKey = normalizeAccountKey(body.accountKey);
          const { payload, savedAt } = await deviceBackup.load(accountKey);
          sendJson(res, 200, { payload, savedAt });
          return;
        } catch (error) {
          if (error instanceof DeviceBackupError) {
            throw new ApiError(error.code);
          }
          throw error;
        }
      }

      if (route.name === "health.preflight") {
        const result = await invokeService(
          services.getPreflight,
          services,
          {
            requestId,
            signal: abortContext.signal,
          },
          abortContext.signal,
        );
        assertServiceResult(
          result,
          (value) => value && typeof value === "object",
        );
        sendJson(res, 200, result);
        return;
      }

      if (route.name === "actions.list") {
        const actionService = featureServices.actionPlan;
        if (!actionService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        if (req.method === "GET") {
          const cropId = url.searchParams.get("cropId");
          const seasonId = url.searchParams.get("seasonId");
          const result = await actionService.listActions({
            accountId: session.id,
            farmId: route.parameters.farmId,
            cropId: cropId || null,
            seasonId: seasonId || null,
          });
          sendJson(res, 200, result);
          return;
        }
        const body = await readJsonBody(req, bodyLimitBytes, abortContext.signal);
        const idempotencyKey = requireIdempotencyHeader(req);
        const result = await actionService.createAction({
          accountId: session.id,
          farmId: route.parameters.farmId,
          draft: body.draft,
          ruleId: body.ruleId ?? null,
          projection: body.projection ?? null,
          confirmed: body.confirmed,
          idempotencyKey,
        });
        sendJson(res, result.created ? 201 : 200, result);
        return;
      }

      if (route.name === "actions.sync") {
        const actionService = featureServices.actionPlan;
        if (!actionService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        const body = await readJsonBody(req, bodyLimitBytes, abortContext.signal);
        const idempotencyKey = requireIdempotencyHeader(req);
        const result = await actionService.syncRuleActions({
          accountId: session.id,
          farmId: route.parameters.farmId,
          cropId: body.cropId,
          seasonId: body.seasonId,
          projections: body.projections,
          reconcile: body.reconcile !== false,
          idempotencyKey,
        });
        sendJson(res, 200, result);
        return;
      }

      if (route.name === "actions.reconcile") {
        const actionService = featureServices.actionPlan;
        if (!actionService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        const body = await readJsonBody(req, bodyLimitBytes, abortContext.signal);
        const result = await actionService.reconcileRuleActions({
          accountId: session.id,
          farmId: route.parameters.farmId,
          cropId: body.cropId,
          seasonId: body.seasonId,
          activeRuleIds: body.activeRuleIds,
          projection: body.projection,
          idempotencyKey: requireIdempotencyHeader(req),
        });
        sendJson(res, 200, result);
        return;
      }

      if (route.name === "actions.update") {
        const actionService = featureServices.actionPlan;
        if (!actionService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        const body = await readJsonBody(req, bodyLimitBytes, abortContext.signal);
        if (body.status !== undefined && body.snoozedUntil !== undefined) {
          throw new ApiError("INVALID_INPUT");
        }
        const common = {
          accountId: session.id,
          farmId: route.parameters.farmId,
          actionId: route.parameters.actionId,
          confirmed: body.confirmed,
          idempotencyKey: requireIdempotencyHeader(req),
        };
        const result = body.snoozedUntil !== undefined
          ? await actionService.snoozeAction({
              ...common,
              snoozedUntil: body.snoozedUntil,
            })
          : await actionService.updateActionStatus({
              ...common,
              status: body.status,
            });
        sendJson(res, 200, result);
        return;
      }

      if (route.name === "cropCycle.get") {
        const cropCycleService = featureServices.cropCycle;
        if (!cropCycleService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        if (req.method === "GET") {
          const seasonIds = url.searchParams.getAll("seasonId");
          const seasonId = seasonIds[0]?.trim();
          if (seasonIds.length !== 1 || !seasonId) {
            throw new ApiError("INVALID_INPUT", {
              fieldErrors: {
                seasonId: "Provide one non-empty seasonId value.",
              },
            });
          }
          const cycle = await cropCycleService.getCycle({
            ownerSessionId: session.id,
            farmId: route.parameters.farmId,
            cropId: route.parameters.cropId,
            seasonId,
          });
          if (!cycle) throw new ApiError("NOT_FOUND");
          sendJson(res, 200, { cycle });
          return;
        }

        const body = await readJsonBody(req, bodyLimitBytes, abortContext.signal);
        const allowedKeys = new Set([
          "seasonId",
          "anchorType",
          "anchorDate",
          "status",
          "userConfirmed",
        ]);
        if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
          throw new ApiError("INVALID_INPUT");
        }
        const cycle = await cropCycleService.putCycle({
          ownerSessionId: session.id,
          farmId: route.parameters.farmId,
          cropId: route.parameters.cropId,
          seasonId: body.seasonId,
          anchorType: body.anchorType,
          anchorDate: body.anchorDate,
          status: body.status,
          userConfirmed: body.userConfirmed,
        });
        sendJson(res, 200, { cycle });
        return;
      }

      if (route.name === "harvestAssessment.create") {
        const harvestService = featureServices.harvestAssessment;
        if (!harvestService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        const body = await readJsonBody(
          req,
          config.photoBodyLimitBytes ?? DEFAULT_PHOTO_BODY_LIMIT_BYTES,
          abortContext.signal,
        );
        const allowedKeys = new Set([
          "cropId",
          "seasonId",
          "mimeType",
          "dataBase64",
        ]);
        if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
          throw new ApiError("INVALID_INPUT");
        }
        const assessment = await harvestService.assessPhoto({
          ownerSessionId: session.id,
          farmId: route.parameters.farmId,
          cropId: body.cropId,
          seasonId: body.seasonId,
          mimeType: body.mimeType,
          dataBase64: body.dataBase64,
          signal: abortContext.signal,
        });
        sendJson(res, 200, { assessment });
        return;
      }

      if (route.name === "harvestWeather.get") {
        const harvestWeatherService = featureServices.harvestWeather;
        if (!harvestWeatherService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        const analysisIds = url.searchParams.getAll("analysisId");
        const seasonIds = url.searchParams.getAll("seasonId");
        const analysisId = analysisIds[0]?.trim();
        const seasonId = seasonIds[0]?.trim();
        if (
          analysisIds.length !== 1 ||
          seasonIds.length !== 1 ||
          !analysisId ||
          !seasonId
        ) {
          throw new ApiError("INVALID_INPUT", {
            fieldErrors: {
              analysisId: "Provide one non-empty analysisId value.",
              seasonId: "Provide one non-empty seasonId value.",
            },
          });
        }
        const seasonWeather = await harvestWeatherService.getSeasonWeather({
          ownerSessionId: session.id,
          farmId: route.parameters.farmId,
          cropId: route.parameters.cropId,
          seasonId,
          analysisId,
          signal: abortContext.signal,
        });
        if (!seasonWeather) throw new ApiError("NOT_FOUND");
        sendJson(res, 200, { seasonWeather });
        return;
      }

      if (route.name === "parcel.get") {
        const satelliteService = featureServices.satellite;
        if (!satelliteService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        if (req.method === "GET") {
          const result = await satelliteService.getParcel({
            ownerSessionId: session.id,
            farmId: route.parameters.farmId,
          });
          sendJson(res, 200, { parcel: result });
          return;
        }
        const body = await readJsonBody(req, bodyLimitBytes, abortContext.signal);
        if (body.confirmed !== true) throw new ApiError("CONFIRMATION_REQUIRED");
        const result = await satelliteService.putParcel({
          ownerSessionId: session.id,
          farmId: route.parameters.farmId,
          geometry: body.geometry,
        });
        sendJson(res, 200, result);
        return;
      }

      if (route.name === "photoUploads.create") {
        const photoService = featureServices.photoSeason;
        if (!photoService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        const body = await readJsonBody(
          req,
          config.photoBodyLimitBytes ?? DEFAULT_PHOTO_BODY_LIMIT_BYTES,
          abortContext.signal,
        );
        const result = await photoService.prepareUpload({
          ownerSessionId: session.id,
          farmId: route.parameters.farmId,
          cropId: body.cropId,
          seasonId: body.seasonId,
          mimeType: body.mimeType,
          dataBase64: body.dataBase64,
        });
        sendJson(res, 201, result);
        return;
      }

      if (route.name === "photos.list") {
        const photoService = featureServices.photoSeason;
        if (!photoService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        if (req.method === "GET") {
          const cropId = url.searchParams.get("cropId");
          const seasonId = url.searchParams.get("seasonId");
          if (!cropId || !seasonId) throw new ApiError("INVALID_INPUT");
          const result = await photoService.getSeasonTimeline({
            ownerSessionId: session.id,
            farmId: route.parameters.farmId,
            cropId,
            seasonId,
          });
          sendJson(res, 200, result);
          return;
        }
        const body = await readJsonBody(req, bodyLimitBytes, abortContext.signal);
        const result = await photoService.addPhoto({
          ownerSessionId: session.id,
          farmId: route.parameters.farmId,
          cropId: body.cropId,
          seasonId: body.seasonId,
          uploadToken: body.uploadToken,
          observedAt: body.observedAt,
          growthStage: body.growthStage ?? null,
          note: body.note ?? null,
          consentState: body.consentState,
        });
        sendJson(res, 201, result);
        return;
      }

      if (route.name === "photos.compare") {
        const photoService = featureServices.photoSeason;
        if (!photoService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        const body = await readJsonBody(req, bodyLimitBytes, abortContext.signal);
        const result = await photoService.comparePhotos({
          ownerSessionId: session.id,
          farmId: route.parameters.farmId,
          cropId: body.cropId,
          seasonId: body.seasonId,
          baselinePhotoId: body.baselinePhotoId,
          currentPhotoId: body.currentPhotoId,
          observations: body.observations,
        });
        sendJson(res, 201, result);
        return;
      }

      if (route.name === "photos.delete") {
        const photoService = featureServices.photoSeason;
        if (!photoService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        const body = await readJsonBody(req, bodyLimitBytes, abortContext.signal);
        const result = await photoService.deletePhoto({
          ownerSessionId: session.id,
          farmId: route.parameters.farmId,
          photoId: route.parameters.photoId,
          confirmed: body.confirmed,
        });
        sendJson(res, 200, result);
        return;
      }

      if (route.name === "seasons.timeline") {
        const photoService = featureServices.photoSeason;
        if (!photoService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        const cropId = url.searchParams.get("cropId");
        if (!cropId) throw new ApiError("INVALID_INPUT");
        const result = await photoService.getSeasonTimeline({
          ownerSessionId: session.id,
          farmId: route.parameters.farmId,
          cropId,
          seasonId: route.parameters.seasonId,
        });
        sendJson(res, 200, result);
        return;
      }

      if (route.name === "seasons.complete") {
        const photoService = featureServices.photoSeason;
        if (!photoService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        const body = await readJsonBody(req, bodyLimitBytes, abortContext.signal);
        const result = await photoService.completeSeason({
          ownerSessionId: session.id,
          farmId: route.parameters.farmId,
          cropId: body.cropId,
          seasonId: route.parameters.seasonId,
          confirmed: body.confirmed,
        });
        sendJson(res, 200, result);
        return;
      }

      if (route.name === "reports.list") {
        const reportService = featureServices.reportHistory;
        if (!reportService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        if (req.method === "GET") {
          const cropId = url.searchParams.get("cropId");
          const reports = await reportService.listReports({
            ownerSessionId: session.id,
            farmId: route.parameters.farmId,
            cropId: cropId || null,
          });
          sendJson(res, 200, { reports });
          return;
        }
        const body = await readJsonBody(req, bodyLimitBytes, abortContext.signal);
        const result = await reportService.saveReport({
          ownerSessionId: session.id,
          farmId: route.parameters.farmId,
          analysisId: body.analysisId,
          cropId: body.cropId,
          seasonId: body.seasonId,
        });
        if (!result) throw new ApiError("ANALYSIS_NOT_FOUND");
        sendJson(res, 201, result);
        return;
      }

      if (route.name === "reports.get") {
        const reportService = featureServices.reportHistory;
        if (!reportService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        const report = await reportService.getReport({
          ownerSessionId: session.id,
          farmId: route.parameters.farmId,
          reportId: route.parameters.reportId,
        });
        if (!report) throw new ApiError("REPORT_NOT_FOUND");
        sendJson(res, 200, report);
        return;
      }

      if (route.name === "satellite.get") {
        const satelliteService = featureServices.satellite;
        if (!satelliteService) throw new ApiError("FEATURE_NOT_CONFIGURED");
        if (req.method === "GET") {
          const result = await satelliteService.getLatest({
            ownerSessionId: session.id,
            farmId: route.parameters.farmId,
          });
          sendJson(res, 200, { observation: result });
          return;
        }
        const body = await readJsonBody(req, bodyLimitBytes, abortContext.signal);
        if (body.confirmed !== true) throw new ApiError("CONFIRMATION_REQUIRED");
        try {
          const result = await satelliteService.refresh({
            ownerSessionId: session.id,
            farmId: route.parameters.farmId,
            signal: abortContext.signal,
          });
          sendJson(res, 200, result);
        } catch (error) {
          if (error?.message === "parcel is not registered for this farm") {
            throw new ApiError("PARCEL_REQUIRED", { cause: error });
          }
          if (error?.message === "satellite adapter is not configured") {
            throw new ApiError("FEATURE_NOT_CONFIGURED", { cause: error });
          }
          throw error;
        }
        return;
      }

      throw new ApiError("NOT_FOUND");
    } catch (caught) {
      if (idempotencyToken) {
        try {
          await idempotencyStore.fail(idempotencyToken);
        } catch {
          // A failed cleanup leaves the key in-progress until its TTL. This is
          // safer than allowing a duplicate mutation and must not mask the
          // original request error.
        }
      }
      if (
        abortContext?.signal.aborted &&
        !abortContext.timedOut &&
        (res.destroyed || !res.writable)
      ) {
        return;
      }
      const error = abortContext?.timedOut
        ? new ApiError("REQUEST_TIMEOUT")
        : normalizeApiError(caught);
      errorCode = error.code;
      sendJson(res, error.status, serializeApiError(error, requestId));
    } finally {
      abortContext?.cleanup();
    }
  };
}

function validateFeatureServices(featureServices) {
  if (!featureServices || typeof featureServices !== "object") {
    throw new TypeError("featureServices must be an object");
  }
  if (featureServices.actionPlan !== undefined) {
    for (const method of [
      "listActions",
      "createAction",
      "syncRuleActions",
      "reconcileRuleActions",
      "snoozeAction",
      "updateActionStatus",
    ]) {
      if (typeof featureServices.actionPlan?.[method] !== "function") {
        throw new TypeError(`featureServices.actionPlan.${method} must be a function`);
      }
    }
  }
  if (featureServices.cropCycle !== undefined) {
    for (const method of ["getCycle", "putCycle"]) {
      if (typeof featureServices.cropCycle?.[method] !== "function") {
        throw new TypeError(`featureServices.cropCycle.${method} must be a function`);
      }
    }
  }
  if (featureServices.harvestWeather !== undefined) {
    if (typeof featureServices.harvestWeather?.getSeasonWeather !== "function") {
      throw new TypeError(
        "featureServices.harvestWeather.getSeasonWeather must be a function",
      );
    }
  }
  if (featureServices.pestGuidance !== undefined) {
    if (typeof featureServices.pestGuidance?.getGuidance !== "function") {
      throw new TypeError("featureServices.pestGuidance.getGuidance must be a function");
    }
  }
  if (featureServices.satellite !== undefined) {
    for (const method of ["putParcel", "getParcel", "getLatest", "refresh"]) {
      if (typeof featureServices.satellite?.[method] !== "function") {
        throw new TypeError(`featureServices.satellite.${method} must be a function`);
      }
    }
  }
  if (featureServices.photoSeason !== undefined) {
    for (const method of [
      "prepareUpload",
      "addPhoto",
      "comparePhotos",
      "deletePhoto",
      "getSeasonTimeline",
      "completeSeason",
    ]) {
      if (typeof featureServices.photoSeason?.[method] !== "function") {
        throw new TypeError(`featureServices.photoSeason.${method} must be a function`);
      }
    }
  }
  if (featureServices.reportHistory !== undefined) {
    for (const method of ["saveReport", "listReports", "getReport"]) {
      if (typeof featureServices.reportHistory?.[method] !== "function") {
        throw new TypeError(`featureServices.reportHistory.${method} must be a function`);
      }
    }
  }
}

function isMutationMethod(method) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method);
}

function requireIdempotencyHeader(req) {
  const key = getHeader(req, "idempotency-key");
  if (!isValidIdempotencyKey(key)) {
    throw new ApiError("INVALID_INPUT", {
      fieldErrors: {
        idempotencyKey:
          "Idempotency-Key must be 1-64 visible ASCII characters.",
      },
    });
  }
  return key;
}

export const httpDefaults = Object.freeze({
  bodyLimitBytes: DEFAULT_BODY_LIMIT_BYTES,
  photoBodyLimitBytes: DEFAULT_PHOTO_BODY_LIMIT_BYTES,
  ipRateLimits: DEFAULT_IP_RATE_LIMITS,
  rateLimits: DEFAULT_RATE_LIMITS,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
});
