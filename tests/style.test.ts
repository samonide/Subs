import { describe, expect, it } from 'vitest';

import {
  StyleResolutionError,
  applyAnimation,
  findSegmentAt,
  findVisibleSegmentsAt,
  resolveAnimatedValue,
  resolveNamedStyle,
  resolveTransform,
  resolveWordStyle,
} from '../src/core/style/resolve.js';
import { newAnimationId, newStyleId, newTrackId } from '../src/core/document/ids.js';
import type { AnimationDef, ProjectDocument, SubtitleTrack } from '../src/core/document/types.js';
import { makeDocument, makeSegment, makeStyle, makeWord } from '../src/core/testing/factories.js';

function trackWith(doc: ProjectDocument, track: SubtitleTrack): [ProjectDocument, SubtitleTrack] {
  return [{ ...doc, tracks: [track] }, track];
}

describe('style cascade', () => {
  it('resolves the track style when nothing overrides it', () => {
    const styleId = newStyleId();
    const doc = makeDocument({
      styles: { [styleId]: makeStyle({ id: styleId, fontSizePx: 40, fill: '#FF0000' }) },
    });
    const track: SubtitleTrack = {
      id: newTrackId(),
      name: 'T',
      styleId,
      visible: true,
      locked: false,
      segments: [],
    };
    const [withTrack, trackRef] = trackWith(doc, track);

    const resolved = resolveNamedStyle(withTrack, styleId);
    expect(resolved.fontSizePx).toBe(40);
    expect(resolved.fill).toBe('#FF0000');
    expect(trackRef.styleId).toBe(styleId);
  });

  it('applies segment overrides on top of the track style', () => {
    const styleId = newStyleId();
    const doc = makeDocument({
      styles: { [styleId]: makeStyle({ id: styleId, fontSizePx: 40, fill: '#FF0000' }) },
    });
    const segment = makeSegment([makeWord('hi ', 0, 100)], {
      styleOverride: { fontSizePx: 72 },
    });
    const track: SubtitleTrack = {
      id: newTrackId(),
      name: 'T',
      styleId,
      visible: true,
      locked: false,
      segments: [segment],
    };

    const resolved = resolveWordStyle(doc, track, segment, segment.words[0]!);
    // The override wins...
    expect(resolved.fontSizePx).toBe(72);
    // ...and unspecified properties are inherited, not reset.
    expect(resolved.fill).toBe('#FF0000');
  });

  it('applies word overrides on top of the segment override', () => {
    const styleId = newStyleId();
    const doc = makeDocument({
      styles: { [styleId]: makeStyle({ id: styleId, fontSizePx: 40, fill: '#FF0000' }) },
    });
    const word = makeWord('word', 0, 100);
    const segment = makeSegment([word], { styleOverride: { fontSizePx: 72 } });
    const track: SubtitleTrack = {
      id: newTrackId(),
      name: 'T',
      styleId,
      visible: true,
      locked: false,
      segments: [segment],
    };

    const inherited = resolveWordStyle(doc, track, segment, word);
    expect(inherited.fontSizePx).toBe(72); // from the segment
    expect(inherited.fill).toBe('#FF0000'); // from the track

    // Now the word overrides one more level. fill was never overridden at a higher level,
    // so it still inherits through the whole chain.
    const overridden = { ...word, styleOverride: { fill: '#0000FF' } };
    const resolved = resolveWordStyle(doc, track, segment, overridden);
    expect(resolved.fill).toBe('#0000FF'); // from the word
    expect(resolved.fontSizePx).toBe(72); // still from the segment
  });

  it('lets a segment styleId REPLACE the track style wholesale', () => {
    const trackStyleId = newStyleId();
    const segmentStyleId = newStyleId();
    const doc = makeDocument({
      styles: {
        [trackStyleId]: makeStyle({ id: trackStyleId, fontSizePx: 40, fill: '#FF0000' }),
        [segmentStyleId]: makeStyle({ id: segmentStyleId, fontSizePx: 96, fill: '#00FF00' }),
      },
    });
    const segment = makeSegment([makeWord('x', 0, 100)], { styleId: segmentStyleId });
    const track: SubtitleTrack = {
      id: newTrackId(),
      name: 'T',
      styleId: trackStyleId,
      visible: true,
      locked: false,
      segments: [segment],
    };

    const resolved = resolveWordStyle(doc, track, segment, segment.words[0]!);
    expect(resolved.fontSizePx).toBe(96);
    expect(resolved.fill).toBe('#00FF00');
  });

  it('is total — every property is present, never undefined-inherited', () => {
    const styleId = newStyleId();
    const doc = makeDocument({ styles: { [styleId]: makeStyle({ id: styleId }) } });
    const resolved = resolveNamedStyle(doc, styleId);
    // Totality (I-17) is what lets a renderer never branch on inheritance.
    for (const value of Object.values(resolved)) {
      expect(value).not.toBeNull();
    }
    expect(resolved.transforms).toEqual([]);
  });

  it('is deterministic — the same document always resolves identically', () => {
    const styleId = newStyleId();
    const doc = makeDocument({
      styles: {
        [styleId]: makeStyle({ id: styleId, transforms: [{ property: 'scale', value: 0.9 }] }),
      },
    });
    const first = resolveNamedStyle(doc, styleId);
    const second = resolveNamedStyle(doc, styleId);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('does not mutate its inputs', () => {
    const styleId = newStyleId();
    const style = makeStyle({ id: styleId });
    const doc = makeDocument({ styles: { [styleId]: style } });
    const before = JSON.stringify(doc);
    resolveNamedStyle(doc, styleId);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('throws on a dangling style reference rather than silently falling back', () => {
    const doc = makeDocument();
    expect(() => resolveNamedStyle(doc, 'does-not-exist')).toThrow(StyleResolutionError);
  });
});

describe('transforms override (I-6)', () => {
  it('replaces rather than merges', () => {
    const styleId = newStyleId();
    const doc = makeDocument({
      styles: {
        [styleId]: makeStyle({
          id: styleId,
          transforms: [
            { property: 'scale', value: 0.8 },
            { property: 'rotationDeg', value: 45 },
          ],
        }),
      },
    });
    const word = makeWord('w', 0, 100);
    const segment = makeSegment([word], {
      styleOverride: { transforms: [{ property: 'opacity', value: 0.5 }] },
    });
    const track: SubtitleTrack = {
      id: newTrackId(),
      name: 'T',
      styleId,
      visible: true,
      locked: false,
      segments: [segment],
    };

    const resolved = resolveWordStyle(doc, track, segment, word);
    // The override replaced the list entirely; scale is no longer present.
    expect(resolved.transforms).toEqual([{ property: 'opacity', value: 0.5 }]);
  });
});

describe('animation resolution', () => {
  const animation: AnimationDef = {
    id: newAnimationId(),
    name: 'fade in',
    phase: 'in',
    property: 'opacity',
    from: 0,
    to: 1,
    curve: 'linear',
    durationMs: 200,
  };

  it('interpolates linearly within the window', () => {
    expect(resolveAnimatedValue(animation, 1000, 0)).toBe(0);
    expect(resolveAnimatedValue(animation, 1000, 100)).toBeCloseTo(0.5, 6);
    expect(resolveAnimatedValue(animation, 1000, 199)).toBeCloseTo(0.995, 6);
  });

  it('returns undefined outside the window so static values resume (I-19)', () => {
    // This is the mechanism behind I-19: "not animating" is expressed as undefined, and
    // the caller falls back to the static value.
    expect(resolveAnimatedValue(animation, 1000, 200)).toBeUndefined();
    expect(resolveAnimatedValue(animation, 1000, 900)).toBeUndefined();
    expect(resolveAnimatedValue(undefined, 1000, 50)).toBeUndefined();
  });

  it('applies a phase=out animation at the end of the segment', () => {
    const out: AnimationDef = { ...animation, phase: 'out', from: 1, to: 0 };
    // The window is the last 200ms of a 1000ms segment: [800, 1000).
    expect(resolveAnimatedValue(out, 1000, 799)).toBeUndefined();
    expect(resolveAnimatedValue(out, 1000, 800)).toBe(1);
    expect(resolveAnimatedValue(out, 1000, 900)).toBeCloseTo(0.5, 6);
    // At 999ms the fade is 99.5% complete, so opacity is 0.005 — not yet zero. The
    // window is half-open, so it never actually reaches 0 inside the segment.
    expect(resolveAnimatedValue(out, 1000, 999)).toBeCloseTo(0.005, 6);
  });

  it('derives its window from a duration fraction when no absolute duration is given', () => {
    const fractional: AnimationDef = { ...animation, durationMs: undefined, durationFraction: 0.5 };
    // 50% of a 1000ms segment is a [0, 500) window.
    expect(resolveAnimatedValue(fractional, 1000, 0)).toBe(0);
    expect(resolveAnimatedValue(fractional, 1000, 250)).toBeCloseTo(0.5, 6);
    expect(resolveAnimatedValue(fractional, 1000, 499)).toBeCloseTo(0.998, 6);
    expect(resolveAnimatedValue(fractional, 1000, 500)).toBeUndefined();
  });

  // ── Invariant I-19 ──
  it('animation wins over a static transform for the same property, and static resumes after (I-19)', () => {
    const styleId = newStyleId();
    const doc = makeDocument({
      styles: {
        [styleId]: makeStyle({ id: styleId, transforms: [{ property: 'opacity', value: 0.3 }] }),
      },
    });
    const base = resolveNamedStyle(doc, styleId);
    expect(base.transforms).toEqual([{ property: 'opacity', value: 0.3 }]);

    // During the animation, the animated value replaces the static one.
    const during = applyAnimation(base, animation, 1000, 100);
    expect(during.transforms).toEqual([{ property: 'opacity', value: 0.5 }]);

    // After the window, the static value is restored — deterministic, never "sometimes".
    const after = applyAnimation(base, animation, 1000, 500);
    expect(after.transforms).toEqual([{ property: 'opacity', value: 0.3 }]);
  });

  it('leaves other properties untouched when animating one', () => {
    const styleId = newStyleId();
    const doc = makeDocument({
      styles: {
        [styleId]: makeStyle({
          id: styleId,
          transforms: [
            { property: 'scale', value: 0.8 },
            { property: 'opacity', value: 0.3 },
          ],
        }),
      },
    });
    const base = resolveNamedStyle(doc, styleId);
    const during = applyAnimation(base, animation, 1000, 100);
    expect(during.transforms).toContainEqual({ property: 'scale', value: 0.8 });
    expect(during.transforms).toContainEqual({ property: 'opacity', value: 0.5 });
  });
});

describe('resolveTransform', () => {
  it('starts from a neutral transform', () => {
    const styleId = newStyleId();
    const doc = makeDocument({ styles: { [styleId]: makeStyle({ id: styleId }) } });
    expect(resolveTransform(resolveNamedStyle(doc, styleId))).toEqual({
      opacity: 1,
      scale: 1,
      rotationDeg: 0,
      translateX: 0,
      translateY: 0,
    });
  });
});

describe('segment-at-time lookup', () => {
  const segments = [
    makeSegment([makeWord('a', 0, 500)], { startMs: 0, endMs: 500 }),
    makeSegment([makeWord('b', 500, 1000)], { startMs: 500, endMs: 1000 }),
    makeSegment([makeWord('c', 2000, 2500)], { startMs: 2000, endMs: 2500 }),
  ];
  const track: SubtitleTrack = {
    id: newTrackId(),
    name: 'T',
    visible: true,
    locked: false,
    segments,
  };

  it('finds the segment containing a timestamp', () => {
    expect(findSegmentAt(track, 0)?.text).toBe('a');
    expect(findSegmentAt(track, 499)?.text).toBe('a');
    expect(findSegmentAt(track, 500)?.text).toBe('b');
    expect(findSegmentAt(track, 2499)?.text).toBe('c');
  });

  it('returns null in a gap, not the nearest segment', () => {
    expect(findSegmentAt(track, 1500)).toBeNull();
    expect(findSegmentAt(track, 9999)).toBeNull();
  });

  it('returns null for an empty track', () => {
    const empty: SubtitleTrack = {
      id: newTrackId(),
      name: 'T',
      visible: true,
      locked: false,
      segments: [],
    };
    expect(findSegmentAt(empty, 0)).toBeNull();
  });

  it('agrees with a linear scan across a dense timeline (binary search correctness)', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      makeSegment([makeWord(`w${i}`, i * 100, i * 100 + 100)], {
        startMs: i * 100,
        endMs: i * 100 + 100,
      }),
    );
    const dense: SubtitleTrack = {
      id: newTrackId(),
      name: 'T',
      visible: true,
      locked: false,
      segments: many,
    };
    for (let t = 0; t < 50_000; t += 37) {
      const found = findSegmentAt(dense, t);
      const expected = many.find((s) => t >= s.startMs && t < s.endMs) ?? null;
      expect(found?.id).toBe(expected?.id ?? null);
    }
  });

  it('finds visible segments across tracks', () => {
    const styleId = newStyleId();
    const doc = makeDocument({ styles: { [styleId]: makeStyle({ id: styleId }) } });
    const visible: SubtitleTrack = {
      id: newTrackId(),
      name: 'V',
      styleId,
      visible: true,
      locked: false,
      segments,
    };
    const hidden: SubtitleTrack = {
      id: newTrackId(),
      name: 'H',
      styleId,
      visible: false,
      locked: false,
      segments,
    };
    const withBoth = { ...doc, tracks: [visible, hidden] };
    const found = findVisibleSegmentsAt(withBoth, 100);
    expect(found).toHaveLength(1);
  });
});
