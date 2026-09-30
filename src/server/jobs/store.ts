/**
 * Job persistence and the local worker queue.
 *
 * ## Why jobs are persisted at all
 *
 * The alternative — an in-memory `Map` — was rejected for one specific reason, not for
 * general durability. With memory-only state, restarting the process mid-job makes the job
 * vanish while its half-written output may still be on disk. The client then polls a job
 * that no longer exists, and the leftover file is never cleaned up: invisible work and
 * invisible garbage, with no record that either existed.
 *
 * Persisting the record means a restart can find the job, see it stuck in `processing`, and
 * fail it explicitly. `recoverInterruptedJobs` does exactly that on startup. It does not
 * attempt to *resume* the work — FFmpeg gives no rewind point — so the honest recovery is
 * "this did not finish; run it again", never a silent success.
 *
 * ## Concurrency: exactly one media job at a time
 *
 * A single serial queue, deliberately. The reasons are all about this being a local desktop
 * tool, not about scaling later:
 *   - FFmpeg is already multi-threaded internally and will use every core it is given, so
 *     two concurrent extractions on a laptop make both slower, not the machine faster;
 *   - a serial queue cannot deadlock, and needs no visibility-timeout or re-delivery
 *     machinery, none of which has a consumer here;
 *   - it bounds resource use, which matters *because there is no authentication* — an
 *     open endpoint that can queue unlimited jobs is a trivial local DoS.
 *
 * When a queue or worker pool is genuinely needed, this class is the only thing that has to
 * change; the job model, the store, and the HTTP surface all stay as they are.
 *
 * ## Atomic writes
 *
 * Same discipline as `project.json` in Phase 1: write a temp file, then rename over the
 * target. A crash can leave a temp file but never a half-written `job.json`.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  createJob,
  JobStatus,
  reportProgress,
  startJob,
  tryTransition,
  type JobRecord,
  type JobTypeValue,
} from '../../core/jobs/index.js';
import { newJobId, type JobId } from '../../core/document/ids.js';
import { ErrorCode, IngestError } from '../errors.js';
import { type WorkspaceLayout } from '../workspace.js';

/** Validates the on-disk shape. Deliberately narrower than Zod: this is a trusted,
 *  server-written file, and a full schema would be speculative weight. */
function parseJobRecord(raw: string): JobRecord {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as Record<string, unknown>)['id'] !== 'string' ||
    typeof (value as Record<string, unknown>)['status'] !== 'string'
  ) {
    throw new IngestError(ErrorCode.INVALID_PROJECT, 'Job record is malformed.');
  }
  return value as JobRecord;
}

export interface JobStore {
  create(input: {
    projectId: string;
    type: JobTypeValue;
    sourceAssetId: string;
    now: string;
  }): JobRecord;
  get(jobId: JobId): JobRecord;
  list(projectId?: string): JobRecord[];
  save(record: JobRecord): void;
  /** Update a job via a pure transition, persisting the result. */
  update(jobId: JobId, transition: (record: JobRecord) => JobRecord): JobRecord;
  /**
   * Mark jobs left mid-flight by a crashed process as failed.
   *
   * A job found in `processing` at startup did not finish; its process is gone. Reporting
   * that as `failed` with an explicit reason is the only honest option: there is no partial
   * output worth promoting, and no resume point to continue from.
   */
  recoverInterruptedJobs(now: string): JobRecord[];
}

export function createJobStore(workspace: WorkspaceLayout): JobStore {
  workspace.ensure();

  const write = (record: JobRecord): void => {
    const target = workspace.jobFile(record.id);
    const temp = workspace.jobTempFile(record.id, '.job.json.tmp');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(temp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(temp, target);
  };

  return {
    create(input) {
      const record = createJob({
        id: newJobId(),
        projectId: input.projectId,
        type: input.type,
        sourceAssetId: input.sourceAssetId,
        createdAt: input.now,
      });
      write(record);
      return record;
    },

    get(jobId: JobId) {
      let raw: string;
      try {
        raw = readFileSync(workspace.jobFile(jobId), 'utf8');
      } catch {
        throw new IngestError(ErrorCode.JOB_NOT_FOUND, `No such job: ${jobId}`);
      }
      return parseJobRecord(raw);
    },

    list(projectId) {
      let ids: string[];
      try {
        ids = readdirSync(workspace.jobsDir);
      } catch {
        return [];
      }
      const records: JobRecord[] = [];
      for (const id of ids) {
        try {
          const record = parseJobRecord(readFileSync(workspace.jobFile(id), 'utf8'));
          if (projectId === undefined || record.projectId === projectId) {
            records.push(record);
          }
        } catch {
          // A job directory without a readable job.json is a crashed or in-flight write.
          // Skipping it is correct: there is no valid record to report.
        }
      }
      return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    save: write,

    update(jobId: JobId, transition: (record: JobRecord) => JobRecord) {
      const next = transition(this.get(jobId));
      write(next);
      return next;
    },

    recoverInterruptedJobs(now) {
      const recovered: JobRecord[] = [];
      for (const record of this.list()) {
        if (record.status === JobStatus.Processing || record.status === JobStatus.Queued) {
          const failed = tryTransition(record, JobStatus.Failed, now, {
            failure: {
              code: 'tool-failed',
              message: 'Processing was interrupted by a restart.',
            },
          });
          write(failed);
          recovered.push(failed);
        }
      }
      return recovered;
    },
  };
}

export { startJob, reportProgress, tryTransition };

/**
 * The single-slot local worker.
 *
 * `submit` runs the handler as soon as the slot is free and resolves with its result. It
 * deliberately does **not** block the caller: the HTTP handler enqueues, returns a job id,
 * and the client polls. A request handler that awaited a two-minute FFmpeg run would hold a
 * socket open and be killed by any proxy timeout — the exact failure the job model exists
 * to prevent.
 */
export class Worker {
  private active: { jobId: JobId; controller: AbortController } | undefined;
  private readonly queue: Array<() => void> = [];

  isBusy(): boolean {
    return this.active !== undefined;
  }

  activeJobId(): JobId | undefined {
    return this.active?.jobId;
  }

  /** How many jobs are waiting behind the active one. */
  depth(): number {
    return this.queue.length;
  }

  private acquire(jobId: JobId): Promise<AbortController> {
    return new Promise<AbortController>((resolve) => {
      const attempt = (): void => {
        if (this.active === undefined) {
          const controller = new AbortController();
          this.active = { jobId, controller };
          resolve(controller);
          return;
        }
        this.queue.push(attempt);
      };
      attempt();
    });
  }

  private release(): void {
    this.active = undefined;
    this.queue.shift()?.();
  }

  /**
   * Enqueue work. Resolves with the handler's value once the slot reaches it.
   *
   * Cancellation is cooperative: `cancel(jobId)` signals the handler's `AbortSignal` and the
   * handler is responsible for terminating its child process and cleaning up. The worker
   * cannot kill arbitrary work itself without holding a handle it deliberately does not own.
   */
  async run<T>(jobId: JobId, handler: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = await this.acquire(jobId);
    try {
      return await handler(controller.signal);
    } finally {
      this.release();
    }
  }

  /**
   * Request cancellation. Returns true when a live job was signalled.
   *
   * A queued job that has not started is not signalled here — its handler will observe the
   * abort when it finally acquires the slot, or the caller marks it cancelled in the store.
   */
  cancel(jobId: JobId): boolean {
    if (this.active?.jobId === jobId) {
      this.active.controller.abort();
      return true;
    }
    return false;
  }

  /** Delete a job's directory. Used after a terminal job is no longer interesting. */
  remove(jobId: JobId): void {
    rmSync(this.workspace.jobDir(jobId), { recursive: true, force: true });
  }

  constructor(private readonly workspace: WorkspaceLayout) {}
}

/**
 * Create a worker bound to a workspace.
 *
 * The workspace is injected rather than captured in a module-level variable: a process-global
 * "current workspace" would mean two stores in one process (a test, or two projects in future)
 * silently delete each other's job directories.
 */
export function createWorker(workspace: WorkspaceLayout): Worker {
  return new Worker(workspace);
}
