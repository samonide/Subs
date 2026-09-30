/**
 * Audio extraction: the Phase 3 job pipeline, end to end.
 *
 * ```
 *  request ──▶ enqueue job ──▶ worker slot ──▶ FFmpeg (child process)
 *                                                      │
 *                     ┌────────────────────────────────┘
 *                     ▼
 *            temp output ──▶ validate ──▶ atomic rename ──▶ asset registered
 *                     │
 *                     └─(failure/cancel)─▶ temp deleted, job failed
 * ```
 *
 * ## The rule this module exists to enforce
 *
 * The worker writes **media files and job records**, never `ProjectDocument`. The document
 * is the client's canonical state (invariant I-20), and it is updated by the HTTP layer
 * after the job completes, as an explicit step with its own error path.
 *
 * The tempting shortcut is to have the worker call `projectStore.save()` when it finishes.
 * That inverts ownership: a background process would rewrite the document the user may have
 * edited in the meantime, and the largest change a job causes would have no undo entry. So
 * the asset registration here is deliberately *not* a document mutation — it returns what
 * changed, and `registerAudioAsset` applies it to the document on the request side.
 *
 * ## Temp-then-rename
 *
 * FFmpeg writes incrementally to `<assetId>/.audio.wav.tmp`. Only after the process exits 0
 * *and* the output probes as real audio is it renamed to its final name. A killed or failed
 * extraction therefore leaves a dot-prefixed temp file that no asset lookup can resolve,
 * rather than a truncated file that looks valid to everything downstream.
 *
 * The final name follows the same rule as every other stored asset — `original.<ext>` inside
 * the asset's own directory — so `WorkspaceLayout.assetFile` stays the only way to resolve an
 * asset to a path, and the media endpoint serves derived audio with no special case.
 */

import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  JobStatus,
  JobType,
  type JobFailureCodeValue,
  type JobProgress,
  type JobRecord,
} from '../../core/jobs/index.js';
import { newAssetId, type AssetId } from '../../core/document/ids.js';
import type { MediaMeta } from '../../core/document/types.js';
import { ErrorCode, IngestError } from '../errors.js';
import { extractAudio, outcomeToError } from './ffmpeg.js';
import { runFfprobe, toMediaMeta, hasAudioStream } from './probe.js';
import { type WorkspaceLayout } from '../workspace.js';
import { ProjectStore } from '../project/store.js';

/** The canonical transcription-ready audio format. See docs/PHASE3.md for the rationale. */
export const CANONICAL_AUDIO = {
  extension: 'wav',
  codec: 'pcm_s16le',
  sampleRate: 16000,
  channels: 1,
} as const;

/**
 * FFmpeg output flags for the canonical format. Fixed here; never caller-supplied.
 *
 * `-f wav` is explicit and load-bearing. FFmpeg infers its muxer from the output extension,
 * and the temp file is named `.audio.wav.tmp` — which tells it nothing. Without an explicit
 * `-f`, a perfectly good extraction fails with "Unable to find a suitable output format".
 */
const AUDIO_ARGS: readonly string[] = [
  '-c:a',
  CANONICAL_AUDIO.codec,
  '-ar',
  String(CANONICAL_AUDIO.sampleRate),
  '-ac',
  String(CANONICAL_AUDIO.channels),
  '-f',
  'wav',
];

/**
 * How far the extracted audio's duration may differ from its source.
 *
 * Not zero, and deliberately not "close enough to ignore". A lossy source decode plus a
 * resample to 16 kHz can legitimately differ by a few milliseconds at the tail, and
 * rejecting that would make the pipeline fail on good media. But a *meaningful* difference
 * means the audio does not correspond to the video — subtitles generated from it would drift
 * against the picture, which is the one failure this whole product exists to avoid. So the
 * difference is measured and reported rather than assumed either way.
 */
export const DURATION_TOLERANCE_MS = 250;

export interface ExtractAudioDeps {
  layout: WorkspaceLayout;
  signal: AbortSignal;
  onProgress?: (progress: JobProgress) => void;
}

export interface ExtractAudioResult {
  /** The new asset's id. Registered against the document by the caller. */
  assetId: AssetId;
  meta: MediaMeta;
  /** Human-readable difference between source and extracted audio duration. */
  durationDeltaMs: number;
  transform: string;
}

/**
 * Locate the source asset's stored file, verifying it exists.
 *
 * The extension comes from the project's own record, never from a request or a guessed
 * default, and the workspace layer re-validates the identifier and containment — so a
 * traversal attempt fails here before it can reach a path.
 */
function resolveSource(
  layout: WorkspaceLayout,
  doc: { assets: ReadonlyArray<{ id: string; filename: string }> },
  projectId: string,
  assetId: AssetId,
): string {
  const asset = doc.assets.find((entry) => entry.id === assetId);
  if (asset === undefined) {
    throw new IngestError(ErrorCode.MISSING_ASSET, `Project has no asset ${assetId}.`);
  }
  const extension = asset.filename.includes('.') ? (asset.filename.split('.').pop() ?? '') : '';
  const path = layout.assetFile(projectId, assetId, extension);
  try {
    statSync(path);
  } catch {
    throw new IngestError(
      ErrorCode.MISSING_ASSET,
      `Asset ${assetId} has no file on disk. It may have been removed outside the app.`,
    );
  }
  return path;
}

/**
 * Run the extraction.
 *
 * Assumes the job has already been transitioned to `processing` by the caller. Returns the
 * result on success and throws a typed `IngestError` on every failure path — including
 * cancellation — after guaranteeing the temp file is gone.
 */
export async function runAudioExtraction(
  deps: ExtractAudioDeps,
  input: { projectId: string; assetId: AssetId; sourceDurationMs?: number },
): Promise<ExtractAudioResult> {
  const { layout, signal } = deps;

  const projects = new ProjectStore(layout);
  const doc = await projects.load(input.projectId);

  const sourcePath = resolveSource(layout, doc, input.projectId, input.assetId);

  const assetId = newAssetId();
  const assetDir = layout.assetDir(input.projectId, assetId);
  mkdirSync(assetDir, { recursive: true });

  // Dot-prefixed and suffixed `.tmp`: `WorkspaceLayout` only ever builds paths of the form
  // `original.<ext>`, so a temp name that cannot be produced by that rule is unreachable by
  // every reader in the system — the strongest available guarantee that a partial write is
  // never mistaken for an asset.
  const tempAudio = join(assetDir, '.audio.wav.tmp');
  const finalAudio = layout.assetFile(input.projectId, assetId, CANONICAL_AUDIO.extension);
  const progressPath = join(assetDir, '.progress');

  // Any early return must leave no file behind. This is the single guarantee that a failed
  // extraction cannot become a registered asset.
  const cleanupTemp = (): void => {
    rmSync(tempAudio, { force: true });
    rmSync(progressPath, { force: true });
  };

  try {
    const outcome = await extractAudio({
      inputPath: sourcePath,
      outputPath: tempAudio,
      progressPath,
      outputArgs: AUDIO_ARGS,
      sourceDurationUs:
        input.sourceDurationMs === undefined ? undefined : input.sourceDurationMs * 1000,
      signal,
      onProgress: deps.onProgress,
    });

    if (!outcome.ok) {
      cleanupTemp();
      // A cancelled run is a cancellation, not a failure: it deserves its own code so the UI
      // can say "cancelled" rather than "something went wrong".
      if (outcome.failureCode === 'cancelled') {
        throw new IngestError(ErrorCode.CANCELLED, 'Audio extraction was cancelled.', {
          cause: outcome,
        });
      }
      throw outcomeToError(outcome, 'extracting audio');
    }

    // Exit 0 and a file exist. Now the real question: is it actually audio? FFmpeg can
    // produce a zero-length or otherwise unusable file and still exit cleanly, and a
    // transcription provider receiving that would fail much later with a far worse message.
    const raw = await runFfprobe(tempAudio);
    if (!hasAudioStream(raw)) {
      cleanupTemp();
      throw new IngestError(
        ErrorCode.OUTPUT_INVALID,
        'Extraction produced a file with no audio track.',
      );
    }

    const meta = toMediaMeta(raw);
    if (meta.durationMs <= 0) {
      cleanupTemp();
      throw new IngestError(
        ErrorCode.OUTPUT_INVALID,
        'Extraction produced a zero-length audio file.',
      );
    }

    // Measured, not assumed. Reported so a caller can surface it; never silently accepted
    // when it exceeds the tolerance.
    const durationDeltaMs =
      input.sourceDurationMs === undefined ? 0 : meta.durationMs - input.sourceDurationMs;

    if (Math.abs(durationDeltaMs) > DURATION_TOLERANCE_MS) {
      cleanupTemp();
      throw new IngestError(
        ErrorCode.OUTPUT_INVALID,
        `Extracted audio is ${Math.abs(durationDeltaMs)}ms ${durationDeltaMs > 0 ? 'longer' : 'shorter'} than the source video. ` +
          'Subtitles generated from it would drift against the picture.',
      );
    }

    // Only now does the temp file become canonical.
    rmSync(progressPath, { force: true });
    renameSync(tempAudio, finalAudio);

    const transform = `ffmpeg -i <source> -vn ${AUDIO_ARGS.join(' ')} <output>`;
    writeAudioMetadata(layout, input.projectId, assetId, {
      sourceAssetId: input.assetId,
      meta,
      durationDeltaMs,
      transform,
    });

    return { assetId, meta, durationDeltaMs, transform };
  } catch (error) {
    // Any throw at all must not leave a partial asset directory behind that looks valid.
    cleanupTemp();
    if (error instanceof IngestError) {
      throw error;
    }
    throw new IngestError(ErrorCode.PROCESSING_FAILED, 'Audio extraction failed.', {
      retryable: true,
      cause: error,
    });
  }
}

/**
 * Write the audio asset's own metadata sidecar.
 *
 * Stored beside the file, not in `ProjectDocument`, and only once the audio is final. Its role
 * is to let Phase 4 find the file and its properties without probing it again; the document
 * still holds the authoritative asset record.
 */
function writeAudioMetadata(
  layout: WorkspaceLayout,
  projectId: string,
  assetId: AssetId,
  data: {
    sourceAssetId: string;
    meta: MediaMeta;
    durationDeltaMs: number;
    transform: string;
  },
): void {
  const target = join(layout.assetDir(projectId, assetId), 'audio-metadata.json');
  const temp = join(layout.assetDir(projectId, assetId), '.audio-metadata.tmp');
  mkdirSync(layout.assetDir(projectId, assetId), { recursive: true });
  writeFileSync(
    temp,
    JSON.stringify(
      {
        assetId,
        role: 'audio',
        derivedFrom: data.sourceAssetId,
        meta: data.meta,
        durationDeltaMs: data.durationDeltaMs,
        transform: data.transform,
      },
      null,
      2,
    ),
    'utf8',
  );
  renameSync(temp, target);
}

/** Convenience re-export so the HTTP layer can build a job without importing core twice. */
export { JobType, JobStatus };
export type { JobFailureCodeValue, JobProgress, JobRecord };
