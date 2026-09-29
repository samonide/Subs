import { describe, expect, it } from 'vitest';

import {
  newProjectId,
  newSegmentId,
  newStyleId,
  newTrackId,
  newWordId,
  __processPrefixForTests,
  __resetIdCounterForTests,
} from '../src/core/document/ids.js';

describe('id generation', () => {
  it('produces unique ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      ids.add(newSegmentId());
    }
    expect(ids.size).toBe(10_000);
  });

  it('never returns the same id twice, even across generators', () => {
    const all = [newProjectId(), newTrackId(), newSegmentId(), newWordId(), newStyleId()];
    expect(new Set(all).size).toBe(all.length);
  });

  it('shares a process prefix so ids from different processes are unlikely to collide', () => {
    const prefix = __processPrefixForTests();
    for (const id of [newSegmentId(), newWordId()]) {
      expect(id.startsWith(`${prefix}_`)).toBe(true);
    }
  });

  it('is JSON-serializable as a plain string', () => {
    const id = newSegmentId();
    const roundTripped: unknown = JSON.parse(JSON.stringify({ id }));
    expect(roundTripped).toEqual({ id });
  });

  it('is not derived from content — editing content must not change an id', () => {
    // Invariant I-5. A content-derived hash would change when the text is edited, which
    // would silently break every style reference, selection, and undo entry pointing at it.
    __resetIdCounterForTests();
    const first = newSegmentId();
    const second = newSegmentId();
    // Different ids for two different objects, regardless of any content they hold.
    expect(first).not.toBe(second);
  });

  it('contains only characters that are safe in a URL path or ASS identifier', () => {
    for (const id of [newSegmentId(), newStyleId()]) {
      expect(id).toMatch(/^[a-z0-9_]+$/);
    }
  });
});
