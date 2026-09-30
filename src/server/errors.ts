/**
 * Structured errors for the Phase 1 ingest/persistence boundary.
 *
 * Callers need to distinguish *kinds* of failure to behave correctly: a too-large upload
 * should be reported differently from a corrupt file, and a missing project is not a
 * storage failure. A flat hierarchy is overkill for one phase, so this is a single error
 * class carrying a machine-readable `code`, plus a `retryable` flag for the job layer
 * that Phase 3 introduces.
 *
 * These live in `src/server` rather than `src/core` because they describe infrastructure
 * failure modes, not domain invariants. Core has no notion of a disk or a process.
 */

export const ErrorCode = {
  /** The request or file was malformed before any bytes were accepted. */
  INVALID_UPLOAD: 'INVALID_UPLOAD',
  /** The file's type is not among the supported media types. */
  UNSUPPORTED_MEDIA: 'UNSUPPORTED_MEDIA',
  /** The upload exceeded the configured size cap. */
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  /** A filesystem operation failed (permissions, disk full, etc). */
  STORAGE_FAILURE: 'STORAGE_FAILURE',
  /** ffprobe could not inspect the file, or the result was unusable. */
  INSPECTION_FAILED: 'INSPECTION_FAILED',
  /** A project document failed validation. */
  INVALID_PROJECT: 'INVALID_PROJECT',
  /** The requested project does not exist. */
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  /** The project exists but its asset files are missing. */
  MISSING_ASSET: 'MISSING_ASSET',
  /** A path escaped the workspace root, or violated a naming rule. */
  PATH_VIOLATION: 'PATH_VIOLATION',
  /** The operation was cancelled. */
  CANCELLED: 'CANCELLED',
  /** ffprobe was not found on the system. */
  TOOL_UNAVAILABLE: 'TOOL_UNAVAILABLE',
  /** ffprobe exceeded its wall-clock budget and was killed. */
  INSPECTION_TIMEOUT: 'INSPECTION_TIMEOUT',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class IngestError extends Error {
  override readonly name = 'IngestError';
  readonly code: ErrorCodeValue;
  /** Whether retrying the same operation could plausibly succeed. */
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(
    code: ErrorCodeValue,
    message: string,
    options?: { retryable?: boolean; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = options?.retryable ?? false;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  /** Serialisable form, suitable for an HTTP response body. */
  toJSON(): { code: ErrorCodeValue; message: string; retryable: boolean } {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export function isIngestError(value: unknown): value is IngestError {
  return value instanceof IngestError;
}

/** Map an error code to the HTTP status that describes it. */
export function httpStatusFor(code: ErrorCodeValue): number {
  switch (code) {
    case ErrorCode.INVALID_UPLOAD:
    case ErrorCode.PATH_VIOLATION:
      return 400;
    case ErrorCode.UNSUPPORTED_MEDIA:
      return 415;
    case ErrorCode.FILE_TOO_LARGE:
      return 413;
    case ErrorCode.PROJECT_NOT_FOUND:
    case ErrorCode.MISSING_ASSET:
      return 404;
    case ErrorCode.CANCELLED:
      return 499;
    case ErrorCode.TOOL_UNAVAILABLE:
    case ErrorCode.INSPECTION_TIMEOUT:
      return 503;
    case ErrorCode.STORAGE_FAILURE:
    case ErrorCode.INSPECTION_FAILED:
      return 500;
    case ErrorCode.INVALID_PROJECT:
      return 422;
  }
}
