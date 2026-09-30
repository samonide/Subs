/**
 * Streamed media ingestion.
 *
 * The whole point of this module is the one thing it must *not* do: buffer the upload.
 * Bytes move from the incoming stream to disk in chunks, and the size cap is enforced
 * *during* streaming — a 5GB upload is rejected after the cap is crossed and the partial
 * file is removed, rather than after it has been fully received.
 *
 *   stream → validate metadata → mint assetId → stream to disk (capped)
 *          → ffprobe → canonical MediaMeta → register asset → persist project
 *
 * Failure at any step removes the partial directory, so a failed upload can never leave
 * behind something that looks like a valid asset.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';

import { newAssetId, type AssetId } from '../../core/document/ids.js';
import type { MediaMeta, ProjectDocument } from '../../core/document/types.js';
import { ErrorCode, IngestError } from '../errors.js';
import { type WorkspaceLayout } from '../workspace.js';
import {
  containerFromFormat,
  containerMatchesExtension,
  extensionOf,
  isSupportedExtension,
  isSupportedMimeType,
  normalizeMimeType,
  sanitizeFilename,
  type SupportedContainer,
} from './filetypes.js';
import { probeMedia, type RawProbe } from './probe.js';

export interface IngestLimits {
  /** Hard cap on the stored file, in bytes. */
  maxFileBytes: number;
  /** Wall-clock budget for the probe. */
  probeTimeoutMs?: number;
}

export interface IngestRequest {
  /** The incoming bytes. A request body, a file handle, anything readable. */
  stream: Readable;
  /** Original filename from the client. Sanitized for display only, never used as a path. */
  originalFilename: string;
  /** Client-declared MIME type. Advisory only. */
  declaredMimeType?: string;
}

export interface IngestOptions extends IngestLimits {
  signal?: AbortSignal;
}

export interface IngestResult {
  assetId: AssetId;
  /** Sanitized original filename, for display. */
  displayName: string;
  extension: string;
  byteSize: number;
  meta: MediaMeta;
  /** The raw ffprobe output, for diagnostics. Deliberately NOT stored in the document. */
  raw: RawProbe;
  /** Absolute path of the stored file. Infrastructure concern, not document data. */
  filePath: string;
}

/**
 * A pass-through that counts bytes and aborts the stream the moment the cap is crossed.
 *
 * Enforcing here rather than after the write is what keeps a hostile "infinite" upload
 * from filling the disk: the stream is destroyed mid-flight, so the remaining bytes are
 * never read.
 *
 * The exceeded flag is recorded rather than thrown directly, because destroying the source
 * stream makes the pipeline reject with its own `ERR_STREAM_PREMATURE_CLOSE` — which would
 * mask the real reason. The caller checks the flag after the pipeline settles and reports
 * `FILE_TOO_LARGE`, so the user is told the truth instead of a transport error.
 */
function createSizeCap(
  limitBytes: number,
  onExceeded: () => void,
): { stream: Transform; exceeded: () => boolean } {
  let seen = 0;
  let exceeded = false;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.byteLength;
      if (seen > limitBytes) {
        exceeded = true;
        onExceeded();
        callback(
          new IngestError(
            ErrorCode.FILE_TOO_LARGE,
            `File exceeds the maximum size of ${Math.floor(limitBytes / (1024 * 1024))} MB.`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
  return { stream, exceeded: () => exceeded };
}

/** Validate declared metadata before accepting any bytes. */
function assertAcceptableMetadata(filename: string, mimeType: string | undefined): string {
  const displayName = sanitizeFilename(filename);

  if (displayName.length === 0) {
    throw new IngestError(ErrorCode.INVALID_UPLOAD, 'The uploaded file has no usable filename.');
  }

  if (!isSupportedExtension(displayName)) {
    throw new IngestError(
      ErrorCode.UNSUPPORTED_MEDIA,
      `Unsupported file type. Supported formats: ${SUPPORTED_LABEL}.`,
    );
  }

  // A declared type that contradicts the allow-list is a strong signal of a bad client or
  // a hostile one. A missing or unrecognised type is not — browsers are unreliable here,
  // so the authoritative check remains the probe below.
  const normalized = normalizeMimeType(mimeType);
  if (normalized !== undefined && !isSupportedMimeType(normalized)) {
    throw new IngestError(
      ErrorCode.UNSUPPORTED_MEDIA,
      `Declared content type "${normalized}" is not a supported video type.`,
    );
  }

  return displayName;
}

const SUPPORTED_LABEL = 'MP4, MOV, WebM and MKV';

/**
 * Ingest one media file into a project's controlled storage.
 *
 * Returns the registered asset's facts. The caller persists the project document; this
 * function does not write `project.json`, because a document must never be persisted in a
 * state that references an asset that failed to register.
 */
export async function ingestMedia(
  layout: WorkspaceLayout,
  projectId: string,
  request: IngestRequest,
  options: IngestOptions,
): Promise<IngestResult> {
  const { stream, originalFilename, declaredMimeType } = request;

  if (stream === undefined || typeof stream.pipe !== 'function') {
    throw new IngestError(ErrorCode.INVALID_UPLOAD, 'No readable upload stream was provided.');
  }
  if (options.signal?.aborted === true) {
    throw new IngestError(ErrorCode.CANCELLED, 'Ingest cancelled before it started.');
  }

  // 1. Validate metadata before touching the disk.
  const displayName = assertAcceptableMetadata(originalFilename, declaredMimeType);
  const extension = extensionOf(displayName) ?? 'bin';

  // 2. Mint the asset identity up front, so the destination path is fully determined by
  //    server-generated values and a failure leaves an empty, sweepable directory.
  const assetId = newAssetId();
  const assetDir = layout.assetDir(projectId, assetId);
  const filePath = layout.assetFile(projectId, assetId, extension);

  await mkdir(assetDir, { recursive: true });

  let finalised = false;
  try {
    // 3. Stream to disk, enforcing the cap during the transfer.
    //
    // On exceeding the cap the *transform* is stopped, but the request stream is NOT
    // destroyed: destroying it aborts the HTTP connection, and the client then sees a
    // transport error instead of the 413 that explains what happened. Pausing lets the
    // upload stop while the response is still deliverable.
    const cap = createSizeCap(options.maxFileBytes, () => {
      stream.pause();
    });

    try {
      await pipeline(stream, cap.stream, createWriteStream(filePath, { flags: 'wx' }));
    } catch (error) {
      if (cap.exceeded()) {
        throw new IngestError(
          ErrorCode.FILE_TOO_LARGE,
          `File exceeds the maximum size of ${Math.floor(options.maxFileBytes / (1024 * 1024))} MB.`,
        );
      }
      throw error;
    }

    const stats = await stat(filePath);
    if (stats.size === 0) {
      throw new IngestError(ErrorCode.INVALID_UPLOAD, 'The uploaded file is empty.');
    }
    if (stats.size > options.maxFileBytes) {
      throw new IngestError(
        ErrorCode.FILE_TOO_LARGE,
        `File exceeds the maximum size of ${Math.floor(options.maxFileBytes / (1024 * 1024))} MB.`,
      );
    }

    // 4. Inspect. This is the authoritative type check: a file whose real container
    //    contradicts its extension is rejected, whatever the client claimed.
    const { meta, raw } = await probeMedia(filePath, {
      timeoutMs: options.probeTimeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    const probedContainer = containerFromFormat(meta.container);
    if (!containerMatchesExtension(probedContainer, displayName)) {
      throw new IngestError(
        ErrorCode.UNSUPPORTED_MEDIA,
        `This file's actual format is ${meta.container ?? 'unrecognised'}, which does not match its .${extension} name.`,
      );
    }

    // 5. The asset is now real. Record its metadata alongside it for diagnostics; the
    //    document remains the source of truth for the asset's identity and role.
    finalised = true;
    return {
      assetId,
      displayName,
      extension,
      byteSize: stats.size,
      meta,
      raw,
      filePath,
    };
  } catch (error) {
    // Any failure — size cap, abort, probe error, mismatch — removes the partial asset so
    // nothing invalid is left looking like a usable file.
    if (!finalised) {
      await rm(assetDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

/** Build the `AssetRecord` for a successfully ingested file. */
export function toAssetRecord(
  result: IngestResult,
  role: 'sourceVideo' | 'audio' = 'sourceVideo',
): ProjectDocument['assets'][number] {
  return {
    id: result.assetId,
    role,
    filename: result.displayName,
    mimeType: `video/${result.extension === 'mkv' ? 'x-matroska' : result.extension}`,
    byteSize: result.byteSize,
    meta: result.meta,
  };
}

export type { SupportedContainer };
