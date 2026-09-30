/**
 * The job domain model.
 *
 * A job is a unit of deferred media work: "extract audio from asset X of project Y". It
 * exists so that slow CPU-bound work (FFmpeg today, transcription in Phase 4, render
 * later) is represented as an observable object rather than a request that hangs.
 *
 * ## Why jobs are not part of ProjectDocument
 *
 * A job is volatile runtime state: it is queued, running, done, gone. A project document
 * is the durable, versioned, undoable truth about a piece of work. Merging them would mean
 * every project file carries a stale `"status": "processing"` from a crashed run, and
 * every undo would try to revert a job that has long since disappeared (invariant I-20).
 *
 * So: jobs live in their own store, in their own file, and a document loaded from disk
 * never mentions one.
 *
 * ## Purity
 *
 * Everything here is plain data plus pure transitions. No clock, no filesystem, no
 * process. Timestamps are injected by the caller for exactly the reason `applyWorkerResult`
 * injects `generatedAt`: a hidden `Date.now()` would make the same inputs produce
 * different records on every run, which makes the state machine untestable.
 */

/** The job types this application knows about. */
export const JobType = {
  AudioExtract: 'media.audio-extract',
  Transcribe: 'transcription.transcribe',
} as const;

export type JobTypeValue = (typeof JobType)[keyof typeof JobType];

/**
 * The job lifecycle.
 *
 * ```
 *                 ┌──────────► cancelled ◄──────────┐
 *                 │                                  │
 *   queued ────────┼──────► processing ──────────────┤
 *                 │                │                │
 *                 └────────────────┴──► completed   │
 *                                  └──► failed ─────┘
 * ```
 *
 * `queued`, `processing`, `completed`, `failed`, and `cancelled` are the states. Every one
 * of `completed`, `failed`, and `cancelled` is terminal: a finished job never changes
 * again, so a late progress report or a duplicate worker callback cannot resurrect it.
 */
export const JobStatus = {
  Queued: 'queued',
  Processing: 'processing',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

export type JobStatusValue = (typeof JobStatus)[keyof typeof JobStatus];

const TERMINAL: ReadonlySet<JobStatusValue> = new Set<JobStatusValue>([
  JobStatus.Completed,
  JobStatus.Failed,
  JobStatus.Cancelled,
]);

export function isTerminal(status: JobStatusValue): boolean {
  return TERMINAL.has(status);
}

/**
 * Progress.
 *
 * `determinate` means FFmpeg reported how far along it is. `indeterminate` means it did
 * not — and that distinction is the point. A spinner that quietly shows 0% forever reads
 * as "stuck"; an honest indeterminate state reads as "working, unknown duration". Guessing
 * a percentage from elapsed time would be a fabrication presented as a measurement.
 */
export type JobProgress =
  { readonly kind: 'determinate'; readonly value: number } | { readonly kind: 'indeterminate' };

export const INDETERMINATE: JobProgress = { kind: 'indeterminate' };

export function determinate(value: number): JobProgress {
  // Clamped here rather than at every call site: a progress value outside 0..1 is
  // nonsense, and the alternative is trusting each producer to remember the range.
  return { kind: 'determinate', value: Math.min(1, Math.max(0, value)) };
}

/** Why a job failed. Structured so callers can branch without string matching. */
export const JobFailureCode = {
  /** The named FFmpeg/ffprobe binary could not be started. */
  ToolUnavailable: 'tool-unavailable',
  /** FFmpeg started and exited non-zero. */
  ToolFailed: 'tool-failed',
  /** The source asset referenced by the job does not exist or is not usable. */
  SourceMissing: 'source-missing',
  /** FFmpeg reported success but the output is missing or not valid media. */
  OutputInvalid: 'output-invalid',
  /** The job was cancelled. */
  Cancelled: 'cancelled',
  /** Writing the output or the job record failed (disk full, permissions). */
  StorageFailed: 'storage-failed',
} as const;

export type JobFailureCodeValue = (typeof JobFailureCode)[keyof typeof JobFailureCode];

export interface JobFailure {
  code: JobFailureCodeValue;
  /** Human-readable, safe to show a user. Never a stack trace, never a host path. */
  message: string;
}

/** A completed job's outcome: enough to act on, with no filesystem paths. */
export interface JobResult {
  /**
   * The asset the job produced, if it produced one.
   *
   * This is a *reference to data the client already has or will fetch*, not a path. An
   * audio-extract job records that asset X now exists; the client learns its metadata from the
   * project document (invariant I-13).
   */
  assetId?: string;
  /** Stable label for undo history, e.g. "Extract audio". */
  label?: string;
  /**
   * An opaque handle to a larger result stored beside the job.
   *
   * A transcription can be hundreds of segments; embedding it in `job.json` would make every
   * status poll re-read and re-parse megabytes, and would put transcript content into the
   * volatile runtime store where a project document does not belong. The job records only that
   * a result exists; the client fetches it separately and applies it as a labelled operation
   * (invariant I-20).
   */
  resultRef?: string;
}

export interface JobRecord {
  readonly id: string;
  readonly projectId: string;
  readonly type: JobTypeValue;
  readonly status: JobStatusValue;
  /** The asset being processed. */
  readonly sourceAssetId: string;
  /** ISO-8601, injected by the caller. */
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly progress: JobProgress;
  readonly failure?: JobFailure;
  readonly result?: JobResult;
  /** ISO-8601. Lets a client distinguish "queued a while ago" from "queued yesterday". */
  readonly updatedAt: string;
}
