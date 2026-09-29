import { describe, expect, it } from 'vitest';

import {
  checkDocument,
  parseDocument,
  DocumentValidationError,
  validateInvariants,
} from '../src/core/validation/index.js';
import { newStyleId } from '../src/core/document/ids.js';
import {
  makeDocument,
  makeDocumentWithTrack,
  makeSegment,
  makeStyle,
  makeWord,
} from '../src/core/testing/factories.js';

/**
 * Round-trip through JSON the way a real load from disk would, returning `unknown`.
 *
 * A document on disk is untrusted input: the whole point of validation is that the
 * in-memory type is not assumed to hold. Returning `unknown` keeps that honest and stops
 * the test from accidentally passing a typed object straight through the validator.
 */
function asUntrustedJson(value: object): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe('structural validation', () => {
  it('accepts a well-formed document', () => {
    const doc = makeDocumentWithTrack([makeSegment([makeWord('hello', 0, 500)])]);
    const result = checkDocument(asUntrustedJson(doc));
    expect(result.ok).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(checkDocument(null).ok).toBe(false);
    expect(checkDocument('nope').ok).toBe(false);
    expect(checkDocument([]).ok).toBe(false);
  });

  it('rejects a missing required field', () => {
    const doc: Record<string, unknown> = { ...makeDocument() };
    delete doc['canvas'];
    expect(checkDocument(doc).ok).toBe(false);
  });

  it('rejects fractional milliseconds (I-1)', () => {
    // A float in a time field is a modelling error, not a rounding issue.
    const doc = makeDocumentWithTrack([
      makeSegment([makeWord('a', 0, 500)], { startMs: 0.5, endMs: 500 }),
    ]);
    expect(checkDocument(asUntrustedJson(doc)).ok).toBe(false);
  });

  it('rejects a negative timestamp', () => {
    const doc = makeDocumentWithTrack([
      makeSegment([makeWord('a', 0, 500)], { startMs: -1, endMs: 500 }),
    ]);
    expect(checkDocument(asUntrustedJson(doc)).ok).toBe(false);
  });

  it('rejects a malformed colour', () => {
    const styleId = newStyleId();
    const doc = makeDocument({ styles: { [styleId]: makeStyle({ id: styleId, fill: 'red' }) } });
    expect(checkDocument(asUntrustedJson(doc)).ok).toBe(false);
  });

  it('rejects an out-of-range opacity', () => {
    const styleId = newStyleId();
    const doc = makeDocument({
      styles: { [styleId]: makeStyle({ id: styleId, shadowOpacity: 5 }) },
    });
    expect(checkDocument(asUntrustedJson(doc)).ok).toBe(false);
  });

  it('accepts rotation as one of the four legal values', () => {
    const doc = makeDocument({
      assets: [
        {
          id: 'a1',
          role: 'sourceVideo',
          filename: 'clip.mp4',
          mimeType: 'video/mp4',
          byteSize: 100,
          meta: { durationMs: 5000, rotation: 90, frameRateNum: 30000, frameRateDen: 1001 },
        },
      ],
    });
    expect(checkDocument(asUntrustedJson(doc)).ok).toBe(true);
  });

  it('rejects an illegal rotation value', () => {
    // 45 is not one of 0/90/180/270. It has to bypass the compile-time type to reach the
    // runtime check, which is exactly the point: a document read from disk is untrusted
    // input and the type system cannot vouch for it.
    const illegalRotation: unknown = 45;
    const doc: unknown = {
      ...makeDocument(),
      assets: [
        {
          id: 'a1',
          role: 'sourceVideo',
          filename: 'clip.mp4',
          mimeType: 'video/mp4',
          byteSize: 100,
          meta: { durationMs: 5000, rotation: illegalRotation },
        },
      ],
    };
    expect(checkDocument(doc).ok).toBe(false);
  });
});

describe('semantic invariants', () => {
  it('reports overlapping segments (I-3)', () => {
    const doc = makeDocumentWithTrack([
      makeSegment([makeWord('a', 0, 600)], { startMs: 0, endMs: 600 }),
      makeSegment([makeWord('b', 500, 900)], { startMs: 500, endMs: 900 }),
    ]);
    const report = validateInvariants(doc);
    expect(report.valid).toBe(false);
    expect(report.violations.some((v) => v.invariant === 'I-3')).toBe(true);
    expect(report.violations[0]?.message).toMatch(/overlap/i);
  });

  it('reports unsorted segments (I-3)', () => {
    const doc = makeDocumentWithTrack([
      makeSegment([makeWord('b', 500, 900)], { startMs: 500, endMs: 900 }),
      makeSegment([makeWord('a', 0, 400)], { startMs: 0, endMs: 400 }),
    ]);
    const report = validateInvariants(doc);
    expect(report.valid).toBe(false);
    expect(report.violations.some((v) => /not sorted/i.test(v.message))).toBe(true);
  });

  it('reports a zero-length segment (I-2)', () => {
    const doc = makeDocumentWithTrack([
      makeSegment([makeWord('a', 100, 100)], { startMs: 100, endMs: 100 }),
    ]);
    const report = validateInvariants(doc);
    expect(report.valid).toBe(false);
    expect(report.violations.some((v) => v.invariant === 'I-2')).toBe(true);
  });

  it('reports a word outside its segment (I-3)', () => {
    const segment = makeSegment([makeWord('stray', 900, 1000)], { startMs: 0, endMs: 500 });
    const report = validateInvariants(makeDocumentWithTrack([segment]));
    expect(report.valid).toBe(false);
    expect(report.violations.some((v) => /outside its segment/i.test(v.message))).toBe(true);
  });

  it('reports a stale text cache rather than silently fixing it (I-8)', () => {
    const segment = makeSegment([makeWord('hello', 0, 500)], { text: 'HELLO' });
    const report = validateInvariants(makeDocumentWithTrack([segment]));
    expect(report.valid).toBe(false);
    const drift = report.violations.find((v) => v.invariant === 'I-8');
    expect(drift).toBeDefined();
    expect(drift?.message).toMatch(/stale/i);
  });

  it('reports styleId and styleOverride together (I-14)', () => {
    const styleId = newStyleId();
    const segment = makeSegment([makeWord('a', 0, 500)], {
      styleId,
      styleOverride: { fontSizePx: 40 },
    });
    const doc = makeDocumentWithTrack([segment], {
      styles: { [styleId]: makeStyle({ id: styleId }) },
    });
    const report = validateInvariants(doc);
    expect(report.valid).toBe(false);
    expect(report.violations.some((v) => v.invariant === 'I-14')).toBe(true);
  });

  it('reports a dangling style reference (I-4)', () => {
    const segment = makeSegment([makeWord('a', 0, 500)], { styleId: 'missing' });
    const report = validateInvariants(makeDocumentWithTrack([segment]));
    expect(report.valid).toBe(false);
    expect(report.violations.some((v) => v.invariant === 'I-4')).toBe(true);
  });

  it('reports a dangling animation reference (I-4)', () => {
    const segment = makeSegment([makeWord('a', 0, 500)], { animationId: 'missing' });
    const report = validateInvariants(makeDocumentWithTrack([segment]));
    expect(report.valid).toBe(false);
    expect(report.violations.some((v) => v.invariant === 'I-4')).toBe(true);
  });

  it('reports duplicate ids (I-5)', () => {
    const doc = makeDocumentWithTrack([
      makeSegment([makeWord('a', 0, 400)], { id: 'dup' }),
      makeSegment([makeWord('b', 400, 800)], { id: 'dup' }),
    ]);
    const report = validateInvariants(doc);
    expect(report.valid).toBe(false);
    expect(report.violations.some((v) => v.invariant === 'I-5')).toBe(true);
  });

  it('reports duplicate ids across tracks, assets and segments alike', () => {
    const doc = makeDocumentWithTrack([makeSegment([makeWord('a', 0, 400)], { id: 'shared' })]);
    doc.assets.push({
      id: 'shared',
      role: 'sourceVideo',
      filename: 'x.mp4',
      mimeType: 'video/mp4',
      byteSize: 1,
    });
    const report = validateInvariants(doc);
    expect(report.violations.some((v) => v.invariant === 'I-5')).toBe(true);
  });

  it('reports a style whose key disagrees with its declared id (I-5)', () => {
    const doc = makeDocument({ styles: { keyA: makeStyle({ id: 'keyB' }) } });
    const report = validateInvariants(doc);
    expect(report.violations.some((v) => v.invariant === 'I-5')).toBe(true);
  });

  it('collects every violation rather than stopping at the first', () => {
    const doc = makeDocumentWithTrack([
      makeSegment([makeWord('a', 0, 600)], { startMs: 0, endMs: 600, styleId: 'missing' }),
      makeSegment([makeWord('b', 500, 900)], { startMs: 500, endMs: 900 }),
    ]);
    const report = validateInvariants(doc);
    expect(report.violations.length).toBeGreaterThanOrEqual(2);
  });
});

describe('parseDocument', () => {
  it('returns a typed document on success', () => {
    const doc = makeDocumentWithTrack([makeSegment([makeWord('hi', 0, 100)])]);
    const parsed = parseDocument(asUntrustedJson(doc) as never);
    expect(parsed.tracks).toHaveLength(1);
    expect(parsed.tracks[0]?.segments[0]?.text).toBe('hi');
  });

  it('throws DocumentValidationError on failure', () => {
    const doc = makeDocumentWithTrack([
      makeSegment([makeWord('a', 0, 600)], { startMs: 0, endMs: 600 }),
      makeSegment([makeWord('b', 500, 900)], { startMs: 500, endMs: 900 }),
    ]);
    expect(() => parseDocument(asUntrustedJson(doc) as never)).toThrow(DocumentValidationError);
  });

  it('produces an error message that names the problem', () => {
    const doc = makeDocumentWithTrack([
      makeSegment([makeWord('a', 100, 100)], { startMs: 100, endMs: 100 }),
    ]);
    try {
      parseDocument(asUntrustedJson(doc) as never);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentValidationError);
      expect((error as Error).message).toMatch(/I-2/);
    }
  });
});

describe('serialization', () => {
  it('round-trips a document through JSON unchanged (I-9)', () => {
    const doc = makeDocumentWithTrack([
      makeSegment([makeWord('hello ', 0, 400), makeWord('world', 400, 900)], {
        styleOverride: { fill: '#FF0000' },
      }),
    ]);
    const parsed = parseDocument(asUntrustedJson(doc) as never);

    // Deep equality, not byte equality: JSON object key order is not part of the data,
    // and Zod emits keys in schema-declaration order. What matters is that no value is
    // lost, added, or altered by the round trip.
    expect(parsed).toEqual(doc);

    // And the canonical form is stable — parsing twice yields identical output.
    const again = parseDocument(asUntrustedJson(parsed) as never);
    expect(JSON.stringify(again)).toBe(JSON.stringify(parsed));
  });

  it('preserves word spacing needed to rebuild the text', () => {
    const segment = makeSegment([makeWord('hello ', 0, 400), makeWord('world', 400, 900)]);
    expect(segment.text).toBe('hello world');
  });
});
