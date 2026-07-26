import { AdapterError, classifyProviderError } from "./errors.js";

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer.`);
  }
  return value;
}

function abortError(signal) {
  if (signal?.reason?.name === "AbortError") return signal.reason;
  return new DOMException("Provider execution was aborted.", "AbortError");
}

function circuitError(code, message) {
  return new AdapterError(message, {
    adapterState: "RATE_LIMITED",
    code,
    retryable: false
  });
}

export class ProviderExecutionGuard {
  #provider;
  #maxConcurrency;
  #maxQueue;
  #failureThreshold;
  #circuitCooldownMs;
  #now;
  #active = 0;
  #queue = [];
  #transientFailures = 0;
  #circuitOpenUntil = 0;

  constructor({
    provider,
    maxConcurrency = 4,
    maxQueue = 8,
    failureThreshold = 3,
    circuitCooldownMs = 1000,
    now = () => Date.now()
  } = {}) {
    if (typeof provider !== "string" || provider.trim() === "") {
      throw new TypeError("provider must be a non-empty string.");
    }
    if (!Number.isFinite(circuitCooldownMs) || circuitCooldownMs <= 0) {
      throw new TypeError("circuitCooldownMs must be a positive number.");
    }
    this.#provider = provider.trim();
    this.#maxConcurrency = positiveInteger(
      maxConcurrency,
      "maxConcurrency"
    );
    this.#maxQueue = nonNegativeInteger(maxQueue, "maxQueue");
    this.#failureThreshold = positiveInteger(
      failureThreshold,
      "failureThreshold"
    );
    this.#circuitCooldownMs = circuitCooldownMs;
    this.#now = now;
  }

  get activeCount() {
    return this.#active;
  }

  get queuedCount() {
    return this.#queue.length;
  }

  get circuitState() {
    this.#refreshCircuit();
    return this.#circuitOpenUntil > 0 ? "OPEN" : "CLOSED";
  }

  run(operation, { signal } = {}) {
    if (typeof operation !== "function") {
      throw new TypeError("operation must be a function.");
    }
    if (signal?.aborted) {
      return Promise.reject(abortError(signal));
    }
    this.#refreshCircuit();
    if (this.#circuitOpenUntil > 0) {
      return Promise.reject(
        circuitError(
          "PROVIDER_CIRCUIT_OPEN",
          `${this.#provider} provider circuit is open.`
        )
      );
    }

    return new Promise((resolve, reject) => {
      const job = {
        operation,
        signal,
        resolve,
        reject,
        started: false,
        settled: false,
        onAbort: null
      };
      if (this.#active < this.#maxConcurrency) {
        this.#start(job);
        return;
      }
      if (this.#queue.length >= this.#maxQueue) {
        reject(
          circuitError(
            "PROVIDER_CONCURRENCY_SATURATED",
            `${this.#provider} provider execution queue is saturated.`
          )
        );
        return;
      }
      job.onAbort = () => {
        if (job.started || job.settled) return;
        const index = this.#queue.indexOf(job);
        if (index >= 0) this.#queue.splice(index, 1);
        job.settled = true;
        reject(abortError(signal));
      };
      signal?.addEventListener("abort", job.onAbort, { once: true });
      this.#queue.push(job);
    });
  }

  #clock() {
    const value = Number(this.#now());
    if (!Number.isFinite(value)) {
      throw new TypeError("Provider execution clock is invalid.");
    }
    return value;
  }

  #refreshCircuit() {
    if (
      this.#circuitOpenUntil > 0 &&
      this.#clock() >= this.#circuitOpenUntil
    ) {
      this.#circuitOpenUntil = 0;
      this.#transientFailures = 0;
    }
  }

  #start(job) {
    if (job.settled) return;
    job.started = true;
    if (job.onAbort) {
      job.signal?.removeEventListener("abort", job.onAbort);
    }
    this.#active += 1;
    Promise.resolve()
      .then(() => job.operation(job.signal))
      .then(
        (value) => {
          if (this.#circuitOpenUntil === 0) {
            this.#transientFailures = 0;
          }
          job.settled = true;
          job.resolve(value);
        },
        (error) => {
          this.#recordFailure(error, job.signal);
          job.settled = true;
          job.reject(error);
        }
      )
      .finally(() => {
        this.#active -= 1;
        this.#drain();
      });
  }

  #recordFailure(error, signal) {
    if (signal?.aborted || error?.name === "AbortError") return;
    const classified = classifyProviderError(error);
    if (
      !classified.retryable ||
      !["TIMEOUT", "RATE_LIMITED", "INTERNAL_ERROR"].includes(
        classified.adapterState
      )
    ) {
      return;
    }
    this.#transientFailures += 1;
    if (this.#transientFailures < this.#failureThreshold) return;

    this.#circuitOpenUntil = this.#clock() + this.#circuitCooldownMs;
    this.#transientFailures = 0;
    const queued = this.#queue.splice(0);
    for (const job of queued) {
      job.signal?.removeEventListener("abort", job.onAbort);
      job.settled = true;
      job.reject(
        circuitError(
          "PROVIDER_CIRCUIT_OPEN",
          `${this.#provider} provider circuit is open.`
        )
      );
    }
  }

  #drain() {
    this.#refreshCircuit();
    if (this.#circuitOpenUntil > 0) return;
    while (
      this.#active < this.#maxConcurrency &&
      this.#queue.length > 0
    ) {
      const job = this.#queue.shift();
      if (job.signal?.aborted) {
        job.signal.removeEventListener("abort", job.onAbort);
        job.settled = true;
        job.reject(abortError(job.signal));
        continue;
      }
      this.#start(job);
    }
  }
}
