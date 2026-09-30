/**
 * Media delivery over HTTP Range.
 *
 * Serves a project's stored asset to the browser as a seekable stream. Two properties make
 * this work possible in a video editor:
 *
 *   1. **Streaming.** The body is piped from disk in 64KB chunks. A 2GB file is never read
 *      into memory, which is the same discipline the ingest path follows.
 *   2. **Byte ranges.** Browsers issue ranged requests to seek. Without correct
 *      `206 Partial Content` responses the video element cannot scrub, and many players
 *      refuse a resource that does not advertise `Accept-Ranges: bytes`.
 *
 * The browser addresses media by **project id and asset id only**. It never sees, and
 * never needs, a filesystem path — the extension comes from the project's own asset
 * record, so the client cannot influence where on disk anything is read from. Every path
 * still passes through `WorkspaceLayout`, which rejects traversal and symlink escapes
 * (S-1).
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { ErrorCode, IngestError } from '../errors.js';
import { type ProjectStore } from '../project/store.js';
import { type WorkspaceLayout } from '../workspace.js';
import { contentRangeHeader, parseRange } from './range.js';

/** Chunk size for streaming. Large enough to be efficient, small enough to stay bounded. */
const STREAM_CHUNK_BYTES = 64 * 1024;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

function contentTypeFor(filePath: string): string {
  return MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Serve `GET|HEAD /media/:projectId/:assetId`.
 *
 * Returns `true` when the route handled the request, so the caller can fall through to
 * other routes. Throws a typed `IngestError` for anything the client got wrong.
 */
export async function serveMedia(
  request: IncomingMessage,
  response: ServerResponse,
  segments: readonly string[],
  layout: WorkspaceLayout,
  store: ProjectStore,
): Promise<boolean> {
  if (segments[0] !== 'media' || segments.length !== 3) {
    return false;
  }

  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    throw new IngestError(ErrorCode.INVALID_UPLOAD, `${method} is not supported for media.`);
  }

  const projectId = segments[1];
  const assetId = segments[2];
  if (projectId === undefined || assetId === undefined) {
    throw new IngestError(ErrorCode.INVALID_UPLOAD, 'A project and asset id are required.');
  }

  // Resolve identity → document → stored path. The client supplies only ids; the path is
  // derived server-side, so a crafted id cannot address an arbitrary file.
  const project = await store.load(projectId);
  const asset = project.assets.find((entry) => entry.id === assetId);
  if (asset === undefined) {
    throw new IngestError(
      ErrorCode.MISSING_ASSET,
      `Asset ${assetId} does not belong to project ${projectId}.`,
    );
  }

  // The extension is a property of the stored asset, taken from the project's own record.
  // `layout.assetFileForExtension` still validates it, so a tampered document cannot smuggle
  // a path through.
  const filePath = layout.assetFileForExtension(
    projectId,
    assetId,
    extname(asset.filename).slice(1),
  );

  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new IngestError(
        ErrorCode.MISSING_ASSET,
        'The media file for this asset is missing from storage.',
        { cause: error },
      );
    }
    throw new IngestError(ErrorCode.STORAGE_FAILURE, 'Could not read the media file.', {
      retryable: true,
      cause: error,
    });
  }

  const rangeHeader = request.headers.range;
  const result = parseRange(rangeHeader, size);
  const contentType = contentTypeFor(filePath);

  // A client that named a range we cannot satisfy gets a 416 with the resource size, so it
  // can retry sensibly. A malformed range is treated as absent rather than fatal.
  if (result.kind === 'unsatisfiable') {
    response.writeHead(416, {
      'content-range': `bytes */${size}`,
      'accept-ranges': 'bytes',
    });
    response.end();
    return true;
  }

  if (result.kind === 'malformed' || result.kind === 'full') {
    // HEAD is genuinely useful here: a player often probes size and type before playing.
    if (method === 'HEAD') {
      response.writeHead(200, {
        'content-type': contentType,
        'content-length': String(size),
        'accept-ranges': 'bytes',
      });
      response.end();
      return true;
    }

    response.writeHead(200, {
      'content-type': contentType,
      'content-length': String(size),
      'accept-ranges': 'bytes',
    });
    // Streamed, never buffered.
    createReadStream(filePath, { highWaterMark: STREAM_CHUNK_BYTES }).pipe(response);
    return true;
  }

  const length = result.end - result.start + 1;

  if (method === 'HEAD') {
    response.writeHead(206, {
      'content-type': contentType,
      'content-length': String(length),
      'content-range': contentRangeHeader(result.start, result.end, size),
      'accept-ranges': 'bytes',
    });
    response.end();
    return true;
  }

  response.writeHead(206, {
    'content-type': contentType,
    'content-length': String(length),
    'content-range': contentRangeHeader(result.start, result.end, size),
    'accept-ranges': 'bytes',
  });

  const stream = createReadStream(filePath, {
    start: result.start,
    end: result.end,
    highWaterMark: STREAM_CHUNK_BYTES,
  });

  // A client that navigates away mid-stream must not leave the file handle open.
  response.on('close', () => {
    stream.destroy();
  });

  stream.pipe(response);
  return true;
}
