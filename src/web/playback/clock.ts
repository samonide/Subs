/**
 * The playback clock.
 *
 * One rule governs this file: **`HTMLVideoElement.currentTime` is the only authority.**
 * There is no timer, no accumulated elapsed time, and no independent notion of "now".
 * Every reported position is read from the element and converted at the single boundary in
 * `time.ts`.
 *
 * The failure this prevents is specific and common: a `setInterval` that advances a
 * counter alongside playback. It drifts against the audio within seconds, it disagrees with
 * what the user hears, and the drift compounds. Everything here reads instead of counting.
 *
 * ## Update strategy
 *
 * A `requestAnimationFrame` loop runs **only while the video is playing**. When paused,
 * updating would repaint the same value 60 times a second for no reason, which is exactly
 * the re-render churn that makes an editor feel sluggish. While playing, rAF is correct: it
 * is already aligned to the compositor, so time updates land on the frame that displays
 * them.
 *
 * Subscribers are notified only when the canonical millisecond value actually changes, so
 * a paused player is genuinely idle.
 */

import { clampMs, msToSeconds, secondsToMs, type PlaybackMs } from './time.js';

/** Coarse playback state. One value, not a set of booleans that can contradict. */
export type PlaybackStatus =
  'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'seeking' | 'ended' | 'error';

export interface PlaybackSnapshot {
  status: PlaybackStatus;
  /** Canonical integer milliseconds. */
  currentMs: PlaybackMs;
  /** Canonical integer milliseconds, or 0 while unknown. */
  durationMs: PlaybackMs;
  /** Playback rate multiplier. */
  rate: number;
  volume: number;
  muted: boolean;
  /** A message suitable for showing to a person. Never a stack trace. */
  error: string | null;
}

type Listener = (snapshot: PlaybackSnapshot) => void;

/** Map a `MediaError` code to something a person can act on. */
function describeMediaError(video: HTMLVideoElement): string | null {
  const error = video.error;
  if (error === null) {
    return null;
  }
  switch (error.code) {
    case 1:
      return 'Loading this video was aborted.';
    case 2:
      return 'A network error interrupted the video.';
    case 3:
      return 'This video could not be decoded — the file may be corrupt or use an unsupported codec.';
    case 4:
      return 'This video format is not supported by your browser.';
    default:
      return 'This video could not be played.';
  }
}

export class PlaybackClock {
  private readonly video: HTMLVideoElement;
  private readonly listeners = new Set<Listener>();
  private frameHandle: number | null = null;
  private lastReportedMs: PlaybackMs | null = null;

  private snapshot: PlaybackSnapshot;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.snapshot = {
      status: 'idle',
      currentMs: 0,
      durationMs: 0,
      rate: 1,
      volume: 1,
      muted: false,
      error: null,
    };
    this.attach();
  }

  // ── Subscription ────────────────────────────────────────────────────────

  /** Subscribe. Fires immediately with the current snapshot. Returns an unsubscribe fn. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): PlaybackSnapshot {
    return this.snapshot;
  }

  /** Read the element and publish if the canonical value changed. */
  private publish(): void {
    const currentMs = secondsToMs(this.video.currentTime);
    const durationMs = this.readDurationMs();

    if (currentMs === this.lastReportedMs && durationMs === this.snapshot.durationMs) {
      // Nothing observable changed. Publishing anyway would re-render for no reason.
      return;
    }
    this.lastReportedMs = currentMs;

    this.snapshot = {
      ...this.snapshot,
      currentMs,
      durationMs,
      rate: this.video.playbackRate,
      volume: this.video.volume,
      muted: this.video.muted,
    };
    this.emit();
  }

  /**
   * Publish unconditionally — for state transitions where the millisecond value did not
   * change but the state did (play → seeking, for instance).
   */
  private publishState(status: PlaybackStatus, error: string | null = this.snapshot.error): void {
    this.snapshot = {
      ...this.snapshot,
      status,
      // Re-read on every state change so a status update never carries a stale position.
      currentMs: secondsToMs(this.video.currentTime),
      durationMs: this.readDurationMs(),
      error,
    };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  /**
   * Duration in integer ms.
   *
   * `Infinity` is what a media element reports before metadata arrives, and some live
   * streams never resolve it. Both must collapse to 0 rather than propagating: a NaN or
   * Infinity duration would break every seek and clamping calculation downstream.
   */
  private readDurationMs(): number {
    const raw = this.video.duration;
    if (!Number.isFinite(raw) || raw < 0) {
      return 0;
    }
    return Math.round(raw * 1000);
  }

  // ── The rAF loop, only while playing ────────────────────────────────────

  private tick = (): void => {
    if (this.video.paused || this.video.ended) {
      this.frameHandle = null;
      return;
    }
    this.publish();
    this.frameHandle = requestAnimationFrame(this.tick);
  };

  private startLoop(): void {
    if (this.frameHandle === null) {
      this.frameHandle = requestAnimationFrame(this.tick);
    }
  }

  private stopLoop(): void {
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }

  // ── Element wiring ──────────────────────────────────────────────────────

  private attach(): void {
    const video = this.video;

    video.addEventListener('loadstart', () => {
      this.stopLoop();
      this.publishState('loading', null);
    });

    video.addEventListener('loadedmetadata', () => {
      this.lastReportedMs = null;
      this.publishState('ready', null);
    });

    video.addEventListener('canplay', () => {
      if (this.snapshot.status === 'loading') {
        this.publishState('ready', null);
      }
    });

    video.addEventListener('play', () => {
      this.publishState('playing', null);
      this.startLoop();
    });

    video.addEventListener('playing', () => {
      // `playing` fires once the browser has enough buffered to actually advance, which is
      // later than `play`. Using it avoids showing "playing" during a stall.
      this.publishState('playing', null);
      this.startLoop();
    });

    video.addEventListener('pause', () => {
      this.stopLoop();
      this.publishState(this.video.ended ? 'ended' : 'paused', null);
    });

    video.addEventListener('seeking', () => {
      this.publishState('seeking');
    });

    video.addEventListener('seeked', () => {
      this.lastReportedMs = null;
      this.publishState(this.video.paused ? 'paused' : 'playing', null);
      if (!this.video.paused) this.startLoop();
    });

    video.addEventListener('ended', () => {
      this.stopLoop();
      this.publishState('ended', null);
    });

    video.addEventListener('error', () => {
      this.stopLoop();
      this.publishState('error', describeMediaError(video) ?? 'This video could not be played.');
    });

    // A stall is a distinct, user-visible condition: the video is neither playing nor
    // paused, and silently doing nothing is the wrong signal.
    video.addEventListener('waiting', () => {
      if (!this.video.paused) this.publishState('loading');
    });

    video.addEventListener('stalled', () => {
      if (!this.video.paused) this.publishState('loading');
    });

    video.addEventListener('ratechange', () => {
      this.publish();
    });

    video.addEventListener('volumechange', () => {
      this.publish();
    });

    // `timeupdate` is the element's own coarse position signal. It is the only way to learn
    // about a position change while the video is *paused* — for example after the user
    // scrubs, or when a media fragment updates currentTime without firing `seeked`. Without
    // it the clock is blind whenever the rAF loop is not running, which is exactly when a
    // scrub needs to be reflected.
    video.addEventListener('timeupdate', () => {
      this.publish();
    });

    // Duration can change after metadata: a live stream resolves later, and some files
    // report a different length once fully parsed.
    video.addEventListener('durationchange', () => {
      this.lastReportedMs = null;
      this.publish();
    });
  }

  // ── Commands ────────────────────────────────────────────────────────────

  async play(): Promise<void> {
    try {
      await this.video.play();
    } catch (error) {
      // Autoplay policies reject play() before any user gesture. That is a normal
      // condition, not a failure of the media.
      const message =
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Playback was blocked by the browser. Press play to start.'
          : 'This video could not be played.';
      this.publishState('error', message);
    }
  }

  pause(): void {
    this.video.pause();
  }

  togglePlayPause(): void {
    if (this.video.paused) {
      void this.play();
    } else {
      this.pause();
    }
  }

  /**
   * Seek to a canonical time.
   *
   * The value is clamped here, converted to seconds, and handed to the element. **After
   * this returns the element is again the authority** — nothing local is treated as the
   * new truth, and the `seeked` event re-reads it.
   */
  seekTo(ms: PlaybackMs): void {
    const clamped = clampMs(ms, this.snapshot.durationMs);
    this.video.currentTime = msToSeconds(clamped);
    this.lastReportedMs = null;
    this.publish();
  }

  setRate(rate: number): void {
    this.video.playbackRate = rate;
    this.publish();
  }

  setVolume(volume: number): void {
    this.video.volume = clamp01(volume);
    this.publish();
  }

  setMuted(muted: boolean): void {
    this.video.muted = muted;
    this.publish();
  }

  /** Detach listeners and stop the loop. */
  destroy(): void {
    this.stopLoop();
    this.listeners.clear();
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
