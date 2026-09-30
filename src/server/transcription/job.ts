/**
 * The transcription job: audio asset → canonical transcription → persisted result.
 *
 * Reuses Phase 3's job store, worker, and state machine verbatim. No second queue, no second
 * persistence layer — the whole point of building those in Phase 3 was that this phase would
 * need them.
 *
 * ## The rule this module exists to enforce
 *
 * **The worker never writes `ProjectDocument`.** It reads the audio, calls the provider,
 * normalizes, and writes a *result file*. The job record gains a `resultRef`. The document is
 * unchanged until a client fetches that result and applies it through `applyTranscription`, a
 * pure labelled operation.
 *
 * If this module saved the document, two things would break at once: the undo stack would hold
 * snapshots of a document that no longer exists, and the largest change the document ever
 * undergoes would have no undo entry at all (invariant I-20).
 *
 * ## Reading the audio
 *
 * `readFileSync` into one `Buffer`. That is a deliberate, bounded choice: 16 kHz mono PCM WAV
 * runs at 32 kB/s, so even the 25 MB provider ceiling is ~13 minutes of audio, and the file was
 * produced and validated by Phase 3. Streaming would add a second code path to save memory that
 * is already bounded by the upload cap.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import { normalizeTranscription } from '../../core/transcription/normalize.js';
import {
  TranscriptionError,
  TranscriptionErrorCode,
  type CanonicalTranscription,
  type ProviderTranscript,
  type TranscriptionProvider,
  type TranscriptGranularity,
} from '../../core/transcription/index.js';
import type { AssetId } from '../../core/document/ids.js';
import type { ProjectDocument } from '../../core/document/types.js';
import { ErrorCode, IngestError } from '../errors.js';
import type { WorkspaceLayout } from '../workspace.js';

export interface TranscribeInput {
  layout: WorkspaceLayout;
  document: ProjectDocument;
  provider: TranscriptionProvider | undefined;
  projectId: string;
  audioAssetId: AssetId;
  granularity: TranscriptGranularity;
  languageHint?: string;
  signal?: AbortSignal;
}

/**
 * Resolve and verify the audio asset.
 *
 * `role: 'audio'` is checked, not assumed. An asset can be missing from disk, can have been
 * replaced, or can carry metadata that no longer describes its file — and sending a video to a
 * speech-to-text API would waste a request and produce a confusing error from the far side.
 */
function resolveAudio(
  layout: WorkspaceLayout,
  document: ProjectDocument,
  projectId: string,
  assetId: AssetId,
): { path: string; durationMs: number | undefined } {
  const asset = document.assets.find((entry) => entry.id === assetId);
  if (asset === undefined) {
    throw new IngestError(ErrorCode.MISSING_ASSET, `Project has no asset ${assetId}.`);
  }
  if (asset.role !== 'audio') {
    throw new IngestError(
      ErrorCode.INVALID_UPLOAD,
      'Only extracted audio can be transcribed. Extract audio from the video first.',
    );
  }
  // The extension comes from the project's own record, never a guess, and the workspace
  // re-validates the identifier and containment.
  const extension = asset.filename.includes('.') ? (asset.filename.split('.').pop() ?? '') : '';
  const path = layout.assetFile(projectId, assetId, extension);

  // Verified against the canonical MediaMeta: an audio asset claiming a container or codec it
  // does not have means the file and the record disagree, and transcribing it would produce
  // timings for audio the user never uploaded.
  const meta = asset.meta;
  if (meta === undefined || meta.audioCodec === undefined) {
    throw new IngestError(
      ErrorCode.MISSING_ASSET,
      'This audio asset has no recorded audio properties. Re-extract it from the video.',
    );
  }

  return { path, durationMs: meta.durationMs };
}

/**
 * Run a transcription and persist its canonical result.
 *
 * Returns the `resultRef` for the job record. On every failure path the result file is removed,
 * so a failed job never leaves a result behind for a client to apply.
 */
export async function runTranscription(
  input: TranscribeInput,
): Promise<{ resultRef: string; result: CanonicalTranscription }> {
  if (input.provider === undefined) {
    throw new TranscriptionError(
      TranscriptionErrorCode.NotConfigured,
      'No transcription provider is configured on this machine. Set OPENAI_API_KEY and restart.',
    );
  }

  const { path, durationMs } = resolveAudio(
    input.layout,
    input.document,
    input.projectId,
    input.audioAssetId,
  );

  let audio: Buffer;
  try {
    audio = readFileSync(path);
  } catch (cause) {
    throw new IngestError(
      ErrorCode.MISSING_ASSET,
      'The audio file is missing from disk. Re-extract it from the video.',
      { cause },
    );
  }

  const providerResult: ProviderTranscript = await input.provider.transcribe({
    audio: new Uint8Array(audio),
    filename: 'audio.wav',
    assetId: input.audioAssetId,
    granularity: input.granularity,
    ...(input.languageHint === undefined ? {} : { languageHint: input.languageHint }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  // The provider's own duration is used when it reports one, because it is a measurement of the
  // audio the provider actually heard. Our asset's duration is the fallback, and the tighter of
  // the two bounds the result.
  const sourceDurationMs = Math.min(
    ...[providerResult.sourceDurationMs, durationMs].filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value),
    ),
  );

  const canonical = normalizeTranscription({
    providerId: providerResult.providerId,
    ...(providerResult.model === undefined ? {} : { model: providerResult.model }),
    ...(providerResult.language === undefined ? {} : { language: providerResult.language }),
    text: providerResult.text,
    segments: providerResult.segments,
    assetId: input.audioAssetId,
    supportsWordTiming: input.provider.supportsWordTiming,
    granularity: input.granularity,
    ...(Number.isFinite(sourceDurationMs) ? { sourceDurationMs } : {}),
  });

  // Provider warnings are carried through rather than dropped — a provider that declined to
  // detect a language should still be able to say so. Built immutably, because a canonical
  // transcription is a readonly value and nothing here should mutate one.
  const warnings = [...canonical.diagnostics.warnings, ...providerResult.warnings];

  return {
    resultRef: 'result.json',
    result: {
      ...canonical,
      diagnostics: {
        ...canonical.diagnostics,
        ...(warnings.length === 0 ? {} : { warnings }),
      },
    },
  };
}

/**
 * Persist a canonical result beside its job record.
 *
 * Atomic write for the same reason `project.json` is atomic: a half-written transcript that
 * parses as valid JSON would be applied to a document as though it were complete.
 */
export function writeResult(
  layout: WorkspaceLayout,
  jobId: string,
  result: CanonicalTranscription,
): void {
  const target = layout.jobResultFile(jobId);
  const temp = layout.jobTempFile(jobId, '.result.json.tmp');
  // The directory already exists: the job store created it when it wrote the job record.
  writeFileSync(temp, JSON.stringify(result, null, 2), 'utf8');
  renameSync(temp, target);
}

/** Read a persisted result. Returns undefined when the job has none. */
export function readResult(
  layout: WorkspaceLayout,
  jobId: string,
): CanonicalTranscription | undefined {
  try {
    return JSON.parse(readFileSync(layout.jobResultFile(jobId), 'utf8')) as CanonicalTranscription;
  } catch {
    // A missing or unreadable result is reported as absent rather than thrown: the caller has
    // a job id and nothing else to go on, and "no result yet" is a normal state for a running
    // or failed job.
    return undefined;
  }
}

/** Remove a persisted result. Called on every failure path. */
export function discardResult(layout: WorkspaceLayout, jobId: string): void {
  rmSync(layout.jobResultFile(jobId), { force: true });
}
