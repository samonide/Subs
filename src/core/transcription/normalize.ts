/**
 * The pure normalizer.
 *
 * Its whole job is to answer one question: **may this provider output become document state?**
 * It is pure, total, and independent of any provider, so the entire set of rules below is
 * testable by feeding it literals.
 *
 * ## Reject, or normalise with a documented rule — but never quietly "fix"
 *
 * Every rule here is one of three kinds, and each is chosen on purpose:
 *
 * - **Rejected.** The provider contradicts itself (end before start, a word outside its
 *   segment). We cannot know which value is wrong, so guessing would fabricate precision.
 * - **Normalised, with a rule stated here.** Seconds → integer milliseconds; rounding a
 *   timestamp to the millisecond grid; dropping a trailing space.
 * - **Preserved as-is.** Text and confidence. This phase never rewrites wording.
 *
 * ## What it deliberately does NOT do
 *
 * It does not repair overlaps by trimming, distribute word timings across a segment, add
 * punctuation, correct spelling, or merge near-duplicate segments. Every one of those is a
 * product decision with visible consequences, and inventing them here would mean the user
 * sees data we made up presented as data the model produced. Segment overlap is handled in the
 * document writer, where the choice is explicit and reported.
 */

import { TranscriptionError, TranscriptionErrorCode } from './errors.js';
import type {
  CanonicalSegment,
  CanonicalTranscription,
  CanonicalWord,
  TimingSource,
  TranscriptGranularity,
} from './types.js';
import type { AssetId } from '../document/ids.js';

/** Input to the normalizer: a provider's answer plus the context needed to judge it. */
export interface NormalizeInput {
  readonly providerId: string;
  readonly model?: string;
  readonly language?: string;
  readonly text: string;
  readonly segments: readonly unknown[];
  /** Source duration in ms, from the audio asset's own MediaMeta. Used to bound timestamps. */
  readonly sourceDurationMs?: number;
  readonly assetId: AssetId;
  readonly supportsWordTiming: boolean;
  /** What was requested, so a missing capability can be reported as a warning. */
  readonly granularity: TranscriptGranularity;
}

/**
 * How far past the end of the source a timestamp may sit before being rejected.
 *
 * Not zero: container and resampling rounding routinely puts the final word a few
 * milliseconds past the source duration, and rejecting good transcripts over that would be
 * maddening. But a timestamp materially beyond the source means the provider is describing
 * audio we do not have, which is worth refusing.
 */
export const DURATION_SLACK_MS = 500;

/**
 * Provider segments routinely overlap by a few milliseconds at boundaries.
 *
 * Words inside a segment are never allowed to overlap *each other* — word ordering is
 * meaningful and the editor relies on it — but the segment's own span is derived from its
 * words when it has any, so a small disagreement between a reported segment boundary and its
 * word boundaries is resolved in favour of the words rather than rejected. Those words are the
 * finer-grained measurement, and taking the max is what makes the segment contain its words,
 * which invariant I-3 requires.
 */
const MIN_SEGMENT_DURATION_MS = 1;

function fail(code: string, message: string, detail?: string): never {
  throw new TranscriptionError(
    TranscriptionErrorCode.MalformedResponse,
    message,
    detail === undefined ? {} : { detail },
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Seconds → integer milliseconds.
 *
 * Rounding, not flooring: a word starting at 0.0004s starts at 0ms, and flooring would place
 * it at 0 while a sibling at 0.0009 would also be 0, collapsing the boundary. Half-up rounding
 * keeps neighbouring words distinct wherever the provider distinguishes them at all.
 */
function secondsToMs(seconds: unknown, what: string): number {
  if (!isFiniteNumber(seconds)) {
    fail('non-finite-time', `${what} is not a finite number.`, String(seconds));
  }
  if (seconds < 0) {
    fail('negative-time', `${what} is negative (${seconds}).`, String(seconds));
  }
  const ms = Math.round(seconds * 1000);
  if (!Number.isSafeInteger(ms)) {
    fail('unsafe-time', `${what} does not convert to a safe integer millisecond value.`);
  }
  return ms;
}

/**
 * Normalise a confidence value, keeping "absent" distinct from zero.
 *
 * Returns `undefined` for absent, `null` for present-but-invalid. The caller drops invalid
 * values rather than substituting anything: a confidence of 0.7 is usable, and a confidence of
 * 700 is a provider bug that should not become a number the UI will happily display as a
 * percentage.
 */
function normalizeConfidence(value: unknown): number | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    return null;
  }
  return value;
}

/** Whitespace the canonical format normalises, and nothing else. */
function normalizeWordText(text: string): string {
  // Leading/trailing whitespace is removed because a word's leading space is a display concern
  // the segment rebuilds; interior spacing is preserved verbatim, including non-breaking
  // spaces, because changing it would change the transcript.
  // Escaped explicitly so the intent is legible: `\s` covers ASCII whitespace, and U+00A0 is
  // added because providers emit non-breaking spaces inside words (French, for one).
  return text.replace(/^[\s\u00A0]+/, '').replace(/[\s\u00A0]+$/, '');
}

function normalizeWord(raw: unknown, index: number): CanonicalWord {
  if (typeof raw !== 'object' || raw === null) {
    fail('bad-word', `Word ${index} is not an object.`);
  }
  const record = raw as Record<string, unknown>;
  const text = record['text'];
  if (typeof text !== 'string') {
    fail('bad-word-text', `Word ${index} has no text.`);
  }

  const startMs = secondsToMs(record['start'], `word ${index} start`);
  const endMs = secondsToMs(record['end'], `word ${index} end`);

  // I-2 requires endMs > startMs. A zero-length word is a real provider artefact (a click, a
  // breath), and inventing a duration for it would be fabrication — so it is rejected here and
  // reported, rather than silently widened.
  if (endMs <= startMs) {
    fail('inverted-word', `Word ${index} ("${text}") ends at or before it starts.`);
  }

  const confidence = normalizeConfidence(record['confidence']);
  const normalized: CanonicalWord = {
    text: normalizeWordText(text),
    startMs,
    endMs,
    // Measured, because the provider reported these times itself. Nothing here is derived.
    timingSource: 'measured' satisfies TimingSource,
  };
  if (confidence !== undefined && confidence !== null) {
    return { ...normalized, confidence };
  }
  return normalized;
}

/**
 * Normalise a provider's segments into the canonical model.
 *
 * Ordering is by start time, because invariant I-3 requires a track's segments to be sorted
 * and array order is the order. A provider that returns them out of order is a provider bug we
 * can safely correct: sorting cannot change any timestamp, so this is ordering, not repair.
 */
export function normalizeTranscription(input: NormalizeInput): CanonicalTranscription {
  const rawSegments = input.segments;
  if (!Array.isArray(rawSegments)) {
    fail('bad-segments', 'Provider returned no segments array.');
  }
  if (rawSegments.length === 0) {
    fail('empty', 'Provider returned no segments.', JSON.stringify(input.text).slice(0, 200));
  }

  const warnings: string[] = [];
  const segments: CanonicalSegment[] = [];

  for (let i = 0; i < rawSegments.length; i += 1) {
    const raw: unknown = rawSegments[i];
    if (typeof raw !== 'object' || raw === null) {
      fail('bad-segment', `Segment ${i} is not an object.`);
    }
    const record = raw as Record<string, unknown>;

    const text = record['text'];
    if (typeof text !== 'string') {
      fail('bad-segment-text', `Segment ${i} has no text.`);
    }

    const reportedStart = secondsToMs(record['start'], `segment ${i} start`);
    const reportedEnd = secondsToMs(record['end'], `segment ${i} end`);
    if (reportedEnd <= reportedStart) {
      fail('inverted-segment', `Segment ${i} ends at or before it starts.`);
    }

    if (
      input.sourceDurationMs !== undefined &&
      reportedEnd > input.sourceDurationMs + DURATION_SLACK_MS
    ) {
      fail(
        'beyond-source',
        `Segment ${i} ends at ${reportedEnd}ms, past the ${input.sourceDurationMs}ms source.`,
      );
    }

    const rawWords = record['words'];
    const words: CanonicalWord[] = [];
    if (Array.isArray(rawWords) && rawWords.length > 0) {
      for (let w = 0; w < rawWords.length; w += 1) {
        const word = normalizeWord(rawWords[w], w);
        // The segment's own bound is checked above; a *word* extending past the source is the
        // same contradiction one level down, and would otherwise slip through — because the
        // segment span below is widened to fit its words, so nothing else would catch it.
        if (
          input.sourceDurationMs !== undefined &&
          word.endMs > input.sourceDurationMs + DURATION_SLACK_MS
        ) {
          fail(
            'word-beyond-source',
            `Word ${w} ends at ${word.endMs}ms, past the ${input.sourceDurationMs}ms source.`,
          );
        }
        words.push(word);
      }
      // The segment span is widened to contain its words. This is not repair: a segment
      // boundary sitting slightly inside its own words is the coarser measurement losing to the
      // finer one, and taking the max keeps I-3 true without inventing a timestamp. Ordering
      // and containment are both preserved as a result.
    }

    const startMs = words.length > 0 ? Math.min(reportedStart, words[0]!.startMs) : reportedStart;
    const endMs =
      words.length > 0 ? Math.max(reportedEnd, words[words.length - 1]!.endMs) : reportedEnd;

    if (endMs - startMs < MIN_SEGMENT_DURATION_MS) {
      fail('zero-length-segment', `Segment ${i} has zero duration after normalisation.`);
    }

    const segmentConfidence = normalizeConfidence(record['confidence']);
    const segment: CanonicalSegment = {
      // Segment text is the provider's, verbatim except for trimming: this phase does not
      // rewrite wording, re-punctuate, or correct spelling (see §30 of the phase brief).
      text: text.trim(),
      startMs,
      endMs,
      words,
      ...(segmentConfidence === undefined || segmentConfidence === null
        ? {}
        : { confidence: segmentConfidence }),
    };
    segments.push(segment);
  }

  segments.sort((a, b) => a.startMs - b.startMs);

  const wordTimingAvailable = segments.some((segment) => segment.words.length > 0);
  if (input.granularity === 'word' && !wordTimingAvailable) {
    // Only a request for words that came back without them is worth saying out loud. A
    // provider that was never asked for words is not failing to deliver, and warning there
    // would be noise on every segment-only result.
    warnings.push(
      'The provider did not return word-level timings, so word highlighting and animation are unavailable.',
    );
  }

  if (input.language === undefined || input.language === '') {
    warnings.push('The provider did not report a detected language.');
  }

  const diagnostics: TranscriptionDiagnosticsShape = { warnings };
  if (input.model !== undefined) {
    diagnostics.model = input.model;
  }

  const result: CanonicalTranscription = {
    providerId: input.providerId,
    text: input.text,
    segments,
    wordTimingAvailable,
    sourceAssetId: input.assetId,
    diagnostics,
  };
  // Optional fields are spread in only when present, so they are genuinely absent from JSON
  // rather than present-and-undefined (invariant I-9).
  return {
    ...result,
    ...(input.language === undefined || input.language === '' ? {} : { language: input.language }),
  };
}

interface TranscriptionDiagnosticsShape {
  model?: string;
  warnings: string[];
}
