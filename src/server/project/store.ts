/**
 * Local project persistence.
 *
 * `project.json` is the source of truth for a project. It is written **atomically**:
 * content goes to a temporary file in the same directory, is flushed, and is then renamed
 * over the target. A rename within a directory is atomic on POSIX, so a crash or a full
 * disk can leave the temporary file behind but can never leave a half-written
 * `project.json` — the only valid copy is never the damaged one.
 *
 * Every write validates first, and every read migrates then validates. A project that
 * fails to load raises a typed error rather than a stack trace.
 */

import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { newProjectId, newStyleId } from '../../core/document/ids.js';
import { SCHEMA_VERSION, type ProjectDocument, type Style } from '../../core/document/types.js';
import { migrate, MigrationError } from '../../core/migration/index.js';
import { checkDocument } from '../../core/validation/index.js';
import { ErrorCode, IngestError } from '../errors.js';
import { type WorkspaceLayout } from '../workspace.js';

const TEMP_PREFIX = '.project-';
const TEMP_SUFFIX = '.json.tmp';

/** The built-in style every new project starts with. */
function defaultStyles(): Record<string, Style> {
  const id = newStyleId();
  return {
    [id]: {
      id,
      name: 'Default',
      fontFamily: 'Inter',
      fontSizePx: 48,
      fontWeight: 700,
      fontStyle: 'normal',
      fill: '#FFFFFF',
      align: 'center',
      lineHeight: 1.2,
    },
  };
}

/** Create a new, valid, empty project. Does not touch the disk. */
export function newProject(name: string): ProjectDocument {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newProjectId(),
    name,
    createdAt: now,
    updatedAt: now,
    canvas: { width: 1920, height: 1080 },
    assets: [],
    tracks: [],
    styles: defaultStyles(),
    animations: {},
  };
}

/** Validate a document, throwing a typed error if it is not usable. */
function assertValid(doc: ProjectDocument, context: string): void {
  const result = checkDocument(doc);
  if (!result.ok) {
    const detail =
      result.report.violations.length > 0
        ? result.report.violations.map((v) => `[${v.invariant}] ${v.message}`).join('; ')
        : 'structural validation failed';
    throw new IngestError(ErrorCode.INVALID_PROJECT, `${context}: ${detail}`);
  }
}

export class ProjectStore {
  readonly layout: WorkspaceLayout;

  constructor(layout: WorkspaceLayout) {
    this.layout = layout;
    this.layout.ensure();
  }

  /** Create a project and persist it. */
  async create(name: string): Promise<ProjectDocument> {
    const doc = newProject(name);
    await this.save(doc);
    return doc;
  }

  /**
   * Persist a document atomically.
   *
   * Validation happens before any write, so an invalid document can never reach disk.
   */
  async save(doc: ProjectDocument): Promise<void> {
    assertValid(doc, 'Refusing to save an invalid project');

    const dir = this.layout.projectDir(doc.id);
    await mkdir(dir, { recursive: true });

    const target = this.layout.projectFile(doc.id);
    const temp = join(dir, `${TEMP_PREFIX}${doc.id}${TEMP_SUFFIX}`);

    try {
      await writeFile(temp, JSON.stringify(doc, null, 2), { encoding: 'utf8', mode: 0o600 });
      // Rename within the same directory: atomic, so the target is never partial.
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      if (error instanceof IngestError) throw error;
      throw new IngestError(ErrorCode.STORAGE_FAILURE, `Could not write project ${doc.id}.`, {
        retryable: true,
        cause: error,
      });
    }
  }

  /** Read and validate a project, migrating older schema versions on the way. */
  async load(projectId: string): Promise<ProjectDocument> {
    const path = this.layout.projectFile(projectId);

    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new IngestError(ErrorCode.PROJECT_NOT_FOUND, `Project ${projectId} does not exist.`, {
          cause: error,
        });
      }
      throw new IngestError(ErrorCode.STORAGE_FAILURE, `Could not read project ${projectId}.`, {
        retryable: true,
        cause: error,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new IngestError(
        ErrorCode.INVALID_PROJECT,
        `Project ${projectId} is not valid JSON and cannot be opened.`,
        { cause: error },
      );
    }

    let doc: ProjectDocument;
    try {
      doc = migrate(parsed);
    } catch (error) {
      if (error instanceof MigrationError) {
        throw new IngestError(ErrorCode.INVALID_PROJECT, `Project ${projectId}: ${error.message}`, {
          cause: error,
        });
      }
      throw error;
    }

    assertValid(doc, `Project ${projectId} is invalid`);
    return doc;
  }

  /** Remove a project directory and everything under it. */
  async remove(projectId: string): Promise<void> {
    const dir = this.layout.projectDir(projectId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      throw new IngestError(ErrorCode.STORAGE_FAILURE, `Could not delete project ${projectId}.`, {
        retryable: true,
        cause: error,
      });
    }
  }

  /**
   * Report assets whose files are missing from disk.
   *
   * The document is the source of truth, so a missing file is a real inconsistency worth
   * surfacing rather than silently ignoring. It is reported, not repaired.
   */
  async findMissingAssets(doc: ProjectDocument): Promise<string[]> {
    const missing: string[] = [];
    for (const asset of doc.assets) {
      const metaPath = this.layout.assetMetadataFile(doc.id, asset.id);
      try {
        await readFile(metaPath, 'utf8');
      } catch {
        missing.push(asset.id);
      }
    }
    return missing;
  }

  /** List the project IDs present on disk. */
  async list(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.layout.projectsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new IngestError(ErrorCode.STORAGE_FAILURE, 'Could not list projects.', {
        cause: error,
      });
    }
    return entries.filter((name) => {
      try {
        this.layout.projectDir(name);
        return true;
      } catch {
        // A directory whose name is not a safe identifier is not one of ours.
        return false;
      }
    });
  }

  /** A readable stream of a project's document file, for download. */
  documentStream(projectId: string) {
    return createReadStream(this.layout.projectFile(projectId));
  }
}
