/**
 * The canonical transcription model.
 *
 * This is the vocabulary the whole application shares. A provider adapter produces it, a pure
 * normalizer validates it, a job carries it, and a pure document operation consumes it.
 * **Nothing here is provider-shaped**: no `verbose_json`, no `segments[].no_speech_prob`, no
 * HTTP status codes. Adding a second provider must not change a single line of this file.
 *
 * ## Why this type exists separately from `ProjectDocument`
 *
 * Because a provider's answer is not yet the user's work. It is a *proposal* — it has not been
 * validated against the timing invariants, it has not been applied, and the user has not seen
 * it. Letting provider output become document state directly is what would let a malformed
 * response write an invalid project, and what would make "re-transcribe" indistinguishable
 * from destroying the user's manual work.
 *
 * So the flow is strictly: provider → {@link CanonicalTranscription} → normalizer → operation
 * → document. The document writer is the only thing permitted to touch tracks and segments.
 */

import type { AssetId } from '../document/ids.js';

/**
 * How a provider wants granularity.
 *
 * Deliberately a *request*, not a promise. `word` asks for word timings; a provider that
 * cannot supply them returns segment-only data, and the canonical result then carries
 * `wordTimingAvailable: false`. Nothing here pretends a capability the provider lacks.
 */
export type TranscriptGranularity = 'segment' | 'word';

/**
 * Where a set of timings came from.
 *
 * Mirrors the document's `SubtitleWord.timingSource` so the distinction survives all the way
 * into persisted state. `synthesized` timings are never presented as `measured` — a heuristic
 * distribution across a segment is useful for animation, but presenting it as measured would
 * put a fabricated precision in front of the user (invariants I-10, I-11).
 */
export type TimingSource = 'measured' | 'synthesized';

/** A word with its timing. `confidence` is absent when the provider supplied none. */
export interface CanonicalWord {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  /**
   * 0..1, **absent when unavailable**.
   *
   * Absent is not the same as 0. A provider that reports no confidence has told us nothing;
   * recording 0 would assert the model was maximally unsure, which is a different and false
   * claim. TypeScript's optional property is what keeps the two distinguishable through
   * `JSON.stringify` and back (invariant I-10).
   */
  readonly confidence?: number;
  readonly timingSource: TimingSource;
}

export interface CanonicalSegment {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly words: readonly CanonicalWord[];
  /** Absent when the provider supplied no segment-level confidence. */
  readonly confidence?: number;
}

/**
 * Diagnostics that are useful but not part of the transcript.
 *
 * Kept as a flat, provider-neutral bag of already-normalised values. The raw provider response
 * is deliberately **not** retained: it is large, it contains provider-specific fields that
 * would become a de-facto part of the document schema, and nothing currently reads it.
 */
export interface TranscriptionDiagnostics {
  /** Model name as reported by the provider, for provenance and for a future bake-off. */
  readonly model?: string;
  /** Source duration the provider claimed, in integer ms, when it reports one. */
  readonly sourceDurationMs?: number;
  /**
   * Facts worth surfacing to the user about *this particular result*, e.g. a provider that
   * declined to detect a language. Not a quality score — this phase makes no judgement about
   * how good a transcript is.
   */
  readonly warnings: readonly string[];
}

export interface CanonicalTranscription {
  /** Provider identity, e.g. `openai`. Stable across model changes. */
  readonly providerId: string;
  /**
   * BCP-47-ish language code, e.g. `en`, `fr`, `zh-cn`.
   *
   * Absent when the provider could not detect one. Never inferred from anything other than
   * the provider's own answer — inferring a language from the user's locale or IP would be a
   * guess presented as metadata.
   */
  readonly language?: string;
  /** The full transcript. Provider-supplied; this phase never rewrites wording. */
  readonly text: string;
  readonly segments: readonly CanonicalSegment[];
  /** Whether any word timings are present at all. Lets the UI explain rather than guess. */
  readonly wordTimingAvailable: boolean;
  /** The audio asset this transcript came from, for provenance. */
  readonly sourceAssetId: AssetId;
  readonly diagnostics: TranscriptionDiagnostics;
}

/**
 * The provider contract.
 *
 * An interface in application terms: "transcribe this audio, tell me what was said and when".
 * No vendor vocabulary, no SDK objects, no HTTP.
 *
 * `transcribe` receives the audio as **bytes**, not as a path. That is what lets a future local
 * provider (Whisper on disk) and a hosted one (an HTTP upload) share the same interface: the
 * path is infrastructure, and infrastructure does not belong in this signature.
 */
export interface TranscriptionProvider {
  /** Stable identifier used in provenance and in error mapping. */
  readonly id: string;
  /**
   * Whether this provider can return word-level timings.
   *
   * Declared up front so the UI can explain a limitation *before* running a job, rather than
   * discovering it from the result.
   */
  readonly supportsWordTiming: boolean;
  /**
   * Produce a provider transcript.
   *
   * Deliberately returns {@link ProviderTranscript} rather than `CanonicalTranscription`: an
   * adapter has not validated anything yet, and claiming otherwise would hide the one step that
   * guarantees the document invariants hold.
   */
  transcribe(input: TranscriptionRequest): Promise<ProviderTranscript>;
}

/**
 * What a provider adapter returns: its own payload, structurally validated but **not** yet
 * canonical.
 *
 * This intermediate type is the honest one. An adapter returning `CanonicalTranscription`
 * would be claiming to have produced validated, integer-millisecond, invariant-satisfying
 * output — which is the normalizer's job, not its own. Keeping the two steps separate means the
 * expensive-to-get-wrong validation lives in one pure, fully-tested place no matter how many
 * providers exist.
 */
export interface ProviderTranscript {
  readonly providerId: string;
  readonly model?: string;
  /**
   * BCP-47-ish language code, e.g. `en`, `fr`. The provider's own detection only — never
   * inferred from a locale, an IP, or a filename.
   */
  readonly language?: string;
  readonly text: string;
  /** Vendor-shaped segments. The normalizer owns their meaning. */
  readonly segments: readonly unknown[];
  /** Duration the provider reported for the audio, in integer ms. */
  readonly sourceDurationMs?: number;
  /** Facts worth surfacing about this particular result. */
  readonly warnings: readonly string[];
}

export interface TranscriptionRequest {
  readonly audio: Uint8Array;
  /** Filename hint for the upload; carries extension only, never a filesystem path. */
  readonly filename: string;
  /** Which asset these bytes came from, for provenance. */
  readonly assetId: AssetId;
  /** Hint from the user, if any. Absence means "let the provider decide". */
  readonly languageHint?: string;
  readonly granularity: TranscriptGranularity;
  readonly signal?: AbortSignal;
}
