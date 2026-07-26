import { DomainError } from "../domain/errors.js";
import { StoreCapacityError } from "../infrastructure/index.js";

const ERROR_DEFINITIONS = Object.freeze({
  INVALID_INPUT: {
    status: 400,
    message: "The request input is invalid.",
    retryable: false,
  },
  INVALID_CULTIVATION_MODE: {
    status: 400,
    message: "The cultivation mode is not valid for this crop.",
    retryable: false,
  },
  INVALID_GROWTH_STAGE_CONTEXT: {
    status: 400,
    message: "The growth-stage context is invalid.",
    retryable: false,
  },
  INVALID_SATELLITE_CONTEXT: {
    status: 400,
    message: "Satellite observation is not valid for this request.",
    retryable: false,
  },
  PARCEL_REQUIRED: {
    status: 400,
    message: "A confirmed parcel is required for this request.",
    retryable: false,
  },
  INVALID_LOCATION_SELECTION: {
    status: 400,
    message: "The location selection is invalid.",
    retryable: false,
  },
  LOCATION_NOT_CONFIRMED: {
    status: 400,
    message: "The location selection must be explicitly confirmed.",
    retryable: false,
  },
  INVALID_LOCATION_TOKEN: {
    status: 400,
    message: "The location candidate token is malformed.",
    retryable: false,
  },
  INVALID_SEASON: {
    status: 400,
    message: "The season selection is invalid.",
    retryable: false,
  },
  SEASON_REQUIRED: {
    status: 400,
    message: "A confirmed season selection is required.",
    retryable: false,
  },
  SEASON_NOT_CONFIRMED: {
    status: 400,
    message: "The season selection must be explicitly confirmed.",
    retryable: false,
  },
  INVALID_SEASON_CONTEXT: {
    status: 400,
    message: "The season is not valid for this crop and cultivation mode.",
    retryable: false,
  },
  INVALID_SEASON_PROFILE: {
    status: 400,
    message: "The season profile is invalid.",
    retryable: false,
  },
  UNVERIFIED_SEASON_PROFILE: {
    status: 400,
    message: "The season profile has not been reviewed for this request.",
    retryable: false,
  },
  INVALID_SEASON_MONTH: {
    status: 400,
    message: "The season month selection is invalid.",
    retryable: false,
  },
  INVALID_GROWTH_STAGE: {
    status: 400,
    message: "The growth stage is invalid.",
    retryable: false,
  },
  INVALID_OPTIONS: {
    status: 400,
    message: "The analysis options are invalid.",
    retryable: false,
  },
  INVALID_PARCEL: {
    status: 400,
    message: "The parcel geometry is invalid.",
    retryable: false,
  },
  PARCEL_NOT_CONFIRMED: {
    status: 400,
    message: "The parcel geometry must be explicitly confirmed.",
    retryable: false,
  },
  PARCEL_TOO_COMPLEX: {
    status: 400,
    message: "The parcel geometry exceeds the supported complexity.",
    retryable: false,
  },
  LOCATION_TOKEN_INVALID: {
    status: 400,
    message: "The location candidate is invalid or expired.",
    retryable: false,
  },
  ANALYSIS_NOT_FOUND: {
    status: 404,
    message: "The analysis was not found.",
    retryable: false,
  },
  PUSH_NOT_CONFIGURED: {
    status: 503,
    message: "Push notifications are not configured on this deployment.",
    retryable: false,
  },
  PUSH_SUBSCRIPTION_EXPIRED: {
    status: 410,
    message: "The push subscription is no longer valid. Allow notifications again.",
    retryable: false,
  },
  PUSH_SEND_FAILED: {
    status: 502,
    message: "The push service refused the notification.",
    retryable: true,
  },
  NOT_FOUND: {
    status: 404,
    message: "The requested API route was not found.",
    retryable: false,
  },
  INVALID_ACCOUNT_KEY: {
    status: 400,
    message: "The account key is not in the expected format.",
    retryable: false,
  },
  INVALID_PAYLOAD: {
    status: 400,
    message: "The backup payload contains unsupported fields.",
    retryable: false,
  },
  BACKUP_NOT_FOUND: {
    status: 404,
    message: "No backup exists for this account key.",
    retryable: false,
  },
  BACKUP_NOT_CONFIGURED: {
    status: 503,
    message: "Device backup storage is not configured.",
    retryable: false,
  },
  BACKUP_STORE_UNAVAILABLE: {
    status: 503,
    message: "The backup store is temporarily unreachable.",
    retryable: true,
  },
  BACKUP_STORE_ERROR: {
    status: 502,
    message: "The backup store rejected the request.",
    retryable: true,
  },
  METHOD_NOT_ALLOWED: {
    status: 405,
    message: "The HTTP method is not allowed for this route.",
    retryable: false,
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    message: "The JSON request body is too large.",
    retryable: false,
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    message: "The idempotency key was already used with another payload.",
    retryable: false,
  },
  CSRF_REJECTED: {
    status: 403,
    message: "The origin or CSRF token was rejected.",
    retryable: false,
  },
  ORIGIN_REJECTED: {
    status: 403,
    message: "The request origin is not allowed.",
    retryable: false,
  },
  RATE_LIMITED: {
    status: 429,
    message: "Too many requests were made.",
    retryable: true,
  },
  REQUEST_TIMEOUT: {
    status: 504,
    message: "The request deadline was exceeded.",
    retryable: true,
  },
  SERVICE_BUSY: {
    status: 503,
    message: "The service is temporarily at capacity.",
    retryable: true,
  },
  INTERNAL_ERROR: {
    status: 500,
    message: "An unexpected server error occurred.",
    retryable: true,
  },
});

const REQUEST_VALIDATION_CODES = new Set([
  "INVALID_INPUT",
  "INVALID_CULTIVATION_MODE",
  "INVALID_GROWTH_STAGE",
  "INVALID_GROWTH_STAGE_CONTEXT",
  "INVALID_LOCATION_SELECTION",
  "INVALID_LOCATION_TOKEN",
  "INVALID_OPTIONS",
  "INVALID_PARCEL",
  "INVALID_SATELLITE_CONTEXT",
  "INVALID_SEASON",
  "INVALID_SEASON_CONTEXT",
  "INVALID_SEASON_MONTH",
  "INVALID_SEASON_PROFILE",
  "LOCATION_NOT_CONFIRMED",
  "PARCEL_NOT_CONFIRMED",
  "PARCEL_REQUIRED",
  "PARCEL_TOO_COMPLEX",
  "SEASON_NOT_CONFIRMED",
  "SEASON_REQUIRED",
  "UNVERIFIED_SEASON_PROFILE",
]);

const TRUSTED_SERVICE_CODES = new Set([
  "ANALYSIS_NOT_FOUND",
  "INTERNAL_ERROR",
  "LOCATION_TOKEN_INVALID",
]);

function cleanFieldErrors(fieldErrors) {
  if (
    !fieldErrors ||
    typeof fieldErrors !== "object" ||
    Array.isArray(fieldErrors)
  ) {
    return undefined;
  }
  const cleaned = {};
  for (const [field, message] of Object.entries(fieldErrors)) {
    if (
      typeof field === "string" &&
      field.length <= 100 &&
      typeof message === "string" &&
      message.length <= 300
    ) {
      cleaned[field] = message;
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export class ApiError extends Error {
  constructor(
    code,
    {
      status,
      message,
      retryable,
      fieldErrors,
      cause,
    } = {},
  ) {
    const definition = ERROR_DEFINITIONS[code] ?? ERROR_DEFINITIONS.INTERNAL_ERROR;
    super(message ?? definition.message, { cause });
    this.name = "ApiError";
    this.code = ERROR_DEFINITIONS[code] ? code : "INTERNAL_ERROR";
    this.status = status ?? definition.status;
    this.retryable = retryable ?? definition.retryable;
    this.fieldErrors = cleanFieldErrors(fieldErrors);
  }
}

export function normalizeApiError(error) {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof StoreCapacityError) {
    return new ApiError("SERVICE_BUSY", { cause: error });
  }

  if (error instanceof DomainError) {
    if (
      error.expose === true &&
      Number.isInteger(error.status) &&
      error.status >= 400 &&
      error.status < 500
    ) {
      const code = REQUEST_VALIDATION_CODES.has(error.code)
        ? error.code
        : "INVALID_INPUT";
      return new ApiError(code, {
        status: 400,
        cause: error,
      });
    }
    return new ApiError("INTERNAL_ERROR", { cause: error });
  }

  if (
    error instanceof Error &&
    typeof error.code === "string" &&
    TRUSTED_SERVICE_CODES.has(error.code)
  ) {
    const definition = ERROR_DEFINITIONS[error.code];
    return new ApiError(error.code, {
      status: definition.status,
      message: definition.message,
      retryable: definition.retryable,
      cause: error,
    });
  }

  return new ApiError("INTERNAL_ERROR", { cause: error });
}

export function serializeApiError(error, requestId) {
  const body = {
    requestId,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
  if (error.fieldErrors) {
    body.fieldErrors = error.fieldErrors;
  }
  return body;
}

export const requestValidationCodes = Object.freeze([
  ...REQUEST_VALIDATION_CODES,
]);
