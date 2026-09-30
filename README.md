# Subtitle Studio

Subtitle generation and editing core. A short video goes in; accurately timed, styled
subtitles come out, and a human can correct and restyle them through a visual editor.

**Current state: Phase 1 — Ingest & Project Persistence.**

The repository contains the **pure domain layer** (`src/core`) and the **ingest and
persistence layer** (`src/server`). A video can be streamed to controlled storage, probed,
normalised into canonical metadata, registered as an asset, and persisted in a validated
project document.

There is deliberately **no user interface, no transcription, no subtitle generation, no
timeline, and no rendering/export** — those arrive in later phases, each gated on the layer
beneath it being correct.

---

## What this is

The product is a precision subtitle editor. Transcription is a starting draft, not the
deliverable: the editor is where a human corrects timing, restyles, and animates captions,
and the export must match what the editor showed.

That single requirement — _the exported video looks like the editor_ — is the reason for
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

| Command             | Purpose                                  |
| ------------------- | ---------------------------------------- |
| `pnpm build`        | Compile TypeScript to `dist/`            |
| `pnpm typecheck`    | Type-check without emitting              |
| `pnpm test`         | Run the test suite once                  |
| `pnpm test:watch`   | Run tests in watch mode                  |
| `pnpm lint`         | ESLint, including the core-boundary rule |
| `pnpm lint:fix`     | ESLint with autofix                      |
| `pnpm format`       | Rewrite files with Prettier              |
| `pnpm format:check` | Verify formatting without writing        |
| `pnpm clean`        | Remove build output                      |

> `pnpm verify` runs the full gate. The core-boundary test inspects compiled output, so
> run `pnpm build` before `pnpm test` if you have only changed sources — `pnpm verify` does
> this for you via the typecheck step.

---

## Repository layout

```
src/
  core/                 # Pure domain layer. No filesystem, HTTP, FFmpeg or browser APIs.
    timing/             # Integer-millisecond time, rational frame rates
    document/           # Document model types and stable ID generation
    style/              # The four-level style cascade and animation precedence
    ops/                # Pure document operations (the undo/redo foundation)
    validation/         # Zod structural schema + semantic invariant checks
    migration/          # Versioned document migration
    testing/            # Document factories shared by tests
  server/               # Infrastructure. Consumes core; core never imports it.
    workspace.ts        # Controlled storage paths, identifier and symlink safety
    errors.ts           # Structured, typed error model
    project/store.ts    # Project CRUD with atomic writes and migration on load
    media/              # Filename/type validation, ffprobe adapter, streamed ingest
    http.ts             # Minimal node:http intake (no framework — see docs/PHASE1.md)
  index.ts              # Public surface of core
tests/                  # Vitest suites
docs/                   # Phase reference documentation
```

### The core boundary

`src/core` must stay importable unchanged by a browser bundle, a Node worker, and a test
runner. It may not import React, the DOM, Node filesystem or process APIs, HTTP servers, or
provider SDKs. It depends only on itself and `zod`.

This is enforced three times, independently:

1. `eslint.config.mjs` — a `no-restricted-imports` rule scoped to `src/core/**`.
2. `tests/boundary.test.ts` — inspects the **compiled** output for forbidden imports and
   DOM globals, so a misconfigured or bypassed lint rule cannot silently permit a breach.
3. The same test asserts the **dependency direction**: no file under `src/core` may import
   the infrastructure layer.

The second and third checks exist because a boundary enforced by one mechanism is a
convention, and a convention is a rule that breaks by Phase 6.

---

## What's implemented so far

**Phase 0 — Foundation** (pure domain, `src/core`)

| Area                                                                            | Status                              |
| ------------------------------------------------------------------------------- | ----------------------------------- |
| Integer-millisecond timing with exact rational frame rates                      | Done, tested at 30 / 29.97 / 60 fps |
| Document model: assets, tracks, segments, words, style and animation registries | Done                                |
| Stable, content-independent ID generation                                       | Done                                |
| Four-level style cascade with animation precedence                              | Done                                |
| Pure operation model (the undo/redo foundation)                                 | Done                                |
| Worker-result application, so workers never replace the client document         | Done                                |
| Structural + semantic document validation                                       | Done                                |
| Versioned migration foundation with future-version refusal                      | Done                                |

**Phase 1 — Ingest & Project Persistence** (infrastructure, `src/server`)

| Area                                                      | Status                                    |
| --------------------------------------------------------- | ----------------------------------------- |
| Streamed ingestion to controlled storage — never buffered | Done, proven by a memory-scaling test     |
| Extension + MIME allow-list, sanitised filenames          | Done                                      |
| ffprobe adapter normalising to canonical `MediaMeta`      | Done                                      |
| Exact rational frame rate, rotation, CFR/VFR detection    | Done                                      |
| Project CRUD with atomic writes, migration on load        | Done                                      |
| Typed error model, structured HTTP responses              | Done                                      |
| Security controls S-1 … S-7                               | Done, each covered by tests               |
| Undo/redo UI, history panel, keyboard handling            | Not yet — the op model it sits on is done |
| Video playback, `/media` Range endpoint                   | Phase 2                                   |
| Audio extraction, jobs, progress                          | Phase 3                                   |
| Transcription                                             | Phase 4                                   |
| Timeline UI, inspector, preview                           | Phase 6–7                                 |
| Export / libass                                           | Phase 8                                   |

Phase 1 details: [`docs/PHASE1.md`](docs/PHASE1.md).

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
- **I-8** A segment's `text` is a cache of its words. Drift is _reported_, never silently
  repaired.
- **I-9** The document round-trips through JSON unchanged.
- **I-14** `styleId` and `styleOverride` are mutually exclusive on one entity.
- **I-19** Animation wins over a static transform for the same property, for its window;
  the static value resumes after.
- **I-20** Every document mutation — including one originating in a worker — enters
  through `core/ops` as a labelled operation. Workers return _results_; the client is the
  only writer of the document.

---

## Scope discipline

This repository is built in phases by an agent over many sessions. The rules future
contributors and agents must follow are in
[`IMPLEMENTATION_PLAN.md` § Agent Development Rules](IMPLEMENTATION_PLAN.md).

The short version: implement only the current phase, keep `src/core` pure, do not fake
functionality, write tests with the code, and **stop when the phase exit criteria are met**
rather than continuing automatically.
