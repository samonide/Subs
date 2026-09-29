/**
 * The style resolution cascade.
 *
 * This is the WYSIWYG contract. One pure function, run identically by the browser
 * preview and the Node export worker, is the mechanism that makes "what you see is what
 * you export" structural rather than a matter of discipline (ARCHITECTURE_REVIEW.md §8).
 *
 * Cascade: project default → track → segment → word.
 *
 * Two properties are non-negotiable:
 *   - **Purity (I-15):** no I/O, no globals, no mutation of inputs, no `Date.now()`.
 *     A single hidden dependency silently breaks one of the three runtimes.
 *   - **Totality (I-17):** `ResolvedStyle` has no optional properties. A renderer must
 *     never branch on "is this inherited?" — that decision is paid once, here.
 */

import type { SegmentId } from '../document/ids.js';
import type {
  AnimationDef,
  ProjectDocument,
  Style,
  StyleOverride,
  SubtitleSegment,
  SubtitleTrack,
  SubtitleWord,
  TransformSpec,
} from '../document/types.js';

/** Every property populated. The renderer consumes this and nothing else. */
export interface ResolvedStyle {
  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  fill: string;
  strokeColor: string | undefined;
  strokeWidthPx: number | undefined;
  shadowColor: string | undefined;
  shadowOpacity: number | undefined;
  shadowBlurPx: number | undefined;
  shadowOffsetXPx: number | undefined;
  shadowOffsetYPx: number | undefined;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  letterSpacingPx: number | undefined;
  position: Style['position'];
  transforms: readonly TransformSpec[];
}

export class StyleResolutionError extends Error {
  override readonly name = 'StyleResolutionError';
}

/** The document default style. Every property concrete, so resolution is always total. */
export const DEFAULT_STYLE: Readonly<Style> = Object.freeze({
  id: 'default',
  name: 'Default',
  fontFamily: 'Inter',
  fontSizePx: 48,
  fontWeight: 700,
  fontStyle: 'normal',
  fill: '#FFFFFF',
  align: 'center',
  lineHeight: 1.2,
});

/** Keys a `StyleOverride` may carry. `id` and `name` are never overridable. */
function applyOverride(base: ResolvedStyle, override: StyleOverride | undefined): ResolvedStyle {
  if (override === undefined) {
    return base;
  }
  return {
    // Spread first, then re-assert totality for keys an override may omit. Every optional
    // key is explicitly listed so the result is total (I-17) and never inherits
    // `undefined` from the base — a renderer must not branch on inheritance.
    ...base,
    ...override,
    ...(override.fontFamily !== undefined && { fontFamily: override.fontFamily }),
    ...(override.fontSizePx !== undefined && { fontSizePx: override.fontSizePx }),
    ...(override.fontWeight !== undefined && { fontWeight: override.fontWeight }),
    ...(override.fontStyle !== undefined && { fontStyle: override.fontStyle }),
    ...(override.fill !== undefined && { fill: override.fill }),
    ...(override.strokeColor !== undefined && { strokeColor: override.strokeColor }),
    ...(override.strokeWidthPx !== undefined && { strokeWidthPx: override.strokeWidthPx }),
    ...(override.shadowColor !== undefined && { shadowColor: override.shadowColor }),
    ...(override.shadowOpacity !== undefined && { shadowOpacity: override.shadowOpacity }),
    ...(override.shadowBlurPx !== undefined && { shadowBlurPx: override.shadowBlurPx }),
    ...(override.shadowOffsetXPx !== undefined && { shadowOffsetXPx: override.shadowOffsetXPx }),
    ...(override.shadowOffsetYPx !== undefined && { shadowOffsetYPx: override.shadowOffsetYPx }),
    ...(override.align !== undefined && { align: override.align }),
    ...(override.lineHeight !== undefined && { lineHeight: override.lineHeight }),
    ...(override.letterSpacingPx !== undefined && { letterSpacingPx: override.letterSpacingPx }),
    ...(override.position !== undefined && { position: override.position }),
    // I-6: transforms REPLACES. A partial ordered list has no defined composition.
    ...(override.transforms !== undefined && { transforms: override.transforms }),
  };
}

/** Materialise a named style from the registry into a total `ResolvedStyle`. */
function toResolved(style: Style): ResolvedStyle {
  return {
    fontFamily: style.fontFamily,
    fontSizePx: style.fontSizePx,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    fill: style.fill,
    strokeColor: style.strokeColor,
    strokeWidthPx: style.strokeWidthPx,
    shadowColor: style.shadowColor,
    shadowOpacity: style.shadowOpacity,
    shadowBlurPx: style.shadowBlurPx,
    shadowOffsetXPx: style.shadowOffsetXPx,
    shadowOffsetYPx: style.shadowOffsetYPx,
    align: style.align,
    lineHeight: style.lineHeight,
    letterSpacingPx: style.letterSpacingPx,
    position: style.position,
    transforms: style.transforms ?? [],
  };
}

/** Look up a named style, failing loudly on a dangling reference (invariant I-4). */
export function resolveNamedStyle(doc: ProjectDocument, styleId: string): ResolvedStyle {
  const style = doc.styles[styleId];
  if (style === undefined) {
    throw new StyleResolutionError(`Dangling style reference: ${styleId}`);
  }
  return toResolved(style);
}

/**
 * Resolve the effective style for a word.
 *
 * The four-level cascade, in order. Pure and deterministic (I-15, I-16): the same
 * document always yields byte-identical output, which is what makes the preview/export
 * parity fixtures meaningful.
 */
export function resolveWordStyle(
  doc: ProjectDocument,
  track: SubtitleTrack,
  segment: SubtitleSegment,
  word: SubtitleWord,
): ResolvedStyle {
  let resolved = resolveNamedStyle(doc, track.styleId ?? 'default');

  // A segment's `styleId` REPLACES the inherited style; its `styleOverride` MERGES onto
  // whatever the chain resolved to. The two are mutually exclusive (invariant I-14), which
  // the validator enforces, so this ordering never has to arbitrate.
  if (segment.styleId !== undefined) {
    resolved = resolveNamedStyle(doc, segment.styleId);
  }
  resolved = applyOverride(resolved, segment.styleOverride);
  resolved = applyOverride(resolved, word.styleOverride);

  return resolved;
}

// ────────────────────────────── Animation ──────────────────────────────────

/** The transform value in effect at a moment in time, after animation precedence. */
export interface ResolvedTransform extends Readonly<Record<TransformSpec['property'], number>> {
  readonly opacity: number;
  readonly scale: number;
  readonly rotationDeg: number;
  readonly translateX: number;
  readonly translateY: number;
}

const NEUTRAL_TRANSFORM: ResolvedTransform = Object.freeze({
  opacity: 1,
  scale: 1,
  rotationDeg: 0,
  translateX: 0,
  translateY: 0,
});

/** Easing curves. `spring` is a deterministic approximation, not a physics simulation. */
function applyCurve(curve: AnimationDef['curve'], t: number): number {
  switch (curve) {
    case 'linear':
      return t;
    case 'easeIn':
      return t * t;
    case 'easeOut':
      return t * (2 - t);
    case 'easeInOut':
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    case 'spring': {
      // Deterministic overshoot. Documented approximation — see the parity matrix:
      // libass has no spring, so this curve is preview-only and must be reported.
      const damped = 1 - Math.cos(t * Math.PI * 2) * Math.exp(-6 * t);
      return Math.min(1, Math.max(0, damped));
    }
  }
}

/** The animation's active window for a given segment, in milliseconds. */
function animationWindow(
  animation: AnimationDef,
  segmentDurationMs: number,
): { startMs: number; endMs: number } {
  const duration =
    animation.durationMs ?? Math.round((animation.durationFraction ?? 0.2) * segmentDurationMs);
  return animation.phase === 'out'
    ? { startMs: segmentDurationMs - duration, endMs: segmentDurationMs }
    : { startMs: 0, endMs: duration };
}

/**
 * Resolve the animated value of one property at `offsetMs` into the segment.
 *
 * Returns `undefined` when the animation does not apply — either it targets a different
 * property, or `offsetMs` falls outside its window. "Outside the window" is what makes
 * invariant **I-19** work: the caller falls back to the static value, so static
 * transforms resume after the animation ends.
 */
export function resolveAnimatedValue(
  animation: AnimationDef | undefined,
  segmentDurationMs: number,
  offsetMs: number,
): number | undefined {
  if (animation === undefined) {
    return undefined;
  }
  const { startMs, endMs } = animationWindow(animation, segmentDurationMs);
  if (offsetMs < startMs || offsetMs >= endMs || endMs <= startMs) {
    return undefined;
  }
  const progress = (offsetMs - startMs) / (endMs - startMs);
  const eased = applyCurve(animation.curve, progress);
  return animation.from + (animation.to - animation.from) * eased;
}

/**
 * Apply animation over a resolved style's static transforms.
 *
 * **Invariant I-19:** animation wins for its property, for its active window; the static
 * value resumes after. Without this rule, a caption with both a static `scale: 0.9` and a
 * pop-in animation on `scale` has no defined winner — a bug that presents as
 * nondeterminism ("why is this 0.9 sometimes?").
 *
 * This is data resolution only. Phase 0 defines no playback, no timeline, and no
 * renderer; Phase 10 consumes this.
 */
export function applyAnimation(
  style: ResolvedStyle,
  animation: AnimationDef | undefined,
  segmentDurationMs: number,
  offsetMs: number,
): ResolvedStyle {
  if (animation === undefined) {
    return style;
  }
  const animated = resolveAnimatedValue(animation, segmentDurationMs, offsetMs);
  if (animated === undefined) {
    return style;
  }

  // I-19: the animated value replaces the static entry for that property, if any.
  const remaining = style.transforms.filter((spec) => spec.property !== animation.property);
  return {
    ...style,
    transforms: [...remaining, { property: animation.property, value: animated }],
  };
}

/** The transform value in effect for a caption at a moment in time, animation included. */
export function resolveTransform(style: ResolvedStyle): ResolvedTransform {
  const result: Record<TransformSpec['property'], number> = { ...NEUTRAL_TRANSFORM };
  for (const spec of style.transforms) {
    result[spec.property] = spec.value;
  }
  return result;
}

// ────────────────────────── Segment-at-time lookup ─────────────────────────

/**
 * Find the segment visible at `tMs` on a track.
 *
 * Binary search over the `startMs`-sorted array (invariant I-3) rather than a linear
 * scan: this runs on every animation frame, and a linear scan is O(n) per frame. An
 * empty track returns null, which is a normal state, not an error.
 */
export function findSegmentAt(track: SubtitleTrack, tMs: number): SubtitleSegment | null {
  let low = 0;
  let high = track.segments.length - 1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const segment = track.segments[mid];
    if (segment === undefined) {
      return null;
    }
    if (tMs < segment.startMs) {
      high = mid - 1;
    } else if (tMs >= segment.endMs) {
      low = mid + 1;
    } else {
      return segment;
    }
  }
  return null;
}

/** All segments visible at `tMs` across every visible track, in track order. */
export function findVisibleSegmentsAt(doc: ProjectDocument, tMs: number): SubtitleSegment[] {
  return doc.tracks
    .filter((track) => track.visible)
    .map((track) => findSegmentAt(track, tMs))
    .filter((segment): segment is SubtitleSegment => segment !== null);
}

export function findSegment(doc: ProjectDocument, segmentId: SegmentId): SubtitleSegment | null {
  for (const track of doc.tracks) {
    const found = track.segments.find((segment) => segment.id === segmentId);
    if (found !== undefined) {
      return found;
    }
  }
  return null;
}
