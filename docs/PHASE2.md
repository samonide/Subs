# Phase 2 — Playback & Time Base

Phase 2 introduces the first browser consumer of the Phase 0 core. It does not build the
editor: it establishes a correct, deterministic playback foundation that playback, subtitle
synchronisation, timeline scrubbing, and frame-accurate editing can all rely on.

Status: **complete**.

## What exists

```
React app (src/web)
   ↓  fetch logical ids only
Vite dev proxy (browser origin → loopback server)
   ↓
node:http (src/server/http.ts)
   ↓  resolves assetId → file path
createReadStream (streamed, never buffered)
   ↓
workspace/projects/<projectId>/media/<assetId>/original.mp4
```

`src/core` is unchanged in role. It still contains no browser APIs, no `node:` imports, and
no I/O — the new `playback/time.ts` in the web layer consumes the Phase 0 timing primitives
rather than reimplementing them.

## The time conversion boundary

There is exactly one conversion from browser seconds to canonical integer milliseconds, in
`src/web/playback/time.ts`:

```ts
export const secondsToMs = (seconds: number): number => Math.round(seconds * 1000);
```

`tests/boundary.test.ts` asserts that this expression appears in that file and in no other
file under `src/web`, so a second rounding rule cannot be introduced by accident. Two subtly
different rounding rules are how off-by-one-frame subtitle drift appears later.

The inverse is `msToSeconds`, used only when writing to `video.currentTime`.

Internally every consumer — UI, clock subscribers, and later the timeline — reads
`PlaybackSnapshot.currentMs`, which is already canonical.

## Playback clock

`src/web/playback/clock.ts` wraps the `HTMLVideoElement` and is the single source of truth.

- The video element is authoritative. The clock **reads** `currentTime`; it never maintains a
  parallel timer. A second clock would drift against the element and produce captions that
  disagree with the picture.
- `requestAnimationFrame` runs **only while playing**, to publish a fresh reading each frame.
  It is cancelled on pause, on `ended`, on `seeking`, and on `destroy`. A running rAF loop on a
  paused video is pure waste.
- `timeupdate`, `durationchange`, `loadedmetadata`, `seeking`, `seeked`, `waiting`, `playing`,
  `pause`, `ended`, and `error` are all observed. A stalled media element is reported as
  `loading`, not as an error.

### State vocabulary

`idle | loading | ready | playing | paused | seeking | ended | error` — one value, so
impossible combinations such as `isPlaying: true, status: 'error'` cannot be represented.

`currentMs` is clamped to `[0, durationMs]`, and an unknown duration collapses to `0` rather
than propagating `NaN` into the UI.

## Frame stepping

Stepping uses the Phase 0 rational frame rate from `MediaMeta` (`frameRateNum` /
`frameRateDen`), never a decimal approximation. `1 / 29.97` is not used anywhere.

| Frame rate   | Frame 1 begins |
| ------------ | -------------- |
| `30000/1001` | 34 ms          |
| `30/1`       | 34 ms          |
| `60/1`       | 17 ms          |

Frame _ownership_ follows the Phase 0 partition rule: frame `n` owns
`[frameToMs(n), frameToMs(n + 1))`. Stepping backward returns the start of the current frame
rather than subtracting a frame duration from an arbitrary position, so repeated
previous-frame presses converge on exact boundaries instead of accumulating error.

**VFR limitation.** For media marked `frameRateMode: 'vfr'`, or with no frame rate metadata,
frame stepping is **disabled and the controls explain why**. A variable frame rate has no
frame index, so any "next frame" would be a fabricated value. This is deliberate: the
alternative is a control that silently lies. The correct treatment — deriving a frame
timeline from the container's sample table — belongs with VFR time-base handling and is
recorded as a known limitation rather than approximated.

## Media endpoint

`GET /media/:projectId/:assetId` streams from disk with Range support.

| Request                  | Response                                             |
| ------------------------ | ---------------------------------------------------- |
| No `Range`               | `200`, full `Content-Length`, `Accept-Ranges: bytes` |
| `bytes=1000-1999`        | `206`, `Content-Range: bytes 1000-1999/30919`        |
| `bytes=-500` (suffix)    | `206`, final 500 bytes                               |
| `bytes=99999999-`        | `416`                                                |
| Malformed / unknown unit | Header ignored, `200`                                |
| Unknown or foreign asset | `404`                                                |

Verified byte-for-byte against the source file: a full download is `cmp`-identical to the
original, and a mid-file range matches the corresponding source slice exactly.

The response is piped from `createReadStream`, so memory use is independent of file size.

### Path containment

The asset is located by looking it up **inside the project document**, then resolving the
stored filename through the workspace layout. Identifiers are never interpolated into a path.
Traversal attempts, symlinks, and foreign asset ids all fail closed, and a symlink whose
target escapes the workspace is rejected by the Phase 1 `assertInsideRoot` check.

### The browser never sees a path

Responses carry only logical ids and canonical metadata. The Phase 1 upload response used to
include `filePath`; that was removed in Phase 2 because it leaked the workspace layout over
the network. `tests/http.test.ts` now asserts no response contains the workspace root. The
browser addresses media as `/media/:projectId/:assetId` and the server resolves the path.

## Browser-side API

Three endpoints, no framework, no generic REST layer:

| Route                            | Purpose                                                                  |
| -------------------------------- | ------------------------------------------------------------------------ |
| `GET /api/projects`              | List projects                                                            |
| `GET /api/projects/:id/playback` | Everything the player needs: asset id, canonical `MediaMeta`, `mediaUrl` |
| `GET /media/:projectId/:assetId` | The bytes                                                                |

`playback` returns `asset: null` for a project with no video, which the UI renders as an empty
state rather than an error.

## UI

Deliberately minimal: a video viewport, play/pause, a time readout, a seek slider, and
previous/next frame. It exists to make the playback architecture observable and testable, not
to preview the product. No design system, no icon set, no theme, no panels.

Keyboard: `Space` play/pause, `←`/`→` step one frame. Shortcuts are suppressed while a text
field has focus.

## Testing

- `range.test.ts` — header parsing, including malformed and unknown units.
- `media-endpoint.test.ts` — full/middle/suffix/unsatisfiable ranges and traversal, byte-exact.
- `playback-time.test.ts` — seconds↔ms, frame stepping, clamping, and rational rates for
  `30/1`, `60/1`, and `30000/1001`, including boundary values.
- `clock.test.ts` — the clock's response to media events, loop lifecycle, and error mapping.
- `app.test.tsx` — loading, empty, error, transport controls, keyboard, and the VFR-disabled
  state.
- `boundary.test.ts` — core/browser separation and the single conversion boundary.

jsdom implements no decoder, so component tests drive the element by dispatching the events a
real element would fire. They verify the clock's _response_ to media events rather than
pretending the browser decodes video.

## Deviations from the plan

- **Vite build added to `build`.** `build` was `tsc` only, which never produced a browser
  bundle. It is now `tsc --build && vite build`.
- **`dev` runs only the web server.** Running the API and Vite together would have required
  adding a process runner for a two-command workflow, which is not a dependency worth taking
  in this phase. `dev:server` and `dev:web` are available separately.
- **`filePath` removed from the upload response.** A Phase 1 leftover that violated the Phase 2
  rule that the browser must never receive server paths.

## Known limitations

- **No VFR time base.** Frame stepping is disabled for VFR rather than approximated.
- **No proxy generation.** Large files rely on the browser decoding the original directly;
  seeking accuracy on very large files is a Phase 13 concern.
- **`video.currentTime` seeking is decoder-dependent.** Browsers may seek to the nearest
  decodable frame rather than the exact requested position. Mitigated by 1-frame stepping,
  which lands on a frame boundary.
- **No waveform, thumbnails, or scrubbing preview.** Phase 3+.
- **Component tests cannot verify actual decoding**, only event handling.
