/**
 * The canonical project document model.
 *
 * Plain, serializable data: no classes, no functions, no cycles. It must round-trip
 * through `JSON.stringify` → disk → `JSON.parse` unchanged (invariant I-9), because
 * autosave, undo, server round-trips, and versioned migration all depend on that.
 *
 * The five concerns the model keeps separate — and must keep separate — are:
 *   1. source media   → `assets[]`
 *   2. content        → `segment.words[]` (the source of truth for text)
 *   3. timing         → integer `startMs` / `endMs` on segments and words
 *   4. visual styling → `styles` registry + sparse overrides
 *   5. animation      → `animations` registry + references
 *
 * Full rationale and all invariants: ARCHITECTURE_REVIEW.md §5.
 */

import type {
  AnimationId,
  AssetId,
  ProjectId,
  SegmentId,
  StyleId,
  TrackId,
  WordId,
} from './ids.js';

// Re-exported so downstream modules can import the whole model surface from this one
// file, without reaching back into `ids.ts` for a type that the model itself uses.
export type {
  AnimationId,
  AssetId,
  ProjectId,
  SegmentId,
  StyleId,
  TrackId,
  WordId,
} from './ids.js';

/** Current document schema version. Bump when the model changes, and add a migration. */
export const SCHEMA_VERSION = 1;

// ────────────────────────────── Media assets ──────────────────────────────

/**
 * Why an asset exists. Segments reference assets by *role*, never by path or ID
 * (invariant I-13), so swapping the source video or changing a font file updates
 * everything automatically and no segment can point at a deleted file.
 */
export type AssetRole = 'sourceVideo' | 'proxyVideo' | 'audio' | 'font' | 'thumbnail';

export interface MediaMeta {
  /** Integer milliseconds. Never a float. */
  durationMs: number;
  width?: number;
  height?: number;
  /** Dimensions after rotation metadata is applied. */
  displayWidth?: number;
  displayHeight?: number;
  rotation?: 0 | 90 | 180 | 270;
  /**
   * Exact rational frame rate. Stored as a pair so that treating 29.97 as 30 becomes
   * unrepresentable — assuming 30fps on a 29.97 source drifts ~3.6 seconds per hour.
   */
  frameRateNum?: number;
  frameRateDen?: number;
  codec?: string;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
}

export interface AssetRecord {
  id: AssetId;
  role: AssetRole;
  /** Original filename. DISPLAY METADATA ONLY — never joined into a filesystem path. */
  filename: string;
  mimeType: string;
  byteSize: number;
  checksum?: string;
  meta?: MediaMeta;
  /** Provenance: which asset this was derived from. */
  derivedFrom?: AssetId;
  /** The exact ffmpeg arguments used, for reproducibility. */
  transform?: string;
}

// ─────────────────────────────── Styling ──────────────────────────────────

export interface NormalizedPosition {
  /** 0..1 of the canvas width. */
  x: number;
  /** 0..1 of the canvas height. */
  y: number;
  anchorX: number;
  anchorY: number;
}

/** A single animatable/transformable property. Ordered, because order is composable. */
export interface TransformSpec {
  property: 'opacity' | 'scale' | 'rotationDeg' | 'translateX' | 'translateY';
  value: number;
}

export interface Style {
  id: StyleId;
  name: string;
  fontFamily: string;
  /** Pixels, at the project's reference canvas resolution. */
  fontSizePx: number;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  /** Canonical form: '#RRGGBB' or '#RRGGBBAA'. */
  fill: string;
  strokeColor?: string;
  strokeWidthPx?: number;
  shadowColor?: string;
  shadowOpacity?: number;
  shadowBlurPx?: number;
  shadowOffsetXPx?: number;
  shadowOffsetYPx?: number;
  align: 'left' | 'center' | 'right';
  /** Multiplier. */
  lineHeight: number;
  letterSpacingPx?: number;
  position?: NormalizedPosition;
  /**
   * Ordered transform list. Order matters (rotate-then-translate differs from
   * translate-then-rotate) and a list maps directly onto a CSS transform string.
   */
  transforms?: TransformSpec[];
}

/**
 * A sparse deviation from an inherited style.
 *
 * Absent key means "inherit" (invariant I-7). There are no sentinel values — an empty
 * string or -1 meaning "inherit" is exactly the kind of ambiguity that makes style bugs
 * unfixable.
 *
 * `transforms` REPLACES rather than merges (invariant I-6): merging two ordered lists is
 * ambiguous, and a partial transform list has no well-defined composition.
 */
export type StyleOverride = Partial<Omit<Style, 'id' | 'name'>>;

// ────────────────────────────── Animation ────────────────────────────────

/**
 * A parametrised animation descriptor, not a keyframe list (decision D-6).
 *
 * Covers the MVP animation set — fade, pop, slide, punch, per-word stagger — which is
 * what subtitle animation actually is in practice. Keyframes, if ever needed, arrive as a
 * union member that resolves to the same `ResolvedTransform`; the resolver and both
 * renderers are unaffected.
 */
export interface AnimationDef {
  id: AnimationId;
  name: string;
  phase: 'in' | 'out' | 'inout';
  property: TransformSpec['property'];
  from: number;
  to: number;
  curve: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'spring';
  /** Absolute duration. Takes precedence over `durationFraction` when both are present. */
  durationMs?: number;
  /** Fraction of the segment's duration. */
  durationFraction?: number;
  /** Per-word offset, for staggered animation. */
  staggerMs?: number;
}

// ─────────────────────── Tracks, segments, words ──────────────────────────

export interface SubtitleWord {
  id: WordId;
  /** May carry leading and trailing spaces — words are joined verbatim to rebuild text. */
  text: string;
  startMs: number;
  endMs: number;
  /**
   * 0..1. Absent means the provider supplied no confidence — which is NOT the same as
   * 0, and NOT the same as certainty (invariant I-10).
   */
  confidence?: number;
  /**
   * Whether these timings were measured by the provider or distributed by our own
   * heuristic. Synthesized timings are never presented as measured (invariant I-11).
   */
  timingSource: 'measured' | 'synthesized';
  styleOverride?: StyleOverride;
  animationId?: AnimationId;
}

export interface SubtitleSegment {
  id: SegmentId;
  /**
   * A CACHE of `words.map(w => w.text).join('')`, not the source of truth. Drift between
   * the two is detectable by the validator rather than silently corrected (invariant I-8).
   */
  text: string;
  /** Authoritative timing. Integer milliseconds. */
  startMs: number;
  endMs: number;
  /** Word indices at which a line break is forced. Undefined = automatic wrapping. */
  lineBreaks?: number[];
  /** Full style replacement. Mutually exclusive with `styleOverride` (invariant I-14). */
  styleId?: StyleId;
  styleOverride?: StyleOverride;
  animationId?: AnimationId;
  /** The content source of truth. */
  words: SubtitleWord[];
  /** Drives re-transcription safety: hand-edited content must not be silently replaced. */
  origin: 'asr' | 'manual';
  /** Protected from re-transcription. */
  locked?: boolean;
}

export interface SubtitleTrack {
  id: TrackId;
  name: string;
  /** Undefined = inherit the project default. */
  styleId?: StyleId;
  animationId?: AnimationId;
  visible: boolean;
  locked: boolean;
  /** Sorted by `startMs` and non-overlapping (invariant I-3). Array order IS the order. */
  segments: SubtitleSegment[];
}

// ──────────────────────────── The document ────────────────────────────────

/**
 * Provenance for the transcript. A POINTER, not a copy — the words already live in
 * `segments[].words`, and a second copy would invite divergence and double the file size.
 */
export interface TranscriptionMeta {
  providerId: string;
  model?: string;
  language?: string;
  generatedAt: string;
}

export interface ProjectDocument {
  schemaVersion: number;
  id: ProjectId;
  name: string;
  /** ISO-8601. */
  createdAt: string;
  updatedAt: string;
  /** Reference design resolution that all pixel-valued style properties are authored against. */
  canvas: { width: number; height: number };
  assets: AssetRecord[];
  tracks: SubtitleTrack[];
  /** Named style registry. Segments reference by ID, so one edit updates many segments. */
  styles: Record<StyleId, Style>;
  animations: Record<AnimationId, AnimationDef>;
  transcription?: TranscriptionMeta;
}
