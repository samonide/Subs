/**
 * Applying a transcription to a project — the client half of invariant I-20.
 *
 * ## The rule this file exists to keep
 *
 * A worker produces a result; **this** produces the document. A background process never writes
 * `project.json`. If it did, the undo stack would hold snapshots of a document that no longer
 * exists, and the largest change the document ever undergoes — a whole transcript — would have
 * no undo entry at all.
 *
 * Every function here is pure. No clock, no filesystem, no provider. `generatedAt` is injected
 * so the same transcript always yields the same operation.
 *
 * ## Re-transcription: what actually happens
 *
 * The user will transcribe, hand-edit, then re-transcribe. Silently replacing the second
 * result over the first would destroy their work, and that is precisely the failure this
 * product cannot afford (DESIGN_PRINCIPLES: *never lose user work*).
 *
 * So the policy is explicit and conservative:
 *
 * | Situation | Result |
 * |---|---|
 * | No tracks yet | A new track is created. |
 * | Target track contains only `origin: 'asr'` segments | Replaced wholesale. Machine output is not user work. |
 * | Target track contains any `origin: 'manual'` segment | **Refused**, with the count of protected segments named. |
 *
 * Refusing rather than merging is a deliberate choice for this phase. A merge engine has to
 * decide what to do about a manual edit that sits inside a machine segment's span — split it,
 * keep it, discard the overlap? Each answer is defensible and each is visible and annoying when
 * wrong. Refusing names the problem, preserves the work, and leaves the decision to Phase 5's
 * editor, which can show the user what conflicts.
 */

import { newSegmentId, newTrackId, newWordId, type TrackId } from '../document/ids.js';
import type {
  ProjectDocument,
  SubtitleSegment,
  SubtitleTrack,
  SubtitleWord,
} from '../document/types.js';
import type { CanonicalTranscription } from './types.js';

export class TranscriptionApplyError extends Error {
  override readonly name = 'TranscriptionApplyError';
  /** Segments that caused a refusal, for a message that names the actual conflict. */
  readonly protectedCount: number;

  constructor(message: string, protectedCount: number) {
    super(message);
    this.protectedCount = protectedCount;
  }
}

export type TranscriptionPlacement =
  /** Create a new track. Refuses if the project already has one. */
  | { readonly kind: 'new-track'; readonly name?: string }
  /**
   * Replace an existing track's content.
   *
   * Refuses when that track holds hand-edited segments. `force` is deliberately absent: the
   * only sanctioned way to discard manual work is the user deleting it themselves.
   */
  | { readonly kind: 'replace-track'; readonly trackId: TrackId };

function buildWords(segment: CanonicalTranscription['segments'][number]): SubtitleWord[] {
  return segment.words.map((word) => {
    // Optional fields are spread in only when present, so an absent confidence is genuinely
    // absent from JSON rather than present-and-undefined (invariant I-9). Recording 0 for an
    // absent confidence would assert maximal uncertainty, which the provider never claimed
    // (invariant I-10).
    const base: SubtitleWord = {
      id: newWordId(),
      text: word.text,
      startMs: word.startMs,
      endMs: word.endMs,
      timingSource: word.timingSource,
    };
    return word.confidence === undefined ? base : { ...base, confidence: word.confidence };
  });
}

function buildSegments(result: CanonicalTranscription): SubtitleSegment[] {
  return result.segments.map((segment) => {
    const words = buildWords(segment);
    // `text` is a cache of the word join, rebuilt rather than taken from the provider's segment
    // string. The two can legitimately differ in trailing whitespace, and the cache is what
    // invariant I-8 checks — so it is derived here, never copied (invariant I-8).
    return {
      id: newSegmentId(),
      startMs: segment.startMs,
      endMs: segment.endMs,
      words,
      // Machine output, always. A later hand edit flips this to 'manual', which is what makes
      // the next re-transcription refuse rather than destroy it.
      origin: 'asr' as const,
      text: words.map((word) => word.text).join(''),
    };
  });
}

/**
 * Apply a canonical transcription, returning a new document.
 *
 * Pure. `generatedAt` is supplied by the caller rather than read from the clock so that the
 * same result always produces the same document — which is what makes undo comparison and
 * testing meaningful.
 */
export function applyTranscription(
  doc: ProjectDocument,
  result: CanonicalTranscription,
  placement: TranscriptionPlacement,
  generatedAt: string,
): ProjectDocument {
  const segments = buildSegments(result);
  if (segments.length === 0) {
    throw new TranscriptionApplyError('The transcription produced no segments.', 0);
  }

  const transcription = {
    providerId: result.providerId,
    ...(result.diagnostics.model === undefined ? {} : { model: result.diagnostics.model }),
    ...(result.language === undefined ? {} : { language: result.language }),
    generatedAt,
  };

  if (placement.kind === 'new-track') {
    if (doc.tracks.length > 0) {
      throw new TranscriptionApplyError(
        'This project already has subtitle tracks. Choose an existing track to replace, or ' +
          'add a track first.',
        0,
      );
    }
    const track: SubtitleTrack = {
      id: newTrackId(),
      name: placement.name ?? 'Transcript',
      visible: true,
      locked: false,
      segments,
    };
    return { ...doc, tracks: [track], transcription };
  }

  const target = doc.tracks.find((track) => track.id === placement.trackId);
  if (target === undefined) {
    throw new TranscriptionApplyError(`No track ${placement.trackId} in this project.`, 0);
  }
  if (target.locked) {
    throw new TranscriptionApplyError(`Track "${target.name}" is locked.`, 0);
  }

  // The safety check that matters. `origin: 'manual'` is the durable record that a human
  // touched this segment, so it is the only evidence available about where their work is.
  const manual = target.segments.filter((segment) => segment.origin === 'manual');
  if (manual.length > 0) {
    throw new TranscriptionApplyError(
      `Track "${target.name}" contains ${manual.length} manually edited segment` +
        `${manual.length === 1 ? '' : 's'}. Re-transcribing would discard them.`,
      manual.length,
    );
  }

  return {
    ...doc,
    tracks: doc.tracks.map((track) =>
      track.id === placement.trackId ? { ...track, segments } : track,
    ),
    transcription,
  };
}

/**
 * The operation label, so undo history reads as an action rather than a mechanism.
 *
 * Includes the segment count because "Transcribe" alone tells a user nothing about whether the
 * thing they are undoing is the transcript they remember creating.
 */
export function transcriptionOperationLabel(result: CanonicalTranscription): string {
  const words = result.segments.reduce((total, segment) => total + segment.words.length, 0);
  const detail =
    result.wordTimingAvailable && words > 0
      ? `${result.segments.length} segments, ${words} words`
      : `${result.segments.length} segments`;
  return `Transcribe (${result.providerId}, ${detail})`;
}
