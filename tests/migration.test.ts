import { describe, expect, it } from 'vitest';

import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  MigrationError,
  migrate,
} from '../src/core/migration/index.js';
import { SCHEMA_VERSION } from '../src/core/document/types.js';
import { makeDocument } from '../src/core/testing/factories.js';

describe('migration foundation', () => {
  it('exposes a single current schema version', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
  });

  it('has a migration step registered for every version below current', () => {
    // A version bump without a registered step would be a lie about the mechanism, and
    // the next non-additive change needs the pattern to already exist and be tested.
    for (let version = 1; version < CURRENT_SCHEMA_VERSION; version += 1) {
      expect(MIGRATIONS[version], `no migration registered from v${version}`).toBeDefined();
    }
  });

  it('migrates a v1 document up to current', () => {
    // v1 → v2 is additive: the new MediaMeta fields are optional, so a real v1 document
    // must load without loss.
    const v1 = { ...makeDocument(), schemaVersion: 1 };
    const migrated = migrate(JSON.parse(JSON.stringify(v1)) as unknown);
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.id).toBe(v1.id);
  });

  it('migrates a current-version document unchanged', () => {
    const doc = makeDocument();
    const migrated = migrate(JSON.parse(JSON.stringify(doc)) as unknown);
    expect(migrated).toEqual(doc);
  });

  it('is deterministic — migrating twice yields the same result', () => {
    const raw = JSON.parse(JSON.stringify(makeDocument())) as unknown;
    expect(migrate(raw)).toEqual(migrate(JSON.parse(JSON.stringify(raw)) as unknown));
  });

  it('rejects a document from a future build rather than half-loading it', () => {
    const doc = { ...makeDocument(), schemaVersion: CURRENT_SCHEMA_VERSION + 1 };
    expect(() => migrate(doc)).toThrow(MigrationError);
    expect(() => migrate(doc)).toThrow(/newer than this build/);
  });

  it('rejects a document with no schema version', () => {
    const doc: Record<string, unknown> = { ...makeDocument() };
    delete doc['schemaVersion'];
    expect(() => migrate(doc)).toThrow(MigrationError);
  });

  it('rejects a non-object document', () => {
    expect(() => migrate(null)).toThrow(MigrationError);
    expect(() => migrate('a string')).toThrow(MigrationError);
    expect(() => migrate([])).toThrow(MigrationError);
  });

  it('rejects a document that fails structural validation after migrating', () => {
    const broken = { ...makeDocument(), canvas: { width: 0, height: 0 } };
    expect(() => migrate(broken)).toThrow(MigrationError);
    expect(() => migrate(broken)).toThrow(/structural validation/);
  });
});
