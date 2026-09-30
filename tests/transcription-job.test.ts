/**
 * The transcription job end to end, and the regression test for invariant I-20.
 *
 * The I-20 test is the most important file in this phase. Phase 0 declared the rule in a comment;
 * nothing enforced it. Phase 4 is the first phase where a worker could actually break it, so the
 * rule now has a test that fails if the worker ever starts writing the document.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { JobType } from '../src/core/jobs/index.js';
import {
  applyTranscription,
  TranscriptionErrorCode,
  type ProviderTranscript,
  type TranscriptionProvider,
} from '../src/core/transcription/index.js';
import { validateInvariants } from '../src/core/validation/index.js';
import { startIngestServer } from '../src/server/http.js';
import { ProjectStore } from '../src/server/project/store.js';
import { WorkspaceLayout } from '../src/server/workspace.js';
import { createJobStore, createWorker } from '../src/server/jobs/store.js';
import { CANONICAL_AUDIO } from '../src/server/media/audio.js';

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function workspace(): WorkspaceLayout {
  const dir = mkdtempSync(join(tmpdir(), 'subs-t4-'));
  scratch.push(dir);
  return new WorkspaceLayout(dir);
}

/** A provider that answers from a fixture, with no network. */
function fixtureProvider(overrides: Partial<ProviderTranscript> = {}): TranscriptionProvider {
  return {
    id: 'fixture',
    supportsWordTiming: true,
    transcribe: async () =>
      Promise.resolve({
        providerId: 'fixture',
        model: 'fixture-model',
        language: 'en',
        text: 'Hello there.',
        segments: [
          {
            start: 0,
            end: 1.5,
            text: 'Hello there.',
            words: [
              { text: 'Hello', start: 0, end: 0.6, confidence: 0.9 },
              { text: 'there', start: 0.6, end: 1.5 },
            ],
          },
        ],
        warnings: [],
        ...overrides,
      }),
  };
}

/**
 * Build a project with a real Phase 3 audio asset on disk.
 *
 * The file is written by hand rather than produced by ffmpeg: this suite is about the
 * transcription pipeline, and the audio's *content* is irrelevant to every assertion. Its
 * metadata is what matters, and that is exactly what Phase 3 would have recorded.
 */
async function projectWithAudio(
  layout: WorkspaceLayout,
): Promise<{ projectId: string; assetId: string }> {
  const projects = new ProjectStore(layout);
  const project = await projects.create('transcribe');
  const assetId = 'audio_fixture';

  const dir = layout.assetDir(project.id, assetId);
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(layout.assetFile(project.id, assetId, CANONICAL_AUDIO.extension), 'RIFFfake');

  const doc = await projects.load(project.id);
  await projects.save({
    ...doc,
    assets: [
      ...doc.assets,
      {
        id: assetId,
        role: 'audio',
        filename: 'audio.wav',
        mimeType: 'audio/wav',
        byteSize: 9,
        meta: {
          durationMs: 1500,
          audioCodec: CANONICAL_AUDIO.codec,
          sampleRate: CANONICAL_AUDIO.sampleRate,
          channels: CANONICAL_AUDIO.channels,
        },
      },
    ],
  });
  return { projectId: project.id, assetId };
}

async function serverFor(
  layout: WorkspaceLayout,
  provider: () => TranscriptionProvider | undefined,
) {
  return startIngestServer({
    layout,
    store: new ProjectStore(layout),
    maxFileBytes: 1_000_000,
    jobs: createJobStore(layout),
    worker: createWorker(layout),
    transcriptionProvider: provider,
  });
}

describe('transcription job', () => {
  it('runs to completion and exposes a canonical result', async () => {
    const layout = workspace();
    const seeded = await projectWithAudio(layout);
    const server = await serverFor(layout, () => fixtureProvider());
    try {
      const started = await fetch(
        `${server.url}/api/projects/${seeded.projectId}/assets/${seeded.assetId}/transcribe`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      expect(started.status).toBe(202);
      const { job } = (await started.json()) as { job: { jobId: string } };

      let status = 'queued';
      for (let i = 0; i < 200 && status !== 'completed' && status !== 'failed'; i += 1) {
        const res = await fetch(`${server.url}/api/jobs/${job.jobId}`);
        const body = (await res.json()) as { job: { status: string } };
        status = body.job.status;
        if (status === 'queued' || status === 'processing')
          await new Promise((r) => setTimeout(r, 10));
      }
      expect(status).toBe('completed');

      const resultRes = await fetch(`${server.url}/api/jobs/${job.jobId}/result`);
      expect(resultRes.status).toBe(200);
      const { result } = (await resultRes.json()) as {
        result: { segments: Array<{ startMs: number; words: unknown[] }>; language: string };
      };
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0]?.startMs).toBe(0);
      expect(result.segments[0]?.words).toHaveLength(2);
      expect(result.language).toBe('en');
    } finally {
      await server.close();
    }
  });

  it('reports not-configured without queuing a job', async () => {
    // Failing before the job exists is what keeps the user from watching "processing" for a
    // failure that was knowable at request time.
    const layout = workspace();
    const seeded = await projectWithAudio(layout);
    const server = await serverFor(layout, () => undefined);
    try {
      const res = await fetch(
        `${server.url}/api/projects/${seeded.projectId}/assets/${seeded.assetId}/transcribe`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(TranscriptionErrorCode.NotConfigured);
      expect(createJobStore(layout).list(seeded.projectId)).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('refuses to transcribe a video asset', async () => {
    // An audio role is checked, not assumed: sending a video to a speech API wastes a request
    // and produces a confusing error from the far side.
    const layout = workspace();
    const projects = new ProjectStore(layout);
    const project = await projects.create('no-audio');
    const doc = await projects.load(project.id);
    await projects.save({
      ...doc,
      assets: [
        ...doc.assets,
        {
          id: 'vid',
          role: 'sourceVideo',
          filename: 'clip.mp4',
          mimeType: 'video/mp4',
          byteSize: 1,
        },
      ],
    });
    const server = await serverFor(layout, () => fixtureProvider());
    try {
      const res = await fetch(`${server.url}/api/projects/${project.id}/assets/vid/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('fails the job and stores no result when the provider rejects the audio', async () => {
    const layout = workspace();
    const seeded = await projectWithAudio(layout);
    const failing: TranscriptionProvider = {
      id: 'fixture',
      supportsWordTiming: true,
      transcribe: async () => {
        throw new (await import('../src/core/transcription/index.js')).TranscriptionError(
          TranscriptionErrorCode.UnsupportedAudio,
          'The audio could not be processed.',
        );
      },
    };
    const server = await serverFor(layout, () => failing);
    try {
      const started = await fetch(
        `${server.url}/api/projects/${seeded.projectId}/assets/${seeded.assetId}/transcribe`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      const { job } = (await started.json()) as { job: { jobId: string } };

      let status = 'queued';
      for (let i = 0; i < 200 && status !== 'completed' && status !== 'failed'; i += 1) {
        const res = await fetch(`${server.url}/api/jobs/${job.jobId}`);
        const body = (await res.json()) as { job: { status: string } };
        status = body.job.status;
        if (status === 'queued' || status === 'processing')
          await new Promise((r) => setTimeout(r, 10));
      }
      expect(status).toBe('failed');

      // No result for a failed job — the guarantee that keeps a partial transcript from being
      // applied to the document.
      const resultRes = await fetch(`${server.url}/api/jobs/${job.jobId}/result`);
      expect(resultRes.status).toBe(409);
    } finally {
      await server.close();
    }
  });

  it('returns 409, not 404, for a job that has no result yet', async () => {
    // "Not ready" and "does not exist" are different answers, and conflating them sends the UI
    // looking for a job that simply has not finished.
    const layout = workspace();
    const jobs = createJobStore(layout);
    const job = jobs.create({
      projectId: 'p',
      type: JobType.Transcribe,
      sourceAssetId: 'a',
      now: new Date().toISOString(),
    });
    const server = await serverFor(layout, () => fixtureProvider());
    try {
      const res = await fetch(`${server.url}/api/jobs/${job.id}/result`);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; status: string } };
      expect(body.error.code).toBe('RESULT_NOT_READY');
      // The job was queued before this server started, so startup recovery has already marked it
      // failed — its process is gone. Either state is a legitimate answer here; what matters is
      // that the response distinguishes "no result" from "no such job".
      expect(['queued', 'failed']).toContain(body.error.status);
    } finally {
      await server.close();
    }
  });
});

describe('invariant I-20 — the worker must not write the document', () => {
  it('leaves ProjectDocument unchanged after a transcription job completes', async () => {
    // THE regression test. A worker that saved the document would make the undo stack hold
    // snapshots of a document that no longer exists, and would give the largest change the
    // document ever undergoes no undo entry at all.
    const layout = workspace();
    const seeded = await projectWithAudio(layout);
    const before = JSON.stringify(await new ProjectStore(layout).load(seeded.projectId));

    const server = await serverFor(layout, () => fixtureProvider());
    try {
      const started = await fetch(
        `${server.url}/api/projects/${seeded.projectId}/assets/${seeded.assetId}/transcribe`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      const { job } = (await started.json()) as { job: { jobId: string } };

      let status = 'queued';
      for (let i = 0; i < 200 && status !== 'completed' && status !== 'failed'; i += 1) {
        const res = await fetch(`${server.url}/api/jobs/${job.jobId}`);
        const body = (await res.json()) as { job: { status: string } };
        status = body.job.status;
        if (status === 'queued' || status === 'processing')
          await new Promise((r) => setTimeout(r, 10));
      }
      expect(status).toBe('completed');

      const after = await new ProjectStore(layout).load(seeded.projectId);
      expect(JSON.stringify(after)).toBe(before);
      // Specifically: no transcript was written into the document behind the client's back.
      expect(after.tracks).toEqual([]);
      expect(after.transcription).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('exposes an operation descriptor instead of a mutated document', async () => {
    const layout = workspace();
    const seeded = await projectWithAudio(layout);
    const server = await serverFor(layout, () => fixtureProvider());
    try {
      const started = await fetch(
        `${server.url}/api/projects/${seeded.projectId}/assets/${seeded.assetId}/transcribe`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      const { job } = (await started.json()) as { job: { jobId: string } };
      for (let i = 0; i < 200; i += 1) {
        const res = await fetch(`${server.url}/api/jobs/${job.jobId}`);
        const body = (await res.json()) as { job: { status: string } };
        if (body.job.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 10));
      }

      const res = await fetch(`${server.url}/api/jobs/${job.jobId}/operation`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { operation: Record<string, unknown> };

      // The response describes an operation; it is not a project document.
      expect(body.operation['kind']).toBe('apply-transcription');
      expect(body.operation['label']).toMatch(/^Transcribe \(fixture,/);
      expect(body.operation).not.toHaveProperty('tracks');
      expect(body.operation).not.toHaveProperty('assets');
      expect(body.operation).not.toHaveProperty('schemaVersion');
    } finally {
      await server.close();
    }
  });

  it('applies as a pure labelled operation on the client, yielding a valid document', async () => {
    const layout = workspace();
    const seeded = await projectWithAudio(layout);
    const server = await serverFor(layout, () => fixtureProvider());
    try {
      const started = await fetch(
        `${server.url}/api/projects/${seeded.projectId}/assets/${seeded.assetId}/transcribe`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      const { job } = (await started.json()) as { job: { jobId: string } };
      for (let i = 0; i < 200; i += 1) {
        const res = await fetch(`${server.url}/api/jobs/${job.jobId}`);
        const body = (await res.json()) as { job: { status: string } };
        if (body.job.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const { result } = (await (
        await fetch(`${server.url}/api/jobs/${job.jobId}/result`)
      ).json()) as { result: never };

      // This is the client half of I-20, and it is one undo entry for the whole transcript.
      const doc = await new ProjectStore(layout).load(seeded.projectId);
      const next = applyTranscription(
        doc,
        result,
        { kind: 'new-track' },
        '2026-01-01T00:00:00.000Z',
      );
      expect(next.tracks).toHaveLength(1);
      expect(validateInvariants(next)).toEqual({ valid: true, violations: [] });
      expect(next.transcription?.providerId).toBe('fixture');
    } finally {
      await server.close();
    }
  });
});

describe('result storage', () => {
  it('keeps the result beside the job record, not inside it', async () => {
    // A transcript can be hundreds of segments. Embedding it in job.json would mean every status
    // poll re-parses it, and would put transcript content in the volatile runtime store.
    const layout = workspace();
    const seeded = await projectWithAudio(layout);
    const server = await serverFor(layout, () => fixtureProvider());
    try {
      const started = await fetch(
        `${server.url}/api/projects/${seeded.projectId}/assets/${seeded.assetId}/transcribe`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      const { job } = (await started.json()) as { job: { jobId: string } };
      for (let i = 0; i < 200; i += 1) {
        const res = await fetch(`${server.url}/api/jobs/${job.jobId}`);
        const body = (await res.json()) as { job: { status: string } };
        if (body.job.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 10));
      }

      const jobs = createJobStore(layout);
      expect(jobs.get(job.jobId).result?.resultRef).toBe('result.json');
      expect(existsSync(layout.jobResultFile(job.jobId))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('exposes no filesystem path in any response', async () => {
    const layout = workspace();
    const seeded = await projectWithAudio(layout);
    const server = await serverFor(layout, () => fixtureProvider());
    try {
      const started = await fetch(
        `${server.url}/api/projects/${seeded.projectId}/assets/${seeded.assetId}/transcribe`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      const raw = await started.text();
      expect(raw).not.toContain(layout.root);
      const { job } = JSON.parse(raw) as { job: { jobId: string } };
      for (let i = 0; i < 200; i += 1) {
        const res = await fetch(`${server.url}/api/jobs/${job.jobId}`);
        if (((await res.json()) as { job: { status: string } }).job.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const resultRaw = await (await fetch(`${server.url}/api/jobs/${job.jobId}/result`)).text();
      expect(resultRaw).not.toContain(layout.root);
      expect(resultRaw).not.toContain('/tmp/');
    } finally {
      await server.close();
    }
  });

  it('rejects traversal in a job id before any path is built', async () => {
    const server = await serverFor(workspace(), () => fixtureProvider());
    try {
      const res = await fetch(`${server.url}/api/jobs/..%2F..%2Fetc/result`);
      expect([400, 404, 422]).toContain(res.status);
    } finally {
      await server.close();
    }
  });
});
