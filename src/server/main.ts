/**
 * Server entry point.
 *
 * Deliberately the thinnest possible file. It resolves the workspace root, starts the HTTP
 * listener, and installs shutdown handlers — nothing else. All routing lives in `http.ts` and
 * all persistence in the modules beneath it, so this file has no reason to grow.
 *
 * It binds to loopback only. Phase 1 and Phase 2 have no authentication, so a listener on a
 * public interface would expose a user's project media to the local network. If the app ever
 * needs remote access, that decision belongs with authentication, not with this file.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIngestServer } from './http.js';
import { WorkspaceLayout } from './workspace.js';
import { ProjectStore } from './project/store.js';

/**
 * 2 GB. Large enough that a real 4K phone recording is never rejected for size, small enough
 * that a runaway upload cannot fill the developer's disk. Enforced during the stream in
 * `ingest.ts`, not after the fact.
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

const DEFAULT_PORT = 4199;
const LOOPBACK = '127.0.0.1';

function resolveWorkspaceRoot(): string {
  // An explicit override lets a developer keep fixtures out of the real workspace; otherwise
  // the root sits beside `src/`, which is stable regardless of the current directory.
  const configured = process.env['SUBS_WORKSPACE'];
  if (configured !== undefined && configured !== '') {
    return resolve(configured);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../workspace');
}

function resolvePort(): number {
  const raw = process.env['PORT'];
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, received "${raw}"`);
  }
  return parsed;
}

const workspaceRoot = resolveWorkspaceRoot();
const port = resolvePort();

const layout = new WorkspaceLayout(workspaceRoot);
const server = createIngestServer({
  layout,
  store: new ProjectStore(layout),
  maxFileBytes: MAX_FILE_BYTES,
  host: LOOPBACK,
});
server.listen(port, LOOPBACK, () => {
  process.stdout.write(`subs server listening on http://${LOOPBACK}:${port}\n`);
  process.stdout.write(`workspace: ${workspaceRoot}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Stop accepting connections, then let the process exit naturally once in-flight
    // responses finish. Force-exiting here would truncate an in-progress media stream.
    server.close(() => {
      process.exit(0);
    });
  });
}
