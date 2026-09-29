/**
 * Canonical timing model.
 *
 * Two rules govern everything in this module (ARCHITECTURE_REVIEW.md §6):
 *
 *  1. **Time is integer milliseconds.** Not float seconds, not float frames. Subtitle
 *     timing is *authored* in milliseconds, milliseconds serialize exactly as JSON, and
 *     editing is delta-based — so integer arithmetic cannot drift across a long session
 *     the way repeated float addition does.
 *
 *  2. **Frame rate is a rational pair, never a single number.** NTSC is `30000/1001`
 *     (29.97002997…), not `29.97` and definitely not `30`. Collapsing the pair into one
 *     float makes it possible to accidentally treat 29.97 as 30, which drifts about
 *     3.6 seconds per hour of video. Keeping the pair makes that mistake unrepresentable.
 *
 * All frame arithmetic is done in `BigInt` and converted to `number` only at the
 * boundary, because even a 60fps hour-long timeline exceeds the safe-integer range for
 * intermediate products.
 *
 * A third rule, from invariant I-1: **`frame` is derived and ephemeral. It is never
 * stored in the document.** Frames exist only for display and export.
 */

/** A frame rate as an exact rational. Never collapse this into a single number. */
export interface FrameRate {
  readonly numerator: number;
  readonly denominator: number;
}

/** Common frame rates. NTSC rates are exact rationals, not rounded decimals. */
export const FRAME_RATES = {
  /** 24 fps film / PAL-family */
  fps24: { numerator: 24, denominator: 1 },
  /** 25 fps PAL */
  fps25: { numerator: 25, denominator: 1 },
  /** 30 fps — true 30, NOT 29.97 */
  fps30: { numerator: 30, denominator: 1 },
  /** 29.97 fps NTSC, exactly 30000/1001. Do not write `29.97`. */
  fps29_97: { numerator: 30000, denominator: 1001 },
  /** 50 fps PAL */
  fps50: { numerator: 50, denominator: 1 },
  /** 60 fps — true 60, NOT 59.94 */
  fps60: { numerator: 60, denominator: 1 },
  /** 59.94 fps NTSC, exactly 60000/1001. */
  fps59_94: { numerator: 60000, denominator: 1001 },
  /** 120 fps high frame rate */
  fps120: { numerator: 120, denominator: 1 },
} as const satisfies Record<string, FrameRate>;

export class TimingError extends Error {
  override readonly name = 'TimingError';
}

/** True when `value` is a non-negative, finite, safe integer. */
function assertMs(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TimingError(`${label} must be a safe integer millisecond value, got ${value}`);
  }
}

function assertFrameRate(fps: FrameRate): void {
  const { numerator, denominator } = fps;
  if (!Number.isSafeInteger(numerator) || numerator <= 0) {
    throw new TimingError(`Frame rate numerator must be a positive integer, got ${numerator}`);
  }
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new TimingError(`Frame rate denominator must be a positive integer, got ${denominator}`);
  }
}

/**
 * Convert a millisecond timestamp to a frame index.
 *
 * `floor(ms * numerator / (1000 * denominator))`, evaluated in BigInt so that long
 * timelines cannot lose precision. Floor (not round) because a frame index identifies
 * the frame *containing* a moment in time; rounding would report the next frame for
 * times just before it.
 */
export function msToFrame(ms: number, fps: FrameRate): number {
  assertMs(ms, 'ms');
  assertFrameRate(fps);
  const scaled = BigInt(ms) * BigInt(fps.numerator);
  const divisor = 1000n * BigInt(fps.denominator);
  return Number(scaled / divisor);
}

/**
 * Convert a frame index to the millisecond timestamp of that frame's start.
 *
 * `ceil(frame * 1000 * denominator / numerator)`.
 *
 * **Ceil, not floor**, and the distinction matters. At 30fps frame 1 truly begins at
 * 33.333ms. Flooring would report its start as 33ms — but 33ms is still inside frame 0,
 * so the two functions would disagree about which frame owns that millisecond, and every
 * half-open interval built from these values would be off by one at the seam. Ceiling
 * reports 34ms: the first *representable* millisecond that actually belongs to frame 1.
 *
 * This is also why an exact `ms → frame → ms` round trip is mathematically impossible at
 * rates that do not divide evenly into milliseconds. What is guaranteed instead — and
 * tested in `tests/timing.test.ts` — is that the two functions partition time with no
 * gaps and no double-counting.
 */
export function frameToMs(frame: number, fps: FrameRate): number {
  if (!Number.isSafeInteger(frame)) {
    throw new TimingError(`frame must be a safe integer, got ${frame}`);
  }
  assertFrameRate(fps);
  const scaled = BigInt(frame) * 1000n * BigInt(fps.denominator);
  const divisor = BigInt(fps.numerator);
  return Number((scaled + divisor - 1n) / divisor);
}

/**
 * The start time of the frame *after* the given frame.
 *
 * This is the upper bound of the frame's time range, and it is the correct exclusive end
 * for interval tests — `frameToMs` is inclusive of the frame's start, so using it as an
 * end bound would make adjacent frames overlap by one frame.
 */
export function frameEndMs(frame: number, fps: FrameRate): number {
  return frameToMs(frame + 1, fps);
}

/** Total number of frames in a video of the given duration. */
export function durationToFrameCount(durationMs: number, fps: FrameRate): number {
  assertMs(durationMs, 'durationMs');
  return msToFrame(durationMs, fps);
}

/** True when `tMs` falls within `[startMs, endMs)` — half-open, so adjacent segments never both match. */
export function isWithin(tMs: number, startMs: number, endMs: number): boolean {
  return tMs >= startMs && tMs < endMs;
}

/**
 * Frame index whose range contains `ms`.
 *
 * Used to display a timecode for a moment in time, e.g. the playhead.
 */
export function msToTimecodeFrame(ms: number, fps: FrameRate): number {
  return msToFrame(ms, fps);
}

// ── ASS timecode ────────────────────────────────────────────────────────────────
// ASS expresses time as H:MM:SS.cc — centiseconds. This is the one lossy step in the
// pipeline: millisecond authoring precision truncates to 10ms on export. That is
// imperceptible (sub-frame at 30fps) but it is a *known* loss, applied consistently so
// ordering is preserved. Truncate rather than round, for that ordering guarantee.

/** Format milliseconds as an ASS timestamp: `H:MM:SS.cc`. */
export function msToAssTime(ms: number): string {
  assertMs(ms, 'ms');
  const centiseconds = Math.floor(ms / 10);
  const cs = centiseconds % 100;
  const totalSeconds = Math.floor(centiseconds / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const pad = (value: number, width: number): string => value.toString().padStart(width, '0');
  return `${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(cs, 2)}`;
}

/** Parse an ASS timestamp `H:MM:SS.cc` back to integer milliseconds. */
export function assTimeToMs(time: string): number {
  const match = /^(\d+):([0-5]?\d):([0-5]?\d)\.(\d{1,2})$/.exec(time);
  if (match === null) {
    throw new TimingError(`Invalid ASS timestamp: ${time}`);
  }
  const [, h, m, s, cs] = match as unknown as [string, string, string, string, string];
  const centiseconds = Number(h) * 360_000 + Number(m) * 6000 + Number(s) * 100 + Number(cs);
  return centiseconds * 10;
}

// ── SRT timecode ────────────────────────────────────────────────────────────────

/** Format milliseconds as an SRT timestamp: `HH:MM:SS,mmm`. */
export function msToSrtTime(ms: number): string {
  assertMs(ms, 'ms');
  const millis = ms % 1000;
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const pad = (value: number, width: number): string => value.toString().padStart(width, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

/** Parse an SRT timestamp `HH:MM:SS,mmm` back to integer milliseconds. */
export function srtTimeToMs(time: string): number {
  const match = /^(\d{2,}):([0-5]?\d):([0-5]?\d),(\d{3})$/.exec(time);
  if (match === null) {
    throw new TimingError(`Invalid SRT timestamp: ${time}`);
  }
  const [, h, m, s, ms] = match as unknown as [string, string, string, string, string];
  return Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + Number(ms);
}
