/**
 * FFmpeg adapter: application intent → safe argv → process → structured result.
 *
 * ## This is the only place FFmpeg argv is constructed
 *
 * Nothing above this module knows what `-c:a pcm_s16le` means. Callers say "extract audio"
 * and pass paths; this module decides the flags. That matters for security: an argument
 * array built from a known, fixed flag list plus server-generated paths cannot be steered
 * by a filename, because the filename is never parsed, interpolated, or passed to a shell.
 *
 * ## stderr is not a failure signal
 *
 * FFmpeg writes banners, warnings, and progress to stderr on *successful* runs. Treating
 * stderr as failure would mark good extractions as broken. Success here is decided by exit
 * status plus an explicit output-existence check, and stderr is kept only as a diagnostic
 * tail (S-7: bounded, so a pathological log cannot exhaust memory).
 *
 * ## Cancellation
 *
 * `AbortSignal` kills the child with SIGTERM, then SIGKILL after a grace period. FFmpeg
 * writes its output incrementally, so a killed run can leave a partial file — the caller is
 * responsible for validating output before promoting it, and for deleting it otherwise.
 */

import { spawn } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';

import { ErrorCode, IngestError } from '../errors.js';
import {
  initialProgressState,
  parseProgressLine,
  progressFromSample,
  type ProgressParserState,
} from '../../core/jobs/progress.js';
import type { JobProgress } from '../../core/jobs/types.js';

export interface RunFfmpegOptions {
  /** Absolute input path. Must already be inside the controlled workspace. */
  inputPath: string;
  /** Absolute output path. Written to a temp path by the caller and renamed on success. */
  outputPath: string;
  /** The `-progress` sink path. FFmpeg overwrites it; read it incrementally via the fd. */
  progressPath: string;
  /** Extra output flags, appended verbatim. Never user-supplied. */
  outputArgs: readonly string[];
  /** Source duration in microseconds, used to turn out_time into a ratio. */
  sourceDurationUs?: number;
  /** Wall-clock cap. Guards against a pathological input hanging the worker forever. */
  timeoutMs?: number;
  /** Cancellation. Aborting kills the child. */
  signal?: AbortSignal;
  onProgress?: (progress: JobProgress) => void;
}

/** Keep only the tail; a full FFmpeg log is unbounded and we only need the error. */
const STDERR_TAIL_BYTES = 8000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 2000;
const PROGRESS_POLL_MS = 100;
/**
 * Threads per ffmpeg process.
 *
 * Paired with the worker's single-slot concurrency: two threads for one job means the machine
 * stays usable while a job runs, which matters because the user is watching the same video in
 * the browser at the same time.
 */
const THREADS_PER_PROCESS = 2;

export interface FfmpegOutcome {
  exitCode: number;
  /** True only when FFmpeg exited 0 AND the output file exists. */
  ok: boolean;
  /** Tail of stderr, for failure diagnostics. */
  stderrTail: string;
  /** Why the run failed, when it did. */
  failureCode?: 'tool-unavailable' | 'tool-failed' | 'output-invalid' | 'cancelled';
}

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

/**
 * Run FFmpeg to extract audio.
 *
 * The canonical output is 16 kHz mono PCM WAV. Rationale (see docs/PHASE3.md):
 *   - PCM is uncompressed, so there is no second lossy generation to degrade the signal
 *     before speech recognition sees it;
 *   - 16 kHz is the native rate of essentially every speech model, so no resampling
 *     happens inside a provider;
 *   - mono avoids a channel-layout guess on the provider side;
 *   - WAV is trivially seekable and streamable, which matters when a provider uploads by
 *     range rather than reading the whole file.
 */
export async function extractAudio(options: RunFfmpegOptions): Promise<FfmpegOutcome> {
  // `-nostdin` stops FFmpeg consuming the parent's stdin, which can otherwise make a
  // detached worker hang. `-y` overwrites the (temp) output. `-hide_banner` keeps stderr
  // to actual diagnostics. `-vn` drops video: the point of this job is audio only.
  //
  // `-threads 2` bounds each process. Unbounded, FFmpeg spawns a thread per core, so a
  // short clip saturates the whole machine and starves the browser decoding the preview the
  // user is watching. Audio-only work gains nothing meaningful past a couple of threads.
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-threads',
    String(THREADS_PER_PROCESS),
    '-i',
    options.inputPath,
    '-vn',
    ...options.outputArgs,
    // Output file first, then the global -progress flag: FFmpeg requires an output
    // operand, and putting the flag last (with no file after it) makes it parse as one.
    '-progress',
    options.progressPath,
    options.outputPath,
  ];

  return runFfmpeg(args, options);
}

function runFfmpeg(args: string[], options: RunFfmpegOptions): Promise<FfmpegOutcome> {
  return new Promise<FfmpegOutcome>((resolve) => {
    if (options.signal?.aborted === true) {
      resolve({
        exitCode: -1,
        ok: false,
        stderrTail: '',
        failureCode: 'cancelled',
      });
      return;
    }

    let child;
    try {
      child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (cause) {
      // Thrown synchronously only when the binary cannot be spawned at all.
      resolve({
        exitCode: -1,
        ok: false,
        stderrTail: cause instanceof Error ? cause.message : 'ffmpeg could not be started',
        failureCode: 'tool-unavailable',
      });
      return;
    }

    let stderr = '';
    let parserState: ProgressParserState = initialProgressState();
    let settled = false;
    let cancelled = false;

    // FFmpeg writes `-progress` output to a file, not to stdout. So progress is read by
    // tracking how much of that file has been consumed and pulling only the new bytes on
    // each chunk. Reading the file whole would miss anything still in flight; re-reading
    // it whole on every tick would be quadratic.
    let progressBytesRead = 0;
    const drainProgress = (): void => {
      if (options.onProgress === undefined) {
        return;
      }
      let handle: number | undefined;
      try {
        handle = openSync(options.progressPath, 'r');
        const size = fstatSync(handle).size;
        if (size <= progressBytesRead) {
          return;
        }
        const length = size - progressBytesRead;
        const buffer = Buffer.alloc(length);
        const read = readSync(handle, buffer, 0, length, progressBytesRead);
        progressBytesRead += read;
        for (const line of buffer.subarray(0, read).toString().split('\n')) {
          if (line.trim() === '') {
            continue;
          }
          const parsed = parseProgressLine(line, parserState);
          parserState = parsed.state;
          const progress = progressFromSample(parsed.sample, options.sourceDurationUs);
          if (progress !== undefined) {
            options.onProgress(progress);
          }
        }
      } catch {
        // The progress file is best-effort: it may not exist yet on the first tick. A
        // missing progress file must never fail the run, only remove progress reporting.
      } finally {
        if (handle !== undefined) {
          try {
            closeSync(handle);
          } catch {
            /* closing a read handle on a file FFmpeg is writing is not worth failing over */
          }
        }
      }
    };

    // A fixed 100ms tick. Not event-driven: FFmpeg does not notify us when it rewrites the
    // progress file, and an fs.watch dependency would be a lot of machinery for a cosmetic
    // update. 100ms is well below the threshold where a progress bar looks laggy, and it
    // keeps the loop cost negligible because the work is measured in tens of reads.
    const progressTimer =
      options.onProgress === undefined
        ? undefined
        : setInterval(() => drainProgress(), PROGRESS_POLL_MS);
    progressTimer?.unref?.();

    const finish = (outcome: FfmpegOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (progressTimer !== undefined) {
        clearInterval(progressTimer);
      }
      cleanup();
      resolve(outcome);
    };

    // Read progress from a file FFmpeg is writing. We tail it by reading on each write
    // signal rather than inotify, which keeps this portable and avoids a dependency.
    const onCancel = (): void => {
      cancelled = true;
      child.kill('SIGTERM');
      // A wedged FFmpeg ignores SIGTERM (e.g. blocked on I/O); escalate so cancellation
      // always terminates rather than waiting on the timeout.
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
    };
    options.signal?.addEventListener('abort', onCancel, { once: true });

    const timeout = setTimeout(() => {
      onCancel();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref?.();

    const cleanup = (): void => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onCancel);
    };

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = tail(stderr + chunk.toString(), STDERR_TAIL_BYTES);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: -1,
        ok: false,
        stderrTail: stderr || error.message,
        failureCode: error.code === 'ENOENT' ? 'tool-unavailable' : 'tool-failed',
      });
    });

    child.on('close', (code) => {
      // One last read: FFmpeg's final progress block is often written moments before it
      // exits, so without this the last sampled value can be slightly stale.
      drainProgress();
      if (cancelled) {
        finish({ exitCode: code ?? -1, ok: false, stderrTail: stderr, failureCode: 'cancelled' });
        return;
      }
      if (code !== 0) {
        finish({
          exitCode: code ?? -1,
          ok: false,
          stderrTail: stderr,
          failureCode: 'tool-failed',
        });
        return;
      }
      // Exit 0 is necessary but not sufficient: FFmpeg can report success having written
      // nothing usable. The output must exist before the job may claim success.
      if (!existsSync(options.outputPath)) {
        finish({
          exitCode: code,
          ok: false,
          stderrTail: stderr,
          failureCode: 'output-invalid',
        });
        return;
      }
      finish({ exitCode: code, ok: true, stderrTail: stderr });
    });
  });
}

/** Map an FFmpeg outcome onto the shared server error type. */
export function outcomeToError(outcome: FfmpegOutcome, what: string): IngestError {
  const message =
    outcome.failureCode === 'tool-unavailable'
      ? 'ffmpeg is not available on this machine.'
      : outcome.failureCode === 'output-invalid'
        ? `ffmpeg reported success but produced no usable ${what}.`
        : `ffmpeg failed while ${what}.`;

  const code =
    outcome.failureCode === 'tool-unavailable'
      ? ErrorCode.TOOL_UNAVAILABLE
      : outcome.failureCode === 'output-invalid'
        ? ErrorCode.OUTPUT_INVALID
        : ErrorCode.PROCESSING_FAILED;

  return new IngestError(code, message, { cause: { exitCode: outcome.exitCode } });
}
