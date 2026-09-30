/**
 * The OpenAI transcription adapter.
 *
 * **This is the only file that knows what an OpenAI response looks like.** It converts vendor
 * JSON into a {@link ProviderTranscript}; nothing above it ever sees `verbose_json`,
 * `segments[].no_speech_prob`, or a provider status code.
 *
 * ## Why `whisper-1` and not the recommended `gpt-transcribe`
 *
 * This looks backwards, so the reasoning is worth stating. OpenAI's own guide recommends
 * `gpt-transcribe` for ordinary file transcription — and then says its `timestamp_granularities`
 * parameter "is only supported for `whisper-1`". Without timestamps a subtitle application has
 * no subtitle application, because the entire product is captions synchronised to picture.
 *
 * So the first provider uses `whisper-1` for its timing, and the adapter is written so that
 * adding a timestamp-capable successor is a one-line configuration change rather than a rewrite.
 * `supportsWordTiming` is declared rather than inferred, so a provider without timestamps
 * advertises the limitation before a job runs instead of after.
 *
 * ## Transport
 *
 * Plain `fetch` with a hand-built multipart body, not the vendor SDK. Two reasons: the adapter
 * is the security boundary, and a 200-line file that constructs one request is far easier to
 * audit than an SDK whose behaviour is defined by a transitive dependency tree. The cost is
 * ~40 lines of multipart encoding.
 *
 * ## Credentials
 *
 * Read from the environment by `loadProviderConfig` and never stored, logged, echoed into an
 * error, or placed in `ProjectDocument`. A `TranscriptionError` carries a user-facing message and
 * an optional server-side `detail`; `detail` never reaches the browser.
 */

import {
  TranscriptionError,
  TranscriptionErrorCode,
  type ProviderTranscript,
  type TranscriptionProvider,
  type TranscriptionRequest,
} from '../../core/transcription/index.js';

export const OPENAI_PROVIDER_ID = 'openai';
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
/** OpenAI's documented upload limit. Checked before sending so the user learns immediately. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface OpenAIProviderConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly endpoint: string;
  readonly timeoutMs: number;
}

/**
 * Build the provider config from the environment.
 *
 * Returns `undefined` rather than throwing when unconfigured, because "no API key on this
 * machine" is a normal state during development and in CI — it should surface as a clear
 * `NotConfigured` error at the point of use, not as a crash at startup that stops the server
 * from serving anything at all.
 */
export function loadProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpenAIProviderConfig | undefined {
  const apiKey = env['OPENAI_API_KEY'];
  if (apiKey === undefined || apiKey.trim() === '') {
    return undefined;
  }
  return {
    apiKey,
    model: env['OPENAI_TRANSCRIBE_MODEL'] ?? 'whisper-1',
    endpoint: env['OPENAI_TRANSCRIBE_ENDPOINT'] ?? DEFAULT_ENDPOINT,
    // A 60-second clip transcribes in a few seconds; this is generous enough for a long one
    // while still bounding a job that would otherwise hang until the job timeout.
    timeoutMs: Number.parseInt(env['OPENAI_TRANSCRIBE_TIMEOUT_MS'] ?? '', 10) || 120_000,
  };
}

/**
 * Build a multipart/form-data body.
 *
 * Built by hand rather than via `FormData` so the audio goes through as a single `Blob` without
 * an extra copy of the bytes — for a 25 MB upload, an avoidable duplicate is 25 MB of resident
 * memory for no reason. The boundary is generated once and used for every part.
 */
function multipartBody(
  audio: Uint8Array,
  fields: ReadonlyArray<readonly [string, string]>,
  boundary: string,
): ArrayBuffer {
  const encoder = new TextEncoder();
  const head: Uint8Array[] = [];
  for (const [name, value] of fields) {
    head.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  head.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
        'Content-Type: audio/wav\r\n\r\n',
    ),
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);

  const total =
    head.reduce((sum, part) => sum + part.byteLength, 0) + audio.byteLength + tail.byteLength;
  // Returns an ArrayBuffer, not a Uint8Array: `fetch`'s BodyInit is typed against ArrayBuffer.
  // The audio is copied into the assembled body exactly once — for a 25 MB upload that is 25 MB
  // of resident memory, not 50 MB.
  const buffer = new ArrayBuffer(total);
  const body = new Uint8Array(buffer);
  let offset = 0;
  for (const part of head) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  body.set(audio, offset);
  offset += audio.byteLength;
  body.set(tail, offset);
  return buffer;
}

/** Map an HTTP status onto a provider-neutral failure. */
function errorForStatus(status: number, body: string): TranscriptionError {
  const detail = `HTTP ${status}: ${body.slice(0, 400)}`;
  if (status === 401 || status === 403) {
    return new TranscriptionError(
      TranscriptionErrorCode.Authentication,
      'The transcription service rejected our credentials. Check the API key.',
      { detail },
    );
  }
  if (status === 429) {
    return new TranscriptionError(
      TranscriptionErrorCode.RateLimited,
      'The transcription service is rate limiting us. Try again shortly.',
      { detail },
    );
  }
  if (status === 400 || status === 422) {
    return new TranscriptionError(
      TranscriptionErrorCode.InvalidRequest,
      'The transcription service rejected the request.',
      { detail },
    );
  }
  if (status >= 500) {
    return new TranscriptionError(
      TranscriptionErrorCode.Unavailable,
      'The transcription service is unavailable right now.',
      { detail },
    );
  }
  return new TranscriptionError(
    TranscriptionErrorCode.MalformedResponse,
    `The transcription service returned an unexpected status (${status}).`,
    { detail },
  );
}

/** The vendor response shape, narrowed to only the fields we read. */
interface RawOpenAITranscription {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
  segments?: unknown;
  words?: unknown;
}

/**
 * A vendor word entry, in OpenAI's own field names.
 *
 * Note `word`, not `text`. This is precisely the detail an adapter exists to absorb: a fixture
 * written from memory said `text`, the real API says `word`, and only the recorded response
 * revealed it. Renaming here means the normalizer speaks one language and a second provider with
 * its own spelling costs nothing.
 */
interface RawOpenAIWord {
  word?: unknown;
  start?: unknown;
  end?: unknown;
  probability?: unknown;
}

/** Translate one vendor word into the shape the normalizer expects. */
function canonicalizeWord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) {
    // Passed through malformed on purpose, so the normalizer rejects it with a message naming
    // the word rather than the adapter silently dropping it.
    return { notAWord: raw };
  }
  const word = raw as RawOpenAIWord;
  return {
    text: word.word,
    start: word.start,
    end: word.end,
    // `probability` is OpenAI's word-level confidence. Renamed, not dropped — and it stays
    // optional, so a provider that omits it yields an absent confidence, never a zero.
    ...(word.probability === undefined ? {} : { confidence: word.probability }),
  };
}

/** Translate a vendor segment, renaming its word list on the way through. */
function canonicalizeSegment(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) {
    return { notASegment: raw };
  }
  const segment = raw as Record<string, unknown>;
  const words = segment['words'];
  return {
    ...segment,
    ...(Array.isArray(words) ? { words: words.map(canonicalizeWord) } : {}),
  };
}

/**
 * The provider.
 *
 * `fetchImpl` is injected rather than used directly so tests can drive the adapter against
 * contract fixtures without a network, and so a future provider can share the harness.
 */
export class OpenAITranscriptionProvider implements TranscriptionProvider {
  readonly id = OPENAI_PROVIDER_ID;
  /** True for `whisper-1`; false for the `gpt-transcribe` family, which returns no timings. */
  readonly supportsWordTiming: boolean;

  constructor(
    private readonly config: OpenAIProviderConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    // Derived from the model rather than hard-coded, so configuring a non-timestamp model is a
    // config change and the UI is told the truth before a job runs.
    this.supportsWordTiming = config.model.startsWith('whisper');
  }

  async transcribe(request: TranscriptionRequest): Promise<ProviderTranscript> {
    if (request.audio.byteLength === 0) {
      throw new TranscriptionError(
        TranscriptionErrorCode.UnsupportedAudio,
        'The audio asset is empty.',
      );
    }
    if (request.audio.byteLength > MAX_UPLOAD_BYTES) {
      // Checked before sending: a 25 MB limit discovered as a server-side rejection is a worse
      // experience than learning it immediately.
      throw new TranscriptionError(
        TranscriptionErrorCode.UnsupportedAudio,
        'The audio is larger than the transcription service accepts (25 MB).',
      );
    }

    const boundary = `subs-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const fields: Array<readonly [string, string]> = [
      ['model', this.config.model],
      ['response_format', 'verbose_json'],
    ];
    // `timestamp_granularities` is only meaningful for models that produce timestamps, and
    // sending it to one that does not is an outright 400.
    if (this.supportsWordTiming) {
      fields.push([
        'timestamp_granularities[]',
        request.granularity === 'word' ? 'word' : 'segment',
      ]);
    }
    // `language` is a *hint*: omitting it lets the provider detect. It is never inferred from
    // anything but an explicit user choice.
    if (request.languageHint !== undefined && request.languageHint !== '') {
      fields.push(['language', request.languageHint]);
    }

    const body = multipartBody(request.audio, fields, boundary);

    // The caller's signal and our own timeout are combined, so cancelling a job and the
    // request outliving its budget both abort the fetch rather than leaking a connection.
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal =
      request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);

    let response: Response;
    try {
      response = await this.fetchImpl(this.config.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted === true) {
        throw new TranscriptionError(
          TranscriptionErrorCode.Cancelled,
          'Transcription was cancelled.',
          { cause: error },
        );
      }
      if (timeout.aborted) {
        throw new TranscriptionError(
          TranscriptionErrorCode.Timeout,
          'The transcription service did not respond in time.',
          { cause: error },
        );
      }
      throw new TranscriptionError(
        TranscriptionErrorCode.Unavailable,
        'Could not reach the transcription service.',
        { cause: error, detail: error instanceof Error ? error.message : undefined },
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw errorForStatus(response.status, text);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new TranscriptionError(
        TranscriptionErrorCode.MalformedResponse,
        'The transcription service returned a response that was not JSON.',
        { detail: text.slice(0, 400), cause: error },
      );
    }

    return this.toProviderTranscript(parsed);
  }

  /**
   * Convert a vendor payload into the intermediate provider transcript.
   *
   * Public and pure so the contract tests can feed it fixtures directly — the same reason
   * `toMediaMeta` is separable from `runFfprobe` in Phase 1.
   */
  toProviderTranscript(parsed: unknown): ProviderTranscript {
    if (typeof parsed !== 'object' || parsed === null) {
      throw new TranscriptionError(
        TranscriptionErrorCode.MalformedResponse,
        'The transcription service returned an unexpected response.',
      );
    }
    const raw = parsed as RawOpenAITranscription;

    // `verbose_json` returns `segments`. Some responses put words at the top level instead; both
    // shapes occur in the wild, so the fallback is handled rather than assumed away.
    //
    // Every vendor field name is translated here. `toProviderTranscript` is the only place that
    // knows OpenAI spells a word's text `word` and its confidence `probability`.
    const segments: readonly unknown[] | undefined = Array.isArray(raw.segments)
      ? raw.segments.map(canonicalizeSegment)
      : Array.isArray(raw.words)
        ? [
            canonicalizeSegment({
              text: raw.text,
              start: 0,
              end: raw.duration,
              words: raw.words,
            }),
          ]
        : undefined;

    if (segments === undefined) {
      throw new TranscriptionError(
        TranscriptionErrorCode.EmptyTranscript,
        'The transcription service returned no segments. The audio may contain no speech.',
      );
    }

    return {
      providerId: this.id,
      text: typeof raw.text === 'string' ? raw.text : '',
      segments,
      ...(this.config.model === undefined ? {} : { model: this.config.model }),
      ...(isFiniteNumber(raw.duration)
        ? { sourceDurationMs: Math.round(raw.duration * 1000) }
        : {}),
      warnings: [],
      // The provider's own detection only. Never inferred.
      ...(typeof raw.language === 'string' && raw.language !== ''
        ? { language: raw.language }
        : {}),
    };
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
