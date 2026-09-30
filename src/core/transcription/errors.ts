/**
 * Provider-neutral transcription errors.
 *
 * Every adapter maps its vendor's failures into these codes. Two reasons this matters:
 *
 *  1. **The application branches on the class of failure, not the vendor.** A retry policy
 *     needs to know "this was a rate limit" versus "this will never work", and that question
 *     must be answerable without a `switch` on vendor names.
 *
 *  2. **Secrets and stack traces stop here.** A raw provider error can carry the request URL,
 *     an `Authorization` header, a request id, and a vendor-specific stack. Those belong in a
 *     server-side log, never in a job record the browser polls. `TranscriptionError` carries a
 *     message written for the user plus an opaque diagnostic handle.
 */

export const TranscriptionErrorCode = {
  /** Credentials missing, wrong, or lacking permission. Never retryable. */
  Authentication: 'auth',
  /** Provider rejected the request shape (bad model, unsupported format). Never retryable. */
  InvalidRequest: 'invalid-request',
  /** Provider could not process this audio (too long, unreadable). Never retryable. */
  UnsupportedAudio: 'unsupported-audio',
  /** Provider accepted the request but has no capacity right now. Retryable. */
  RateLimited: 'rate-limited',
  /** Provider did not answer in time. Retryable. */
  Timeout: 'timeout',
  /** Provider unreachable or returned 5xx. Retryable. */
  Unavailable: 'unavailable',
  /**
   * Provider answered, but the payload could not be understood.
   *
   * Retryable in principle (a truncated body may be transient) but not in practice: this phase
   * makes one attempt, so the distinction only shapes the message the user sees.
   */
  MalformedResponse: 'malformed-response',
  /** Provider answered with a valid, empty transcript (silence). Not an error to the user. */
  EmptyTranscript: 'empty-transcript',
  /** The operation was cancelled locally before or during the call. */
  Cancelled: 'cancelled',
  /** No provider is configured on this machine. A setup problem, not a request problem. */
  NotConfigured: 'not-configured',
} as const;

export type TranscriptionErrorCodeValue =
  (typeof TranscriptionErrorCode)[keyof typeof TranscriptionErrorCode];

/**
 * Which failures are worth another attempt.
 *
 * Expressed as data rather than inferred from the code at each call site, so the retry policy
 * has exactly one definition. Note that "retryable" describes the *failure class*, not the
 * request: a rate limit is retryable, but this phase still makes one attempt, because a
 * silent retry loop would burn the user's quota without telling them anything happened.
 */
const RETRYABLE: ReadonlySet<TranscriptionErrorCodeValue> = new Set<TranscriptionErrorCodeValue>([
  TranscriptionErrorCode.RateLimited,
  TranscriptionErrorCode.Timeout,
  TranscriptionErrorCode.Unavailable,
]);

export class TranscriptionError extends Error {
  override readonly name = 'TranscriptionError';
  readonly code: TranscriptionErrorCodeValue;
  readonly retryable: boolean;

  /**
   * Server-side diagnostic detail, deliberately **not** serialised to the browser.
   *
   * A provider's raw error text can name the model, the request id, and occasionally echo part
   * of the request. It is attached to the thrown error for a log line, and never travels in a
   * job record.
   */
  readonly detail?: string;

  constructor(
    code: TranscriptionErrorCodeValue,
    message: string,
    options: { detail?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    if (options.detail !== undefined) {
      this.detail = options.detail;
    }
  }

  /** The user-facing projection. No detail, no cause, no stack. */
  toJSON(): { code: TranscriptionErrorCodeValue; message: string; retryable: boolean } {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export function isTranscriptionError(value: unknown): value is TranscriptionError {
  return value instanceof TranscriptionError;
}

/** HTTP status for an error code, mirroring the server's existing typed-error mapping. */
export function httpStatusForTranscription(code: TranscriptionErrorCodeValue): number {
  switch (code) {
    case TranscriptionErrorCode.Authentication:
      return 502;
    case TranscriptionErrorCode.NotConfigured:
      return 503;
    case TranscriptionErrorCode.InvalidRequest:
    case TranscriptionErrorCode.UnsupportedAudio:
      return 422;
    case TranscriptionErrorCode.RateLimited:
      return 429;
    case TranscriptionErrorCode.Timeout:
    case TranscriptionErrorCode.Unavailable:
      return 503;
    case TranscriptionErrorCode.MalformedResponse:
    case TranscriptionErrorCode.EmptyTranscript:
      return 502;
    case TranscriptionErrorCode.Cancelled:
      return 499;
  }
}
