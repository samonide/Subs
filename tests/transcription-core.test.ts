/**
 * The pure normalizer and the document-writing operation.
 *
 * No provider, no HTTP, no filesystem: every test here feeds literals and asserts on values.
 * The cases that matter most are the rejections, because the normalizer's value is entirely in
 * what it refuses. A normalizer that "helpfully" repairs bad provider data hands the user
 * fabricated precision while looking like it worked.
 */

import { describe, expect, it } from 'vitest';

import {
  applyTranscription,
  DURATION_SLACK_MS,
  normalizeTranscription,
  TranscriptionApplyError,
  TranscriptionError,
  TranscriptionErrorCode,
  transcriptionOperationLabel,
  type CanonicalTranscription,
  type NormalizeInput,
} from '../src/core/transcription/index.js';
import { validateInvariants } from '../src/core/validation/index.js';
import {
  makeDocument,
  makeDocumentWithTrack,
  makeSimpleSegment,
} from '../src/core/testing/factories.js';

const T0 = '2026-01-01T00:00:00.000Z';

function input(overrides: Partial<NormalizeInput> = {}): NormalizeInput {
  return {
    providerId: 'test-provider',
    model: 'test-model',
    language: 'en',
    text: 'Hello there. General Kenobi.',
    segments: [
      { start: 0, end: 1.2, text: 'Hello there.', words: [] },
      { start: 1.2, end: 2.5, text: 'General Kenobi.', words: [] },
    ],
    assetId: 'asset_1',
    supportsWordTiming: true,
    granularity: 'segment',
    ...overrides,
  };
}

function providerError(fn: () => unknown): TranscriptionError {
  try {
    fn();
  } catch (error) {
    if (error instanceof TranscriptionError) return error;
    throw error;
  }
  throw new Error('expected a TranscriptionError');
}

describe('normalizeTranscription — valid input', () => {
  it('converts segment seconds to integer milliseconds', () => {
    const result = normalizeTranscription(input());
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toMatchObject({ startMs: 0, endMs: 1200, text: 'Hello there.' });
    expect(result.segments[1]).toMatchObject({ startMs: 1200, endMs: 2500 });
  });

  it('rounds to the millisecond grid rather than flooring', () => {
    // Flooring would collapse 0.0004 and 0.0009 onto the same millisecond, erasing a
    // boundary the provider did distinguish.
    const result = normalizeTranscription(
      input({
        segments: [
          { start: 0.0004, end: 0.0009, text: 'a' },
          { start: 1.2345, end: 2.3456, text: 'b' },
        ],
      }),
    );
    expect(result.segments[0]?.startMs).toBe(0);
    expect(result.segments[0]?.endMs).toBe(1);
    expect(result.segments[1]?.startMs).toBe(1235);
    expect(result.segments[1]?.endMs).toBe(2346);
  });

  it('produces safe integers even for long recordings', () => {
    const result = normalizeTranscription(
      input({ segments: [{ start: 3599.999, end: 3600.001, text: 'end' }] }),
    );
    expect(Number.isSafeInteger(result.segments[0]?.endMs)).toBe(true);
    expect(result.segments[0]?.endMs).toBe(3600001);
  });

  it('sorts segments by start time', () => {
    // Array order is the order, and invariant I-3 requires sorted tracks. Sorting cannot change
    // any timestamp, so this is ordering rather than repair.
    const result = normalizeTranscription(
      input({
        segments: [
          { start: 2, end: 3, text: 'later' },
          { start: 0, end: 1, text: 'earlier' },
        ],
      }),
    );
    expect(result.segments.map((s) => s.text)).toEqual(['earlier', 'later']);
  });

  it('preserves provider text verbatim apart from trimming', () => {
    // This phase never rewrites wording, re-punctuates, or corrects spelling.
    const result = normalizeTranscription(
      input({ segments: [{ start: 0, end: 1, text: '  Héllo, wörld!  ' }] }),
    );
    expect(result.segments[0]?.text).toBe('Héllo, wörld!');
  });

  it('keeps unicode and emoji intact', () => {
    const result = normalizeTranscription(
      input({ segments: [{ start: 0, end: 1, text: '日本語テスト 🎬 naïve' }] }),
    );
    expect(result.segments[0]?.text).toBe('日本語テスト 🎬 naïve');
  });

  it('retains the provider language, model, and text', () => {
    const result = normalizeTranscription(input({ language: 'fr', text: 'Bonjour.' }));
    expect(result.language).toBe('fr');
    expect(result.diagnostics.model).toBe('test-model');
    expect(result.text).toBe('Bonjour.');
  });

  it('records the source asset for provenance', () => {
    expect(normalizeTranscription(input()).sourceAssetId).toBe('asset_1');
  });
});

describe('normalizeTranscription — confidence', () => {
  it('keeps an absent confidence absent, not zero', () => {
    // The distinction the whole type exists for: a provider that said nothing has not claimed
    // maximal uncertainty.
    const result = normalizeTranscription(input());
    expect(result.segments[0]?.confidence).toBeUndefined();
    expect('confidence' in (result.segments[0] ?? {})).toBe(false);
    // And it survives serialization as absent, not as null or 0.
    const roundTripped = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(roundTripped.segments[0]).not.toHaveProperty('confidence');
  });

  it('keeps a genuine zero confidence as zero', () => {
    const result = normalizeTranscription(
      input({ segments: [{ start: 0, end: 1, text: 'a', confidence: 0 }] }),
    );
    expect(result.segments[0]?.confidence).toBe(0);
  });

  it('keeps a present confidence', () => {
    const result = normalizeTranscription(
      input({ segments: [{ start: 0, end: 1, text: 'a', confidence: 0.87 }] }),
    );
    expect(result.segments[0]?.confidence).toBeCloseTo(0.87);
  });

  it('drops an out-of-range confidence instead of substituting one', () => {
    // A confidence of 700 is a provider bug. Clamping to 1 would invent certainty; recording
    // 0 would invent uncertainty. Dropping it is the only non-fabricating option.
    const result = normalizeTranscription(
      input({ segments: [{ start: 0, end: 1, text: 'a', confidence: 700 }] }),
    );
    expect(result.segments[0]?.confidence).toBeUndefined();
  });
});

describe('normalizeTranscription — words', () => {
  const withWords = {
    segments: [
      {
        start: 0,
        end: 1.5,
        text: 'Hello there.',
        words: [
          { text: 'Hello', start: 0, end: 0.6, confidence: 0.95 },
          { text: 'there', start: 0.6, end: 1.5 },
        ],
      },
    ],
  };

  it('normalises word timing and preserves order', () => {
    const result = normalizeTranscription(input({ segments: withWords.segments }));
    const words = result.segments[0]?.words ?? [];
    expect(words.map((w) => w.text)).toEqual(['Hello', 'there']);
    expect(words.map((w) => [w.startMs, w.endMs])).toEqual([
      [0, 600],
      [600, 1500],
    ]);
  });

  it('marks provider timings as measured', () => {
    const result = normalizeTranscription(input({ segments: withWords.segments }));
    expect(result.segments[0]?.words.every((w) => w.timingSource === 'measured')).toBe(true);
  });

  it('reports wordTimingAvailable', () => {
    expect(
      normalizeTranscription(input({ segments: withWords.segments })).wordTimingAvailable,
    ).toBe(true);
    expect(normalizeTranscription(input()).wordTimingAvailable).toBe(false);
  });

  it('widens the segment span to contain its words rather than rejecting', () => {
    // A segment boundary slightly inside its own words is the coarser measurement losing to the
    // finer one. Taking the max keeps I-3 true without inventing a time.
    const result = normalizeTranscription(
      input({
        segments: [
          {
            start: 0.1,
            end: 1.0,
            text: 'x',
            words: [
              { text: 'a', start: 0, end: 0.6 },
              { text: 'b', start: 0.6, end: 1.4 },
            ],
          },
        ],
      }),
    );
    expect(result.segments[0]?.startMs).toBe(0);
    expect(result.segments[0]?.endMs).toBe(1400);
  });

  it('trims word whitespace so the segment join is clean', () => {
    const result = normalizeTranscription(
      input({
        segments: [
          {
            start: 0,
            end: 1,
            text: 'x',
            words: [
              { text: 'Hello ', start: 0, end: 0.5 },
              { text: ' world', start: 0.5, end: 1 },
            ],
          },
        ],
      }),
    );
    expect(result.segments[0]?.words.map((w) => w.text)).toEqual(['Hello', 'world']);
  });

  it('warns when word granularity was requested but not delivered', () => {
    const result = normalizeTranscription(input({ granularity: 'word' }));
    expect(result.wordTimingAvailable).toBe(false);
    expect(result.diagnostics.warnings.join(' ')).toMatch(/word-level timings/i);
  });

  it('does not warn when words were never requested', () => {
    // Warning on a segment-only request would be noise on every result.
    const result = normalizeTranscription(input({ granularity: 'segment' }));
    expect(result.diagnostics.warnings.join(' ')).not.toMatch(/word-level timings/i);
  });
});

describe('normalizeTranscription — rejections', () => {
  it('rejects an empty segment list', () => {
    expect(providerError(() => normalizeTranscription(input({ segments: [] }))).code).toBe(
      TranscriptionErrorCode.MalformedResponse,
    );
  });

  it('rejects a missing segments array', () => {
    expect(
      providerError(() =>
        normalizeTranscription(input({ segments: undefined as unknown as unknown[] })),
      ).code,
    ).toBe(TranscriptionErrorCode.MalformedResponse);
  });

  it('rejects an inverted segment', () => {
    const error = providerError(() =>
      normalizeTranscription(input({ segments: [{ start: 2, end: 1, text: 'x' }] })),
    );
    expect(error.code).toBe(TranscriptionErrorCode.MalformedResponse);
    expect(error.message).toMatch(/ends at or before/i);
  });

  it('rejects a zero-length segment', () => {
    expect(
      providerError(() =>
        normalizeTranscription(input({ segments: [{ start: 1, end: 1, text: 'x' }] })),
      ).message,
    ).toMatch(/ends at or before/i);
  });

  it('rejects negative timestamps', () => {
    const error = providerError(() =>
      normalizeTranscription(input({ segments: [{ start: -1, end: 1, text: 'x' }] })),
    );
    expect(error.message).toMatch(/negative/i);
  });

  it('rejects a non-finite timestamp', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        providerError(() =>
          normalizeTranscription(input({ segments: [{ start: 0, end: bad, text: 'x' }] })),
        ).code,
      ).toBe(TranscriptionErrorCode.MalformedResponse);
    }
  });

  it('rejects a word whose timing is inverted', () => {
    const error = providerError(() =>
      normalizeTranscription(
        input({
          segments: [
            {
              start: 0,
              end: 2,
              text: 'x',
              words: [{ text: 'a', start: 1, end: 0.5 }],
            },
          ],
        }),
      ),
    );
    expect(error.message).toMatch(/ends at or before/i);
  });

  it('widens the segment rather than rejecting a word outside its reported span', () => {
    // The segment span is widened to contain its words, so a word "outside its segment" cannot
    // survive normalisation — I-3 is satisfied by construction rather than by rejection. This is
    // the documented exception to "reject, don't repair", and it is safe because it can only
    // ever widen a span to a time the provider itself reported.
    const result = normalizeTranscription(
      input({
        segments: [
          {
            start: 10,
            end: 11,
            text: 'x',
            words: [{ text: 'a', start: 0, end: 2 }],
          },
        ],
      }),
    );
    // Segment reported as 10–11s, its only word as 0–2s. The span becomes their union, because
    // taking the max of two times the provider itself reported cannot invent one.
    expect(result.segments[0]?.startMs).toBe(0);
    expect(result.segments[0]?.endMs).toBe(11000);
  });

  it('rejects a word extending materially past the source duration', () => {
    // The gap this caught: the segment span is widened to fit its words, so a word far past the
    // end of the audio would otherwise have escaped the duration check entirely.
    const error = providerError(() =>
      normalizeTranscription(
        input({
          segments: [
            {
              start: 0,
              end: 1,
              text: 'x',
              words: [{ text: 'a', start: 0, end: 30 }],
            },
          ],
          sourceDurationMs: 5000,
        }),
      ),
    );
    expect(error.message).toMatch(/Word 0 ends at 30000ms, past the 5000ms source/i);
  });

  it('rejects a non-object segment and a non-object word', () => {
    expect(providerError(() => normalizeTranscription(input({ segments: ['nope'] }))).code).toBe(
      TranscriptionErrorCode.MalformedResponse,
    );
    expect(
      providerError(() =>
        normalizeTranscription(input({ segments: [{ start: 0, end: 1, text: 'x', words: [42] }] })),
      ).code,
    ).toBe(TranscriptionErrorCode.MalformedResponse);
  });

  it('rejects a segment or word with no text', () => {
    expect(
      providerError(() => normalizeTranscription(input({ segments: [{ start: 0, end: 1 }] })))
        .message,
    ).toMatch(/no text/i);
    expect(
      providerError(() =>
        normalizeTranscription(
          input({
            segments: [{ start: 0, end: 1, text: 'x', words: [{ start: 0, end: 1 }] }],
          }),
        ),
      ).message,
    ).toMatch(/no text/i);
  });

  it('rejects a segment ending materially past the source duration', () => {
    const error = providerError(() =>
      normalizeTranscription(
        input({ segments: [{ start: 0, end: 30, text: 'x' }], sourceDurationMs: 5000 }),
      ),
    );
    expect(error.message).toMatch(/past the 5000ms source/i);
  });

  it('tolerates a segment slightly past the source duration', () => {
    // Container and resampling rounding routinely puts the final word a few ms over. Rejecting
    // good transcripts over that would be maddening.
    const result = normalizeTranscription(
      input({
        segments: [{ start: 0, end: 5 + DURATION_SLACK_MS / 1000, text: 'x' }],
        sourceDurationMs: 5000,
      }),
    );
    expect(result.segments[0]?.endMs).toBe(5000 + DURATION_SLACK_MS);
  });

  it('warns rather than invents when no language is reported', () => {
    const result = normalizeTranscription(input({ language: undefined }));
    expect(result.language).toBeUndefined();
    expect(result.diagnostics.warnings.join(' ')).toMatch(/did not report a detected language/i);
  });
});

describe('applyTranscription', () => {
  const result: CanonicalTranscription = normalizeTranscription(
    input({
      segments: [
        {
          start: 0,
          end: 1,
          text: 'Hello',
          words: [{ text: 'Hello', start: 0, end: 1, confidence: 0.9, timingSource: 'measured' }],
        },
      ],
    }),
  );

  it('creates a track on an empty project', () => {
    const doc = makeDocument();
    const next = applyTranscription(doc, result, { kind: 'new-track' }, T0);
    expect(next.tracks).toHaveLength(1);
    expect(next.tracks[0]?.segments).toHaveLength(1);
    expect(next.tracks[0]?.segments[0]?.origin).toBe('asr');
  });

  it('never mutates the input document', () => {
    const doc = makeDocument();
    const before = JSON.stringify(doc);
    applyTranscription(doc, result, { kind: 'new-track' }, T0);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('produces a document that satisfies every invariant', () => {
    const doc = makeDocument();
    const next = applyTranscription(doc, result, { kind: 'new-track' }, T0);
    expect(validateInvariants(next)).toEqual({ valid: true, violations: [] });
  });

  it('derives segment text from the words rather than copying the provider string', () => {
    const spaced = normalizeTranscription(
      input({
        segments: [
          {
            start: 0,
            end: 1,
            text: 'Hello world',
            words: [
              { text: 'Hello', start: 0, end: 0.5, timingSource: 'measured' },
              { text: 'world', start: 0.5, end: 1, timingSource: 'measured' },
            ],
          },
        ],
      }),
    );
    const next = applyTranscription(makeDocument(), spaced, { kind: 'new-track' }, T0);
    // Invariant I-8 checks text against the word join, so the cache must be derived here.
    expect(next.tracks[0]?.segments[0]?.text).toBe('Helloworld');
    expect(validateInvariants(next).valid).toBe(true);
  });

  it('preserves an absent confidence as absent', () => {
    const noConfidence = normalizeTranscription(
      input({
        segments: [
          {
            start: 0,
            end: 1,
            text: 'a',
            words: [{ text: 'a', start: 0, end: 1, timingSource: 'measured' }],
          },
        ],
      }),
    );
    const next = applyTranscription(makeDocument(), noConfidence, { kind: 'new-track' }, T0);
    expect(next.tracks[0]?.segments[0]?.words[0]).not.toHaveProperty('confidence');
  });

  it('preserves a zero confidence as zero', () => {
    const zero = normalizeTranscription(
      input({
        segments: [
          {
            start: 0,
            end: 1,
            text: 'a',
            words: [{ text: 'a', start: 0, end: 1, confidence: 0, timingSource: 'measured' }],
          },
        ],
      }),
    );
    const next = applyTranscription(makeDocument(), zero, { kind: 'new-track' }, T0);
    expect(next.tracks[0]?.segments[0]?.words[0]?.confidence).toBe(0);
  });

  it('preserves timing source through to the document', () => {
    const next = applyTranscription(makeDocument(), result, { kind: 'new-track' }, T0);
    expect(next.tracks[0]?.segments[0]?.words[0]?.timingSource).toBe('measured');
  });

  it('records provenance on the document', () => {
    const next = applyTranscription(makeDocument(), result, { kind: 'new-track' }, T0);
    expect(next.transcription).toEqual({
      providerId: 'test-provider',
      model: 'test-model',
      language: 'en',
      generatedAt: T0,
    });
  });

  it('leaves unrelated project state untouched', () => {
    const doc = makeDocument({ name: 'Keep me' });
    const next = applyTranscription(doc, result, { kind: 'new-track' }, T0);
    expect(next.name).toBe('Keep me');
    expect(next.assets).toEqual(doc.assets);
    expect(next.styles).toEqual(doc.styles);
    expect(next.canvas).toEqual(doc.canvas);
    expect(next.id).toBe(doc.id);
    expect(next.createdAt).toBe(doc.createdAt);
  });

  it('rejects new-track when the project already has a track', () => {
    const doc = makeDocumentWithTrack();
    expect(() => applyTranscription(doc, result, { kind: 'new-track' }, T0)).toThrow(
      TranscriptionApplyError,
    );
  });

  it('refuses to create a second track silently', () => {
    // Silently appending would leave two overlapping tracks and an invariant failure much later.
    const doc = makeDocumentWithTrack();
    let message = '';
    try {
      applyTranscription(doc, result, { kind: 'new-track' }, T0);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/already has subtitle tracks/i);
  });

  it('replaces a machine-generated track', () => {
    const doc = makeDocumentWithTrack();
    const first = applyTranscription(
      doc,
      result,
      { kind: 'replace-track', trackId: doc.tracks[0]!.id },
      T0,
    );
    const second = applyTranscription(
      first,
      result,
      { kind: 'replace-track', trackId: doc.tracks[0]!.id },
      T0,
    );
    expect(second.tracks[0]?.segments).toHaveLength(1);
  });

  it('refuses to overwrite a track holding manual work, and names the count', () => {
    // The rule that protects the user. Re-transcribing must never silently discard a hand edit.
    const doc = makeDocumentWithTrack([makeSimpleSegment(0, 1000)]);
    const trackId = doc.tracks[0]!.id;
    const edited = {
      ...doc,
      tracks: doc.tracks.map((track) => ({
        ...track,
        segments: track.segments.map((segment) => ({
          ...segment,
          origin: 'manual' as const,
          text: 'I fixed this',
        })),
      })),
    };

    let caught: TranscriptionApplyError | undefined;
    try {
      applyTranscription(edited, result, { kind: 'replace-track', trackId }, T0);
    } catch (error) {
      caught = error as TranscriptionApplyError;
    }
    expect(caught).toBeInstanceOf(TranscriptionApplyError);
    expect(caught?.protectedCount).toBe(1);
    expect(caught?.message).toMatch(/1 manually edited segment/i);
  });

  it('leaves the document untouched when it refuses', () => {
    const doc = makeDocumentWithTrack([makeSimpleSegment(0, 1000)]);
    const trackId = doc.tracks[0]!.id;
    const edited = {
      ...doc,
      tracks: doc.tracks.map((track) => ({
        ...track,
        segments: track.segments.map((s) => ({ ...s, origin: 'manual' as const })),
      })),
    };
    const before = JSON.stringify(edited);
    expect(() =>
      applyTranscription(edited, result, { kind: 'replace-track', trackId }, T0),
    ).toThrow();
    expect(JSON.stringify(edited)).toBe(before);
  });

  it('refuses to write to a locked track', () => {
    const doc = makeDocumentWithTrack();
    const locked = { ...doc, tracks: doc.tracks.map((t) => ({ ...t, locked: true })) };
    expect(() =>
      applyTranscription(locked, result, { kind: 'replace-track', trackId: doc.tracks[0]!.id }, T0),
    ).toThrow(/locked/i);
  });

  it('refuses an unknown track', () => {
    expect(() =>
      applyTranscription(
        makeDocumentWithTrack(),
        result,
        { kind: 'replace-track', trackId: 'nope' },
        T0,
      ),
    ).toThrow(/No track/i);
  });
});

describe('transcriptionOperationLabel', () => {
  it('describes the action for undo history', () => {
    const result = normalizeTranscription(input());
    const label = transcriptionOperationLabel(result);
    expect(label).toMatch(/^Transcribe \(test-provider, 2 segments\)$/);
  });

  it('includes the word count when word timings exist', () => {
    const result = normalizeTranscription(
      input({
        segments: [
          {
            start: 0,
            end: 1,
            text: 'a b',
            words: [
              { text: 'a', start: 0, end: 0.5, timingSource: 'measured' },
              { text: 'b', start: 0.5, end: 1, timingSource: 'measured' },
            ],
          },
        ],
      }),
    );
    expect(transcriptionOperationLabel(result)).toContain('2 words');
  });
});
