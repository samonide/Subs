/**
 * Stable identifier generation.
 *
 * IDs are the backbone of the document model: styles attach to segments by ID, selection
 * survives edits because it references IDs, and undo diffs are keyed on them. They must
 * therefore be **unique, stable, and serializable**.
 *
 * Strategy: a monotonic counter combined with a per-process random prefix. The prefix
 * makes IDs from two different documents (or two browser tabs) collision-free without
 * coordination; the counter makes IDs within a process cheap and, crucially, makes
 * **ID creation order observable** — which is what lets tests assert that a generated ID
 * was not derived from content.
 *
 * Deliberately NOT used: database sequences, UUIDs from a library, or content-derived
 * hashes. The first is unavailable (there is no database) and couples identity to
 * infrastructure; the second is a dependency for a need we do not have; the third is
 * banned outright by invariant I-5, because an ID derived from content changes when the
 * content is edited — which would silently break every reference to it.
 *
 * Safe in both browser and worker contexts: uses `crypto.getRandomValues` when available
 * and never touches Node- or DOM-specific APIs beyond that single global.
 */

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_RANDOM_LENGTH = 8;
const ID_SEPARATOR = '_';

/** Per-process prefix, generated once. Distinguishes IDs across documents and tabs. */
const PROCESS_PREFIX: string = (() => {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto === undefined || typeof globalCrypto.getRandomValues !== 'function') {
    // A random-looking fallback. The counter still guarantees within-process uniqueness.
    return 'fallback';
  }
  const bytes = new Uint8Array(ID_RANDOM_LENGTH);
  globalCrypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
})();

let counter = 0;

/**
 * Generate a new unique ID.
 *
 * Shape: `<prefix>_<counter><random>`. The counter is what guarantees uniqueness; the
 * trailing random component makes IDs from separate processes unlikely to collide.
 */
function generateId(): string {
  counter += 1;

  const globalCrypto = globalThis.crypto;
  let random = '';
  if (globalCrypto !== undefined && typeof globalCrypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(4);
    globalCrypto.getRandomValues(bytes);
    random = Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
  }

  return `${PROCESS_PREFIX}${ID_SEPARATOR}${counter}${random}`;
}

export type ProjectId = string;
export type AssetId = string;
export type TrackId = string;
export type SegmentId = string;
export type WordId = string;
export type StyleId = string;
export type AnimationId = string;

export const newProjectId = (): ProjectId => generateId();
export const newAssetId = (): AssetId => generateId();
export const newTrackId = (): TrackId => generateId();
export const newSegmentId = (): SegmentId => generateId();
export const newWordId = (): WordId => generateId();
export const newStyleId = (): StyleId => generateId();
export const newAnimationId = (): AnimationId => generateId();

/** Test-only: reset the counter so ID generation is reproducible within a test file. */
export function __resetIdCounterForTests(): void {
  counter = 0;
}

/** Test-only: the process prefix, for asserting the shared shape of generated IDs. */
export function __processPrefixForTests(): string {
  return PROCESS_PREFIX;
}
