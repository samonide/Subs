/**
 * The provider contract suite.
 *
 * These are the guarantees **every** transcription provider must satisfy, expressed once so a
 * future adapter inherits them by construction rather than by remembering. The OpenAI adapter
 * runs them; a local Whisper adapter will run the same suite.
 *
 * The suite drives the whole path — adapter → normalizer → canonical result — because a
 * guarantee about a provider that only holds for the adapter in isolation is not a guarantee the
 * application can rely on.
 *
 * No network: every case feeds a recorded provider response. Real-provider verification is a
 * separate, opt-in concern (see `provider-live.test.ts` and docs/PHASE4.md).
 */

import { describe, expect, it } from 'vitest';

import {
  normalizeTranscription,
  TranscriptionError,
  TranscriptionErrorCode,
  type ProviderTranscript,
  type TranscriptionErrorCodeValue,
  type TranscriptionProvider,
} from '../src/core/transcription/index.js';
import { OpenAITranscriptionProvider } from '../src/server/transcription/openai.js';

const ASSET = 'asset_test' as const;

function config(overrides: Partial<{ model: string }> = {}) {
  return {
    apiKey: 'test-key-not-real',
    model: overrides.model ?? 'whisper-1',
    endpoint: 'https://example.invalid/v1/audio/transcriptions',
    timeoutMs: 5000,
  };
}

/**
 * A fetch stub returning one recorded provider response.
 *
 * Declared `async` because a real fetch is: the adapter awaits the promise and then reads
 * `ok`/`status` off the resolved Response, so a synchronously-returning stub would not exercise
 * the same path.
 */
async function jsonResponse(
  payload: unknown,
  init: { status?: number; body?: string } = {},
): Promise<Response> {
  return new Response(init.body ?? JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(payload: unknown, init: { status?: number; body?: string } = {}): typeof fetch {
  return async () => jsonResponse(payload, init);
}

/** A stub that throws a transport-level failure, as `fetch` does when a host is unreachable. */
function failingFetch(error: Error): typeof fetch {
  return async () => {
    await Promise.resolve();
    throw error;
  };
}

function provider(fetchImpl: typeof fetch, model?: string): TranscriptionProvider {
  return new OpenAITranscriptionProvider(config(model === undefined ? {} : { model }), fetchImpl);
}

/** Run the full path for a recorded payload and return the canonical result. */
async function canonicalise(
  payload: unknown,
  options: { granularity?: 'segment' | 'word'; model?: string } = {},
): Promise<ReturnType<typeof normalizeTranscription>> {
  const p = provider(stubFetch(payload), options.model);
  const transcript: ProviderTranscript = await p.transcribe({
    audio: new Uint8Array([1, 2, 3, 4]),
    filename: 'audio.wav',
    assetId: ASSET,
    granularity: options.granularity ?? 'word',
  });
  return normalizeTranscription({
    providerId: transcript.providerId,
    ...(transcript.model === undefined ? {} : { model: transcript.model }),
    ...(transcript.language === undefined ? {} : { language: transcript.language }),
    text: transcript.text,
    segments: transcript.segments,
    assetId: ASSET,
    supportsWordTiming: p.supportsWordTiming,
    granularity: options.granularity ?? 'word',
  });
}

/** A realistic `verbose_json` payload with word timestamps. */
const SEGMENTS_WITH_WORDS = {
  task: 'transcribe',
  language: 'en',
  duration: 2.5,
  text: 'Hello there. General Kenobi.',
  segments: [
    {
      id: 0,
      start: 0.0,
      end: 1.2,
      text: 'Hello there.',
      words: [
        { word: 'Hello', start: 0.0, end: 0.5, probability: 0.99 },
        { word: ' there', start: 0.5, end: 1.2, probability: 0.97 },
      ],
    },
    {
      id: 1,
      start: 1.2,
      end: 2.5,
      text: ' General Kenobi.',
      words: [
        { word: ' General', start: 1.2, end: 1.9, probability: 0.95 },
        { word: ' Kenobi.', start: 1.9, end: 2.5, probability: 0.93 },
      ],
    },
  ],
};

describe('provider contract — successful transcription', () => {
  it('produces integer-millisecond segment timings', async () => {
    const result = await canonicalise(SEGMENTS_WITH_WORDS);
    expect(result.segments[0]?.startMs).toBe(0);
    expect(result.segments[0]?.endMs).toBe(1200);
    expect(result.segments[1]?.endMs).toBe(2500);
    for (const segment of result.segments) {
      expect(Number.isSafeInteger(segment.startMs)).toBe(true);
      expect(Number.isSafeInteger(segment.endMs)).toBe(true);
    }
  });

  it('produces word timings with segment containment', async () => {
    const result = await canonicalise(SEGMENTS_WITH_WORDS);
    for (const segment of result.segments) {
      for (const word of segment.words) {
        expect(word.startMs).toBeGreaterThanOrEqual(segment.startMs);
        expect(word.endMs).toBeLessThanOrEqual(segment.endMs);
      }
    }
  });

  it('reports the detected language from the provider', async () => {
    expect((await canonicalise(SEGMENTS_WITH_WORDS)).language).toBe('en');
  });

  it('preserves non-ASCII text exactly', async () => {
    const payload = {
      language: 'ja',
      duration: 1,
      text: 'こんにちは、世界。',
      segments: [{ start: 0, end: 1, text: 'こんにちは、世界。', words: [] }],
    };
    const result = await canonicalise(payload, { granularity: 'segment' });
    expect(result.segments[0]?.text).toBe('こんにちは、世界。');
  });

  it('preserves punctuation the provider supplied', async () => {
    // No post-processing: wording is the provider's, not ours.
    const payload = {
      language: 'en',
      duration: 1,
      text: "It's fine — really.",
      segments: [{ start: 0, end: 1, text: "It's fine — really.", words: [] }],
    };
    expect((await canonicalise(payload, { granularity: 'segment' })).segments[0]?.text).toBe(
      "It's fine — really.",
    );
  });

  it('marks timings as measured, since the provider reported them', async () => {
    const result = await canonicalise(SEGMENTS_WITH_WORDS);
    expect(
      result.segments.flatMap((s) => s.words).every((w) => w.timingSource === 'measured'),
    ).toBe(true);
  });

  it('does not invent word timings when the provider returns none', async () => {
    // A segment-only result must not acquire words. Word timings would be fabrication, and
    // `wordTimingAvailable` is what the UI reads to tell the user why highlighting is absent.
    const payload = {
      language: 'en',
      duration: 1,
      text: 'Hello.',
      segments: [{ start: 0, end: 1, text: 'Hello.', words: [] }],
    };
    const result = await canonicalise(payload, { granularity: 'word' });
    expect(result.segments[0]?.words).toEqual([]);
    expect(result.wordTimingAvailable).toBe(false);
    expect(result.diagnostics.warnings.join(' ')).toMatch(/word-level timings/i);
  });

  it("maps the provider's `probability` onto canonical confidence", async () => {
    // The adapter renames `probability` → `confidence`, so the normalizer sees one vocabulary.
    const result = await canonicalise(SEGMENTS_WITH_WORDS);
    expect(result.segments[0]?.words[0]?.confidence).toBeCloseTo(0.99);
  });

  it('keeps confidence absent when the provider omits it', async () => {
    // A provider that reports no confidence has told us nothing. Recording 0 would assert the
    // model was maximally unsure — a different, and false, claim.
    const payload = {
      language: 'en',
      duration: 1,
      text: 'Hello.',
      segments: [
        { start: 0, end: 1, text: 'Hello.', words: [{ word: 'Hello', start: 0, end: 1 }] },
      ],
    };
    const result = await canonicalise(payload);
    expect(result.segments[0]?.words[0]).not.toHaveProperty('confidence');
    // Absent must stay absent through a real serialization round trip, not become null or 0.
    const roundTripped = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(roundTripped.segments[0]?.words[0]).not.toHaveProperty('confidence');
  });

  it('keeps a genuine zero confidence as zero, distinct from absent', async () => {
    const payload = {
      language: 'en',
      duration: 1,
      text: 'Hello.',
      segments: [
        {
          start: 0,
          end: 1,
          text: 'Hello.',
          words: [{ word: 'Hello', start: 0, end: 1, probability: 0 }],
        },
      ],
    };
    const result = await canonicalise(payload);
    expect(result.segments[0]?.words[0]?.confidence).toBe(0);
  });

  it('returns no segments for an empty transcript', async () => {
    // Silence is not an error: OpenAI returns a valid response with no segments.
    const payload = { language: 'en', duration: 1, text: '', segments: [] };
    const transcript = await provider(stubFetch(payload)).transcribe({
      audio: new Uint8Array([1]),
      filename: 'audio.wav',
      assetId: ASSET,
      granularity: 'segment',
    });
    expect(transcript.segments).toEqual([]);
  });
});

describe('provider contract — error mapping', () => {
  const cases: ReadonlyArray<readonly [number, TranscriptionErrorCodeValue]> = [
    [401, TranscriptionErrorCode.Authentication],
    [403, TranscriptionErrorCode.Authentication],
    [429, TranscriptionErrorCode.RateLimited],
    [400, TranscriptionErrorCode.InvalidRequest],
    [500, TranscriptionErrorCode.Unavailable],
    [503, TranscriptionErrorCode.Unavailable],
  ];

  for (const [status, expected] of cases) {
    it(`maps HTTP ${status} to ${expected}`, async () => {
      const p = provider(stubFetch({}, { status, body: '{"error":"nope"}' }));
      await expect(
        p.transcribe({
          audio: new Uint8Array([1]),
          filename: 'audio.wav',
          assetId: ASSET,
          granularity: 'segment',
        }),
      ).rejects.toMatchObject({ code: expected });
    });
  }

  it('rejects empty audio before making a request', async () => {
    const calls: number[] = [];
    const p = provider(async () => {
      calls.push(1);
      return jsonResponse({});
    });
    await expect(
      p.transcribe({
        audio: new Uint8Array([]),
        filename: 'audio.wav',
        assetId: ASSET,
        granularity: 'segment',
      }),
    ).rejects.toBeInstanceOf(TranscriptionError);
    // Validating first means the user learns immediately rather than after an upload.
    expect(calls).toHaveLength(0);
  });

  it('rejects audio above the provider size limit before sending', async () => {
    const calls: number[] = [];
    const p = provider(async () => {
      calls.push(1);
      return jsonResponse({});
    });
    const huge = new Uint8Array(26 * 1024 * 1024);
    await expect(
      p.transcribe({ audio: huge, filename: 'audio.wav', assetId: ASSET, granularity: 'segment' }),
    ).rejects.toMatchObject({ code: TranscriptionErrorCode.UnsupportedAudio });
    expect(calls).toHaveLength(0);
  });

  it('rejects a non-JSON response as malformed', async () => {
    const p = provider(stubFetch(null, { body: '<html>gateway</html>' }));
    await expect(
      p.transcribe({
        audio: new Uint8Array([1]),
        filename: 'audio.wav',
        assetId: ASSET,
        granularity: 'segment',
      }),
    ).rejects.toMatchObject({ code: TranscriptionErrorCode.MalformedResponse });
  });

  it('surfaces a transport failure as unavailable, not as a crash', async () => {
    const p = provider(failingFetch(new TypeError('fetch failed')));
    await expect(
      p.transcribe({
        audio: new Uint8Array([1]),
        filename: 'audio.wav',
        assetId: ASSET,
        granularity: 'segment',
      }),
    ).rejects.toMatchObject({ code: TranscriptionErrorCode.Unavailable });
  });

  it('marks only transient failures retryable', async () => {
    // A failed job is terminal this phase; retryability only shapes the message. It must not
    // mean "retry forever".
    const notRetryable = new TranscriptionError(TranscriptionErrorCode.Authentication, 'x');
    const retryable = new TranscriptionError(TranscriptionErrorCode.RateLimited, 'x');
    expect(notRetryable.retryable).toBe(false);
    expect(retryable.retryable).toBe(true);
  });
});

describe('provider contract — capability declaration', () => {
  it('declares word timing for a timestamp-capable model', async () => {
    const p = provider(stubFetch({}), 'whisper-1');
    expect(p.supportsWordTiming).toBe(true);
  });

  it('declares no word timing for a model that cannot produce them', () => {
    // `gpt-transcribe` returns text and language but no timestamps. Advertising the capability
    // would make the UI promise word highlighting the result cannot support.
    expect(provider(stubFetch({}), 'gpt-transcribe').supportsWordTiming).toBe(false);
  });

  it('never puts the API key in a user-facing error', async () => {
    const p = provider(
      stubFetch({}, { status: 401, body: '{"error":{"message":"bad key sk-live-ABC123"}}' }),
    );
    try {
      await p.transcribe({
        audio: new Uint8Array([1]),
        filename: 'audio.wav',
        assetId: ASSET,
        granularity: 'segment',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TranscriptionError);
      const message = (error as TranscriptionError).message;
      expect(message).not.toContain('test-key-not-real');
      expect(message).not.toContain('sk-live-ABC123');
      // The user-facing projection must be free of the provider's raw payload too.
      expect(JSON.stringify((error as TranscriptionError).toJSON())).not.toContain(
        'sk-live-ABC123',
      );
    }
  });
});
