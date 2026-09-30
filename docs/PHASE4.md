# Phase 4 — Transcription Provider Integration

Phase 4 turns extracted audio into a **canonical, validated, project-applicable transcription**.

```
VIDEO → AUDIO (Phase 3) → TRANSCRIPTION → CANONICAL TIMESTAMPED RESULT → PROJECT-APPLICABLE OPERATION
```

No timeline, no segment editing UI, no styling, no rendering. Those are Phase 5+.

---

## 1. The core requirement

**A provider's response never enters the core document model directly.** The pipeline is strictly:

```
provider adapter  →  ProviderTranscript  →  normalizeTranscription  →  applyTranscription  →  document
   (vendor JSON)      (intermediate)          (pure validation)          (pure operation)
```

Three types, three responsibilities:

| Stage           | Type                     | Owns                                                                  |
| --------------- | ------------------------ | --------------------------------------------------------------------- |
| Adapter         | `ProviderTranscript`     | Translating vendor field names and HTTP into one shape                |
| Normalizer      | `CanonicalTranscription` | Validation, integer-ms conversion, sorting, confidence/timing honesty |
| Document writer | `ProjectDocument`        | Segments, words, provenance, invariant satisfaction                   |

The split is deliberate: the adapter has **not** validated anything, so claiming it returns a
canonical result would hide the one step that guarantees the document invariants hold. Keeping
validation in one pure, fully-tested function means the expensive-to-get-wrong logic exists once
no matter how many providers are added.

---

## 2. First provider: OpenAI `whisper-1`

### Why `whisper-1` and not the recommended `gpt-transcribe`

This looks backwards, so the reasoning is worth stating plainly.

OpenAI's own documentation recommends `gpt-transcribe` for ordinary file transcription — and
then states that `timestamp_granularities` "is only supported for `whisper-1`". `gpt-transcribe`
returns text and detected language but **no segment or word timings**.

Without timestamps there is no subtitle application, because the entire product is captions
synchronised to picture. So the first provider uses `whisper-1`.

The choice is not baked in: `supportsWordTiming` is **derived from the configured model**, and
`OPENAI_TRANSCRIBE_MODEL` can point elsewhere. Configuring a timestamp-capable successor is a
config change, not a rewrite.

### What was verified

| Verification                                                                      | Status                                                                           |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Adapter against recorded provider responses                                       | ✅ 25 contract tests                                                             |
| Adapter against a **live HTTP endpoint** (real multipart, real fetch, real parse) | ✅ verified manually — provider received the 64,521-byte WAV                     |
| Full flow against a live server                                                   | ✅ `queued → processing → completed`, `Transcribe (openai, 2 segments, 4 words)` |
| **Real OpenAI API**                                                               | ❌ **NOT PERFORMED — no `OPENAI_API_KEY` on this machine**                       |

The distinction matters. Everything below was verified against a _local fixture provider_ that
speaks the same protocol. That proves the adapter, the normalizer, the job, the routes, and the
document writer — it does **not** prove that OpenAI's production API returns exactly this shape
today. A live call must be made before trusting the integration against the real service.

Environment on this machine: no `OPENAI_API_KEY`, no local Whisper runtime, no `faster-whisper`,
no `whisper` package. Network egress to `api.openai.com` is reachable (returns 401 unauthenticated).

### A bug this phase caught by recording the real field names

The first contract fixture was written from memory with word entries shaped `{ text, start, end }`.
OpenAI's real API uses **`word`** for the text and **`probability`** for confidence. Every
word-bearing test failed, and the fix went into the adapter — which is exactly where a vendor
field-name difference belongs. The normalizer speaks one vocabulary; a second provider with its
own spelling costs nothing.

Had the fixture been generated from the adapter's own expectations, this would have shipped and
failed on first real use.

---

## 3. The provider interface

```ts
interface TranscriptionProvider {
  readonly id: string;
  readonly supportsWordTiming: boolean;
  transcribe(input: TranscriptionRequest): Promise<ProviderTranscript>;
}
```

Application terms, not vendor terms. No SDK objects, no HTTP, no vendor vocabulary.

Two deliberate choices:

- **`supportsWordTiming` is declared up front.** The UI can explain a limitation _before_ running
  a job rather than discovering it from the result.
- **Audio arrives as `Uint8Array`, not a path.** That is what lets a future local provider
  (Whisper on disk) and a hosted one (HTTP upload) share this interface. Paths are
  infrastructure, and infrastructure does not belong in a core signature.

`granularity: 'segment' | 'word'` is a **request, not a promise.** A provider asked for words and
unable to supply them returns segment-only data, and the result carries
`wordTimingAvailable: false` with a warning. Nothing pretends a capability the provider lacks.

---

## 4. Normalization rules

Every rule is one of three kinds, chosen on purpose.

### Rejected — we cannot know which value is wrong

| Condition                                      | Why not repaired                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| Empty or absent segments array                 | Nothing to recover                                                                  |
| `endMs <= startMs` on a segment                | A zero-length word is real (a click, a breath); inventing a duration is fabrication |
| Negative or non-finite timestamp               | Provider contradicts itself                                                         |
| Segment/word ending > source duration + 500 ms | Describes audio we do not have                                                      |
| Non-object segment or word, missing text       | Malformed payload                                                                   |

### Normalized — with the rule stated

| Rule                    | Detail                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Seconds → integer ms    | **Rounded, not floored.** Flooring collapses 0.0004 and 0.0009 onto the same millisecond, erasing a boundary the provider did distinguish |
| Segment ordering        | Sorted by `startMs`. Sorting cannot change a timestamp, so this is ordering, not repair                                                   |
| Word whitespace         | Leading/trailing trimmed; interior spacing preserved verbatim                                                                             |
| Duration slack          | 500 ms tolerance for container/resample rounding at the tail                                                                              |
| Out-of-range confidence | Dropped, not clamped to 0 or 1                                                                                                            |

### Preserved as-is

Text and wording. **This phase never rewrites, paraphrases, re-punctuates, or corrects spelling.**
There is no LLM post-processing stage. Faithful transcription is the goal; editorial cleanup is a
separate product decision.

### The one widening exception

A segment span is widened to contain its own words. This is the documented exception to
"reject, don't repair", and it is safe because it can only ever widen a span to a time the
provider itself reported — the max of two reported values cannot invent one.

Writing that test also **exposed a real hole**: because the span was widened to fit its words, a
word extending far past the end of the audio escaped the duration check entirely. There is now an
explicit word-level duration check, and a test for it.

---

## 5. Confidence and timing honesty

### Absent confidence is not zero

```ts
confidence?: number   // absent when the provider supplied none
```

TypeScript's optional property is what keeps the two distinguishable through
`JSON.stringify` → disk → `JSON.parse` (invariant I-10). Optional fields are spread in only when
present, so an absent confidence is genuinely absent from JSON — not `null`, not `0`.

A provider that reports no confidence has told us **nothing**. Recording `0` would assert the
model was maximally unsure, which is a different and false claim. A genuine `0` is preserved as
`0`, and a test asserts both survive a serialization round trip.

Confidence is **metadata only** in this phase. It is not used to "fix" a transcript, and there is
no quality scoring.

### Timing source

`measured` means the provider reported that time. `synthesized` means our own heuristic produced
it. **This phase synthesizes nothing** — every word timing that exists came from the provider and
is marked `measured`. A provider that returns no word timings produces none; they are never
distributed across a segment, because a fabricated word-level highlight is worse than an absent
one (invariants I-10, I-11).

### Language

Preserved from the provider's own detection only. **Never inferred** from a locale, an IP, or a
filename. A missing language produces a warning, not a guess. The model is language-neutral.

---

## 6. Provenance

Stored on `ProjectDocument.transcription`:

```json
{
  "providerId": "openai",
  "model": "whisper-1",
  "language": "en",
  "generatedAt": "2026-01-01T00:00:00.000Z"
}
```

Alongside per-segment `origin: 'asr'` and per-word `timingSource`, this answers: which provider,
which model, when, from which audio asset, and whether timing was measured or synthesized.

The raw provider response is **not** stored. It is large, vendor-shaped, contains no information
this product uses, and storing it would turn a vendor format into a de-facto part of the document
schema.

---

## 7. The document-writing operation

`applyTranscription(doc, result, placement, generatedAt)` — pure, no clock, no I/O. `generatedAt`
is injected so the same result always produces the same document.

- `segment.text` is **derived from the word join**, never copied from the provider's segment
  string (invariant I-8). The cache is what the validator checks.
- Segments are created with `origin: 'asr'` — machine output, always.
- Confidence is copied only when present.
- Unrelated project state (assets, styles, canvas, id, createdAt) is untouched.

### Re-transcription semantics

The user will transcribe, hand-edit, then re-transcribe. Silently replacing the second result over
the first would destroy their work — precisely the failure this product cannot afford.

| Situation                                             | Result                                               |
| ----------------------------------------------------- | ---------------------------------------------------- |
| No tracks yet                                         | A new track is created                               |
| Target track holds only `origin: 'asr'` segments      | Replaced wholesale — machine output is not user work |
| Target track holds **any** `origin: 'manual'` segment | **Refused**, naming the count of protected segments  |
| Target track is locked                                | Refused                                              |

There is deliberately **no `force` option**. The only sanctioned way to discard manual work is the
user deleting it themselves.

**Refusing rather than merging** is a deliberate choice for this phase. A merge engine must decide
what to do about a manual edit sitting inside a machine segment's span — split it, keep it,
discard the overlap? Each answer is defensible and each is visible and annoying when wrong.
Refusing names the problem, preserves the work, and leaves the decision to Phase 5's editor, which
can show the user what conflicts. This is a documented Phase 4 rule, not undefined behaviour.

---

## 8. Invariant I-20 — the worker never writes the document

**This is the phase's central guarantee, and it now has tests.**

```
worker → result file → job records resultRef → client fetches → client applies labelled operation
```

The worker writes **media files, job records, and a result file**. It never touches
`project.json`. If it did, two things would break at once: the undo stack would hold snapshots of
a document that no longer exists, and the largest change the document ever undergoes would have
no undo entry at all.

Two routes make this visible:

- `GET /api/jobs/:jobId/result` → the canonical result
- `GET /api/jobs/:jobId/operation` → `{ kind, label, result }` — a **descriptor of an operation**,
  structurally incapable of being a document (no `tracks`, `assets`, or `schemaVersion`)

Verified live: after a completed transcription the document still had `tracks: 0` and
`transcription: undefined`.

---

## 9. Result persistence

The canonical result lives at `workspace/jobs/<jobId>/result.json`, beside the job record.

`JobResult.resultRef` carries only `'result.json'`. The record stays ~500 bytes regardless of
transcript size, so **every status poll stays cheap**, and transcript content never enters the
volatile runtime store where a project document does not belong.

Written atomically (temp + rename) for the same reason `project.json` is: a half-written
transcript that still parses as valid JSON would be applied as though it were complete.

A job with no result returns **409 `RESULT_NOT_READY`**, not 404 — "not finished" and "does not
exist" are different answers, and conflating them sends the UI hunting for a job that is merely
still running.

---

## 10. Error model

Every adapter maps vendor failures into `TranscriptionError` codes:

| Code                 | HTTP | Retryable |
| -------------------- | ---- | --------- |
| `auth`               | 502  | no        |
| `invalid-request`    | 422  | no        |
| `unsupported-audio`  | 422  | no        |
| `rate-limited`       | 429  | **yes**   |
| `timeout`            | 503  | **yes**   |
| `unavailable`        | 503  | **yes**   |
| `malformed-response` | 502  | no        |
| `empty-transcript`   | 502  | no        |
| `cancelled`          | 499  | no        |
| `not-configured`     | 503  | no        |

### Retry policy

**One attempt. No automatic retry.** Retryability is recorded as data on the error, not acted on.
A silent retry loop would burn the user's quota while telling them nothing happened. Phase 4
reports; a human decides.

### Credential and detail handling

`TranscriptionError` carries a user-facing `message` and an optional server-side `detail` that
**never reaches the browser** — `toJSON()` includes only code, message, and retryable. A test
asserts that neither the API key nor the provider's raw payload appears in the user-facing
projection, even when the provider echoes the key back in its error body.

Credentials are read from the environment by `loadProviderConfig`, which returns `undefined`
rather than throwing when unconfigured. A missing key is a normal state in development and CI; it
surfaces as a clear `NotConfigured` at the point of use rather than crashing the server at
startup and taking media playback down with it.

---

## 11. Duplicate jobs

**Allowed, and deduplicated only when the audio asset already has one in flight.**

Two concurrent transcriptions of the same audio are wasteful and produce two results, but they
do not corrupt anything: each is a separate job with its own result file, and applying the second
over the first is a single undoable operation. Deduplicating would need shared state that only pays
off at a scale this application does not have.

Every job is independent; the client chooses which result to apply.

---

## 12. API surface

| Method | Path                                    | Purpose                        |
| ------ | --------------------------------------- | ------------------------------ |
| `POST` | `/api/projects/:p/assets/:a/transcribe` | Queue a transcription → `202`  |
| `GET`  | `/api/jobs/:jobId/result`               | The canonical result, or `409` |
| `GET`  | `/api/jobs/:jobId/operation`            | Operation descriptor           |
| `POST` | `/api/jobs/:jobId/cancel`               | Cancel (from Phase 3)          |

Body: `{ granularity: 'segment' | 'word', language?: string, placement?: ... }`.

No path is exposed. Tests assert no response contains the workspace root or `/tmp/`.

### Audio input contract

`role: 'audio'` is **checked, not assumed**, and `meta.audioCodec` must be present. An asset can
be missing from disk, replaced, or carry metadata that no longer describes its file — and sending
a video to a speech API wastes a request and produces a confusing error from the far side. A
non-audio asset is rejected with a clear message naming the fix.

The audio is read once into a `Buffer`. 16 kHz mono PCM runs at 32 kB/s, so even the 25 MB
provider ceiling is ~13 minutes, and Phase 3 already validated the file. Streaming would add a
second code path to save memory that is bounded by the upload cap.

---

## 13. Security

| Concern               | Control                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| API key               | Environment only; never stored, logged, or placed in the document         |
| Provider error bodies | `detail` never serialized to the browser                                  |
| Filesystem paths      | Never in any response; identifiers validated before any path join         |
| Audio upload size     | 25 MB checked **before** sending                                          |
| Empty audio           | Rejected before sending                                                   |
| Multipart body        | Hand-built; audio copied exactly once (25 MB in, not 50 MB)               |
| Request body          | 64 KB cap on the transcribe JSON                                          |
| Transport             | `fetch` with an explicit timeout, combined with the caller's abort signal |

No secrets in the repository. No credentials invented for the fixture provider.

---

## 14. Future provider evaluation

Phase 4 deliberately does **not** pick a "best" provider, and provides no dashboard or ranking.

What exists for a later comparison:

- **`tests/transcription-provider.test.ts` is a reusable contract suite.** A new adapter runs it
  and inherits the guarantees rather than re-deriving them.
- **`CanonicalTranscription.diagnostics`** already carries model and reported duration — enough to
  compare without re-probing.
- **Fixtures are generated, not downloaded**, so an evaluation corpus can be built locally and
  deterministically.

A later evaluation would compare, on one fixed corpus: transcript text against a reference,
segment and word timing error, language-detection accuracy, latency, and error rate. ASR quality
variance is a known product risk (R-3 in `PRODUCT.md`); Phase 4 makes it _measurable_ and does not
pretend to have answered it.

---

## 15. Known limitations

Honest list:

- **The real OpenAI API has never been called.** No credential on this machine. The adapter is
  verified against recorded responses and a live local endpoint speaking the same protocol.
- **One provider.** The interface supports more; only one adapter exists.
- **No retry.** One attempt, as documented above.
- **No duplicate-job suppression.** Allowed by design.
- **No re-transcription merge.** Refuses rather than guessing; Phase 5 owns the decision.
- **No browser UI.** §34 permits a minimal surface; the HTTP tests observe the flow more
  precisely, and Phase 5 will add the surface where a transcript is actually shown.
- **No progress.** A hosted transcription is one request with no progress channel. The job
  reports `indeterminate` rather than inventing a percentage.
- **Raw provider responses are not retained**, so provider-side debugging has no artifact beyond
  the job record's error detail.

---

## 16. Test suite

**477 tests across 24 files** (Phase 4 adds 89).

| File                                  | Covers                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `transcription-core.test.ts` (52)     | Normalizer rules, rejections, confidence, apply semantics, re-transcription refusal                                     |
| `transcription-provider.test.ts` (25) | Provider contract suite: timings, language, unicode, punctuation, error mapping, capability declaration, no key leakage |
| `transcription-job.test.ts` (11)      | Job lifecycle, not-configured, result storage, **I-20 regression**                                                      |
| `boundary.test.ts` (22, +2)           | Core holds no provider implementation; vendor vocabulary confined to the adapter                                        |

The I-20 regression tests are the ones that matter most here:

- the document is byte-identical before and after a completed transcription;
- `tracks` stays empty and `transcription` stays undefined;
- the operation response carries no document fields;
- applying the result on the client yields a document passing every invariant.

### Boundary checks updated for the new phase

Four Phase 1–3 gates correctly blocked Phase 4 work. Each was updated rather than deleted, and
each now asserts something still true:

- The ingest path stays free of transcription, subtitle, and rendering machinery — later-phase
  directories are excluded explicitly, not the check removed.
- The media pipeline stays free of transcription — Phase 4 added `server/transcription/`, but
  `server/media/` must remain exactly as narrow as Phase 3 left it.
- **New:** core defines no provider implementations and performs no network I/O.
- **New:** vendor vocabulary (`verbose_json`, `timestamp_granularities`, `probability`) is confined
  to the adapter and must never appear in core.
- The job-type assertion now expects exactly two types, so it still functions as a phase gate.
