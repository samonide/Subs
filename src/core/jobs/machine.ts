/**
 * The job state machine.
 *
 * Every transition is a pure function returning a **new** record. There is no mutation,
 * no clock, and no I/O, which means the whole lifecycle can be tested by asserting on
 * values rather than by racing a real worker.
 *
 * ## Why transitions are validated rather than assumed
 *
 * A worker callback can arrive late. A poll can arrive out of order. A cancel can land
 * after the work already finished. Without a checked transition, any of those silently
 * overwrite a terminal state — a cancelled job flipping to "completed" is the kind of bug
 * that ships because the UI never showed it, not because the logic was wrong in an obvious
 * way.
 *
 * So illegal transitions throw `JobTransitionError`, and terminal states absorb
 * everything. That makes a duplicate completion a loud failure during tests instead of a
 * silent race in production.
 */

import {
  INDETERMINATE,
  isTerminal,
  JobFailureCode,
  JobStatus,
  type JobFailure,
  type JobProgress,
  type JobRecord,
  type JobResult,
  type JobStatusValue,
  type JobTypeValue,
} from './types.js';

/** Raised when code attempts a lifecycle transition that does not exist. */
export class JobTransitionError extends Error {
  readonly from: JobStatusValue;
  readonly to: JobStatusValue;

  constructor(from: JobStatusValue, to: JobStatusValue) {
    super(`Illegal job transition ${from} → ${to}`);
    this.name = 'JobTransitionError';
    this.from = from;
    this.to = to;
  }
}

function replace(record: JobRecord, patch: Partial<JobRecord>): JobRecord {
  return { ...record, ...patch };
}

/**
 * Which transitions are legal.
 *
 * `queued` → `processing | cancelled | failed`
 * `processing` → `completed | failed | cancelled`
 * terminal → nothing.
 *
 * `queued → failed` is allowed: a job can be rejected before it runs (source missing, the
 * queue was shut down). Making that route through `processing` would force a fake "started"
 * status for a job that never started.
 */
function assertTransition(from: JobStatusValue, to: JobStatusValue): void {
  if (from === to) {
    // A repeat of the current status is not a transition. `tryTransition` relies on this to
    // make a duplicate callback a no-op: without it, a late second `completed` would
    // produce a *new* record, overwriting the real result and its timestamps.
    return;
  }
  if (isTerminal(from)) {
    throw new JobTransitionError(from, to);
  }
  const legal: Record<'queued' | 'processing', readonly JobStatusValue[]> = {
    queued: [JobStatus.Processing, JobStatus.Failed, JobStatus.Cancelled],
    processing: [JobStatus.Completed, JobStatus.Failed, JobStatus.Cancelled],
  };
  if (!legal[from as 'queued' | 'processing'].includes(to)) {
    throw new JobTransitionError(from, to);
  }
}

export function createJob(input: {
  id: string;
  projectId: string;
  type: JobTypeValue;
  sourceAssetId: string;
  createdAt: string;
}): JobRecord {
  return {
    id: input.id,
    projectId: input.projectId,
    type: input.type,
    status: JobStatus.Queued,
    sourceAssetId: input.sourceAssetId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    progress: INDETERMINATE,
  };
}

export function startJob(record: JobRecord, startedAt: string): JobRecord {
  assertTransition(record.status, JobStatus.Processing);
  return replace(record, {
    status: JobStatus.Processing,
    startedAt,
    updatedAt: startedAt,
    progress: INDETERMINATE,
  });
}

/**
 * Record progress.
 *
 * Only valid while processing. Progress on a terminal job is dropped by throwing, because
 * an FFmpeg process that keeps emitting after cancellation is a real race and silently
 * ignoring it would leave a cancelled job showing 90%.
 */
export function reportProgress(record: JobRecord, progress: JobProgress, at: string): JobRecord {
  if (record.status !== JobStatus.Processing) {
    throw new JobTransitionError(record.status, JobStatus.Processing);
  }
  return replace(record, { progress, updatedAt: at });
}

export function completeJob(record: JobRecord, result: JobResult, finishedAt: string): JobRecord {
  assertTransition(record.status, JobStatus.Completed);
  return replace(record, {
    status: JobStatus.Completed,
    result,
    finishedAt,
    updatedAt: finishedAt,
    progress: { kind: 'determinate', value: 1 },
  });
}

export function failJob(record: JobRecord, failure: JobFailure, finishedAt: string): JobRecord {
  assertTransition(record.status, JobStatus.Failed);
  return replace(record, {
    status: JobStatus.Failed,
    failure,
    finishedAt,
    updatedAt: finishedAt,
  });
}

export function cancelJob(record: JobRecord, finishedAt: string): JobRecord {
  assertTransition(record.status, JobStatus.Cancelled);
  return replace(record, {
    status: JobStatus.Cancelled,
    failure: {
      code: JobFailureCode.Cancelled,
      message: 'Cancelled by request.',
    },
    finishedAt,
    updatedAt: finishedAt,
  });
}

/**
 * Apply a transition only if it is legal, reporting whether it happened.
 *
 * Used by the worker, where a duplicate or late callback is expected rather than a
 * programming error: losing an update is correct, throwing across an async boundary is not.
 * The transition-specific functions above remain strict for callers that want the check.
 */
export function tryTransition(
  record: JobRecord,
  to: JobStatusValue,
  at: string,
  detail?: { failure?: JobFailure; result?: JobResult },
): JobRecord {
  // Already in the requested state: nothing to do. Returning `record` itself (not a copy)
  // is what makes a duplicate callback observably a no-op, so a caller can rely on identity.
  if (record.status === to) {
    return record;
  }
  try {
    assertTransition(record.status, to);
  } catch {
    return record;
  }
  switch (to) {
    case JobStatus.Processing:
      return startJob(record, at);
    case JobStatus.Completed:
      return completeJob(record, detail?.result ?? {}, at);
    case JobStatus.Failed:
      return failJob(record, detail?.failure ?? { code: 'tool-failed', message: 'Failed.' }, at);
    case JobStatus.Cancelled:
      return cancelJob(record, at);
    default:
      return record;
  }
}
