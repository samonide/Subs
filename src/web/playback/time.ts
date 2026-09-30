/**
 * The time-conversion boundary.
 *
 * **This module is the only place in the application where browser seconds are converted
 * to the canonical integer-millisecond representation.** Everything downstream — subtitle
 * highlighting, timeline playhead, frame stepping, export — consumes integer milliseconds
 * produced here.
 *
 * The rule is the one the architecture fixed in Phase 0:
 *
 *     ms = Math.round(seconds * 1000)
 *
 * Scattering `Math.round(video.currentTime * 1000)` through components is how a codebase
 * ends up with two subtly different rounding rules, each defensible in isolation and
 * together producing off-by-one-frame subtitle drift. The boundary is the point.
 *
 * ## Why round, and why it does not accumulate
 *
 * `video.currentTime` is a float in seconds. Rounding gives the nearest whole millisecond,
 * which keeps the reported position within 0.5ms of the truth.
 *
 * It does not drift, because the value is **re-derived from the element on every sample**
 * rather than accumulated from deltas. Any imprecision in the browser's own clock is
 * corrected continuously instead of integrated. There is no running total anywhere.
 *
 * ## Direction of conversion
 *
 * ms → seconds (below) is the only inverse used, and it is used solely at the media
 * boundary when seeking. It is `ms / 1000` with no rounding: the video element accepts a
 * double, so rounding here would only introduce error.
 */

import {
  FRAME_RATES,
  type FrameRate,
  msToFrame,
  frameToMs,
  durationToFrameCount,
} from '../../core/timing/index.js';

/** Canonical playback position: integer milliseconds. */
export type PlaybackMs = number;

/**
 * Browser seconds → canonical integer milliseconds.
 *
 * THE conversion. Non-finite input yields 0 rather than NaN, because a NaN position would
 * propagate into every downstream comparison and render.
 */
export function secondsToMs(seconds: number): PlaybackMs {
  if (!Number.isFinite(seconds)) {
    return 0;
  }
  return Math.round(seconds * 1000);
}

/** Canonical milliseconds → browser seconds. Used only at the media boundary. */
export function msToSeconds(ms: PlaybackMs): number {
  return ms / 1000;
}

/**
 * Clamp a position into `[0, durationMs]`.
 *
 * A negative time is meaningless and a time beyond the duration is unreachable; both are
 * corrected here so no consumer has to defend against them.
 */
export function clampMs(ms: PlaybackMs, durationMs: PlaybackMs): PlaybackMs {
  if (!Number.isFinite(ms)) return 0;
  if (ms < 0) return 0;
  if (durationMs > 0 && ms > durationMs) return durationMs;
  return ms;
}

/**
 * Resolve a frame rate from asset metadata.
 *
 * Uses the exact rational pair recorded at ingest. **There is no fallback to a decimal
 * frame rate anywhere in this module** — a source whose metadata lacks a frame rate has no
 * known frame grid, and pretending otherwise by assuming 30 would silently mis-step on
 * every file that failed to report it.
 */
export function frameRateFromMeta(
  meta: { frameRateNum?: number; frameRateDen?: number } | null | undefined,
): FrameRate | null {
  if (meta === null || meta === undefined) return null;
  const { frameRateNum, frameRateDen } = meta;
  if (
    frameRateNum === undefined ||
    frameRateDen === undefined ||
    !Number.isSafeInteger(frameRateNum) ||
    !Number.isSafeInteger(frameRateDen) ||
    frameRateNum <= 0 ||
    frameRateDen <= 0
  ) {
    return null;
  }
  return { numerator: frameRateNum, denominator: frameRateDen };
}

/** True when frame stepping can be trusted for this source. */
export function supportsFrameStepping(
  meta:
    | { frameRateNum?: number; frameRateDen?: number; frameRateMode?: 'cfr' | 'vfr' }
    | null
    | undefined,
): boolean {
  if (frameRateFromMeta(meta) === null) {
    return false;
  }
  // A variable-frame-rate source has no fixed grid, so "next frame" has no exact meaning.
  // We say so rather than approximate it.
  return meta?.frameRateMode !== 'vfr';
}

/** The frame index containing a canonical time. */
export function msToFrameAt(ms: PlaybackMs, fps: FrameRate): number {
  return msToFrame(ms, fps);
}

/** The canonical start time of a frame, clamped into the media. */
export function frameAt(ms: PlaybackMs, fps: FrameRate): number {
  return frameToMs(ms, fps);
}

/**
 * Step to the next frame from a canonical time.
 *
 * "Next frame" means the first frame that begins **after** the current position, so a
 * second press advances exactly one frame. Returning the frame's own start time is what
 * makes repeated stepping land on a stable grid instead of accumulating rounding error.
 */
export function stepForward(ms: PlaybackMs, fps: FrameRate, durationMs: PlaybackMs): PlaybackMs {
  const current = msToFrame(ms, fps);
  const nextFrameStart = frameToMs(current + 1, fps);
  if (durationMs > 0 && nextFrameStart >= durationMs) {
    // Already at (or past) the last frame: stay put rather than overshoot the media.
    return clampMs(ms, durationMs);
  }
  return clampMs(nextFrameStart, durationMs);
}

/**
 * Step to the previous frame from a canonical time.
 *
 * "Previous frame" means the frame the current position belongs to, unless the position
 * sits within half a frame of that frame's start — in which case it steps to the frame
 * before, so a second press visibly moves backwards. This is the behaviour every NLE
 * implements; without it, the first press appears to do nothing.
 */
export function stepBackward(ms: PlaybackMs, fps: FrameRate, durationMs: PlaybackMs): number {
  const current = msToFrame(ms, fps);
  const currentFrameStart = frameToMs(current, fps);
  const frameDuration = frameToMs(current + 1, fps) - currentFrameStart;

  // Within half a frame of the boundary? Go back a further frame.
  const nearBoundary = ms - currentFrameStart < frameDuration / 2;
  const targetFrame = nearBoundary ? current - 1 : current;
  const target = frameToMs(Math.max(0, targetFrame), fps);
  return clampMs(target, durationMs);
}

/** Total frames in the media, for display and for clamping. */
export function totalFrames(durationMs: PlaybackMs, fps: FrameRate): number {
  return durationToFrameCount(durationMs, fps);
}

/** Common rates, re-exported so the browser layer does not reach into core internals. */
export { FRAME_RATES };
