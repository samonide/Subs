/**
 * Structural validation of the project document.
 *
 * This layer checks SHAPE only — required fields, primitive types, enumerations. The
 * cross-field semantic rules ("segments must not overlap", "a dangling style reference is
 * an error") live in `validateInvariants.ts`, because they are not expressible in Zod
 * without contortion.
 *
 * The split matters: a document is untrusted input — a file on disk, eventually an API
 * payload — so it must be parsed and checked before any code acts on it.
 */

import { z } from 'zod';
import { SCHEMA_VERSION } from '../document/types.js';

/** Integer milliseconds. A float here is a modelling error, not a rounding issue (I-1). */
const msSchema = z.number().int().min(0);

/** Colours are canonicalised at authoring time: '#RRGGBB' or '#RRGGBBAA'. */
const colorSchema = z.string().regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, {
  message: 'Colour must be #RRGGBB or #RRGGBBAA',
});

/** A unit interval. */
const unitInterval = z.number().min(0).max(1);

export const transformSpecSchema = z.object({
  property: z.enum(['opacity', 'scale', 'rotationDeg', 'translateX', 'translateY']),
  value: z.number(),
});

export const normalizedPositionSchema = z.object({
  x: unitInterval,
  y: unitInterval,
  anchorX: unitInterval,
  anchorY: unitInterval,
});

const styleCoreShape = {
  fontFamily: z.string().min(1),
  fontSizePx: z.number().positive(),
  fontWeight: z.number().int().min(1).max(1000),
  fontStyle: z.enum(['normal', 'italic']),
  fill: colorSchema,
  strokeColor: colorSchema.optional(),
  strokeWidthPx: z.number().min(0).optional(),
  shadowColor: colorSchema.optional(),
  shadowOpacity: unitInterval.optional(),
  shadowBlurPx: z.number().min(0).optional(),
  shadowOffsetXPx: z.number().optional(),
  shadowOffsetYPx: z.number().optional(),
  align: z.enum(['left', 'center', 'right']),
  lineHeight: z.number().positive(),
  letterSpacingPx: z.number().optional(),
  position: normalizedPositionSchema.optional(),
  transforms: z.array(transformSpecSchema).optional(),
};

export const styleSchema = z.object({ id: z.string().min(1), name: z.string(), ...styleCoreShape });

/** The override form carries the same properties minus identity. */
export const styleOverrideSchema = z
  .object(styleCoreShape)
  .partial()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'An override must specify at least one property',
  });

export const animationDefSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  phase: z.enum(['in', 'out', 'inout']),
  property: z.enum(['opacity', 'scale', 'rotationDeg', 'translateX', 'translateY']),
  from: z.number(),
  to: z.number(),
  curve: z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'spring']),
  durationMs: z.number().int().min(0).optional(),
  durationFraction: z.number().min(0).max(1).optional(),
  staggerMs: z.number().int().min(0).optional(),
});

export const subtitleWordSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  startMs: msSchema,
  endMs: msSchema,
  confidence: unitInterval.optional(),
  timingSource: z.enum(['measured', 'synthesized']),
  styleOverride: styleOverrideSchema.optional(),
  animationId: z.string().min(1).optional(),
});

export const subtitleSegmentSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  startMs: msSchema,
  endMs: msSchema,
  lineBreaks: z.array(z.number().int().min(0)).optional(),
  styleId: z.string().min(1).optional(),
  styleOverride: styleOverrideSchema.optional(),
  animationId: z.string().min(1).optional(),
  words: z.array(subtitleWordSchema),
  origin: z.enum(['asr', 'manual']),
  locked: z.boolean().optional(),
});

export const subtitleTrackSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  styleId: z.string().min(1).optional(),
  animationId: z.string().min(1).optional(),
  visible: z.boolean(),
  locked: z.boolean(),
  segments: z.array(subtitleSegmentSchema),
});

export const assetRecordSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['sourceVideo', 'proxyVideo', 'audio', 'font', 'thumbnail']),
  filename: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().min(0),
  checksum: z.string().optional(),
  meta: z
    .object({
      durationMs: msSchema,
      width: z.number().int().min(0).optional(),
      height: z.number().int().min(0).optional(),
      displayWidth: z.number().int().min(0).optional(),
      displayHeight: z.number().int().min(0).optional(),
      rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
      frameRateNum: z.number().int().positive().optional(),
      frameRateDen: z.number().int().positive().optional(),
      codec: z.string().optional(),
      audioCodec: z.string().optional(),
      sampleRate: z.number().int().positive().optional(),
      channels: z.number().int().positive().optional(),
    })
    .optional(),
  derivedFrom: z.string().min(1).optional(),
  transform: z.string().optional(),
});

export const projectDocumentSchema = z.object({
  schemaVersion: z.number().int().min(1),
  id: z.string().min(1),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  assets: z.array(assetRecordSchema),
  tracks: z.array(subtitleTrackSchema),
  styles: z.record(z.string().min(1), styleSchema),
  animations: z.record(z.string().min(1), animationDefSchema),
  transcription: z
    .object({
      providerId: z.string().min(1),
      model: z.string().optional(),
      language: z.string().optional(),
      generatedAt: z.string(),
    })
    .optional(),
});

export type ProjectDocumentInput = z.input<typeof projectDocumentSchema>;
export type ProjectDocumentParsed = z.output<typeof projectDocumentSchema>;

/** Current schema version, re-exported for the migration layer. */
export { SCHEMA_VERSION };
