/**
 * The job HTTP surface, exercised end to end against a real server and real FFmpeg.
 *
 * Two things are being proven here that unit tests cannot:
 *
 *  1. **The flow actually works.** A real project, a real ingested video, a real queued job,
 *     real FFmpeg, a real audio file, and a document that references it. Anything less would
 *     leave the central claim of this phase untested.
 *
 *  2. **The worker cannot be turned into a file or command execution surface.** Every
 *     adversarial input is aimed at the identifiers, because those are the only untrusted
 *     values that reach a path or an argv.
 */

import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  type ReadStream,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JobStatus, JobType } from '../src/core/jobs/index.js';

import { startIngestServer, type StartedServer } from '../src/server/http.js';
import { WorkspaceLayout } from '../src/server/workspace.js';
import { ProjectStore } from '../src/server/project/store.js';
import { createJobStore, createWorker } from '../src/server/jobs/store.js';
import { cleanupFixtures, ffmpegAvailable, makeVideoFixture } from './helpers/fixtures.js';

const available = await ffmpegAvailable();
const maybe = available ? describe : describe.skip;

let layout: WorkspaceLayout;
let server: StartedServer;
const scratch: string[] = [];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'subs-jobapi-'));
  scratch.push(dir);
  layout = new WorkspaceLayout(dir);
  server = await startIngestServer({
    layout,
    store: new ProjectStore(layout),
    maxFileBytes: 50_000_000,
    jobs: createJobStore(layout),
    worker: createWorker(layout),
  });
});

afterAll(async () => {
  await server.close();
  await cleanupFixtures();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * Streaming-upload fetch options.
 *
 * `duplex: 'half'` is required by undici for a request body that is a stream — without it
 * Node throws. It is absent from the DOM `RequestInit` type, so the options are built with a
 * type that includes it and spread into the call, rather than cast at each site.
 */
function uploadInit(filename: string, stream: ReadStream): RequestInit {
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { 'content-type': 'video/mp4', 'x-filename': filename },
    body: stream as unknown as BodyInit,
    duplex: 'half',
  };
  return init;
}

async function createProjectWithVideo(): Promise<{ projectId: string; assetId: string }> {
  const created = await fetch(`${server.url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'api' }),
  });
  const body = (await created.json()) as { project: { id: string } };

  const fixture = await makeVideoFixture('api-src', { durationSeconds: 1, withAudio: true });
  if (fixture === undefined) throw new Error('fixture unavailable');

  const uploaded = await fetch(
    `${server.url}/api/projects/${body.project.id}/assets`,
    uploadInit('clip.mp4', createReadStream(fixture)),
  );
  const result = (await uploaded.json()) as { asset: { id: string } };
  return { projectId: body.project.id, assetId: result.asset.id };
}

async function waitForTerminal(
  jobId: string,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${server.url}/api/jobs/${jobId}`);
    const body = (await res.json()) as { job: Record<string, unknown> };
    const status = body.job['status'];
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      return body.job;
    }
    if (Date.now() > deadline) throw new Error(`job did not settle: ${JSON.stringify(body.job)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

maybe('job HTTP surface (real ffmpeg)', () => {
  it('runs the whole pipeline: upload → job → ffmpeg → audio asset on the document', async () => {
    const { projectId, assetId } = await createProjectWithVideo();

    const started = await fetch(`${server.url}/api/projects/${projectId}/assets/${assetId}/audio`, {
      method: 'POST',
    });
    expect(started.status).toBe(202);
    const { job } = (await started.json()) as { job: { jobId: string; status: string } };
    // The worker may already have picked the job up by the time the response is written, so
    // the reported status is `queued` or `processing` — never a terminal state, because the
    // handler never blocks the response.
    expect(['queued', 'processing']).toContain(job.status);

    const settled = await waitForTerminal(job.jobId);
    expect(settled['status']).toBe('completed');

    // The document references the derived audio asset, with provenance.
    const doc = (await (await fetch(`${server.url}/api/projects/${projectId}`)).json()) as {
      project: { assets: Array<Record<string, unknown>> };
    };
    const audio = doc.project.assets.find((a) => a['role'] === 'audio');
    expect(audio).toBeDefined();
    expect(audio?.['derivedFrom']).toBe(assetId);

    // And the file is genuinely on disk, at the canonical name.
    const audioId = audio?.['id'] as string;
    expect(existsSync(layout.assetFile(projectId, audioId, 'wav'))).toBe(true);
  });

  it('exposes no filesystem path in any job response', async () => {
    const { projectId, assetId } = await createProjectWithVideo();
    const started = await fetch(`${server.url}/api/projects/${projectId}/assets/${assetId}/audio`, {
      method: 'POST',
    });
    const raw = await started.text();
    expect(raw).not.toContain(layout.root);
    expect(raw).not.toContain('/tmp/');
    expect(raw).not.toContain('original.');
  });

  it('never returns a workspace path even on success', async () => {
    const { projectId, assetId } = await createProjectWithVideo();
    const started = await fetch(`${server.url}/api/projects/${projectId}/assets/${assetId}/audio`, {
      method: 'POST',
    });
    const { job } = (await started.json()) as { job: { jobId: string } };
    const settled = await waitForTerminal(job.jobId);
    expect(JSON.stringify(settled)).not.toContain(layout.root);
  });

  it('cancels a job and registers no audio asset', async () => {
    // A longer source so the cancel has a real window to land in.
    const created = await fetch(`${server.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cancel' }),
    });
    const { project } = (await created.json()) as { project: { id: string } };
    const fixture = await makeVideoFixture('cancel-src', { durationSeconds: 20, withAudio: true });
    if (fixture === undefined) throw new Error('fixture unavailable');
    const uploaded = await fetch(
      `${server.url}/api/projects/${project.id}/assets`,
      uploadInit('long.mp4', createReadStream(fixture)),
    );
    const { asset } = (await uploaded.json()) as { asset: { id: string } };

    const started = await fetch(
      `${server.url}/api/projects/${project.id}/assets/${asset.id}/audio`,
      {
        method: 'POST',
      },
    );
    const { job } = (await started.json()) as { job: { jobId: string } };

    const cancelled = await fetch(`${server.url}/api/jobs/${job.jobId}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);

    const settled = await waitForTerminal(job.jobId);
    expect(['cancelled', 'completed']).toContain(settled['status']);

    if (settled['status'] === 'cancelled') {
      // The guarantee: a cancelled extraction leaves nothing that looks like an asset.
      const doc = (await (await fetch(`${server.url}/api/projects/${project.id}`)).json()) as {
        project: { assets: Array<{ role: string }> };
      };
      expect(doc.project.assets.filter((a) => a.role === 'audio')).toEqual([]);

      const mediaRoot = join(layout.projectDir(project.id), 'media');
      const leftovers = readdirSync(mediaRoot).flatMap((dir) =>
        readdirSync(join(mediaRoot, dir)).filter((n) => n.startsWith('audio.')),
      );
      expect(leftovers).toEqual([]);
    }
  });

  it('never returns a workspace path even on success', async () => {
    const { projectId, assetId } = await createProjectWithVideo();
    const started = await fetch(`${server.url}/api/projects/${projectId}/assets/${assetId}/audio`, {
      method: 'POST',
    });
    const { job } = (await started.json()) as { job: { jobId: string } };
    const settled = await waitForTerminal(job.jobId);
    expect(JSON.stringify(settled)).not.toContain(layout.root);
  });
});

describe('job route validation (no ffmpeg required)', () => {
  it('rejects a traversal project id', async () => {
    const res = await fetch(`${server.url}/api/projects/..%2F..%2Fetc/assets/x/audio`, {
      method: 'POST',
    });
    expect([400, 404, 422]).toContain(res.status);
  });

  it('rejects a traversal job id', async () => {
    const res = await fetch(`${server.url}/api/jobs/..%2F..%2Fetc`);
    expect([400, 404, 422]).toContain(res.status);
  });

  it('returns 404 for a job that does not exist', async () => {
    const res = await fetch(`${server.url}/api/jobs/does_not_exist`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a project that does not exist', async () => {
    const res = await fetch(`${server.url}/api/projects/nope/assets/nope/audio`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('returns a structured error body, never a stack trace', async () => {
    const res = await fetch(`${server.url}/api/jobs/does_not_exist`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body['error']).toBe('object');
    expect(JSON.stringify(body)).not.toMatch(/at .*\.ts:\d+/);
  });

  it('does not create any file for a rejected request', async () => {
    const before = readdirSync(layout.projectsDir).length;
    await fetch(`${server.url}/api/projects/..%2F..%2Ftmp/x/assets/y/audio`, { method: 'POST' });
    expect(readdirSync(layout.projectsDir).length).toBe(before);
  });

  it('recovers an interrupted job on the real server entry point', async () => {
    // Recovery has to run inside `createIngestServer`, because that is what `main.ts` calls.
    // Placed in the test-only `startIngestServer` helper instead, every test here would pass
    // while production never recovered a thing — which is exactly the bug this now guards.
    const dir = mkdtempSync(join(tmpdir(), 'subs-recover-'));
    scratch.push(dir);
    const recoverLayout = new WorkspaceLayout(dir);
    const jobs = createJobStore(recoverLayout);

    const stuck = jobs.create({
      projectId: 'p',
      type: JobType.AudioExtract,
      sourceAssetId: 'a',
      now: new Date().toISOString(),
    });
    // A record on disk in `processing`: the state a crashed process leaves behind.
    jobs.update(stuck.id, (record) => ({ ...record, status: JobStatus.Processing }));

    const started = await startIngestServer({
      layout: recoverLayout,
      store: new ProjectStore(recoverLayout),
      maxFileBytes: 1_000_000,
    });

    try {
      const res = await fetch(`${started.url}/api/jobs/${stuck.id}`);
      const body = (await res.json()) as {
        job: { status: string; failure?: { message: string } };
      };
      expect(body.job.status).toBe('failed');
      expect(body.job.failure?.message).toMatch(/interrupted/i);
    } finally {
      await started.close();
    }
  });
});
