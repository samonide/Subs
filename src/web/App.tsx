/**
 * The playback surface.
 *
 * Phase 2's entire visible deliverable: a video element and enough transport to make the
 * playback architecture observable and testable. This is deliberately **not** the product
 * UI — no panels, no timeline, no styling. It exists so the clock, the frame stepping, and
 * the media streaming can be exercised against a real video element.
 *
 * Design constraints followed here, from the project's Operate-mode principles:
 *   - Standard `HTMLVideoElement` affordances, not reinvented ones.
 *   - One accent colour, reserved for the playhead and the active control.
 *   - Real control states: disabled frame buttons explain themselves via `title`.
 *   - Keyboard operable throughout; shortcuts never fire while typing.
 *   - No modal, no decorative motion, no card grid.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PlaybackClock, type PlaybackSnapshot } from './playback/clock.js';
import {
  frameRateFromMeta,
  stepBackward,
  stepForward,
  supportsFrameStepping,
} from './playback/time.js';
import { formatTimecode, framePosition } from './playback/timecode.js';
import { getPlaybackDescriptor, type PlaybackDescriptor } from './api.js';
import { PROJECT_ID_STORAGE_KEY } from './storage.js';

const STATUS_LABEL: Record<PlaybackSnapshot['status'], string> = {
  idle: 'Idle',
  loading: 'Loading…',
  ready: 'Ready',
  playing: 'Playing',
  paused: 'Paused',
  seeking: 'Seeking…',
  ended: 'Ended',
  error: 'Error',
};

/** Statuses where a frame step should be disabled: no grid, or no media. */
function frameStepEnabled(snapshot: PlaybackSnapshot, canStep: boolean): boolean {
  if (!canStep) return false;
  if (snapshot.durationMs <= 0) return false;
  return snapshot.status !== 'error' && snapshot.status !== 'loading';
}

export function App(): React.JSX.Element {
  const [projectId, setProjectId] = useState<string>(() => readStoredProjectId() ?? '');
  const [descriptor, setDescriptor] = useState<PlaybackDescriptor | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const clockRef = useRef<PlaybackClock | null>(null);
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>({
    status: 'idle',
    currentMs: 0,
    durationMs: 0,
    rate: 1,
    volume: 1,
    muted: false,
    error: null,
  });

  // Load the descriptor for the current project id.
  useEffect(() => {
    if (projectId.trim().length === 0) {
      setDescriptor(null);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    void getPlaybackDescriptor(projectId.trim())
      .then((next) => {
        if (cancelled) return;
        setDescriptor(next);
        // Remember the last project so a reload returns to it.
        writeStoredProjectId(next.projectId);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDescriptor(null);
        setLoadError(error instanceof Error ? error.message : 'This project could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Attach the clock exactly once per video element. The clock subscribes to the element's
  // own events, so React never polls the video for time.
  const attachClock = useCallback((video: HTMLVideoElement | null) => {
    clockRef.current?.destroy();
    clockRef.current = null;
    if (video === null) return;
    const clock = new PlaybackClock(video);
    clockRef.current = clock;
    clock.subscribe(setSnapshot);
  }, []);

  const frameRate = useMemo(() => frameRateFromMeta(descriptor?.asset?.meta ?? null), [descriptor]);
  const canStepFrames = useMemo(
    () => supportsFrameStepping(descriptor?.asset?.meta ?? null),
    [descriptor],
  );

  const stepFrame = useCallback(
    (direction: 1 | -1) => {
      const clock = clockRef.current;
      if (clock === null || frameRate === null) return;
      const current = clock.getSnapshot();
      const target =
        direction === 1
          ? stepForward(current.currentMs, frameRate, current.durationMs)
          : stepBackward(current.currentMs, frameRate, current.durationMs);
      // Frame stepping pauses, matching every NLE: you step to inspect a frame, and
      // playback continuing would make the step unverifiable.
      clock.pause();
      clock.seekTo(target);
    },
    [frameRate],
  );

  // Keyboard transport. Guarded so a shortcut never fires while the user is typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return;
      }

      switch (event.key) {
        case ' ':
        case 'k':
          event.preventDefault();
          clockRef.current?.togglePlayPause();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          stepFrame(-1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          stepFrame(1);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [stepFrame]);

  const mediaUrl = descriptor?.mediaUrl ?? null;
  const canStep = frameStepEnabled(snapshot, canStepFrames);
  const position =
    frameRate === null ? null : framePosition(snapshot.currentMs, snapshot.durationMs, frameRate);

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">Subtitle Studio — playback</h1>
        <p className="app__subtitle">
          Phase 2 technical surface. No subtitles are generated or edited yet.
        </p>
      </header>

      <section className="panel" aria-labelledby="project-heading">
        <h2 id="project-heading" className="panel__heading">
          Project
        </h2>
        <div className="row">
          <label className="field">
            <span className="field__label">Project ID</span>
            <input
              className="field__input"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              placeholder="paste a project id"
              aria-describedby="project-help"
            />
          </label>
          <button
            type="button"
            className="button"
            onClick={() => {
              if (projectId.trim().length > 0) writeStoredProjectId(projectId.trim());
            }}
          >
            Remember
          </button>
        </div>
        <p id="project-help" className="hint">
          {loading
            ? 'Loading project…'
            : loadError !== null
              ? loadError
              : descriptor === null
                ? 'Enter a project id to load its video.'
                : descriptor.asset === null
                  ? 'This project has no ingested video yet. Upload one through the ingest API, then reload.'
                  : `${descriptor.name} — ${descriptor.asset.meta?.width ?? '?'}×${descriptor.asset.meta?.height ?? '?'}, ${formatRate(descriptor.asset.meta?.frameRateNum, descriptor.asset.meta?.frameRateDen)}`}
        </p>
      </section>

      <section className="panel panel--stage" aria-label="Video player">
        <div className="stage">
          {mediaUrl === null ? (
            <div className="stage__placeholder">
              <p>No media loaded</p>
            </div>
          ) : (
            // A native video element: the authoritative clock, and the only decoder.
            // No <track> yet — subtitles are not generated until Phase 4+, and a
            // placeholder caption file would be fake functionality.
            <video
              ref={attachClock}
              className="stage__video"
              src={mediaUrl}
              preload="metadata"
              playsInline
            />
          )}
        </div>

        <div className="transport">
          <div className="transport__row">
            <button
              type="button"
              className="button"
              onClick={() => stepFrame(-1)}
              disabled={!canStep}
              title={
                canStep ? 'Previous frame (←)' : 'Frame stepping needs a constant-frame-rate source'
              }
              aria-label="Previous frame"
            >
              ◀ Frame
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => clockRef.current?.togglePlayPause()}
              disabled={mediaUrl === null}
              title="Play or pause (Space)"
            >
              {snapshot.status === 'playing' ? 'Pause' : 'Play'}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => stepFrame(1)}
              disabled={!canStep}
              title={
                canStep ? 'Next frame (→)' : 'Frame stepping needs a constant-frame-rate source'
              }
              aria-label="Next frame"
            >
              Frame ▶
            </button>

            <span className="status" data-status={snapshot.status}>
              {STATUS_LABEL[snapshot.status]}
            </span>
          </div>

          <label className="seek">
            <span className="visually-hidden">Seek</span>
            <input
              className="seek__input"
              type="range"
              min={0}
              max={Math.max(0, snapshot.durationMs)}
              step={1}
              value={Math.min(snapshot.currentMs, Math.max(0, snapshot.durationMs))}
              onChange={(event) => clockRef.current?.seekTo(Number(event.target.value))}
              disabled={snapshot.durationMs <= 0}
              aria-label="Seek"
            />
          </label>

          <div className="readout">
            <span className="readout__time">{formatTimecode(snapshot.currentMs, frameRate)}</span>
            <span className="readout__sep">/</span>
            <span className="readout__time readout__time--muted">
              {formatTimecode(snapshot.durationMs, frameRate)}
            </span>
            {position !== null ? (
              <span className="readout__frames">
                frame {position.frame} / {position.totalFrames}
              </span>
            ) : (
              <span className="readout__frames readout__frames--muted">frame rate unknown</span>
            )}
          </div>

          {snapshot.error !== null ? (
            <p className="error" role="alert">
              {snapshot.error}
            </p>
          ) : null}

          {descriptor?.asset?.meta?.frameRateMode === 'vfr' ? (
            <p className="note">
              This source has a variable frame rate, so it has no fixed frame grid. Frame stepping
              is disabled rather than approximated.
            </p>
          ) : null}
        </div>
      </section>

      <section className="panel" aria-labelledby="shortcuts-heading">
        <h2 id="shortcuts-heading" className="panel__heading">
          Keyboard
        </h2>
        <dl className="shortcuts">
          <div>
            <dt>
              <kbd>Space</kbd> <kbd>K</kbd>
            </dt>
            <dd>Play / pause</dd>
          </div>
          <div>
            <dt>
              <kbd>←</kbd>
            </dt>
            <dd>Previous frame</dd>
          </div>
          <div>
            <dt>
              <kbd>→</kbd>
            </dt>
            <dd>Next frame</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function formatRate(num: number | undefined, den: number | undefined): string {
  if (num === undefined || den === undefined) return 'frame rate unknown';
  // Show the exact rational, never a rounded decimal.
  return `${num}/${den} fps`;
}

function readStoredProjectId(): string | null {
  try {
    return globalThis.localStorage?.getItem(PROJECT_ID_STORAGE_KEY) ?? null;
  } catch {
    // Private browsing or a blocked storage partition. Not worth surfacing.
    return null;
  }
}

function writeStoredProjectId(id: string): void {
  try {
    globalThis.localStorage?.setItem(PROJECT_ID_STORAGE_KEY, id);
  } catch {
    // Non-fatal: remembering the project is a convenience, not a requirement.
  }
}
