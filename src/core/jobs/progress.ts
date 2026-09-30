/**
 * Parser for FFmpeg's `-progress` output.
 *
 * FFmpeg writes machine-readable progress as repeated `key=value` blocks on its own
 * stream:
 *
 * ```
 * bitrate= 256.1kbits/s
 * total_size=160078
 * out_time_us=5000000
 * out_time_ms=5000000
 * out_time=00:00:05.000000
 * progress=continue
 * ...
 * progress=end
 * ```
 *
 * ## Why this is parsed separately from process execution
 *
 * Progress text is the part most likely to change meaning or be malformed, and it is the
 * part that has nothing to do with spawning a process. Parsing it as a pure function means
 * the edge cases — a truncated final block, a missing `out_time_us`, `out_time_us` that
 * exceeds the source duration, a value that goes backwards — are unit-tested without
 * running FFmpeg at all.
 *
 * ## Why `out_time_us` and not `out_time_ms`
 *
 * Both exist and they are not interchangeable. `out_time_ms` is a *misnomer* in FFmpeg:
 * despite the name it reports microseconds. Reading it as milliseconds makes a 5-second
 * file report 5,000,000 "ms" and report progress as 1000× too slow. `out_time_us` is
 * unambiguous, so that is what this parses.
 */

import { determinate, type JobProgress } from './types.js';

/** The subset of FFmpeg progress keys this parser understands. */
export interface ProgressSample {
  /** Encoded output position, in microseconds. */
  outTimeUs?: number;
  /** `continue`, `end`, or anything else FFmpeg emits. */
  marker?: string;
  totalSize?: number;
  bitrate?: string;
}

export interface ProgressParserState {
  lastOutTimeUs: number;
  finished: boolean;
}

/** Parse one line. Returns the updated sample and state; unknown keys are ignored. */
export function parseProgressLine(
  line: string,
  state: ProgressParserState,
): { sample: ProgressSample; state: ProgressParserState } {
  const separator = line.indexOf('=');
  if (separator === -1) {
    return { sample: {}, state };
  }
  const key = line.slice(0, separator).trim();
  const value = line.slice(separator + 1).trim();

  switch (key) {
    case 'out_time_us':
    case 'out_time_ms': {
      const parsed = Number(value);
      // A non-numeric or negative value is ignored rather than propagated: FFmpeg emits
      // `N/A` for some keys on some builds, and `N/A` becoming NaN would poison every
      // subsequent progress value through arithmetic.
      if (!Number.isFinite(parsed) || parsed < 0) {
        return { sample: {}, state };
      }
      // Monotonic by construction. FFmpeg can emit a slightly lower out_time across blocks
      // (it is not a strict guarantee), and a progress bar that goes backwards reads as a
      // bug even when the underlying job is fine. Clamping keeps the UI monotonic while
      // leaving `outTimeUs` itself truthful.
      const clamped = Math.max(parsed, state.lastOutTimeUs);
      return {
        sample: { outTimeUs: parsed },
        state: { ...state, lastOutTimeUs: clamped },
      };
    }
    case 'progress':
      return {
        sample: { marker: value },
        state: { ...state, finished: value === 'end' },
      };
    case 'total_size': {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0
        ? { sample: { totalSize: parsed }, state }
        : { sample: {}, state };
    }
    case 'bitrate':
      return { sample: { bitrate: value }, state };
    default:
      return { sample: {}, state };
  }
}

export function initialProgressState(): ProgressParserState {
  return { lastOutTimeUs: 0, finished: false };
}

/**
 * Turn a sample into the job's progress.
 *
 * Returns `undefined` when FFmpeg has not yet reported a usable position, which the caller
 * renders as indeterminate. Guessing a ratio before any position is known would produce a
 * confident-looking 0% that means nothing.
 */
export function progressFromSample(
  sample: ProgressSample,
  sourceDurationUs: number | undefined,
): JobProgress | undefined {
  if (sample.outTimeUs === undefined) {
    return undefined;
  }
  if (sourceDurationUs === undefined || sourceDurationUs <= 0) {
    // Duration unknown (a live or malformed source): we know work is happening but not how
    // much of it is done. Indeterminate is the honest answer.
    return { kind: 'indeterminate' };
  }
  return determinate(sample.outTimeUs / sourceDurationUs);
}
