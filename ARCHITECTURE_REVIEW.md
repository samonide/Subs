# ARCHITECTURE_REVIEW.md — Senior Architect Self-Review

A re-examination of the architecture proposed in `ARCHITECTURE.md`, **before** any code is
written. This document is adversarial toward my own earlier proposal: where I over-engineered,
it says so.

Companions: `PRODUCT.md` (requirements), `ARCHITECTURE.md` (canonical design),
`IMPLEMENTATION_PLAN.md` (sequence).

**Verdict summary:** the direction is sound, but **three of my proposals were over-engineered**
(§2 monorepo, §9 undo/redo deferral, §5 a speculative `transform`+`position`+`effects` field
cluster), and **one under-specified claim needs correcting** (§7 libass support for
background boxes and border radius — libass has no such feature).

---

## 1. Architecture decision review

### D-1 — pnpm monorepo with 4 packages

**Decision:** pnpm workspaces; `apps/{web,server}`, `packages/{core,media,render-ass,render-dom}`.

**Why it makes sense:** the _constraint_ that `core` is environment-independent (importable
by browser, Node worker, and test runner) is genuinely load-bearing. It is what makes
preview/export parity achievable instead of aspirational.

**Main alternative:** a single app with path discipline (`src/core/`, `src/server/`).

**Why not the alternative:** path discipline inside one package is _unenforceable_ in the way
that matters. You can ESLint-import-boundaries within a package, but the real risk isn't a
stray import — it's that preview styling quietly lands in a React component, where it is
indistinguishable from ordinary UI code. A separate package makes that mistake structurally
impossible.

**How I'd migrate if wrong:** moving `packages/core` into `src/core` and keeping
`render-ass` separate is a mechanical path change plus `tsconfig` rootDirs. Low cost. This is
why the decision is cheap to reverse — which is itself an argument that it need not be made
today.

### 🚩 VERDICT: **DEFERRED — and my earlier proposal was over-engineered**

Creating **four** packages in Phase 0 was fragmentation, not architecture. I was paying a
structural cost in exchange for a boundary that costs nothing to add later and is _cheaper to
add late_, because a boundary applied to 400 lines of code is unarguable, while the same
boundary applied to 20,000 lines invites exceptions.

**Revised:** a single `package.json` at Phase 0. Introduce packages only at the phase that
gives them a second consumer (full reasoning in §2).

---

### D-2 — FFmpeg + libass (ASS) export

**Decision:** render the burned-in export with FFmpeg's `subtitles` filter driven by a
generated ASS file. The ASS file is produced by a **pure function**:
`ProjectDocument → .ass`.

**Why it makes sense:** libass is a mature text renderer with wrapping, alignment, outlines,
shadows, colour, transforms, per-event timing, and fades — and it needs no browser. Being a
pure string-producing function, it is unit-testable, diffable, and reviewable. The
alternative renderers either need a browser at export time or are the browser.

**Main alternative:** headless Chromium — load the preview, `MediaRecorder`/screenshot frames,
mux. Maximises DOM parity by construction, since the exporter _is_ the preview.

**Why not the alternative:** it is a second, invisible implementation of all layout
behaviour, with a second font stack, a second set of browser quirks, and a heavy runtime
dependency. It also cannot be a pure function. The decisive argument is philosophical: with
libass, the export is a _transformation_ of the document; with Chromium, it is a _replay_ of
the app. A transformation is reviewable; a replay is not.

**How I'd migrate if wrong:** if Chromium-parity turns out to matter more than reviewability
(large, exotic style sets), the document model and `core` are unchanged — only the export
backend swaps, behind the same job interface. Genuinely low-risk.

### VERDICT: **LOCKED**

Highest-confidence decision in the set. It underwrites the entire export design, it is
verified available (`--enable-libass`, `ass` + `subtitles` filters), and reversing it later
touches exactly one package.

---

### D-5 — Hosted transcription provider behind an abstraction

**Decision:** implement one hosted API (default OpenAI) behind a `TranscriptionProvider`
interface. Local Whisper deferred.

**Why it makes sense:** zero operational burden, real word timings, and the whole provider
surface is one interface with a normalizer at its boundary.

**Main alternative:** local `faster-whisper` first — private, free, and the Python 3.14
runtime is already present on this machine.

**Why not the alternative:** it front-loads a Python model runtime, a model-download story,
and CPU-inference performance questions _before the first subtitle can be generated_. Those
are real product problems, not build problems, and they deserve to be answered with
evidence. Python 3.14 is also very new; `faster-whisper`/`ctranslate2` wheel availability is
unverified.

**A deeper correction to my earlier reasoning:** I previously cited provider swap cost as
evidence this decision is low-risk. That argument was weak — a well-designed interface makes
any provider low-risk, so swap cost doesn't discriminate between the options. What actually
discriminates is **onboarding the first real user**, where API-key friction is a five-minute
problem and a Python runtime is a day.

**How I'd migrate if wrong:** implement a second interface implementation. No application
code changes. This is the least consequential decision in the set, which is exactly why it
should not be locked.

### VERDICT: **DEFERRED**

Deliberately. The interface is what must be locked; the first implementation is a reversible
configuration choice with no architectural consequence.

---

### D-6 — Parametrised animation descriptors, not keyframes

**Decision:** `SubtitleAnimationDef` as `(property, curve, phase, durationFraction, from, to, stagger)`.

**Why it makes sense:** the MVP animation set — fade, pop, slide, punch — is fully
expressive in that form. Nothing in the current requirements needs a keyframe curve editor.

**Main alternative:** a keyframe timeline from the start.

**Why not the alternative:** a keyframe system is a large amount of machinery — interpolation
across arbitrary property sets, a UI to author it, ordering rules — built for a requirement
that does not exist yet. The failure mode is building it, finding nobody uses it, and
maintaining dead weight.

**Honest weakness in my own position:** the descriptor covers _single-property, in-out_
motion only. Per-word colour tweens, sequential choreography, and loops are not
representable. If the product's motion ambitions grow, this needs replacing, not extending.

**How I'd migrate if wrong:** the upgrade path is _a union, not a rewrite_:
`SubtitleAnimationDef = ParametricAnimation | KeyframeAnimation`. Both resolve to the same
`ResolvedTransform`, so the resolver and both renderers are untouched. Text is stored in the
document, so old projects still load — the migration converts descriptors to a
single-keyframe-pair form.

### VERDICT: **LOCKED (parametric now), with the keyframe union as the documented escape hatch**

---

### D-7 — Vite SPA + Fastify (vs. Next.js)

**Decision:** separate Vite React SPA and a Fastify API service.

**Why it makes sense:** the editor is a single full-bleed application surface with large
media assets, drag-and-drop, and rAF-driven playback. Nothing here benefits from SSR, and
several things actively suffer from it — a 2GB video does not want a Node render pass, and
streaming multipart through a Next.js route handler invites exactly the buffering failure
this design is trying to avoid.

**Main alternative:** Next.js.

**Why not the alternative:** it adds SSR, routing conventions, and a server runtime we do not
need, while making the streamed-upload path harder to get right. It is a large framework to
adopt in order to use a fraction of it.

**Separately, Fastify itself is not yet justified** — see below.

**How I'd migrate if wrong:** the Vite app is a static bundle; any reverse proxy or CDN can
serve it. The Fastify API is a small surface that could be re-hosted. Neither decision is
load-bearing.

### VERDICT: **D-7 (Vite SPA) LOCKED** · **Fastify DEFERRED**

---

## 2. Package structure review

I proposed four packages at Phase 0. Re-examining that honestly: **three of them had no
second consumer, and a package with one consumer is not a boundary — it is a folder with
extra build config.**

The useful test I should have applied: _a package earns its existence when it has two
consumers that must not be coupled, or when it has a genuinely different runtime._ Measured
against that:

| Package      | Consumers at Phase 0                   | Verdict                                                                                           |
| ------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `core`       | web only                               | **Not yet** — the boundary that matters is _`core` vs everything else_, not core's internal shape |
| `media`      | nothing (no ffmpeg code until Phase 3) | **Premature** — created before its only consumer exists                                           |
| `render-ass` | nothing (no export until Phase 8)      | **Premature**                                                                                     |
| `render-dom` | nothing (no preview until Phase 7)     | **Premature**                                                                                     |

### Final structure: 2 packages, introduced at Phase 0, not 4

```
Subs/
├── package.json            # single root, pnpm
├── tsconfig.json
├── src/
│   ├── core/               # ⭐ pure, no react, no node, no ffmpeg. Importable everywhere.
│   ├── server/             # fastify + ffmpeg + transcription. Node-only.
│   ├── web/                # react + vite app
│   └── shared/             # transient: only if/when two of the above need to share
├── tests/
└── docs/
```

`src/core` versus everything else **is** the structural win, and it is achievable with an
ESLint `no-restricted-imports` rule in a single package — enforced in CI, which was the
actual requirement. The rule is:

```
src/core/  →  must not import: react, react-dom, node:*, child_process, fastify
```

Verified by a unit test that greps the built dependency graph. This is a real, automated,
CI-enforced boundary at a fraction of the cost.

**Why this is not premature in the other direction:** the moment a _second runtime_ appears,
extraction is mechanical. Phase 7 (preview) and Phase 8 (export) are where divergence
actually starts:

- **Phase 7** → `src/core/render/` extracted, renamed `render-dom`, as a package.
- **Phase 8** → `render-ass` is born already Node-consumable (it is a pure string function, so
  this is genuinely trivial — the function was written to be portable).
- **Phase 11+** → `src/core/media/` extracted when transcription and ffmpeg share a job shape.

The end state is the four-package monorepo. We get there having paid the cost only where it
earns something, and having tested the boundary at small scale first.

**Consequence:** D-1 above is downgraded to DEFERRED. Revisit at Phase 7, when the second
runtime is real and the boundary will have been exercised by ~5 phases of actual code.

---

## 3. Browser vs. server vs. worker vs. external provider

Derived per operation from its actual constraints, not from preference.

| Operation                         | Where                        | Why                                                                                         |
| --------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| Video decode / playback           | **Browser**                  | `<video>` is the best video player available; zero copy; the editor _needs_ 60fps scrubbing |
| Subtitle text editing             | **Browser**                  | Latency-sensitive direct manipulation                                                       |
| Style resolution (`resolveStyle`) | **Both**                     | Pure, so the same function runs in both runtimes — this is the parity mechanism             |
| Preview render                    | **Browser**                  | Must be interactive at 60fps; round-tripping to a server is impossible for a drag           |
| Waveform                          | **Browser**                  | Precomputed peak data, rendered to canvas                                                   |
| Timeline UI / zoom / selection    | **Browser**                  | Pure UI state                                                                               |
| Upload transport                  | **Browser → server**         | The bytes must reach disk; the browser cannot keep them (storage pressure)                  |
| **File storage on disk**          | **Server**                   | Reloadable across browser restarts; a 2GB blob cannot live in a browser tab                 |
| Media probing (`ffprobe`)         | **Worker**                   | CPU-bound, must not block the API                                                           |
| Audio extraction                  | **Worker**                   | CPU-bound, ~seconds to tens of seconds                                                      |
| Transcode to proxy                | **Worker**                   | CPU-bound, slow                                                                             |
| **ASR**                           | **Worker** (hosted provider) | Network-bound and long; a request would time out                                            |
| **Segmentation**                  | **Worker**, on the document  | Pure; no reason to run it on the API thread                                                 |
| Document persistence              | **Server**                   | Source of truth, must outlive the tab                                                       |
| Export (ASS gen + FFmpeg)         | **Worker**                   | CPU-bound, minutes                                                                          |
| Job progress                      | **Server → Browser (SSE)**   | One-directional; the job runs in a worker that the browser cannot see                       |

**Two derivations worth stating explicitly:**

1. **Segmentation runs in the worker, not the browser** — even though it's a pure function
   both could run. It is part of "turn this uploaded media into subtitles," which is
   inherently an asynchronous, progress-reporting operation. The browser needs the _result_,
   not the intermediate debate about line breaks.

2. **The video never returns to the server after upload.** Playback streams from the
   `/media` endpoint; export re-reads the file from disk. This is the single most important
   structural decision in the pipeline: after ingest, video is a _static asset_, not a stream
   shuttled back and forth. The 30-second clip is a 30-second clip everywhere; nothing about
   editing it requires re-uploading.

### Data flow

```
┌─ BROWSER ────────────────────────────────────────────────────────┐
│  file picker / drag-drop                                        │
│      │  (bytes stream, never buffered whole)                    │
└──────┼──────────────────────────────────────────────────────────┘
       │ POST /api/projects/:id/assets  ──── streamed to disk
       ▼
┌─ SERVER (Fastify, thin) ────────────────────────────────────────┐
│  write stream → workspace/media/<assetId>/<file>                │
│  enqueue job, return 202 + jobId immediately                     │
│  store project.json, serve /media/* for playback                 │
└──────┼──────────────────────────────────────────────────────────┘
       │ job queue (in-process, worker_threads)
       ▼
┌─ WORKER ────────────────────────────────────────────────────────┐
│  1. ffprobe        → MediaMeta (exact frameRate, rotation)      │
│  2. ffmpeg         → 16kHz mono WAV ──┐                          │
│  3. TranscriptionProvider ───────────┤                          │
│  4. segmentWords() (src/core, pure) │                          │
│  5. write project.json             ▼                          │
│     6. SSE: progress + result        project.json updated       │
└─────────────────────────────────────────────────┬──────────────┘
                                                  │ GET /api/projects/:id  (poll or SSE)
┌─ BROWSER (editor) ─────────────────────────────▼──────────────┐
│  <video src=/media/...>  ← plays from server, Range requests    │
│  timeline: documentStore → pure ops → re-render                 │
│  preview overlay: resolveStyle()  ← src/core, same function     │
└──────┼──────────────────────────────────────────────────────────┘
       │ POST /api/jobs {kind:'export'}
       ▼
┌─ WORKER ────────────────────────────────────────────────────────┐
│  render-ass: ProjectDocument → .ass   (pure string fn)          │
│  ffmpeg -i source.mp4 -vf subtitles=out.ass  → output.mp4       │
│  + SRT / VTT sidecars                                            │
└─────────────────────────────────────────────────────────────────┘
```

**Note the two uses of `src/core` inside the worker** (`segmentWords`, `render-ass`) and the
one inside the browser (`resolveStyle`). Same code, two runtimes. That is the whole point, and
it is why `core` may never import anything environment-specific.

---

## 4. Transcription abstraction

Three layers, deliberately separated, because they are three different kinds of code:

```
Layer 1  provider adapter      (Node, impure, per-vendor, disposable)
             │  vendor response format
             ▼
Layer 2  normalizer            (pure, vendor-agnostic)  ── src/core
             │  NormalizedTranscript
             ▼
Layer 3  document writer       (pure, builds SubtitleSegment[])  ── src/core
```

Layer 1 is the only place a vendor's response shape is allowed to appear, and it is
disposable: deleting a provider must not touch layers 2 or 3.

### Interface

```ts
export interface TranscriptionProvider {
  readonly id: string; // stable, persisted in the document
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  transcribe(req: TranscriptionRequest): Promise<ProviderRawResult>;
}

export interface ProviderCapabilities {
  wordTimings: boolean; // false ⇒ words must be synthesized
  confidences: boolean;
  languageDetection: boolean;
  maxAudioBytes?: number; // chunking threshold
  maxAudioMs?: number;
}

export interface TranscriptionRequest {
  audio: { path: string; durationMs: number; sampleRate: number };
  language?: string; // undefined = auto-detect
  hints?: { vocabulary?: string[] };
  signal: AbortSignal; // cancellation
  onProgress?(fraction: number): void;
}

/** Adapter's job: parse the vendor response. Still vendor-shaped. */
export interface ProviderRawResult {
  providerId: string;
  model?: string;
  language?: string;
  text?: string;
  units: RawUnit[]; // {text,start,end,confidence?} — vendor's granularity
  metadata?: Record<string, unknown>;
}
```

### The normalized model (Layer 2) — this is the contract

```ts
export interface NormalizedTranscript {
  text: string;
  language?: string;
  units: NormalizedUnit[]; // ordered, non-overlapping
  providerId: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface NormalizedUnit {
  text: string;
  startMs: number; // integer ms
  endMs: number;
  confidence?: number; // 0..1, absent if the provider has no such thing
  timingSource: 'measured' | 'synthesized';
}
```

**Rules the normalizer guarantees** (each is a testable invariant):

- **U-1** All time is integer milliseconds.
- **U-2** Units are ordered by `startMs` and non-overlapping. Overlapping vendor output is
  clamped, not passed through.
- **U-3** `endMs > startMs` always. Zero-length units are merged forward.
- **U-4** Units never exceed the audio duration.
- **U-5** `confidence` is either absent or in [0,1]. Never 0 as a stand-in for "unknown".
- **U-6** If `capabilities.wordTimings === false`, every unit is marked
  `timingSource: 'synthesized'` and distributed within its containing span by character
  length. **It is never silently presented as measured.** This distinction is the difference
  between a trustworthy tool and a lying one, and it survives all the way to the UI.
- **U-7** If `confidence` is absent, it stays absent — not `1.0`, not `0`. Absent and certain
  are different facts.

### What never enters the document

`ProviderRawResult`, `units`, `metadata` about provider internals, and every vendor field
name. The document records only `transcription: { providerId, model, language, transcriptId, generatedAt }`
— a **provenance pointer**, not a copy. Re-running a provider is a request, not a lookup of
a cached blob we silently embedded. Provider-native output is never stored in the project.

### Future model: `RawResult` and `NormalizedUnit` are deliberately open

A local Whisper provider emits `units` at whatever granularity it produces — word, token, or
character. A forced-alignment provider emits per-word timings over a known transcript. A
future model might emit structured dialogue. The normalizer collapses all of these to
`NormalizedUnit`; nothing above layer 2 knows or cares. The `metadata` bag carries
model-specific detail for diagnostics without letting it into the model.

---

## 5. Document model review

### What I got wrong

My original `ProjectDocument` had a speculative field cluster. Specifically I had:

- `StyleTransform` (`scale`/`rotationDeg`/`opacity`) **plus** separate
  `SubtitleTrack.transform` / `SubtitleSegment.transform` fields;
- a separate `SubtitleTrack.position` **and** `SubtitleStyle.position`;
- `lineBreaks?: number[]` with a semantics I never pinned down;
- a `SubtitleStyle.extensions` bag that could never be populated honestly;
- no `documentId` on assets or fonts, which makes the font registry non-viable;
- no notion of per-segment ordering at equal start times.

That is four fields added "in case," and one missing field that a _required_ feature
(§6 of `PRODUCT.md`, S-08) cannot live without. Correcting both.

### Canonical model

```ts
// ─────────────────────────── IDs ───────────────────────────
type ProjectId = string;
type AssetId = string;
type TrackId = string;
type SegmentId = string;
type WordId = string;
type StyleId = string;
type AnimationId = string;
type JobId = string;

// ─────────────────────────── Media ──────────────────────────
type AssetRole = 'sourceVideo' | 'proxyVideo' | 'audio' | 'font' | 'thumbnail';

interface AssetRecord {
  id: AssetId;
  role: AssetRole;
  filename: string; // display name, NEVER used to build a path (§12)
  mimeType: string;
  byteSize: number;
  checksum?: string; // cache validation
  meta?: MediaMeta; // probe result, set once at ingest
  derivedFrom?: AssetId; // provenance chain
  transform?: string; // exact ffmpeg args, for reproducibility
}

interface MediaMeta {
  durationMs: number; // integer
  width?: number;
  height?: number;
  displayWidth?: number;
  displayHeight?: number; // after rotation
  rotation?: 0 | 90 | 180 | 270;
  frameRateNum?: number;
  frameRateDen?: number; // EXACT rational
  codec?: string;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
}

// ────────────────────── Style system ────────────────────────
interface Style {
  id: StyleId;
  name: string;
  // typography
  fontFamily: string; // registry key, not a system font name
  fontSizePx: number; // at project.canvas
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  fill: string; // '#RRGGBB' or '#RRGGBBAA'
  // stroke
  strokeColor?: string;
  strokeWidthPx?: number;
  // shadow
  shadowColor?: string;
  shadowOpacity?: number; // 0..1
  shadowBlurPx?: number;
  shadowOffsetXPx?: number;
  shadowOffsetYPx?: number;
  // text box  ⚠ see §7 — NOT natively renderable by libass
  backgroundColor?: string;
  backgroundOpacity?: number;
  paddingXPx?: number;
  paddingYPx?: number;
  // layout
  align: 'left' | 'center' | 'right';
  lineHeight: number; // multiplier
  letterSpacingPx?: number;
  // placement — normalized, resolution independent
  position?: NormalizedPosition; // 0..1 of the canvas
  // opacity — merged into transforms, NOT a separate field
  transforms?: TransformSpec[]; // ordered, composed
}

interface TransformSpec {
  property: 'opacity' | 'scale' | 'rotationDeg' | 'translateX' | 'translateY';
  value: number; // scale/translate normalized (0..1 of canvas);
  // opacity 0..1; rotation in degrees
}

interface NormalizedPosition {
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
}

/** Sparse: absent = inherit. Never a sentinel value. */
type StyleOverride = Partial<Omit<Style, 'id' | 'name' | 'transforms'>> & {
  transforms?: TransformSpec[]; // replaces, not merges — see invariant I-6
};
```

**Transforms as an ordered list** rather than a struct of named fields. Order is required
(rotate-then-translate ≠ translate-then-rotate) and a list is the representation both
DOM `transform` strings and ASS override tags are natively good at. It also gives
per-property animation a uniform target — `property` is already a discriminator.

**Opacity belongs in `transforms`.** A separate `opacity` field and a
`transforms[opacity]` entry would be two sources of truth for one visual fact.

**Position lives on the style, not duplicated on the track.** A track-level _position
adjustment_ is a translate transform, which is exactly what `transforms` is for. One
mechanism, not two.

**`extensions` removed.** A bag that is never populated and never read is a promise the code
doesn't keep. Forward compatibility is handled by `schemaVersion` + migrations (§5.4),
which is honest: migrations are written when the version actually changes. Unknown-key
preservation is achieved by a documented "migrate forward, or refuse" policy, not an
inert container.

```ts
// ──────────────────── Tracks / segments / words ──────────────
interface SubtitleTrack {
  id: TrackId;
  name: string;
  styleId?: StyleId; // undefined = inherit project default
  visible: boolean;
  locked: boolean;
  segments: SubtitleSegment[]; // sorted by startMs (§5.2)
}

interface SubtitleSegment {
  id: SegmentId;
  text: string; // CACHE of words — validated, drift-detectable
  startMs: number; // integer, authoritative
  endMs: number; // integer, > startMs
  lineBreaks?: number[]; // word indices at which a break is forced
  styleId?: StyleId; // full replacement
  styleOverride?: StyleOverride; // sparse deviation
  animationId?: AnimationId;
  words: SubtitleWord[]; // content source of truth
  origin: 'asr' | 'manual'; // re-transcription safety
  locked?: boolean; // protected from re-transcription
}

interface SubtitleWord {
  id: WordId;
  text: string; // may carry leading/trailing spaces
  startMs: number;
  endMs: number;
  confidence?: number; // absent ≠ 0
  timingSource: 'measured' | 'synthesized';
  styleOverride?: StyleOverride;
  animationId?: AnimationId;
}

// ───────────────────────── Animation ────────────────────────
interface AnimationDef {
  id: AnimationId;
  name: string;
  phase: 'in' | 'out' | 'inout';
  property: TransformSpec['property'];
  from: number;
  to: number;
  curve: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'spring';
  durationMs?: number; // absolute; else durationFraction × segment
  durationFraction?: number;
  staggerMs?: number; // per-word offset
}

// ──────────────────── Project document ──────────────────────
interface ProjectDocument {
  schemaVersion: number;
  id: ProjectId;
  name: string;
  createdAt: string; // ISO-8601
  updatedAt: string;

  canvas: { width: number; height: number }; // reference design resolution

  assets: AssetRecord[]; // videos, audio, and fonts alike
  tracks: SubtitleTrack[];
  styles: Record<StyleId, Style>;
  animations: Record<AnimationId, AnimationDef>;

  transcription?: {
    providerId: string;
    model?: string;
    language?: string;
    generatedAt: string;
  }; // provenance POINTER, never a transcript copy
}
```

**Why `transcription` is a pointer and not a stored transcript:** the words already live in
`segments[].words`. Storing a second copy invites divergence and doubles the document size.
What the pointer is genuinely for is _reproducibility_ — knowing that these words came from
`whisper-1` on a specific date, so re-running is a conscious act rather than an accident.

### 5.1 Invariants

| #        | Invariant                                                                                                                                                      | Enforced by                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **I-1**  | All times are **integer milliseconds**. No floats anywhere in the document.                                                                                    | Types + unit tests                                                |
| **I-2**  | `endMs > startMs` on every segment and word.                                                                                                                   | Validator                                                         |
| **I-3**  | Within a track, segments are **sorted by `startMs`** and **non-overlapping**.                                                                                  | Validator; timeline ops maintain it                               |
| **I-4**  | Every `styleId`/`animationId` reference resolves.                                                                                                              | Validator (dangling ref = hard error)                             |
| **I-5**  | Every entity has a **stable, unique ID**. Never an array index, never text content.                                                                            | ID factory + validator                                            |
| **I-6**  | `transforms` **replaces** on override (not merges). A partial transform list would be ambiguous to compose.                                                    | Resolver + tests                                                  |
| **I-7**  | Overrides are **sparse**; absent key = inherit. No sentinels (`""`, `-1`, `null`).                                                                             | Types (`Partial`)                                                 |
| **I-8**  | `segment.text` is a **cache**; it must equal `words.map(w => w.text).join('')` modulo line breaks.                                                             | `validateDocument()` reports drift rather than silently fixing it |
| **I-9**  | The document is **pure JSON** — no classes, no functions, no cycles, no `undefined` in required slots. Round-trips through `JSON.stringify`/`parse` unchanged. | Round-trip test                                                   |
| **I-10** | `confidence` absent ≠ `confidence: 0`.                                                                                                                         | Types + test                                                      |
| **I-11** | `timingSource: 'synthesized'` words are never presented as measured.                                                                                           | Data + UI                                                         |
| **I-12** | `fontFamily` must name an **existing font asset**. A missing font is a hard error at validation, not a silent system fallback (S-08).                          | Validator                                                         |
| **I-13** | `media.assets[]` is **append-only**; a segment never stores asset IDs. Assets are referenced by _role_.                                                        | Types                                                             |

**I-13 is the "aha" simplification.** Segments have no business knowing which file they came
from. Referencing by role (`sourceVideo`, `audio`, `font`) means swapping the source video or
changing the font file updates everything automatically, and no segment can ever point at a
deleted file.

### 5.2 Why no explicit `order` field on segments

I proposed `order: number` earlier. It's unnecessary: **array order is the order**, and I-3
ties it to `startMs`. Two orderings that can disagree is a bug generator. The array is
sorted; that is the single ordering.

### 5.3 Multi-track and layering

`tracks[]` with `visible` covers MVP and mid-term needs. Composition modes (multiply/screen),
track ordering/z-index, and per-track opacity live in the **effect/tier system (§5.5)**, not
as ad-hoc fields. Adding them as fields would mean a third place to change when compositing
arrives.

### 5.4 Versioning and migration

```ts
type Migration = (doc: unknown) => unknown;
const MIGRATIONS: Record<number, Migration> = {/* n → n+1 */};

export function migrate(raw: unknown): ProjectDocument; // pure
export function validateDocument(doc: unknown): ProjectDocument; // Zod + I-1…I-13
```

`migrate` is pure and table-driven, one test per step. A document from a **newer** version
fails loudly rather than loading partially — partial load of a subtitle document means
silently mangled timing, which is worse than refusal.

### 5.5 How the model absorbs future requirements

| Future need                          | How the current model absorbs it                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| Keyframe animation                   | `AnimationDef` becomes a union; resolver output unchanged                                    |
| Effects / compositing modes          | New `EffectSpec` list on track/segment, mirroring `TransformSpec`                            |
| Colour grading on subtitles          | New `TransformSpec.property` value (e.g. `saturation`)                                       |
| Per-line styling                     | Line break indices already exist as `lineBreaks`; lines gain a style reference               |
| Translation tracks                   | Already multiple tracks                                                                      |
| Beat-synced / audio-driven animation | New animation curve source; timeline model untouched                                         |
| Track templates / brand kits         | `styles`/`animations` are already named registries — a template is a partial registry export |

**The pattern:** the model has **named registries** (`styles`, `animations`) and
**typed extensible spec lists** (`transforms`), so new _kinds_ of thing are additive, while
new _entries_ in an existing kind are data. That is what "evolve over several years without
a rewrite" concretely means here.

---

## 6. Timing model

### Canonical representation: **integer milliseconds**

Considered and rejected:

| Option                                                    | Verdict                                                                                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Float seconds                                             | Rejected — `0.1 + 0.2` class errors accumulate; serializes as noise; frame math is approximate everywhere                                           |
| **Float frames**                                          | Rejected — non-integer frame rates (29.97) make frame values irrational-ish; a 10,000-frame timeline accumulates visible error                      |
| Rational microseconds (BigInt)                            | Rejected for _storage_ — correct but heavyweight; a BigInt in a hot loop and a 10× larger document buys precision we do not need at 1ms granularity |
| **Integer ms (canonical) + exact rational fps (context)** | **Chosen**                                                                                                                                          |

**Why integer ms is correct here:**

1. **Subtitle timing is authored in ms.** Nobody perceives a difference below ~16ms. Speech
   timing precision from ASR is ~10ms at best. Representing more is fake precision.
2. **It serializes exactly.** `JSON` has no integer/float distinction that would bite us;
   `1e3` vs `1000` round-trips identically as integers, and no float ever enters the model.
3. **Frame math is exact anyway** when fps is kept rational. The frames are a _derived,
   ephemeral_ quantity; they never persist (§6.3).
4. **Editing is delta-based.** Dragging an edge adds/subtracts integers. Repeated
   float add/subtract is the classic drift source; integer arithmetic is exact by
   construction, so a 10,000-operation editing session cannot drift at all.

**The one rule that makes this safe:** _frame rate is never a rounded number._ It is stored
as `frameRateNum`/`frameRateDen` and converted only at the boundary with `BigInt`.

### 6.1 Conversions

```ts
// Exact. All fps math in BigInt. Never a float.
function msToFrame(ms: number, num: number, den: number): number {
  return Number((BigInt(Math.round(ms)) * BigInt(den) * 1000n) / (BigInt(num) * 1000n));
}
function frameToMs(frame: number, num: number, den: number): number {
  return Number((BigInt(frame) * 1000n * BigInt(den)) / BigInt(num));
}
function msToTimecode(ms, num, den): string; // HH:MM:SS:FF
function msToAssTime(ms: number): string; // H:MM:SS.cc — ASS is centiseconds
function msToSrtTime(ms: number): string; // HH:MM:SS,mmm
```

**ASS is centiseconds.** This is an unavoidable lossy export step: millisecond timing
truncates to 10ms on export. At 1ms authoring granularity that is imperceptible (sub-frame
at 30fps), but it must be a _known, documented_ loss rather than a surprise — a segment
starting at 1045ms exports as 1.04s. Truncation, not rounding, and consistent so ordering
is preserved.

### 6.2 Worked examples

**30 FPS** (`30/1`)

| Frame        | Calculation         | Stored ms |
| ------------ | ------------------- | --------- |
| 0            | `0`                 | 0         |
| 1            | `1000/30` = 33.3333 | **33**    |
| 2            | `2000/30` = 66.6667 | **67**    |
| 30           | `30000/30` = 1000   | 1000      |
| 1800 (1 min) | 60,000              | 60,000    |

⚠ Frames 1 and 2 are **not** exactly 2× each other (33 vs 67) — frame duration is 33.33ms
and ms is the coarser unit. This is inherent to ms-based storage, and it is precisely why the
video element, not the ms model, is the playback clock (§6.4).

**29.97 FPS** — the trap. NTSC is `30000/1001` = **29.97002997…**

⚠ **Never store `29.97`.** Store `num=30000, den=1001`.

| Frame         | Exact (30000/1001) | Stored ms  |
| ------------- | ------------------ | ---------- |
| 1             | 33.3667            | **33**     |
| 2             | 66.7333            | **67**     |
| 30            | 1001.0             | **1001**   |
| 1,800 (1 min) | 60,060.0           | **60,060** |

Note frame 30 is **1001ms**, not 1000ms — a 1ms difference per second of video, and a
visible, growing error if the frame count is ever confused with seconds.

**The two distinct 29.97 bugs** (verified numerically; they are often confused):

| Bug                                           | Error over 1 hour | Severity                                                                                                                               |
| --------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **A.** Using `29.97` in ms↔frame _conversion_ | **3.6 ms**        | Negligible. Honest correction to an earlier draft of this document, which overstated this as "~3 seconds/hour" — that figure was wrong |
| **B.** Assuming **30fps** on a 29.97 source   | **3.6 seconds**   | **Severe.** 1h: exact 3,599,996ms vs. assumed 3,596,400ms                                                                              |

So the real risk is **not** rounding the constant in a conversion — it is losing the
denominator entirely and treating 29.97 as 30. This is exactly why `frameRateNum/Den` is
stored as a **pair** and never collapsed to a single number: keeping the pair makes bug B
impossible, and costs nothing.

**60 FPS** (`60/1`)

| Frame         | Calculation         | Stored ms |
| ------------- | ------------------- | --------- |
| 1             | `1000/60` = 16.6667 | **17**    |
| 2             | 33.3333             | **33**    |
| 30            | 500                 | 500       |
| 3,600 (1 min) | 60,000              | 60,000    |

### 6.3 The anti-float rule

> **`frame` is derived and ephemeral. It is never stored in the document.**

Store ms. Compute frames at the moment of display or export, via the exact rational
converters above. This eliminates the entire class of "frame value drifted" bugs, because no
frame value survives longer than the function call that produced it.

### 6.4 Video time is float; our model is not

`video.currentTime` returns a float in seconds. The single conversion point:

```ts
// rAF loop — the ONLY place video time enters the app
const tMs = Math.round(video.currentTime * 1000);
```

`Math.round` (not `floor`) keeps the reported position within half a millisecond of truth and
never accumulates, because it derives from the element's own time each frame rather than
adding deltas. `video.currentTime` itself is re-read every frame, so any internal
imprecision in the browser's clock is corrected continuously rather than integrated.

**Two clocks, one authority.** The video element is the clock; the ms model mirrors it. There
is no independent timer anywhere in the application.

---

## 7. Preview vs. export parity

### The mechanism

```
        ProjectDocument  ──┐
                           │
        src/core/resolve ──┼──► ResolvedStyle  ──► render-dom  ──► <div> in browser
              (PURE)      │         (total)         (browser)
                           │
                           └──► ResolvedStyle  ──► render-ass   ──► .ass string
                                                     (pure)              │
                                                                          ▼
                                                        ffmpeg -vf subtitles=…ass
```

Both renderers receive an **identical, fully-populated** value. Neither inspects the document.
Neither branches on "is this inherited?" (that decision is already paid for, once, in
`resolveStyle`). A renderer cannot silently disagree with the document, because it never sees
the document.

### The anti-drift policy — the important part

> **When preview and export disagree, the fix goes in `core` (shared constants, shared
> normalization) or in `render-dom` (emulating a libass quirk). It is NEVER made by editing
> the document, and NEVER by accepting a known difference silently.**

The tempting failure mode is to accept "shadow blur is close enough" and let the gap
accumulate across 30 properties until the export is visibly different. Every difference is
either _fixed_ or _declared_ in the matrix below — never tacit.

### Compatibility matrix (honest, not aspirational)

| Property                  | Browser (DOM/CSS)            | libass / ASS                        | Exact parity?                     | Notes                                                                                                                                    |
| ------------------------- | ---------------------------- | ----------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Font family               | `@font-face`                 | `fontsdir` + font resolution        | **Yes, if the same file is used** | Requires an explicit font asset (I-12); system-font-name styling _cannot_ match                                                          |
| Font size                 | `px`                         | `\fs` (script resolution units)     | **Yes**, with a scale factor      | ASS sizes are relative to `PlayResY`; the scale factor must be exact                                                                     |
| Font weight               | `font-weight`                | `\b` (bold toggle)                  | ⚠ **Partial**                     | ASS has boolean bold, not numeric weight 100–900. Only 400/700 (or bold on/off) is portable                                              |
| Font style (italic)       | `font-style`                 | `\i`                                | **Yes**                           | Binary in both                                                                                                                           |
| Fill colour               | `color`                      | `\c&HBBGGRR&`                       | **Yes**                           | Note the **BBGGRR** byte order in ASS — a real bug source                                                                                |
| Fill opacity              | `rgba()`                     | `\1a` (alpha)                       | **Yes**                           | 0–255, linear                                                                                                                            |
| Stroke colour             | `-webkit-text-stroke`        | `\3c`                               | **Yes**                           |                                                                                                                                          |
| Stroke width              | `text-stroke-width`          | `\3a`                               | ⚠ **Partial**                     | ASS `\3a` is an _outline expansion_ in scaled units; not identical to CSS stroke width. Empirically close; needs a calibration constant  |
| Shadow                    | `text-shadow`                | `\4c`, `\3c`, `\3a`, `\3o` (border) | ⚠ **Partial**                     | libass shadow ≈ offset border, not a true Gaussian blur. `shadowBlurPx` is **not** representable                                         |
| **Background box**        | CSS `background` + `padding` | **none**                            | ❌ **No**                         | libass has no background primitive. This is a **style-model error**, resolved in §7.1                                                    |
| **Border radius**         | CSS `border-radius`          | **none**                            | ❌ **No**                         | Same root cause as background                                                                                                            |
| Padding                   | CSS `padding`                | `\xbord` (border scale)             | ⚠ **Partial**                     | Only as a border-equivalent                                                                                                              |
| Text alignment            | `text-align`                 | `\an`, `\a`                         | **Yes**                           | 3×3 grid, maps cleanly                                                                                                                   |
| Line height               | `line-height`                | `\fs` + `\fsp` (spacing)            | ⚠ **Partial**                     | `\fsp` is _between-character_ spacing, not CSS line-height. Multi-line spacing needs a measured translation                              |
| Letter spacing            | `letter-spacing`             | `\fsp`                              | ⚠ **Partial**                     | **Direct conflict with line height** — both map toward `\fsp`. Must pick one meaning                                                     |
| Position (normalized)     | `left/top` %                 | `{\an}` + `\pos()`                  | ⚠ **Partial**                     | ASS anchoring is _complex_; normalised DOM anchoring and ASS alignment/margins do not correspond 1:1. Needs a documented, tested mapping |
| Scale                     | CSS `scale()`                | `\fscx/\fscy`                       | **Yes**                           |                                                                                                                                          |
| Rotation                  | CSS `rotate()`               | `\frz` (z-rotation)                 | **Yes**                           | z-axis only; matches CSS 2D rotate                                                                                                       |
| Opacity                   | `opacity`                    | `\1a`                               | **Yes**                           |                                                                                                                                          |
| Translate X/Y             | `translate()`                | `\move` / `\an`                     | **Yes**                           |                                                                                                                                          |
| Animation — opacity       | CSS/WAAPI                    | `\fad(in,out)`                      | **Yes**                           |                                                                                                                                          |
| Animation — scale         | CSS `transform`              | `\t(...)` with `\fscx/\fscy`        | **Yes**                           |                                                                                                                                          |
| Animation — translate     | CSS `translate`              | `\move` or `\t(\org)`               | **Yes**                           |                                                                                                                                          |
| Animation — spring/bounce | cubic-bezier approximation   | `\t` with limited interpolation     | ❌ **No**                         | ASS has no spring. Preview would be strictly better; **must be declared**                                                                |
| Line breaks               | algorithm                    | algorithm                           | ⚠ **Needs one implementation**    | See §7.2 — the browser must _not_ re-wrap text                                                                                           |
| Per-word styling          | `<span>` per word            | `\t` with override tags             | **Yes**                           |                                                                                                                                          |
| Per-segment overrides     | computed style               | per-event override tags             | **Yes**                           |                                                                                                                                          |

**Summary of the honest position:** exact parity on roughly half the properties. Partial on
another third (needing calibration constants and tested mappings). Genuinely impossible on
three: background box, border radius, and spring/bounce curves.

### 7.1 Resolved: background box and border radius are removed from the style model

I originally specified `backgroundColor`, `backgroundOpacity`, `paddingXPx/Y`, and
`borderRadiusPx` as MVP style properties, and simultaneously claimed WYSIWYG. **Those two
positions are incompatible** — libass cannot render a background box at all, so a user styling
a background would get a beautiful preview and no background in the export. That is the exact
failure the architecture exists to prevent, and my original model would have shipped it.

**Decision: remove the text-box background from the MVP style model.** Since the first
implementation is builtin, this costs nothing — there is no legacy data to migrate, and the
control is removed before it can mislead anyone.

How background is supported **later**, without parity loss:

> **A box IS a stroke.** libass renders borders, and a sufficiently thick border around
> opaque text is visually a filled box. So the extension is a _derived_ style, not a new
> primitive:
>
> 1. **Approximation** — render a "box" style as a thick same-colour stroke. Works in both
>    renderers, keeps parity, costs a hard edge. Good enough for the common "black box"
>    caption style, which is the actual popular use case.
> 2. **Full parity (Phase 13+)** — composite the box separately: generate a second ASS track
>    (`[V4+ Styles]` border style) or a transparent overlay video, then stack. Both are
>    FFmpeg-side and cost no model change.

Rounded corners specifically: only achievable by a real overlay composite, never by a single
ASS event. That is a Phase 13+ feature, honestly labelled.

**`padding`** survives as a _concept_ (`\xbord`) but is documented as a border-equivalent, not
CSS padding.

### 7.2 Letter spacing vs. line height: one meaning, forced

Both map toward ASS `\fsp`, and they genuinely conflict. The resolution is a documented
**product** decision, not an implementation detail: **when line height is non-default, it is
authored as an explicit multiple and translated to `\fsp`-adjacent spacing by a shared,
tested function.** The document keeps two independent fields (they are different user
concepts), but the resolver emits one normalized value and both renderers consume _that_.

The rule that prevents drift: **neither renderer performs its own line layout.** Text wrapping
happens **once**, in `src/core` (headless, dependency-injected measurer), producing an
explicit `ResolvedLine[]`. The browser positions lines; libass receives pre-broken lines. If
the browser re-wrapped text, every wrapping difference would become a parity bug forever.

This is the most valuable single decision in the parity section.

### 7.3 How drift is prevented mechanically

1. **Shared resolver** — one implementation, two runtimes.
2. **Pre-computed layout** — wrapping is done once, in `core`.
3. **Parity fixture tests in CI** — a fixture document is rendered by `render-dom` (headless
   screenshot) and by `render-ass` → ffmpeg (frame grab); the two are compared per property
   with per-property tolerances. **A property in the matrix marked "partial" has a declared
   numeric tolerance; anything exceeding it fails the build.**
4. **The matrix is a versioned artifact** — it is a table in this document that tests read,
   so it cannot silently rot out of date.

---

## 8. Style resolution review

**The four-level cascade is correct** — project default → track → segment → word. It is the
right shape because each level corresponds to a real user intent ("set the look for this
project", "this track is a translation in a different language", "this one line needs
emphasis").

### Refinements to how it works

**Named style vs. override must be cleanly separated.** A segment picks _one_:

- `styleId` → replaces the whole style (inherit-from-named-style, and THAT named style
  inherits from its own parent via the track chain), or
- `styleOverride` → sparse deviations from whatever the chain resolved to.

Mixing them is a bug source, so the rule is: **`styleId` and `styleOverride` are mutually
exclusive on a single entity.** Setting both is a validation error (I-14, added below).
The alternative — merging a named style _and_ an override — needs "does the override beat
the named style or its parent?" answered, and the answer is almost never what a user wants.

**Resolution is two functions, not one:**

```ts
resolveStyle(styles, id): Style                                   // registry → concrete
resolveEffective(base: Style, ...overrides: StyleOverride[]): ResolvedStyle  // merge → total
```

`ResolvedStyle` is **fully populated** (no optionals) — the renderer's type system then makes
it impossible to forget a property or branch on inheritance.

**Why purity and determinism are non-negotiable:**

- _Purity_ is what lets the same function run in a React render, a Node worker, and a Vitest
  assertion. A single hidden dependency (a module-level cache, a font-measurement singleton)
  silently breaks one of the three.
- _Determinism_ is what makes the parity fixture tests meaningful — same input, same output,
  every run, or the comparison proves nothing.
- Both make the resolver trivially **memoizable**, which is what keeps a 60fps preview
  affordable.

### Invariants

| #        | Invariant                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------- |
| **I-6**  | `transforms` **replaces** on override; it does not merge. Merging an ordered list is ambiguous. |
| **I-7**  | Overrides are sparse; absent = inherit; no sentinel values.                                     |
| **I-14** | `styleId` and `styleOverride` are mutually exclusive on one entity.                             |
| **I-15** | `resolveStyle` is pure: no I/O, no globals, no mutation of inputs, no `Date.now()`.             |
| **I-16** | Same inputs ⇒ byte-identical output, across processes and runs.                                 |
| **I-17** | `ResolvedStyle` is total — every property present, no `undefined`.                              |
| **I-18** | The resolver never inspects the media, the DOM, or the renderer's capabilities.                 |

**I-18 matters more than it looks.** A resolver that took "does libass support background
boxes?" as an input would be one `if` away from the document changing shape depending on
which backend is asking. Capability handling belongs at the _renderer_ boundary — a renderer
declares what it supports and reports a gap (X-08), rather than the model bending per
backend.

### 8.1 Two invariants added by the product/UX pass

These were not in the original review. They came from asking "does this model survive the
editing interactions we actually want?" (`PRODUCT.md` §17) rather than "is the model tidy?"

| #        | Invariant                                                                                                                                                                                                             | Enforced by              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **I-19** | **Animation overrides the static `transforms` entry for the same `property`, for the duration of the animation.** Animation is applied _after_ style resolution, and static values resume after the animation window. | Resolver + tests         |
| **I-20** | **Every document mutation — including those originating in a worker — enters through `src/core/ops` as a labelled op.** The client never adopts a server-produced document wholesale.                                 | Architecture rule + test |

**Why I-19 was a genuine gap.** The model has a static `transforms` list on the style _and_
an animation that animates a `transform` property. If a caption is authored with `scale: 0.9`
and also has a pop-in animation on `scale`, the two collide — and the original model did not
say which wins. Left undefined, this becomes a Phase 10 bug that presents as
nondeterminism ("why is this caption 0.9 sometimes?"). The rule is simple and total:
**animation wins for its property, for its window; static values resume after.** It also
fixes the resolver's ordering: `resolveAnimation` runs _last_, after the cascade.

**Why I-20 matters, concretely.** Transcription runs in a worker, which writes segments into
`project.json`. If the client then _replaces_ its document with the server's, two things
break:

1. The undo stack holds snapshots of a document that no longer exists — undo becomes
   incoherent.
2. "Transcription produced 47 segments" — the single largest change in the document — has no
   undo entry, so `Ctrl+Z` after the first manual edit cannot get back to the
   pre-transcription state.

The fix costs nothing and preserves the single-mutation-home rule: the worker returns a
**transcript result** (not a document), and the client applies it as a single labelled op
(`applyTranscript`). Same for a render job — the render result is a file, and the document is
touched only if a deliberate op says so. **The client is the only writer of the document;
the server is a source of results.**

This is the single most valuable finding of the product/UX pass, because it is invisible
until someone has manually edited a caption and then pressed undo.

### 8.2 Op-level rules the interaction model requires

Not model changes — precise semantics for the ops in `src/core/ops`, decided now so they
are not invented inconsistently in Phase 6.

| Op                                  | Rule                                                                                                                                           | Why                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `moveSegment(id, deltaMs)`          | Shifts `startMs` **and** `endMs`. Duration is preserved                                                                                        | Dragging a caption body moves it; it must not silently retime it (`PRODUCT.md` §17B) |
| `retimeSegment(id, edge, newMs)`    | Moves one boundary only; clamps to `> startMs` / `< endMs`; clamps words to the new bounds                                                     | Edge-drag is retiming, not moving                                                    |
| `splitSegment(id, atMs)`            | Splits at the nearest **word boundary**, never mid-word. Recomputes both halves' `text` from their words (I-8)                                 | Mid-word splits are always wrong; the text cache must be rebuilt, not sliced         |
| `mergeSegments(a, b)`               | Same track only. `start = a.start`, `end = b.end`. **If a gap exists, the merged segment displays during the gap** — confirm before committing | Merging across a gap re-introduces a gap the user did not ask for                    |
| `setStyleOverride`                  | Sparse merge; `transforms` **replaces** (I-6)                                                                                                  | Per I-6                                                                              |
| `applyStyleToSelection(ids, style)` | Bulk; one op, one undo entry                                                                                                                   | "Make these 20 look like that one" (`PRODUCT.md` §17C)                               |
| `applyTranscript(result)`           | Creates segments; **one op, one undo entry**; respects per-segment `locked`                                                                    | I-20; re-transcription safety                                                        |

**Batching rule, extended.** The "a drag is one undo entry" rule also applies to **typing**:
a burst of keystrokes is one entry, debounced — not one per character. Otherwise editing text
while the video plays floods the history and evicts everything useful. This is a hard
requirement of the interaction model, not an optimization.

---

## 9. Undo/redo — reconsidered

**I was wrong to defer this to Phase 9.**

My original reasoning was that mutations already funnel through pure functions, so extraction
later is "cheap." That reasoning was weak. The actual cost of late undo is not the diffing
mechanism — it is that **once a UI exists, every feature author starts writing imperative
side-effects** (`applyStyle()` in a component, a direct array push in an event handler). By
Phase 9 there are dozens of mutation sites, and retrofitting history means auditing all of
them. The cheap moment is **now, while the rule is "all mutations go through core ops" and
there are zero counterexamples to enforce.**

And the Phase 6 note I wrote was self-contradictory: I accepted shipping a timeline where
dragging destroys work, then deferred the fix. That is a real product defect, not a
pragmatic trade.

### Final decision: **undo/redo architecture lands in Phase 0, with the timeline (Phase 6)**

Not "a history panel with buttons" — the _architecture_, which is cheap:

```ts
interface Op {  label: string; apply(doc: ProjectDocument): ProjectDocument; }
undoStack: Op[];  redoStack: Op[];
```

Every mutation in `core` is expressed as a **pure, labelled operation**. Properties:

- **Pure** — `(doc) => doc'`, never mutate in place. Undo is trivially reliable.
- **Structurally shared where cheap** — the document is JSON; at MVP scale (30s–1min ⇒
  tens–hundreds of segments) full snapshots are simple and fast. Shallow-clone only the
  touched path.
- **Labelled** — enabling the UI later is purely additive, and the labels are the undo menu text.
- **Batched** — a drag is one op from pointerdown to pointerup, not 200. Without batching,
  a single drag pollutes the entire history.

**Enforcement (the part that makes it stick):** a test asserting that no module outside
`src/core/ops` exports a document-mutating function. Mutations have exactly one home, and
undo/redo therefore cannot be forgotten by a new feature.

**In Phase 6:** `Ctrl+Z` / `Ctrl+Shift+Z` plus a small history list. In Phase 9: the polished
history UI. The hard part is done in Phase 0; later phases are UI.

---

## 10. Media file handling

### Storage: the simplest thing that is actually correct

**Local filesystem, keyed by asset ID, never by filename.**

```
workspace/
├── projects/
│   └── <projectId>/
│       ├── project.json            # the document (source of truth)
│       └── media/
│           ├── <assetId>/source.mp4        # original, untouched
│           ├── <assetId>/proxy.mp4         # derived
│           ├── <assetId>/audio.wav         # derived
│           └── <fontAssetId>/Inter-Bold.ttf
└── tmp/                            # job scratch space, GC'd
```

**Why this rather than alternatives:**

| Alternative                    | Why not                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Store bytes in the document    | Documents must stay small, diffable, and `JSON.parse`-able                                                                                 |
| Store bytes in Postgres        | No DB in scope; adds ops for no benefit (§D-3)                                                                                             |
| Filename-keyed files           | Collision, traversal, encoding, and case-collision hazards. **Asset ID is generated by us and is the only safe key**                       |
| Content-addressed (hash) names | Elegant, but adds a hashing layer and orphan-GC complexity before it's needed                                                              |
| Object storage (S3)            | Correct _later_; requires an auth story we're not building. Storage sits behind an interface so it can be swapped without touching callers |

**The original file is never modified, moved, or overwritten.** Every artifact is derived,
recorded with `derivedFrom` and the exact `transform` string, and rebuildable.

### Upload flow

1. Client: `POST /api/projects/:id/assets` with the file as a **streamed body**.
2. Server: generate `assetId` up front, write to `media/<assetId>/source.<ext>` via a
   write stream. **Never `formData()`, never `Buffer.concat`.**
3. Return `202` + `{ assetId }` immediately; enqueue an `ingest` job.
4. Worker: `ffprobe` → `MediaMeta` → write back into `project.json` → emit SSE progress.
5. Client fetches `/media/<assetId>/source.mp4` for playback (HTTP Range).

**Why the ID is minted before the upload:** it is the only safe destination path, and it
means a failed upload leaves an empty, GC-able directory rather than a half-named file.

### Lifecycle, cleanup, failure

- **Orphan GC:** directories under `media/` with no matching `AssetRecord` in
  `project.json` are swept on startup and after job failure. Interrupted uploads leave
  empty dirs and are collected.
- **Job scratch:** all FFmpeg output goes to `tmp/`, moved into `media/` only on success.
  A cancelled job never leaves a half-written artifact in the media tree.
- **Failure:** the job records a typed error; the original upload is **retained** (a probe
  failure is fixable by re-probing; deleting the user's file is not). Derived artifacts are
  deleted.
- **Checksum:** recorded on the asset, used to validate cached derivatives.

---

## 11. Job model

### Lifecycle

```
queued ──▶ processing ──┬──▶ completed
                        ├──▶ failed        (typed error, retryable flag)
                        └──▶ cancelled
```

Six states, with `cancelled` reachable from `queued` or `processing`. `completed` and
`failed` are terminal.

### Job types

| Kind              | Worker action                              | Notes                                                                                  |
| ----------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `ingest`          | `ffprobe` → `MediaMeta`                    | Trivial, but a job from day one — establishes the pattern before there's anything slow |
| `extract-audio`   | ffmpeg → 16kHz mono WAV                    | CPU-bound                                                                              |
| `transcode-proxy` | ffmpeg → H.264 faststart                   | Phase 13; **API reserved now** so a second media job needs no new machinery            |
| `transcribe`      | `TranscriptionProvider` + `segmentWords()` | The long one                                                                           |
| `export`          | `render-ass` + ffmpeg                      | The longest                                                                            |

Five kinds. Note that `transcode-proxy` exists in the enum from Phase 3 despite arriving in
Phase 13 — a second CPU-bound media job with no new code path.

**Deliberately minimal.** No priority, no queue-within-queue, no scheduled jobs, no
dependency graph between jobs, no retry policy beyond a `retryable` flag on the error. Those
are added when a real need appears, and each is a change to `JobRecord`, not a redesign.

**Where it lives:** server-side runtime state, stored per-project and **outside
`ProjectDocument`**. A document loaded from disk never carries a stale `rendering…` job.
Jobs are rehydrated by the server, not by the client.

**Progress:** FFmpeg `-progress pipe:1`, parsed; SSE to the browser. The worker and the API
are different threads, so SSE (server→client push) is the correct direction — the client
never needs to talk to a worker directly.

---

## 12. Security and validation

Auth is out of scope. These are not auth features; they are **the minimum required to safely
execute untrusted bytes with a subprocess that parses untrusted formats.** FFmpeg is a large
native attack surface and untrusted media is exactly its threat model.

| #        | Threat                       | Control                                                                                                                                                                                                                                                                                                                            |
| -------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S-1**  | **Path traversal**           | Asset paths are **derived from server-generated `assetId`** only. The client never supplies a path. `assetId` is validated against `/^[A-Za-z0-9_-]{1,64}$/` before use. A stored `filename` is **display metadata only** and is never joined into a filesystem path. This is why S-2 and S-3 are non-negotiable, not nice-to-have |
| **S-2**  | **Filename sanitization**    | Stored original name is stripped of path separators, `..`, control chars, null bytes, and length-capped. Used for display and for `Content-Disposition`. The on-disk name is `source<ext>` where `ext` is allow-listed                                                                                                             |
| **S-3**  | **Extension allow-list**     | Container/container-derived extension allow-list (mp4, mov, webm, mkv, m4v, wav, mp3, m4a, ttf, otf, woff2). An unknown extension ⇒ reject, do not pass through                                                                                                                                                                    |
| **S-4**  | **File size limit**          | Hard cap on upload bytes and on probe-reported duration. Enforced _during streaming_ (abort the stream), not after buffering                                                                                                                                                                                                       |
| **S-5**  | **FFmpeg argument safety**   | Every FFmpeg invocation uses `execFile`/`spawn` with an **argv array — never a shell string**. User-controlled values (paths) are never interpolated into command text. Media URLs passed to ffmpeg are plain local paths. The input path is always absolute and under `workspace/`                                                |
| **S-6**  | **Timeout + kill**           | Every FFmpeg process has a wall-clock timeout and an `AbortSignal`; `SIGTERM`, then `SIGKILL` after a grace period. A pathological input cannot pin a worker forever                                                                                                                                                               |
| **S-7**  | **Protocol allow-list**      | Any URL ffmpeg is asked to open must be `file:` under `workspace/`. `http:`, `https:`, `concat:`, `subfile:`, and friends are rejected — otherwise a crafted "video" can make FFmpeg fetch remote URLs or read arbitrary local files                                                                                               |
| **S-8**  | **Temp file cleanup**        | `tmp/` swept on startup and after every job. On crash, the next startup sweeps by mtime                                                                                                                                                                                                                                            |
| **S-9**  | **Malformed media**          | `ffprobe` failure ⇒ typed job error, no crash, original retained. A probe result is never trusted as validated input to later stages                                                                                                                                                                                               |
| **S-10** | **Resource isolation**       | Jobs run with `-nostdin` and a memory ceiling. No Docker available, so isolation is a worker thread + process — adequate at this scale, documented as a limitation                                                                                                                                                                 |
| **S-11** | **Document validation**      | Zod + invariant validator (I-1…I-14) on every **read**. Untrusted JSON (a file on disk) must not reach the editor unvalidated. Load, validate, _then_ use                                                                                                                                                                          |
| **S-12** | **Request rate/size limits** | Body size cap at the server, and job-concurrency cap, so uploads and renders cannot exhaust the box                                                                                                                                                                                                                                |
| **S-13** | **XSS**                      | Subtitle text is rendered as **text content**, never `dangerouslySetInnerHTML`, in both the preview and the editor. Subtitle text is attacker-controlled data (it comes from a video's audio, or a pasted file)                                                                                                                    |
| **S-14** | **Binding**                  | Server binds `127.0.0.1` only. No authentication means it must not be exposed to a network — a deliberate, documented constraint rather than an oversight                                                                                                                                                                          |

**The framing worth recording:** every one of these is triggered by _the feature itself_
handling untrusted media. None is an auth feature. They are not optional polish for a
"serious" app — a subtitle editor that shells out to FFmpeg with a user-supplied path is the
canonical local file-inclusion / command-injection target.

---

## 13. Phase order review

### Problems with my original 16 phases

1. **A "Phase 15 — Testing" was a cleanup phase.** Tests cannot be a phase; they are a
   property of every phase, with exit criteria in each.
2. **Fragmentation into 4 packages up front** (§2), inflating Phase 0.
3. **Undo/redo deferred past the timeline** (§9) — a shipped defect I should not have planned.
4. **Phases were technology-shaped, not outcome-shaped.** "Advanced Styling" and "Word-Level
   Timing" are feature buckets, not engineering steps.
5. **The list obscured a real dependency:** a player/transport must exist _before_ the
   timeline, and the style resolver must exist _before_ the inspector, and export must exist
   _before_ advanced styling. My original ordering had export as Phase 8 with advanced styling
   at 10 — correct — but the reasoning wasn't visible in the phase list itself.

### Final phase order

Eleven phases (0–10). Each has an engineering purpose, and none is "cleanup."

---

**Phase 0 — Foundation** · _deps: none_
**Goal:** a pure, tested core that every later phase builds on; boundaries enforced by CI.
**Why it exists:** the style resolver, timing model, and undo/redo architecture are the three
things that become expensive to retrofit. They must exist before any UI, and they need no UI
to be correct.
**Scope:** TS strict; `src/core` with IDs, `time.ts` (exact-rational), document types, Zod
schema, invariant validator, migrations, `resolveStyle` (total + pure), `segmentWords`,
`splitSegment`/`mergeSegments`, and **undo/redo as a pure op-stack**. ESLint + a test
asserting `core` imports no `react`/`node:fs`/`child_process`. Vitest.
**Exit:** build + tests green; cascade correct across 4 levels; ms↔frame exact for
30/29.97/60; migration identity at v1; no non-pure function in the op set; the boundary test
passes.
**NOT included:** any UI, any HTTP, any FFmpeg, any package split.

---

**Phase 1 — Ingest & Project Persistence** · _deps: 0_
**Goal:** a video on disk, probed, in a saveable project.
**Why it exists:** proves the streaming-upload design and gives every later phase a real
project to operate on. Buffering here poisons everything downstream.
**Scope:** Fastify; project CRUD; streamed upload (S-1…S-4); `ffprobe` → `MediaMeta`; Zod
validation on save _and_ load; `/media` endpoint with Range support.
**Exit:** 2GB file uploads with measured flat RSS; save→reload→deep-equal; a corrupted
document yields a readable error, not a stack trace; 90° rotation probed correctly; traversal
attempt via a crafted filename is rejected.
**NOT included:** playback UI, timeline, transcode, waveform, resumable upload.

---

**Phase 2 — Playback & Time Base** · _deps: 1_
**Goal:** video plays; the app has exactly one clock.
**Why it exists:** the video element is the time authority. Every timestamp, the timeline,
and export all depend on the fact that app time _is_ video time.
**Scope:** `<video>` wiring; `playbackStore`; rAF loop reading `currentTime` (the single
`Math.round(t*1000)` conversion point); `timeToFrame`/`frameToTime`; frame-step with
`requestVideoFrameCallback`; minimal transport UI.
**Exit:** 60s playback with zero drift from the video clock; frame step exact at 29.97 and
30; a test that the 1-hour 29.97 drift does not occur.
**NOT included:** the timeline, any subtitle UI, waveforms, audio mixing.

---

**Phase 3 — Audio Extraction & Job Infrastructure** · _deps: 1_
**Goal:** the job system, and a normalized audio track.
**Why it exists:** jobs are the substrate for extraction, transcription, and export. Building
the pattern on a 5-second job (cheap to iterate) rather than a 5-minute one is deliberate.
**Scope:** `JobRecord` + lifecycle; worker-thread runner; FFmpeg wrapper (`-progress`,
`AbortSignal` → `SIGTERM`→`SIGKILL`, argv-only); `extract-audio` → 16kHz mono WAV; job API +
SSE; `tmp/` GC.
**Exit:** extraction under realtime with monotonic progress; cancel leaves no orphan process;
a non-media file produces a typed error; extracted duration matches within one audio frame.
**NOT included:** transcription, proxy transcode, waveform display, retry policy, job queue
depth control.

---

**Phase 4 — Transcription** · _deps: 3_
**Goal:** normalized words on the document, via a swappable provider.
**Why it exists:** the provider interface must exist before any provider, so that swapping is
a registry change.
**Scope:** `TranscriptionProvider` + registry + **normalizer** (Layer 2, §4); one hosted
provider; `transcribe` job; `providerId`/`model` recorded; `synthesized` marking for
word-timing-less providers.
**Exit:** a 60s clip yields ordered non-overlapping words with plausible durations; swapping
providers is a one-file change with zero edits elsewhere; missing API key fails before work
starts; no-word-timing provider yields `synthesized` units, verifiably marked.
**NOT included:** local Whisper, translation, re-transcription UX, confidence UI.

---

**Phase 5 — Subtitle Model & Segmented Document** · _deps: 4_
**Goal:** readable, well-timed segments in a persisted document.
**Why it exists:** the ASR word stream is unreadable. Segmentation is where transcription
becomes subtitles, and where perceived quality is won or lost.
**Scope:** `segmentWords()` (line length, max lines, reading speed, word-boundary breaks);
`lineBreaks`; invariant validator; the transcribe job now writes segments into
`project.json`; segment list UI (deliberately **not** a timeline).
**Exit:** real-transcript fixture produces readable lines within the reading-speed cap or
explicitly flagged; validator catches overlap and zero-length; `text`↔`words` round-trips
exactly; segment list survives save/reload.
**NOT included:** the timeline, styling, reflow-on-edit, clever segmentation.

---

**Phase 6 — Timeline Editor + Undo/Redo** · _deps: 2, 5_
**Goal:** a real timeline, and the ability to undo a mistake on it.
**Why it exists:** timing correction is the core editing act — and per §9, a timeline without
undo is a defect, so both land together.
**Scope:** `timelineStore` (ephemeral); segment bars from ms; click/shift/marquee select;
drag to move, drag edges to resize; snapping (frame + word); `splitSegment` at a word
boundary; `mergeSegments`; playhead + scrub synced to the video; `Ctrl+Z`/`Ctrl+Shift+Z`;
one-track only.
**Exit:** drag/retime/split/merge all correct; split is word-exact and merge is its exact
inverse; snapping engages; undo/redo covers every operation, verified per-op; 500-segment
project scrolls and drags smoothly; no document state in UI stores.
**NOT included:** multi-track, word lanes, auto-scroll, track headers, advanced shortcuts.

---

**Phase 7 — Styling & Live Preview** · _deps: 6_
**Goal:** styled subtitles rendering over the video, via the shared resolver.
**Why it exists:** proves the resolver in a real runtime and makes the product legible.
**Scope:** built-in default style + MVP properties (no background box — §7.1);
`render-dom` preview overlay; normalized position + safe-area presets; in-place text editing
over the video; track-level style inspector editing by ID; font registry plumbing.
**Exit:** live style update during playback; track style change updates all segments at once;
a segment override changes one; `resolveStyle` cascade tests pass; the same style at 720p and
1080p yields the same relative placement.
**NOT included:** animation, effects, per-word overrides, font upload UI, export.

---

**Phase 8 — Export & Renderer Parity** · _deps: 7_
**Goal:** burned-in video, and _proof_ the preview matches it.
**Why it exists:** this is the product's core promise and its biggest risk. Export before
advanced styling, so a non-expressible style is discovered while the style model is still
small enough to fix cheaply.
**Scope:** `render-ass` (pure `ProjectDocument → .ass`); ASS mapping for the MVP property
set including the `\pos`/`{\an}` anchor mapping; export job from the **source** video; SRT +
VTT; parity fixture harness (DOM screenshot vs. ffmpeg frame grab, per-property tolerances);
`resolveAnimation` as an honest identity stub.
**Exit:** 60s clip exports a playable MP4 with burned-in subtitles; SRT re-import reproduces
text and timings; **parity harness green** — every property in the matrix within its declared
tolerance; export reports progress and is cancellable.
**NOT included:** animation, other containers, resolution presets, hardware encoding, batch.

---

**Phase 9 — Multi-Track, Shortcuts, Autosave** · _deps: 8_
**Goal:** layered captions and a keyboard-driven workflow.
**Why it exists:** one track cannot express what real captions need (a translation layer, a
commentary layer, a duplicate for emphasis). Once export is proven, layering is cheap.
**Scope:** track CRUD/reorder/visibility/lock; stacked lanes; per-track style; full shortcut
set; command palette; debounced autosave; history UI.
**Exit:** two tracks render and export simultaneously with independent styles; a locked track
rejects drag; autosave survives refresh; no shortcut fires while typing in a text field.
**NOT included:** track compositing modes, solo/mute mixer semantics, templates.

---

**Phase 10 — Word-Level Timing, Animation, Effects** · _deps: 9_
**Goal:** the expressive layer — karaoke, per-word styling, motion.
**Why it exists:** these are the capabilities that make it feel like Photoshop, and they all
build on word timing, which only becomes trustworthy once one track, export, and undo are
solid. Grouping them here is honest: they are one capability area, not three phases, and
splitting them earlier is what produced the original plan's 16 phases.
**Scope:** word lane + word retiming; word-level overrides (layer 4); karaoke highlight;
`resolveAnimation` real; entrance/exit/emphasis with word stagger; both renderers for every
property; effects list (first tier of the extensibility seam, §5.5); proxy transcode + long-file
robustness; render retry/resume/cleanup.
**Exit:** word highlight exact at word boundaries; edge-drag clamps words; animation matches
between preview and export; a property added to the model appears in **both** renderers in the
same commit; proxy transcode previews smoothly.
**NOT included:** keyframe timeline, motion paths, batch export, distributed rendering.

---

### Why this order is better

| Property                               | Effect                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Undo/redo before any UI                | The "all mutations are pure ops" rule is enforced with **zero** counterexamples. Late adoption is an audit, not an extraction                 |
| Export at Phase 8                      | The style model is proven expressible while it's small. Advanced styling at Phase 10 is then _provably_ exportable                            |
| Playback before the timeline           | The video element is established as the time authority before anything depends on it                                                          |
| Testing in every phase's exit criteria | No cleanup phase; quality is a gate, not an afterthought                                                                                      |
| Eleven phases, not sixteen             | Several former phases were feature buckets. Merging word-level + animation + effects reflects that they share a dependency and a risk profile |

**What I dropped from the original 16 and why:** separate "Phase 13 — Performance & Large
Files" and "Phase 15 — Testing" as standalone phases. Performance work is folded into
Phase 10's proxy/long-file scope, and profiling is an exit criterion rather than a phase.
Testing is Phase 0's harness plus a criterion on every phase. A "cleanup phase" is an
admission that the previous phase was not finished.

---

## 14. MVP definition

The MVP is **one honest, complete loop**, not "everything works." It is the smallest thing
that proves the architecture.

> A user provides a short video. The app obtains a transcription, generates timestamped
> subtitles, shows them synchronized with the video, lets the user edit their text and timing
> and apply basic styling, previews the result live, and exports a subtitled video.

### Required (MVP = Phases 0–8)

| Capability                                                                      | Phase |
| ------------------------------------------------------------------------------- | ----- |
| Upload a video, stream it to disk, probe it                                     | 1     |
| Play it back with a correct, single clock                                       | 2     |
| Extract audio via a real job system                                             | 3     |
| Transcribe through a swappable provider, with words                             | 4     |
| Generate readable, well-timed segments                                          | 5     |
| Timeline: select, move, retime, split, merge                                    | 6     |
| Undo/redo over every edit                                                       | 6     |
| Basic styling (font, size, weight, colour, stroke, shadow, alignment, position) | 7     |
| Live preview over the video                                                     | 7     |
| Export a burned-in MP4 + SRT                                                    | 8     |
| Parity between preview and export                                               | 8     |

**MVP acceptance:** a user uploads a 45-second clip and can go from upload to a correctly
timed, styled, burned-in MP4 without the developer present.

### Not in the MVP — and why

| Excluded                              | Reason                                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-track                           | One track is sufficient to prove the model. Adding tracks before export is proven risks validating a model that export then contradicts |
| Word-level styling / karaoke          | Depends on the timeline being trusted; premature                                                                                        |
| Animation                             | Highest fidelity risk; belongs after parity is proven                                                                                   |
| Text background boxes / border radius | **Not representable by libass** — excluded from the model entirely (§7.1), so MVP makes no promise it can't keep                        |
| Effects, keyframes                    | No requirement yet                                                                                                                      |
| Proxy transcoding                     | Only needed when playback is actually janky; premature optimization                                                                     |
| Confidence UI, re-transcription UX    | Refinements on a working pipeline                                                                                                       |
| Font upload UI                        | Registry plumbing in Phase 7; real upload UX later                                                                                      |
| SRT/VTT _import_                      | Export-only in MVP                                                                                                                      |
| Command palette, themes, i18n         | Convenience                                                                                                                             |
| Auth, cloud, multi-user               | Explicitly out of scope                                                                                                                 |

**One honest concession:** the MVP has **no background boxes** on captions. That is a visible
feature, and it is the correct call precisely _because_ the alternative is shipping a control
that works in the editor and silently does nothing in the export. The Phase 13 stroke-based
approximation recovers the popular "black box" caption style with full parity.

---

## 15. Final technology stack

Each dependency below earns its place. Nothing is included for popularity, and the
"not adopted" list matters as much.

### Frontend

- **React 19** — the editor is deeply stateful, with hundreds of components, a document
  model, and a 60fps playhead loop. Component model and reconciliation fit this; a
  framework-less alternative means hand-rolling the thing React already solves.
- **Vite 7** — instant HMR matters most during timeline drag iteration, which is where the
  bulk of development time goes. `vite build` produces a static bundle, so this decision
  isn't lock-in.
- **TypeScript 5.x, `strict` + `noUncheckedIndexedAccess`** — a four-level style cascade with
  sparse overrides and a versioned schema is exactly the code that breaks silently without
  types. `noUncheckedIndexedAccess` matters because time→segment lookup is array indexing;
  unchecked access there is a live bug source. **Non-negotiable.**

### Backend

- **Fastify** — small, schema-first (JSON-schema validation at the boundary for free), good
  streaming support, fast. The only real alternative is bare `node:http` (~100 lines here) or
  Express (slower, unmaintained). Fastify is a proportionate choice, and replacing it later
  touches one directory.
- **Node `worker_threads`** — FFmpeg is a child process, so the main value is keeping
  transcription and file work off the event loop. Chosen because Docker is unavailable.
- **No database** — the document is JSON; a file is the database. Revisit only if remote sync
  or multi-user appears.

### State

- **Zustand 5** — ~1kB, no provider tree, and critically **usable outside React**, which
  matters because worker code must not depend on a UI store. Redux Toolkit is far more
  machinery than seven small stores need; Jotai's atom granularity adds ceremony for no gain
  here; Jotai/XState/others are not meaningfully better for this shape.
- **Seven stores, one per concern** (`document`, `media`, `timeline`, `selection`, `playback`,
  `ui`, `render`). Only `document` mutates the document.

### Validation

- **Zod 4** — the document is untrusted input (a file on disk, eventually an API). Zod gives
  one schema that is simultaneously the runtime validator, the type source, and the migration
  target. The alternative is hand-written validators, which drift from the types.
- **Airtight not-at-all costs more than worth here:** the document validates through Zod plus
  the explicit invariant checks (I-1…I-14). This is deliberate — invariants like "no
  overlapping segments" are not expressible in Zod without contortion, so a custom validator
  owns them.

### Testing

- **Vitest 4** — native Vite integration, fast, no separate config. Jest would mean a second
  transform pipeline. Playwright is **deferred to Phase 6+**, for when real UI exists to
  protect.

### Media

- **FFmpeg / ffprobe CLI (9.0.2, installed)** — spawned as a child process. Not an npm
  wrapper: wrappers add a dependency and lag the binary. `ffmpeg-static` would pin a build but
  the system binary is **verified to have libass**, which is the entire export architecture.
  **This is the most load-bearing dependency and it is already installed.**
- **libass** — the export text renderer (§D-2).

### Rendering

- **DOM/CSS for preview; ASS/libass for export** — as decided in D-2.

### Tooling

- **pnpm 11** — already available; fast, strict, and workspace-native, which matters if the
  monorepo arrives at Phase 7.
- **ESLint 9 (flat config) + Prettier 3** — ESLint carries the **module-boundary rule** that
  enforces `core` purity, which is a real architectural requirement, not style. Prettier is
  boring and correct.
- **No Husky/lint-staged, no commitizen, no Changesets** — ceremony without a requirement. Add
  when there's a team or a release process.

### Not adopted (and why)

`next.js` (SSR unused; complicates streaming upload) · `redux`/`@reduxjs/toolkit` (excess
machinery) · `prisma`/`drizzle`/`postgres` (no DB in scope) · `ffmpeg.wasm` (large, slow, no
libass) · `@ffmpeg/ffmpeg` wrapper (lags the binary) · `tailwindcss` — **still an open
question**, see §15.1.

### 15.1 Open: CSS approach

`PRODUCT.md` assumed Tailwind v4. On reflection this is a **UI decision for Phase 7**, when
the styling system is designed — not a Phase 0 one. CSS Modules are a perfectly good default
and add zero dependencies. **Decision deferred to Phase 7**, with the note that the
subtitle _style system_ is data-driven (`Style` objects), so it is unaffected by the choice
of CSS approach; this only affects how the editor chrome is written.

---

## 16. Final summary

### 1. Final architecture

A browser/server split with an asynchronous worker tier. The browser owns everything
latency-sensitive and interactive (playback, timeline, editing, preview). The server owns
persistence, media storage, and the job API, and is deliberately thin. Workers own all
CPU-bound media and AI work. One pure core (`src/core`) is shared by the browser preview and
the worker export, which is the mechanism that makes WYSIWYG structural rather than aspirational.

### 2. Final package structure

**One package at Phase 0** — `src/{core,server,web}` with a lint-enforced boundary on
`core`. Packages are extracted at Phase 7 (`render-dom`) and Phase 8 (`render-ass`) when a
second runtime genuinely exists. The end state is the monorepo; we get there by paying the
cost only where it earns something.

### 3. Final technology stack

TypeScript (strict) · React 19 + Vite 7 · Fastify + `worker_threads` · Zustand · Zod + custom
invariants · Vitest · **FFmpeg 9.0.2 + libass (installed and verified)** · pnpm · ESLint +
Prettier. No database. CSS approach deferred to Phase 7.

### 4. Final project/document model

`ProjectDocument` — pure JSON, `schemaVersion`, canvas reference resolution, `assets[]`
(videos/audio/**fonts**, referenced by **role**, never by path), `tracks[]` → `segments[]` →
`words[]`, `styles` and `animations` as **named registries**, sparse `StyleOverride` at track
/ segment / word level, ordered `TransformSpec[]`, normalized `position`, `origin` and
`timingSource` for re-transcription safety, `transcription` as a **provenance pointer**.
14 documented invariants (I-1…I-14). Background box and border radius **removed** — libass
cannot render them.

### 5. Final media pipeline

Upload **streamed to disk** under a server-generated `assetId` (never `formData()`), →
`ffprobe` in a worker → `MediaMeta` with exact rational fps → derive audio/proxy as separate
immutable artifacts with recorded provenance. Original never modified. The video is a static
asset after ingest; it is never shuttled back and forth.

### 6. Final transcription abstraction

Three layers: vendor adapter → **pure normalizer** → pure document writer. The normalized
result (`NormalizedTranscript` / `NormalizedUnit`) carries text, units, start/end, confidence
(absent ≠ 0), language, provider, model, timingSource, and metadata. Seven invariants (U-1…U-7).
Provider-native formats never enter the document, and `synthesized` timings are never passed
off as measured.

### 7. Final rendering architecture

`resolveStyle` (pure, total, four-level cascade) → `ResolvedStyle` → either `render-dom`
(browser, preview) or `render-ass` (pure `ProjectDocument → .ass` string, export). **Text
wrapping is done once, in `core`** — neither renderer lays out text, which removes the entire
class of wrapping drift. Exact parity on ~half the properties, calibrated parity on a third,
and **three declared impossibilities** (background box, border radius, spring/bounce). A
compatibility matrix is a versioned artifact read by CI parity tests.

### 8. Final phase order

**0** Foundation · **1** Ingest & Persistence · **2** Playback & Time Base · **3** Audio
Extraction & Jobs · **4** Transcription · **5** Subtitle Model · **6** Timeline + Undo/Redo ·
**7** Styling & Preview · **8** Export & Parity · **9** Multi-Track & Shortcuts · **10**
Word-Level, Animation & Effects. Testing is a criterion on every phase, not a phase. No
cleanup phases.

### 9. Final MVP definition

Phases 0–8. Upload → transcribe → segment → timeline-edit → style → preview → export
burned-in MP4 + SRT, with proven preview/export parity. **Excluded from MVP:** multi-track,
word-level styling, animation, text background boxes, effects, proxy transcoding, auth, cloud.

### 10. LOCKED

- **D-2** FFmpeg + libass export. Highest confidence; verified available; reversibility touches one package.
- **D-6** Parametrised animation descriptors, with the keyframe union as a documented escape hatch.
- **D-7a** Vite SPA (not Next.js). The frontend is a static bundle; low lock-in.
- **The `core` boundary** — enforced by ESLint and a test from Phase 0. This is the decision everything else depends on.
- **Integer-ms canonical time with exact-rational fps.** Reviewed in detail; float seconds and float frames both rejected with worked drift examples.
- **The four-level style cascade** with named registries and sparse overrides.
- **Background box / border radius removed from the style model.**
- **No database; local filesystem keyed by asset ID.**

### 11. DEFERRED

- **D-1** Monorepo / package split → revisit Phase 7.
- **D-5** First transcription provider (a hosted API is the default) — the _interface_ is locked; the implementation is not.
- **Fastify** as the HTTP framework → Phase 1, or bare `node:http` if it stays trivial.
- **CSS approach (Tailwind vs. CSS Modules)** → Phase 7.
- **Playwright** → Phase 6+, when there is UI worth protecting.
- **Automatic timestamps for segments** → after MVP, only if a real need appears.
- **Keyframe animation** → union extension, no model change.
- **Real text-box backgrounds** → Phase 13+ via stroke approximation, then overlay composite.
- **Full background-box parity in the document** → only when a second export backend could render it.

### 12. Risks still requiring discussion

1. **libass `{\an}` anchor ↔ normalized DOM position.** The parity matrix's biggest unknown and the most likely source of Phase 8 rework. Mitigation: a fixture-driven mapping test written _before_ the full export.
2. **`\fsp` collision between letter spacing and line height.** Needs a documented product decision on which wins when both are set. Recommend: line height wins, letter spacing is applied within a line.
3. **Stroke width vs. libass border scaling.** Almost certainly needs an empirical calibration constant rather than a clean mapping.
4. **ASR provider word-timing quality varies a lot by provider and audio quality.** If the first provider underperforms, segmentation quality (Phase 5) — not the provider — is where the fix belongs. Worth an early bake-off on 3–4 real clips.
5. **No Docker/GPU.** Worker-thread isolation is adequate at 30s–1min but is a real limitation under concurrent load.
6. **Font licensing and distribution.** Shipping a font file to a server for export has licensing implications that depend on the chosen fonts.
7. **Document growth over years.** If a project accumulates thousands of segments, whole-document snapshots for undo become heavy. Not a Phase 0 problem; noted so it isn't a surprise at Phase 10.
8. **Single-machine storage.** `workspace/` is local. Multi-project, multi-day use with no cleanup is fine locally, but there's no backup story yet.

**Awaiting approval. No code has been written, no dependencies installed, no `package.json`
created, and the project has not been initialized.**

---

## 17. Architecture ↔ product check

_Added by the product/UX pass. The question: **can this architecture support the editor we
eventually want, without a rewrite?** Not "is the model tidy" — that was §5. This asks
whether each capability in the North Star has somewhere to live._

### 17.1 Capability-by-capability

| Capability                                                | Supported? | By what                                                                                                                        | Verdict                                      |
| --------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| **Timeline** (zoom, playhead, drag, resize, split, merge) | ✅         | Segments carry `startMs`/`endMs`; ops in `core/ops`; binary-search lookup                                                      | Clean. No new structure needed               |
| **Drag preserves duration / edge retimes**                | ✅         | `moveSegment` vs `retimeSegment` (§8.2)                                                                                        | Now explicit. Was ambiguous                  |
| **Multi-track**                                           | ✅         | `tracks[]` already plural, each with its own style + visibility                                                                | Clean                                        |
| **Word timing**                                           | ✅         | `segment.words[]` with `startMs`/`endMs`                                                                                       | Clean                                        |
| **Karaoke / word emphasis**                               | ✅         | Word `styleOverride` (cascade layer 4) + word `animationId`                                                                    | Clean                                        |
| **Style inheritance**                                     | ✅         | 4-level cascade, `styles` registry, sparse overrides                                                                           | Clean. Verified pure                         |
| **Consistency ("restyle 40 at once")**                    | ✅         | Track `styleId` → N segments                                                                                                   | Clean. This is the reason it's a registry    |
| **"Make these look like that one"**                       | ✅         | `applyStyleToSelection` — a bulk op, **no model change**                                                                       | Gap identified and closed in §8.2            |
| **Animation**                                             | ✅         | `animations` registry; **I-19** now resolves the static/animation collision                                                    | Fixed — this was a real gap                  |
| **Undo/redo**                                             | ✅         | Pure op-stack, Phase 0; **I-20** keeps worker results inside it                                                                | Fixed — this was a real gap                  |
| **Preview**                                               | ✅         | `render-dom` consuming the shared resolver                                                                                     | Clean                                        |
| **Export**                                                | ✅         | `render-ass` consuming the same resolver                                                                                       | Clean                                        |
| **Parity**                                                | ✅         | Versioned matrix, wrapping in `core`, CI tolerances                                                                            | Clean. The single most protected property    |
| **Future effects**                                        | ✅         | `TransformSpec` is a typed extensible list; effects mirror it                                                                  | Clean                                        |
| **Keyboard-driven editing**                               | ✅         | Ops are pure functions, so shortcuts map 1:1 to ops                                                                            | Clean — and this is _why_ ops must stay pure |
| **Large videos**                                          | ⚠️         | Streaming upload + proxy planned, but **no frame-accurate seeking strategy for non-integer frame rates** in the playback model | See below                                    |
| **Edit text while playing**                               | ⚠️         | Possible, but not a stated requirement anywhere                                                                                | See below                                    |

### 17.2 Two things the check surfaced that were _not_ architecture defects

**Large video seeking is under-specified.** R-4 solved frame↔ms conversion exactly, but
nothing states the _playback_ strategy for seeking a 4K or VFR source. The video element
seeks in float seconds; our model is integer ms. For a long or high-resolution file, seeking
can land on a non-keyframe, producing a multi-second stall — which would read as "the editor
is slow." This is a genuine unknown, and it is **not** solved in Phase 0 or 2 because the
answer depends on proxy availability (Phase 10). Recorded as **R-21**.

**"Edit text while playing" is an implicit requirement.** It emerged as a core-loop
constraint (`PRODUCT.md` §17B) but is nowhere in the phase specs, which is exactly how
implicit requirements get discovered at Phase 9 and cause a rethink. It is a Phase 6
requirement — cheap if planned, disruptive if retrofitted, because it affects how the
text-editing overlay interacts with the rAF loop and the selection model.

### 17.3 What the architecture does _not_ need

Stating this is as important as the gaps, because the tendency in a long project is to
retrofit structure for capabilities that were never demanded:

- **No keyframe timeline** — union extension, no model change.
- **No plugin system** — the `TranscriptionProvider` interface is the one extension point
  that exists, and it is enough for the foreseeable provider churn.
- **No event-sourcing or CRDT layer** — undo/redo is snapshots, and that is correct at this
  scale. Collaboration is out of scope and would be a different architecture.
- **No scene graph / compositing tree** — multi-track subtitles are a _list_, not a tree.
  The moment tracks need blend modes or z-ordering, that is when a tree becomes justified,
  and it is not now.
- **No generic "effect" engine** — `TransformSpec` plus the existing `animations` registry
  covers the stated requirements. A general effect graph is speculative by definition.

### 17.4 Verdict

**The architecture supports the intended editor without a rewrite.** Two genuine gaps were
found by the product pass and both are now fixed at the _invariant_ level rather than with
new structures — animation/static collision (I-19) and worker-produced mutations bypassing
undo (I-20). Both fixes are ~1 line of resolver logic and ~1 architectural rule
respectively, and both were caught _before_ implementation, which is the entire point of
doing this pass.

Two items are recorded as newly-needed _requirements_ rather than defects: VFR seeking
(R-21) and edit-while-playing (Phase 6). Neither requires a model change.
