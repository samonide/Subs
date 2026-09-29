# PRODUCT.md — Subtitle Studio (working title)

Status: **Draft v0.3** — Foundation stage, after the architecture + product/UX review
Scope: **Raw core application only.** No landing page, no auth, no pricing, no billing, no dashboard, no SaaS concerns.
Target input: short-form video, **30s – 5min** (design target 30s – 1min)

> **Companion documents.** `ARCHITECTURE_REVIEW.md` is canonical for technical decisions and
> models. `DESIGN_PRINCIPLES.md` holds the editor's UX/design philosophy and the North Star.
> `IMPLEMENTATION_PLAN.md` holds the phase order and the agent execution contract.

---

## North Star

> **You drop in a clip, and thirty seconds later you have captions that look like a
> designer made them.** The transcription is a starting draft, not the deliverable. Fixing
> and restyling that draft should feel like direct manipulation — dragging a caption 200ms
> later feels like moving a physical object, not editing a form. And when you export, the
> file you get is the file you saw.

Full statement and the disciplines behind it: `DESIGN_PRINCIPLES.md`.

---

## 1. Product overview

A desktop-class, browser-based application that takes a short video, transcribes its speech,
produces accurately timed subtitles, and lets a human edit, restyle, animate and re-time those
subtitles through a visual, non-linear editor, then exports a finished video with the subtitles
burned in (or as a sidecar file).

The differentiator is not transcription quality — it is the **editor**. Transcription is a
solved, purchasable commodity. The product is a precision subtitle authoring environment that
feels like a lightweight combination of Photoshop and CapCut's caption tools: layered,
animated, precisely timed text over video.

**Editorial stance:** the auto-generated transcript is a _starting draft_, not the answer.
Every timestamp, line break, word and style remains user-owned and user-editable.

---

## 2. Core problem

People who publish short-form video need burned-in subtitles, and the current options split
badly:

- **Auto-caption tools (CapCut, Descript)** produce serviceable text but give little control over
  exact timing, per-word styling, motion, or multi-track layering. The result looks generic.
- **Professional NLEs (Premiere, Resolve, After Effects)** can do all of it, but the cost in
  time and skill is enormous. Editing a 45-second clip's captions should not require a motion
  graphics workflow.
- **Manual subtitle editors (Aegisub, Subtitle Edit)** are powerful for _text files_, but are
  2D text-and-time tools with no visual styling model, no animation, and no video preview.

The gap is a tool that is **fast like an auto-caption tool** and **expressive like After Effects**,
scoped to the single job of making subtitles look good.

**Secondary problem:** transcription timestamps from ASR providers are good enough to be a
draft, but never good enough to ship. Subtitle timing is a craft — line length, reading speed,
line breaks, and lead-in/out all need human correction. Most tools under-invest here.

---

## 3. Core workflow

```
Video Upload
  → Media Ingest & Probe (ffprobe: duration, fps, streams, rotation)
  → Audio Extraction (ffmpeg → normalized 16kHz mono PCM/WAV)
  → Speech-to-Text (pluggable provider → words + segments + confidences)
  → Segmentation & Timestamp Model (words → readable, timed SubtitleSegments)
  → Subtitle Timeline (segments laid out on a time axis)
  → Visual Subtitle Editor (select / retime / retype / restyle)
  → Styling & Animation (style presets, per-track, per-segment, per-word overrides)
  → Preview (DOM/Canvas renderer consuming the same document as export)
  → Render / Export (server-side FFmpeg render driven by the same document)
```

**Critical invariant:** the preview renderer and the export renderer consume _the same
subtitle document_. Any style property that can be set in the editor must be expressible in
the export, and must look the same. This is the single most important architectural property
of the product and it is designed for from Phase 0.

---

## 4. Target user workflow

**Primary persona — the short-form creator.**
A creator with a 30–60s talking-head clip (interview cut, reel, tutorial, podcast excerpt)
who wants punchy, well-timed, on-brand captions. They care about: hook text, keyword emphasis,
safe-area placement (avoiding the caption area used by the platform UI), and reading speed.

**Secondary persona — the localization/QA editor.**
Someone correcting a transcript or re-timing subtitles for a market. They care about accuracy,
timing precision, and not having to redraw everything.

**Typical session:**

1. Drop in `clip.mp4`. See it immediately, playing, with audio.
2. Press _Transcribe_. Progress shown. Segments appear on the timeline, already populated.
3. Watch through, fix the words the ASR got wrong. Fix line breaks that read badly.
4. Drag a segment's edge 200ms later because it appeared before the speaker finished.
5. Split a long segment into two because the line is too long to read.
6. Apply a caption style preset ("Bold Pop", "Karaoke Highlight").
7. Nudge position up so the caption clears the platform's UI chrome.
8. Emphasize 2–3 keywords per line with a different color and a pop-in animation.
9. Preview at full speed. Nudge timings. Repeat 2–3 times.
10. Export. Burned-in MP4, or SRT/VTT sidecar.

**The product must never make step 3–5 feel like a chore.** Timings are measured in
milliseconds and adjusted by dragging, not by typing numbers.

---

## 5. Functional requirements

### Tier: MVP (required for the app to be useful)

| ID   | Requirement                                                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | Import a local video file (MP4/MOV/WebM) and probe its metadata.                                                                                                              |
| F-02 | In-browser video playback with frame-accurate seeking and current-time readout.                                                                                               |
| F-03 | Extract audio and produce a normalized 16kHz mono track for ASR.                                                                                                              |
| F-04 | Transcribe via a pluggable provider, returning words + timings + confidences.                                                                                                 |
| F-05 | Convert the raw word stream into readable `SubtitleSegment`s (line-breaking, max chars/line, max lines, reading-speed caps).                                                  |
| F-06 | Display all segments on a zoomable timeline, positioned by real time.                                                                                                         |
| F-07 | Select a segment; edit its text directly.                                                                                                                                     |
| F-08 | Drag a segment to move it; drag its edges to retime it, with millisecond precision.                                                                                           |
| F-09 | Split a segment at a point (by time, or at a word boundary). Merge two adjacent segments.                                                                                     |
| F-10 | Apply and edit a base subtitle style: font family, size, weight, fill, stroke (+width), shadow, background (+opacity/padding/radius), alignment, line height, letter spacing. |
| F-11 | Position the subtitle block (X/Y, and safe-area presets).                                                                                                                     |
| F-12 | Live preview: rendered subtitles composited over the playing video.                                                                                                           |
| F-13 | Multiple subtitle tracks, independently styled, individually visible/muteable.                                                                                                |
| F-14 | Persist the project document (local, server-side JSON) and reload it intact.                                                                                                  |
| F-15 | Export: burned-in video (FFmpeg) and SRT/VTT sidecar.                                                                                                                         |

### Tier: Advanced (after MVP is solid)

| ID   | Requirement                                                                     |
| ---- | ------------------------------------------------------------------------------- |
| F-20 | Word-level timing retained and used for karaoke/highlight effects.              |
| F-21 | Per-word and per-segment style _overrides_ on top of a track style (cascade).   |
| F-22 | Entrance / exit / emphasis animations, keyframe-free, parametrised.             |
| F-23 | Style presets, saved and reusable across projects/tracks.                       |
| F-24 | Undo/redo across all document mutations.                                        |
| F-25 | Full keyboard shortcut system and command palette.                              |
| F-26 | Transform: scale, rotation, opacity per segment/word.                           |
| F-27 | Multi-line layout control: manual line breaks vs automatic, line-level styling. |
| F-28 | Background job tracking for transcribe/render with progress and error recovery. |
| F-29 | Drag-and-drop reordering and vertical track stacking in the timeline.           |

### Tier: Future (explicitly deferred)

| ID   | Requirement                                                                             |
| ---- | --------------------------------------------------------------------------------------- |
| F-40 | Custom font upload / font discovery UI.                                                 |
| F-41 | Color themes, brand kits, safe-area templates per platform (TikTok/Reels/Shorts).       |
| F-42 | Video editing primitives: trim, split video, B-roll, image overlays, audio replacement. |
| F-43 | Batch processing, project folders, media libraries.                                     |
| F-44 | Translation / re-transcription into other languages with per-track styling.             |
| F-45 | Collaborative editing.                                                                  |
| F-46 | Text-to-speech / voiceover.                                                             |
| F-47 | Motion tracking, advanced compositing, 3D transforms.                                   |

---

## 6. Subtitle data model requirements

The single hardest requirement in this product: **styling must not be smeared across the
document.** The naive model (`{text, start, end, color, font, ...}`) cannot survive word-level
styling, multi-track layering, animation, or a shared preview/export renderer. It forces a
rewrite by Phase 9 at the latest.

**Required model shape — five separated concerns:**

1. **Content** — what the words are. `SubtitleSegment.text` plus ordered `SubtitleWord[]`.
2. **Timing** — when. Segment `startMs`/`endMs`; word `startMs`/`endMs`. Never in the content.
3. **Style** — how it looks. A **named, reusable, resolvable** style, not an inline blob.
4. **Animation** — how it moves. A named, reusable animation descriptor + parameters.
5. **Structure** — track membership, ordering, and track-level defaults.

**Model requirements:**

- **M-01 Stable IDs.** Every addressable object (track, segment, word, style, animation)
  has a stable, collision-free ID. IDs are how style overrides attach, how selection survives
  edits, and how undo diffs work. Never key on array index or text content.
- **M-02 Style indirection.** A segment references a style _ID_. Styles live in a project-level
  registry so N segments can share one style and updating it updates all of them — the
  behaviour a designer expects from a style panel. A segment may carry an **override object**
  for per-segment deviation without cloning the whole style.
- **M-03 Resolution cascade.** The effective style of a word is:
  `project default → track style → segment override → word override`, each layer overriding
  only the keys it specifies. This must be a single pure function used by _both_ renderers.
- **M-04 Partial styles are valid.** An override object is sparse. `undefined` means
  "inherit", and must serialize distinctly from an explicit value. No sentinel hackery
  (`color: ""` meaning inherit) — that is how style bugs become unfixable.
- **M-05 Extensible by design.** The style shape must accept unknown keys without loss.
  Options: (a) allow a typed extensible record with a known-key fast path + passthrough,
  (b) keep a versioned core and an `extensions` bag. Either is acceptable; silently dropping
  unknown keys is not.
- **M-06 All time in integer milliseconds.** Never floats. Floats accumulate error through
  split/merge/drag operations and produce off-by-one-frame export artifacts.
- **M-07 Segments are ordered and non-overlapping by convention** within a track, with
  invariant validation. Overlap is _tolerated in the document_ (the model must survive
  user error) but flagged by a validator, not silently fixed.
- **M-08 Words are children of a segment**, not a parallel stream. Word order reconstructs
  the text; the segment text is a derived convenience cache, not the source of truth.
  Divergence between them must be detectable.
- **M-09 The document is plain, serializable data.** No class instances, no functions, no
  cycles. It must survive `JSON.stringify` → disk → `JSON.parse` unchanged. This is what
  makes autosave, undo, versioning and server round-trips tractable.
- **M-10 Versioned.** The document has a `schemaVersion`. Migration is a pure, tested
  function per version bump. Files must outlive the code that wrote them.

**Full schema in `ARCHITECTURE.md` §3.** This section states the requirements; that section
states one concrete shape satisfying them.

---

## 7. Video processing requirements

- **V-01** Ingest MP4/MOV/WebM, plus anything FFmpeg can demux. Reject with a clear message
  when it cannot, not a stack trace.
- **V-02** Probe before anything else: duration, container, video codec, pixel dimensions,
  **display aspect ratio**, **frame rate (exact rational, not rounded)**, rotation metadata,
  audio codec/channels/sample rate. Frame rate must be _exact_ — 29.97 vs 30 changes
  timecode↔frame math and is a classic source of drift.
- **V-03** Honor rotation metadata, else portrait phone video renders sideways.
- **V-04** Preserve the original file. All derived media is separate, disposable artifacts
  derived from the original by a recorded, re-runnable transform chain. Never overwrite
  source media.
- **V-05** Stream where possible. A 5GB ProRes file must not be fully buffered in Node's heap.
  Extraction and rendering pipe FFmpeg output.
- **V-06** Web playback needs a browser-decodable proxy. Plan for a transcode-to-H.264
  faststart MP4 (Phase 13) so the editor previews smoothly while the original remains the
  render source. FFmpeg's native H.264 encoder is present in this environment (verified:
  `ffmpeg 9.0.2`), so this is feasible without external binaries.
- **V-07** Processing is cancellable and reports progress. FFmpeg progress is parsed from
  `-progress pipe:1`, not inferred.

---

## 8. Transcription requirements

- **T-01 Provider-agnostic.** The application depends on a `TranscriptionProvider` interface,
  never on a vendor SDK. See `ARCHITECTURE.md` §5.
- **T-02** Providers differ in what they return (some words, some segments, some no timings at
  all). Normalize at the boundary into one internal shape, so the rest of the app never sees
  provider quirks.
- **T-03** Word-level timestamps required. Word timings are the substrate for karaoke
  highlighting, word-level styling, and precise line breaking. A provider that returns only
  segment timings must be distributed within the segment (documented as _synthesized_, never
  passed off as _measured_ — an honesty requirement for the data model, not just UX).
- **T-04** Confidence per word, retained. Drives "low-confidence review" affordances later.
- **T-05** Language is explicit and carried on the document, not guessed at render time.
- **T-06** Failed/low-quality audio must produce a clear, actionable error — not an empty
  transcript that looks like a bug.
- **T-07** Re-transcription must not destroy manual edits silently. A transcript is _draft
  content_; the operation that replaces it must be explicit and undoable.
- **T-08** Long audio must not block the HTTP request thread. Transcription is a background
  job from the first version it exists, even if the "queue" is a single in-process worker
  at first. Retrofitting job semantics after the fact is painful.

---

## 9. Timestamp requirements

This is where a subtitle product is won or lost, and it deserves its own section.

- **TS-01** Single source of truth for time: integer milliseconds, one clock, no
  `seconds`/`frames`/`ms` mixing anywhere in the model or the editor.
- **TS-02** Word timings are the atomic truth. Segment timings are _derived_, then editable.
  Once the user drags an edge, the segment's word timings are clipped to it, not ignored.
- **TS-03** Frame-aware snapping. Edges snap to word boundaries and to frame boundaries, because
  an edge landing 3ms after a word starts is always wrong. The snap source is user-selectable.
- **TS-04** Reading-speed constraints surface as _guidance_, not silent correction. The editor
  should flag a segment showing 14 characters/second rather than rewrite the user's text.
  Auto-behaviour on generated content is fine; auto-behaviour on hand-edited content is hostile.
- **TS-05** No gaps shorter than a configurable threshold, no zero-length segments after a
  split, and no segment exceeding the video duration — all validated, all reported.
- **TS-06** Playback↔timeline sync is exact. The playhead is driven by
  `video.currentTime`, read on `requestAnimationFrame`, not by an independent timer. Two
  clocks that drift is the classic timeline bug.
- **TS-07** Segments must render in a _preview time window_ ahead of the playhead, so no text
  pops in visibly late. The active-segment query is a binary search over sorted starts
  (O(log n)), not a filter (O(n) per frame).

---

## 10. Subtitle editing requirements

- **E-01** Direct manipulation first. Drag to move, drag edges to retime. Numeric entry exists
  in an inspector for precision, but is never the primary path.
- **E-02** Selection: click, shift-click range, marquee. Multi-select operations
  (move, delete, restyle, split) act on the whole selection.
- **E-03** Text editing happens _in place over the video_ (contenteditable overlay), because
  judging a line break requires seeing it over the frame. A detached side panel alone is
  insufficient.
- **E-04** Split at word boundary, never mid-word. Splitting must reconcile word timings on
  both halves.
- **E-05** Merge only adjacent-in-time segments on the same track, and warn if they would
  overlap.
- **E-06** Undo/redo over every document mutation, including style changes and splits.
  Non-negotiable for an editor.
- **E-07** Every destructive action is recoverable or confirmed.
- **E-08** Editor state (selection, zoom, panel layout, playhead) is _separate from_ the
  document and is not persisted as document state. See `ARCHITECTURE.md` §7.
- **E-09** Keyboard shortcuts for the core loop: play/pause, frame step, split, merge, delete,
  undo/redo, nudge timing.

---

## 11. Styling system requirements

- **S-01** Named, reusable styles in a project-level registry. Segments reference by ID.
- **S-02** Four-level cascade: project default → track → segment override → word override.
  Resolution is one pure function shared by preview and export.
- **S-03** Full property set for the MVP tier: `fontFamily`, `fontSize`, `fontWeight`,
  `fontStyle`, `fill`, `stroke {color,width}`, `shadow {color,opacity,blur,offsetX,offsetY}`,
  `background {color,opacity,paddingX,paddingY,radius}`, `align`, `lineHeight`,
  `letterSpacing`.
- **S-04** Position as a normalized coordinate relative to the frame (`0..1`) plus a
  normalized anchor, **not** pixels. This is what makes preview and export resolution-independent
  and makes safe-area presets trivial.
- **S-05** Transform per segment/word: `scale`, `rotationDeg`, `opacity`. Normalized units.
- **S-06** Style presets: built-in starting points plus user-saved presets.
- **S-07** Rendering contract: every style property has exactly one defined meaning shared by
  both renderers. The style schema is the single source of truth for that meaning, and the two
  renderers are both tested against it.
- **S-08** Fonts must be deterministic across preview and export. The font family must be
  pinned to a specific loaded font file with an explicit weight, and the export renderer must
  use the _same file_. System-font-name-only styling is a silent, hard-to-diagnose mismatch.
- **S-09** Unknown/unsupported style keys must be preserved through a load→save round trip,
  not dropped, so an older build cannot corrupt a newer document.

---

## 12. Timeline requirements

- **L-01** Horizontal time axis, zoomable (continuous, not stepped), with a scrollable/panable
  viewport. Zoom anchored at the cursor.
- **L-02** Playhead, draggable to scrub; scrubbing drives the video.
- **L-03** Segment bars per track, colored by track, showing the text; width reflects real
  duration.
- **L-04** Selection is visible and shared with the editor.
- **L-05** Drag to move, drag edges to resize, with snapping (frame + word boundaries).
- **L-06** Track headers: name, visibility, mute/solo, style reference, reorder.
- **L-07** Word-level lane (sub-row) shown for the selected segment, showing word timing.
- **L-08** Zoom/pan/selection are UI state — not document state.
- **L-09** Renders efficiently: only visible segments in the DOM. A 1-hour project must not
  mount 4,000 DOM nodes.
- **L-10** Keyboard shortcuts for play/step/split/merge/delete/nudge, active without focus
  being trapped in a text field.

---

## 13. Preview / rendering requirements

- **R-01** **One subtitle representation, two renderers.** Preview (DOM/Canvas in browser) and
  export (FFmpeg/ASS/headless) consume the _same_ resolved style. This is the core product
  promise: WYSIWYG.
- **R-02** Style resolution is a pure, side-effect-free function (`resolveStyle` +
  `resolveSegment`) with **no dependency on the DOM or on React**. That is what lets a Node
  export worker and a browser preview share it.
- R-02 is the reason the style layer is its own module. If preview styling ever lives inside
  components, WYSIWYG is unachievable without a rewrite.
- **R-03** Preview overlays subtitles on `<video>` and stays locked to the video clock.
- **R-04** A pure "subtitle-only" frame export (transparent PNG/alpha) is useful for
  verification and compositing, and is a cheap way to _prove_ renderer parity in tests.
- **R-05** Rendering a frame is a pure function of `(document, track, timeMs, frameSize)`.
  Deterministic, replayable, testable against golden images.
- **R-06** No layout measurement in the render path. The export renderer must lay text out
  without a browser. This is why text measurement/line-breaking is a shared, headless-safe
  module, not a browser API.
- **R-07** Preview renders only segments in a look-ahead window around the playhead.

---

## 14. Export requirements

- **X-01** Burned-in video. FFmpeg + libass (ASS/SSA) is the right tool: it is a mature,
  scriptable, resolution-independent text renderer with per-event styling, positioning,
  outlines, shadows and animation-adjacent transforms — and it needs no browser. See
  `ARCHITECTURE.md` §6.
- **X-02** Sidecar subtitles: SRT and WebVTT, generated from the same document.
- **X-03** Export is a **job**: queued, observable, cancellable, retried, with a typed error
  state. Not a synchronous request that times out.
- **X-04** Export reads the source video, not the preview proxy.
- **X-05** Deterministic and reproducible: same document + same source → same output. Assumes
  FFmpeg/libass build versions are recorded in the job.
- **X-06** Renders never block the UI thread. Server-side worker, progress streamed.
- **X-07** Export is the **first** consumer of the shared style resolver, written before or
  alongside advanced styling. It is the parity test: if it is hard to express a style in ASS,
  the style model is wrong.
- **X-08** Honest capability reporting: styles the current renderer cannot express must be
  reported, not silently ignored.

---

## 15. Future extensibility requirements

- **E-01** New ASR providers implement `TranscriptionProvider` and nothing else changes.
- **E-02** New styling properties are added to the style schema, the resolver's defaults, and
  _both_ renderers. One property, two implementations, one meaning.
- **E-03** New animation types plug into the animation registry, not into the renderers.
- **E-04** New render targets (GIF, transparent WebM, server-side Chromium capture) reuse the
  document and resolver; they are new sinks, not a new pipeline.
- **E-05** The document is renderer-agnostic. A future second renderer (e.g. WebGL/Canvas
  text engine for performance) consumes the same document.
- **E-06** Schema migrations are pure and tested, so old projects keep opening.
- **E-07** The provider/job boundary is designed so moving to a separate worker host, a
  GPU box, or a queue service later is a deployment change, not a code rewrite.
- **E-08** Pluggable media backends: local FS now, object storage later, same interface.

---

## 16. Out of scope for the current stage

Explicitly **not** building now, and not to be stubbed in to make the UI look complete:

- Landing page, marketing site, SEO, blog.
- Authentication, sign-up, sessions, roles, permissions.
- Users, organizations, teams, sharing.
- Pricing, plans, subscriptions, billing, invoices, trials, paywalls, quotas.
- User dashboard, settings pages, admin panels.
- Analytics, telemetry-as-a-product, notifications, email.
- Deployment infrastructure, autoscaling, CDN, observability stack.
- Comments, review/approval workflows, approvals.
- Mobile support, offline mode, native apps.
- Multi-language UI (i18n) — not yet, but all user-facing strings stay centralized to keep it cheap later.
- Real-time collaboration, CRDTs, presence.
- Video _editing_ proper: trimming, B-roll, transitions, filters, audio mixing.
- TTS, voice cloning, dubbing, translation.
- Plugin/mod system, scripting API.
- Full component library, design system, theming engine, Storybook.

**Firm rule for this stage:** no fake functionality. If a control is not wired to real
behavior, it does not exist in the UI. A stubbed timeline is worse than no timeline, because it
teaches the wrong model and costs more to remove than to build.

---

## 17. Product design challenges

Answers to the questions that would otherwise get answered by accident during
implementation. Each states the decision, the reasoning, and what it costs.

### A. What does the user primarily edit?

**Decision: the subtitle segment is the primary object. Words are the secondary object.
Text ranges are never a first-class object.**

| Level                                     | Editable?                                        | Why                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Segment**                               | **Yes — the main event**                         | A caption is the unit a viewer sees, the unit a designer styles, the unit a platform renders. Moving, restyling, retiming, splitting all operate on segments |
| **Word**                                  | Yes, for **timing correction and emphasis only** | Word-level _style_ is a differentiator (karaoke, keyword pops) but is a refinement _of a segment_, not a parallel editing mode                               |
| **Text range** (arbitrary character span) | **No**                                           | Nobody thinks "select characters 4–11 of this caption." It adds a selection concept, a model concept, and an undo concept, for no user job                   |

**Consequence:** the document keeps words as children of segments (already specified, §6
M-08), so word-level features are additive. But the _interaction_ hierarchy is
segment-first. A user who never touches words still gets a complete product.

**The risk this avoids:** building a word-first editor (like some karaoke tools) makes the
common case — "this caption is late" — a multi-step operation. That is the wrong default.

### B. Timeline interactions

| Action                      | Behaviour                                                                                                                       | Reasoning                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Drag a segment**          | Moves start _and_ end together. Duration preserved. Live timecode readout. Snaps to word boundaries of the neighbouring segment | Moving a caption should not silently change how long it is on screen                                               |
| **Drag an edge**            | Retimes one boundary. Live readout. Snaps to frame **and** word boundaries. The other edge stays fixed                          | This is _the_ core correction gesture                                                                              |
| **Split**                   | At the playhead, or at a word boundary near the click. Words are divided between the halves; **text is rejoined per half**      | Splitting mid-word is always wrong; the model must make it impossible                                              |
| **Merge**                   | Only adjacent segments on the same track. Requires confirmation if it would overlap                                             | Merging across a time gap silently re-introduces a gap the user didn't ask for                                     |
| **Move the playhead**       | Drives the video. Never a separate conceptual "cursor"                                                                          | One clock. A second cursor is a bug generator                                                                      |
| **Edit text while playing** | **Allowed and encouraged.** The caption is a live overlay; typing into it does not stop playback                                | The user's loop is watch→fix→watch. Stopping playback to fix a word breaks the loop for the most common correction |
| **Snap**                    | To word boundaries by default, frame boundaries available, magnet toggle                                                        | Word boundaries are the _semantically correct_ snap target; frames are the _technically_ correct one               |

**Two decisions worth defending:**

1. **Drag preserves duration; edge-drag changes it.** A user dragging the body of a caption
   is moving it. A user dragging an edge is retiming it. Conflating these is a classic
   timeline bug.
2. **A drag is one undo entry**, not one per pointer-move event. Otherwise a single
   correction evicts the entire history — which is worse than having no history, because
   the user believes they can undo.

### C. Styling: global vs. local

**Decision: a three-tier model, with a deliberate "apply to" gesture.**

```
Project default  →  the look of this project's captions
   ↓
Track style      →  a named, reusable look (shared by N segments)
   ↓
Segment override →  "this one caption is different"
   ↓
Word override    →  "this one word is emphasized"  (Phase 10)
```

**How a user creates consistency quickly:** they style the _track_, not the segments. That
is why `styles` is a named registry — N segments share one style ID, and editing it
updates all of them atomically. The alternative (styling segment by segment) is the failure
mode of every naive caption tool.

**The "apply to" gesture** — a real gap in the current model. Users need "make this
segment look like that one" and "make these 20 selected segments use my style". This maps
onto existing primitives (copy a `styleOverride`, or set `styleId` on a selection) and
needs **no model change** — it is a bulk operation in `src/core/ops`. Recorded here so it is
built deliberately at Phase 7/9 rather than rediscovered later.

**Cost of this decision:** the Inspector must make the _current scope_ (project / track /
this segment) unmistakable, or users will style one caption and wonder why the other 39
didn't change. This is a UI problem with a real design cost — see `DESIGN_PRINCIPLES.md` §6.

### D. Word-level subtitles and emphasis

**Decision: word timing enables three things, in increasing order of complexity.**

1. **Karaoke highlight** — colour/scale the word currently being spoken, driven by the
   playhead. Pure read of existing data. _(Phase 10)_
2. **Per-word static emphasis** — "make _these two words_ yellow". A `styleOverride` on the
   word. _(Phase 10)_
3. **Sequential animation** — words appear one at a time as they're spoken. Animation +
   word timing, which is why it's last. _(Phase 10, later)_

**The critical UX constraint:** the highlight must be driven by the **video clock**, not by
an animation timer. A highlight that drifts from the audio is worse than no highlight,
because it looks like a bug and users can't tell whether the _timing_ or the _highlight_ is
wrong. This is the single most important constraint on the word-level feature, and it falls
straight out of the one-clock rule (TS-06).

**What it must not become:** a karaoke editor that forces users to author word-level styles
for every caption. Everything here is an _optional refinement_, off by default.

### E. Animation without becoming After Effects

**Decision: the parametric descriptor is right, and the limit is the feature.**

The model supports `(property, curve, phase, from, to, stagger)`. That covers fade, pop,
slide, punch, and per-word stagger — which is the overwhelming majority of what subtitle
animation actually _is_ in practice.

**What is deliberately not supported:** keyframes, motion paths, expressions, per-property
curves, timeline-sequenced choreography. Each is an After Effects concept with no user job
in _this_ product yet.

**The honest weakness** (recorded in `ARCHITECTURE_REVIEW.md` §1, D-6): the descriptor
covers single-property, in/out motion only. Per-word colour tweens and loops are not
representable. If the product's motion ambitions grow, this becomes a type union — the
resolver and both renderers are untouched, and old documents still load.

**The product rule that prevents scope creep:** _an animation that cannot be exported is not
an animation._ The parity matrix gates this. Spring curves are the first casualty — libass
cannot do them, so either they never ship or the UI reports the difference.

### F. Preview vs. render vs. export

**Decision: the preview is simply "the editor". Render is a background job. Export is a file.**

|                | What the user calls it             | What it is               | Latency       |
| -------------- | ---------------------------------- | ------------------------ | ------------- |
| Preview        | _(nothing — it's just the editor)_ | Live overlay, WYSIWYG    | Real-time     |
| Render         | "Export"                           | Server job → a real file | 10s – minutes |
| Exported video | the downloaded file                | Theirs                   | Done          |

**Design commitments** (detailed in `DESIGN_PRINCIPLES.md` §10):

- The word "preview" is never used, because it implies a lesser version of the real thing.
  **We do not ship a lesser version.** The editor is WYSIWYG.
- Rendering is backgrounded, cancellable, and never blocks editing.
- A rendered file is playable in the stage before download, so the user can verify without
  leaving the tool.
- If a property can't be rendered faithfully, the export **says so, specifically, before
  the user waits.** A silent difference is a broken promise.

---

## 18. Feature tiering (from the product pass)

Separated so the architecture supports the right product without the plan absorbing scope.

### CORE — the product without these is not a subtitle editor

- Upload → transcribe → segments appear
- Timeline: select, move, retime, split, merge
- Text editing over the video
- Track-level shared style; segment override
- Live WYSIWYG preview
- Undo/redo (total)
- Export burned-in + SRT
- **Parity between preview and export**

### IMPORTANT — small, cheap, and the product is notably worse without them

- Frame-accurate stepping and timecode readout
- Snapping (word + frame)
- Reading-speed guidance (flag, never silently rewrite)
- Autosave
- Keyboard shortcuts for the core loop
- Empty / loading / error / cancelled states
- Safe-area position presets
- Confidence surfacing for low-confidence words
- Re-transcription that preserves manual edits

### ADVANCED — where it becomes a _design_ tool

- Word-level timing and karaoke highlight
- Per-word emphasis
- Multiple tracks
- Animation (entrance/exit/stagger)
- Style presets and saved styles
- Transform (scale/rotation/opacity)

### LATER — beyond the product's stated scope

- Keyframes, motion paths, effects/compositing
- Translation tracks
- Font upload UI, brand kits
- Batch export, proxy management
- Anything collaborative, cloud, or account-based

**The load-bearing observation:** every CORE item is supported by the current architecture
with no model change. Several IMPORTANT items (snapping, autosave) are pure UI. The ADVANCED
tier is the _first_ place the document model is actually exercised — which is the right time
to find out whether it holds up, and it is Phase 10, not Phase 0.

---

## 19. Product Risks

Distinct from the technical risk register in `ARCHITECTURE.md` §10. These are risks of the
_product being bad_, not the _system being broken_. Per the instruction, they are recorded
with the phase at which each should be addressed — and **not** prematurely solved.

### Technical risks

_Detail in `ARCHITECTURE.md` §10 (R-1…R-20). Summarised here by product impact._

| #   | Risk                          | Product impact                                             | Address at                 |
| --- | ----------------------------- | ---------------------------------------------------------- | -------------------------- |
| T-1 | Preview ≠ export (R-2)        | The product's core promise fails; captions ship unreadable | **Phase 8, gating**        |
| T-2 | `{\an}` anchor mapping (R-15) | Captions land in the wrong place in the export             | **Phase 8**                |
| T-3 | Font substitution (R-6)       | Wrong font in the delivered file                           | Phase 7 → verified Phase 8 |
| T-4 | Timing drift (R-4)            | Captions desync from audio; looks broken                   | **Phase 0/2**              |

### UX risks

_Not yet designed — deliberately. These are the risks most likely to bite first._

| #       | Risk                                          | Why it matters                                                                                                             | Address at                                                            |
| ------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **U-1** | **The editor feels like a form**              | The single biggest product failure mode. If it's "upload + textarea + export button", it has failed regardless of features | Phase 6/7 — the layout in `DESIGN_PRINCIPLES.md` §2 is the commitment |
| **U-2** | **Styling control overload**                  | 20+ equal-weight controls → users skip, misclick, abandon (cognitive load, §6)                                             | Phase 7 — gate every new control against the ≤4 rule                  |
| **U-3** | **Scope confusion in the Inspector**          | User styles one caption, doesn't understand why the other 39 didn't change                                                 | Phase 7 — the "current scope" must be unmistakable                    |
| **U-4** | **Timing is edited by typing numbers**        | Turns a 2-second correction into a 10-second chore, breaking the core loop                                                 | Phase 6 — direct manipulation is the primary path                     |
| **U-5** | **Subtitles unreadable over arbitrary video** | The craft is _visible_; white-on-white kills the product's value                                                           | Phase 7 — stroke prominence, safe areas (`DESIGN_PRINCIPLES.md` §9)   |
| **U-6** | **Undo missing or lossy**                     | A drag destroys work; trust collapses permanently                                                                          | **Phase 0 architecture, Phase 6 UI**                                  |
| **U-7** | **Keyboard operability added late**           | Excludes users; a shortcut layer bolted on never covers the gestures that matter                                           | Phase 6                                                               |
| **U-8** | **Failed job destroys work**                  | A failed render or transcription must never touch the document                                                             | Phase 3/8 — Fortify's non-negotiable                                  |

### Performance risks

| #       | Risk                                 | Product impact                                      | Address at                                       |
| ------- | ------------------------------------ | --------------------------------------------------- | ------------------------------------------------ |
| **F-1** | **Timeline jank with many segments** | Editing feels broken; the tool is unusable at scale | Phase 6 (500 segments), Phase 10 (profile)       |
| **F-2** | **Preview drops frames during drag** | The core gesture becomes unsatisfying               | Phase 7                                          |
| **F-3** | **Render takes minutes**             | User perceives the app as slow even while editing   | Phase 3/8 — backgrounded, so mitigated by design |
| **F-4** | **Large video in browser**           | Upload OOM or playback stall                        | Phase 1 (streaming) — Critical, R-1              |
| **F-5** | **Transcription latency**            | The 30-second North Star promise breaks             | Phase 4 — measure; bake-off                      |

### Product risks

| #       | Risk                                               | Why it matters                                                                                                                   | Address at                                          |
| ------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **P-1** | **Transcription is simply wrong**                  | If ASR quality is poor, the product feels broken before the user can fix anything. This is a _product_ risk, not a technical one | Phase 4 — **bake-off on 3–4 real clips**            |
| **P-2** | **Segmentation reads awkwardly**                   | Bad line breaks read as "bad product" regardless of styling quality                                                              | Phase 5 — reading-speed caps, manual break override |
| **P-3** | **No caption background boxes in MVP**             | A visible missing feature. Correct call (libass can't render them) but users will notice                                         | Phase 10 — stroke approximation, then overlay       |
| **P-4** | **Two-providers-swap promise untested**            | If the interface leaks provider types, the "provider-agnostic" claim is hollow                                                   | Phase 4 — the exit criterion _is_ the swap test     |
| **P-5** | **The tool is only useful for burned-in captions** | Narrower than users may expect; SRT-only users are underserved                                                                   | Post-MVP — watch for demand                         |
| **P-6** | **Editing model mismatch**                         | If users actually want word-first, the whole interaction hierarchy is wrong                                                      | Phase 6 — observe real usage                        |

### Scope risks

| #       | Risk                                  | Why it matters                                                                  | Address at                                                     |
| ------- | ------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **S-1** | **Over-scoping early**                | The most likely _actual_ failure. Building animation before the edit loop works | **Continuous** — per-phase "NOT included" lists                |
| **S-2** | **Feature-request accumulation**      | Each "small" addition compounds; the tool stops being focused                   | Continuous — the tiering in §18 is the filter                  |
| **S-3** | **Premature abstraction**             | Packages/interfaces built for imagined consumers                                | Continuous — Karpathy §2; D-1 already deferred for this reason |
| **S-4** | **Speculative model fields**          | Fields added "in case" become migration burden forever                          | **Phase 0** — the model audit already removed four             |
| **S-5** | **Fake UI to look complete**          | Locks in the wrong model; costs more to remove than to build                    | Continuous — hard rule, §16                                    |
| **S-6** | **Parity debt accumulating silently** | Small accepted differences compound until preview and export visibly diverge    | **Phase 8** — versioned matrix, CI-enforced tolerances         |

---

## 20. What this product is explicitly not

Restated because a product that drifts into these is a different, worse product:

- Not a video editor. No trimming, B-roll, transitions, filters, audio mixing.
- Not a script-writing tool. The transcript is input, not output.
- Not a translation tool.
- Not a social/marketing product. No feeds, no sharing, no virality mechanics.
- Not a general text-styling tool. Every style property must be expressible in the export.
