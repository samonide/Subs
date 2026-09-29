# IMPLEMENTATION_PLAN.md — Subtitle Studio

Companion to `PRODUCT.md` (what), `ARCHITECTURE.md` (how/why), and `ARCHITECTURE_REVIEW.md`
(canonical decisions, models, and risk analysis).

This document is the **sequence**: what gets built, in what order, and what must be true
before the next phase starts.

> **This is v0.2**, rewritten after the architecture review. The original 16-phase plan had
> four structural problems, all corrected below: a "Testing" _phase_ (testing is a criterion
> on every phase, not a phase), a 4-package scaffold (fragmentation — deferred to Phase 7),
> undo/redo deferred past the timeline (a shipped defect — moved to Phase 0/6), and
> feature-bucket phases rather than engineering steps.

---

## How to read this plan

Every phase has **Goal**, **Why it exists**, **Dependencies**, **Scope**, **Exit criteria**,
and **NOT included**.

The **NOT included** list is the most important part of each phase. It is a commitment: these
are the tempting scope-creep items to _refuse_ while the phase is in flight.

**The no-fake-UI rule, applied throughout:** if a control is not wired to real behaviour, it
does not ship in that phase. A visually complete editor backed by stubbed timing is worse
than a sparse honest one — it locks in the wrong model and costs more to remove than to
build. Every NOT-included list is enforced.

**Phase dependencies are real.** Do not start a phase until the previous one genuinely
passes its exit criteria.

**MVP boundary: Phases 0–8.** That is the smallest thing that proves the architecture. See
§MVP below.

---

## Agent Development Rules

Binding on any agent — OpenCode, Pi, Claude, or otherwise — working in this repository.
Derived from the Karpathy guidelines, the architecture skill's boundary doctrine, and the
observed failure modes of long multi-phase agent builds.

### The rules

1. **Inspect before modifying.** Read the files you are about to change, and the modules
   they import. Never edit code you have not read in this session.

2. **Read the governing documents before coding.** Minimum: `IMPLEMENTATION_PLAN.md` (the
   current phase), `ARCHITECTURE_REVIEW.md` (the relevant section), and
   `DESIGN_PRINCIPLES.md` if the work touches UI. A phase that contradicts a document is
   a defect in the phase, not a licence to improvise.

3. **Never implement a future phase without explicit approval.** "I got ahead of myself and
   also built Phase 7" is a failure, however good the code. Stay inside the phase's scope
   and its **NOT included** list.

4. **Never replace working architecture without evidence.** If an existing boundary,
   abstraction, or invariant looks wrong, say so in the report with concrete reasoning.
   Do not quietly replace it. The document model has already been audited twice; a third
   unevidenced rewrite is a regression, not an improvement.

5. **Prefer the smallest implementation that satisfies the current phase's exit criteria.**
   If 200 lines could be 50, write 50. If a function is only used once, do not abstract it.

6. **Do not add a dependency without stating the justification** in the report. "It's
   popular" is not a justification. A dependency added in a phase where nothing needs it is
   a premature abstraction with a maintenance cost.

7. **Do not create an abstraction without a real, named consumer.** This is why the
   monorepo split was deferred (D-1) — three of four proposed packages had no second
   consumer. "We will need it later" is not a consumer.

8. **Keep core business logic independent of UI.** `src/core` must not import React, the
   DOM, Node builtins, or FFmpeg. This is enforced by lint _and_ a test. If a core function
   seems to need one of those, the function is in the wrong place.

9. **Keep provider-specific logic behind adapters.** Vendor response shapes may appear in
   exactly one place: the provider adapter. Nothing above the normalizer may know which
   provider produced a transcript.

10. **Do not fake functionality.** A control not wired to real behaviour does not exist. A
    stubbed timeline is worse than no timeline.

11. **Do not hide incomplete functionality behind polished UI.** If something is partial,
    the UI must not pretend otherwise. An honest "not yet" beats a convincing lie.

12. **Tests are part of the implementation, not a cleanup phase.** Write the test with the
    code. A phase is not complete with failing tests, and there is no later "testing phase."

13. **Verify behaviour; do not trust generated code.** Run the tests. Run the typecheck. Run
    the build. Assert the exit criteria — actually assert them, do not assert that you
    believe they hold. A test that asserts nothing is worse than no test.

14. **Update documentation when architecture changes.** If you add an invariant, change a
    boundary, or reverse a decision, update `ARCHITECTURE_REVIEW.md` in the same change. A
    document that lags the code is worse than no document.

15. **Preserve the project document format.** Any change to the document model requires a
    `schemaVersion` bump and a tested migration. Projects must outlive the code that wrote
    them.

16. **Do not continue automatically into the next phase.** When the current phase's exit
    criteria are satisfied, **stop and report.** The next phase begins only on explicit
    instruction.

17. **Leave the repository coherent.** Every phase ends with the repo in a state where
    build, typecheck, lint, and tests all pass. A phase that leaves broken state is not
    finished, regardless of how much of the work is done.

18. **Make one ruling at a time, and record it.** When something is ambiguous and the
    documents don't settle it, decide, implement, and state the ruling plus what it costs if
    wrong — in the phase report. Do not silently pick an interpretation.

### The stop rule, stated plainly

> **When the phase exit criteria are met: run the verification, write the report, and
> stop.** Do not begin the next phase. Do not "quickly" fix an adjacent thing. Do not
> refactor something you noticed. Report the observation and let the human decide.

This rule exists because the characteristic failure of a long agent build is not doing too
little — it is doing too much, well, without asking. The report is the deliverable; the
next phase is a separate decision.

---

## Phase Execution Contract

The standard shape of every implementation phase. Follow it literally.

### BEFORE CODING

1. **Read the phase spec** in this document, in full, including **NOT included**.
2. **Read the governing sections:** the relevant `ARCHITECTURE_REVIEW.md` section and, for
   UI work, `DESIGN_PRINCIPLES.md`.
3. **Inspect the current implementation** — what exists now in the files you will touch.
4. **Identify dependencies** on prior phases; confirm they are actually done, not assumed.
5. **Identify the boundaries** this work crosses (`core` / `server` / `web`) and confirm the
   change respects them.
6. **State the plan and the verification** for each step before writing code
   (`step → verify: check`). If a step has no verification, it is not a step.

### DURING CODING

7. **Implement only the current phase.** Nothing from **NOT included**.
8. **Keep changes incremental** — one coherent, working step at a time; commit after each
   step that passes checks.
9. **Write the test with the code**, not after. Target the phase's exit criteria directly.
10. **Avoid unrelated refactors.** If you find a problem outside the phase, record it in the
    report; do not fix it.
11. **Follow the existing patterns.** Match the style of the code you are working in.

### AFTER CODING

12. **Run the full gate:** tests → typecheck → lint → build. All green, or the work is not
    finished.
13. **Inspect the files you changed.** Read them back. Look for leftovers, dead code,
    commented-out blocks, and half-finished thoughts.
14. **Verify each exit criterion explicitly**, one by one, with the evidence that proves it.
15. **Update the documentation** if any decision, invariant, or boundary changed.

### FINAL REPORT

State all of the following. A report missing any of these is incomplete:

- **What changed** — in plain terms
- **Why** — the reasoning, especially for any judgment call
- **Files changed** — with paths
- **Tests added** — what they cover and why that matters
- **Commands run** — and their results
- **Known limitations** — what is incomplete or deliberately deferred
- **Deferred work** — out-of-scope items noticed and left alone
- **Rulings made** — any ambiguity decided unilaterally, with what it costs if wrong
- **Recommended next phase** — and confirmation that this one is complete

Then **stop.**

---

## Phase order — the reasoning, stated up front

Three orderings are load-bearing, and getting them wrong is expensive:

1. **The style resolver and undo/redo come before any UI (Phase 0).** Both become expensive
   to retrofit once a UI exists, because feature authors start writing imperative
   side-effects. This is why Phase 0 is not "scaffolding" — it is where the three
   expensive-to-move decisions get made: the pure core, the style cascade, and the op-based
   mutation model.

2. **Playback (Phase 2) before the timeline (Phase 6).** The video element is the time
   authority. Everything downstream assumes app time _is_ video time; establishing that
   before the timeline exists prevents a class of sync bugs that are far cheaper to prevent
   than to fix.

3. **Export (Phase 8) before advanced styling (Phase 10).** Export is the _parity test_ for
   the style model. If it arrives after styling is complex, a non-expressible property is
   discovered when it is most expensive to fix. Export gates everything stylistic after it.

A fourth, smaller one: **jobs (Phase 3) before the slow job (Phase 4).** The job pattern is
built on a 5-second extraction rather than a 5-minute transcription, because iterating the
job lifecycle is fast only while the job is small.

---

## Phase 0 — Foundation

**Tier:** FOUNDATION · **Goal:** a pure, tested core that every later phase builds on, with
boundaries enforced by CI.
**Why it exists:** the style resolver, timing model, and undo/redo architecture are the
three things that become expensive to retrofit. They need no UI to be correct, and they are
correct _only_ if nothing else exists yet to corrupt them.
**Dependencies:** none

**Scope**

- TypeScript strict + `noUncheckedIndexedAccess`; Vitest; ESLint + Prettier.
- `src/core/` (pure — no React, no DOM, no Node builtins, no FFmpeg):
  - ID factory (stable, unique, never derived from content)
  - `time.ts` — integer ms canonical; exact rational fps as a num/den pair; `BigInt`
    converters; ms→ASS centiseconds, ms→SRT timecode
  - Document types (per `ARCHITECTURE_REVIEW.md` §5)
  - Zod schema + `validateDocument()` enforcing invariants I-1…I-14
  - `migrations.ts` — pure, table-driven
  - `resolveStyle()` / `resolveEffective()` — the four-level cascade, returning a
    **fully populated** `ResolvedStyle`
  - `segmentWords()` — word stream → readable segments
  - `splitSegment()` / `mergeSegments()` / `moveSegment` / `retimeSegment` — pure timeline
    ops, with the exact semantics in `ARCHITECTURE_REVIEW.md` §8.2
  - **Undo/redo as a pure op-stack** (see `ARCHITECTURE_REVIEW.md` §9), including the
    batching rule (a drag and a typing burst are each _one_ entry)
- ESLint boundary rule: `core` may not import React/DOM/`node:fs`/`child_process`/`fastify`.
  Plus a test asserting the same, so a lint misconfiguration cannot silently permit a breach.

**Exit criteria**

- `pnpm build` and `pnpm test` green on a clean checkout.
- The `core` boundary test passes — verified by a test, not by convention.
- Cascade resolves correctly across all four levels; partial overrides inherit correctly.
- `ms↔frame` exact for 30, 29.97 (`30000/1001`), and 60; a 1-hour 29.97 timeline does not
  drift (asserted with the verified ~3.6s/hr figure as the thing being avoided).
- `migrate()` is identity at v1; validator catches overlap, zero-length, dangling refs, and
  a `styleId` + `styleOverride` collision.
- Every op in `src/core/ops` is pure: a test asserts no mutation function mutates its input.
- **Invariant I-20 holds:** a test asserts that no module outside `src/core/ops` can mutate a
  document, and that a worker-supplied _result_ is applied through an op rather than by
  replacing the document.
- `moveSegment` preserves duration; `retimeSegment` moves one edge and clamps words;
  `splitSegment` splits at a word boundary and rebuilds both halves' `text` from their words
  (I-8). Each asserted.
- No non-pure function exists in the resolver.

**NOT included:** Any UI. Any HTTP. Any FFmpeg. Any package split. Any provider. Animation
resolution (I-19 is a Phase 10 concern; the _rule_ is recorded now, the code comes later).

---

## Phase 1 — Ingest & Project Persistence

**Tier:** MVP · **Goal:** a video on disk, probed, in a saveable project.
**Why it exists:** proves the streamed-upload design and gives every later phase a real project
to operate on. Getting buffering wrong here poisons everything downstream.
**Dependencies:** Phase 0

**Scope**

- Server: project CRUD; Zod + invariant validation on **save and load**.
- **Streamed** upload to `workspace/projects/<id>/media/<assetId>/` — `assetId` minted
  _before_ the upload; `filename` is display metadata only, never a path (security S-1/S-2).
- Extension allow-list, size cap enforced during streaming, argv-only FFmpeg/ffprobe
  invocation, bind to `127.0.0.1` (S-3/S-4/S-5/S-14).
- `ffprobe` → `MediaMeta` (exact rational fps, rotation, display dimensions).
- `/media` endpoint with HTTP Range, for playback.

**Exit criteria**

- A 2GB video uploads with flat measured RSS — no buffering.
- Save → reload → `validateDocument` → deep-equal to what was saved.
- A corrupted document yields a readable error, not a stack trace.
- A 90°-rotated phone video probes with `rotation: 90` and correct display dimensions.
- A path-traversal attempt via a crafted filename is rejected.
- A non-media file yields a typed error; the server does not crash.

**NOT included:** Playback UI. Timeline. Transcode. Waveform. Thumbs. Resumable upload.

---

## Phase 2 — Playback & Time Base

**Tier:** MVP · **Goal:** video plays, and the app has exactly one clock.
**Why it exists:** the video element is the time authority. Everything downstream assumes
app time is video time.
**Dependencies:** Phase 1

**Scope**

- `<video>` wired to the `sourceVideo` asset; `playbackStore`.
- rAF loop reading `video.currentTime` — the **single** `Math.round(t*1000)` conversion point
  in the entire application. No independent timer exists.
- `msToFrame` / `frameToMs` using the exact rational pair.
- Frame stepping with `requestVideoFrameCallback` where available.
- Minimal transport UI (a time readout and a seek bar). This is a technical base, not the
  timeline.

**Exit criteria**

- 60s of playback with zero drift between the video clock and the reported ms (asserted with
  tolerance = 1 frame).
- Frame step lands on the exact expected frame at 29.97 and 30.
- Play/pause/seek/rate all settle to a consistent reported time.

**NOT included:** The timeline. Any subtitle UI. Waveforms. Audio mixing UI.

---

## Phase 3 — Audio Extraction & Job Infrastructure

**Tier:** MVP · **Goal:** the job system, and a normalized audio track.
**Why it exists:** jobs are the substrate for extraction, transcription, and export. Building
the pattern on a 5-second job makes iterating the lifecycle fast; building it first on a
5-minute transcription does not.
**Dependencies:** Phase 1

**Scope**

- `JobRecord` + lifecycle (`queued → processing → completed | failed | cancelled`).
- `worker_threads` runner; concurrency cap.
- FFmpeg wrapper: `-progress pipe:1`, `AbortSignal` → `SIGTERM` then `SIGKILL`, wall-clock
  timeout, argv-only, protocol allow-list (S-5/S-6/S-7).
- `extract-audio` → 16kHz mono WAV. All FFmpeg output to `tmp/`, moved to `media/` only on
  success.
- Job API + SSE `/api/events`; `tmp/` and orphan GC.

**Exit criteria**

- Extraction completes well under realtime with monotonic progress reaching 1.0.
- Cancelling mid-job leaves no orphan ffmpeg process (asserted by process listing).
- A cancelled job leaves nothing partial in the media tree.
- Extracted audio duration matches the source within one audio frame.

**NOT included:** Transcription. Proxy transcode. Waveform display. Retry policy. Queue
depth control. Job prioritisation.

---

## Phase 4 — Transcription

**Tier:** MVP · **Goal:** normalized words on the document, via a swappable provider.
**Why it exists:** the provider interface must exist _before_ any provider, so that adding or
swapping one is a registry change and not a refactor.
**Dependencies:** Phase 3

**Scope**

- `TranscriptionProvider` interface + registry.
- The **normalizer** (Layer 2, `ARCHITECTURE_REVIEW.md` §4) with invariants U-1…I-7.
- **One** provider implementation (default: a hosted API — the choice is DEFERRED, not
  locked; it must sit behind the interface).
- `transcribe` job; `providerId`/`model` recorded as a provenance pointer; `synthesized`
  marking for providers without word timings.
- **The job returns a transcript result, not a document** (invariant I-20). The client
  applies it as a single labelled `applyTranscript` op, so the largest change in the
  document is undoable and the undo stack stays coherent.

**Exit criteria**

- A 60s clip yields ordered, non-overlapping units with plausible durations.
- Swapping providers is a one-file registry change with **zero** edits elsewhere (proves the
  abstraction).
- Missing API key fails before any work begins.
- A provider with no word timings yields `synthesized` units, verifiably marked as such.
- Normalizer rejects or clamps overlapping vendor output.
- **The client never adopts a server-produced document wholesale**; the transcript arrives as
  a result and is applied through `core/ops` (I-20).
- **Bake-off on 3–4 real clips** (product risk P-1): word-timing quality is acceptable, or
  the segmentation phase is where the fix belongs.

**NOT included:** Local Whisper. Translation. Re-transcription UX. Confidence UI. Vocabulary
hints beyond the interface field.

---

## Phase 5 — Subtitle Model & Segmented Document

**Tier:** MVP · **Goal:** readable, well-timed segments in a persisted document.
**Why it exists:** the ASR word stream is unreadable. Segmentation is where transcription
becomes subtitles, and where perceived product quality is won or lost.
**Dependencies:** Phase 4

**Scope**

- `segmentWords()` heuristics: max chars/line, max lines, reading-speed cap, word-boundary
  breaks, never splitting mid-word.
- `lineBreaks` as word indices.
- The transcribe job now writes segments into `project.json`.
- Segment list UI (deliberately **not** a timeline yet) showing the selected segment's words.

**Exit criteria**

- A real-transcript fixture produces readable lines, each within the reading-speed cap or
  explicitly flagged.
- `text` ↔ `words` round-trips exactly, including spaces and punctuation.
- Segments survive save/reload with timings intact.
- The validator flags overlap and zero-length rather than silently fixing them.

**NOT included:** The timeline. Styling. Reflow-on-edit. Clever segmentation. Punctuation
models.

---

## Phase 6 — Timeline Editor + Undo/Redo

**Tier:** MVP · **Goal:** a real timeline, and the ability to undo a mistake on it.
**Why it exists:** timing correction is the core editing act — and a timeline without undo is
a defect, not a pragmatic trade. The op-stack ships in Phase 0; the UI lands here.
**Dependencies:** Phases 2, 5

**Scope**

- `timelineStore` — zoom, scroll, px-per-second, track heights. **Entirely ephemeral**, never
  in the document.
- Segment bars positioned by real ms; only visible segments in the DOM.
- Click / shift-click / marquee selection; drag to move; drag edges to resize.
- Snapping to frame and word boundaries (source selectable).
- `splitSegment` at a word boundary; `mergeSegments` for adjacent segments.
- Playhead and scrub, synchronised bidirectionally with the video.
- **Editing text while the video plays** — the caption is a live overlay and typing into it
  does not stop playback (`PRODUCT.md` §17B). This is a core-loop constraint, cheap now and
  disruptive later because it affects the overlay's interaction with the rAF loop.
- `Ctrl+Z` / `Ctrl+Shift+Z`; a minimal history list.
- One track only.

**Exit criteria**

- Drag moves; edge-drag retimes to the millisecond; snapping engages at word boundaries.
- **Dragging the body preserves duration; dragging an edge changes one bound only.**
- Split is word-exact and merge is its exact inverse; `text` is rebuilt from words, not sliced.
- Undo/redo covers text edit, move, resize, split, merge — verified per operation.
- **A drag is one undo entry; a typing burst is one undo entry** (debounced, not per
  keystroke). Otherwise history is worthless after one sentence.
- **Text can be edited while the video plays**, without stopping playback.
- Full keyboard operability of the core loop, not mouse-only gestures.
- 500-segment project scrolls and drags without visible jank (measured).
- No document state leaks into `timelineStore`/`selectionStore` (asserted by test).

**NOT included:** Multi-track. Word lanes. Track headers. Auto-scroll. Command palette.
Advanced shortcuts.

---

## Phase 7 — Styling & Live Preview

**Tier:** MVP · **Goal:** styled subtitles rendering over the video, via the shared resolver.
**Why it exists:** proves the resolver in a real runtime and makes the product legible. Also
where the **CSS approach** and the **package split** are decided.
**Dependencies:** Phase 6

**Scope**

- Built-in default style + MVP properties — **no background box, no border radius** (libass
  cannot render them; see `ARCHITECTURE_REVIEW.md` §7.1).
- Preview renderer consuming `resolveStyle()` from `core`.
- Normalized position + safe-area presets.
- In-place text editing over the video (contenteditable overlay).
- Track-level style inspector editing the named style by ID.
- Font registry plumbing: font files as assets, `FontFace` in preview.
- **Extract `render-dom` as a package**; **adopt the monorepo root** (D-1 revisited here).
- **Decide the CSS approach** (Tailwind vs. CSS Modules) — a UI decision, deferred to here.

**Exit criteria**

- Styled subtitles render over playing video and update live as the style changes.
- A track style change updates every segment on that track at once.
- A segment override changes one segment without touching the track style.
- The same style at 720p and 1080p yields the same relative placement (asserted).
- `core` remains boundary-clean after the package split.

**NOT included:** Animation. Effects. Per-word overrides. Font upload UI. Export.

---

## Phase 8 — Export & Renderer Parity

**Tier:** MVP · **Goal:** burned-in video out, and _proof_ the preview matches it.
**Why it exists:** the product's core promise and its biggest risk. Export lands before
advanced styling so a non-expressible property is discovered while the style model is still
small enough to fix cheaply.
**Dependencies:** Phase 7

**Scope**

- `render-ass` — pure `ProjectDocument → .ass` string, no Node APIs.
- ASS mapping for every MVP property, including the `\pos` / `{\an}` anchor mapping (the
  largest known unknown — R-15).
- Export job: FFmpeg `subtitles` filter driven by the generated ASS, from the **source**
  video, never the preview proxy.
- SRT + VTT generation from the same document.
- **Text wrapping implemented in `core`** and consumed by both renderers (not re-wrapped in
  the browser) — the single most valuable parity decision.
- Parity fixture harness: DOM render vs. ffmpeg frame grab, compared per property against
  `ARCHITECTURE_REVIEW.md` §7 with declared tolerances.
- `resolveAnimation` as an **honest identity stub** — not fake; nothing to animate yet, and
  the renderer must not pretend otherwise.

**Exit criteria**

- A 60s clip exports a playable MP4 with burned-in subtitles.
- SRT re-import reproduces the same text and timings.
- **Parity harness green** — every property in the matrix within its declared tolerance.
  Anything exceeding tolerance fails the build.
- Export reports progress, is cancellable, and does not block the UI.
- The `{\an}`/position mapping is verified against fixtures, not assumed (closes R-15's cost
  risk).

**NOT included:** Animation. Other containers. Resolution presets. Hardware encoding. Batch
export. Rounded text boxes.

> **Highest-risk phase in the plan.** If libass cannot express some style faithfully, the
> _style model_ is wrong and must change now — while only MVP styling exists. That is exactly
> why it sits here and not at 12.

---

## Phase 9 — Multi-Track, Shortcuts, Autosave

**Tier:** MVP+ · **Goal:** layered captions and a keyboard-driven workflow.
**Why it exists:** one track cannot express a translation layer, a commentary layer, or a
duplicate for emphasis. Once export is proven, layering is cheap.
**Dependencies:** Phase 8

**Scope**

- Track CRUD, reorder, visibility, lock, per-track style — as stacked lanes.
- Full keyboard shortcut set and command palette.
- Debounced autosave; a polished history UI.
- Multi-select styling operations.

**Exit criteria**

- Two tracks render and export simultaneously with independent styles.
- A locked track rejects drag edits.
- Autosave survives a browser refresh mid-edit.
- No shortcut fires while focus is in a text input.

**NOT included:** Track compositing modes. Solo/mute mixer semantics. Track templates.

---

## Phase 10 — Word-Level Timing, Animation, Effects

**Tier:** ADVANCED · **Goal:** the expressive layer — karaoke, per-word styling, motion.
**Why it exists:** these are the capabilities that make it feel like Photoshop, and all three
build on word timing — which only becomes trustworthy once one track, export, and undo are
solid. Grouping them here is honest: they are one capability area, not three phases.
**Dependencies:** Phase 9

**Scope**

- Word lane + word retiming; words clamped to their segment on edge-drag.
- Word-level style overrides (cascade layer 4); karaoke highlight driven by the playhead.
- `resolveAnimation` real (replacing the Phase 8 stub); entrance/exit/emphasis with word
  stagger; **both** renderers for every animated property. **Invariant I-19 applies:**
  animation wins over a static `transforms` entry for the same property, for its window, and
  the resolver applies animation _last_.
- Effects list — the first tier of the extensibility seam.
- Proxy transcode for smooth preview; **decide the VFR/large-file seeking strategy (R-21)**;
  long-file robustness; render retry/resume/cleanup.

**Exit criteria**

- Word highlight tracks the playhead exactly at each word's boundaries.
- Dragging a segment edge clamps its words; no word escapes its segment.
- Animation matches between preview and export.
- **A static transform and an animation on the same property resolve deterministically**
  (I-19), and static values resume after the animation window.
- A property added to the model appears in **both** renderers in the same commit.
- The Phase 8 identity stub is fully replaced — no dead code path remains.

**NOT included:** Keyframe timeline. Motion paths. Batch export. Distributed rendering.

---

## Deferred (deliberately, with reasons)

| Item                                              | Why deferred                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Monorepo / package split                          | Phase 7, when a second runtime exists (D-1)                                          |
| Local Whisper provider                            | Adds a Python runtime before anything works; the interface already supports it (D-5) |
| First-provider choice beyond "hosted API default" | Config choice, not architecture (D-5)                                                |
| Keyframe animation                                | Not needed yet; arrives as a type union, no model change (D-6)                       |
| True rounded text boxes                           | Only via FFmpeg overlay composite; stroke approximation first (§7.1)                 |
| Proxy transcoding                                 | Only when playback is actually janky; premature optimization                         |
| Confidence UI, re-transcription UX                | Refinements on a working pipeline                                                    |
| Font upload UI                                    | Registry plumbing in Phase 7; real upload UX later                                   |
| SRT/VTT _import_                                  | Export-only in MVP                                                                   |
| Command palette, themes, i18n                     | Convenience                                                                          |
| Playwright E2E                                    | Phase 6+, when there is real UI to protect                                           |
| Auth, cloud, multi-user, billing                  | Explicitly out of scope                                                              |

---

## MVP definition

> A user provides a short video. The app obtains a transcription, generates timestamped
> subtitles, shows them synchronised with the video, lets the user edit their text and timing
> and apply basic styling, previews the result live, and exports a subtitled video.

**MVP = Phases 0–8.** Upload → transcribe → segment → timeline-edit → style → preview →
export burned-in MP4 + SRT, with proven preview/export parity.

**Acceptance:** a user uploads a 45-second clip and goes from upload to a correctly timed,
styled, burned-in MP4 without the developer present.

**Not in the MVP:** multi-track, word-level styling, karaoke, animation, text background
boxes, effects, proxy transcoding, confidence UI, font upload UI, SRT import, command
palette, themes, i18n, auth, cloud.

**One honest concession:** the MVP has **no background boxes** on captions. That is a visible
feature, and it is the correct call precisely _because_ the alternative is shipping a control
that works in the editor and silently does nothing in the export. A stroke-based
approximation recovers the popular "black box" caption style with full parity later.

---

## Risk register by phase — when each must be resolved

| Phase  | Risk                                         | Consequence of ignoring                                                                           |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **0**  | `core` boundary not enforced by tooling      | Every later phase inherits a leaky core; preview/export parity becomes impossible                 |
| **0**  | Undo/redo adopted after a UI exists          | Feature authors write imperative side-effects; retrofitting becomes an audit, not an extraction   |
| **0**  | Timing model not exact                       | Irreparable drift (verified: assuming 30fps on 29.97 drifts ~3.6s/hr)                             |
| **1**  | Upload buffering                             | OOM on any real video; unfixable later without a protocol change                                  |
| **1**  | Security S-1/S-5/S-7 skipped                 | Local file inclusion / command injection via a crafted "video"                                    |
| **2**  | Two clocks (video + timer)                   | Irreparable timeline drift                                                                        |
| **5**  | Poor segmentation quality                    | Product _feels_ broken regardless of styling quality                                              |
| **7**  | Style properties authored in pixels          | Breaks every later resolution and export path                                                     |
| **8**  | `{\an}` anchor mapping assumed               | Most likely source of Phase 8 rework (R-15)                                                       |
| **8**  | Parity gaps accepted silently                | Style model must change while styling is already complex — the most expensive possible time       |
| **8**  | Worker results replacing the document (R-22) | Undo becomes incoherent after the first transcription; **prevented by I-20, asserted in Phase 0** |
| **10** | Animation/static transform collision (R-23)  | Presents as nondeterminism; **prevented by I-19**                                                 |
| **10** | VFR / large-file seeking stalls (R-21)       | Editor reads as "slow"; decided with proxy transcoding                                            |

---

## Immediate next step

**Phase 0 — Architecture & Foundation.** Concretely:

1. `git init` + `.gitignore` + `README.md` (recording the verified FFmpeg/libass capability
   output).
2. A **single** `package.json` at the root — pnpm, TypeScript strict, Vitest, ESLint +
   Prettier. No workspaces yet (D-1 deferred).
3. `src/core/`: IDs, `time.ts`, document types, Zod schema, invariant validator, migrations.
4. `src/core/style/`: `resolveStyle` / `resolveEffective` + the four-level cascade tests.
5. `src/core/ops/`: `splitSegment`, `mergeSegments`, and the **pure undo/redo op-stack**.
6. `src/core/segmentation/`: `segmentWords` + reading-speed tests.
7. The boundary lint rule and the test that asserts it.

Phase 0 ends with a green build, an enforced module boundary, a tested style resolver, a
tested undo/redo core, and **no UI**.

**Awaiting approval. No code written, no dependencies installed, no `package.json` created,
project not initialized.**
