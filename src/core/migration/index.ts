/**
 * Versioned document migration.
 *
 * A project file must outlive the code that wrote it. That requires three things:
 *   - a schema version on the document,
 *   - a pure, table-driven migration per version bump,
 *   - loud refusal of a document from a *newer* build.
 *
 * The last point is the non-obvious one. Partially loading a document from a future
 * version means silently mangling timing — which is worse than refusing to open it. So
 * `migrate` throws on an unknown future version rather than guessing.
 *
 * Phase 0 defines the mechanism with a single version. Historical migrations are added
 * when versions actually change; inventing them now would be complexity with no consumer.
 */

import { SCHEMA_VERSION, type ProjectDocument } from '../document/types.js';
import { projectDocumentSchema } from '../validation/schema.js';

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

/**
 * A migration step from version `n` to `n + 1`.
 *
 * Pure by contract: same input, same output, no I/O, no clock access. That is what makes
 * a migration testable and replayable.
 */
export type Migration = (document: unknown) => unknown;

/**
 * Steps keyed by the version they migrate FROM.
 *
 * Empty at v1 because there is nothing before v1. Each future schema bump adds exactly one
 * entry here, plus its test.
 */
export const MIGRATIONS: Readonly<Record<number, Migration>> = Object.freeze({});

/** The highest schema version this build understands. */
export const CURRENT_SCHEMA_VERSION = SCHEMA_VERSION;

/**
 * Bring a raw document up to the current schema version.
 *
 * @throws {MigrationError} if the document is malformed, has no schema version, or comes
 *   from a newer build than this one.
 */
export function migrate(raw: unknown): ProjectDocument {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new MigrationError('Cannot migrate a non-object document');
  }

  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new MigrationError(
      `Document is missing a valid schemaVersion (got ${JSON.stringify(version)})`,
    );
  }

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new MigrationError(
      `Document schema version ${version} is newer than this build supports (${CURRENT_SCHEMA_VERSION}). ` +
        'Refusing to load it: a partial load would silently corrupt timing. Open the project with a newer build.',
    );
  }

  let current: unknown = raw;
  for (let step = version; step < CURRENT_SCHEMA_VERSION; step += 1) {
    const migration = MIGRATIONS[step];
    if (migration === undefined) {
      throw new MigrationError(
        `No migration registered from schema version ${step} to ${step + 1}. ` +
          'The document cannot be upgraded safely.',
      );
    }
    current = migration(current);
  }

  const parsed = projectDocumentSchema.safeParse(current);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new MigrationError(
      `Migrated document failed structural validation at ${first?.path.join('.') ?? '<root>'}: ${first?.message ?? 'unknown error'}`,
    );
  }

  return parsed.data;
}
