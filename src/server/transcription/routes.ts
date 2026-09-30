/**
 * Transcription HTTP routes.
 *
 * Four endpoints, one per step of one flow — the same restraint Phase 3 used for jobs. No
 * generic job-management surface, no transcript editing endpoints, no styling.
 *
 * ```
 * POST /api/projects/:p/assets/:a/transcribe   → 202, job queued
 * GET  /api/jobs/:jobId/result                  → the canonical result, if the job produced one
 * GET  /api/jobs/:jobId/operation               → the pure op the client should apply
 * ```
 *
 * ## The third route is the point of the phase
 *
 * `GET /api/jobs/:jobId/operation` returns a **descriptor of an operation**, not a mutated
 * document. It is deliberately incapable of changing anything: the server has no idea what the
 * client's current document looks like, and it does not need one. The client fetches the
 * result, applies `applyTranscription` locally, and gets one undo entry covering the entire
 * transcript (invariant I-20).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  applyTranscription,
  transcriptionOperationLabel,
  TranscriptionError,
  TranscriptionErrorCode,
  isTranscriptionError,
  type CanonicalTranscription,
  type TranscriptGranularity,
} from '../../core/transcription/index.js';
import { JobStatus, JobType, startJob, tryTransition } from '../../core/jobs/index.js';
import { ErrorCode, IngestError } from '../errors.js';
import { httpStatusForTranscription } from '../../core/transcription/index.js';
import { discardResult, readResult, runTranscription, writeResult } from '../transcription/job.js';
import type { TranscriptionProvider } from '../../core/transcription/index.js';
import type { JobStore, Worker } from '../jobs/store.js';
import type { ProjectStore } from '../project/store.js';
import type { WorkspaceLayout } from '../workspace.js';

export interface TranscriptionRouteDeps {
  layout: WorkspaceLayout;
  projects: ProjectStore;
  jobs: JobStore;
  worker: Worker;
  /**
   * Resolved per request rather than captured at startup.
   *
   * A function, not a value, so a test can supply a fixture provider and so the absence of
   * credentials is a per-request fact instead of a process-level one. Returning `undefined`
   * means "no provider configured", which surfaces as a clear `NotConfigured` failure rather
   * than a crash at startup.
   */
  provider: () => TranscriptionProvider | undefined;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

/** Map any thrown value onto the shared structured-error shape. Never a stack trace. */
export function sendTranscriptionError(response: ServerResponse, error: unknown): boolean {
  if (isTranscriptionError(error)) {
    const body = error.toJSON();
    sendJson(response, httpStatusForTranscription(error.code), { error: body });
    return true;
  }
  return false;
}

/** The client-facing job projection, matching Phase 3's shape. */
function jobView(record: ReturnType<JobStore['get']>): unknown {
  return {
    jobId: record.id,
    projectId: record.projectId,
    type: record.type,
    status: record.status,
    sourceAssetId: record.sourceAssetId,
    progress: record.progress,
    failure: record.failure ?? null,
    result: record.result ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    finishedAt: record.finishedAt ?? null,
  };
}

function readString(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    // Bounded, for the same reason Phase 1's reader was: an unbounded read is an unbounded
    // memory read.
    if (size > 64_000) {
      throw new IngestError(ErrorCode.INVALID_UPLOAD, 'Request body is too large.');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (cause) {
    throw new IngestError(ErrorCode.INVALID_UPLOAD, 'Request body is not valid JSON.', {
      cause,
    });
  }
}

/** Start a transcription job for one audio asset. */
async function startTranscription(
  deps: TranscriptionRouteDeps,
  projectId: string,
  assetId: string,
  body: unknown,
): Promise<{ jobId: string; placement: string }> {
  const project = await deps.projects.load(projectId);
  const asset = project.assets.find((entry) => entry.id === assetId);
  if (asset === undefined) {
    throw new IngestError(ErrorCode.MISSING_ASSET, `Project has no asset ${assetId}.`);
  }
  if (asset.role !== 'audio') {
    throw new IngestError(
      ErrorCode.INVALID_UPLOAD,
      'Only extracted audio can be transcribed. Extract audio from the video first.',
    );
  }

  // Fail fast, before queuing, when there is no provider. A queued job that cannot possibly run
  // leaves the user watching "processing" for a failure that was already knowable.
  const provider = deps.provider();
  if (provider === undefined) {
    throw new TranscriptionError(
      TranscriptionErrorCode.NotConfigured,
      'No transcription provider is configured. Set OPENAI_API_KEY and restart the server.',
    );
  }

  const granularity: TranscriptGranularity =
    readString(body, 'granularity') === 'segment' ? 'segment' : 'word';
  const languageHint = readString(body, 'language');
  // Placement is the client's explicit choice, recorded so the operation descriptor can honour
  // it. `auto` means "new track if the project has none, otherwise replace a purely
  // machine-generated track" — resolved here, with the manual-work refusal still enforced by
  // `applyTranscription` on the client.
  const placementRaw = readString(body, 'placement') ?? 'auto';

  const job = deps.jobs.create({
    projectId,
    type: JobType.Transcribe,
    sourceAssetId: assetId,
    now: new Date().toISOString(),
  });

  void deps.worker
    .run(job.id, async (signal) => {
      deps.jobs.update(job.id, (record) => startJob(record, new Date().toISOString()));
      try {
        const { resultRef, result } = await runTranscription({
          layout: deps.layout,
          document: project,
          provider,
          projectId,
          audioAssetId: assetId,
          granularity,
          ...(languageHint === undefined ? {} : { languageHint }),
          signal,
        });

        writeResult(deps.layout, job.id, result);

        // The job completes by recording *that a result exists*. It does not touch the
        // document — see the module header for why that is not negotiable.
        deps.jobs.update(job.id, (record) =>
          tryTransition(record, JobStatus.Completed, new Date().toISOString(), {
            result: { resultRef, label: transcriptionOperationLabel(result) },
          }),
        );
      } catch (error) {
        // A result that survived a failed job would be applied to the document as though it
        // were complete.
        discardResult(deps.layout, job.id);

        const cancelled =
          isTranscriptionError(error) && error.code === TranscriptionErrorCode.Cancelled;
        const message =
          error instanceof TranscriptionError || error instanceof IngestError
            ? error.message
            : 'Transcription failed.';
        deps.jobs.update(job.id, (record) =>
          tryTransition(
            record,
            cancelled ? JobStatus.Cancelled : JobStatus.Failed,
            new Date().toISOString(),
            {
              failure: { code: 'tool-failed', message },
            },
          ),
        );
      }
    })
    .catch(() => {
      deps.jobs.update(job.id, (record) =>
        tryTransition(record, JobStatus.Failed, new Date().toISOString(), {
          failure: { code: 'tool-failed', message: 'The processing worker stopped unexpectedly.' },
        }),
      );
    });

  return { jobId: job.id, placement: placementRaw };
}

/** Route a transcription request. Returns true when handled. */
export async function serveTranscriptionRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  segments: readonly string[],
  deps: TranscriptionRouteDeps,
): Promise<boolean> {
  const method = request.method ?? 'GET';

  // POST /api/projects/:projectId/assets/:assetId/transcribe
  if (
    method === 'POST' &&
    segments.length === 6 &&
    segments[0] === 'api' &&
    segments[1] === 'projects' &&
    segments[3] === 'assets' &&
    segments[5] === 'transcribe'
  ) {
    const projectId = segments[2];
    const assetId = segments[4];
    if (projectId === undefined || assetId === undefined) {
      throw new IngestError(ErrorCode.INVALID_UPLOAD, 'Missing project or asset id.');
    }
    const body = await readJson(request);
    const { jobId, placement } = await startTranscription(deps, projectId, assetId, body);
    sendJson(response, 202, {
      job: jobView(deps.jobs.get(jobId)),
      // Echoed so the client knows what it asked for without storing it anywhere server-side.
      requestedPlacement: placement,
    });
    return true;
  }

  // GET /api/jobs/:jobId/result
  if (
    method === 'GET' &&
    segments.length === 4 &&
    segments[0] === 'api' &&
    segments[1] === 'jobs' &&
    segments[3] === 'result'
  ) {
    const jobId = segments[2];
    if (jobId === undefined) {
      throw new IngestError(ErrorCode.INVALID_UPLOAD, 'Missing job id.');
    }
    const record = deps.jobs.get(jobId);
    const result = readResult(deps.layout, jobId);
    if (result === undefined) {
      // A job with no result is a normal state — running, or failed. Saying so explicitly is
      // better than a 404 that reads like "this job does not exist".
      sendJson(response, 409, {
        error: {
          code: 'RESULT_NOT_READY',
          message: 'This job has not produced a transcription yet.',
          status: record.status,
        },
      });
      return true;
    }
    sendJson(response, 200, { result });
    return true;
  }

  // GET /api/jobs/:jobId/operation
  //
  // Returns what to apply and where — never a document. See the module header.
  if (
    method === 'GET' &&
    segments.length === 4 &&
    segments[0] === 'api' &&
    segments[1] === 'jobs' &&
    segments[3] === 'operation'
  ) {
    const jobId = segments[2];
    if (jobId === undefined) {
      throw new IngestError(ErrorCode.INVALID_UPLOAD, 'Missing job id.');
    }
    const record = deps.jobs.get(jobId);
    const result = readResult(deps.layout, jobId);
    if (result === undefined) {
      sendJson(response, 409, {
        error: {
          code: 'RESULT_NOT_READY',
          message: 'This job has not produced a transcription yet.',
          status: record.status,
        },
      });
      return true;
    }
    sendJson(response, 200, {
      operation: {
        kind: 'apply-transcription',
        label: transcriptionOperationLabel(result),
        result,
      },
    });
    return true;
  }

  return false;
}

export { applyTranscription, type CanonicalTranscription };
