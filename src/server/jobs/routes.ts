/**
 * Job HTTP routes — the smallest surface that demonstrates the Phase 3 pipeline.
 *
 * Three endpoints, derived from what the flow actually needs:
 *
 *   POST /api/projects/:projectId/assets/:assetId/audio   → enqueue extraction
 *   GET  /api/jobs/:jobId                                 → poll status/progress
 *   POST /api/jobs/:jobId/cancel                          → request cancellation
 *
 * Deliberately not a generic job API. There is no `GET /api/jobs`, no filtering, no
 * pagination, and no job-management surface: each route maps to one step of one flow.
 *
 * ## The handler never waits for the work
 *
 * The POST that starts extraction returns immediately with a queued job. If it awaited the
 * FFmpeg run, a two-minute extraction would hold a socket open, be killed by any proxy
 * timeout, and produce no progress at all — the precise failure the job model exists to
 * avoid. The client polls instead.
 *
 * ## Registration happens here, not in the worker
 *
 * When a job succeeds, the worker has produced a *file*. This module is what turns that
 * file into an asset on the document, as an ordinary request-path mutation with its own
 * error handling. The worker never writes `ProjectDocument` (invariant I-20).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  cancelJob,
  JobStatus,
  JobType,
  reportProgress,
  startJob,
  tryTransition,
  type JobProgress,
} from '../../core/jobs/index.js';
import type { AssetId } from '../../core/document/ids.js';
import type { MediaMeta } from '../../core/document/types.js';
import { ErrorCode, IngestError } from '../errors.js';
import { runAudioExtraction } from '../media/audio.js';
import type { JobStore } from '../jobs/store.js';
import type { Worker } from '../jobs/store.js';
import type { ProjectStore } from '../project/store.js';
import type { WorkspaceLayout } from '../workspace.js';

export interface JobRouteDeps {
  layout: WorkspaceLayout;
  projects: ProjectStore;
  jobs: JobStore;
  worker: Worker;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

/**
 * The job projection sent to the client.
 *
 * A deliberate subset. `sourceAssetId` is included because the client needs to know what is
 * being worked on; no filesystem path, no stderr tail, and no internal timing detail is
 * exposed. The `sourceDurationMs` guard below keeps a malformed stored value from
 * poisoning the progress ratio.
 */
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

/**
 * Register a completed audio asset against the project document.
 *
 * Runs on the request path, after the job succeeded. It is a plain document mutation saved
 * through `ProjectStore.save`, so it is validated and atomic like every other write. If it
 * throws, the job is marked failed rather than being left claiming success for an asset
 * nobody can see — a "completed" job whose asset is not in the document is worse than a
 * failure, because the UI would move on and the user would find out later.
 */
async function registerAudioAsset(
  deps: JobRouteDeps,
  projectId: string,
  jobId: string,
  input: {
    assetId: AssetId;
    meta: MediaMeta;
    durationDeltaMs: number;
    transform: string;
    sourceAssetId: AssetId;
  },
  now: string,
): Promise<void> {
  const project = await deps.projects.load(projectId);

  const already = project.assets.some((asset) => asset.id === input.assetId);
  const assets = already
    ? project.assets
    : [
        ...project.assets,
        {
          id: input.assetId,
          role: 'audio' as const,
          // The canonical name is ours, not the user's: this file was produced by us and its
          // name carries no information about the original.
          filename: 'audio.wav',
          mimeType: 'audio/wav',
          byteSize: 0,
          meta: input.meta,
          derivedFrom: input.sourceAssetId,
          transform: input.transform,
        },
      ];

  await deps.projects.save({ ...project, assets, updatedAt: now });

  deps.jobs.update(jobId, (record) =>
    tryTransition(record, JobStatus.Completed, now, {
      result: { assetId: input.assetId, label: 'Extract audio' },
    }),
  );
}

/** Start the extraction for one source asset. */
async function startExtraction(
  deps: JobRouteDeps,
  projectId: string,
  assetId: string,
): Promise<{ jobId: string }> {
  const project = await deps.projects.load(projectId);
  const source = project.assets.find((asset) => asset.id === assetId);
  if (source === undefined) {
    throw new IngestError(ErrorCode.MISSING_ASSET, `Project has no asset ${assetId}.`);
  }
  if (source.role !== 'sourceVideo') {
    throw new IngestError(
      ErrorCode.INVALID_UPLOAD,
      'Only a source video can have its audio extracted.',
    );
  }

  const job = deps.jobs.create({
    projectId,
    type: JobType.AudioExtract,
    sourceAssetId: assetId,
    now: new Date().toISOString(),
  });

  // Deliberately not awaited. The job runs on the worker's single slot; the client polls.
  void deps.worker
    .run(job.id, async (signal) => {
      const startedAt = new Date().toISOString();
      deps.jobs.update(job.id, (record) => startJob(record, startedAt));

      try {
        const result = await runAudioExtraction(
          {
            layout: deps.layout,
            signal,
            onProgress: (progress: JobProgress) => {
              deps.jobs.update(job.id, (record) =>
                reportProgress(record, progress, new Date().toISOString()),
              );
            },
          },
          {
            projectId,
            assetId: assetId,
            sourceDurationMs: source.meta?.durationMs,
          },
        );

        await registerAudioAsset(
          deps,
          projectId,
          job.id,
          {
            assetId: result.assetId,
            meta: result.meta,
            durationDeltaMs: result.durationDeltaMs,
            transform: result.transform,
            sourceAssetId: assetId,
          },
          new Date().toISOString(),
        );
      } catch (error) {
        const message = error instanceof IngestError ? error.message : 'Audio extraction failed.';
        const code =
          error instanceof IngestError && error.code === ErrorCode.CANCELLED
            ? JobStatus.Cancelled
            : JobStatus.Failed;
        deps.jobs.update(job.id, (record) =>
          tryTransition(record, code, new Date().toISOString(), {
            failure: { code: 'tool-failed', message },
          }),
        );
      }
    })
    .catch(() => {
      // `run` rejects only if the handler throws outside its own try — which it should not.
      // Recorded rather than swallowed so a genuinely unexpected failure is visible.
      deps.jobs.update(job.id, (record) =>
        tryTransition(record, JobStatus.Failed, new Date().toISOString(), {
          failure: { code: 'tool-failed', message: 'The processing worker stopped unexpectedly.' },
        }),
      );
    });

  return { jobId: job.id };
}

/**
 * Route a job request. Returns true when handled.
 *
 * Follows the same shape as `serveMedia`: the caller tries each handler in turn.
 */
export async function serveJobRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  segments: readonly string[],
  deps: JobRouteDeps,
): Promise<boolean> {
  const method = request.method ?? 'GET';

  // POST /api/projects/:projectId/assets/:assetId/audio
  if (
    method === 'POST' &&
    segments.length === 6 &&
    segments[0] === 'api' &&
    segments[1] === 'projects' &&
    segments[3] === 'assets' &&
    segments[5] === 'audio'
  ) {
    const projectId = segments[2];
    const assetId = segments[4];
    if (projectId === undefined || assetId === undefined) {
      throw new IngestError(ErrorCode.INVALID_UPLOAD, 'Missing project or asset id.');
    }
    const { jobId } = await startExtraction(deps, projectId, assetId);
    sendJson(response, 202, { job: jobView(deps.jobs.get(jobId)) });
    return true;
  }

  // GET /api/jobs/:jobId
  if (
    method === 'GET' &&
    segments.length === 3 &&
    segments[0] === 'api' &&
    segments[1] === 'jobs'
  ) {
    const jobId = segments[2];
    if (jobId === undefined) {
      throw new IngestError(ErrorCode.INVALID_UPLOAD, 'Missing job id.');
    }
    sendJson(response, 200, { job: jobView(deps.jobs.get(jobId)) });
    return true;
  }

  // POST /api/jobs/:jobId/cancel
  if (
    method === 'POST' &&
    segments.length === 4 &&
    segments[0] === 'api' &&
    segments[1] === 'jobs' &&
    segments[3] === 'cancel'
  ) {
    const jobId = segments[2];
    if (jobId === undefined) {
      throw new IngestError(ErrorCode.INVALID_UPLOAD, 'Missing job id.');
    }
    const record = deps.jobs.get(jobId);

    if (record.status === JobStatus.Completed || record.status === JobStatus.Failed) {
      // Already finished. Cancelling is a no-op rather than an error: the client asked, and
      // the honest answer is "it already ended". Returning 409 would make a racing UI show
      // a failure for a request that did its job.
      sendJson(response, 200, { job: jobView(record), cancelled: false });
      return true;
    }

    const signalled = deps.worker.cancel(jobId);
    // For a queued job the worker has no handle to signal yet, so the record is cancelled
    // directly. The handler will still run, observe an already-aborted signal, and its own
    // transition will be a no-op because the job is already terminal.
    const updated =
      signalled && record.status === JobStatus.Processing
        ? record
        : deps.jobs.update(jobId, (current) => cancelJob(current, new Date().toISOString()));

    sendJson(response, 200, { job: jobView(updated), cancelled: true });
    return true;
  }

  return false;
}
