export class DomainError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DomainError";
    this.code = code;
    this.status = options.status ?? 400;
    this.expose =
      options.expose ??
      (this.status >= 400 && this.status < 500);
    this.details = options.details ?? null;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      details: this.details,
    };
  }
}

export function domainAssert(condition, code, message, details = null) {
  if (!condition) {
    throw new DomainError(code, message, { details });
  }
}
