import { describe, expect, it } from 'vitest';

import {
  FRAME_RATES,
  TimingError,
  assTimeToMs,
  durationToFrameCount,
  frameEndMs,
  frameToMs,
  isWithin,
  msToAssTime,
  msToFrame,
  msToSrtTime,
  srtTimeToMs,
  type FrameRate,
} from '../src/core/timing/index.js';

const FPS_30: FrameRate = FRAME_RATES.fps30;
const FPS_29_97: FrameRate = FRAME_RATES.fps29_97;
const FPS_60: FrameRate = FRAME_RATES.fps60;

describe('frame rate representation', () => {
  it('stores NTSC 29.97 as an exact rational, not a rounded decimal', () => {
    // 29.97 would be a lie. The true NTSC rate is 30000/1001 = 29.97002997...
    expect(FPS_29_97).toEqual({ numerator: 30000, denominator: 1001 });
    expect(FPS_29_97.numerator / FPS_29_97.denominator).not.toBe(29.97);
  });

  it('distinguishes true 30 from 29.97', () => {
    expect(FPS_30).toEqual({ numerator: 30, denominator: 1 });
    // One second of video is 1000ms at 30fps but 1001ms at 29.97 — the 0.1% difference
    // that makes rounding the rate dangerous.
    expect(durationToFrameCount(1000, FPS_30)).toBe(30);
    expect(durationToFrameCount(1001, FPS_29_97)).toBe(30);
    expect(durationToFrameCount(1000, FPS_29_97)).toBe(29);
  });

  it('rejects a non-positive or non-integer rate', () => {
    expect(() => msToFrame(0, { numerator: 0, denominator: 1 })).toThrow(TimingError);
    expect(() => msToFrame(0, { numerator: 30, denominator: 0 })).toThrow(TimingError);
    expect(() => msToFrame(0, { numerator: 29.97, denominator: 1 })).toThrow(TimingError);
  });
});

describe('msToFrame', () => {
  it('maps frame 0 and the first boundary at every tested rate', () => {
    expect(msToFrame(0, FPS_30)).toBe(0);
    expect(msToFrame(0, FPS_29_97)).toBe(0);
    expect(msToFrame(0, FPS_60)).toBe(0);
  });

  it('floors within a frame rather than rounding to the next one', () => {
    // 33ms is inside frame 0 at 30fps (which spans 0..33ms), so it must be frame 0.
    expect(msToFrame(33, FPS_30)).toBe(0);
    // 34ms is the start of frame 1.
    expect(msToFrame(34, FPS_30)).toBe(1);
    expect(msToFrame(66, FPS_30)).toBe(1);
    expect(msToFrame(67, FPS_30)).toBe(2);
  });

  it('handles representative middle frames', () => {
    expect(msToFrame(500, FPS_30)).toBe(15);
    expect(msToFrame(500, FPS_29_97)).toBe(14);
    expect(msToFrame(500, FPS_60)).toBe(30);
  });

  it('partitions time exactly: a frame owns [start, nextStart)', () => {
    // An exact ms -> frame -> ms round trip is impossible at rates that do not divide
    // evenly into milliseconds. The property that actually matters is that the two
    // functions partition time with no gaps and no double-counting: the frame a
    // timestamp resolves to always starts at or before it, and the next frame always
    // starts after it.
    for (const fps of [FPS_30, FPS_29_97, FPS_60]) {
      for (let frame = 0; frame < 500; frame += 1) {
        const start = frameToMs(frame, fps);
        const nextStart = frameEndMs(frame, fps);
        expect(start).toBeLessThan(nextStart);
        expect(msToFrame(start, fps)).toBe(frame);
        expect(msToFrame(nextStart, fps)).toBe(frame + 1);
        // Every integer ms from the frame's start up to (not including) the next frame's
        // start resolves to this same frame — no gap, no overlap.
        for (let ms = start; ms < nextStart; ms += 1) {
          expect(msToFrame(ms, fps)).toBe(frame);
        }
      }
    }
  });

  it('does not drift over a long 29.97 timeline', () => {
    // 1 hour at 30000/1001 is 107,892 complete frames. Assuming 30fps instead of the true
    // NTSC rate drifts 3,597ms over that span — the rational pair is what prevents it.
    const framesInAnHour = 107_892;
    const trueMs = frameToMs(framesInAnHour, FPS_29_97);
    const assumed30Ms = frameToMs(framesInAnHour, FPS_30);
    expect(trueMs - assumed30Ms).toBe(3597);
    // The true timeline is 3,599,996.4ms; ceil lands us within one frame of it.
    expect(Math.abs(trueMs - 3_599_996)).toBeLessThanOrEqual(1);
  });

  it('rejects fractional milliseconds', () => {
    expect(() => msToFrame(10.5, FPS_30)).toThrow(TimingError);
    expect(() => msToFrame(Number.NaN, FPS_30)).toThrow(TimingError);
  });
});

describe('frameToMs', () => {
  it('reports the first representable millisecond inside the frame', () => {
    // frameToMs ceils, because 33ms is still inside frame 0 at 30fps. Reporting frame 1
    // as starting at 33ms would make the two converters disagree about ownership of that
    // millisecond, and every half-open interval built from them would be off by one.
    expect(frameToMs(0, FPS_30)).toBe(0);
    expect(frameToMs(1, FPS_30)).toBe(34);
    expect(frameToMs(2, FPS_30)).toBe(67);
    expect(frameToMs(3, FPS_30)).toBe(100);
    expect(frameToMs(30, FPS_30)).toBe(1000);
    expect(frameToMs(60, FPS_30)).toBe(2000);
  });

  it('is exact at rates that divide evenly into milliseconds', () => {
    // 25fps is 40ms/frame and 50fps is 20ms/frame: no rounding, so exact round trips.
    const fps25 = FRAME_RATES.fps25;
    expect(frameToMs(1, fps25)).toBe(40);
    expect(frameToMs(25, fps25)).toBe(1000);
    expect(msToFrame(frameToMs(7, fps25), fps25)).toBe(7);
  });

  it('is monotone non-decreasing', () => {
    let previous = -1;
    for (let frame = 0; frame < 5000; frame += 1) {
      const current = frameToMs(frame, FPS_60);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it('frameEndMs is the exclusive upper bound of the frame', () => {
    // frameToMs is inclusive of the start, so using it as an end bound would make
    // adjacent frames overlap by one frame.
    expect(frameEndMs(0, FPS_30)).toBe(frameToMs(1, FPS_30));
    expect(frameEndMs(5, FPS_60)).toBe(frameToMs(6, FPS_60));
  });

  it('rejects a fractional frame index', () => {
    expect(() => frameToMs(1.5, FPS_30)).toThrow(TimingError);
  });
});

describe('durationToFrameCount', () => {
  it('counts frames in a duration', () => {
    expect(durationToFrameCount(1000, FPS_30)).toBe(30);
    expect(durationToFrameCount(1000, FPS_29_97)).toBe(29);
    expect(durationToFrameCount(1000, FPS_60)).toBe(60);
  });
});

describe('isWithin', () => {
  it('is half-open so adjacent segments never both match', () => {
    expect(isWithin(0, 0, 100)).toBe(true);
    expect(isWithin(99, 0, 100)).toBe(true);
    // 100 is the start of the next segment, not the end of this one.
    expect(isWithin(100, 0, 100)).toBe(false);
    expect(isWithin(-1, 0, 100)).toBe(false);
  });
});

describe('ASS timecodes', () => {
  it('formats milliseconds as H:MM:SS.cc', () => {
    expect(msToAssTime(0)).toBe('0:00:00.00');
    expect(msToAssTime(1234)).toBe('0:00:01.23');
    expect(msToAssTime(61_000)).toBe('0:01:01.00');
    expect(msToAssTime(3_661_000)).toBe('1:01:01.00');
  });

  it('truncates to centiseconds rather than rounding', () => {
    // 1045ms -> 1.04s, not 1.05s. Truncation preserves ordering across segments,
    // which rounding does not guarantee.
    expect(msToAssTime(1045)).toBe('0:00:01.04');
    expect(msToAssTime(1049)).toBe('0:00:01.04');
  });

  it('round-trips at centisecond resolution', () => {
    for (const ms of [0, 1000, 12_340, 3_600_000, 7_265_000]) {
      expect(assTimeToMs(msToAssTime(ms))).toBe(ms);
    }
  });

  it('rejects a malformed timestamp', () => {
    expect(() => assTimeToMs('nope')).toThrow(TimingError);
    expect(() => assTimeToMs('0:99:00.00')).toThrow(TimingError);
  });
});

describe('SRT timecodes', () => {
  it('formats and parses HH:MM:SS,mmm exactly', () => {
    expect(msToSrtTime(0)).toBe('00:00:00,000');
    expect(msToSrtTime(3661_234)).toBe('01:01:01,234');
    for (const ms of [0, 1, 999, 1000, 3_600_000, 7_265_432]) {
      expect(srtTimeToMs(msToSrtTime(ms))).toBe(ms);
    }
  });

  it('rejects a malformed timestamp', () => {
    expect(() => srtTimeToMs('0:00:00.000')).toThrow(TimingError);
  });
});
