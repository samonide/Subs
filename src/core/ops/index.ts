/**
 * The operation model — the foundation for undo/redo.
 *
 * An operation is a **pure, labelled function** from a document to a new document. This
 * shape is what makes undo trivial (apply the inverse), makes every edit testable without
 * a DOM, and makes keyboard shortcuts map 1:1 onto operations.
 *
 * Why this lands in Phase 0 rather than with the timeline (ARCHITECTURE_REVIEW.md §9):
 * the cost of late adoption is not the diffing mechanism, it is that once UI exists,
 * feature authors start writing imperative side-effects, and retrofitting history means
 * auditing every mutation site. The cheap moment is now, while "all mutations are pure
 * ops" has zero counterexamples.
 *
 * ## Invariant I-20 — the rule this module exists to enforce
 *
 * A worker (transcription, rendering) must NEVER write or replace the client's canonical
 * document. A worker returns a *result*; the client applies it as a labelled operation.
 *
 * If it were the other way round — the client adopting a server-produced document — two
 * things break: the undo stack would hold snapshots of a document that no longer exists,
 * and "transcription produced 47 segments", the single largest change in the document,
 * would have no undo entry at all.
 */

import type { ProjectDocument, SubtitleSegment, SubtitleWord } from '../document/types.js';
import { newSegmentId, newTrackId, newWordId, type SegmentId } from '../document/ids.js';

/** A pure, deterministic document mutation. Never mutates its input. */
export type Operation = (doc: ProjectDocument) => ProjectDocument;

/** A named operation, so undo history can label its entries. */
export interface LabelledOperation {
  /** Human-readable label; this becomes the undo menu text. */
  label: string;
  apply: Operation;
}

function labelled(label: string, apply: Operation): LabelledOperation {
  return { label, apply };
}

/**
 * Apply an operation, returning a new document.
 *
 * The input is never mutated. This is the single entry point through which the document
 * changes, and the reason undo/redo can be a stack of snapshots.
 */
export function applyOperation(
  doc: ProjectDocument,
  operation: LabelledOperation,
): ProjectDocument {
  return operation.apply(doc);
}

/** Rebuild a segment's cached text from its words (invariant I-8). */
function withDerivedText(segment: SubtitleSegment): SubtitleSegment {
  return { ...segment, text: segment.words.map((word) => word.text).join('') };
}

// ─────────────────────────── Timeline operations ───────────────────────────
// Semantics per ARCHITECTURE_REVIEW.md §8.2. Phase 0 defines the ops and proves their
// semantics; the timeline UI that calls them is Phase 6.

/**
 * Move a segment in time, preserving its duration.
 *
 * Dragging a caption's body moves it. It must not silently retime it — that is
 * `retimeSegment`'s job, and conflating the two is a classic timeline bug.
 */
export function moveSegment(segmentId: SegmentId, deltaMs: number): LabelledOperation {
  return labelled(`Move segment ${deltaMs >= 0 ? '+' : ''}${deltaMs}ms`, (doc) => {
    if (deltaMs === 0 || findSegmentWithTrack(doc, segmentId) === null) {
      return doc;
    }
    return mapSegment(doc, segmentId, (segment) => ({
      ...segment,
      startMs: Math.max(0, segment.startMs + deltaMs),
      endMs: Math.max(0, segment.endMs + deltaMs),
      words: segment.words.map((word) => ({
        ...word,
        startMs: Math.max(0, word.startMs + deltaMs),
        endMs: Math.max(0, word.endMs + deltaMs),
      })),
    }));
  });
}

/**
 * Retime one edge of a segment. The other edge, and all other segments, are untouched.
 *
 * Words are clamped to the new bounds, so no word can end up outside its segment.
 */
export function retimeSegment(
  segmentId: SegmentId,
  edge: 'start' | 'end',
  newMs: number,
): LabelledOperation {
  return labelled(`Retime segment ${edge} to ${newMs}ms`, (doc) =>
    mapSegment(doc, segmentId, (segment) => {
      const startMs = edge === 'start' ? clamp(newMs, 0, segment.endMs - 1) : segment.startMs;
      const endMs = edge === 'end' ? Math.max(newMs, startMs + 1) : segment.endMs;
      return {
        ...segment,
        startMs,
        endMs,
        words: segment.words.map((word) => ({
          ...word,
          startMs: clamp(word.startMs, startMs, endMs),
          endMs: clamp(word.endMs, startMs, endMs),
        })),
      };
    }),
  );
}

/**
 * Split a segment at a time, snapping to the nearest word boundary.
 *
 * Splitting mid-word is always wrong, so the snap is not optional. Both halves get their
 * text re-derived from their words (I-8) rather than slicing a string.
 */
export function splitSegment(segmentId: SegmentId, atMs: number): LabelledOperation {
  return labelled(`Split segment at ${atMs}ms`, (doc) => {
    const found = findSegmentWithTrack(doc, segmentId);
    if (found === null) {
      return doc;
    }
    const { trackIndex, segmentIndex, segment } = found;
    const splitIndex = nearestWordBoundary(segment, atMs);
    // A boundary at 0 or at the end would produce an empty half; that is not a split.
    if (splitIndex <= 0 || splitIndex >= segment.words.length) {
      return doc;
    }

    const leftWords = segment.words.slice(0, splitIndex);
    const rightWords = segment.words.slice(splitIndex);
    const boundaryMs = rightWords[0]?.startMs ?? atMs;

    const left = withDerivedText({
      ...segment,
      id: newSegmentId(),
      startMs: segment.startMs,
      endMs: boundaryMs,
      words: leftWords,
      lineBreaks: undefined,
    });
    const right = withDerivedText({
      ...segment,
      id: newSegmentId(),
      startMs: boundaryMs,
      endMs: segment.endMs,
      words: rightWords,
      lineBreaks: undefined,
    });

    return replaceTrackSegments(doc, trackIndex, segmentIndex, [left, right]);
  });
}

/**
 * Merge two segments on the same track.
 *
 * Refuses across a track boundary, and refuses when either segment is missing. Merging
 * across a time gap would display the merged caption during that gap — a behaviour the
 * user did not ask for — so the caller must confirm before applying a gapped merge.
 */
export function mergeSegments(firstId: SegmentId, secondId: SegmentId): LabelledOperation {
  return labelled('Merge segments', (doc) => {
    const first = findSegmentWithTrack(doc, firstId);
    const second = findSegmentWithTrack(doc, secondId);
    if (first === null || second === null || first.trackIndex !== second.trackIndex) {
      return doc;
    }
    if (second.segmentIndex !== first.segmentIndex + 1) {
      // Only adjacent segments merge. Merging non-adjacent ones would delete subtitles.
      return doc;
    }

    const merged = withDerivedText({
      ...first.segment,
      startMs: Math.min(first.segment.startMs, second.segment.startMs),
      endMs: Math.max(first.segment.endMs, second.segment.endMs),
      words: [...first.segment.words, ...second.segment.words],
      lineBreaks: undefined,
    });

    const track = doc.tracks[first.trackIndex];
    if (track === undefined) {
      return doc;
    }
    const segments = [...track.segments];
    segments.splice(first.segmentIndex, 2, merged);

    return {
      ...doc,
      tracks: doc.tracks.map((entry, index) =>
        index === first.trackIndex ? { ...entry, segments } : entry,
      ),
    };
  });
}

// ──────────────────────────── Style operations ────────────────────────────

/** Set a sparse style override on a segment. */
export function setSegmentStyleOverride(
  segmentId: SegmentId,
  override: SubtitleSegment['styleOverride'],
): LabelledOperation {
  return labelled('Style segment', (doc) =>
    mapSegment(doc, segmentId, (segment) => ({ ...segment, styleOverride: override })),
  );
}

/**
 * Apply one segment's style to many.
 *
 * This is the "make these look like that one" gesture. It needs no new model structure —
 * it copies an existing override onto a selection — which is why the architecture did not
 * have to anticipate it.
 */
export function applyStyleToSelection(
  sourceSegmentId: SegmentId,
  targetSegmentIds: readonly SegmentId[],
): LabelledOperation {
  return labelled(`Style ${targetSegmentIds.length} segment(s)`, (doc) => {
    const source = findSegment(doc, sourceSegmentId);
    if (source === null) {
      return doc;
    }
    let next = doc;
    for (const targetId of targetSegmentIds) {
      next = mapSegment(next, targetId, (segment) => ({
        ...segment,
        // Copying the override, not the id: the targets keep their own inheritance chain.
        styleOverride: source.styleOverride === undefined ? undefined : { ...source.styleOverride },
      }));
    }
    return next;
  });
}

// ──────────────── Result application — invariant I-20 in code ────────────────

/** What a worker hands back. Deliberately NOT a `ProjectDocument`. */
export interface TranscriptionSegmentResult {
  startMs: number;
  endMs: number;
  words: ReadonlyArray<
    Pick<SubtitleWord, 'text' | 'startMs' | 'endMs' | 'confidence' | 'timingSource'>
  >;
}

/**
 * The response a worker sends back to the client.
 *
 * A worker never mutates or returns the document. It returns *this* — data plus
 * provenance — and the client turns it into an operation.
 */
export interface WorkerResult {
  /** Which operation should be applied, so the client can decide what to do with it. */
  kind: 'transcript';
  providerId: string;
  model?: string;
  language?: string;
  /**
   * ISO-8601 timestamp of the transcription, supplied by the caller.
   *
   * Injected rather than read from the clock: an operation must be pure and
   * deterministic, and a hidden `new Date()` would make the same transcript produce a
   * different document on every run — which would break undo comparisons and make
   * operations untestable.
   */
  generatedAt: string;
  segments: readonly TranscriptionSegmentResult[];
}

/**
 * Apply a worker's result to the document as a single, undoable operation.
 *
 * This is the client half of invariant I-20. The entire transcription — potentially
 * hundreds of segments, the largest change the document will ever undergo — enters the
 * document through one labelled op, so it is one entry in the undo history.
 */
export function applyWorkerResult(result: WorkerResult): LabelledOperation {
  return labelled(`Transcribe (${result.segments.length} segments)`, (doc) => {
    const trackId = doc.tracks[0]?.id ?? newTrackId();
    const segments: SubtitleSegment[] = result.segments.map((raw) => {
      const words: SubtitleWord[] = raw.words.map((word) => ({ ...word, id: newWordId() }));
      return withDerivedText({
        id: newSegmentId(),
        startMs: raw.startMs,
        endMs: raw.endMs,
        words,
        origin: 'asr',
        text: '',
      });
    });

    const track = doc.tracks.find((entry) => entry.id === trackId);
    const baseTrack = track ?? {
      id: trackId,
      name: 'Track 1',
      visible: true,
      locked: false,
      segments: [],
    };

    return {
      ...doc,
      tracks:
        track === undefined
          ? [...doc.tracks, { ...baseTrack, segments }]
          : doc.tracks.map((entry) =>
              entry.id === trackId
                ? { ...entry, segments: [...entry.segments, ...segments] }
                : entry,
            ),
      transcription: {
        providerId: result.providerId,
        ...(result.model === undefined ? {} : { model: result.model }),
        ...(result.language === undefined ? {} : { language: result.language }),
        generatedAt: result.generatedAt,
      },
    };
  });
}

// ─────────────────────────────── internals ─────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

interface SegmentLocation {
  trackIndex: number;
  segmentIndex: number;
  segment: SubtitleSegment;
}

function findSegmentWithTrack(doc: ProjectDocument, segmentId: SegmentId): SegmentLocation | null {
  for (const [trackIndex, track] of doc.tracks.entries()) {
    const segmentIndex = track.segments.findIndex((segment) => segment.id === segmentId);
    const segment = track.segments[segmentIndex];
    if (segment !== undefined) {
      return { trackIndex, segmentIndex, segment };
    }
  }
  return null;
}

function findSegment(doc: ProjectDocument, segmentId: SegmentId): SubtitleSegment | null {
  return findSegmentWithTrack(doc, segmentId)?.segment ?? null;
}

function mapSegment(
  doc: ProjectDocument,
  segmentId: SegmentId,
  update: (segment: SubtitleSegment) => SubtitleSegment,
): ProjectDocument {
  return {
    ...doc,
    tracks: doc.tracks.map((track) => ({
      ...track,
      segments: track.segments.map((segment) =>
        segment.id === segmentId ? update(segment) : segment,
      ),
    })),
  };
}

function replaceTrackSegments(
  doc: ProjectDocument,
  trackIndex: number,
  segmentIndex: number,
  replacement: SubtitleSegment[],
): ProjectDocument {
  return {
    ...doc,
    tracks: doc.tracks.map((track, index) => {
      if (index !== trackIndex) {
        return track;
      }
      const segments = [...track.segments];
      segments.splice(segmentIndex, 1, ...replacement);
      return { ...track, segments };
    }),
  };
}

/** Index of the word boundary nearest `atMs`, for word-exact splitting. */
function nearestWordBoundary(segment: SubtitleSegment, atMs: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= segment.words.length; i += 1) {
    const candidateMs = segment.words[i]?.startMs ?? segment.endMs;
    const distance = Math.abs(candidateMs - atMs);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}
