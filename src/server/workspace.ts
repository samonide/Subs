/**
 * Controlled workspace storage layout and path resolution.
 *
 * ```
 * workspace/
 *   projects/
 *     <projectId>/
 *       project.json
 *       media/
 *         <assetId>/
 *           original.<ext>
 *           metadata.json
 *   tmp/
 * ```
 *
 * The central security property (S-1): **every path is derived from a server-generated
 * identifier, never from user input.** A project ID or asset ID arriving from a request is
 * treated as untrusted and must pass `isSafeIdentifier` before it is ever joined into a
 * path. `filename` is display metadata and is never joined into a path at all.
 *
 * The second property (S-1, symlink variant): after resolving, the real path must still
 * be inside the workspace root. A pre-existing symlink planted inside the workspace could
 * otherwise redirect a write to `/etc`. `assertInsideRoot` closes that.
 */

import { mkdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ErrorCode, IngestError } from './errors.js';

/**
 * Identifiers permitted in a path.
 *
 * Deliberately strict: lowercase alphanumerics and underscore. Our generated IDs match
 * this, and rejecting anything else means a traversal string can never be a valid
 * component, so no amount of `..` juggling helps.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeIdentifier(value: string): boolean {
  return SAFE_ID.test(value);
}

/** Throw unless `value` is safe to use as a path component. */
export function assertSafeIdentifier(value: string, label: string): string {
  if (!isSafeIdentifier(value)) {
    throw new IngestError(
      ErrorCode.PATH_VIOLATION,
      `${label} is not a valid identifier. Only letters, digits, underscore and dash are allowed (1–64 characters).`,
    );
  }
  return value;
}

/**
 * Verify that `candidate` resolves inside `root`, following symlinks.
 *
 * Two checks, and **the symlink check runs first**:
 *
 *   1. A *lexical* check catches `../` traversal directly.
 *   2. A *realpath* check catches a symlink planted inside the workspace that points
 *      outside it.
 *
 * Order matters. An earlier version returned as soon as the lexical check passed, which
 * meant a path like `<projects>/evil/target.txt` — lexically contained, but where `evil`
 * is a symlink to `/etc` — was accepted. The lexical check alone is not sufficient, and
 * skipping the realpath check is exactly the hole that makes the lexical one look safe.
 *
 * The leaf may not exist yet (we are often creating it), so the deepest existing ancestor
 * is resolved and the remainder appended.
 */
export function assertInsideRoot(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);

  // Resolve the root through symlinks too, so the comparison is like-for-like.
  let realRoot: string;
  try {
    realRoot = realpathSync.native(resolvedRoot);
  } catch {
    realRoot = resolvedRoot;
  }

  const resolvedCandidate = resolve(candidate);

  // Resolve the deepest existing ancestor, then re-append the non-existent tail.
  let probe = resolvedCandidate;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(probe);
      const realCandidate = tail.length === 0 ? real : join(real, ...tail);
      const relReal = relative(realRoot, realCandidate);
      if (relReal === '..' || relReal.startsWith(`..${sep}`) || isAbsolute(relReal)) {
        throw new IngestError(
          ErrorCode.PATH_VIOLATION,
          'Resolved path escapes the workspace root (via a symlink).',
        );
      }
      return resolvedCandidate;
    } catch (error) {
      if (error instanceof IngestError) throw error;
      const parent = resolve(probe, '..');
      if (parent === probe) {
        throw new IngestError(
          ErrorCode.PATH_VIOLATION,
          'Could not verify the path is inside the workspace root.',
          { cause: error },
        );
      }
      tail.unshift(basename(probe));
      probe = parent;
    }
  }
}

/** Absolute layout for a workspace, with no knowledge of what lives inside it. */
export class WorkspaceLayout {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  get projectsDir(): string {
    return join(this.root, 'projects');
  }

  get tmpDir(): string {
    return join(this.root, 'tmp');
  }

  /** Ensure the base directories exist. Idempotent. */
  ensure(): void {
    mkdirSync(this.projectsDir, { recursive: true });
    mkdirSync(this.tmpDir, { recursive: true });
    mkdirSync(this.jobsDir, { recursive: true });
  }

  projectDir(projectId: string): string {
    assertSafeIdentifier(projectId, 'projectId');
    const dir = join(this.projectsDir, projectId);
    return assertInsideRoot(this.projectsDir, dir);
  }

  projectFile(projectId: string): string {
    return join(this.projectDir(projectId), 'project.json');
  }

  assetDir(projectId: string, assetId: string): string {
    assertSafeIdentifier(assetId, 'assetId');
    const dir = join(this.projectDir(projectId), 'media', assetId);
    return assertInsideRoot(this.projectsDir, dir);
  }

  /** The stored media file. The extension is ours (from the allow-list), never the user's. */
  assetFile(projectId: string, assetId: string, extension: string): string {
    assertSafeIdentifier(assetId, 'assetId');
    // Allow only a bare alnum extension. A value like `../evil` or `mp4/../../x` must be
    // rejected outright rather than "cleaned", because a permissive cleanup is a place
    // where a bypass hides.
    const trimmed = extension.trim();
    if (!/^[A-Za-z0-9]{1,8}$/.test(trimmed)) {
      throw new IngestError(ErrorCode.PATH_VIOLATION, `Unsafe file extension: ${extension}`);
    }
    const file = join(this.assetDir(projectId, assetId), `original.${trimmed.toLowerCase()}`);
    return assertInsideRoot(this.projectsDir, file);
  }

  assetMetadataFile(projectId: string, assetId: string): string {
    return join(this.assetDir(projectId, assetId), 'metadata.json');
  }

  /**
   * Locate the stored file for an asset, given the extension recorded at ingest.
   *
   * The asset id alone is not enough: ingest names the file `original.<ext>`, and the
   * extension is a property of the *asset*, so the caller supplies it from the project's
   * record rather than guessing. Guessing here would be a silent failure mode — a `.mp4`
   * stored as `original.mp4` would 404 just because the caller guessed `mov`.
   *
   * Note this takes an extension, never a path. There is no way to ask this layout for an
   * arbitrary file.
   */
  assetFileForExtension(projectId: string, assetId: string, extension: string): string {
    return this.assetFile(projectId, assetId, extension);
  }

  /** A scratch path for in-progress work, removed once the real file is final. */
  tmpFile(label: string): string {
    assertSafeIdentifier(label, 'tmp label');
    return join(this.tmpDir, label);
  }

  /**
   * A job record file, stored **outside** any project directory.
   *
   * Deliberate: jobs are volatile runtime state, not part of a project's durable truth. If
   * job records lived inside `projects/<id>/`, a project could be copied, backed up, or
   * committed with a stale `"status": "processing"` attached, and every consumer of that
   * directory would have to know which files are load-bearing (invariant I-20).
   *
   * The file name is the job id, which the caller generates. No user string reaches the
   * path: `assertSafeIdentifier` runs first, so traversal is rejected before `join`.
   */
  jobFile(jobId: string): string {
    assertSafeIdentifier(jobId, 'jobId');
    const dir = join(this.jobsDir, jobId);
    return join(dir, 'job.json');
  }

  get jobsDir(): string {
    return join(this.root, 'jobs');
  }

  jobDir(jobId: string): string {
    assertSafeIdentifier(jobId, 'jobId');
    const dir = join(this.jobsDir, jobId);
    return assertInsideRoot(this.jobsDir, dir);
  }

  /**
   * A temp path inside a job's own directory, so a crashed write cannot be mistaken for one.
   *
   * The label is **not** validated as an identifier: unlike `jobId`, it never comes from
   * outside the process — it is a literal this module owns. `assertSafeIdentifier` is the
   * right check for caller-supplied input and the wrong one here, where it would reject the
   * dot-prefixed temp name this method exists to produce.
   */
  jobTempFile(jobId: string, label: string): string {
    assertSafeIdentifier(jobId, 'jobId');
    if (label.length === 0 || label.includes('/') || label.includes('\\')) {
      throw new IngestError(ErrorCode.PATH_VIOLATION, 'Unsafe job temp label.');
    }
    return join(this.jobDir(jobId), label);
  }

  /**
   * A job's result payload, stored beside its record rather than inside it.
   *
   * A transcription can be hundreds of segments. Keeping it in `job.json` would mean every
   * status poll re-reads and re-parses it, and would put transcript content in the volatile
   * runtime store. The job record carries only a reference; the client fetches this file,
   * applies it as a labelled operation, and the document — not the job store — becomes the
   * truth (invariant I-20).
   *
   * The name is derived from the job id, which the caller generated. It is never a user string.
   */
  jobResultFile(jobId: string): string {
    assertSafeIdentifier(jobId, 'jobId');
    return join(this.jobDir(jobId), 'result.json');
  }
}
