import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReadStream } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { ingestMedia, toAssetRecord } from '../src/server/media/ingest.js';
import { newProject, ProjectStore } from '../src/server/project/store.js';
import { WorkspaceLayout } from '../src/server/workspace.js';
import { ErrorCode } from '../src/server/errors.js';
import {
  cleanupFixtures,
  ffmpegAvailable,
  makeRawFixture,
  makeVideoFixture,
} from './helpers/fixtures.js';

let root: string;
let layout: WorkspaceLayout;
let store: ProjectStore;
let hasFfmpeg = false;
let videoPath: string | undefined;

const MAX_BYTES = 50 * 1024 * 1024;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'subs-ingest-'));
  layout = new WorkspaceLayout(join(root, 'workspace'));
  store = new ProjectStore(layout);
  hasFfmpeg = await ffmpegAvailable();
  if (hasFfmpeg) {
    videoPath = await makeVideoFixture('ingest-source', {
      durationSeconds: 1,
      width: 160,
      height: 120,
    });
  }
});

afterAll(async () => {
  await cleanupFixtures();
  await rm(root, { recursive: true, force: true });
});

async function freshProject(): Promise<string> {
  const doc = await store.create(`p-${Math.random().toString(36).slice(2, 8)}`);
  return doc.id;
}

describe('streamed ingestion of a real video', () => {
  it('accepts a real video and returns canonical metadata', async () => {
    if (!hasFfmpeg || videoPath === undefined) return;
    const projectId = await freshProject();

    const result = await ingestMedia(
      layout,
      projectId,
      { stream: createReadStream(videoPath), originalFilename: 'My Clip.mp4' },
      { maxFileBytes: MAX_BYTES },
    );

    expect(result.assetId).toBeTruthy();
    expect(result.extension).toBe('mp4');
    expect(result.byteSize).toBeGreaterThan(0);
    expect(result.meta.width).toBe(160);
    expect(result.meta.height).toBe(120);
    expect(result.meta.frameRateNum).toBe(30);
    expect(result.meta.frameRateDen).toBe(1);
    // The display name keeps the user's name; the stored path does not.
    expect(result.displayName).toBe('My Clip.mp4');
    expect(result.filePath).toContain(join('media', result.assetId, 'original.mp4'));
  });

  it('stores the file on disk with a controlled name', async () => {
    if (!hasFfmpeg || videoPath === undefined) return;
    const projectId = await freshProject();
    const result = await ingestMedia(
      layout,
      projectId,
      { stream: createReadStream(videoPath), originalFilename: '../../evil.mp4' },
      { maxFileBytes: MAX_BYTES },
    );

    const info = await stat(result.filePath);
    expect(info.isFile()).toBe(true);
    // The traversal in the original name affected nothing about where it landed.
    expect(result.filePath).toContain('original.mp4');
  });

  it('builds an asset record referencing the asset, not a path', async () => {
    if (!hasFfmpeg || videoPath === undefined) return;
    const projectId = await freshProject();
    const result = await ingestMedia(
      layout,
      projectId,
      { stream: createReadStream(videoPath), originalFilename: 'clip.mp4' },
      { maxFileBytes: MAX_BYTES },
    );

    const asset = toAssetRecord(result);
    expect(asset.id).toBe(result.assetId);
    expect(asset.role).toBe('sourceVideo');
    expect(asset.filename).toBe('clip.mp4');
    expect(asset.byteSize).toBe(result.byteSize);
    expect(asset.meta).toEqual(result.meta);
    // The document must not carry a filesystem path.
    expect(JSON.stringify(asset)).not.toContain(root);
  });
});

describe('ingestion rejects bad input', () => {
  it('rejects an unsupported extension before writing anything', async () => {
    const projectId = await freshProject();
    await expect(
      ingestMedia(
        layout,
        projectId,
        { stream: Readable.from([Buffer.from('x')]), originalFilename: 'evil.exe' },
        { maxFileBytes: MAX_BYTES },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_MEDIA });

    // Nothing was created for the rejected upload.
    const mediaDir = join(layout.projectDir(projectId), 'media');
    const entries = await readdir(mediaDir).catch(() => []);
    expect(entries).toHaveLength(0);
  });

  it('rejects a filename with no usable name', async () => {
    const projectId = await freshProject();
    await expect(
      ingestMedia(
        layout,
        projectId,
        { stream: Readable.from([Buffer.from('x')]), originalFilename: '..' },
        { maxFileBytes: MAX_BYTES },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_UPLOAD });
  });

  it('rejects a declared MIME type outside the allow-list', async () => {
    const projectId = await freshProject();
    await expect(
      ingestMedia(
        layout,
        projectId,
        {
          stream: Readable.from([Buffer.from('x')]),
          originalFilename: 'clip.mp4',
          declaredMimeType: 'application/x-msdownload',
        },
        { maxFileBytes: MAX_BYTES },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_MEDIA });
  });

  it('rejects an empty upload', async () => {
    const projectId = await freshProject();
    await expect(
      ingestMedia(
        layout,
        projectId,
        { stream: Readable.from([]), originalFilename: 'clip.mp4' },
        { maxFileBytes: MAX_BYTES },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_UPLOAD });
  });

  it('rejects an upload exceeding the size cap and removes the partial file', async () => {
    const projectId = await freshProject();
    // 5MB of data against a 1MB cap.
    const big = Buffer.alloc(5 * 1024 * 1024, 0x41);

    await expect(
      ingestMedia(
        layout,
        projectId,
        { stream: Readable.from([big]), originalFilename: 'clip.mp4' },
        { maxFileBytes: 1024 * 1024 },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.FILE_TOO_LARGE });

    // The partial asset directory must be gone, not left behind as debris.
    const mediaDir = join(layout.projectDir(projectId), 'media');
    const entries = await readdir(mediaDir).catch(() => []);
    expect(entries).toHaveLength(0);
  });

  it('enforces the cap during streaming, not after the whole body', async () => {
    const projectId = await freshProject();
    // A generator that would produce a gigabyte; the cap must stop it early.
    let produced = 0;
    const endless = new Readable({
      read() {
        produced += 64 * 1024;
        if (produced > 200 * 1024 * 1024) this.push(null);
        else this.push(Buffer.alloc(64 * 1024, 0x42));
      },
    });

    await expect(
      ingestMedia(
        layout,
        projectId,
        { stream: endless, originalFilename: 'clip.mp4' },
        { maxFileBytes: 2 * 1024 * 1024 },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.FILE_TOO_LARGE });

    // Proof the cap engaged early: nowhere near 200MB was ever produced.
    expect(produced).toBeLessThan(10 * 1024 * 1024);
  });

  it('rejects a file whose real container contradicts its extension', async () => {
    if (!hasFfmpeg) return;
    const projectId = await freshProject();
    const webm = await makeVideoFixture('liar', { extension: 'webm', withAudio: false });
    if (webm === undefined) return;

    // The bytes are WebM but the name claims MP4. The extension is a signal, not proof.
    await expect(
      ingestMedia(
        layout,
        projectId,
        { stream: createReadStream(webm), originalFilename: 'clip.mp4' },
        { maxFileBytes: MAX_BYTES },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_MEDIA });
  });

  it('cleans up when the probe fails, leaving no asset behind', async () => {
    const projectId = await freshProject();
    const notMedia = await makeRawFixture('fake.mp4', 'this is not a video at all');

    await expect(
      ingestMedia(
        layout,
        projectId,
        { stream: createReadStream(notMedia), originalFilename: 'fake.mp4' },
        { maxFileBytes: MAX_BYTES },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INSPECTION_FAILED });

    const mediaDir = join(layout.projectDir(projectId), 'media');
    const entries = await readdir(mediaDir).catch(() => []);
    expect(entries).toHaveLength(0);
  });

  it('cleans up when the stream is interrupted mid-transfer', async () => {
    const projectId = await freshProject();
    const interrupted = new Readable({
      read() {
        this.destroy(new Error('connection reset'));
      },
    });

    await expect(
      ingestMedia(
        layout,
        projectId,
        { stream: interrupted, originalFilename: 'clip.mp4' },
        { maxFileBytes: MAX_BYTES },
      ),
    ).rejects.toBeDefined();

    const mediaDir = join(layout.projectDir(projectId), 'media');
    const entries = await readdir(mediaDir).catch(() => []);
    expect(entries).toHaveLength(0);
  });

  it('rejects a request with no readable stream', async () => {
    const projectId = await freshProject();
    await expect(
      ingestMedia(
        layout,
        projectId,
        { stream: undefined as never, originalFilename: 'clip.mp4' },
        { maxFileBytes: MAX_BYTES },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_UPLOAD });
  });
});

describe('project persistence', () => {
  it('creates a valid project and persists it', async () => {
    const doc = await store.create('My first project');
    expect(doc.name).toBe('My first project');
    expect(doc.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(Object.keys(doc.styles)).toHaveLength(1);

    const loaded = await store.load(doc.id);
    expect(loaded).toEqual(doc);
  });

  it('round-trips a project through disk unchanged', async () => {
    const doc = newProject('Round trip');
    await store.save(doc);
    const loaded = await store.load(doc.id);
    expect(loaded).toEqual(doc);
  });

  it('refuses to save an invalid document', async () => {
    const doc = newProject('Invalid');
    // Overlapping segments violate I-3.
    doc.tracks = [
      {
        id: 'track-1',
        name: 'T',
        visible: true,
        locked: false,
        segments: [
          {
            id: 's1',
            text: 'a',
            startMs: 0,
            endMs: 600,
            words: [{ id: 'w1', text: 'a', startMs: 0, endMs: 600, timingSource: 'measured' }],
            origin: 'asr',
          },
          {
            id: 's2',
            text: 'b',
            startMs: 500,
            endMs: 900,
            words: [{ id: 'w2', text: 'b', startMs: 500, endMs: 900, timingSource: 'measured' }],
            origin: 'asr',
          },
        ],
      },
    ];

    await expect(store.save(doc)).rejects.toMatchObject({ code: ErrorCode.INVALID_PROJECT });
  });

  it('reports a missing project with a typed error', async () => {
    await expect(store.load('doesnotexist')).rejects.toMatchObject({
      code: ErrorCode.PROJECT_NOT_FOUND,
    });
  });

  it('reports a corrupted project file without a stack trace', async () => {
    const doc = await store.create('Corrupt');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(store.layout.projectFile(doc.id), '{ this is not json', 'utf8');

    try {
      await store.load(doc.id);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.INVALID_PROJECT });
      expect((error as Error).message).not.toContain('at Object.');
    }
  });

  it('rejects a hostile project id rather than traversing the filesystem', async () => {
    await expect(store.load('../../etc/passwd')).rejects.toMatchObject({
      code: ErrorCode.PATH_VIOLATION,
    });
  });

  it('lists projects on disk', async () => {
    const doc = await store.create('Listed');
    const ids = await store.list();
    expect(ids).toContain(doc.id);
  });

  it('deletes a project and its media', async () => {
    const doc = await store.create('Deletable');
    await store.remove(doc.id);
    await expect(store.load(doc.id)).rejects.toMatchObject({ code: ErrorCode.PROJECT_NOT_FOUND });
  });
});

describe('atomic write behaviour', () => {
  it('leaves no temporary file behind after a successful save', async () => {
    const doc = await store.create('Atomic');
    const { readdir: rd } = await import('node:fs/promises');
    const entries = await rd(store.layout.projectDir(doc.id));
    expect(entries).toContain('project.json');
    // The temp file is renamed into place, never left behind.
    expect(entries.filter((name) => name.includes('.tmp'))).toHaveLength(0);
  });

  it('keeps the previous valid document when a save fails validation', async () => {
    const doc = await store.create('Preserved');
    const original = await store.load(doc.id);

    const broken = { ...doc, canvas: { width: -1, height: -1 } };
    await expect(store.save(broken as never)).rejects.toMatchObject({
      code: ErrorCode.INVALID_PROJECT,
    });

    // The good copy is untouched: a failed save must not destroy the only valid one.
    const after = await store.load(doc.id);
    expect(after).toEqual(original);
  });

  it('migrates an older-schema document on load', async () => {
    const doc = await store.create('Old schema');
    const { readFile, writeFile } = await import('node:fs/promises');
    const path = store.layout.projectFile(doc.id);

    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    raw['schemaVersion'] = 1;
    await writeFile(path, JSON.stringify(raw), 'utf8');

    const loaded = await store.load(doc.id);
    // Loaded at the current version rather than rejected.
    expect(loaded.schemaVersion).toBeGreaterThanOrEqual(2);
  });

  it('refuses a document from a newer build', async () => {
    const doc = await store.create('From the future');
    const { readFile, writeFile } = await import('node:fs/promises');
    const path = store.layout.projectFile(doc.id);

    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    raw['schemaVersion'] = 9999;
    await writeFile(path, JSON.stringify(raw), 'utf8');

    await expect(store.load(doc.id)).rejects.toMatchObject({ code: ErrorCode.INVALID_PROJECT });
  });
});
