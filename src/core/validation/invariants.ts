/**
 * Semantic invariant validation.
 *
 * Zod checks shape. This module checks the cross-field rules that make a document
 * *coherent* — the ones a schema cannot express without contortion. The full list is
 * ARCHITECTURE_REVIEW.md §5.1; each violation below names the invariant it enforces.
 *
 * Design rule: **report, do not silently fix.** A document that overlaps its own segments
 * is a real condition the editor must survive and surface, not something to quietly
 * correct on load. Silent correction loses user data and hides bugs.
 */

import type { ProjectDocument } from '../document/types.js';

export interface InvariantViolation {
  /** The invariant identifier, e.g. "I-3". */
  invariant: string;
  /** Human-readable explanation naming the problem and its location. */
  message: string;
  /** Dotted path to the offending value, when one can be identified. */
  path?: string;
}

export interface InvariantReport {
  valid: boolean;
  violations: InvariantViolation[];
}

function violation(invariant: string, message: string, path?: string): InvariantViolation {
  return path === undefined ? { invariant, message } : { invariant, message, path };
}

/**
 * Check every semantic invariant the document model declares.
 *
 * Returns a report rather than throwing, so a caller can surface every problem at once
 * instead of making the user fix them one reload at a time.
 */
export function validateInvariants(doc: ProjectDocument): InvariantReport {
  const violations: InvariantViolation[] = [];

  // ── I-3: segments sorted by startMs and non-overlapping within a track ──
  for (const [trackIndex, track] of doc.tracks.entries()) {
    for (let i = 1; i < track.segments.length; i += 1) {
      const previous = track.segments[i - 1];
      const current = track.segments[i];
      if (previous === undefined || current === undefined) {
        continue;
      }
      if (current.startMs < previous.startMs) {
        violations.push(
          violation(
            'I-3',
            `Segments are not sorted by startMs: ${previous.id} (${previous.startMs}) comes before ${current.id} (${current.startMs})`,
            `tracks[${trackIndex}].segments[${i}]`,
          ),
        );
      }
      if (current.startMs < previous.endMs) {
        violations.push(
          violation(
            'I-3',
            `Segments overlap: ${previous.id} ends at ${previous.endMs} but ${current.id} starts at ${current.startMs}`,
            `tracks[${trackIndex}].segments[${i}]`,
          ),
        );
      }
    }

    for (const [segmentIndex, segment] of track.segments.entries()) {
      const segmentPath = `tracks[${trackIndex}].segments[${segmentIndex}]`;

      // ── I-2: endMs > startMs on every segment and word ──
      if (segment.endMs <= segment.startMs) {
        violations.push(
          violation(
            'I-2',
            `Segment "${segment.id}" has endMs (${segment.endMs}) <= startMs (${segment.startMs})`,
            segmentPath,
          ),
        );
      }

      // Words must satisfy the same rule, and must fit inside their segment.
      for (const [wordIndex, word] of segment.words.entries()) {
        const wordPath = `${segmentPath}.words[${wordIndex}]`;
        if (word.endMs <= word.startMs) {
          violations.push(
            violation(
              'I-2',
              `Word "${word.id}" in segment "${segment.id}" has endMs (${word.endMs}) <= startMs (${word.startMs})`,
              wordPath,
            ),
          );
        }
        if (word.startMs < segment.startMs || word.endMs > segment.endMs) {
          violations.push(
            violation(
              'I-3',
              `Word "${word.id}" (${word.startMs}–${word.endMs}) falls outside its segment "${segment.id}" (${segment.startMs}–${segment.endMs})`,
              wordPath,
            ),
          );
        }
      }

      // ── I-8: text is a cache of the words; drift is reported, not repaired ──
      const derived = segment.words.map((word) => word.text).join('');
      if (derived !== segment.text) {
        violations.push(
          violation(
            'I-8',
            `Segment "${segment.id}" text does not match its words. Expected ${JSON.stringify(derived)}, found ${JSON.stringify(segment.text)}. The text cache is stale — re-derive it or fix the words.`,
            segmentPath,
          ),
        );
      }

      // ── I-14: styleId and styleOverride are mutually exclusive ──
      if (segment.styleId !== undefined && segment.styleOverride !== undefined) {
        violations.push(
          violation(
            'I-14',
            `Segment "${segment.id}" sets both styleId and styleOverride. These are mutually exclusive: styleId replaces the inherited style, styleOverride merges onto it.`,
            segmentPath,
          ),
        );
      }

      // lineBreaks index words, so an index past the end is a modelling error.
      if (segment.lineBreaks !== undefined) {
        for (const index of segment.lineBreaks) {
          if (index > segment.words.length) {
            violations.push(
              violation(
                'I-8',
                `Segment "${segment.id}" has a line break at word index ${index}, but the segment has only ${segment.words.length} words`,
                segmentPath,
              ),
            );
          }
        }
      }
    }
  }

  // ── I-4: every style and animation reference resolves ──
  const styleIds = new Set(Object.keys(doc.styles));
  const animationIds = new Set(Object.keys(doc.animations));

  for (const [trackIndex, track] of doc.tracks.entries()) {
    if (track.styleId !== undefined && !styleIds.has(track.styleId)) {
      violations.push(
        violation(
          'I-4',
          `Track "${track.id}" references unknown style "${track.styleId}"`,
          `tracks[${trackIndex}].styleId`,
        ),
      );
    }
    if (track.animationId !== undefined && !animationIds.has(track.animationId)) {
      violations.push(
        violation(
          'I-4',
          `Track "${track.id}" references unknown animation "${track.animationId}"`,
          `tracks[${trackIndex}].animationId`,
        ),
      );
    }
    for (const [segmentIndex, segment] of track.segments.entries()) {
      const segmentPath = `tracks[${trackIndex}].segments[${segmentIndex}]`;
      if (segment.styleId !== undefined && !styleIds.has(segment.styleId)) {
        violations.push(
          violation(
            'I-4',
            `Segment "${segment.id}" references unknown style "${segment.styleId}"`,
            `${segmentPath}.styleId`,
          ),
        );
      }
      if (segment.animationId !== undefined && !animationIds.has(segment.animationId)) {
        violations.push(
          violation(
            'I-4',
            `Segment "${segment.id}" references unknown animation "${segment.animationId}"`,
            `${segmentPath}.animationId`,
          ),
        );
      }
      for (const [wordIndex, word] of segment.words.entries()) {
        if (word.animationId !== undefined && !animationIds.has(word.animationId)) {
          violations.push(
            violation(
              'I-4',
              `Word "${word.id}" references unknown animation "${word.animationId}"`,
              `${segmentPath}.words[${wordIndex}].animationId`,
            ),
          );
        }
      }
    }
  }

  // ── I-5: IDs are unique across the whole document ──
  const seen = new Map<string, string>();
  const claim = (id: string, where: string): void => {
    const existing = seen.get(id);
    if (existing !== undefined) {
      violations.push(
        violation('I-5', `Duplicate id "${id}" used by both ${existing} and ${where}`, where),
      );
    } else {
      seen.set(id, where);
    }
  };

  for (const [assetIndex, asset] of doc.assets.entries()) {
    claim(asset.id, `assets[${assetIndex}]`);
  }
  for (const styleId of Object.keys(doc.styles)) {
    const style = doc.styles[styleId];
    if (style !== undefined && style.id !== styleId) {
      violations.push(
        violation(
          'I-5',
          `Style keyed as "${styleId}" declares id "${style.id}"`,
          `styles.${styleId}`,
        ),
      );
    }
  }
  for (const animationId of Object.keys(doc.animations)) {
    const animation = doc.animations[animationId];
    if (animation !== undefined && animation.id !== animationId) {
      violations.push(
        violation(
          'I-5',
          `Animation keyed as "${animationId}" declares id "${animation.id}"`,
          `animations.${animationId}`,
        ),
      );
    }
  }
  for (const [trackIndex, track] of doc.tracks.entries()) {
    claim(track.id, `tracks[${trackIndex}]`);
    for (const [segmentIndex, segment] of track.segments.entries()) {
      claim(segment.id, `tracks[${trackIndex}].segments[${segmentIndex}]`);
      for (const [wordIndex, word] of segment.words.entries()) {
        claim(word.id, `tracks[${trackIndex}].segments[${segmentIndex}].words[${wordIndex}]`);
      }
    }
  }

  return { valid: violations.length === 0, violations };
}
