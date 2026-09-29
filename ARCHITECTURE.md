# ARCHITECTURE.md — Subtitle Studio

Companion to `PRODUCT.md` (requirements) and `IMPLEMENTATION_PLAN.md` (sequence).
This document records **decisions and their reasons**, so future phases do not re-litigate them.

Status: **Draft v0.3 — revised after the product/UX pass.** None of it is implemented yet.

> **Precedence:** `ARCHITECTURE_REVIEW.md` is the **canonical** document. This file is the
> narrative version. Where they differ, the review wins. Sections here carry
> "canonical definition" pointers to the review for anything the review refined —
> notably the document model (§3), timing (§6), the parity matrix (§7), the transcription
> normalizer (§5), undo/redo (§7.1), and package structure (§2, §9).
>
> **What the review changed** (v0.1 → v0.2): the package split was deferred; undo/redo moved
> from Phase 9 to Phase 0; text background and border radius were **removed** from the style
> model because libass cannot render them; four speculative fields were removed and one
> required one added; six new risks were recorded; and the decision register now marks each
> decision LOCKED or DEFERRED.
>
> **What the product/UX pass changed** (v0.2 → v0.3): two invariants were added after asking
> "does this model survive the editing interactions we actually want?" — **I-19**
> (animation vs. static transform precedence) and **I-20** (worker-produced mutations must
> enter through `core/ops`, never replace the document). Three risks were added (R-21 VFR
> seeking, R-22 and R-23 — the latter two now resolved by those invariants). The phase specs
> gained explicit op semantics, the edit-while-playing requirement, and the typing-burst
> undo batching rule. The architecture↔product check is `ARCHITECTURE_REVIEW.md` §17.

---

## 0. Canonical reference index

| Topic                                           | Canonical location                |
| ----------------------------------------------- | --------------------------------- |
| Decision review (LOCKED/DEFERRED)               | `ARCHITECTURE_REVIEW.md` §1       |
| Package structure reasoning                     | `ARCHITECTURE_REVIEW.md` §2       |
| Browser/server/worker split + data flow diagram | `ARCHITECTURE_REVIEW.md` §3       |
| Transcription layers + normalizer invariants    | `ARCHITECTURE_REVIEW.md` §4       |
| Document model + all 20 invariants (I-1…I-20)   | `ARCHITECTURE_REVIEW.md` §5, §8.1 |
| Timing model + 30/29.97/60 worked examples      | `ARCHITECTURE_REVIEW.md` §6       |
| **Preview/export compatibility matrix**         | `ARCHITECTURE_REVIEW.md` §7       |
| Style cascade invariants I-14…I-18              | `ARCHITECTURE_REVIEW.md` §8       |
| Undo/redo design                                | `ARCHITECTURE_REVIEW.md` §9       |
| Media storage + upload flow                     | `ARCHITECTURE_REVIEW.md` §10      |
| Job lifecycle + job types                       | `ARCHITECTURE_REVIEW.md` §11      |
| Security requirements S-1!S-14                  | `ARCHITECTURE_REVIEW.md` §12      |
| Final phase order + MVP definition              | `ARCHITECTURE_REVIEW.md` §13, §14 |
| **Architecture ↔ product check**                | `ARCHITECTURE_REVIEW.md` §17      |
| **Editor UX/design philosophy + North Star**    | `DESIGN_PRINCIPLES.md`            |
| **Product design decisions + product risks**    | `PRODUCT.md` §17–§19              |
| **Agent development rules + phase contract**    | `IMPLEMENTATION_PLAN.md`          |
| Stack justification                             | `ARCHITECTURE_REVIEW.md` §15      |

---

## 1. Repository inspection — what exists

**Finding: the repository is empty.** No source files, no scaffold, no git history, no
package manager metadata. There is no existing stack to preserve — the stack must be _chosen_.

Verified state at time of writing:

| Area                      | Status              |
| ------------------------- | ------------------- |
| Source files              | none                |
| `package.json` / lockfile | none                |
| Git repository            | **not initialized** |
| TypeScript config         | none                |
| UI framework              | none                |
| Styling approach          | none                |
| Media/video libraries     | none                |
| Backend / API             | none                |
| Database                  | none                |
| Test setup                | none                |
| Build tooling             | none                |

So the "do not replace the existing stack" constraint is vacuous here, and the risk shifts
entirely to _over-building_: the temptation is to scaffold an enormous app with auth, DB,
queues and a design system before a single subtitle renders. This plan explicitly does not.

### Environment capability probe (verified on this machine)

| Tool                 | Version     | Notes                                                                   |
| -------------------- | ----------- | ----------------------------------------------------------------------- |
| Node                 | v26.10.0    | current LTS line                                                        |
| npm                  | 12.1.0      |                                                                         |
| pnpm                 | 11.26.0     | available                                                               |
| bun                  | 1.4.2       | available                                                               |
| Python               | 3.14.7      | present (relevant if local Whisper is explored later)                   |
| **FFmpeg**           | **n9.0.2**  | **present** — the single most important capability here                 |
| libass               | **present** | **verified** — `--enable-libass`; `ass` + `subtitles` filters available |
| libx264 / libvpx-vp9 | **present** | verified — proxy transcode (§6/V-06) needs no external binary           |
| git                  | 2.55.0      |                                                                         |
| Docker               | **absent**  | constrains process-isolation strategies                                 |
| NVIDIA GPU           | **absent**  | no GPU-accelerated encode; CPU FFmpeg only                              |

**FFmpeg being installed natively is a decisive input.** It removes the need for a WASM
FFmpeg build, a Docker image, or a static binary download — the three usual blockers.

**libass verified (Phase 0 probe).** `ffmpeg -filters` lists both `ass` and `subtitles`, and
the build configuration includes `--enable-libass`. This is the most consequential fact in
this document: the entire export architecture in §6 rests on it, and it is now confirmed
rather than assumed. `libx264` and `libvpx-vp9` are also present, so browser-proxy
transcoding (V-06) needs no external binary.

Absence of Docker and GPU means: jobs run as in-process Node worker threads, and encoding is
CPU-bound. Both are acceptable at 30s–1min clip lengths.

---

## 2. Stack decision

| Layer                | Choice                                          | Why                                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language             | **TypeScript, strict**                          | Required by the quality bar. A document model with a four-level style cascade, a versioned schema and a pure resolver is exactly the code that breaks without types.                                                      |
| UI framework         | **React 19 + Vite**                             | The editor is deeply stateful and component-heavy; Vite is the fastest credible dev loop.                                                                                                                                 |
| Language flags       | **`strict: true` + `noUncheckedIndexedAccess`** | Array indexing is pervasive in time→segment logic; unchecked access is a real bug source there.                                                                                                                           |
| Package manager      | **pnpm**                                        | Already available; fast and strict. Also workspace-native should the monorepo arrive at Phase 7.                                                                                                                          |
| Styling              | **DEFERRED to Phase 7**                         | A UI concern, not a foundation concern. Note the subtitle _style system_ is data-driven (`Style` objects) and is unaffected by this choice.                                                                               |
| State                | **Zustand**, one store per concern              | Small, framework-agnostic, works outside React (needed by worker code). See §7.                                                                                                                                           |
| Validation           | **Zod + custom invariant validator**            | The document is untrusted input (a file on disk, future API). Zod covers shape; a hand-written validator owns cross-field invariants like "no overlapping segments", which are not expressible in Zod without contortion. |
| Persistence          | **JSON documents on local disk**                | No DB. The document model is JSON (§3), so a file _is_ the database. Revisit only if remote sync appears.                                                                                                                 |
| Server               | **Fastify + Node `worker_threads`**             | Thin API; the worker pool is the render/transcode job runner (§8).                                                                                                                                                        |
| Media                | **FFmpeg CLI, spawned**                         | Installed. See §6/§8 for the tradeoffs.                                                                                                                                                                                   |
| Export text renderer | **FFmpeg + libass (ASS)**                       | See §6.                                                                                                                                                                                                                   |
| Tests                | **Vitest**                                      | Native to Vite; unit tests cover the pure core, which is where the risk is.                                                                                                                                               |
| E2E                  | **Playwright** (deferred to Phase 6+)           | Only when there is UI worth regression-testing.                                                                                                                                                                           |

**Layout — one package at Phase 0, extracted as second runtimes appear:**

```
Subs/
├── package.json            # single root, pnpm
├── src/
│   ├── core/               # ⭐ pure: no react, no node builtins, no ffmpeg
│   │                       #    document model, schema, invariants, migrations,
│   │                       #    resolveStyle, segmentation, all timeline ops, undo ops
│   ├── server/             # fastify + ffmpeg + transcription providers. Node-only.
│   └── web/                # react + vite editor app
├── tests/
└── docs/
```

**The `src/core` boundary is the load-bearing decision of this document.** It holds the
document model, the schema, migrations, the style resolver, segmentation, and all timeline
operations — and it imports _nothing_ from React, the DOM, or FFmpeg. It must be importable
by a browser bundle, a Node worker, and a test runner unchanged. That single constraint is
what makes R-02/WYSIWYG (§13 in PRODUCT.md) achievable rather than aspirational.

**Why one package rather than four.** See `ARCHITECTURE_REVIEW.md` §2. A package with a
single consumer is a folder with extra build config. The boundary that matters is _`core`
versus everything else_, and that is enforceable today with an ESLint
`no-restricted-imports` rule plus a test asserting `core` imports no `react`/`node:fs`/
`child_process`. Packages are extracted at Phase 7 (`render-dom`) and Phase 8 (`render-ass`),
when a genuine second runtime exists. The end state is the monorepo; we get there by paying
the cost only where it earns something.

---

## 3. The document model

> **Canonical definition:** `ARCHITECTURE_REVIEW.md` §5. This section is the summary; the
> review document holds the full type definitions and all 14 invariants. Where the two
> differ, the review is authoritative — it supersedes the first draft of this file.

Plain JSON. No classes, no functions, no cycles. Must round-trip through
`JSON.stringify` → disk → `JSON.parse` unchanged.

### 3.1 Shape

```ts
interface ProjectDocument {
  schemaVersion: number;
  id: ProjectId;
  name: string;
  createdAt: string;
  updatedAt: string;
  canvas: { width: number; height: number }; // reference design resolution
  assets: AssetRecord[]; // video, audio, AND fonts
  tracks: SubtitleTrack[];
  styles: Record<StyleId, Style>; // named registry
  animations: Record<AnimationId, AnimationDef>;
  transcription?: {
    // provenance POINTER, never a transcript copy
    providerId: string;
    model?: string;
    language?: string;
    generatedAt: string;
  };
}
```

### 3.2 The seven separations

| Concern          | Where it lives                                                           |
| ---------------- | ------------------------------------------------------------------------ |
| Source media     | `assets[]` — referenced by **role**, never by path or filename           |
| Subtitle content | `segment.words[]` (source of truth); `segment.text` is a validated cache |
| Timing           | `startMs`/`endMs` as **integer ms**, on segments and words               |
| Visual styling   | `styles` registry + sparse `StyleOverride` at track/segment/word         |
| Animation        | `animations` registry + `animationId` references                         |
| Timeline state   | **not in the document** — `timelineStore` is ephemeral UI state          |
| Editor state     | **not in the document** — selection, zoom, panels                        |
| Render state     | **not in the document** — `JobRecord` is server-side runtime state       |

### 3.3 Corrections to the first draft

The review identified four speculative fields and one missing field. Changes:

| Change                                                                                                       | Reason                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transform?: StyleTransform` on track + segment **removed** → `transforms?: TransformSpec[]` on `Style` only | Two sources of truth for one visual fact. Order matters (rotate≠translate), so an ordered list is both correct and directly expressible as a CSS `transform` string |
| `opacity` **folded into `transforms`**                                                                       | `opacity` is a transform, not a separate visual property                                                                                                            |
| `position` on **track removed** (kept on `Style`)                                                            | A track-level position adjustment _is_ a translate transform. One mechanism, not two                                                                                |
| `extensions?: Record<string, unknown>` **removed**                                                           | A bag never populated and never read is a promise the code doesn't keep. Forward compatibility is handled honestly by `schemaVersion` + migrations                  |
| `lineBreaks?: number[]` **semantics pinned**                                                                 | **Word indices** at which a line break is forced. Defined this time, because text layout depends on it                                                              |
| `order: number` on track **removed**; segments rely on array order                                           | Two orderings that can disagree is a bug generator. Array order _is_ the order, and invariant I-3 ties it to `startMs`                                              |
| `fontFamily` now **must name a font asset** (invariant I-12)                                                 | The font registry is impossible without an asset ID. Font determinism (S-08) is a hard requirement                                                                  |

### 3.4 Text background removed

`backgroundColor`, `backgroundOpacity`, `paddingXPx/Y`, and `borderRadiusPx` are **removed
from the style model**. libass has no background-box primitive, so keeping them would mean
shipping controls that work in the preview and do nothing in the export — the precise
failure this architecture exists to prevent. Recovery path: a box is approximated as a thick
same-colour stroke (full parity, hard edges), and true rounded boxes arrive later as an
FFmpeg-side overlay composite. See `ARCHITECTURE_REVIEW.md` §7.1.

### 3.5 Assets referenced by role

Segments never store asset IDs. They reference `sourceVideo` / `audio` / `font` **by role**
(invariant I-13). Swapping the source video or changing the font file therefore updates
everything automatically, and no segment can reference a deleted file.

### 3.6 Invariants

The complete list (I-1…I-14) is in `ARCHITECTURE_REVIEW.md` §5.1. The load-bearing ones:

- **I-1** All time is **integer milliseconds**. No floats in the document.
- **I-3** Segments sorted by `startMs` and non-overlapping within a track.
- **I-5** Every entity has a stable, unique ID. Never an array index, never text content.
- **I-6** `transforms` **replaces** on override; it does not merge.
- **I-7** Overrides are sparse; absent = inherit. No sentinels (`""`, `-1`, `null`).
- **I-9** Pure JSON; round-trips unchanged.
- **I-14** `styleId` and `styleOverride` are mutually exclusive on one entity.

### 3.7 Schema evolution

```ts
type Migration = (doc: unknown) => unknown;
const MIGRATIONS: Record<number, Migration> = {/* n → n+1 */};
export function migrate(raw: unknown): ProjectDocument; // pure, throws on unknown future version
```

Pure, table-driven, one test per step. A document from a **newer** version fails loudly
rather than loading partially — partial load of a subtitle document means silently mangled
timing, which is worse than refusal.

## 4. Style resolution — the WYSIWYG contract

> **Canonical definition:** `ARCHITECTURE_REVIEW.md` §8, including invariants I-6…I-7 and
> I-14…I-18. The four-level cascade was reviewed and **confirmed correct**; the refinements
> are below.

One pure function, no DOM, no React, no globals, no I/O. Both renderers call it.

```ts
// src/core/style/resolve.ts
export function resolveStyle(styles: Record<StyleId, Style>, id: StyleId): Style;
export function resolveEffective(base: Style, ...overrides: StyleOverride[]): ResolvedStyle;
export function resolveSegmentAt(doc: ProjectDocument, trackId: TrackId, tMs: number): ResolvedSegment | null;
export function resolveLines(...): ResolvedLine[];   // wrapping happens HERE, once
```

Cascade (PRODUCT M-03):

```
project default style
  → track.styleId
    → segment.styleId  (replacement)  |  segment.styleOverride  (merge)
      → word.styleOverride  (merge)
```

**Two functions, not one.** `resolveStyle` walks the named-style registry; `resolveEffective`
performs the sparse merge. Separating them keeps "which style is this" distinct from "what
are its effective values", and makes each independently testable.

**`styleId` and `styleOverride` are mutually exclusive on one entity** (invariant I-14).
Setting both is a validation error — merging a named style _and_ an override forces the
question "does the override beat the named style or its parent?", and the answer is almost
never what a user intends.

`ResolvedStyle` is **fully populated** — every key has a concrete value, because the renderer
must never branch on "is this inherited?" (I-17). Renderers consume a total type; the
resolution complexity is paid once, in one place, that both renderers share.

**Purity and determinism are non-negotiable** (I-15, I-16): same inputs must produce
byte-identical output across processes and runs. A single hidden dependency — a module-level
cache, a font-measurement singleton — silently breaks the browser preview, the worker export,
or the parity test, and the parity fixture tests become meaningless.

**The resolver never inspects media, the DOM, or a renderer's capabilities** (I-18). A
resolver that asked "does libass support background boxes?" would be one `if` away from the
document changing shape depending on which backend is asking. Capability handling belongs at
the _renderer_ boundary: a renderer declares what it supports and **reports** a gap, rather
than the model bending per backend.

**Lookup:** segment-at-time is a binary search over a track's `startMs`-sorted array (I-3)
with a max-duration window. Never a linear scan per frame.

**Wrapping lives here too**, producing explicit `ResolvedLine[]` (see §6 parity). Neither
renderer performs its own text layout.

**Why this matters:** if preview styling lives in React components, the export renderer must
re-implement the cascade against a different data shape, and the two will drift. The resolver
is the contract that makes drift structurally impossible.

---

## 4.5 Timing model

> **Canonical definition with worked examples:** `ARCHITECTURE_REVIEW.md` §6.

**Canonical representation: integer milliseconds.** Rationale and rejected alternatives are
in the review; the short version — subtitle timing is _authored_ in ms, ms serializes exactly
as JSON, and editing is delta-based, so integer arithmetic **cannot** drift across a
10,000-operation session. Float seconds and float frames both accumulate error; float frames
are additionally irrational at 29.97.

**Frame rate is never rounded.** Stored as `frameRateNum`/`frameRateDen`, converted only at
the boundary using `BigInt`:

```ts
function msToFrame(ms, num, den) {
  return Number(((BigInt(Math.round(ms)) * BigInt(den) * 1000n) / BigInt(num)) * 1000n);
}
function frameToMs(f, num, den) {
  return Number((BigInt(f) * 1000n * BigInt(den)) / BigInt(num));
}
```

**NTSC is `30000/1001`, never `29.97`** — and never `30`. Storing the rate as a **num/den
pair** rather than a single number is what makes the dangerous mistake impossible: assuming
**30fps on a 29.97 source drifts ~3.6 seconds per hour** of video (verified). Rounding to
`29.97` _inside a conversion_ is comparatively harmless (~3.6ms/hour) — the real hazard is
losing the denominator. Full worked tables for 30 / 29.97 / 60 fps are in the review; read
them before touching `time.ts`.

**Two rules that prevent whole bug classes:**

1. **`frame` is derived and ephemeral — never stored in the document.** Computed at display
   or export time via the exact converters. This eliminates "the frame value drifted"
   entirely, because no frame value outlives the call that produced it.
2. **There is exactly one place video time enters the app.** The rAF loop:
   `const tMs = Math.round(video.currentTime * 1000)`. `Math.round`, re-derived from the
   element every frame, so browser clock imprecision is corrected continuously rather than
   integrated. **No independent timer exists anywhere in the application.**

**Known lossy step:** ASS timecodes are centiseconds, so export truncates ms to 10ms
(perceptually irrelevant, sub-frame at 30fps) — but it is a _documented_ loss, applied
consistently so ordering is preserved, not a surprise.

---

## 4.6 Security and validation

> **Canonical detail:** `ARCHITECTURE_REVIEW.md` §12, requirements S-1…I-14.

Authentication is out of scope. These are **not auth features** — they are the minimum
required to safely execute untrusted bytes with a subprocess that parses untrusted formats.
FFmpeg is a large native attack surface and untrusted media is exactly its threat model.

The non-negotiable ones, because everything else depends on them:

- **S-1 Path traversal** — asset paths derive from a **server-generated `assetId`** only; the
  client never supplies a path; `assetId` is validated against `/^[A-Za-z0-9_-]{1,64}$/`.
  `filename` is display metadata and is **never joined into a filesystem path**.
- **S-5 FFmpeg argument safety** — every invocation uses `spawn` with an **argv array, never
  a shell string**. No user-controlled value is interpolated into command text.
- **S-7 Protocol allow-list** — any URL ffmpeg opens must be `file:` under `workspace/`.
  `http:`, `https:`, `concat:`, `subfile:` are rejected, or a crafted "video" could make
  FFmpeg fetch remote URLs or read arbitrary local files.
- **S-13 XSS** — subtitle text renders as **text content**, never `dangerouslySetInnerHTML`.
  Subtitle text is attacker-controlled data: it comes from a video's audio, or a pasted file.
- **S-14 Bind to `127.0.0.1`** — with no authentication, the server must not be reachable
  from a network. A deliberate constraint, not an oversight.

Also required: extension allow-list, streaming size caps, per-process timeout + kill,
`tmp/` GC on startup and after each job, typed errors on malformed media, and Zod +
invariant validation on **every** document read (S-11).

---

## 5. Transcription provider abstraction

> **Canonical definition:** `ARCHITECTURE_REVIEW.md` §4. Three layers, deliberately
> separated because they are three different kinds of code. Summary follows.

```
Layer 1  provider adapter   (Node, impure, per-vendor, disposable)   src/server/
             │  vendor response format
             ▼
Layer 2  normalizer         (PURE, vendor-agnostic)                  src/core/
             │  NormalizedTranscript
             ▼
Layer 3  document writer    (PURE, builds SubtitleSegment[])         src/core/
```

Layer 1 is the **only** place a vendor's response shape is allowed to appear, and it is
disposable: deleting a provider must not touch layers 2 or 3.

```ts
export interface TranscriptionProvider {
  readonly id: string; // stable, persisted in the document
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities; // wordTimings, confidences, limits
  transcribe(req: TranscriptionRequest): Promise<ProviderRawResult>;
}

/** The normalized contract (Layer 2 output). */
export interface NormalizedTranscript {
  text: string;
  units: NormalizedUnit[]; // ordered, non-overlapping
  language?: string;
  providerId: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface NormalizedUnit {
  text: string;
  startMs: number; // integer ms
  endMs: number;
  confidence?: number; // absent ≠ 0
  timingSource: 'measured' | 'synthesized';
}
```

**Normalizer invariants (U-1…I-7):** integer ms; units ordered and non-overlapping (vendor
overlap is clamped, not passed through); `endMs > startMs` always; within audio duration;
`confidence` either absent or in [0,1] — **never 0 as a stand-in for unknown**; units from a
provider with `wordTimings: false` are marked `'synthesized'` and distributed by character
length, **never presented as measured**.

**Provider-native formats never enter the document.** The document records only
`transcription: { providerId, model, language, generatedAt }` — a provenance _pointer_, not a
copy. The words already live in `segments[].words`; a second copy would invite divergence.

**Which providers, and when:**

| Provider                              | When                | Rationale                                                                                                                                                                                              |
| ------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI / Groq / Deepgram / AssemblyAI | **Phase 4 (first)** | Zero ops burden, good word timings, immediately useful. **Decision DEFERRED — this is the default, not a commitment**                                                                                  |
| `faster-whisper` (local, Python)      | Later, if desired   | Free and private; CPU-only inference is slow but viable for 60s clips. Python 3.14 is present, though `faster-whisper`/`ctranslate2` wheel availability is **unverified**. Do **not** build this first |
| Forced-alignment providers            | Later               | Emit per-word timings over a _known_ transcript — ideal when a human-edited script exists                                                                                                              |
| Browser `transformers.js` Whisper     | Optional later      | No API cost, no upload; heavy bundle, slow in-browser CPU                                                                                                                                              |

**The interface is LOCKED; the first implementation is DEFERRED.** The first provider must be
behind the interface, never in the app's logic.

---

## 6. Rendering & export — why FFmpeg + libass

Four candidate architectures:

**(a) Browser-only** (WebCodecs / MediaRecorder / ffmpeg.wasm)

- **Pro:** no server, no upload for small clips, trivially private.
- **Con:** ffmpeg.wasm is large and slow; text rendering fidelity in WASM is weak; **no
  libass**; CPU-bound on the UI thread for a 60s render; `MediaRecorder` output is
  non-deterministic and often codec-unsupported; memory pressure on 5GB files. Subtitle
  styling in Canvas/DOM then has _zero_ relationship to any other renderer.
- **Verdict:** fine for thumbnails; unacceptable as the export path for a fidelity product.

**(b) Server-side FFmpeg (synchronous)**

- **Pro:** simple.
- **Con:** a 60s render can take 30–300s — exceeds typical proxy/HTTP timeouts; one render
  blocks the event loop's usefulness; no progress, no cancel.
- **Verdict:** correct _tools_, wrong _shape_.

**(c) Worker-based FFmpeg (async jobs)** ✅ **chosen**

- **Pro:** non-blocking, progress-reportable, cancellable, survives restarts, scales to a GPU
  box later, keeps FFmpeg out of the request path.
- **Con:** needs job state and a UI for it (which we need anyway).
- **Verdict:** this is the answer for a serious subtitle application.

**(d) Hybrid** — browser for preview, server for export. This is the actual final design:
browser preview is _not_ a "processing" choice, it is a latency choice (zero round-trip while
dragging). Media _processing_ and _export_ are all (c).

### Why libass/ASS rather than burned-in text in the browser or a headless browser

- Mature text layout: wrapping, alignment, outlines, shadows, positioning, transforms.
- **Scriptable and deterministic** — no Chromium dependency, no font-rendering drift.
- It takes styling from a JSON document, so `render-ass` is a **pure function**:
  `ProjectDocument → ASS file`. Testable in unit tests, diffable, reviewable.
- It is the practical ceiling of subtitle fidelity for this class of product.

The decisive argument is philosophical: with libass the export is a _transformation_ of the
document; with headless Chromium it is a _replay_ of the app. A transformation is reviewable;
a replay is not.

**The parity contract:** the export is a _reference implementation_ of the style semantics.
When DOM preview and libass disagree, the fix goes in `src/core` (shared constants and
normalization) or in `render-dom` (emulating a libass quirk) — **never** by editing the
document, and **never** by silently accepting a difference. This is documented as the
resolution policy because without it the two renderers drift by default.

### Parity status — read before promising anything

> **Canonical matrix:** `ARCHITECTURE_REVIEW.md` §7, including a per-property
> browser/libass/exact-parity table.

The honest summary, because it constrains what the product may promise:

- **Exact parity** on roughly half the properties (colour, opacity, scale, rotation,
  translate, alignment, font size/family _with pinned files_, fades, per-word styling).
- **Calibrated parity** on about a third (stroke width, shadow, letter spacing, line height,
  normalized position) — each needs a documented mapping or an empirical constant, enforced
  by fixture tests with declared tolerances.
- **Genuinely impossible in libass** on three: **text background box**, **border radius**, and
  **spring/bounce curves**.

**Consequence — background box and border radius were removed from the style model** (§3.4).
Shipping them would mean shipping controls that work in the editor and do nothing in the
export. Recovery: a box approximated as a thick same-colour stroke (full parity, hard edges),
then a true rounded box as an FFmpeg-side overlay composite at a later phase.

**Text wrapping is done once, in `src/core`**, producing explicit `ResolvedLine[]`. Neither
renderer lays out text. If the browser re-wrapped text, every wrapping difference would
become a permanent parity bug — this is the single most valuable decision in the parity story.

Parity is enforced mechanically, not aspirationally: a versioned compatibility matrix is read
by CI tests that render a fixture through both paths and compare per property. A property
exceeding its declared tolerance fails the build.

### Font determinism

`fontFamily` resolves through a project font registry mapping family → a specific font file,
uploaded/registered as an `AssetRecord` of kind `'font'`. The preview loads via
`FontFace`; the export passes the same file to FFmpeg's `fontsdir`. Same file, same weight,
both renderers. System-family-only styling is a guaranteed silent mismatch (PRODUCT S-08).

---

## 7. State management — seven separated concerns

The instruction to avoid one giant global store is correct, and the natural failure mode is
_over_-splitting into forty micro-stores. Seven concerns, each with a distinct lifetime:

| Store            | Lifetime | Contains                                                           | Persisted to document?            |
| ---------------- | -------- | ------------------------------------------------------------------ | --------------------------------- |
| `documentStore`  | project  | The `ProjectDocument` — the only mutable truth                     | **Yes** — it _is_ the document    |
| `mediaStore`     | session  | Asset records, probe results, thumbnails, loaded element refs      | Partly (asset records)            |
| `timelineStore`  | session  | Zoom, scroll offset, px-per-second, track heights, collapsed lanes | **No** — pure UI                  |
| `selectionStore` | session  | Selected segment/word/track IDs, active track, primary segment     | **No** — pure UI                  |
| `playbackStore`  | session  | `currentTimeMs`, `durationMs`, `isPlaying`, `rate`, `volume`       | **No** — runtime                  |
| `uiStore`        | session  | Panel layout, active inspector tab, dialogs, toasts, theme         | **No** — pure UI                  |
| `renderStore`    | session  | Job list, active render progress, cancel handles                   | **No** — server state, rehydrated |

**Rules:**

1. **Only `documentStore` mutates the document.** Every other store either reads from it or
   holds its own ephemeral state. No component mutates the document directly.
2. **All mutations go through pure operations in `src/core/ops`** — `moveSegment`,
   `splitSegment`, `mergeSegments`, `applyStyleOverride`. The store is a thin dispatcher.
   This makes every edit unit-testable without a DOM.
3. **`currentTimeMs` is derived, not stored as truth.** Playback reads `video.currentTime` on
   `rAF`. The store holds a mirror for React's benefit, but the video element is the clock.
   A second timer would drift (PRODUCT TS-06).
4. **Selectors are memoized and derived, never duplicated.** `activeSegmentAt(t)` is a
   selector over `documentStore`; components subscribe to the _result_, not to the whole store.
5. **Undo/redo is built into `core` from Phase 0** (see below).

### 7.1 Undo/redo — architecture in Phase 0, UI later

**Originally deferred to Phase 9. That was a mistake** (`ARCHITECTURE_REVIEW.md` §9). The
cost of _late_ adoption is not the diffing mechanism — it is that once a UI exists, feature
authors start writing imperative side-effects, and retrofitting history means auditing every
mutation site. The cheap moment is now, while "all mutations are pure ops" has zero
counterexamples.

```ts
interface Op { label: string; apply(doc: ProjectDocument): ProjectDocument }
undoStack: Op[]; redoStack: Op[];
```

Four properties, each load-bearing:

- **Pure** — `(doc) => doc'`, never in-place mutation. Undo is trivially reliable.
- **Labeled** — the labels _are_ the undo menu text; the UI is purely additive later.
- **Batched** — a drag is one op from pointerdown to pointerup, not 200. Without batching a
  single drag destroys the entire history.
- **Snapshots** — the document is JSON and small (tens–hundreds of segments), so full
  snapshots are simple and fast. Structural sharing only if profiling demands it.

**Enforcement:** a test asserting no module outside `src/core/ops` exports a
document-mutating function. Mutations have exactly one home, so undo/redo cannot be
forgotten by a new feature.

**Timeline:** architecture + `Ctrl+Z` in Phase 6; polished history UI in Phase 9. The hard
part is done in Phase 0.

---

## 8. Media processing pipeline

> **Canonical detail:** `ARCHITECTURE_REVIEW.md` §10 (storage layout, upload flow, lifecycle,
> cleanup) and §3 (full browser/server/worker data-flow diagram).

```
Upload ──▶ write to workspace/media/<assetId>/  (streamed, never buffered whole)
      ──▶ ffprobe ──▶ MediaMeta (exact rational frameRate, rotation, duration)
      ──▶ [Phase 10] transcode ──▶ proxy H.264 faststart for smooth preview
      ──▶ ffmpeg ─▶ 16kHz mono WAV ──▶ TranscriptionProvider (worker)
      ──▶ segmentWords() (src/core, pure) ──▶ SubtitleSegment[] ──▶ project.json
```

**Storage:** local filesystem, keyed by **server-generated `assetId`** — never by filename.
`filename` is display metadata only and is never joined into a path. The asset ID is minted
_before_ the upload begins, so the destination path is safe and a failed upload leaves an
empty, sweepable directory rather than a half-named file.

```
workspace/
├── projects/<projectId>/
│   ├── project.json
│   └── media/<assetId>/source.mp4      # original, never modified
│                    /proxy.mp4         # derived
│                    /audio.wav         # derived
│                    └──<fontId>/X.ttf  # font assets live here too
└── tmp/                                 # job scratch, GC'd on startup and after each job
```

- **FFmpeg is spawned as a child process** with an **argv array, never a shell string**
  (security S-5). Progress from `-progress pipe:1`; cancellation via `AbortSignal` →
  `SIGTERM`, then `SIGKILL` after a grace period. Every process has a wall-clock timeout.
- **Worker threads** run jobs off the event loop. No Docker on this machine, so job isolation
  is a thread + a process-per-FFmpeg, not a container. Adequate at this clip length; the job
  interface keeps a remote worker possible.
- **Artifacts are disposable and derived**, never in-place, always with `derivedFrom` +
  the exact `transform` args recorded so any artifact can be rebuilt.
- **Job output goes to `tmp/`** and is moved into `media/` only on success, so a cancelled
  job never leaves a half-written artifact in the media tree.
- **Browser uploads must be streamed to disk**, not buffered. `request.formData()` buffers
  entirely in memory and will OOM on a large video — the single most likely production
  failure. Designed in from Phase 1, not retrofitted.
- **The video never returns to the server after upload.** After ingest it is a static asset:
  playback streams from `/media`, export re-reads it from disk. This is the key structural
  simplification of the pipeline.

---

## 9. Module boundaries

**Phase 0 shape — one package, one enforced boundary:**

```
src/core/     pure. no react, no dom, no node builtins, no ffmpeg.
              document model, zod schema, invariants, migrations, style resolver,
              segmentation, ALL timeline operations, undo ops, time utilities.
src/server/   fastify routes, ffmpeg wrappers, job runner, transcription providers,
              file storage adapter. Node-only.
src/web/      React UI, stores, components, preview renderer. Browser-only.
```

**Enforcement:** an ESLint `no-restricted-imports` rule plus a test asserting `core` imports
no `react` / `node:fs` / `child_process` / `fastify`. Automated, because a convention that is
only documented is a convention that breaks by Phase 6.

**Package extraction is deferred, not abandoned** (`ARCHITECTURE_REVIEW.md` §2):

| Extracted     | Phase   | Trigger                                                                               |
| ------------- | ------- | ------------------------------------------------------------------------------------- |
| `render-dom`  | **7**   | Preview is written; it is the first `core` code that must be isolated as browser-only |
| `render-ass`  | **8**   | Export is written; a pure string function, so extraction is mechanical                |
| `media`       | **11+** | Transcription and FFmpeg share a job shape and start to genuinely co-evolve           |
| monorepo root | **7**   | pnpm workspaces, once ≥2 packages exist                                               |

The end state is the four-package monorepo proposed in the first draft. The difference is
that the boundary is **exercised by ~5 phases of real code before it is formalised**, so the
rules are written from evidence rather than prediction.

**Server API surface (thin, deliberately):**

```
POST   /api/projects                create
GET    /api/projects                list
GET    /api/projects/:id            load (migrated + validated)
PUT    /api/projects/:id            save document JSON
POST   /api/projects/:id/assets     upload (streamed to disk)
GET    /media/:assetId/:file        media playback (HTTP Range)
POST   /api/jobs                    enqueue {projectId, kind, params}
GET    /api/jobs/:id                status + progress
POST   /api/jobs/:id/cancel
GET    /api/jobs/:id/artifact       download result
GET    /api/events                  SSE stream of job updates
```

The server holds **no business logic** — it persists, queues, and delegates. Every decision
lives in `core` or a provider adapter, so the same logic is reachable from tests, the worker,
and later a CLI.

---

## 10. Identified risks

| #    | Risk                                                                                                                                                                                       | Severity | Mitigation                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1  | **Upload buffering OOM** on large files                                                                                                                                                    | Critical | Streamed multipart from Phase 1; add size limits + a documented max. Test with a 2GB file.                                                                                                                                                                  |
| R-2  | **Preview ≠ export fidelity** — the product's core promise                                                                                                                                 | Critical | Single resolver + shared schema; **text wrapping done once in `core`**; export lands at Phase 8 to gate all later styling; parity tested per-property against a versioned matrix, not assumed                                                               |
| R-3  | ~~**libass unavailable** in the installed FFmpeg~~                                                                                                                                         | ~~High~~ | **RESOLVED — verified present**: `ffmpeg -filters` lists `ass` and `subtitles`; build config includes `--enable-libass`. Re-verify if FFmpeg is upgraded or the binary is swapped                                                                           |
| R-4  | **Time model drift** (ms vs frames vs floats)                                                                                                                                              | High     | Integer ms everywhere; one `time.ts`; **exact rational fps stored as a num/den pair**, converted only in `BigInt`; `frame` is derived and never stored. Assuming 30fps on a 29.97 source drifts ~3.6s/hour — worked tables in `ARCHITECTURE_REVIEW.md` §6.2 |
| R-5  | **R-anchored text positioning** in libass vs. normalized DOM positioning                                                                                                                   | High     | Normalized position in the document; each renderer maps it. Test margins/insets explicitly — this is where exporters usually break.                                                                                                                         |
| R-6  | **Font substitution** in export (missing weights, fallback faces)                                                                                                                          | High     | Explicit font files, `fontsdir`, verify glyph coverage at upload.                                                                                                                                                                                           |
| R-7  | **Timeline performance** — thousands of segments, per-frame work                                                                                                                           | Medium   | Binary search for active segment; virtualized timeline; memoized selectors; profile before optimizing.                                                                                                                                                      |
| R-8  | **Undo/redo memory** on large documents                                                                                                                                                    | Low      | Snapshot strategy is fine at 30s–1min; revisit only if profiling says otherwise.                                                                                                                                                                            |
| R-9  | **Re-transcription destroys manual edits**                                                                                                                                                 | Medium   | `source` + `locked` per segment (PRODUCT T-07); explicit, undoable operation.                                                                                                                                                                               |
| R-10 | **Segmentation quality** — bad line breaks read as "bad product"                                                                                                                           | Medium   | Reading-speed + max-chars heuristics, manual line-break override, word-boundary-aware split. This is a quality feature, not a detail.                                                                                                                       |
| R-11 | **Core boundary erosion** — `core` starts importing React                                                                                                                                  | Medium   | Automated boundary lint; treat violations as build failures.                                                                                                                                                                                                |
| R-12 | **No Docker/GPU** limits isolation and encode throughput                                                                                                                                   | Low      | In-process workers are sufficient at this clip length; interface keeps a remote worker possible.                                                                                                                                                            |
| R-13 | **Schema version mismatch** across builds                                                                                                                                                  | Medium   | Versioned migrations, pure and tested; unknown future version fails loudly.                                                                                                                                                                                 |
| R-14 | **Over-scoping** — building styling/animation before the edit loop works                                                                                                                   | High     | Phase gates in `IMPLEMENTATION_PLAN.md`; per-phase "Do not build" lists; no fake UI                                                                                                                                                                         |
| R-15 | **`{\an}` anchor ↔ normalized DOM position** — the largest _unknown_ in the parity matrix                                                                                                  | High     | Fixture-driven mapping test written **before** the full export. Most likely source of Phase 8 rework. Not a correctness risk, a cost risk                                                                                                                   |
| R-16 | **`\fsp` collision** between letter spacing and line height — both map toward the same ASS tag                                                                                             | Medium   | Documented product decision (recommend: line height wins). Shared tested translation in `core`, never per-renderer                                                                                                                                          |
| R-17 | **Stroke width ≠ libass border scale**                                                                                                                                                     | Medium   | Almost certainly needs an empirical calibration constant, derived by fixture comparison at Phase 8, not assumed                                                                                                                                             |
| R-18 | **ASR word-timing quality varies by provider and audio**                                                                                                                                   | Medium   | Bake-off on 3–4 real clips before committing. If output is poor, the fix belongs in segmentation (Phase 5), not in the provider choice                                                                                                                      |
| R-19 | **Font licensing** — shipping a font file to a server for export                                                                                                                           | Low      | Depends on the chosen fonts; a product/legal decision, not technical. Flagged now, resolved when fonts are selected                                                                                                                                         |
| R-20 | **Document growth** — whole-document undo snapshots over years of use                                                                                                                      | Low      | Fine at MVP scale. Noted so it is a surprise at Phase 10, not at launch                                                                                                                                                                                     |
| R-21 | **Seeking in large / VFR sources** — the video element seeks in float seconds and may land on a non-keyframe, causing multi-second stalls that read as "the editor is slow"                | Medium   | Found by the architecture↔product check (`ARCHITECTURE_REVIEW.md` §17.2). Answer depends on proxy availability, so **not solved in Phase 0/2**. Decide at Phase 10 with proxy transcoding                                                                   |
| R-22 | **Worker-produced mutations bypassing undo** — if the client adopts the server's document wholesale, the undo stack is incoherent and the biggest change in the document has no undo entry | High     | **RESOLVED by invariant I-20** (`ARCHITECTURE_REVIEW.md` §8.1): the client is the only writer of the document; workers return results, applied as labelled ops                                                                                              |
| R-23 | **Animation colliding with static transforms** — undefined precedence presents as nondeterminism                                                                                           | Medium   | **RESOLVED by invariant I-19**: animation wins for its property, for its window; resolver applies `resolveAnimation` last                                                                                                                                   |

---

## 11. Decision register

> **Superseded by `ARCHITECTURE_REVIEW.md` §1**, which re-evaluated each decision and
> assigned a LOCKED / DEFERRED verdict. Summary:

| #    | Decision                                | Verdict                      | Rationale in one line                                                                                                                                                              |
| ---- | --------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Monorepo / package split                | **DEFERRED → Phase 7**       | Four packages at Phase 0 was fragmentation. A package with one consumer is a folder with extra build config. The `core` boundary is what matters and is enforceable today via lint |
| D-2  | FFmpeg + libass (ASS) export            | **LOCKED**                   | Verified available; pure `document → .ass` transformation; reversing touches exactly one module                                                                                    |
| D-3  | Zod-validated JSON files, no DB         | **LOCKED**                   | The document is JSON, so a file is the database                                                                                                                                    |
| D-4  | Snapshot / pure-op undo-redo            | **LOCKED, moved to Phase 0** | Originally deferred to Phase 9 — that was a mistake. Cheap now, an audit later                                                                                                     |
| D-5  | First transcription provider            | **DEFERRED**                 | A hosted API is the default, but the interface is what must be locked. Swap cost doesn't discriminate between providers; onboarding cost does                                      |
| D-6  | Parametrised animation, not keyframes   | **LOCKED**                   | Covers the MVP animation set; keyframes later via a type union, so no model change                                                                                                 |
| D-7  | Vite SPA (not Next.js)                  | **LOCKED**                   | Frontend is a static bundle; SSR adds nothing and complicates streamed upload                                                                                                      |
| D-7b | Fastify specifically                    | **DEFERRED → Phase 1**       | A proportionate choice, but at this surface size bare `node:http` is a real option                                                                                                 |
| D-8  | CSS approach (Tailwind vs. CSS Modules) | **DEFERRED → Phase 7**       | A UI decision. The subtitle style system is data-driven and unaffected                                                                                                             |
| D-9  | Text background / border radius         | **REMOVED from the model**   | libass cannot render a background box. Shipping the control would be a control that lies                                                                                           |

**Locked decisions are recorded so future phases do not re-litigate them. Deferred decisions
are explicitly _not_ closed — each names the phase at which it is revisited.**
