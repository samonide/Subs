/**
 * Document validation entry point.
 *
 * Two layers, deliberately separate:
 *   - **Structural** (Zod): shape, types, enumerations.
 *   - **Semantic** (`validateInvariants`): cross-field coherence — ordering, overlap,
 *     dangling references, ID uniqueness, text-cache drift.
 *
 * Both run on every document read. A document is untrusted input: a file on disk now, an
 * API payload later. Nothing acts on a document that has not passed both.
 */

import { projectDocumentSchema, type ProjectDocumentInput } from './schema.js';
import { validateInvariants, type InvariantReport } from './invariants.js';
import type { ProjectDocument } from '../document/types.js';

export { validateInvariants };
export type { InvariantReport, InvariantViolation } from './invariants.js';

export class DocumentValidationError extends Error {
  override readonly name = 'DocumentValidationError';
  readonly report: InvariantReport;
  readonly structuralIssues: unknown;

  constructor(report: InvariantReport, structuralIssues: unknown) {
    const detail =
      report.violations.length > 0
        ? report.violations.map((v) => `[${v.invariant}] ${v.message}`).join('\n  ')
        : 'structural validation failed';
    super(`Invalid project document:\n  ${detail}`);
    this.report = report;
    this.structuralIssues = structuralIssues;
  }
}

/**
 * Validate and parse a document.
 *
 * Returns a typed `ProjectDocument` on success and throws `DocumentValidationError` on
 * failure. Throwing is correct here: a document that fails validation must not be used,
 * and partial acceptance of a subtitle document means silently mangled timing.
 */
export function parseDocument(input: ProjectDocumentInput): ProjectDocument {
  const parsed = projectDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new DocumentValidationError({ valid: true, violations: [] }, parsed.error.issues);
  }

  // Semantic invariants can only be checked once the shape is sound.
  const report = validateInvariants(parsed.data);
  if (!report.valid) {
    throw new DocumentValidationError(report, undefined);
  }

  return parsed.data;
}

/** Validate without throwing. Useful for diagnostics and for the test suite. */
export function checkDocument(input: unknown): {
  ok: boolean;
  document?: ProjectDocument;
  report: InvariantReport;
  structuralIssues?: unknown;
} {
  const parsed = projectDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      report: { valid: false, violations: [] },
      structuralIssues: parsed.error.issues,
    };
  }
  const report = validateInvariants(parsed.data);
  if (!report.valid) {
    return { ok: false, document: parsed.data, report };
  }
  return { ok: true, document: parsed.data, report };
}
