# Subtitle Studio

Subtitle generation and editing core. A short video goes in; accurately timed, styled
subtitles come out, and a human can correct and restyle them through a visual editor.

**Current state: Phase 0 — Architecture & Foundation.**

At this point the repository contains **only the pure domain layer**: the document model,
the timing model, style resolution, the operation model that undo/redo will be built on,
and document validation and migration. There is deliberately **no user interface, no HTTP
server, no FFmpeg integration, and no transcription provider** — those arrive in later
phases, and each is gated on the layer beneath it being correct.

---

## What this is

The product is a precision subtitle editor. Transcription is a starting draft, not the
deliverable: the editor is where a human corrects timing, restyles, and animates captions,
and the export must match what the editor showed.

That single requirement — *the exported video looks like the editor* — is the reason for
almost every structural decision here. The style resolver lives in one pure module that
both the browser preview and the Node export worker call, so the two cannot drift.

- **Product requirements:** [`PRODUCT.md`](PRODUCT.md)
- **Architecture (narrative):** [`ARCHITECTURE.md`](ARCHITECTURE.md)
- **Architecture (canonical decisions and models):** [`ARCHITECTURE_REVIEW.md`](ARCHITECTURE_REVIEW.md)
- **Implementation phases:** [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)
- **Editor design principles:** [`DESIGN_PRINCIPLES.md`](DESIGN_PRINCIPLES.md)

`ARCHITECTURE_REVIEW.md` is canonical. Where it and `ARCHITECTURE.md` disagree, the review
wins.

---

## Development commands

Requires Node 22+ (developed on 26.10) and pnpm.

```bash
pnpm install        # install dependencies
pnpm verify         # typecheck + lint + format check + tests  (run this)
```

Individual steps:

| Command | Purpose |
|---|---|
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm test` | Run the test suite once |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm lint` | ESLint, including the core-boundary rule |
| `pnpm lint:fix` | ESLint with autofix |
| `pnpm format` | Rewrite files with Prettier |
| `pnpm format:check` | Verify formatting without writing |
| `pnpm clean` | Remove build output |

> `pnpm verify` runs the full gate. The core-boundary test inspects compiled output, so
> run `pnpm build` before `pnpm test` if you have only changed sources — `pnpm verify` does
> this for you via the typecheck step.

---

## Repository layout

```
src/
  core/                 # Pure domain layer. The only thing that exists in Phase 0.
    timing/             # Integer-millisecond time, rational frame rates
    document/           # Document model types and stable ID generation
    style/              # The four-level style cascade and animation precedence
    ops/                # Pure document operations (the undo/redo foundation)
    validation/         # Zod structural schema + semantic invariant checks
    migration/          # Versioned document migration
    testing/            # Document factories shared by tests
  index.ts              # Public surface of core
tests/                  # Vitest suites, one per area
docs/                   # (reserved)
```

### The core boundary

`src/core` must stay importable unchanged by a browser bundle, a Node worker, and a test
runner. It may not import React, the DOM, Node filesystem or process APIs, HTTP servers, or
provider SDKs. It depends only on itself and `zod`.

This is enforced twice, independently:

1. `eslint.config.mjs` — a `no-restricted-imports` rule scoped to `src/core/**`.
2. `tests/boundary.test.ts` — inspects the **compiled** output for forbidden imports and
   DOM globals, so a misconfigured or bypassed lint rule cannot silently permit a breach.

The second check exists because a boundary enforced by only one mechanism is a convention,
and a convention is a rule that breaks by Phase 6.

---

## What's implemented in Phase 0

| Area | Status |
|---|---|
| Integer-millisecond timing with exact rational frame rates | Done, tested at 30 / 29.97 / 60 fps |
| Document model: assets, tracks, segments, words, style and animation registries | Done |
| Stable, content-independent ID generation | Done |
| Four-level style cascade (project → track → segment → word) with animation precedence | Done |
| Pure operation model (`moveSegment`, `retimeSegment`, `splitSegment`, `mergeSegments`, style ops) | Done |
| Worker-result application, so workers never replace the client document | Done |
| Structural validation (Zod) and semantic invariant validation (I-1…I-14) | Done |
| Versioned migration foundation with future-version refusal | Done |
| Undo/redo UI, history panel, keyboard handling | **Not in Phase 0** — the op model it will sit on is here |
| Timeline UI, inspector, preview rendering | **Phase 6–7** |
| FFmpeg, audio extraction, transcription | **Phase 3–4** |
| Export / libass | **Phase 8** |

---

## Invariants the code enforces

The document model declares twenty invariants. The load-bearing ones, all covered by tests:

- **I-1** All time is integer milliseconds. Never a float.
- **I-2** `endMs > startMs` on every segment and word.
- **I-3** Segments are sorted by `startMs` and non-overlapping within a track; words stay
  inside their segment.
- **I-5** Every entity has a stable, unique ID — never an array index, never derived from
  content.
- **I-6** `transforms` replaces on override; it does not merge.
- **I-8** A segment's `text` is a cache of its words. Drift is *reported*, never silently
  repaired.
- **I-9** The document round-trips through JSON unchanged.
- **I-14** `styleId` and `styleOverride` are mutually exclusive on one entity.
- **I-19** Animation wins over a static transform for the same property, for its window;
  the static value resumes after.
- **I-20** Every document mutation — including one originating in a worker — enters
  through `core/ops` as a labelled operation. Workers return *results*; the client is the
  only writer of the document.

---

## Scope discipline

This repository is built in phases by an agent over many sessions. The rules future
contributors and agents must follow are in
[`IMPLEMENTATION_PLAN.md` § Agent Development Rules](IMPLEMENTATION_PLAN.md).

The short version: implement only the current phase, keep `src/core` pure, do not fake
functionality, write tests with the code, and **stop when the phase exit criteria are met**
rather than continuing automatically.
