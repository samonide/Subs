# Phase 1 — Ingest & Project Persistence

Architecture reference for the storage, ingestion, and persistence layer. Implemented; see
`ARCHITECTURE.md` for the system-level design and `ARCHITECTURE_REVIEW.md` for the canonical
decisions.

---

## Storage layout

```
workspace/
  projects/
    <projectId>/
      project.json                 # the ProjectDocument — the source of truth
      media/
        <assetId>/
          original.<ext>           # the bytes, named by us
  tmp/                             # job scratch
```

**The rule:** paths derive from server-generated identifiers only. A `projectId` or
`assetId` arriving from a request is untrusted and must pass `isSafeIdentifier`
(`/^[A-Za-z0-9_-]{1,64}$/`) before it is joined into a path. The user's original filename is
stored as `AssetRecord.filename` for **display only** and is never a path component.

`WorkspaceLayout` is the single place that builds paths, and every path it returns passes
through `assertInsideRoot`.

### Why the document holds no filesystem path

`ProjectDocument` references assets by **role** (`sourceVideo`, `audio`, `font`), never by
path or file id. Two consequences:

- The document is portable — it can be moved, backed up, or synced without rewriting paths.
- Swapping the underlying media file updates everything automatically, and no segment or
  asset can reference a file that has been deleted.

Absolute paths exist only in the `IngestResult` returned to the caller, which never reaches
the document.

---

## Ingestion flow

```
incoming stream
  → validate declared metadata (S-2, S-3)   ← before any bytes are accepted
  → mint assetId                               ← destination is now fully determined
  → create media/<assetId>/
  → stream bytes to original.<ext>  (cap enforced during transfer, S-4)
  → ffprobe                                    ← the authoritative type check
  → canonical MediaMeta
  → container/extension consistency check
  → return IngestResult
  → caller appends the asset and saves the project
```

Two ordering decisions carry most of the safety:

1. **Metadata is validated before the disk is touched.** A rejected `.exe` never creates a
   directory.
2. **The document learns about the asset only after the probe succeeds.** An asset that
   failed to ingest is never referenced by a persisted project, so a crash between "file
   written" and "project saved" leaves an orphan file — swept by `tmp`/orphan GC — rather
   than a project pointing at a nonexistent asset.

### Failure and cleanup

Every failure path removes the partial asset directory:

| Failure                         | Result                                         |
| ------------------------------- | ---------------------------------------------- |
| Unsupported extension / MIME    | Rejected before writing; nothing created       |
| Empty upload                    | Rejected; directory removed                    |
| Size cap exceeded               | Stream stopped mid-transfer; directory removed |
| Stream interrupted              | Directory removed                              |
| ffprobe fails / file is corrupt | Directory removed                              |
| Container contradicts extension | Directory removed                              |
| Cancelled                       | Directory removed                              |

A partial file can therefore never be mistaken for a valid asset.

**Deferred deliberately:** no orphan-sweep daemon. `ProjectStore.findMissingAssets()` reports
assets whose files are missing, and `tmp/` is swept, but automatic reclamation of orphans
from a crash mid-ingest is Phase 13 work (long-file robustness). Documented rather than
silently skipped.

---

## MediaMeta

Canonical, minimal, and the only media shape the rest of the application sees. Raw ffprobe
JSON is **not stored on the document** — it contains absolute paths and a large amount of
information the product does not use, which would make project files non-portable and
hard to diff. The raw probe is returned to the caller for diagnostics only.

| Field                                    | Source                                          | Notes                                           |
| ---------------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| `durationMs`                             | `format.duration`                               | Integer ms, rounded. Never a float              |
| `width` / `height`                       | video stream                                    | Coded dimensions                                |
| `displayWidth` / `displayHeight`         | derived                                         | After rotation; the axes swap on a quarter turn |
| `rotation`                               | `side_data_list[].rotation`, else `tags.rotate` | Normalised to 0/90/180/270                      |
| `frameRateNum` / `frameRateDen`          | `avg_frame_rate`, else `r_frame_rate`           | **Exact rational. Never collapsed to a float**  |
| `frameRateMode`                          | inferred                                        | `cfr` or `vfr`                                  |
| `codec`                                  | video stream                                    | e.g. `h264`                                     |
| `container`                              | `format.format_name`                            | e.g. `mov,mp4,m4a,3gp,3g2,mj2`                  |
| `audioCodec` / `sampleRate` / `channels` | audio stream                                    | Absent for video-only                           |

### Frame rate

ffprobe reports rates as `"30000/1001"` or `"30/1"`. The pair is parsed and stored as
integers; the string form is discarded. `29.97` is never produced, because assuming 30fps on
a 29.97 source drifts ~3.6 seconds per hour (`ARCHITECTURE_REVIEW.md` §6.2).

`frameRateMode` is inferred by comparing `r_frame_rate` with `avg_frame_rate`. When they
disagree, or when only one is present, the answer is `vfr` — deliberately conservative,
because a wrong `cfr` misleads playback and export in ways a wrong `vfr` does not. This is
the first evidence collected toward risk **R-21** (seeking strategy for VFR sources).

### Rotation

Two shapes exist and **both** are handled, because current ffmpeg writes `side_data_list`
while older muxers write a `rotate` tag, and missing the common one leaves portrait phone
video sideways in the editor. Side data wins when both are present.

---

## File type policy

Three signals, none trusted alone:

1. **Extension** — must be in the allow-list: `mp4`, `m4v`, `mov`, `webm`, `mkv`.
2. **Declared MIME** — advisory. A type outside the allow-list is rejected; a _missing_ or
   unrecognised one is not, because browsers are unreliable and the probe is authoritative.
3. **ffprobe container** — the real check. A `.mp4` that is actually a WebM is rejected
   despite passing the first two.

This is a deliberately small set. A subtitle editor for short-form video is not a demuxer
for every codec on earth, and an allow-list is a security control as much as a product
decision.

Note that `matroska,webm` is ffprobe's container string for **both** WebM and MKV. The
`webm` member is the only signal that distinguishes them.

---

## Project persistence

| Operation                | Behaviour                                                         |
| ------------------------ | ----------------------------------------------------------------- |
| `create(name)`           | Builds a valid empty document (with a default style) and saves it |
| `save(doc)`              | Validates, then writes atomically                                 |
| `load(id)`               | Reads, migrates, validates; typed error on any failure            |
| `remove(id)`             | Recursive delete                                                  |
| `list()`                 | Project ids on disk, filtering non-conforming directory names     |
| `findMissingAssets(doc)` | Reports assets whose files are absent                             |

### Atomic writes

`save` writes to `.project-<id>.json.tmp` in the same directory, then renames over the
target. A rename within a directory is atomic on POSIX, so a crash or a full disk can leave
the temporary file behind but can **never** leave a half-written `project.json` — the only
valid copy is never the damaged one. Validation runs _before_ any write, so an invalid
document never reaches disk at all.

### Schema versions

`MediaMeta` gained `frameRateMode` and `container` in this phase, so the schema moved v1 → v2
and a migration step was registered. The change is additive and optional, so v1 documents
remain valid; the step is still recorded and tested because a version bump without a
migration is a lie about the mechanism, and the next non-additive change needs the pattern
already in place.

`migrate` stamps the upgraded version onto the result. A migrated document that kept its
old number would re-run every step on the next load.

A document from a **newer** build is refused rather than half-loaded, because partial load of
a subtitle document means silently mangled timing.

---

## Security controls (S-1 … S-7)

| #       | Control                       | Where                                                                    | Verified by                                                                  |
| ------- | ----------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| **S-1** | Path traversal                | `assertSafeIdentifier` + `assertInsideRoot`                              | 12 tests: traversal, `..`, separators, absolute paths, **symlink escape**    |
| **S-2** | Filename sanitisation         | `sanitizeFilename` — strips directories, control chars, NUL, caps length | 9 tests: POSIX/Windows paths, NUL, traversal prefixes, long names            |
| **S-3** | Extension + MIME allow-list   | `filetypes.ts`                                                           | 8 tests: supported set, rejected set, MIME normalisation                     |
| **S-4** | Size cap **during** streaming | `createSizeCap` in `ingest.ts`                                           | 3 tests, including a stream that would produce 2GB being stopped after <64MB |
| **S-5** | Argv-only process spawn       | `spawn('ffprobe', args, …)` — never a shell string                       | Source assertion + a canary test proving no command executes                 |
| **S-6** | Timeout + kill                | `runFfprobe` — wall-clock timeout, `SIGTERM` then `SIGKILL`              | Exercised by the probe error paths                                           |
| **S-7** | Protocol allow-list           | Only local absolute paths are ever passed                                | By construction: the server never accepts a URL                              |

Two details worth recording, because both were bugs found by these tests:

- **The lexical containment check must not short-circuit the symlink check.** An early
  version returned as soon as the lexical check passed, so `<projects>/evil/target.txt` —
  lexically contained, with `evil` a symlink to `/etc` — was accepted. `assertInsideRoot` now
  resolves the deepest existing ancestor through `realpath` and compares like-for-like.
- **The size cap must not destroy the request stream.** Doing so aborts the HTTP connection,
  and the client sees a network error instead of the 413 that explains what happened. The
  transform is stopped and the source paused, so the response is still deliverable.

**S-14** (bind to `127.0.0.1`) applies to the server, which binds loopback by default.

---

## Server boundary

`src/server/http.ts` uses **`node:http` directly**, not Fastify. D-7b deferred the framework
decision, and adopting it now — on the strength of "we now need a server" rather than on
evidence about the surface — would be exactly the premature commitment the plan warns about.
Three routes do not justify a framework; a boundary test asserts no framework is present.

The layer streams request bodies and never buffers them, enforces the cap while streaming,
binds to loopback, and converts typed `IngestError`s into structured JSON. An unexpected
error yields a generic 500 with no stack trace.

---

## Error model

One class, `IngestError`, with a machine-readable `code` and a `retryable` flag — the
smallest model that lets a caller distinguish "too large" from "corrupt" from "no such
project". A flat hierarchy would be enterprise scaffolding for one phase.

| Code                                      | HTTP | Meaning                                            |
| ----------------------------------------- | ---- | -------------------------------------------------- |
| `INVALID_UPLOAD`                          | 400  | Malformed before any bytes were accepted           |
| `PATH_VIOLATION`                          | 400  | Escaped the workspace, or a bad identifier         |
| `UNSUPPORTED_MEDIA`                       | 415  | Not an accepted type, or contradicts its container |
| `FILE_TOO_LARGE`                          | 413  | Exceeded the cap                                   |
| `PROJECT_NOT_FOUND` / `MISSING_ASSET`     | 404  | Absent                                             |
| `INVALID_PROJECT`                         | 422  | Failed validation or migration                     |
| `INSPECTION_FAILED`                       | 500  | ffprobe could not read the file                    |
| `TOOL_UNAVAILABLE` / `INSPECTION_TIMEOUT` | 503  | ffprobe missing or hung                            |
| `STORAGE_FAILURE`                         | 500  | Filesystem failure                                 |
| `CANCELLED`                               | 499  | Aborted                                            |

---

## Module boundaries

```
src/core/     pure domain. No filesystem, no HTTP, no FFmpeg, no browser APIs.
src/server/   infrastructure. Consumes core; core never imports it.
```

The dependency direction is enforced by a test that fails if any file under `src/core`
imports the server layer — the one direction that would let a process or filesystem
dependency leak back into the layer that must stay portable.

---

## Known limitations

- **No orphan sweeping.** A crash between "file written" and "project saved" leaves an
  unreferenced directory. Reported by `findMissingAssets`, reclaimed in Phase 13.
- **No resumable or chunked upload.** A dropped connection restarts the transfer.
- **No proxy transcoding.** Large or awkward codecs are stored as-is until Phase 10.
- **No `metadata.json` written yet.** The layout reserves it for the raw probe; the document
  is the source of truth, so writing it now would duplicate data with no consumer.
- **Cancellation is cooperative.** An in-flight ffprobe is killed on abort; a partially
  written file is cleaned up on the next attempt.
