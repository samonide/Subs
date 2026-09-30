/**
 * Upload file-name and type validation (S-2, S-3).
 *
 * Three independent signals, none trusted alone:
 *
 *   1. **The original filename** — sanitized for *display and storage metadata only*.
 *      It never becomes a path. Its extension is one signal about the content.
 *   2. **The declared MIME type** — advisory. A browser can be wrong or absent, so this
 *      alone can never accept or reject a file.
 *   3. **Actual media inspection** (in `probe.ts`) — the only authoritative check. A file
 *      whose real container contradicts its extension is rejected.
 *
 * The supported set is deliberately small. This is a subtitle editor for short-form
 * video, not a demuxer for every codec on earth; an explicit allow-list is a security
 * control as much as a product decision.
 */

/** Media types we accept for ingest, keyed by canonical extension. */
export const SUPPORTED_MEDIA = {
  mp4: { extensions: ['mp4', 'm4v'], mimeTypes: ['video/mp4', 'video/x-m4v'], label: 'MP4' },
  mov: { extensions: ['mov'], mimeTypes: ['video/quicktime'], label: 'QuickTime MOV' },
  webm: { extensions: ['webm'], mimeTypes: ['video/webm'], label: 'WebM' },
  mkv: {
    extensions: ['mkv'],
    mimeTypes: ['video/x-matroska', 'video/matroska'],
    label: 'Matroska',
  },
} as const;

export type SupportedContainer = keyof typeof SUPPORTED_MEDIA;

/** All accepted extensions, lower-case and without a leading dot. */
export const SUPPORTED_EXTENSIONS: readonly string[] = Object.values(SUPPORTED_MEDIA).flatMap(
  (entry) => entry.extensions.map((ext) => ext.toLowerCase()),
);

/** All accepted MIME types, lower-case. */
export const SUPPORTED_MIME_TYPES: readonly string[] = Object.values(SUPPORTED_MEDIA).flatMap(
  (entry) => entry.mimeTypes,
);

/** Longest filename we will keep for display. */
const MAX_FILENAME_LENGTH = 180;

/**
 * Sanitize a client-supplied filename for display and storage as metadata.
 *
 * Strips directory components, traversal sequences, control characters and NUL bytes, and
 * caps the length. The result is never used as a path — the stored file is always
 * `original.<ext>` — so this is about honest display and safe logging, not path safety.
 * Path safety comes from the identifier rules in `workspace.ts`.
 */
export function sanitizeFilename(input: string): string {
  // Take the last path segment under both separators, so a Windows-style path cannot
  // survive as a POSIX basename.
  const lastSegment = input.split(/[/\\]/).pop() ?? '';
  // Remove control characters and NUL. Matching control characters is the point of this
  // line — a NUL byte in a filename is exactly what a truncation attack relies on — so the
  // lint rule that flags control-character regexes does not apply.
  // eslint-disable-next-line no-control-regex
  const cleaned = lastSegment.replace(/[\u0000-\u001f\u007f]/g, '');
  // Drop any remaining traversal or separator residue.
  const withoutDots = cleaned.replace(/^\.+/, '').replace(/[/\\]/g, '');
  const capped = withoutDots.slice(0, MAX_FILENAME_LENGTH);
  return capped;
}

/** Extract a lower-case extension from a filename, or undefined if there is none. */
export function extensionOf(filename: string): string | undefined {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(sanitizeFilename(filename));
  return match?.[1]?.toLowerCase();
}

/** True when the extension is in the supported allow-list. */
export function isSupportedExtension(filename: string): boolean {
  const ext = extensionOf(filename);
  return ext !== undefined && SUPPORTED_EXTENSIONS.includes(ext);
}

/** Normalize a declared MIME type for comparison (strip parameters, lower-case). */
export function normalizeMimeType(mimeType: string | undefined): string | undefined {
  if (mimeType === undefined) {
    return undefined;
  }
  return mimeType.split(';')[0]?.trim().toLowerCase();
}

/** True when a declared MIME type is in the allow-list. */
export function isSupportedMimeType(mimeType: string | undefined): boolean {
  const normalized = normalizeMimeType(mimeType);
  return normalized !== undefined && SUPPORTED_MIME_TYPES.includes(normalized);
}

/**
 * Guess the canonical container key from a container string reported by ffprobe.
 *
 * ffprobe reports container names as a comma list (e.g. `mov,mp4,m4a,3gp,3g2,mj2`), so we
 * match the first entry we recognise.
 */
export function containerFromFormat(
  formatName: string | undefined,
): SupportedContainer | undefined {
  if (formatName === undefined) {
    return undefined;
  }
  const parts = formatName
    .toLowerCase()
    .split(',')
    .map((part) => part.trim());
  // ffprobe reports WebM as "matroska,webm" — the same container family as MKV. The
  // presence of "webm" in the list is the only signal distinguishing them, so it is
  // checked first; a bare matroska list (with no webm) is a real .mkv.
  if (parts.includes('webm')) return 'webm';
  if (parts.includes('matroska') || parts.includes('mkv')) return 'mkv';
  if (
    parts.includes('mp4') ||
    parts.includes('m4a') ||
    parts.includes('3gp') ||
    parts.includes('3g2')
  ) {
    return 'mp4';
  }
  if (parts.includes('mov') || parts.includes('quicktime')) return 'mov';
  return undefined;
}

/**
 * Whether a probed container is consistent with the extension the file arrived with.
 *
 * This is the check that makes the extension mean something: a `.mp4` that is really a
 * WebM is rejected, rather than being accepted on the strength of its name.
 */
export function containerMatchesExtension(
  probed: SupportedContainer | undefined,
  filename: string,
): boolean {
  if (probed === undefined) {
    return false;
  }
  const ext = extensionOf(filename);
  if (ext === undefined) {
    return false;
  }
  // Read through a widened view: the per-container tuples have different element types, so
  // `includes` on the union would infer `never`.
  const extensions: readonly string[] = SUPPORTED_MEDIA[probed].extensions;
  return extensions.includes(ext);
}
