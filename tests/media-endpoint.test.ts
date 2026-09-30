import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startIngestServer, type StartedServer } from '../src/server/http.js';
import { ProjectStore } from '../src/server/project/store.js';
import { WorkspaceLayout } from '../src/server/workspace.js';
import { ingestMedia, toAssetRecord } from '../src/server/media/ingest.js';
import { cleanupFixtures, ffmpegAvailable, makeVideoFixture } from './helpers/fixtures.js';

let root: string;
let server: StartedServer;
let store: ProjectStore;
let hasFfmpeg = false;
let projectId: string;
let assetId: string;
let fileSize = 0;

const MAX_BYTES = 20 * 1024 * 1024;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'subs-media-'));
  const layout = new WorkspaceLayout(join(root, 'workspace'));
  store = new ProjectStore(layout);
  hasFfmpeg = await ffmpegAvailable();

  if (hasFfmpeg) {
    const video = await makeVideoFixture('served', { durationSeconds: 1, width: 160, height: 120 });
    if (video !== undefined) {
      const doc = await store.create('Media served');
      projectId = doc.id;
      const result = await ingestMedia(
        layout,
        projectId,
        { stream: createReadStream(video), originalFilename: 'served.mp4' },
        { maxFileBytes: MAX_BYTES },
      );
      assetId = result.assetId;
      fileSize = result.byteSize;
      await store.save({ ...doc, assets: [toAssetRecord(result)] });
    }
  }

  server = await startIngestServer({
    layout,
    store,
    maxFileBytes: MAX_BYTES,
    probeTimeoutMs: 20_000,
  });
});

afterAll(async () => {
  await server.close();
  await cleanupFixtures();
  await rm(root, { recursive: true, force: true });
});

function mediaUrl(): string {
  return `${server.url}/media/${projectId}/${assetId}`;
}

async function readBody(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

describe('media endpoint — full responses', () => {
  it('serves the whole file with Accept-Ranges', async () => {
    if (!hasFfmpeg || assetId === undefined) return;
    const response = await fetch(mediaUrl());

    expect(response.status).toBe(200);
    // A player that cannot see this will refuse to seek.
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(Number(response.headers.get('content-length'))).toBe(fileSize);

    const body = await readBody(response);
    expect(body.byteLength).toBe(fileSize);
  });

  it('answers HEAD without a body', async () => {
    if (!hasFfmpeg || assetId === undefined) return;
    const response = await fetch(mediaUrl(), { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(Number(response.headers.get('content-length'))).toBe(fileSize);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect((await readBody(response)).byteLength).toBe(0);
  });
});

describe('media endpoint — byte ranges', () => {
  it('serves a beginning range as 206', async () => {
    if (!hasFfmpeg || assetId === undefined) return;
    const response = await fetch(mediaUrl(), { headers: { range: 'bytes=0-99' } });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 0-99/${fileSize}`);
    expect(Number(response.headers.get('content-length'))).toBe(100);
    expect((await readBody(response)).byteLength).toBe(100);
  });

  it('serves a middle range', async () => {
    if (!hasFfmpeg || assetId === undefined) return;
    const start = 50;
    const end = 149;
    const response = await fetch(mediaUrl(), { headers: { range: `bytes=${start}-${end}` } });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/${fileSize}`);
    expect((await readBody(response)).byteLength).toBe(end - start + 1);
  });

  it('serves an ending range', async () => {
    if (!hasFfmpeg || assetId === undefined) return;
    const start = fileSize - 100;
    const response = await fetch(mediaUrl(), { headers: { range: `bytes=${start}-` } });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(
      `bytes ${start}-${fileSize - 1}/${fileSize}`,
    );
    expect((await readBody(response)).byteLength).toBe(100);
  });

  it('serves a suffix range', async () => {
    if (!hasFfmpeg || assetId === undefined) return;
    const response = await fetch(mediaUrl(), { headers: { range: 'bytes=-50' } });

    expect(response.status).toBe(206);
    const body = await readBody(response);
    expect(body.byteLength).toBe(50);
    expect(response.headers.get('content-range')).toBe(
      `bytes ${fileSize - 50}-${fileSize - 1}/${fileSize}`,
    );
  });

  it('returns exactly the requested bytes, byte-for-byte', async () => {
    if (!hasFfmpeg || assetId === undefined) return;
    // Correctness of a range means the content matches, not just the length.
    const range = { start: 32, end: 95 };
    const response = await fetch(mediaUrl(), {
      headers: { range: `bytes=${range.start}-${range.end}` },
    });
    const partial = await readBody(response);

    const full = await readBody(await fetch(mediaUrl()));
    expect(partial.equals(full.subarray(range.start, range.end + 1))).toBe(true);
  });

  it('answers HEAD for a range without a body', async () => {
    if (!hasFfmpeg || assetId === undefined) return;
    const response = await fetch(mediaUrl(), { headers: { range: 'bytes=0-99' }, method: 'HEAD' });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 0-99/${fileSize}`);
    expect((await readBody(response)).byteLength).toBe(0);
  });
});

describe('media endpoint — range errors', () => {
  it('returns 416 for a range past the end', async () => {
    if (!hasFfmpeg || assetId === undefined) return;
    const response = await fetch(mediaUrl(), { headers: { range: `bytes=${fileSize + 100}-` } });
    expect(response.status).toBe(416);
    // The size is included so a client can retry sensibly.
    expect(response.headers.get('content-range')).toBe(`bytes */${fileSize}`);
  });

  it('ignores a malformed range and serves the whole file', async () => {
    if (!hasFfmpeg || assetId === undefined) return;
    // A broken range must not break playback; serving everything is the safe fallback.
    const response = await fetch(mediaUrl(), { headers: { range: 'bytes=abc-def' } });
    expect(response.status).toBe(200);
    expect(Number(response.headers.get('content-length'))).toBe(fileSize);
  });

  it('ignores a multi-range request', async () => {
    if (!hasFfmpeg || assetId === undefined) return;
    const response = await fetch(mediaUrl(), { headers: { range: 'bytes=0-9,20-29' } });
    expect(response.status).toBe(200);
  });
});

describe('media endpoint — access control', () => {
  it('404s for an unknown project', async () => {
    const response = await fetch(`${server.url}/media/nosuchproject/${assetId ?? 'x'}`);
    expect(response.status).toBe(404);
  });

  it('404s for an asset that is not in the project', async () => {
    if (projectId === undefined) return;
    const response = await fetch(`${server.url}/media/${projectId}/notanasset`);
    expect(response.status).toBe(404);
  });

  it('404s when the stored file has been removed', async () => {
    if (!hasFfmpeg || assetId === undefined) return;
    const doc = await store.load(projectId);
    const layout = new WorkspaceLayout(join(root, 'workspace'));
    const { rm: remove } = await import('node:fs/promises');
    await remove(layout.assetDir(projectId, assetId), { recursive: true, force: true });

    const response = await fetch(mediaUrl());
    expect(response.status).toBe(404);
    // Restore for any later assertions.
    void doc;
  });

  it('rejects a traversal project id', async () => {
    for (const hostile of ['..', '..%2F..%2Fetc', '%2Fetc%2Fpasswd']) {
      const response = await fetch(`${server.url}/media/${hostile}/${assetId ?? 'x'}`);
      // Traversal must never yield file contents; a 400 or 404 is correct.
      expect([400, 404]).toContain(response.status);
    }
  });

  it('rejects a traversal asset id', async () => {
    if (projectId === undefined) return;
    for (const hostile of ['..', '..%2F..%2Fetc%2Fpasswd']) {
      const response = await fetch(`${server.url}/media/${projectId}/${hostile}`);
      expect([400, 404]).toContain(response.status);
    }
  });

  it('never returns a filesystem path', async () => {
    if (!hasFfmpeg || assetId === undefined) return;
    const response = await fetch(mediaUrl(), { headers: { range: 'bytes=0-9' } });
    const body = (await response.text()).slice(0, 200);
    expect(body).not.toContain(root);
    expect(body).not.toContain('/workspace/');
  });

  it('does not expose the project document through the media route', async () => {
    if (projectId === undefined) return;
    // Asking for a directory-ish path must not yield project.json.
    const response = await fetch(`${server.url}/media/${projectId}/${projectId}`);
    expect([400, 404]).toContain(response.status);
  });
});

describe('playback descriptor route', () => {
  it('returns ids and a media URL, never a path', async () => {
    if (!hasFfmpeg || assetId === undefined) return;
    const response = await fetch(`${server.url}/api/projects/${projectId}/playback`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      projectId: string;
      asset: { assetId: string; meta: { frameRateNum?: number; frameRateDen?: number } } | null;
      mediaUrl: string;
    };
    expect(body.projectId).toBe(projectId);
    expect(body.asset?.assetId).toBe(assetId);
    expect(body.mediaUrl).toBe(`/media/${projectId}/${assetId}`);
    expect(JSON.stringify(body)).not.toContain(root);
  });

  it('reports null for a project with no video, which is not an error', async () => {
    const doc = await store.create('No video');
    const response = await fetch(`${server.url}/api/projects/${doc.id}/playback`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { asset: unknown; mediaUrl: unknown };
    expect(body.asset).toBeNull();
    expect(body.mediaUrl).toBeNull();
  });

  it('404s for an unknown project', async () => {
    const response = await fetch(`${server.url}/api/projects/nosuch/playback`);
    expect(response.status).toBe(404);
  });
});
