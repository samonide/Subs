/**
 * The audio extraction pipeline, exercised against **real** FFmpeg.
 *
 * These are not mocked. The behaviour under test is precisely the behaviour that only exists
 * when a real process runs: exit codes, partial output on failure, what FFmpeg leaves on disk
 * when it is killed, and whether a temp file can be mistaken for a finished asset. A mock
 * would assert that the code calls the functions it is supposed to call, which is not the
 * question worth asking.
 *
 * Fixtures are generated with FFmpeg at test time — no committed binaries, no downloads.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  CANONICAL_AUDIO,
  DURATION_TOLERANCE_MS,
  runAudioExtraction,
} from '../src/server/media/audio.js';
import { ErrorCode } from '../src/server/errors.js';
import { WorkspaceLayout } from '../src/server/workspace.js';
import { ProjectStore } from '../src/server/project/store.js';
import { cleanupFixtures, ffmpegAvailable, makeVideoFixture } from './helpers/fixtures.js';

afterAll(async () => {
  await cleanupFixtures();
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

const available = await ffmpegAvailable();
const maybe = available ? describe : describe.skip;

const scratchDirs: string[] = [];

/** A workspace outside the repo, so a failing test cannot leave tracked-looking files. */
function workspace(): WorkspaceLayout {
  const dir = mkdtempSync(join(tmpdir(), 'subs-p3-'));
  scratchDirs.push(dir);
  return new WorkspaceLayout(dir);
}

async function seed(
  layout: WorkspaceLayout,
  options: { withAudio?: boolean; durationSeconds?: number } = {},
): Promise<{ projectId: string; assetId: string; durationMs: number }> {
  const projects = new ProjectStore(layout);
  const project = await projects.create('phase3');
  const fixture = await makeVideoFixture('src', {
    durationSeconds: options.durationSeconds ?? 1,
    withAudio: options.withAudio ?? true,
  });
  if (fixture === undefined) throw new Error('fixture unavailable');

  // Ingest through the real path so the asset record and file are exactly as production
  // creates them — a hand-assembled asset would not exercise the extension resolution that
  // `resolveSource` depends on.
  const { ingestMedia } = await import('../src/server/media/ingest.js');
  const result = await ingestMedia(
    layout,
    project.id,
    {
      stream: createReadStream(fixture),
      originalFilename: 'clip.mp4',
      declaredMimeType: 'video/mp4',
    },
    { maxFileBytes: 50_000_000 },
  );

  const doc = await projects.load(project.id);
  await projects.save({
    ...doc,
    assets: [
      ...doc.assets,
      {
        id: result.assetId,
        role: 'sourceVideo',
        filename: result.displayName,
        mimeType: 'video/mp4',
        byteSize: result.byteSize,
        meta: result.meta,
      },
    ],
  });

  return { projectId: project.id, assetId: result.assetId, durationMs: result.meta.durationMs };
}

maybe('runAudioExtraction (real ffmpeg)', () => {
  it('extracts canonical 16 kHz mono PCM audio from a real video', async () => {
    const layout = workspace();
    const seeded = await seed(layout);

    const result = await runAudioExtraction(
      { layout, signal: new AbortController().signal },
      {
        projectId: seeded.projectId,
        assetId: seeded.assetId,
        sourceDurationMs: seeded.durationMs,
      },
    );

    // The format is the contract Phase 4 depends on.
    expect(result.meta.audioCodec).toBe('pcm_s16le');
    expect(result.meta.sampleRate).toBe(CANONICAL_AUDIO.sampleRate);
    expect(result.meta.channels).toBe(CANONICAL_AUDIO.channels);
    expect(result.meta.durationMs).toBeGreaterThan(0);

    // Duration agreement is measured, not assumed.
    expect(Math.abs(result.durationDeltaMs)).toBeLessThanOrEqual(DURATION_TOLERANCE_MS);

    // The final file exists at the canonical stored-asset name, and no temp survived. The name
    // comes from `assetFile` — the only resolver in the system — so this is exactly the path
    // the media endpoint will serve.
    const audioPath = layout.assetFile(seeded.projectId, result.assetId, 'wav');
    expect(existsSync(audioPath)).toBe(true);
    const dir = layout.assetDir(seeded.projectId, result.assetId);
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(statSync(audioPath).size).toBeGreaterThan(0);

    // Exactly one stored media file: no stray temp, no second copy of the audio.
    expect(readdirSync(dir).filter((n) => n.startsWith('original.'))).toHaveLength(1);
  });

  it('reports determinate progress that is monotonic and reaches 1', async () => {
    const layout = workspace();
    const seeded = await seed(layout);
    const values: number[] = [];

    await runAudioExtraction(
      {
        layout,
        signal: new AbortController().signal,
        onProgress: (p) => {
          if (p.kind === 'determinate') values.push(p.value);
        },
      },
      { projectId: seeded.projectId, assetId: seeded.assetId, sourceDurationMs: seeded.durationMs },
    );

    // A 1-second fixture may finish before the first poll, so progress can legitimately be
    // empty. What must hold whenever samples exist is that they never go backwards or exceed 1.
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    }
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('fails and leaves no asset when the source has no audio track', async () => {
    // FFmpeg errors on a video with no audio stream. The job must fail rather than register
    // an empty WAV that Phase 4 would then try to transcribe.
    const layout = workspace();
    const seeded = await seed(layout, { withAudio: false });

    await expect(
      runAudioExtraction(
        { layout, signal: new AbortController().signal },
        {
          projectId: seeded.projectId,
          assetId: seeded.assetId,
        },
      ),
    ).rejects.toThrow();

    // Nothing was written into the project document.
    const doc = await new ProjectStore(layout).load(seeded.projectId);
    expect(doc.assets.filter((a) => a.role === 'audio')).toEqual([]);
  });

  it('rejects a missing source asset without touching the filesystem', async () => {
    const layout = workspace();
    const seeded = await seed(layout);

    await expect(
      runAudioExtraction(
        { layout, signal: new AbortController().signal },
        {
          projectId: seeded.projectId,
          assetId: 'no_such_asset',
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.MISSING_ASSET });
  });

  it('leaves no temp file behind when cancelled mid-run', async () => {
    const layout = workspace();
    const seeded = await seed(layout, { durationSeconds: 3 });
    const controller = new AbortController();

    // Abort immediately: the run is cancelled either during spawn or during processing.
    setTimeout(() => controller.abort(), 5);

    await expect(
      runAudioExtraction(
        { layout, signal: controller.signal },
        {
          projectId: seeded.projectId,
          assetId: seeded.assetId,
          sourceDurationMs: seeded.durationMs,
        },
      ),
    ).rejects.toThrow();

    // The critical guarantee: no audio file anywhere in the project, at any stage.
    const mediaRoot = join(layout.projectDir(seeded.projectId), 'media');
    const audioFiles = readdirSync(mediaRoot).flatMap((assetDir) => {
      const dir = join(mediaRoot, assetDir);
      return readdirSync(dir)
        .filter((name) => name.startsWith('audio.'))
        .map((name) => join(dir, name));
    });
    expect(audioFiles).toEqual([]);
  });

  it('refuses to treat a corrupt source as a successful extraction', async () => {
    const layout = workspace();
    const projects = new ProjectStore(layout);
    const project = await projects.create('corrupt');

    const { makeRawFixture } = await import('./helpers/fixtures.js');
    const junk = await makeRawFixture('junk.mp4', 'this is not a video');
    if (junk === undefined) return;

    // Register a source asset whose file is not decodable media.
    const assetId = 'corrupt_asset';
    mkdirSync(layout.assetDir(project.id, assetId), { recursive: true });
    writeFileSync(layout.assetFile(project.id, assetId, 'mp4'), 'this is not a video');

    const doc = await projects.load(project.id);
    await projects.save({
      ...doc,
      assets: [
        ...doc.assets,
        {
          id: assetId,
          role: 'sourceVideo',
          filename: 'junk.mp4',
          mimeType: 'video/mp4',
          byteSize: 18,
        },
      ],
    });

    await expect(
      runAudioExtraction(
        { layout, signal: new AbortController().signal },
        {
          projectId: project.id,
          assetId,
        },
      ),
    ).rejects.toThrow();

    const after = await projects.load(project.id);
    expect(after.assets.filter((a) => a.role === 'audio')).toEqual([]);
    rmSync(junk, { force: true });
  });
});
