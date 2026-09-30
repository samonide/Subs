/**
 * HTTP byte-range parsing.
 *
 * Pure and transport-agnostic: it takes a header value and a known size, and returns
 * either a byte range or a typed reason the request cannot be served. It knows nothing
 * about requests, responses, sockets, or filesystems, which is what makes every edge case
 * below cheap to test.
 *
 * Media playback depends on this. Without correct `206 Partial Content` responses, the
 * video element cannot seek: browsers issue ranged requests as a matter of course, and
 * many refuse to play a resource that does not advertise `Accept-Ranges: bytes`.
 */

export type RangeResult =
  | { kind: 'full' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' }
  | { kind: 'malformed' };

/**
 * Parse a `Range` header against a known resource size.
 *
 * Supports the two forms RFC 9110 requires a server to understand:
 *   - `bytes=start-end`   an explicit inclusive range
 *   - `bytes=start-`      from `start` to the end
 *   - `bytes=-suffix`     the final `suffix` bytes
 *
 * Multi-range requests (`bytes=0-99,200-299`) are deliberately **not** served. A server
 * may legally decline them by ignoring the header and returning the whole representation,
 * which is what `full` means here. Multipart/byteranges would add real complexity, and no
 * media player needs it.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  // A missing header means "send the whole thing".
  if (header === undefined) {
    return { kind: 'full' };
  }

  const match = /^bytes\s*=\s*(.*)$/i.exec(header.trim());
  if (match === null) {
    // A Range header in a unit we do not understand must be ignored, not rejected.
    return { kind: 'full' };
  }

  const spec = match[1]?.trim() ?? '';
  if (spec.length === 0) {
    return { kind: 'malformed' };
  }

  // Multiple ranges: decline by ignoring, per RFC 9110 §14.2.
  if (spec.includes(',')) {
    return { kind: 'full' };
  }

  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (parts === null) {
    return { kind: 'malformed' };
  }

  const [, rawStart, rawEnd] = parts as unknown as [string, string, string];
  const hasStart = rawStart.length > 0;
  const hasEnd = rawEnd.length > 0;

  if (!hasStart && !hasEnd) {
    // "bytes=-" names neither a start nor a suffix.
    return { kind: 'malformed' };
  }

  // "bytes=-N" — the last N bytes.
  if (!hasStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix === 0) {
      return { kind: 'unsatisfiable' };
    }
    const start = Math.max(0, size - suffix);
    // A suffix longer than the file is the whole file, not an error.
    return size === 0 ? { kind: 'unsatisfiable' } : { kind: 'range', start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) {
    return { kind: 'malformed' };
  }

  if (size === 0 || start >= size) {
    // Past the end of the resource.
    return { kind: 'unsatisfiable' };
  }

  if (!hasEnd) {
    // "bytes=N-" — from N to the end.
    return { kind: 'range', start, end: size - 1 };
  }

  const requestedEnd = Number(rawEnd);
  if (!Number.isSafeInteger(requestedEnd)) {
    return { kind: 'malformed' };
  }

  // An end before the start is malformed rather than unsatisfiable: the client asked for
  // something that cannot be interpreted, not something out of bounds.
  if (requestedEnd < start) {
    return { kind: 'malformed' };
  }

  // A range that runs past the end is clamped, not rejected: "bytes=0-999999" on a
  // 500-byte file means "all of it".
  return { kind: 'range', start, end: Math.min(requestedEnd, size - 1) };
}

/** The `Content-Range` header value for a served range, or undefined for a full body. */
export function contentRangeHeader(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}
