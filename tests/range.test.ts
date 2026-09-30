import { describe, expect, it } from 'vitest';

import { contentRangeHeader, parseRange } from '../src/server/media/range.js';

const SIZE = 1000;

describe('range parsing — full responses', () => {
  it('serves the whole body when no Range header is present', () => {
    expect(parseRange(undefined, SIZE)).toEqual({ kind: 'full' });
  });

  it('ignores a Range unit it does not understand', () => {
    // RFC 9110: an unrecognised unit must be ignored, not rejected.
    expect(parseRange('items=0-99', SIZE)).toEqual({ kind: 'full' });
  });

  it('ignores a multi-range request rather than implementing multipart/byteranges', () => {
    // Legitimate to decline; no media player needs it.
    expect(parseRange('bytes=0-99,200-299', SIZE)).toEqual({ kind: 'full' });
  });
});

describe('range parsing — explicit ranges', () => {
  it('parses a bounded range', () => {
    expect(parseRange('bytes=0-499', SIZE)).toEqual({ kind: 'range', start: 0, end: 499 });
  });

  it('parses a range in the middle', () => {
    expect(parseRange('bytes=400-699', SIZE)).toEqual({ kind: 'range', start: 400, end: 699 });
  });

  it('parses a single byte', () => {
    expect(parseRange('bytes=0-0', SIZE)).toEqual({ kind: 'range', start: 0, end: 0 });
  });

  it('tolerates whitespace and casing', () => {
    expect(parseRange('  BYTES = 0-499  ', SIZE)).toEqual({ kind: 'range', start: 0, end: 499 });
  });

  it('clamps an end that runs past the resource', () => {
    expect(parseRange('bytes=900-99999', SIZE)).toEqual({ kind: 'range', start: 900, end: 999 });
  });
});

describe('range parsing — open-ended ranges', () => {
  it('parses "from N to the end"', () => {
    expect(parseRange('bytes=500-', SIZE)).toEqual({ kind: 'range', start: 500, end: 999 });
  });

  it('parses a range starting at zero to the end', () => {
    expect(parseRange('bytes=0-', SIZE)).toEqual({ kind: 'range', start: 0, end: 999 });
  });
});

describe('range parsing — suffix ranges', () => {
  it('returns the last N bytes', () => {
    expect(parseRange('bytes=-200', SIZE)).toEqual({ kind: 'range', start: 800, end: 999 });
  });

  it('clamps a suffix longer than the resource to the whole file', () => {
    expect(parseRange('bytes=-5000', SIZE)).toEqual({ kind: 'range', start: 0, end: 999 });
  });

  it('treats a zero-length suffix as unsatisfiable', () => {
    expect(parseRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });
});

describe('range parsing — unsatisfiable and malformed', () => {
  it('rejects a range starting past the end', () => {
    expect(parseRange('bytes=1000-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=5000-6000', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('rejects any range on an empty resource', () => {
    expect(parseRange('bytes=0-10', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-10', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('treats an end before the start as malformed', () => {
    // Uninterpretable rather than out of bounds: the two deserve different responses.
    expect(parseRange('bytes=500-100', SIZE)).toEqual({ kind: 'malformed' });
  });

  it('rejects garbage byte-range headers', () => {
    for (const header of ['bytes=', 'bytes=-', 'bytes=abc-def', 'bytes=1.5-2.5']) {
      expect(parseRange(header, SIZE), header).toEqual({ kind: 'malformed' });
    }
  });

  it('ignores a header that is not a byte range at all', () => {
    // No recognised unit, so it must be ignored rather than treated as a broken range.
    expect(parseRange('garbage', SIZE)).toEqual({ kind: 'full' });
  });
});

describe('contentRangeHeader', () => {
  it('formats a partial response', () => {
    expect(contentRangeHeader(0, 499, 1000)).toBe('bytes 0-499/1000');
    expect(contentRangeHeader(900, 999, 1000)).toBe('bytes 900-999/1000');
  });
});
