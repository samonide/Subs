# DESIGN_PRINCIPLES.md — Subtitle Studio Editor

Design philosophy for the **editor**, not a landing page. Nothing here is implemented yet;
this is the contract the Phase 7+ UI work is measured against.

**Method note:** this document applies the _Operate_ mode from the Impeccable design
methodology (the mode for tools and app UI, not brand surfaces), the cognitive-load and
Nielsen heuristics framework, and the state-inventory approach from _Fortify_. Section
headings cite which discipline produced the principle, so a later reviewer can tell a
reasoned constraint from a personal preference.

---

## North Star

> **You drop in a clip, and thirty seconds later you have captions that look like a
> designer made them.**
>
> The transcription is a starting draft, not the deliverable. The tool's job is to make
> correcting and restyling that draft feel like direct manipulation — dragging a caption
> two hundred milliseconds later should feel like moving a physical object on a desk, not
> editing a form. And when you hit export, the file you get must be the file you saw.

Three clauses, each a testable promise:

1. **Thirty seconds to first value** — not a tutorial, not a settings page, not a
   "get started" wizard. Upload, and captions appear.
2. **Direct manipulation over configuration** — the common edits are drags. Numeric
   entry exists for precision, never as the primary path.
3. **What you see is what you export** — enforced structurally by a shared style resolver,
   not by careful discipline.

**The anti-north-star:** _"upload a file + giant form + textarea + export button."_ If the
editor ever degenerates into a form with a video stapled on top, it has failed regardless
of how many features it has.

---

## 1. The mode: Operate, not Persuade

_Source: Impeccable — mode selection._

This is a tool people spend focused hours in, not a page they visit once. That
determines nearly everything downstream.

|            | Persuade (landing)       | **Operate (this editor)**                       |
| ---------- | ------------------------ | ----------------------------------------------- |
| Goal       | convince, convert        | complete a task accurately                      |
| Density    | sparse, generous         | **dense, information-rich**                     |
| Motion     | orchestrated, expressive | **150–250ms, state-only**                       |
| Color      | expressive, committed    | **restrained**, one accent for selection/action |
| Typography | display + body pairing   | **one well-tuned sans**, tight scale            |
| Delight    | on the surface           | **saved for moments**, not pages                |

**Consequences to hold to:**

- No page-load choreography. The editor loads _into a task_.
- No decorative motion. Motion communicates state change, feedback, loading, reveal —
  nothing else.
- No display font in UI labels, buttons, or data. One family carries the whole interface.
- Fixed `rem` scale, tighter ratio (1.125–1.2). Fluid `clamp()` headings do not serve
  product UI — users view at consistent DPI.
- Accent colour appears on: primary action, current selection, active state, playhead.
  Nowhere else. If everything is accented, nothing is.
- Density is a _permission_, not a warning. A professional editor is allowed to be dense.

---

## 2. The spatial model

_Source: Pattern analysis of Premiere / After Effects / CapCut; deliberately not copied._

Four regions, fixed, familiar to anyone who has touched a video tool:

```
┌──────────────────────────────────────────────────────────────┐
│  TOOLBAR        project · transcribe · export                │  thin, global actions
├───────────────────────────────────────────┬──────────────────┤
│                                           │                  │
│              STAGE                        │    INSPECTOR     │
│        (video + live subtitle overlay)     │  (contextual     │
│                                           │   properties)    │
│         the work happens here             │                  │
│                                           │  changes with    │
│                                           │  selection       │
├───────────────────────────────────────────┴──────────────────┤
│  TIMELINE                                                  ▲    │
│  tracks · segments · playhead · words                       │  │  resizable
├──────────────────────────────────────────────────────────────┤  │  divider
│  SUBTITLE LIST  (or tab alongside Inspector)                 ▼    │
└──────────────────────────────────────────────────────────────┘
```

**The stage is the primary surface, not a preview of one.** Text is edited _in place over
the video_, because judging a line break requires seeing it against the frame. A detached
side panel alone is insufficient — this is a finding from the product pass, not a
preference.

**The Inspector is contextual, never a permanent wall of controls.** It shows properties of
_what is currently selected_. Nothing selected → project-level settings. Segment selected →
its text, timing, style. Word selected → word overrides. This is the single most
important defence against control overload (§6).

**Resizable dividers, not fixed panels.** Users have different monitor sizes, font
preferences, and workflows. Layout is theirs to arrange; we persist it.

---

## 3. The editing loop is the product

_Source: Product brainstorming pass; cognitive-load framework._

The core loop, and how long each part should take:

```
watch → hear something wrong → fix it → watch again
```

That loop runs 3–10 times per session. **Everything else is secondary.** Design
consequences:

| Decision                            | Consequence                                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| The loop must be sub-second per fix | Drag directly on the timeline; no modal "edit timing" dialog, ever                                                               |
| Corrections are visual, not textual | A 12-character text box for `startMs` is a precision tool, not the main path                                                     |
| The video must not stop             | Editing while playing is a first-class mode, not an edge case                                                                    |
| Selection must be shared            | Selecting a segment in the timeline selects it in the list _and_ highlights it on the stage — one selection concept, three views |
| Undo must be total                  | Any fix can be reversed. Intent's principle: _undo is not a feature, it is a right_                                              |

**Time is the medium.** The user's core perceptual loop is audiovisual; anything that
breaks audio-visual continuity is a bug even if the numbers are correct.

---

## 4. Interaction patterns worth adopting

_Source: Pattern analysis; each is justified, none is copied wholesale._

**Drag with live temporal feedback.** Dragging a segment edge shows a live timecode
readout and a snapping indicator (word boundary / frame boundary). The user should never
have to guess where the edge landed.

**Snapping that announces itself.** Magnetic snapping is delightful when it is invisible
(missed snap) and infuriating when it is unexplained. Show the snap indicator.

**Space to play/pause.** Universal in video tools. Expect it.

**IJKL-style shuttle** for frame-stepping — LMB-style, J/K/L shuttle, I/K for in/out.
Familiar to every editor user, invisible to everyone else.

**Double-click a segment to edit its text in place**, on the stage. Not "open editor."

**Escape means "deselect,"** never "close a dialog you didn't open."

**Direct manipulation over modals** — the Operate-mode guidance is explicit: modals are
usually laziness. Exhaust inline and progressive alternatives first. This product has a
permanent Inspector; a modal is nearly always the wrong tool.

**Drag-import-drop for the video file.** A creator has the file on their desktop. Making
them navigate a file picker is a pointless detour.

---

## 5. State design

_Source: Fortify — state inventory. Every state below must be designed, not just the happy path._

| State                                      | What the user sees                                                                 | What they can do                            | Recovery                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------- |
| **Empty (no project)**                     | Drop zone + a one-line explanation of what the app does                            | Drop a file, or open a sample               | —                                                    |
| **Empty (no segments, transcript exists)** | "Transcript ready — 47 segments" + primary action                                  | Generate, or open the timeline              | —                                                    |
| **Loading video**                          | Skeleton in the stage, timeline disabled                                           | Cancel                                      | —                                                    |
| **Transcribing**                           | Determinate progress with stage ("extracting audio", "transcribing", "segmenting") | Cancel, keep working in a loaded project    | —                                                    |
| **Partial**                                | Some tracks/segments failed                                                        | Retry the failed part, keep what worked     | Per-item retry                                       |
| **Error — bad media**                      | Plain language: what failed, what to do ("This file has no audio track")           | Choose a different file                     | Non-blocking                                         |
| **Error — transcription failed**           | What failed and the likely cause                                                   | Retry, change provider, continue without it | **Never destroys existing work**                     |
| **No network (transcription)**             | Explicit banner; local editing stays available                                     | Keep editing, retry later                   | Queued, not lost                                     |
| **Rendering**                              | Determinate progress, cancel available                                             | Cancel, keep editing the document           | Render from a snapshot                               |
| **Render failed**                          | Cause + retry                                                                      | Retry, adjust, export SRT instead           | —                                                    |
| **Disabled control**                       | Greyed, **with a reason on hover**                                                 | —                                           | A disabled control with no explanation is a dead end |
| **Overflow**                               | Timeline virtualized; lists paginate or scroll                                     | —                                           | —                                                    |

**Hard rule from Fortify, applied here:** _never lose user work._ Autosave is
non-negotiable from Phase 9, and a failed transcription or render must never touch the
document.

**Graduated waiting messaging** (Fortify): 0–3s nothing; 3–10s spinner; 10–30s "this is
taking longer than usual"; 30s+ offer alternatives. A 5-minute render must never be an
indeterminate spinner.

---

## 6. Control density and cognitive load

_Source: Cognitive Load Assessment; Working Memory Rule (Miller/Cowan, ≤4 items)._

The Inspector's property list is the main risk in this product. Twenty styling controls is
not a feature, it is a wall — at 8+ visible options users skip, misclick, or abandon.

**Rules:**

- **Never more than ~4 visible options at a decision point.** Group the rest under
  disclosure, and _sequence_ rather than hide.
- **Progressive disclosure, not hidden functionality.** The difference: the user knows the
  thing exists. A collapsed "Advanced" section with a visible label is sequencing. A
  control that simply isn't there is hiding.
- **One primary action per region.** The toolbar has one primary (Export). The Inspector's
  primary is whatever the selection most needs.
- **No working-memory bridges.** The user must never have to remember a value from one
  panel to use it in another. If a style matters in two places, it is visible in both.
- **Group by proximity and shared background**, not by data-model structure. Users think
  "Typography" and "Effects", not "StyleOverride" and "TransformSpec".

**The property list is deliberately short in the MVP** (PRODUCT §11 S-03). Every control
added later must earn its place against this limit, which is why the styling phase is
gated and why the document model removes properties libass cannot render — an honest tool
has fewer controls than a lying one.

---

## 7. Visual language

_Source: Impeccable craft floor + Operate colour rules._

**Aesthetic:** _professional creative tool._ Quiet, dense, precise, confident. The
reference points are NLE and motion tools, not consumer apps. Nothing bounces. Nothing
gradients for decoration. The interface recedes so the video and the captions are the
brightest things on screen.

**Hierarchy (highest to lowest contrast):**

1. Video and subtitles — the subject
2. Playhead and current selection
3. Active panel
4. Inactive panels, borders
5. Disabled controls

**Craft-floor rules that apply literally:**

- **Contrast:** body and secondary text ≥ 4.5:1; large text ≥ 3:1. On coloured surfaces,
  tint secondary text from that hue — never grey.
- **Depth:** shadows carry an offset _and_ a soft blur. A zero-offset coloured halo is
  decoration, not depth.
- **Spacing:** tight groups, generous separation, more space _above_ a heading than below.
- **Numerals:** tabular figures everywhere a time or number appears. Times that jitter in
  width as they change are a classic tell of an amateur tool.
- **Browser surfaces:** text selection, caret, focus rings, scrollbars, and underline
  offsets all ship with defaults that belong to no design system. Theme them. This is the
  cheapest signal that a page was _built_ rather than assembled.
- **Icons:** drawn, one consistent stroke and weight, from a real library. No Unicode
  glyphs standing in for icons.

**Bans for this product specifically:**

- Kicker/eyebrow labels above headings (banned outright in the craft floor; no brief
  earns it back).
- Cards as the default container. The timeline is not a card grid.
- Glass and blur as decoration.
- Monospace as "technical" costume. Monospace is for **data and measurement** — which in
  this product means timecodes, and only timecodes.
- Full-saturation accent on inactive states.
- Modal for any task that needs neither interruption nor protected focus.
- "Something went wrong" — ever. Errors name the problem and the recovery.

**Light or dark is not a category default.** The scene decides: video editors are used for
hours, often in dim rooms, often beside a bright video frame. A dark chrome around a bright
video reduces glare; this must be validated with real footage, not assumed.

---

## 8. Accessibility baseline

_Source: Intent — accessibility is a baseline, not a feature._

Not a compliance afterthought; a creative tool that excludes people is incomplete.

- **Full keyboard operability is a Phase 6 requirement**, not Phase 9. A timeline that can
  only be operated by mouse is unusable for many people, and a shortcut layer bolted on
  late never covers the gestures that matter.
- Visible focus indicators on every interactive element.
- State changes announced to screen readers (segment selected, render started, export done).
- No information conveyed by colour alone — selected _and_ highlighted, error _and_
  labelled.
- Contrast per §7, on the stage as well as the chrome (subtitles over arbitrary video
  content is the hardest contrast problem in this product; see §9).
- Browser zoom to 200% without loss of function.

---

## 9. The hard visual problem

_Source: Product pass._

Subtitles are the one place where this product's craft is directly visible, and it is
harder than it looks.

**The problem:** subtitle text sits on top of _arbitrary, unknown_ video frames. White
text with a thin stroke is unreadable over a bright sky and invisible over a dark one. The
user cannot choose a stroke colour that works for frame 1 and frame 200 simultaneously —
and they shouldn't have to think about it.

**Principles:**

- The **stroke is a legibility guarantee, not a decoration.** It is what makes text
  readable over unknown content, and it should be offered prominently rather than buried
  under effects.
- **Normalised positioning** means a caption authored in a 1080p canvas sits correctly at
  any resolution — and, more importantly, at any aspect ratio, including the vertical
  formats this audience actually publishes to.
- **Safe-area presets** (bottom / centre / top, per platform) exist because the target
  platforms cover the bottom of the frame with their own UI. This is a real constraint of
  the use case, not a hypothetical.
- **Parity is a legibility feature, not just fidelity.** If the preview and the export
  disagree about a stroke, the user's captions are unreadable in the delivered file. The
  parity matrix (`ARCHITECTURE_REVIEW.md` §7) is therefore a quality requirement with a
  visible failure mode.

---

## 10. Preview vs. export, as the user experiences it

_Source: Product pass; the question "how does the user understand these three things?"_

The product has three states that are easy to conflate and must be kept visually and
conceptually distinct:

|                    | What it is                         | Latency           | Fidelity            |
| ------------------ | ---------------------------------- | ----------------- | ------------------- |
| **Preview**        | Live overlay, WYSIWYG, interactive | Real-time (60fps) | The user's _intent_ |
| **Render**         | Server job producing a real file   | 10s – minutes     | The **commitment**  |
| **Exported video** | A file they own                    | Done              | What they ship      |

**Design commitments:**

- The preview is never labelled "preview" in a way that implies reduced fidelity. It is
  simply the editor. The word "preview" implies a lesser version, and we do not ship one.
- **Rendering is a visible, cancellable, background process**, not a frozen UI. The user
  keeps editing; the job reports progress in a corner, not a blocking overlay.
- **Rendered output is previewable in the stage** before download, so the user can verify
  the final artefact without leaving the tool.
- If any property cannot be rendered faithfully, the export must **say so, specifically**,
  before the user waits. A silent difference is a broken promise (PRODUCT X-08).
- Export offers formats honestly: burned-in MP4 and SRT/VTT. Never a fake "MP4" that is
  actually a still image with text.

---

## 11. What would make this editor excellent vs. frustrating

**Excellent:**

- Captions appear ~20 seconds after upload with no configuration.
- Dragging a caption edge feels physical; the video scrubs under your finger.
- Changing the track style restyles forty captions at once.
- Splitting a caption at the word you clicked leaves the words intact.
- Undo always works, including for a drag you ruined.
- The exported file is indistinguishable from the preview.
- The tool never shows you a control that quietly does nothing.

**Frustrating (and therefore forbidden):**

- A "giant form" where a caption should be.
- Typing milliseconds into a text box as the primary way to fix timing.
- Reading speed too fast to follow, discovered only in the export.
- A style that looks right in the editor and is missing in the file.
- Losing an edit because a render failed.
- Twenty styling sliders with no hierarchy, and no way to get back to a known-good look.
- A modal dialog for something that could happen inline.
- The app deciding your captions should be reflowed after you fixed them.

---

## 12. Anti-scope for the design

_Source: Karpathy §2 — simplicity first; no speculative features._

To keep this document from becoming a wish list, the following are **not** design goals at
this stage, and adding them would violate the discipline more than it would help:

- A themeable, brandable design system with a public token API.
- Animation _of the interface_ (the editor chrome should be still; only state feedback
  moves).
- Dark/light as a user preference setting — decided by use scene, not offered as a toggle
  without evidence.
- Micro-interactions, easter eggs, onboarding tours.
- A design-token pipeline, Storybook, or component library documentation.

The one design-system decision that _is_ worth making early is the **component state
vocabulary** (default / hover / focus / active / disabled / loading / error), because it
must be consistent from the first component onward and retrofitting consistency is
expensive. Everything else waits for real UI.

---

## Open design questions

Recorded rather than silently answered. Each needs a decision at the phase named.

| #   | Question                                                                                                               | Decide at                        |
| --- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| D1  | Dark chrome, or light? Depends on real footage and room conditions, not preference.                                    | Phase 7 — test with actual video |
| D2  | Inspector on the right, or as a tab beside the subtitle list? Both are common; the split affects density.              | Phase 6                          |
| D3  | Does the subtitle list exist at all, or is the timeline the only navigator? Affects information density substantially. | Phase 6                          |
| D4  | Tailwind vs. CSS Modules — deferred from Phase 0 to here.                                                              | Phase 7                          |
| D5  | Which built-in style presets ship, and do they encode _platform_ conventions (TikTok/Reels safe areas)?                | Phase 7/10                       |
| D6  | Multi-track: stacked lanes in one timeline, or a track selector? Affects the whole timeline model.                     | Phase 9                          |
