# Subtitle Studio

Subtitle generation and editing core. A short video goes in; accurately timed, styled
subtitles come out, and a human can correct and restyle them through a visual editor.

**Current state: Phase 2 — Playback & Time Base.**

The repository contains the **pure domain layer** (`src/core`), the **ingest and persistence
layer** (`src/server`), and a **minimal browser playback client** (`src/web`). A video can be
streamed to controlled storage, probed into canonical metadata, played back in the browser
through a Range-capable endpoint, and stepped frame-accurately using exact rational timing.

There is deliberately **no transcription, no subtitle generation, no timeline, no styling
editor, and no rendering/export** — those arrive in later phases, each gated on the layer
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
- **Phase notes:** [1](docs/PHASE1.md) · [2](docs/PHASE2.md) · [3](docs/PHASE3.md) · [4](docs/PHASE4.md)

`ARCHITECTURE_REVIEW.md` is canonical. Where it and `ARCHITECTURE.md` disagree, the review
wins.

---

## Development commands

Requires Node 22+ (developed on 26.10) and pnpm.

```bash
pnpm install        # install dependencies
pnpm verify         # typecheck + lint + format check + tests + build   (run this)
```

Individual steps:

| Command             | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `pnpm dev`          | Vite dev server for the browser app       |
| `pnpm dev:server`   | Compile and run the API/media server      |
| `pnpm dev:web`      | Vite dev server (same as `pnpm dev`)      |
| `pnpm build`        | Compile TypeScript and bundle the browser |
| `pnpm typecheck`    | Type-check without emitting               |
| `pnpm test`         | Run the test suite once                   |
| `pnpm test:watch`   | Run tests in watch mode                   |
| `pnpm lint`         | ESLint, including the core-boundary rule  |
| `pnpm lint:fix`     | ESLint with autofix                       |
| `pnpm format`       | Rewrite files with Prettier               |
| `pnpm format:check` | Verify formatting without writing         |
| `pnpm clean`        | Remove build output                       |

> `pnpm verify` runs the full gate. The core-boundary test inspects compiled output, so
> run `pnpm build` before `pnpm test` if you have only changed sources — `pnpm verify` does
> this for you.

The API server listens on loopback only and serves the media endpoint. It is not started by
`pnpm dev`; run `pnpm dev:server` in a second terminal when you need real media. Vite proxies
`/api` and `/media` to it (see `vite.config.ts`).

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
    media/              # Filename/type validation, ffprobe adapter, streamed ingest,
                        # Range parsing, streamed serving
    http.ts             # Minimal node:http routes (no framework — see docs/PHASE1.md)
    main.ts             # Entry point; loopback only
  web/                  # Browser client. Consumes core; depends on no Node API.
    App.tsx             # The single surface — a transport, not the editor
    api.ts              # Fetches the playback descriptor by logical id
    storage.ts          # Remembers the last project (optional, fails quietly)
    playback/
      time.ts           # The single seconds ↔ ms conversion boundary
      clock.ts          # Playback clock; the video element is authoritative
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
| Audio extraction, jobs, progress                          | Phase 3                                   |
| Transcription                                             | Phase 4                                   |
| Timeline UI, inspector, preview                           | Phase 6–7                                 |
| Export / libass                                           | Phase 8                                   |

Phase 1 details: [`docs/PHASE1.md`](docs/PHASE1.md).

**Phase 2 — Playback & Time Base** (browser client, `src/web`)

| Area                                                           | Status                                             |
| -------------------------------------------------------------- | -------------------------------------------------- |
| React + Vite application shell with a single transport surface | Done, deliberately minimal                         |
| `GET /media/:projectId/:assetId` with correct Range support    | Done, verified byte-for-byte against real media    |
| Streamed from disk, never buffered                             | Done                                               |
| One conversion boundary, seconds → canonical integer ms        | Done, asserted to exist in exactly one file        |
| Playback clock with the video element authoritative            | Done, rAF only while playing                       |
| Eight-value playback state, no redundant or impossible states  | Done                                               |
| Frame stepping from exact rational FPS (30 / 29.97 / 60)       | Done                                               |
| Browser never receives a server filesystem path                | Done, enforced by tests                            |
| `Space` / `←` / `→` keyboard transport                         | Done                                               |
| Variable frame rate frame stepping                             | **Disabled and explained** — no frame index exists |
| Subtitle, timeline, styling, export                            | Later phases                                       |

Phase 2 details: [`docs/PHASE2.md`](docs/PHASE2.md).

**Phase 3 — Audio Extraction & Media Processing** (infrastructure, `src/server`)

| Area                                                       | Status                                          |
| ---------------------------------------------------------- | ----------------------------------------------- |
| Job domain model and state machine, pure, in `core`        | Done — terminal states absorb late callbacks    |
| Persistent job store with atomic writes and crash recovery | Done — recovery runs on the real entry point    |
| Single-slot worker: one media job at a time                | Done, intentionally                             |
| FFmpeg adapter: one file builds all argv, no shell         | Done, asserted by a boundary test               |
| Canonical audio: 16 kHz mono PCM WAV                       | Done, measured duration agreement within 250 ms |
| Temp-then-rename; a failed run cannot become an asset      | Done, verified live                             |
| Deterministic + indeterminate progress, cancellation       | Done                                            |
| Transcription, subtitles, rendering                        | Later phases                                    |

Phase 3 details: [`docs/PHASE3.md`](docs/PHASE3.md).

**Phase 4 — Transcription** (`src/core/transcription`, `src/server/transcription`)

| Area                                                                    | Status                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `TranscriptionProvider` interface + canonical result types, in `core`   | Done, no vendor vocabulary                              |
| OpenAI adapter (`whisper-1`, for word timestamps) behind that interface | Done, verified against recorded + live local responses  |
| Pure normalizer: integer-ms, sorting, confidence, timing honesty        | Done — rejects rather than silently repairing           |
| Absent confidence stays absent, distinct from a real zero               | Done, asserted through a JSON round trip                |
| `measured` vs `synthesized` timing preserved; nothing synthesized       | Done                                                    |
| Pure document-writing operation with provenance                         | Done, one undo entry for a whole transcript             |
| Re-transcription refuses over manual work, and names the count          | Done — no merge engine, deliberately                    |
| Transcription job reuses the Phase 3 worker and store                   | Done, no second queue                                   |
| Worker never writes `ProjectDocument` (I-20)                            | Done, verified live and by a regression test            |
| **Real OpenAI API call**                                                | **Not performed — no `OPENAI_API_KEY` on this machine** |
| Timeline, segment editing, styling, export                              | Later phases                                            |

Phase 4 details: [`docs/PHASE4.md`](docs/PHASE4.md).

---

## Running transcription

Set one environment variable and use the HTTP API:

```bash
export OPENAI_API_KEY=sk-...          # required; the app runs without it
export OPENAI_TRANSCRIBE_MODEL=whisper-1   # optional; the only model with word timestamps
export SUBS_WORKSPACE=./workspace     # optional; defaults beside src/
```

The app starts and serves media and playback with **no** API key. Transcription requests return a
clear `503 not-configured` rather than failing at startup.

```bash
# 1. Upload a video, 2. extract audio, 3. transcribe, 4. poll
curl -X POST localhost:4199/api/projects/$P/assets/$VIDEO/audio
curl -X POST localhost:4199/api/projects/$P/assets/$AUDIO/transcribe -d '{"granularity":"word"}'
curl localhost:4199/api/jobs/$JOB/result
```

Step 4 returns the canonical result. Applying it to a project is a **client-side** operation —
the server never writes `project.json` (invariant I-20).

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
