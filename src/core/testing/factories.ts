/**
 * Document factories.
 *
 * Building a valid `ProjectDocument` by hand is verbose enough that test code would
 * otherwise drown in fixture noise and, worse, drift from the model. These factories
 * produce documents that satisfy every invariant by default, so a test states only the
 * one thing it is actually about.
 *
 * They live in `src/core` (not in `tests/`) because they are useful to any consumer
 * constructing a document — a migration test, a validator test, a future seeding tool.
 */

import {
  newProjectId,
  newStyleId,
  newTrackId,
  newSegmentId,
  newWordId,
  type AnimationId,
  type StyleId,
} from '../document/ids.js';
import {
  SCHEMA_VERSION,
  type ProjectDocument,
  type Style,
  type SubtitleSegment,
  type SubtitleWord,
} from '../document/types.js';

/** A fixed timestamp, so factory output is deterministic across runs. */
const FIXED_TIMESTAMP = '2026-01-01T00:00:00.000Z';

export function makeStyle(overrides: Partial<Style> = {}): Style {
  const id = overrides.id ?? newStyleId();
  return {
    id,
    name: overrides.name ?? `Style ${id}`,
    fontFamily: 'Inter',
    fontSizePx: 48,
    fontWeight: 700,
    fontStyle: 'normal',
    fill: '#FFFFFF',
    align: 'center',
    lineHeight: 1.2,
    ...overrides,
  };
}

export function makeWord(text: string, startMs: number, endMs: number): SubtitleWord {
  return {
    id: newWordId(),
    text,
    startMs,
    endMs,
    timingSource: 'measured',
  };
}

/**
 * A segment whose cached `text` is derived from its words, so it satisfies I-8 by
 * construction. Pass `text` only when a test is specifically about text-cache drift.
 */
export function makeSegment(
  words: SubtitleWord[],
  overrides: Partial<SubtitleSegment> = {},
): SubtitleSegment {
  const startMs = overrides.startMs ?? words[0]?.startMs ?? 0;
  const endMs = overrides.endMs ?? words.at(-1)?.endMs ?? startMs + 1;
  return {
    id: overrides.id ?? newSegmentId(),
    text: words.map((word) => word.text).join(''),
    startMs,
    endMs,
    words,
    origin: 'asr',
    ...overrides,
  };
}

/** An empty, valid project. */
export function makeDocument(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  const defaultStyleId = newStyleId();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: overrides.id ?? newProjectId(),
    name: 'Test Project',
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    canvas: { width: 1920, height: 1080 },
    assets: [],
    tracks: [],
    styles: { [defaultStyleId]: makeStyle({ id: defaultStyleId, name: 'Default' }) },
    animations: {},
    ...overrides,
  };
}

/** A project with one track, optionally carrying segments. */
export function makeDocumentWithTrack(
  segments: SubtitleSegment[] = [],
  overrides: Partial<ProjectDocument> = {},
): ProjectDocument {
  const base = makeDocument(overrides);
  const trackStyleId = Object.keys(base.styles)[0] as StyleId;
  return {
    ...base,
    tracks: [
      {
        id: newTrackId(),
        name: 'Track 1',
        styleId: trackStyleId,
        visible: true,
        locked: false,
        segments,
      },
    ],
  };
}

/** Convenience: a two-word segment spanning `startMs`–`endMs`. */
export function makeSimpleSegment(
  startMs: number,
  endMs: number,
  text = 'hello world',
): SubtitleSegment {
  const words = text.split(' ').map((word, index, all) => {
    const span = (endMs - startMs) / all.length;
    const wordStart = startMs + Math.round(span * index);
    const wordEnd = index === all.length - 1 ? endMs : startMs + Math.round(span * (index + 1));
    return makeWord(index === all.length - 1 ? word : `${word} `, wordStart, wordEnd);
  });
  return makeSegment(words, { startMs, endMs });
}

export type { AnimationId };
