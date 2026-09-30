# Phase 3 — Audio Extraction & Media Processing

Phase 3 turns slow, CPU-bound media work into an observable, cancellable, recoverable **job**.
It ends at:

```
VIDEO → AUDIO → VERIFIED PROCESSING RESULT
```

No transcription (Phase 4), no subtitles (Phase 5+), no rendering (Phase 8).

---

## 1. Job architecture

A job is a unit of deferred media work. It exists so that a two-minute FFmpeg run is a thing
you can _watch_ rather than a request that hangs.

### Jobs are not part of ProjectDocument

This is the load-bearing decision, and it is invariant I-20 from ARCHITECTURE_REVIEW.md.

A job is volatile runtime state: queued, running, done, gone. A project document is the
durable, versioned, undoable truth about a piece of work. Merging them would mean every
project file carries a stale `"status": "processing"` from a crashed run, and every undo
would try to revert a job that no longer exists.

So job records live in `workspace/jobs/<jobId>/job.json`, outside any project directory.
A project can be copied, backed up, or committed and never carry runtime state.

### Lifecycle

```
                 ┌──────────► cancelled ◄──────────┐
                 │                                  │
   queued ────────┼──────► processing ──────────────┤
                 │                │                │
                 └────────────────┴──► completed   │
                                  └──► failed ─────┘
```

Terminal states (`completed`, `failed`, `cancelled`) absorb everything. A late worker callback
or a duplicate completion cannot resurrect a finished job.

Every transition is a pure function in `src/core/jobs/machine.ts`:

| Function         | Legal from             | Effect                                    |
| ---------------- | ---------------------- | ----------------------------------------- |
| `startJob`       | `queued`               | → `processing`, records `startedAt`       |
| `reportProgress` | `processing`           | updates progress only                     |
| `completeJob`    | `processing`           | → `completed`, records result, progress 1 |
| `failJob`        | `queued`, `processing` | → `failed`, records structured failure    |
| `cancelJob`      | `queued`, `processing` | → `cancelled`                             |

`queued → failed` is legal: a job can be rejected before it runs (missing source). Routing
that through `processing` would force a fake "started" status on work that never began.

Illegal transitions **throw** `JobTransitionError`. `tryTransition` is the lenient variant
for async boundaries, where a duplicate callback should lose the race quietly rather than
surface as an unhandled rejection.

Timestamps are **injected by the caller**, never read from the clock inside core. A hidden
`Date.now()` would make the same inputs produce different records on every run, which makes
the state machine untestable and undo comparisons unreliable.

---

## 2. Worker model

### One job at a time

`Worker` is a single-slot serial queue. The reasons are all about this being a local desktop
tool, not about scaling later:

- FFmpeg is already multi-threaded internally. Two concurrent extractions on a laptop make
  both slower, not the machine faster.
- A serial queue cannot deadlock and needs no visibility-timeout or re-delivery machinery,
  none of which has a consumer here.
- It bounds resource use, which matters **because there is no authentication** — an open
  endpoint that can queue unlimited jobs is a trivial local DoS.

Every ffmpeg process is additionally capped at `-threads 2`. Unbounded, FFmpeg takes a thread
per core, so a short clip saturates the machine and starves the browser decoding the preview
the user is watching at the same time.

### Isolation from the request

The handler that starts a job does **not** await it. It enqueues, returns `202` with a job id,
and the client polls. A request handler that awaited FFmpeg would hold a socket open and be
killed by any proxy timeout — the exact failure the job model exists to prevent.

### Cancellation

Cooperative. `POST /api/jobs/:jobId/cancel` aborts the handler's `AbortSignal`; the FFmpeg
adapter responds with `SIGTERM`, escalating to `SIGKILL` after a 2s grace period. The pipeline
then deletes the partial output and the job settles as `cancelled` — never `completed`.

Cancelling an already-terminal job is a **no-op returning 200**, not a 409. The client asked
and the honest answer is "it already ended"; a racing UI should not show a failure for a
request that did its job.

---

## 3. Persistence and crash recovery

`job.json` is written to a temp file then renamed — the same atomic discipline as
`project.json`. A crash can leave a temp file but never a half-written record.

### Why jobs are persisted at all

The alternative, an in-memory `Map`, was rejected for one specific reason. With memory-only
state, restarting mid-job makes the job vanish while its half-written output may still be on
disk. The client then polls a job that no longer exists, and the leftover file is never
cleaned up: invisible work and invisible garbage, with no record that either existed.

Persisting the record means a restart can find the job, see it stuck in `processing`, and fail
it explicitly.

### Recovery

`createIngestServer` calls `recoverInterruptedJobs` **before the server accepts a request**.
Any job found in `queued` or `processing` belongs to a process that is gone; its FFmpeg child
died with the parent. Those are marked `failed` with an explicit reason and logged to stderr:

```
recovered 1 interrupted job(s): rqfc64vl_11ctrt
```

Recovery deliberately does **not** resume. FFmpeg offers no rewind point, and a partially
written WAV is not a resumable artifact. The honest recovery is "this did not finish; run it
again" — never a silent success.

> **This lives in `createIngestServer`, not the test helper.** `main.ts` calls
> `createIngestServer` directly. Recovery placed in `startIngestServer` (used only by tests)
> would pass every test and never run in production. A test now covers the real entry point.

---

## 4. The FFmpeg boundary

`src/server/media/ffmpeg.ts` is the **only** file that constructs FFmpeg argv. A boundary test
asserts this: `spawn('ffmpeg')` appears in exactly one file, so the "safe argument array"
claim is auditable rather than aspirational.

```ts
spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
```

- **Argument array, never a shell string.** No `shell: true`, no `execSync`, no template
  interpolation. A filename cannot become a command because it is never parsed — it is a path
  this process generated, validated by `WorkspaceLayout`.
- `-nostdin` — stops FFmpeg consuming the parent's stdin, which can make a detached worker hang.
- A wall-clock timeout (10 min default), then SIGTERM → SIGKILL.
- `-threads 2` — bounded CPU.

### stderr is not a failure signal

FFmpeg writes banners, warnings, and progress to stderr on **successful** runs. Success is
decided by exit status **plus an explicit output-existence check**. Stderr is kept only as an
8 KB tail for diagnostics — bounded so a pathological log cannot exhaust memory.

A test asserts that a run with empty stderr and exit 0 is fine, and that exit 0 with a missing
output is a failure (`output-invalid`).

---

## 5. Canonical audio format

```
pcm_s16le · 16 kHz · mono · WAV
```

| Choice               | Why                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Uncompressed PCM** | No second lossy generation degrading the signal before speech recognition sees it                               |
| **16 kHz**           | The native rate of essentially every speech model, so no resampling happens inside a provider                   |
| **Mono**             | Avoids a channel-layout guess on the provider side                                                              |
| **WAV**              | Trivially seekable and streamable — matters when a provider uploads by range rather than reading the whole file |

Exactly one output format. No alternatives, no configuration.

`-f wav` is explicit because FFmpeg infers its muxer from the output extension, and the temp
file is named `.audio.wav.tmp`, which tells it nothing. Without `-f`, a perfectly good
extraction fails with _"Unable to find a suitable output format"_.

### Duration agreement

Extracted audio is compared against the source video duration, with a tolerance of
**250 ms**.

Not zero — a lossy source decode plus a resample can legitimately differ by a few
milliseconds at the tail, and rejecting that would fail the pipeline on good media. But a
_meaningful_ difference means the audio does not correspond to the video, and subtitles
generated from it would drift against the picture — the one failure this product exists to
avoid.

Exceeding the tolerance **fails the job**. The difference is measured and reported
(`durationDeltaMs`), never silently accepted.

---

## 6. Asset relationship

The extracted audio becomes a normal asset with `role: 'audio'` and `derivedFrom` pointing at
the source video:

```json
{
  "id": "…",
  "role": "audio",
  "filename": "audio.wav",
  "mimeType": "audio/wav",
  "derivedFrom": "<sourceVideoAssetId>",
  "transform": "ffmpeg -i <source> -vn -c:a pcm_s16le -ar 16000 -ac 1 -f wav <output>",
  "meta": { "audioCodec": "pcm_s16le", "sampleRate": 16000, "channels": 1, "durationMs": 3000 }
}
```

The model already had `role: 'audio'`, `derivedFrom`, `transform`, and the audio `MediaMeta`
fields from Phase 0, so **no schema change and no migration were needed**.

On disk the file is `media/<assetId>/original.wav` — the same naming rule as every other stored
asset, so `WorkspaceLayout.assetFile` remains the only way to resolve an asset to a path and the
Phase 2 media endpoint serves derived audio with no special case.

A small `audio-metadata.json` sidecar records the derivation for Phase 4 to find without
re-probing. It is written only after the audio is final.

### No document mutation from the worker

The worker produces **media files and job records**. It never writes `ProjectDocument`.

Registering the asset on the document happens in the HTTP layer after the job succeeds, as an
ordinary request-path mutation with its own error handling. The tempting shortcut — having the
worker call `projectStore.save()` when it finishes — inverts ownership: a background process
would rewrite a document the user may have edited in the meantime, and the largest change a
job causes would have no undo entry.

---

## 7. Atomic output

FFmpeg writes to `.audio.wav.tmp`. Only after the process exits 0 **and** the output probes as
real audio (has an audio stream, non-zero duration) is it renamed into place.

Every failure path — FFmpeg error, cancel, invalid output, duration mismatch, throw — runs
through a single `cleanupTemp()` in a `try/catch`, so a partial file can never survive as an
asset. A `.tmp` name is chosen because `WorkspaceLayout` only ever builds paths of the form
`original.<ext>`: a name the resolver cannot produce is unreachable by every reader.

**Verified live:** a video with no audio track produces a failed job, zero audio assets on the
document, and only the original upload on disk.

---

## 8. Progress semantics

FFmpeg writes machine-readable progress to a file via `-progress`:

```
out_time_us=5000000
out_time_ms=5000000
progress=end
```

Two decisions worth recording:

**`out_time_us`, not `out_time_ms`.** Both exist and they are not interchangeable. FFmpeg's
`out_time_ms` is a misnomer — it reports _microseconds_. Reading it as milliseconds makes a
5-second file report 5,000,000 "ms" and progress run 1000× too slow.

**`indeterminate` is a real state.** Before FFmpeg reports a usable position, progress is
`{ kind: 'indeterminate' }` rather than a confident `0%`. A spinner stuck at 0% reads as
_broken_; an honest indeterminate state reads as _working, unknown duration_. When the source
duration is unknown (live or malformed input), progress stays indeterminate permanently —
guessing a ratio there would be a fabrication presented as a measurement.

Values are clamped to `0..1` and made monotonic by the parser, because a progress bar that
goes backwards or shows 103% reads as a bug even when the job is fine.

Progress is polled every 100 ms by reading only the _new_ bytes of the progress file. FFmpeg
does not notify us when it rewrites it, and `fs.watch` would be a lot of machinery for a
cosmetic update.

---

## 9. Concurrency and resource limits

| Limit                   | Value                             | Rationale                                                                                 |
| ----------------------- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| Simultaneous media jobs | **1**                             | FFmpeg already uses every core; serialising bounds resource use in an unauthenticated app |
| Threads per ffmpeg      | **2**                             | Keeps the machine usable while the user watches the same video in the browser             |
| Job wall clock          | **10 min** then SIGTERM → SIGKILL | A pathological input cannot hang the worker forever                                       |
| Progress poll           | 100 ms                            | Below perceptual lag; costs tens of reads per job                                         |
| stderr retained         | 8 KB tail                         | Bounded diagnostics                                                                       |

Not implemented, deliberately: quotas, rate limiting, priority queues, multi-worker pools.
Each has no consumer at this scale. When a queue is genuinely needed, `Worker` is the only
class that has to change.

---

## 10. HTTP surface

Three routes, derived from what the flow needs. Not a generic job API — no `GET /api/jobs`, no
filtering, no pagination.

| Method | Path                                             | Purpose                                |
| ------ | ------------------------------------------------ | -------------------------------------- |
| `POST` | `/api/projects/:projectId/assets/:assetId/audio` | Enqueue extraction → `202`             |
| `GET`  | `/api/jobs/:jobId`                               | Poll status, progress, failure, result |
| `POST` | `/api/jobs/:jobId/cancel`                        | Request cancellation                   |

The job view is a deliberate subset: no filesystem path, no stderr tail, no internal timing.
Two tests assert no response body contains the workspace root.

---

## 11. Security

Continuing S-1…S-7 from Phase 1, plus worker-specific controls:

| Control                                    | Where                                                           |
| ------------------------------------------ | --------------------------------------------------------------- |
| Identifiers validated before any path join | `WorkspaceLayout.assertSafeIdentifier`                          |
| Containment re-checked after join          | `assertInsideRoot`                                              |
| Symlink escape                             | resolved through `realpath` of the deepest existing ancestor    |
| argv only, no shell                        | `spawn` with an array; no `shell: true`, no `execSync`          |
| Temp label is code-controlled              | validated for separators only, never as an untrusted identifier |
| HTTP body capped                           | `readJsonBody` with a 1 MB default                              |
| Bounded stderr                             | 8 KB tail                                                       |
| Loopback only                              | no authentication exists yet                                    |

Adversarial tests cover traversal in project/asset/job ids, traversal in temp labels, shell
argument injection attempts, symlink escape, unknown job ids, and the guarantee that a rejected
request creates no file.

---

## 12. Known limitations

Honest list of what this phase does **not** do:

- **No resume.** A crashed job is failed, not resumed. FFmpeg has no rewind point.
- **No orphan sweeping.** A crash mid-ingest can leave an unreferenced asset directory holding
  only a `.tmp` file. The job is marked failed and the orphan is identifiable, but nothing
  deletes it yet. Phase 13 (large-file handling) owns a sweep.
- **Cancellation is cooperative.** It kills the FFmpeg child, but a queued job that has not
  started is cancelled by marking its record — the handler still runs and observes an
  already-aborted signal.
- **Polling, not push.** No websockets. Adequate for a local tool; revisit only on evidence.
- **No retry policy.** A failed job is terminal. Automatic retry would need a backoff
  decision and evidence that it helps.
- **Single process.** A multi-process deployment would need a shared queue; `Worker` is the
  only thing that changes.

---

## 13. Test suite

**387 tests across 21 files** (Phase 3 adds 63).

Media tests run against **real FFmpeg** with fixtures generated at test time — no committed
binaries, no downloads. They are skipped when ffmpeg is unavailable so an unrelated
environment problem cannot fail the suite.

| File                              | Covers                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `tests/jobs.test.ts` (26)         | State machine, illegal transitions, terminal immutability, progress parser          |
| `tests/job-store.test.ts` (19)    | Persistence, crash recovery, worker concurrency, slot release, traversal            |
| `tests/audio-extract.test.ts` (6) | Real extraction, format, duration tolerance, cancel, corrupt source                 |
| `tests/job-api.test.ts` (12)      | Full HTTP pipeline, no path leakage, cancellation, recovery on the real entry point |
| `tests/boundary.test.ts` (+5)     | Core purity, dependency direction, no shell, one job type, Phase 3 scope            |

### A flake worth recording

A pre-existing Phase 1 test began failing ~3 runs in 10 with `ECONNRESET`. It was not a bug in
that test: with file parallelism on a 16-core box, the new FFmpeg suites saturated the machine,
starved the event loop of the worker running an HTTP test, and undici reset the connection. The
failure landed on unrelated pure-logic code — the signature of an environment problem
masquerading as a code bug.

Fixed by serialising test files (`fileParallelism: false`). Verified 8/8 clean runs afterwards.
