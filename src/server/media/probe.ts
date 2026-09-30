/**
 * ffprobe adapter: raw tool output → canonical `MediaMeta`.
 *
 * This is the only place that knows ffprobe's JSON shape. Everything above it consumes
 * `MediaMeta` and never sees a tool-specific field name. That boundary is what lets the
 * probe tool be swapped (or a second provider added) without touching anything else.
 *
 * Raw ffprobe JSON is deliberately **not** stored on the document: it contains absolute
 * filesystem paths and a large amount of information the product does not use. Keeping
 * it out of `ProjectDocument` is what makes a project file portable (S-1 in spirit) and
 * keeps the document diffable.
 *
 * Process safety (S-5, S-6, S-7):
 *   - spawned with an **argument array**, never a shell string, so a filename cannot
 *     inject a command;
 *   - `-nostdin`, and the path is always an absolute path we generated;
 *   - a wall-clock timeout, then SIGTERM and SIGKILL;
 *   - the protocol allow-list is implicit here because we only ever pass a local path.
 */

import { spawn } from 'node:child_process';

import type { MediaMeta } from '../../core/document/types.js';
import { ErrorCode, IngestError } from '../errors.js';

/** The subset of ffprobe's stream object we consume. */
interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  nb_frames?: string;
  tags?: Record<string, string>;
  side_data_list?: unknown;
}

interface RawProbe {
  streams?: RawStream[];
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
    tags?: Record<string, string>;
  };
}

export interface ProbeOptions {
  /** Wall-clock budget for the probe. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Parse ffprobe's `avg_frame_rate` / `r_frame_rate` into an exact rational pair.
 *
 * ffprobe reports these as `"30000/1001"` or `"30/1"`. We keep the pair and never collapse
 * it to a float: treating 29.97 as 30 drifts ~3.6 seconds per hour of video
 * (ARCHITECTURE_REVIEW.md §6.2). `"0/0"` means "unknown" and yields undefined.
 */
export function parseRationalFrameRate(
  value: string | undefined,
): { num: number; den: number } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) {
    return undefined;
  }
  return { num, den };
}

/**
 * Decide constant vs. variable frame rate.
 *
 * ffprobe reports both a nominal rate (`r_frame_rate`) and an average (`avg_frame_rate`).
 * For a genuinely variable source these diverge. This is a heuristic, and it is
 * conservative: when the two disagree we report `vfr`, because a wrong `cfr` would mislead
 * playback and export in ways a wrong `vfr` would not.
 */
export function inferFrameRateMode(
  rFrameRate: string | undefined,
  avgFrameRate: string | undefined,
): 'cfr' | 'vfr' | undefined {
  const r = parseRationalFrameRate(rFrameRate);
  const avg = parseRationalFrameRate(avgFrameRate);
  if (r === undefined) {
    return avg === undefined ? undefined : 'vfr';
  }
  if (avg === undefined) {
    return 'vfr';
  }
  return r.num * avg.den === avg.num * r.den ? 'cfr' : 'vfr';
}

/** Side-data entry carrying display rotation. */
interface RawSideData {
  rotation?: number;
  side_data_type?: string;
}

function asSideDataList(value: unknown): RawSideData[] {
  return Array.isArray(value) ? (value as RawSideData[]) : [];
}

/**
 * Read display rotation from a video stream.
 *
 * Two shapes exist in the wild and **both** must be handled:
 *   - `side_data_list: [{ rotation: 90 }]` — how current ffmpeg/ffprobe write it. This is
 *     the common case and is easy to miss, which would leave a portrait phone video
 *     sideways in the editor.
 *   - `tags: { rotate: "90" }` — the older QuickTime-style tag, still emitted by some
 *     muxers and still found in the wild.
 *
 * A negative rotation is normalised into 0–270.
 */
function rotationFromStream(video: RawStream | undefined): 0 | 90 | 180 | 270 | undefined {
  if (video === undefined) {
    return undefined;
  }

  const fromSideData = asSideDataList(video.side_data_list)
    .map((entry) => entry.rotation)
    .find((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (fromSideData !== undefined) {
    return normalizeRotation(fromSideData);
  }

  const raw = video.tags?.['rotate'];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? normalizeRotation(value) : undefined;
}

function normalizeRotation(value: number): 0 | 90 | 180 | 270 | undefined {
  const normalized = ((Math.round(value) % 360) + 360) % 360;
  return normalized === 0 || normalized === 90 || normalized === 180 || normalized === 270
    ? normalized
    : undefined;
}

/** Apply a quarter-turn rotation to produce the display dimensions. */
function displayDimensions(
  width: number | undefined,
  height: number | undefined,
  rotation: 0 | 90 | 180 | 270 | undefined,
): { displayWidth: number | undefined; displayHeight: number | undefined } {
  if (width === undefined || height === undefined || (rotation !== 90 && rotation !== 270)) {
    return { displayWidth: width, displayHeight: height };
  }
  return { displayWidth: height, displayHeight: width };
}

/**
 * Convert raw ffprobe output into canonical `MediaMeta`.
 *
 * Pure and separately testable: it takes the parsed JSON, not the file, so the mapping
 * can be tested without spawning anything.
 */
export function toMediaMeta(probe: RawProbe): MediaMeta {
  const streams = probe.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  // Prefer the container duration, which covers all streams; fall back to the video
  // stream, then to any stream that reports one.
  const durationSeconds = probe.format?.duration ?? video?.duration ?? audio?.duration;
  const durationMs =
    durationSeconds === undefined ? 0 : Math.max(0, Math.round(Number(durationSeconds) * 1000));

  if (durationSeconds !== undefined && !Number.isFinite(Number(durationSeconds))) {
    throw new IngestError(ErrorCode.INSPECTION_FAILED, 'Media reports a non-numeric duration.');
  }

  const rotation = rotationFromStream(video);
  const { displayWidth, displayHeight } = displayDimensions(video?.width, video?.height, rotation);

  const frameRate =
    parseRationalFrameRate(video?.avg_frame_rate) ?? parseRationalFrameRate(video?.r_frame_rate);
  const frameRateMode = inferFrameRateMode(video?.r_frame_rate, video?.avg_frame_rate);

  const sampleRate = audio?.sample_rate === undefined ? undefined : Number(audio.sample_rate);

  const meta: MediaMeta = { durationMs };

  if (video !== undefined) {
    if (video.width !== undefined) meta.width = video.width;
    if (video.height !== undefined) meta.height = video.height;
    if (displayWidth !== undefined) meta.displayWidth = displayWidth;
    if (displayHeight !== undefined) meta.displayHeight = displayHeight;
    if (rotation !== undefined) meta.rotation = rotation;
    if (frameRate !== undefined) {
      meta.frameRateNum = frameRate.num;
      meta.frameRateDen = frameRate.den;
    }
    if (frameRateMode !== undefined) meta.frameRateMode = frameRateMode;
    if (video.codec_name !== undefined) meta.codec = video.codec_name;
  }

  if (probe.format?.format_name !== undefined) meta.container = probe.format.format_name;
  if (audio !== undefined) {
    if (audio.codec_name !== undefined) meta.audioCodec = audio.codec_name;
    if (sampleRate !== undefined && Number.isFinite(sampleRate) && sampleRate > 0)
      meta.sampleRate = sampleRate;
    if (audio.channels !== undefined) meta.channels = audio.channels;
  }

  return meta;
}

/** True when the probe found at least one video stream. */
export function hasVideoStream(probe: RawProbe): boolean {
  return (probe.streams ?? []).some((stream) => stream.codec_type === 'video');
}

/** True when the probe found at least one audio stream. */
export function hasAudioStream(probe: RawProbe): boolean {
  return (probe.streams ?? []).some((stream) => stream.codec_type === 'audio');
}

/** Run ffprobe against a local file and return its raw parsed JSON. */
export async function runFfprobe(filePath: string, options: ProbeOptions = {}): Promise<RawProbe> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const args = [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    // A relative path could be resolved against a hostile cwd; we always pass absolute.
    filePath,
  ];

  return new Promise<RawProbe>((resolvePromise, rejectPromise) => {
    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        fn();
      }
    };

    const kill = (): void => {
      child.kill('SIGTERM');
      // Escalate if it ignores the polite request.
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 2000).unref?.();
    };

    const onAbort = (): void => {
      kill();
      finish(() => rejectPromise(new IngestError(ErrorCode.CANCELLED, 'Probe cancelled.')));
    };

    const timer = setTimeout(() => {
      kill();
      finish(() =>
        rejectPromise(
          new IngestError(ErrorCode.INSPECTION_TIMEOUT, `ffprobe timed out after ${timeoutMs}ms.`, {
            retryable: true,
          }),
        ),
      );
    }, timeoutMs);

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Cap the buffer: a pathological file can produce a lot of stderr.
      if (stderr.length < 64_000) stderr += chunk.toString('utf8');
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === 'ENOENT') {
          rejectPromise(
            new IngestError(ErrorCode.TOOL_UNAVAILABLE, 'ffprobe was not found on this system.', {
              retryable: false,
              cause: error,
            }),
          );
        } else {
          rejectPromise(
            new IngestError(
              ErrorCode.INSPECTION_FAILED,
              `Could not run ffprobe: ${error.message}`,
              {
                cause: error,
              },
            ),
          );
        }
      });
    });

    child.on('close', (code) => {
      finish(() => {
        if (code !== 0) {
          const detail = stderr.trim().slice(0, 400);
          const error = new IngestError(
            ErrorCode.INSPECTION_FAILED,
            `ffprobe could not read this file (exit ${code}). It may be corrupt, incomplete, or not a media file.`,
          );
          if (detail.length > 0) {
            // Keep ffprobe's own message as context; it is the difference between
            // "this is broken" and "this is broken because ...".
            error.message = `${error.message} ffprobe: ${detail}`;
          }
          rejectPromise(error);
          return;
        }
        try {
          resolvePromise(JSON.parse(stdout) as RawProbe);
        } catch (error) {
          rejectPromise(
            new IngestError(
              ErrorCode.INSPECTION_FAILED,
              'ffprobe returned output that is not valid JSON.',
              {
                cause: error,
              },
            ),
          );
        }
      });
    });
  });
}

/** Inspect a media file and return canonical `MediaMeta`. */
export async function probeMedia(
  filePath: string,
  options: ProbeOptions = {},
): Promise<{ meta: MediaMeta; raw: RawProbe }> {
  const raw = await runFfprobe(filePath, options);
  if (!hasVideoStream(raw)) {
    throw new IngestError(
      ErrorCode.UNSUPPORTED_MEDIA,
      'This file has no video stream. Subtitle Studio needs a video to subtitle.',
    );
  }
  const meta = toMediaMeta(raw);
  if (meta.durationMs <= 0) {
    throw new IngestError(
      ErrorCode.INSPECTION_FAILED,
      'The media reports a zero duration, which usually means the file is truncated.',
    );
  }
  return { meta, raw };
}

export type { RawProbe };
