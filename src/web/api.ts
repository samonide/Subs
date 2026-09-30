/**
 * The browser's view of a project.
 *
 * Deliberately narrow: the player needs an asset id, a media URL, and the timing metadata
 * required for frame stepping. It does **not** need the whole `ProjectDocument`, and
 * crucially it never receives a filesystem path — the server derives the media location
 * from ids. The types here mirror the server's projection rather than importing the
 * document model, so a change to the document cannot silently alter what the client sees.
 */

import type { FrameRate } from '../core/timing/index.js';

export interface MediaMetaDto {
  durationMs: number;
  width?: number;
  height?: number;
  displayWidth?: number;
  displayHeight?: number;
  rotation?: 0 | 90 | 180 | 270;
  frameRateNum?: number;
  frameRateDen?: number;
  frameRateMode?: 'cfr' | 'vfr';
  codec?: string;
  container?: string;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
}

export interface PlaybackDescriptor {
  projectId: string;
  name: string;
  /** Null when the project has no ingested video yet — a valid state, not an error. */
  asset: { assetId: string; meta: MediaMetaDto | null } | null;
  mediaUrl: string | null;
}

/** A project summary from the list endpoint. */
export interface ProjectSummary {
  projectId: string;
  name: string;
  hasVideo: boolean;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function readError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    return new ApiError(
      body.error?.code ?? 'UNKNOWN',
      body.error?.message ?? `Request failed with status ${response.status}.`,
      response.status,
    );
  } catch {
    return new ApiError(
      'UNKNOWN',
      `Request failed with status ${response.status}.`,
      response.status,
    );
  }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const response = await fetch('/api/projects');
  if (!response.ok) throw await readError(response);
  const body = (await response.json()) as { projectIds: string[] };

  // The list endpoint returns ids only; resolve each to a summary in parallel. A project
  // that fails to load is skipped rather than failing the whole list — one broken project
  // should not hide every other one.
  const settled = await Promise.allSettled(
    body.projectIds.map(async (id) => {
      const project = await getPlaybackDescriptor(id);
      return { projectId: project.projectId, name: project.name, hasVideo: project.asset !== null };
    }),
  );
  return settled
    .filter(
      (result): result is PromiseFulfilledResult<ProjectSummary> => result.status === 'fulfilled',
    )
    .map((result) => result.value);
}

export async function getPlaybackDescriptor(projectId: string): Promise<PlaybackDescriptor> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/playback`);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as PlaybackDescriptor;
}

/** Derive the frame rate from a descriptor's metadata, or null if unknown. */
export function descriptorFrameRate(descriptor: PlaybackDescriptor): FrameRate | null {
  const meta = descriptor.asset?.meta;
  if (meta?.frameRateNum === undefined || meta.frameRateDen === undefined) {
    return null;
  }
  return { numerator: meta.frameRateNum, denominator: meta.frameRateDen };
}
