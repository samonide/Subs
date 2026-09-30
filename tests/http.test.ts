import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startIngestServer, type StartedServer } from '../src/server/http.js';
import { ProjectStore } from '../src/server/project/store.js';
import { WorkspaceLayout } from '../src/server/workspace.js';
import {
  cleanupFixtures,
  ffmpegAvailable,
  makeRawFixture,
  makeVideoFixture,
} from './helpers/fixtures.js';

let root: string;
let server: StartedServer;
let store: ProjectStore;
let hasFfmpeg = false;
let videoPath: string | undefined;

const MAX_BYTES = 20 * 1024 * 1024;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'subs-http-'));
  const layout = new WorkspaceLayout(join(root, 'workspace'));
  store = new ProjectStore(layout);
  hasFfmpeg = await ffmpegAvailable();
  if (hasFfmpeg) {
    videoPath = await makeVideoFixture('http-source', {
      durationSeconds: 1,
      width: 160,
      height: 120,
      withAudio: false,
    });
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

async function postJson(path: string, body: unknown) {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('project endpoints', () => {
  it('creates a project', async () => {
    const { status, body } = await postJson('/api/projects', { name: 'HTTP project' });
    expect(status).toBe(201);
    const project = body['project'] as { id: string; name: string };
    expect(project.name).toBe('HTTP project');
    expect(project.id).toBeTruthy();
  });

  it('loads a created project', async () => {
    const created = await postJson('/api/projects', { name: 'Loadable' });
    const project = created.body['project'] as { id: string };
    const response = await fetch(`${server.url}/api/projects/${project.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { project: { id: string } };
    expect(body.project.id).toBe(project.id);
  });

  it('returns a structured 404 for a missing project', async () => {
    const response = await fetch(`${server.url}/api/projects/doesnotexist`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('returns a structured 400 for an unknown route', async () => {
    const response = await fetch(`${server.url}/api/nope`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_UPLOAD');
  });

  it('does not leak a stack trace on an unexpected path', async () => {
    const response = await fetch(`${server.url}/api/projects/%2F%2F%2Fetc`);
    const text = await response.text();
    expect(text).not.toContain('at Object.');
    expect(text).not.toContain('.ts:');
  });
});

describe('asset upload endpoint', () => {
  it('accepts a real video and registers it in the project', async () => {
    if (!hasFfmpeg || videoPath === undefined) return;
    const created = await postJson('/api/projects', { name: 'Upload target' });
    const projectId = (created.body['project'] as { id: string }).id;

    const bytes = await readAll(videoPath);
    const response = await fetch(`${server.url}/api/projects/${projectId}/assets`, {
      method: 'POST',
      headers: { 'x-filename': 'clip.mp4', 'content-type': 'video/mp4' },
      // A UintArray, not a Node Buffer: `fetch`'s BodyInit type rejects Buffer outright.
      body: new Uint8Array(bytes),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { asset: { id: string; meta: { width: number } } };
    expect(body.asset.id).toBeTruthy();
    expect(body.asset.meta.width).toBe(160);

    // The persisted project now references the asset.
    const reloaded = await store.load(projectId);
    expect(reloaded.assets).toHaveLength(1);
    expect(reloaded.assets[0]?.id).toBe(body.asset.id);
  });

  it('rejects an unsupported type with a structured 415', async () => {
    const created = await postJson('/api/projects', { name: 'Bad type' });
    const projectId = (created.body['project'] as { id: string }).id;

    const response = await fetch(`${server.url}/api/projects/${projectId}/assets`, {
      method: 'POST',
      headers: { 'x-filename': 'evil.exe', 'content-type': 'application/octet-stream' },
      body: new Uint8Array(Buffer.from('nope')),
    });

    expect(response.status).toBe(415);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA');
  });

  it('rejects an oversized upload with a structured 413 and registers nothing', async () => {
    const created = await postJson('/api/projects', { name: 'Too big' });
    const projectId = (created.body['project'] as { id: string }).id;

    const response = await fetch(`${server.url}/api/projects/${projectId}/assets`, {
      method: 'POST',
      headers: { 'x-filename': 'big.mp4', 'content-type': 'video/mp4' },
      body: new Uint8Array(Buffer.alloc(25 * 1024 * 1024, 0x41)),
    });

    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FILE_TOO_LARGE');

    // A rejected upload must leave the project untouched.
    const reloaded = await store.load(projectId);
    expect(reloaded.assets).toHaveLength(0);
  });

  it('rejects a non-media file with a structured error', async () => {
    const notMedia = await makeRawFixture('http-bad.mp4', 'definitely not a video');
    const created = await postJson('/api/projects', { name: 'Not media' });
    const projectId = (created.body['project'] as { id: string }).id;

    const response = await fetch(`${server.url}/api/projects/${projectId}/assets`, {
      method: 'POST',
      headers: { 'x-filename': 'fake.mp4', 'content-type': 'video/mp4' },
      body: new Uint8Array(await readAll(notMedia)),
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INSPECTION_FAILED');

    const reloaded = await store.load(projectId);
    expect(reloaded.assets).toHaveLength(0);
  });

  it('sanitizes a traversal filename and never returns a server path', async () => {
    const created = await postJson('/api/projects', { name: 'Traversal' });
    const projectId = (created.body['project'] as { id: string }).id;
    if (!hasFfmpeg || videoPath === undefined) return;

    const response = await fetch(`${server.url}/api/projects/${projectId}/assets`, {
      method: 'POST',
      headers: { 'x-filename': '../../../etc/passwd.mp4', 'content-type': 'video/mp4' },
      body: new Uint8Array(await readAll(videoPath)),
    });

    // The name is sanitized to its last segment, so this is accepted and stored safely.
    expect(response.status).toBe(201);
    const raw = await response.text();
    const body = JSON.parse(raw) as {
      asset: { id: string; filename: string };
      mediaUrl: string;
    };
    expect(body.asset.filename).toBe('passwd.mp4');

    // The browser addresses media by logical id. An absolute server path must never appear in
    // any response: it would leak the workspace layout and couple the client to this host.
    expect(raw).not.toContain(root);
    expect(raw).not.toMatch(/"filePath"/);
    expect(body.mediaUrl).toBe(`/media/${projectId}/${body.asset.id}`);
  });

  it('never leaks a filesystem path through the playback descriptor', async () => {
    const created = await postJson('/api/projects', { name: 'Descriptor' });
    const projectId = (created.body['project'] as { id: string }).id;
    if (!hasFfmpeg || videoPath === undefined) return;

    await fetch(`${server.url}/api/projects/${projectId}/assets`, {
      method: 'POST',
      headers: { 'x-filename': 'clip.mp4', 'content-type': 'video/mp4' },
      body: new Uint8Array(await readAll(videoPath)),
    });

    const response = await fetch(`${server.url}/api/projects/${projectId}/playback`);
    const raw = await response.text();
    expect(response.status).toBe(200);
    // The descriptor is the browser's entire view of the project. If it contained a path, the
    // client would have a way to learn the server's filesystem layout.
    expect(raw).not.toContain(root);
    expect(raw).not.toContain('workspace');
    expect(raw).not.toContain('.mp4');
  });

  it('rejects a missing filename header', async () => {
    const created = await postJson('/api/projects', { name: 'No name' });
    const projectId = (created.body['project'] as { id: string }).id;

    const response = await fetch(`${server.url}/api/projects/${projectId}/assets`, {
      method: 'POST',
      headers: { 'content-type': 'video/mp4' },
      body: new Uint8Array(Buffer.from('x')),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_UPLOAD');
  });

  it('rejects an upload to a project that does not exist', async () => {
    const response = await fetch(`${server.url}/api/projects/nosuchproject/assets`, {
      method: 'POST',
      headers: { 'x-filename': 'clip.mp4', 'content-type': 'video/mp4' },
      body: new Uint8Array(Buffer.from('x')),
    });
    expect(response.status).toBe(404);
  });
});

async function readAll(path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path)) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
