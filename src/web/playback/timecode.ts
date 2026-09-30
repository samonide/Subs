/**
 * Timecode formatting for the transport readout.
 *
 * Frames are shown because this is a frame-accurate editing tool: a millisecond readout
 * tells a user nothing they can act on, while "frame 412 of 900" is exactly the vocabulary
 * a subtitle editor needs.
 *
 * Kept separate from the conversion boundary — formatting is presentation, and must never
 * be a place where time is converted.
 */

import type { FrameRate } from '../../core/timing/index.js';
import { msToFrame, frameToMs, durationToFrameCount } from '../../core/timing/index.js';

export interface TimecodeParts {
  hours: string;
  minutes: string;
  seconds: string;
  frames: string;
  /** Current frame index, for the "frame N of M" display. */
  frame: number;
  totalFrames: number;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/**
 * Format a canonical time as `HH:MM:SS:FF`.
 *
 * With no frame rate, frames cannot be shown, so the readout degrades to
 * `HH:MM:SS.mmm` rather than inventing a frame count from an assumed rate.
 */
export function formatTimecode(ms: number, fps: FrameRate | null): string {
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const base = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;

  if (fps === null) {
    return `${base}.${pad(safeMs % 1000, 3)}`;
  }

  const frames = msToFrame(safeMs, fps) % Math.max(1, fps.numerator);
  return `${base}:${pad(frames)}`;
}

/** Current and total frame indices, for a "frame N of M" readout. */
export function framePosition(ms: number, durationMs: number, fps: FrameRate): TimecodeParts {
  const frame = msToFrame(ms, fps);
  const totalFrames = durationToFrameCount(durationMs, fps);
  return {
    hours: pad(Math.floor(frame / (fps.numerator * 3600))),
    minutes: pad(Math.floor((frame / (fps.numerator * 60)) % 60)),
    seconds: pad(Math.floor((frame / fps.numerator) % 60)),
    frames: pad(frame % fps.numerator),
    frame,
    totalFrames,
  };
}

/** Start time of a frame, re-exported so components need one import for frame maths. */
export { msToFrame, frameToMs };
