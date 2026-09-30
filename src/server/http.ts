/**
 * Minimal HTTP intake for Phase 1.
 *
 * Deliberately **not** Fastify: D-7b deferred that decision, and the brief says not to
 * force a framework in merely because ingestion now needs a server. The Phase 1 surface is
 * three routes, and `node:http` plus these ~150 lines is proportionate. If the surface
 * grows, the framework question is revisited on evidence rather than by default.
 *
 * What this layer must get right (S-4, S-14):
 *   - it **streams** the body; it never buffers it;
 *   - it enforces the declared size cap while streaming;
 *   - it binds to `127.0.0.1` only, because there is no authentication;
 *   - it turns typed `IngestError`s into structured JSON, never a stack trace.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { ErrorCode, IngestError, httpStatusFor, isIngestError } from './errors.js';
import { ingestMedia } from './media/ingest.js';
import { serveMedia } from './media/serve.js';
import { createJobStore, createWorker, type JobStore, type Worker } from './jobs/store.js';
import { serveJobRoutes } from './jobs/routes.js';
import { type ProjectStore } from './project/store.js';
import { type WorkspaceLayout } from './workspace.js';

export interface ServerConfig {
  layout: WorkspaceLayout;
  store: ProjectStore;
  maxFileBytes: number;
  probeTimeoutMs?: number;
  /** Interface to bind. Defaults to loopback: without auth, this must not be reachable. */
  host?: string;
  /** Job subsystem. Created by {@link createIngestServer} when not supplied. */
  jobs?: JobStore;
  worker?: Worker;
}

/** A config with the job subsystem resolved, as used internally by the router. */
type ResolvedConfig = ServerConfig & { jobs: JobStore; worker: Worker };

/**
 * Read a small JSON body with a hard cap.
 *
 * A cap is essential: an unbounded JSON read is an unbounded memory read, which is the same
 * class of bug the upload path is built to avoid.
 */
async function readJsonBody(request: IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > limitBytes) {
      throw new IngestError(ErrorCode.INVALID_UPLOAD, 'Request body is too large.');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    throw new IngestError(ErrorCode.INVALID_UPLOAD, 'Request body is not valid JSON.', {
      cause: error,
    });
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (isIngestError(error)) {
    sendJson(response, httpStatusFor(error.code), { error: error.toJSON() });
    return;
  }
  // An unexpected error must not leak a stack trace to a client, and must not take the
  // process down.
  sendJson(response, 500, {
    error: {
      code: 'INTERNAL',
      message: 'Something went wrong handling this request.',
      retryable: true,
    },
  });
}

async function route(
  config: ResolvedConfig,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const segments = url.pathname.split('/').filter((part) => part.length > 0);
  const method = request.method ?? 'GET';

  // GET|HEAD /media/:projectId/:assetId — streamed with Range support.
  if (
    segments[0] === 'media' &&
    (await serveMedia(request, response, segments, config.layout, config.store))
  ) {
    return;
  }

  // Job routes: extraction start, status poll, cancellation.
  //
  // The job subsystem is resolved **once**, when the server is created, not per request.
  // Building it here would mint a fresh store and worker for every request — meaning the
  // single-slot queue would be recreated constantly (so "one job at a time" would be false),
  // and a job created by one request would be invisible to the next.
  if (
    await serveJobRoutes(request, response, segments, {
      layout: config.layout,
      projects: config.store,
      jobs: config.jobs,
      worker: config.worker,
    })
  ) {
    return;
  }

  // POST /api/projects  { name }
  if (
    method === 'POST' &&
    segments.length === 2 &&
    segments[0] === 'api' &&
    segments[1] === 'projects'
  ) {
    const body = (await readJsonBody(request)) as { name?: unknown } | undefined;
    const name =
      typeof body?.name === 'string' && body.name.length > 0 ? body.name : 'Untitled project';
    const doc = await config.store.create(name.slice(0, 200));
    sendJson(response, 201, { project: doc });
    return;
  }

  // GET /api/projects
  if (
    method === 'GET' &&
    segments.length === 2 &&
    segments[0] === 'api' &&
    segments[1] === 'projects'
  ) {
    const ids = await config.store.list();
    sendJson(response, 200, { projectIds: ids });
    return;
  }

  // GET /api/projects/:id/playback
  //
  // A deliberately narrow projection of the project: everything the browser needs to
  // play, and nothing else. The full document is available at /api/projects/:id, but a
  // player has no business receiving the whole model — and this route makes it
  // structurally impossible for the client to depend on a filesystem path, because no path
  // is ever included. The media URL is built from ids.
  if (
    method === 'GET' &&
    segments.length === 4 &&
    segments[0] === 'api' &&
    segments[1] === 'projects' &&
    segments[3] === 'playback'
  ) {
    const projectId = segments[2];
    if (projectId === undefined) {
      throw new IngestError(ErrorCode.INVALID_UPLOAD, 'Missing project id.');
    }
    const project = await config.store.load(projectId);
    const video = project.assets.find((asset) => asset.role === 'sourceVideo');

    sendJson(response, 200, {
      projectId: project.id,
      name: project.name,
      // A project with no ingested video yet is a valid state, not an error: Phase 1 can
      // create a project before anything is uploaded.
      asset: video === undefined ? null : { assetId: video.id, meta: video.meta ?? null },
      mediaUrl: video === undefined ? null : `/media/${project.id}/${video.id}`,
    });
    return;
  }

  // GET /api/projects/:id
  if (
    method === 'GET' &&
    segments.length === 3 &&
    segments[0] === 'api' &&
    segments[1] === 'projects'
  ) {
    const projectId = segments[2];
    if (projectId === undefined)
      throw new IngestError(ErrorCode.INVALID_UPLOAD, 'Missing project id.');
    sendJson(response, 200, { project: await config.store.load(projectId) });
    return;
  }

  // PUT /api/projects/:id  (the document itself)
  if (
    method === 'PUT' &&
    segments.length === 3 &&
    segments[0] === 'api' &&
    segments[1] === 'projects'
  ) {
    const projectId = segments[2];
    if (projectId === undefined)
      throw new IngestError(ErrorCode.INVALID_UPLOAD, 'Missing project id.');
    const body = await readJsonBody(request, 20_000_000);
    if (typeof body !== 'object' || body === null) {
      throw new IngestError(ErrorCode.INVALID_PROJECT, 'Request body is not a project document.');
    }
    const doc = body as { id?: unknown };
    if (doc.id !== projectId) {
      throw new IngestError(
        ErrorCode.INVALID_PROJECT,
        'Project id in the document does not match the URL.',
      );
    }
    await config.store.save(body as never);
    sendJson(response, 200, { project: body });
    return;
  }

  // POST /api/projects/:id/assets  (raw body upload, headers carry the name and type)
  if (
    method === 'POST' &&
    segments.length === 4 &&
    segments[0] === 'api' &&
    segments[1] === 'projects' &&
    segments[3] === 'assets'
  ) {
    const projectId = segments[2];
    if (projectId === undefined)
      throw new IngestError(ErrorCode.INVALID_UPLOAD, 'Missing project id.');

    // Confirm the project exists before accepting any bytes.
    const project = await config.store.load(projectId);

    const filenameHeader = request.headers['x-filename'];
    const filename = decodeURIComponent(typeof filenameHeader === 'string' ? filenameHeader : '');
    const contentType = request.headers['content-type'];
    const mimeType = typeof contentType === 'string' ? contentType : undefined;
    if (filename.length === 0) {
      throw new IngestError(
        ErrorCode.INVALID_UPLOAD,
        'Missing the original filename (X-Filename header).',
      );
    }

    const result = await ingestMedia(
      config.layout,
      projectId,
      { stream: request, originalFilename: filename, declaredMimeType: mimeType },
      {
        maxFileBytes: config.maxFileBytes,
        ...(config.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: config.probeTimeoutMs }),
      },
    );

    // Only now does the document learn about the asset: an asset that failed to ingest
    // must never be referenced by a persisted project.
    const asset = {
      id: result.assetId,
      role: 'sourceVideo' as const,
      filename: result.displayName,
      mimeType: `video/${result.extension === 'mkv' ? 'x-matroska' : result.extension}`,
      byteSize: result.byteSize,
      meta: result.meta,
    };
    const updated = {
      ...project,
      assets: [...project.assets, asset],
      updatedAt: new Date().toISOString(),
    };
    await config.store.save(updated);

    // The response carries only logical identifiers and canonical metadata. `result.filePath`
    // is an absolute server path and must never cross the network: the browser addresses media
    // by `/media/:projectId/:assetId`, which the server resolves to a path itself. Exposing it
    // would leak the workspace layout and tie the client to the host's filesystem.
    sendJson(response, 201, {
      asset,
      mediaUrl: `/media/${projectId}/${result.assetId}`,
    });
    return;
  }

  throw new IngestError(ErrorCode.INVALID_UPLOAD, `No route for ${method} ${url.pathname}.`);
}

export function createIngestServer(config: ServerConfig): Server {
  // Resolve the job subsystem once, here. Doing it inside `route` would create a new store
  // and a new worker on every request — which would silently break the single-slot guarantee
  // and make a freshly created job unreadable by the very next poll.
  const jobs = config.jobs ?? createJobStore(config.layout);

  // Crash recovery, before the server can answer a single request.
  //
  // A job found in `queued` or `processing` belongs to a process that is gone: its FFmpeg
  // child died with the parent, and there is no partial output worth promoting. Marking those
  // failed — rather than leaving them "processing" — is what stops a restarted server from
  // showing work that will never finish, and what lets a later cleanup sweep find the
  // orphaned temp file instead of ignoring it.
  //
  // This lives here and not in `startIngestServer` because the real entry point (`main.ts`)
  // calls `createIngestServer` directly. Recovery in a helper only the tests use is recovery
  // that never runs in production.
  const recovered = jobs.recoverInterruptedJobs(new Date().toISOString());
  if (recovered.length > 0) {
    process.stderr.write(
      `recovered ${recovered.length} interrupted job(s): ${recovered
        .map((record) => record.id)
        .join(', ')}\n`,
    );
  }

  const resolved: ResolvedConfig = {
    ...config,
    jobs,
    worker: config.worker ?? createWorker(config.layout),
  };
  return createServer((request, response) => {
    route(resolved, request, response).catch((error: unknown) => sendError(response, error));
  });
}

export interface StartedServer {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

/**
 * Start the server on loopback unless explicitly told otherwise.
 *
 * Crash recovery has already run inside {@link createIngestServer}; this only adds a bound
 * port and a promise-shaped handle. Recovery is asserted through the job store, which is
 * where the observable effect lives.
 */
export function startIngestServer(config: ServerConfig, port = 0): Promise<StartedServer> {
  const resolved: ServerConfig = {
    ...config,
    jobs: config.jobs ?? createJobStore(config.layout),
    worker: config.worker ?? createWorker(config.layout),
  };
  const server = createIngestServer(resolved);
  const host = config.host ?? '127.0.0.1';

  return new Promise<StartedServer>((resolvePromise, rejectPromise) => {
    server.on('error', rejectPromise);
    server.listen(port, host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        rejectPromise(new Error('Server did not bind to a TCP port'));
        return;
      }
      resolvePromise({
        server,
        url: `http://${host}:${address.port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error === undefined ? done() : fail(error)));
          }),
      });
    });
  });
}
