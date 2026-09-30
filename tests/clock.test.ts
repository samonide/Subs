// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlaybackClock, type PlaybackSnapshot } from '../src/web/playback/clock.js';

/**
 * A scriptable stand-in for the parts of `HTMLVideoElement` the clock reads.
 *
 * jsdom's video element has no decoder, so `currentTime` never moves and `duration` stays
 * NaN. Dispatching events explicitly keeps these tests honest: they verify the clock's
 * *response* to media events rather than pretending the browser decodes video.
 */
function makeVideo(overrides: { duration?: number; currentTime?: number } = {}): HTMLVideoElement {
  const video = document.createElement('video');
  let currentTime = overrides.currentTime ?? 0;
  let duration = overrides.duration ?? 0;
  let paused = true;

  Object.defineProperties(video, {
    currentTime: {
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
      },
      configurable: true,
    },
    duration: { get: () => duration, configurable: true },
    paused: { get: () => paused, configurable: true },
    ended: { get: () => duration > 0 && currentTime >= duration, configurable: true },
    error: { get: () => null, configurable: true },
  });

  // Test controls, mirroring what a user gesture would do to a real element.
  const controls = {
    setTime(value: number) {
      currentTime = value;
    },
    setDuration(value: number) {
      duration = value;
    },
    play() {
      paused = false;
      video.dispatchEvent(new Event('play'));
      video.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    },
    pause() {
      paused = true;
      video.dispatchEvent(new Event('pause'));
    },
    end() {
      currentTime = duration;
      paused = true;
      video.dispatchEvent(new Event('ended'));
    },
    fail(code: number) {
      Object.defineProperty(video, 'error', { get: () => ({ code }), configurable: true });
      video.dispatchEvent(new Event('error'));
    },
  };

  return Object.assign(video, { __controls: controls });
}

type ControllableVideo = HTMLVideoElement & {
  __controls: {
    setTime(value: number): void;
    setDuration(value: number): void;
    play(): Promise<void>;
    pause(): void;
    end(): void;
    fail(code: number): void;
  };
};

describe('PlaybackClock', () => {
  let video: ControllableVideo;
  let clock: PlaybackClock;
  let snapshots: PlaybackSnapshot[];

  beforeEach(() => {
    video = makeVideo({ duration: 10 }) as ControllableVideo;
    clock = new PlaybackClock(video);
    snapshots = [];
    clock.subscribe((snapshot) => snapshots.push(snapshot));
  });

  afterEach(() => {
    clock.destroy();
  });

  const last = (): PlaybackSnapshot => snapshots[snapshots.length - 1] as PlaybackSnapshot;

  it('publishes an initial snapshot on subscribe', () => {
    expect(snapshots).toHaveLength(1);
    expect(last().status).toBe('idle');
    expect(last().currentMs).toBe(0);
  });

  it('reports the authoritative clock in integer milliseconds', () => {
    video.__controls.setDuration(10);
    video.dispatchEvent(new Event('loadedmetadata'));

    video.__controls.setTime(3.4567);
    video.dispatchEvent(new Event('timeupdate'));

    // The element said 3.4567s; the clock reports 3457ms and nothing else.
    expect(last().currentMs).toBe(3457);
    expect(Number.isInteger(last().currentMs)).toBe(true);
    expect(last().durationMs).toBe(10_000);
  });

  it('moves through the status vocabulary', () => {
    video.dispatchEvent(new Event('loadstart'));
    expect(last().status).toBe('loading');

    video.__controls.setDuration(10);
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(last().status).toBe('ready');

    void video.__controls.play();
    expect(last().status).toBe('playing');

    video.__controls.pause();
    expect(last().status).toBe('paused');

    video.__controls.end();
    expect(last().status).toBe('ended');
  });

  it('never reports playing and error at the same time', () => {
    // The Fortify state model: one status, not a set of booleans that can contradict.
    void video.__controls.play();
    video.__controls.fail(3);
    expect(last().status).toBe('error');
    expect(last().status === 'playing').toBe(false);
  });

  it('turns a media error into a message a person can act on', () => {
    video.__controls.fail(3);
    expect(last().status).toBe('error');
    expect(last().error).toMatch(/could not be decoded/i);
    // Never a raw stack trace or an internal path.
    expect(last().error).not.toMatch(/at Object/);
    expect(last().error).not.toContain('/');
  });

  it('clamps a seek to the media bounds', () => {
    video.__controls.setDuration(10);
    video.dispatchEvent(new Event('loadedmetadata'));

    clock.seekTo(-500);
    expect(video.currentTime).toBe(0);

    clock.seekTo(99_000);
    // Clamped to 10s, converted to seconds only at the boundary.
    expect(video.currentTime).toBe(10);
  });

  it('reads the element again after a seek rather than trusting a local value', () => {
    video.__controls.setDuration(10);
    video.dispatchEvent(new Event('loadedmetadata'));
    clock.seekTo(4000);

    // The element is the authority: whatever it reports afterwards is the truth.
    video.__controls.setTime(4.25);
    video.dispatchEvent(new Event('seeked'));
    expect(last().currentMs).toBe(4250);
  });

  it('reports seeking while a seek is in flight', () => {
    video.__controls.setDuration(10);
    video.dispatchEvent(new Event('loadedmetadata'));
    video.dispatchEvent(new Event('seeking'));
    expect(last().status).toBe('seeking');
  });

  it('does not publish when nothing observable changed', () => {
    video.__controls.setDuration(10);
    video.dispatchEvent(new Event('loadedmetadata'));
    const before = snapshots.length;

    // A frame tick at an unchanged position must be a no-op, or a paused player would
    // re-render 60 times a second for no reason.
    video.__controls.setTime(2);
    video.dispatchEvent(new Event('timeupdate'));
    const afterFirst = snapshots.length;
    video.dispatchEvent(new Event('timeupdate'));
    video.dispatchEvent(new Event('timeupdate'));

    expect(afterFirst).toBe(before + 1);
    expect(snapshots.length).toBe(afterFirst);
  });

  it('collapses an unknown duration to zero', () => {
    // A media element reports Infinity or NaN before metadata; both must not propagate.
    const unknown = makeVideo({ duration: Number.NaN }) as ControllableVideo;
    const unknownClock = new PlaybackClock(unknown);
    const seen: PlaybackSnapshot[] = [];
    unknownClock.subscribe((next) => {
      seen.push(next);
    });
    unknown.dispatchEvent(new Event('loadedmetadata'));
    // Collected into an array rather than a `let`: TypeScript's control-flow analysis
    // narrows a closure-assigned variable to `null` at the point of use, which would hide
    // real reads behind a type error.
    expect(seen[seen.length - 1]?.durationMs).toBe(0);
    unknownClock.destroy();
  });

  it('reports a stall as a visible loading state', () => {
    void video.__controls.play();
    video.dispatchEvent(new Event('waiting'));
    expect(last().status).toBe('loading');
  });

  it('stops the animation loop when paused', () => {
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');
    const cancelSpy = vi.spyOn(globalThis, 'cancelAnimationFrame');

    void video.__controls.play();
    const afterPlay = rafSpy.mock.calls.length;
    expect(afterPlay).toBeGreaterThan(0);

    video.__controls.pause();
    // Pausing must tear the loop down; a running loop on a paused player is pure waste.
    expect(cancelSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it('treats a blocked autoplay as a normal condition, not a media failure', async () => {
    const blocked = makeVideo({ duration: 10 }) as ControllableVideo;
    const blockedClock = new PlaybackClock(blocked);
    const seen: PlaybackSnapshot[] = [];
    blockedClock.subscribe((next) => {
      seen.push(next);
    });

    blocked.play = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
    await blockedClock.play();

    const latest = seen[seen.length - 1];
    expect(latest?.status).toBe('error');
    // The message explains the cause rather than blaming the file.
    expect(latest?.error).toMatch(/blocked by the browser/i);
    blockedClock.destroy();
  });
});
