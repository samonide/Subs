import { describe, expect, it } from 'vitest';

import {
  applyOperation,
  applyStyleToSelection,
  applyWorkerResult,
  mergeSegments,
  moveSegment,
  retimeSegment,
  setSegmentStyleOverride,
  splitSegment,
  type WorkerResult,
} from '../src/core/ops/index.js';
import { newStyleId } from '../src/core/document/ids.js';
import type { ProjectDocument, SubtitleSegment } from '../src/core/document/types.js';
import {
  makeDocumentWithTrack,
  makeSegment,
  makeStyle,
  makeWord,
} from '../src/core/testing/factories.js';

function segmentIds(doc: ProjectDocument): string[] {
  return (doc.tracks[0]?.segments ?? []).map((s) => s.id);
}

function firstSegment(doc: ProjectDocument): SubtitleSegment {
  const segment = doc.tracks[0]?.segments[0];
  if (segment === undefined) {
    throw new Error('fixture has no first segment');
  }
  return segment;
}

const twoWordSegment = (): SubtitleSegment =>
  makeSegment([makeWord('hello ', 0, 400), makeWord('world', 400, 900)], {
    startMs: 0,
    endMs: 900,
  });

describe('purity', () => {
  it('every operation returns a new document and never mutates the input', () => {
    const doc = makeDocumentWithTrack([twoWordSegment()]);
    const snapshot = JSON.stringify(doc);
    const id = firstSegment(doc).id;

    applyOperation(doc, moveSegment(id, 100));
    applyOperation(doc, retimeSegment(id, 'end', 1200));
    applyOperation(doc, setSegmentStyleOverride(id, { fontSizePx: 20 }));
    applyOperation(doc, splitSegment(id, 400));

    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('is deterministic — the same operation twice yields equal documents', () => {
    const doc = makeDocumentWithTrack([twoWordSegment()]);
    const id = firstSegment(doc).id;
    const a = applyOperation(doc, retimeSegment(id, 'end', 1234));
    const b = applyOperation(doc, retimeSegment(id, 'end', 1234));
    expect(a).toEqual(b);
  });

  it('carries a human-readable label for the undo history', () => {
    expect(moveSegment('x', 50).label).toContain('Move segment');
    expect(splitSegment('x', 500).label).toContain('Split segment');
  });
});

describe('moveSegment', () => {
  it('preserves duration — a drag moves, it does not retime', () => {
    const doc = makeDocumentWithTrack([twoWordSegment()]);
    const id = firstSegment(doc).id;
    const before = firstSegment(doc);

    const next = applyOperation(doc, moveSegment(id, 100));
    const after = firstSegment(next);

    expect(after.startMs).toBe(before.startMs + 100);
    expect(after.endMs).toBe(before.endMs + 100);
    expect(after.endMs - after.startMs).toBe(before.endMs - before.startMs);
  });

  it('moves the words with the segment', () => {
    const doc = makeDocumentWithTrack([twoWordSegment()]);
    const id = firstSegment(doc).id;
    const next = applyOperation(doc, moveSegment(id, 250));
    const words = firstSegment(next).words;
    expect(words[0]?.startMs).toBe(250);
    expect(words[1]?.endMs).toBe(1150);
  });

  it('does not move a segment before zero', () => {
    const doc = makeDocumentWithTrack([twoWordSegment()]);
    const id = firstSegment(doc).id;
    const next = applyOperation(doc, moveSegment(id, -5000));
    expect(firstSegment(next).startMs).toBe(0);
  });

  it('is a no-op for a zero delta', () => {
    const doc = makeDocumentWithTrack([twoWordSegment()]);
    const next = applyOperation(doc, moveSegment(firstSegment(doc).id, 0));
    expect(next).toBe(doc);
  });

  it('is a no-op for an unknown segment id', () => {
    const doc = makeDocumentWithTrack([twoWordSegment()]);
    expect(applyOperation(doc, moveSegment('nope', 100))).toBe(doc);
  });
});

describe('retimeSegment', () => {
  it('moves only the requested edge', () => {
    const doc = makeDocumentWithTrack([twoWordSegment()]);
    const id = firstSegment(doc).id;
    const after = firstSegment(applyOperation(doc, retimeSegment(id, 'end', 1500)));
    expect(after.endMs).toBe(1500);
    expect(after.startMs).toBe(0); // untouched
  });

  it('clamps words to the new bounds so none escapes the segment', () => {
    const doc = makeDocumentWithTrack([twoWordSegment()]);
    const id = firstSegment(doc).id;
    const after = firstSegment(applyOperation(doc, retimeSegment(id, 'end', 100)));
    for (const word of after.words) {
      expect(word.startMs).toBeGreaterThanOrEqual(after.startMs);
      expect(word.endMs).toBeLessThanOrEqual(after.endMs);
    }
  });

  it('never allows a zero-length segment', () => {
    const doc = makeDocumentWithTrack([twoWordSegment()]);
    const id = firstSegment(doc).id;
    const after = firstSegment(applyOperation(doc, retimeSegment(id, 'end', 0)));
    expect(after.endMs).toBeGreaterThan(after.startMs);
  });

  it('never allows a start past the end', () => {
    const doc = makeDocumentWithTrack([twoWordSegment()]);
    const id = firstSegment(doc).id;
    const after = firstSegment(applyOperation(doc, retimeSegment(id, 'start', 5000)));
    expect(after.startMs).toBeLessThan(after.endMs);
  });
});

describe('splitSegment', () => {
  it('splits at a word boundary, never mid-word', () => {
    const doc = makeDocumentWithTrack([twoWordSegment()]);
    const id = firstSegment(doc).id;
    const next = applyOperation(doc, splitSegment(id, 450));
    const segments = next.tracks[0]?.segments ?? [];

    expect(segments).toHaveLength(2);
    // The split time snaps to the start of "world" (400ms), not to the requested 450ms.
    expect(segments[0]?.endMs).toBe(400);
    expect(segments[1]?.startMs).toBe(400);
  });

  it('rebuilds both halves text from their own words (I-8)', () => {
    const doc = makeDocumentWithTrack([twoWordSegment()]);
    const id = firstSegment(doc).id;
    const segments = applyOperation(doc, splitSegment(id, 400)).tracks[0]?.segments ?? [];

    expect(segments[0]?.text).toBe('hello ');
    expect(segments[1]?.text).toBe('world');
    // Each half is internally consistent.
    for (const segment of segments) {
      expect(segment.text).toBe(segment.words.map((w) => w.text).join(''));
    }
  });

  it('conserves every word across the two halves', () => {
    const doc = makeDocumentWithTrack([twoWordSegment()]);
    const id = firstSegment(doc).id;
    const segments = applyOperation(doc, splitSegment(id, 400)).tracks[0]?.segments ?? [];
    const words = segments.flatMap((s) => s.words);
    expect(words).toHaveLength(2);
    expect(words.map((w) => w.text).join('')).toBe('hello world');
  });

  it('refuses a split that would produce an empty half', () => {
    const doc = makeDocumentWithTrack([twoWordSegment()]);
    const id = firstSegment(doc).id;
    expect(applyOperation(doc, splitSegment(id, -500))).toBe(doc);
    expect(applyOperation(doc, splitSegment(id, 99_999))).toBe(doc);
  });

  it('is exactly inverted by merge', () => {
    const doc = makeDocumentWithTrack([twoWordSegment()]);
    const id = firstSegment(doc).id;
    const split = applyOperation(doc, splitSegment(id, 400));
    const [a, b] = split.tracks[0]?.segments ?? [];
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    const merged = applyOperation(split, mergeSegments(a!.id, b!.id));
    const segments = merged.tracks[0]?.segments ?? [];
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe('hello world');
    expect(segments[0]?.words.map((w) => w.text).join('')).toBe('hello world');
  });
});

describe('mergeSegments', () => {
  it('refuses non-adjacent segments rather than deleting subtitles', () => {
    const doc = makeDocumentWithTrack([
      makeSegment([makeWord('a', 0, 400)], { startMs: 0, endMs: 400 }),
      makeSegment([makeWord('b', 400, 800)], { startMs: 400, endMs: 800 }),
      makeSegment([makeWord('c', 800, 1200)], { startMs: 800, endMs: 1200 }),
    ]);
    const segments = doc.tracks[0]!.segments;
    const next = applyOperation(doc, mergeSegments(segments[0]!.id, segments[2]!.id));
    expect(segmentIds(next)).toHaveLength(3);
  });

  it('refuses to merge across tracks', () => {
    const doc = makeDocumentWithTrack([
      makeSegment([makeWord('a', 0, 400)], { startMs: 0, endMs: 400 }),
    ]);
    const second = makeSegment([makeWord('b', 400, 800)], { startMs: 400, endMs: 800 });
    const withTrack = {
      ...doc,
      tracks: [...doc.tracks, { ...doc.tracks[0]!, id: 'track-2', segments: [second] }],
    };
    const first = withTrack.tracks[0]!.segments[0]!;
    const other = withTrack.tracks[1]!.segments[0]!;
    expect(applyOperation(withTrack, mergeSegments(first.id, other.id))).toBe(withTrack);
  });
});

describe('style operations', () => {
  it('applies a sparse override to one segment only', () => {
    const doc = makeDocumentWithTrack([
      makeSegment([makeWord('a', 0, 400)], { startMs: 0, endMs: 400 }),
      makeSegment([makeWord('b', 400, 800)], { startMs: 400, endMs: 800 }),
    ]);
    const [first, second] = doc.tracks[0]!.segments;
    const next = applyOperation(doc, setSegmentStyleOverride(first!.id, { fontSizePx: 30 }));
    expect(next.tracks[0]?.segments[0]?.styleOverride).toEqual({ fontSizePx: 30 });
    expect(next.tracks[0]?.segments[1]?.styleOverride).toBeUndefined();
    expect(second).toBeDefined();
  });

  it('copies a style across a selection ("make these look like that one")', () => {
    const doc = makeDocumentWithTrack([
      makeSegment([makeWord('a', 0, 400)], {
        startMs: 0,
        endMs: 400,
        styleOverride: { fill: '#FF0000', fontSizePx: 60 },
      }),
      makeSegment([makeWord('b', 400, 800)], { startMs: 400, endMs: 800 }),
      makeSegment([makeWord('c', 800, 1200)], { startMs: 800, endMs: 1200 }),
    ]);
    const [a, b, c] = doc.tracks[0]!.segments;
    const next = applyOperation(doc, applyStyleToSelection(a!.id, [b!.id, c!.id]));
    const segments = next.tracks[0]!.segments;

    expect(segments[1]?.styleOverride).toEqual({ fill: '#FF0000', fontSizePx: 60 });
    expect(segments[2]?.styleOverride).toEqual({ fill: '#FF0000', fontSizePx: 60 });
    // The source is unchanged, and the copy is a distinct object.
    expect(segments[0]?.styleOverride).not.toBe(segments[1]?.styleOverride);
  });
});

// ── Invariant I-20 ──
describe('worker results (I-20)', () => {
  const result: WorkerResult = {
    kind: 'transcript',
    providerId: 'test-provider',
    model: 'test-model',
    language: 'en',
    generatedAt: '2026-01-01T00:00:00.000Z',
    segments: [
      {
        startMs: 0,
        endMs: 900,
        words: [
          { text: 'hello ', startMs: 0, endMs: 400, timingSource: 'measured' },
          { text: 'world', startMs: 400, endMs: 900, timingSource: 'measured' },
        ],
      },
    ],
  };

  it('a WorkerResult is not a ProjectDocument — it carries data, not state', () => {
    // The type separation is the whole point: a worker cannot hand back a document
    // because it has no way to construct one.
    expect(result).not.toHaveProperty('tracks');
    expect(result).not.toHaveProperty('schemaVersion');
  });

  it('applies a transcript as a single operation, not a wholesale document replacement', () => {
    const doc = makeDocumentWithTrack([]);
    const next = applyOperation(doc, applyWorkerResult(result));

    expect(next.tracks).toHaveLength(1);
    expect(next.tracks[0]?.segments).toHaveLength(1);
    expect(next.tracks[0]?.segments[0]?.text).toBe('hello world');
  });

  it('records provenance as a pointer, not a second copy of the transcript', () => {
    const doc = makeDocumentWithTrack([]);
    const next = applyOperation(doc, applyWorkerResult(result));
    expect(next.transcription).toEqual({
      providerId: 'test-provider',
      model: 'test-model',
      language: 'en',
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    // The words live once, in the segments.
    expect(next.transcription).not.toHaveProperty('segments');
  });

  it('marks generated segments as ASR-derived so re-transcription can protect manual work', () => {
    const doc = makeDocumentWithTrack([]);
    const next = applyOperation(doc, applyWorkerResult(result));
    expect(next.tracks[0]?.segments[0]?.origin).toBe('asr');
  });

  it('is deterministic — the same result produces the same document', () => {
    const a = applyOperation(makeDocumentWithTrack([]), applyWorkerResult(result));
    const b = applyOperation(makeDocumentWithTrack([]), applyWorkerResult(result));
    // Ids are generated, so compare the meaningful content rather than raw equality.
    expect(a.tracks[0]?.segments[0]?.text).toBe(b.tracks[0]?.segments[0]?.text);
    expect(a.transcription).toEqual(b.transcription);
  });

  it('preserves synthesized timing provenance through to the document', () => {
    const doc = makeDocumentWithTrack([]);
    const next = applyOperation(
      doc,
      applyWorkerResult({
        ...result,
        segments: [
          {
            startMs: 0,
            endMs: 500,
            words: [{ text: 'word', startMs: 0, endMs: 500, timingSource: 'synthesized' }],
          },
        ],
      }),
    );
    expect(next.tracks[0]?.segments[0]?.words[0]?.timingSource).toBe('synthesized');
  });
});

describe('style registry integration', () => {
  it('a document with styles survives every operation unchanged in shape', () => {
    const styleId = newStyleId();
    const doc = makeDocumentWithTrack([twoWordSegment()], {
      styles: { [styleId]: makeStyle({ id: styleId, fontSizePx: 64 }) },
    });
    const next = applyOperation(doc, moveSegment(firstSegment(doc).id, 10));
    expect(Object.keys(next.styles)).toEqual([styleId]);
  });
});
