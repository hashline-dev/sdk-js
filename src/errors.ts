// src/errors.ts — error hierarchy surfaced by the Hashline SDK.

import type { ProblemJson } from "./types.js";

/** Base class for all errors thrown by the Hashline SDK. */
export class HashlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HashlineError";
    // Preserve prototype chain when transpiled to ES5 targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when SDK input is invalid (missing/oversize fields, wrong batch shape).
 * These are callsite bugs; they are NOT retried.
 */
export class ValidationError extends HashlineError {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Wraps a non-2xx HTTP response from the Hashline API. `problem` carries the
 * RFC 7807 body when the server returned one (spec §5.1). `retryable` is
 * `true` for 408/429/5xx — the SDK may have already retried before throwing
 * this error; the flag lets callers decide whether to retry again later.
 */
export class APIError extends HashlineError {
  readonly status: number;
  readonly requestId: string | undefined;
  readonly problem: ProblemJson | undefined;
  readonly retryable: boolean;

  constructor(opts: {
    status: number;
    message: string;
    requestId?: string | undefined;
    problem?: ProblemJson | undefined;
    retryable: boolean;
  }) {
    super(opts.message);
    this.name = "APIError";
    this.status = opts.status;
    this.requestId = opts.requestId;
    this.problem = opts.problem;
    this.retryable = opts.retryable;
  }
}

/**
 * Thrown when the request could not reach the server — DNS, TCP, TLS, fetch
 * abort, or any transport-level failure. Always `retryable: true` semantically;
 * the SDK retries these internally up to `maxRetries`.
 */
export class NetworkError extends HashlineError {
  override readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "NetworkError";
    this.cause = cause;
  }
}
