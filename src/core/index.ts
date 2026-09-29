/**
 * Public surface of the core domain layer.
 *
 * Everything exported here is pure and environment-agnostic: importable unchanged by a
 * browser bundle, a Node worker, and a test runner. That constraint is enforced by
 * `eslint.config.mjs` and, independently, by `tests/boundary.test.ts`.
 *
 * Consumers should import from `@/core` (this module) rather than reaching into
 * individual files, so the internal layout stays free to change.
 */

export * from './timing/index.js';
export * from './document/ids.js';
export * from './document/types.js';
export * from './style/resolve.js';
export * from './validation/index.js';
export * from './migration/index.js';
export * from './ops/index.js';
export * from './testing/factories.js';
