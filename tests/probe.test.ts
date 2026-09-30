import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  inferFrameRateMode,
  parseRationalFrameRate,
  probeMedia,
  toMediaMeta,
  type RawProbe,
} from '../src/server/media/probe.js';
import { ErrorCode, IngestError } from '../src/server/errors.js';
import { containerFromFormat } from '../src/server/media/filetypes.js';
import {
  cleanupFixtures,
  ffmpegAvailable,
  makeRawFixture,
  makeVideoFixture,
} from './helpers/fixtures.js';

let hasFfmpeg = false;

beforeAll(async () => {
  hasFfmpeg = await ffmpegAvailable();
});

afterAll(async () => {
  await cleanupFixtures();
});

describe('rational frame rate parsing', () => {
  it('parses the exact rational ffprobe reports', () => {
    expect(parseRationalFrameRate('30/1')).toEqual({ num: 30, den: 1 });
    expect(parseRationalFrameRate('60/1')).toEqual({ num: 60, den: 1 });
    expect(parseRationalFrameRate('25/1')).toEqual({ num: 25, den: 1 });
    expect(parseRationalFrameRate('30000/1001')).toEqual({ num: 30000, den: 1001 });
  });

  it('never collapses a rational to a float', () => {
    const parsed = parseRationalFrameRate('30000/1001');
    if (parsed === undefined) {
      expect.unreachable('30000/1001 must parse');
      return;
    }
    // The exact pair must survive; a float would be 29.97, which is wrong.
    expect(parsed).toEqual({ num: 30_000, den: 1001 });
    expect(parsed.num / parsed.den).not.toBe(29.97);
  });

  it('treats 0/0 and malformed values as unknown', () => {
    expect(parseRationalFrameRate('0/0')).toBeUndefined();
    expect(parseRationalFrameRate('30')).toBeUndefined();
    expect(parseRationalFrameRate('')).toBeUndefined();
    expect(parseRationalFrameRate(undefined)).toBeUndefined();
  });

  it('rejects a negative or zero denominator', () => {
    expect(parseRationalFrameRate('30/0')).toBeUndefined();
    expect(parseRationalFrameRate('-30/1')).toBeUndefined();
  });
});

describe('frame rate mode inference', () => {
  it('reports cfr when nominal and average agree', () => {
    expect(inferFrameRateMode('30/1', '30/1')).toBe('cfr');
    expect(inferFrameRateMode('30000/1001', '30000/1001')).toBe('cfr');
  });

  it('reports vfr when they diverge', () => {
    expect(inferFrameRateMode('30/1', '25/1')).toBe('vfr');
  });

  it('reports vfr rather than guessing when only one rate is known', () => {
    // Conservative: a wrong 'cfr' misleads playback and export; a wrong 'vfr' does not.
    expect(inferFrameRateMode('30/1', '0/0')).toBe('vfr');
    expect(inferFrameRateMode('0/0', '30/1')).toBe('vfr');
    expect(inferFrameRateMode('0/0', '0/0')).toBeUndefined();
  });
});

describe('toMediaMeta', () => {
  const baseProbe = (overrides: Partial<RawProbe> = {}): RawProbe => ({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1920,
        height: 1080,
        r_frame_rate: '30/1',
        avg_frame_rate: '30/1',
      },
    ],
    format: { format_name: 'mov,mp4,m4a', duration: '12.5' },
    ...overrides,
  });

  it('converts duration seconds to integer milliseconds', () => {
    expect(toMediaMeta(baseProbe()).durationMs).toBe(12_500);
  });

  it('rounds rather than truncating a fractional millisecond', () => {
    const probe = baseProbe({ format: { format_name: 'mp4', duration: '0.967633' } });
    expect(toMediaMeta(probe).durationMs).toBe(968);
  });

  it('extracts dimensions, codec and container', () => {
    const meta = toMediaMeta(baseProbe());
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1080);
    expect(meta.codec).toBe('h264');
    expect(meta.container).toBe('mov,mp4,m4a');
  });

  it('applies a 90° rotation to the display dimensions', () => {
    const probe = baseProbe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          r_frame_rate: '30/1',
          avg_frame_rate: '30/1',
          tags: { rotate: '90' },
        },
      ],
    });
    const meta = toMediaMeta(probe);
    expect(meta.rotation).toBe(90);
    // A quarter turn swaps the displayed axes.
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1080);
    expect(meta.displayWidth).toBe(1080);
    expect(meta.displayHeight).toBe(1920);
  });

  it('leaves display dimensions equal for no rotation', () => {
    const meta = toMediaMeta(baseProbe());
    expect(meta.rotation).toBeUndefined();
    expect(meta.displayWidth).toBe(1920);
    expect(meta.displayHeight).toBe(1080);
  });

  it('normalises a negative rotation into the canonical 0-270 range', () => {
    const probe = baseProbe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 100,
          height: 50,
          r_frame_rate: '30/1',
          avg_frame_rate: '30/1',
          tags: { rotate: '-90' },
        },
      ],
    });
    expect(toMediaMeta(probe).rotation).toBe(270);
  });

  it('reads rotation from side_data_list, which is how current ffmpeg writes it', () => {
    // Easy to miss, and missing it leaves a portrait phone video sideways in the editor.
    const probe = baseProbe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          r_frame_rate: '30/1',
          avg_frame_rate: '30/1',
          side_data_list: [{ rotation: 90 }],
        },
      ],
    });
    const meta = toMediaMeta(probe);
    expect(meta.rotation).toBe(90);
    expect(meta.displayWidth).toBe(1080);
    expect(meta.displayHeight).toBe(1920);
  });

  it('falls back to the legacy rotate tag when side data is absent', () => {
    const probe = baseProbe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 100,
          height: 50,
          r_frame_rate: '30/1',
          avg_frame_rate: '30/1',
          tags: { rotate: '180' },
        },
      ],
    });
    expect(toMediaMeta(probe).rotation).toBe(180);
  });

  it('prefers side data over a tag when both are present', () => {
    const probe = baseProbe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 100,
          height: 50,
          r_frame_rate: '30/1',
          avg_frame_rate: '30/1',
          tags: { rotate: '90' },
          side_data_list: [{ rotation: 270 }],
        },
      ],
    });
    expect(toMediaMeta(probe).rotation).toBe(270);
  });

  it('extracts audio metadata when present', () => {
    const probe = baseProbe({
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 10, height: 10, avg_frame_rate: '30/1' },
        { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
      ],
    });
    const meta = toMediaMeta(probe);
    expect(meta.audioCodec).toBe('aac');
    expect(meta.sampleRate).toBe(48_000);
    expect(meta.channels).toBe(2);
  });

  it('omits audio fields for a video-only file', () => {
    const meta = toMediaMeta(baseProbe());
    expect(meta.audioCodec).toBeUndefined();
    expect(meta.sampleRate).toBeUndefined();
    expect(meta.channels).toBeUndefined();
  });

  it('omits frame rate entirely when the probe reports none', () => {
    const probe = baseProbe({
      streams: [{ codec_type: 'video', codec_name: 'mjpeg', width: 10, height: 10 }],
    });
    const meta = toMediaMeta(probe);
    expect(meta.frameRateNum).toBeUndefined();
    expect(meta.frameRateDen).toBeUndefined();
    expect(meta.frameRateMode).toBeUndefined();
  });

  it('rejects a non-numeric duration', () => {
    const probe = baseProbe({ format: { format_name: 'mp4', duration: 'not-a-number' } });
    expect(() => toMediaMeta(probe)).toThrow(IngestError);
  });
});

describe('containerFromFormat', () => {
  it('maps ffprobe container names to our canonical keys', () => {
    expect(containerFromFormat('mov,mp4,m4a,3gp,3g2,mj2')).toBe('mp4');
    // WebM is reported as the matroska family; the "webm" member is the only signal.
    expect(containerFromFormat('matroska,webm')).toBe('webm');
    expect(containerFromFormat('matroska')).toBe('mkv');
    expect(containerFromFormat('quicktime')).toBe('mov');
  });

  it('returns undefined for an unrecognised container', () => {
    expect(containerFromFormat('avi')).toBeUndefined();
    expect(containerFromFormat(undefined)).toBeUndefined();
  });
});

describe('probeMedia against real media', () => {
  it('reads a real 30fps MP4 and preserves the rational frame rate', async () => {
    if (!hasFfmpeg) return;
    const path = await makeVideoFixture('cfr30', {
      frameRate: '30/1',
      width: 320,
      height: 240,
      durationSeconds: 1,
    });
    if (path === undefined) return;

    const { meta } = await probeMedia(path);
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(240);
    expect(meta.frameRateNum).toBe(30);
    expect(meta.frameRateDen).toBe(1);
    expect(meta.frameRateMode).toBe('cfr');
    expect(meta.durationMs).toBeGreaterThan(900);
    expect(meta.durationMs).toBeLessThan(1100);
    expect(meta.codec).toBe('h264');
  });

  it('reads a real 29.97fps MP4 as 30000/1001, not 29.97', async () => {
    if (!hasFfmpeg) return;
    const path = await makeVideoFixture('ntsc', { frameRate: '30000/1001' });
    if (path === undefined) return;

    const { meta } = await probeMedia(path);
    const num = meta.frameRateNum as number;
    const den = meta.frameRateDen as number;
    expect(num).toBe(30_000);
    expect(den).toBe(1001);
    // The whole point: the pair must not have been flattened to 29.97.
    expect(num / den).not.toBe(29.97);
  });

  it('reads a real 60fps MP4', async () => {
    if (!hasFfmpeg) return;
    const path = await makeVideoFixture('cfr60', { frameRate: '60/1' });
    if (path === undefined) return;
    const { meta } = await probeMedia(path);
    expect(meta.frameRateNum).toBe(60);
    expect(meta.frameRateDen).toBe(1);
  });

  it('reads a video with audio', async () => {
    if (!hasFfmpeg) return;
    const path = await makeVideoFixture('withaudio', { withAudio: true });
    if (path === undefined) return;
    const { meta } = await probeMedia(path);
    expect(meta.audioCodec).toBeDefined();
    expect(meta.sampleRate).toBeGreaterThan(0);
    expect(meta.channels).toBeGreaterThan(0);
  });

  it('reads a video-only file without audio metadata', async () => {
    if (!hasFfmpeg) return;
    const path = await makeVideoFixture('noaudio', { withAudio: false });
    if (path === undefined) return;
    const { meta } = await probeMedia(path);
    expect(meta.audioCodec).toBeUndefined();
  });

  it('reads a rotated phone video with corrected display dimensions', async () => {
    if (!hasFfmpeg) return;
    const path = await makeVideoFixture('rotated', { width: 640, height: 360, rotation: 90 });
    if (path === undefined) return;
    const { meta } = await probeMedia(path);
    expect(meta.rotation).toBe(90);
    expect(meta.displayWidth).toBe(meta.height);
    expect(meta.displayHeight).toBe(meta.width);
  });

  it('rejects a non-media file with a typed error', async () => {
    const path = await makeRawFixture('notes.txt', 'this is definitely not a video');
    await expect(probeMedia(path)).rejects.toMatchObject({ code: ErrorCode.INSPECTION_FAILED });
  });

  it('rejects a corrupt file with a typed error', async () => {
    if (!hasFfmpeg) return;
    // A truncated MP4: real header, missing body.
    const path = await makeRawFixture(
      'corrupt.mp4',
      Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]),
    );
    await expect(probeMedia(path)).rejects.toMatchObject({ code: ErrorCode.INSPECTION_FAILED });
  });

  it('reports a missing file rather than throwing something opaque', async () => {
    await expect(probeMedia('/nonexistent/definitely-not-here.mp4')).rejects.toMatchObject({
      code: ErrorCode.INSPECTION_FAILED,
    });
  });

  it('rejects an audio-only file, which cannot be subtitled', async () => {
    if (!hasFfmpeg) return;
    // An MP4 with only an audio stream.
    const path = await makeVideoFixture('audioonly', { withAudio: true });
    if (path === undefined) return;
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-vn',
      '-c:a',
      'aac',
      path,
    ]);

    await expect(probeMedia(path)).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_MEDIA });
  });
});
