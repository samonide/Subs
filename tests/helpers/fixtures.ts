/**
 * Deterministic media fixtures for tests.
 *
 * Generated locally with the already-installed ffmpeg rather than committed as binaries:
 * a few KB of generated video beats a few MB of committed video, and nothing depends on a
 * network download. Each fixture is a *known* quantity, so a test can assert exact
 * metadata rather than "something plausible".
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface FixtureOptions {
  /** Exact frame rate as a rational, e.g. `30/1` or `30000/1001`. */
  frameRate?: string;
  width?: number;
  height?: number;
  /** Duration in seconds. Kept tiny — these are test fixtures, not content. */
  durationSeconds?: number;
  withAudio?: boolean;
  /** Apply a 90° rotation metadata tag, as a phone recording would carry. */
  rotation?: 0 | 90 | 180 | 270;
  /** Container/extension, e.g. `mp4` or `webm`. */
  extension?: string;
}

let sharedDir: string | null = null;

/** A temp directory shared by one test file, removed by `cleanupFixtures()`. */
export async function fixtureDir(): Promise<string> {
  if (sharedDir === null) {
    sharedDir = await mkdtemp(join(tmpdir(), 'subs-fixtures-'));
  }
  return sharedDir;
}

export async function cleanupFixtures(): Promise<void> {
  if (sharedDir !== null) {
    await rm(sharedDir, { recursive: true, force: true });
    sharedDir = null;
  }
}

function videoCodecFor(extension: string): { videoArgs: string[]; audioArgs: string[] } {
  // VP9 in WebM is slow to encode; use VP8 for the fixture. The point is a valid file
  // with known properties, not codec coverage.
  if (extension === 'webm') {
    return { videoArgs: ['-c:v', 'libvpx', '-b:v', '64k'], audioArgs: ['-c:a', 'libvorbis'] };
  }
  if (extension === 'mkv') {
    return {
      videoArgs: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast'],
      audioArgs: ['-c:a', 'aac'],
    };
  }
  return {
    videoArgs: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast'],
    audioArgs: ['-c:a', 'aac'],
  };
}

/**
 * Create a tiny, deterministic video fixture and return its absolute path.
 *
 * Skips (returning undefined) when ffmpeg is unavailable, so a machine without it does
 * not fail the whole suite for an environmental reason. Tests that require a fixture fail
 * loudly; unrelated tests still run.
 */
export async function makeVideoFixture(
  name: string,
  options: FixtureOptions = {},
): Promise<string | undefined> {
  const {
    frameRate = '30/1',
    width = 320,
    height = 240,
    durationSeconds = 1,
    withAudio = true,
    rotation,
    extension = 'mp4',
  } = options;

  const dir = await fixtureDir();
  const path = join(dir, `${name}.${extension}`);
  const { videoArgs, audioArgs } = videoCodecFor(extension);

  const videoSource = `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=${frameRate}`;

  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', videoSource];
  if (withAudio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSeconds}`);
  }
  args.push(...videoArgs);
  if (withAudio) args.push(...audioArgs);
  if (withAudio) args.push('-shortest');
  args.push(path);

  try {
    await execFileAsync('ffmpeg', args, { timeout: 60_000 });

    // Rotation is applied as a second pass, because ffmpeg only records a display rotation
    // when *reading* a stream that carries one — a synthetic lavfi source has none. The
    // result lands in `side_data_list`, which is exactly the shape a real phone recording
    // produces and the one the parser must handle. Writing a `rotate` tag instead would
    // produce a file most players ignore, so the fixture would not exercise the path that
    // matters.
    if (rotation !== undefined && rotation !== 0) {
      const rotated = join(dir, `${name}-rotated.${extension}`);
      await execFileAsync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          '-display_rotation',
          String(rotation),
          '-i',
          path,
          '-c',
          'copy',
          rotated,
        ],
        {
          timeout: 60_000,
        },
      );
      return rotated;
    }

    return path;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

/** True when ffmpeg is available, so a suite can skip instead of failing. */
export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** Write arbitrary bytes to a temp file — for corrupt-media and non-media cases. */
export async function makeRawFixture(name: string, contents: string | Buffer): Promise<string> {
  const dir = await fixtureDir();
  const path = join(dir, name);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, contents);
  return path;
}
