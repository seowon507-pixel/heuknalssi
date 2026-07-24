const SAFE_STATES = new Set([
  "SUCCESS",
  "NO_DATA",
  "TIMEOUT",
  "RATE_LIMITED",
  "AUTH_ERROR",
  "SCHEMA_CHANGED",
  "UNSUPPORTED",
  "INTERNAL_ERROR"
]);

export class AdapterError extends Error {
  constructor(
    message,
    {
      adapterState = "INTERNAL_ERROR",
      code = "ADAPTER_ERROR",
      retryable = false,
      httpStatus = null,
      retryAfterMs = null,
      cause
    } = {}
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AdapterError";
    this.adapterState = SAFE_STATES.has(adapterState)
      ? adapterState
      : "INTERNAL_ERROR";
    this.code = code;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
  }
}

export class SchemaChangedError extends AdapterError {
  constructor(message = "Provider response did not match the frozen schema.", options = {}) {
    super(message, {
      ...options,
      adapterState: "SCHEMA_CHANGED",
      code: "PROVIDER_SCHEMA_CHANGED",
      retryable: false
    });
    this.name = "SchemaChangedError";
  }
}

export class UnsupportedContractError extends AdapterError {
  constructor(message = "The provider contract is not frozen or supported.", options = {}) {
    super(message, {
      ...options,
      adapterState: "UNSUPPORTED",
      code: "PROVIDER_CONTRACT_UNSUPPORTED",
      retryable: false
    });
    this.name = "UnsupportedContractError";
  }
}

export class NoDataError extends AdapterError {
  constructor(message = "The provider returned no data.", options = {}) {
    super(message, {
      ...options,
      adapterState: "NO_DATA",
      code: "PROVIDER_NO_DATA",
      retryable: false
    });
    this.name = "NoDataError";
  }
}

export class DeadlineExceededError extends AdapterError {
  constructor(message = "The provider request exceeded its deadline.", options = {}) {
    super(message, {
      ...options,
      adapterState: "TIMEOUT",
      code: "PROVIDER_TIMEOUT",
      retryable: true
    });
    this.name = "DeadlineExceededError";
  }
}

function parseRetryAfter(value, nowMs) {
  if (value === null || value === undefined || value === "") return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const dateMs = Date.parse(String(value));
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);

  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

/**
 * Converts provider failures to a small, safe classification. It deliberately
 * excludes response bodies, request URLs, credentials, and provider messages.
 */
export function classifyProviderError(input, { now = () => Date.now() } = {}) {
  if (input instanceof AdapterError) {
    return {
      adapterState: input.adapterState,
      code: input.code,
      retryable: input.retryable,
      httpStatus: input.httpStatus,
      retryAfterMs: input.retryAfterMs
    };
  }

  if (
    input?.name === "AbortError" ||
    input?.name === "TimeoutError" ||
    input?.code === "ABORT_ERR" ||
    input?.code === "ETIMEDOUT" ||
    input?.code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return {
      adapterState: "TIMEOUT",
      code: "PROVIDER_TIMEOUT",
      retryable: true,
      httpStatus: null,
      retryAfterMs: null
    };
  }

  const status = Number.isInteger(input?.status)
    ? input.status
    : Number.isInteger(input?.statusCode)
      ? input.statusCode
      : null;

  if (status === 401 || status === 403) {
    return {
      adapterState: "AUTH_ERROR",
      code: "PROVIDER_AUTH_ERROR",
      retryable: false,
      httpStatus: status,
      retryAfterMs: null
    };
  }

  if (status === 429) {
    return {
      adapterState: "RATE_LIMITED",
      code: "PROVIDER_RATE_LIMITED",
      retryable: true,
      httpStatus: status,
      retryAfterMs: parseRetryAfter(
        headerValue(input?.headers, "retry-after"),
        now()
      )
    };
  }

  if (status !== null && status >= 500 && status <= 599) {
    return {
      adapterState: "INTERNAL_ERROR",
      code: "PROVIDER_SERVER_ERROR",
      retryable: true,
      httpStatus: status,
      retryAfterMs: null
    };
  }

  if (status !== null) {
    return {
      adapterState: "INTERNAL_ERROR",
      code: "PROVIDER_HTTP_ERROR",
      retryable: false,
      httpStatus: status,
      retryAfterMs: null
    };
  }

  return {
    adapterState: "INTERNAL_ERROR",
    code: "PROVIDER_NETWORK_ERROR",
    retryable: true,
    httpStatus: null,
    retryAfterMs: null
  };
}

export function toAdapterError(input, options) {
  if (input instanceof AdapterError) return input;
  const classified = classifyProviderError(input, options);
  return new AdapterError("Provider request failed.", {
    ...classified,
    cause: input
  });
}
