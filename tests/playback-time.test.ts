import { describe, expect, it } from 'vitest';

import { FRAME_RATES, type FrameRate } from '../src/core/timing/index.js';
import {
  clampMs,
  frameRateFromMeta,
  msToSeconds,
  secondsToMs,
  stepBackward,
  stepForward,
  supportsFrameStepping,
  totalFrames,
} from '../src/web/playback/time.js';
import { formatTimecode, framePosition } from '../src/web/playback/timecode.js';

const FPS_30: FrameRate = FRAME_RATES.fps30;
const FPS_60: FrameRate = FRAME_RATES.fps60;
const FPS_29_97: FrameRate = FRAME_RATES.fps29_97;
const RATES: FrameRate[] = [FPS_30, FPS_29_97, FPS_60];

describe('the conversion boundary', () => {
  it('converts seconds to integer milliseconds', () => {
    expect(secondsToMs(0)).toBe(0);
    expect(secondsToMs(1)).toBe(1000);
    expect(secondsToMs(1.5)).toBe(1500);
    // Rounds to nearest, not truncates: 1.9995 is 2000ms, not 1999ms.
    expect(secondsToMs(1.9995)).toBe(2000);
  });

  it('always produces an integer', () => {
    for (const seconds of [0.1, 0.333, 1.0001, 12.3456, 99.9999]) {
      expect(Number.isInteger(secondsToMs(seconds))).toBe(true);
    }
  });

  it('collapses non-finite input to zero rather than propagating NaN', () => {
    // A NaN position would corrupt every downstream comparison and render.
    expect(secondsToMs(Number.NaN)).toBe(0);
    expect(secondsToMs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(secondsToMs(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('converts milliseconds back to seconds without rounding', () => {
    // The video element accepts a double, so rounding here would only add error.
    expect(msToSeconds(0)).toBe(0);
    expect(msToSeconds(1500)).toBe(1.5);
    expect(msToSeconds(1)).toBe(0.001);
  });
});

describe('clamping', () => {
  it('clamps to the media bounds', () => {
    expect(clampMs(-500, 10_000)).toBe(0);
    expect(clampMs(5000, 10_000)).toBe(5000);
    expect(clampMs(50_000, 10_000)).toBe(10_000);
  });

  it('does not clamp when the duration is unknown', () => {
    // Duration 0 means "not known yet" — clamping to 0 would freeze the position.
    expect(clampMs(5000, 0)).toBe(5000);
  });

  it('collapses non-finite input', () => {
    expect(clampMs(Number.NaN, 10_000)).toBe(0);
  });
});

describe('frame rate resolution from metadata', () => {
  it('uses the exact rational pair', () => {
    expect(frameRateFromMeta({ frameRateNum: 30000, frameRateDen: 1001 })).toEqual({
      numerator: 30_000,
      denominator: 1001,
    });
    expect(frameRateFromMeta({ frameRateNum: 30, frameRateDen: 1 })).toEqual({
      numerator: 30,
      denominator: 1,
    });
  });

  it('returns null rather than assuming a rate', () => {
    // There is deliberately no 30fps fallback: assuming a frame grid that the metadata
    // does not state would silently mis-step on every file that failed to report one.
    expect(frameRateFromMeta(null)).toBeNull();
    expect(frameRateFromMeta(undefined)).toBeNull();
    expect(frameRateFromMeta({})).toBeNull();
    expect(frameRateFromMeta({ frameRateNum: 30 })).toBeNull();
    expect(frameRateFromMeta({ frameRateNum: 0, frameRateDen: 1 })).toBeNull();
    expect(frameRateFromMeta({ frameRateNum: 29.97, frameRateDen: 1 })).toBeNull();
  });
});

describe('frame stepping support', () => {
  it('is supported for constant frame rates', () => {
    expect(supportsFrameStepping({ frameRateNum: 30, frameRateDen: 1, frameRateMode: 'cfr' })).toBe(
      true,
    );
    expect(supportsFrameStepping({ frameRateNum: 30000, frameRateDen: 1001 })).toBe(true);
  });

  it('is NOT supported for variable frame rates, and says so', () => {
    // A VFR source has no fixed grid, so "next frame" has no exact meaning. Reporting it
    // honestly is better than approximating.
    expect(supportsFrameStepping({ frameRateNum: 30, frameRateDen: 1, frameRateMode: 'vfr' })).toBe(
      false,
    );
  });

  it('is not supported without a known rate', () => {
    expect(supportsFrameStepping(null)).toBe(false);
    expect(supportsFrameStepping({})).toBe(false);
  });
});

describe('frame stepping — forward', () => {
  it('advances exactly one frame from a frame boundary at every rate', () => {
    // At 30fps a frame is 33.33ms; stepping to frame starts avoids accumulating error.
    expect(stepForward(0, FPS_30, 10_000)).toBe(frameToMsStart(1, FPS_30));
    expect(stepForward(frameToMsStart(5, FPS_30), FPS_30, 10_000)).toBe(frameToMsStart(6, FPS_30));
    expect(stepForward(frameToMsStart(100, FPS_60), FPS_60, 10_000)).toBe(
      frameToMsStart(101, FPS_60),
    );
  });

  it('advances one frame from a mid-frame position', () => {
    // Position 20ms is inside frame 0 at 30fps, so "next" is frame 1.
    expect(stepForward(20, FPS_30, 10_000)).toBe(frameToMsStart(1, FPS_30));
  });

  it('does not treat 29.97 as 30', () => {
    // Stepping 30000/1001 through 100 frames must differ from 30fps by a full millisecond
    // per second; if the rate were flattened to 29.97 this would drift.
    const at29_97 = stepForward(frameToMsStart(299, FPS_29_97), FPS_29_97, 1_000_000);
    const at30 = stepForward(frameToMsStart(299, FPS_30), FPS_30, 1_000_000);
    expect(at29_97).toBe(frameToMsStart(300, FPS_29_97));
    expect(at30).toBe(frameToMsStart(300, FPS_30));
    // The two rates genuinely disagree at frame 300.
    expect(at29_97).not.toBe(at30);
  });

  it('stays put at the last frame instead of seeking past the media', () => {
    // The last frame begins at 67ms and the media ends 10ms later, so frame 3 (at 100ms)
    // does not exist. "Next frame" has no target, and the honest behaviour is to stay on
    // the final frame rather than jump to the duration — which is not a frame boundary and
    // would leave the playhead between frames.
    const lastFrameStart = frameToMsStart(2, FPS_30);
    const durationMs = lastFrameStart + 10;
    expect(lastFrameStart).toBe(67);
    expect(stepForward(lastFrameStart, FPS_30, durationMs)).toBe(lastFrameStart);
  });

  it('steps forward normally when the next frame is still inside the media', () => {
    // One frame later there is a real next frame, so it advances.
    expect(stepForward(frameToMsStart(1, FPS_30), FPS_30, 10_000)).toBe(frameToMsStart(2, FPS_30));
  });

  it('advances from frame 0', () => {
    expect(stepForward(0, FPS_60, 10_000)).toBe(frameToMsStart(1, FPS_60));
  });
});

describe('frame stepping — backward', () => {
  it('steps back one frame from a mid-frame position', () => {
    // 20ms is inside frame 0 at 30fps, and is more than half a frame in, so "previous" is 0.
    expect(stepBackward(20, FPS_30, 10_000)).toBe(frameToMsStart(0, FPS_30));
  });

  it('steps back a further frame when near a frame boundary', () => {
    // Without this, the first press on a boundary appears to do nothing — the behaviour
    // every NLE implements.
    const boundary = frameToMsStart(5, FPS_30);
    expect(stepBackward(boundary, FPS_30, 10_000)).toBe(frameToMsStart(4, FPS_30));
  });

  it('does not step before the start of the media', () => {
    expect(stepBackward(0, FPS_30, 10_000)).toBe(0);
    expect(stepBackward(5, FPS_30, 10_000)).toBe(0);
  });

  it('round-trips with forward stepping', () => {
    for (const fps of RATES) {
      const start = frameToMsStart(10, fps);
      const forward = stepForward(start, fps, 1_000_000);
      expect(stepBackward(forward, fps, 1_000_000)).toBe(start);
    }
  });
});

describe('repeated stepping stays on the grid', () => {
  it('does not accumulate error over many steps at 29.97', () => {
    let ms = 0;
    for (let i = 0; i < 3000; i += 1) {
      ms = stepForward(ms, FPS_29_97, 10_000_000);
    }
    // 3000 frames at 30000/1001 is 100.1 seconds. Naive delta accumulation would drift.
    expect(ms).toBe(frameToMsStart(3000, FPS_29_97));
    expect(ms).toBeGreaterThan(100_000);
    expect(ms).toBeLessThan(101_000);
  });

  it('stays exact at 60fps over many steps', () => {
    let ms = 0;
    for (let i = 0; i < 1000; i += 1) {
      ms = stepForward(ms, FPS_60, 10_000_000);
    }
    expect(ms).toBe(frameToMsStart(1000, FPS_60));
    expect(ms).toBe(Math.ceil((1000 * 1000) / 60));
  });
});

describe('total frames', () => {
  it('counts frames for the media duration', () => {
    expect(totalFrames(1000, FPS_30)).toBe(30);
    expect(totalFrames(1001, FPS_29_97)).toBe(30);
    expect(totalFrames(1000, FPS_60)).toBe(60);
  });
});

describe('timecode formatting', () => {
  it('shows frames when a rate is known', () => {
    expect(formatTimecode(0, FPS_30)).toBe('00:00:00:00');
    expect(formatTimecode(1000, FPS_30)).toBe('00:00:01:00');
    expect(formatTimecode(1500, FPS_30)).toBe('00:00:01:15');
  });

  it('falls back to milliseconds rather than inventing a frame rate', () => {
    expect(formatTimecode(1500, null)).toBe('00:00:01.500');
  });

  it('formats long durations', () => {
    expect(formatTimecode(3_661_000, FPS_30)).toBe('01:01:01:00');
  });

  it('reports current and total frame indices', () => {
    const position = framePosition(1000, 10_000, FPS_30);
    expect(position.frame).toBe(30);
    expect(position.totalFrames).toBe(300);
  });
});

/** Local helper mirroring the core frame start, to keep assertions readable. */
function frameToMsStart(frame: number, fps: FrameRate): number {
  return Math.ceil((frame * 1000 * fps.denominator) / fps.numerator);
}
