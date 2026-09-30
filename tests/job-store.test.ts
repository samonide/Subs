/**
 * Job store persistence, the single-slot worker, and crash recovery.
 *
 * The store tests are about durability: what survives a restart, and what a restart must
 * *not* leave behind. The worker tests are about the concurrency promise — one job at a time,
 * bounded, never two FFmpeg processes fighting over the same cores.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { JobStatus, JobType } from '../src/core/jobs/index.js';
import { createJobStore, createWorker } from '../src/server/jobs/store.js';
import { WorkspaceLayout } from '../src/server/workspace.js';

const scratch: string[] = [];
function workspace(): WorkspaceLayout {
  const dir = mkdtempSync(join(tmpdir(), 'subs-jobs-'));
  scratch.push(dir);
  return new WorkspaceLayout(dir);
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const NOW = '2026-01-01T00:00:00.000Z';

describe('job store', () => {
  it('persists a created job so it survives a process restart', () => {
    const layout = workspace();
    const store = createJobStore(layout);
    const job = store.create({
      projectId: 'p1',
      type: JobType.AudioExtract,
      sourceAssetId: 'a1',
      now: NOW,
    });

    // A fresh store object over the same layout stands in for a restarted process.
    const reopened = createJobStore(layout);
    expect(reopened.get(job.id)).toEqual(job);
  });

  it('lists jobs for a project and filters by project', () => {
    const layout = workspace();
    const store = createJobStore(layout);
    store.create({ projectId: 'p1', type: JobType.AudioExtract, sourceAssetId: 'a1', now: NOW });
    store.create({ projectId: 'p2', type: JobType.AudioExtract, sourceAssetId: 'a2', now: NOW });

    expect(store.list()).toHaveLength(2);
    expect(store.list('p1')).toHaveLength(1);
    expect(store.list('p1')[0]?.projectId).toBe('p1');
  });

  it('throws a typed JOB_NOT_FOUND for an unknown id', () => {
    const store = createJobStore(workspace());
    expect(() => store.get('missing')).toThrowError(/No such job/);
  });

  it('rejects a traversal id before it reaches the filesystem', () => {
    const store = createJobStore(workspace());
    expect(() => store.get('../../etc')).toThrow();
  });

  it('leaves no temp file after a save, because writes are atomic renames', () => {
    const layout = workspace();
    const store = createJobStore(layout);
    const job = store.create({
      projectId: 'p1',
      type: JobType.AudioExtract,
      sourceAssetId: 'a1',
      now: NOW,
    });
    const dir = layout.jobDir(job.id);
    expect(readdirSync(dir).filter((n) => n.includes('.tmp'))).toEqual([]);
    expect(readdirSync(dir)).toContain('job.json');
  });
});

describe('crash recovery', () => {
  it('fails jobs left mid-flight by a restart', () => {
    const layout = workspace();
    const store = createJobStore(layout);

    // Simulate a process that died mid-job: a record on disk stuck in `processing`.
    const job = store.create({
      projectId: 'p1',
      type: JobType.AudioExtract,
      sourceAssetId: 'a1',
      now: NOW,
    });
    store.update(job.id, (record) => ({ ...record, status: JobStatus.Processing }));

    const recovered = createJobStore(layout).recoverInterruptedJobs('2026-01-01T00:10:00.000Z');

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe(JobStatus.Failed);
    expect(recovered[0]?.failure?.message).toMatch(/interrupted/i);
  });

  it('fails queued jobs too, since their process is also gone', () => {
    const layout = workspace();
    const store = createJobStore(layout);
    store.create({ projectId: 'p1', type: JobType.AudioExtract, sourceAssetId: 'a1', now: NOW });

    const recovered = createJobStore(layout).recoverInterruptedJobs(NOW);
    expect(recovered[0]?.status).toBe(JobStatus.Failed);
  });

  it('leaves terminal jobs untouched', () => {
    const layout = workspace();
    const store = createJobStore(layout);
    const job = store.create({
      projectId: 'p1',
      type: JobType.AudioExtract,
      sourceAssetId: 'a1',
      now: NOW,
    });
    store.update(job.id, (record) => ({ ...record, status: JobStatus.Cancelled }));

    expect(createJobStore(layout).recoverInterruptedJobs(NOW)).toHaveLength(0);
    expect(createJobStore(layout).get(job.id).status).toBe(JobStatus.Cancelled);
  });

  it('is idempotent — recovering twice does not re-fail or throw', () => {
    const layout = workspace();
    const store = createJobStore(layout);
    const job = store.create({
      projectId: 'p1',
      type: JobType.AudioExtract,
      sourceAssetId: 'a1',
      now: NOW,
    });
    store.update(job.id, (record) => ({ ...record, status: JobStatus.Processing }));

    const first = createJobStore(layout).recoverInterruptedJobs(NOW);
    const second = createJobStore(layout).recoverInterruptedJobs(NOW);
    expect(first).toHaveLength(1);
    // The job is now terminal, so a second sweep finds nothing to do.
    expect(second).toHaveLength(0);
  });

  it('skips a job directory whose record is unreadable instead of throwing', () => {
    const layout = workspace();
    const store = createJobStore(layout);
    store.create({ projectId: 'p1', type: JobType.AudioExtract, sourceAssetId: 'a1', now: NOW });

    // A directory with no job.json models a crash during the very first write.
    mkdirSync(join(layout.jobsDir, 'orphan'), { recursive: true });

    expect(() => createJobStore(layout).recoverInterruptedJobs(NOW)).not.toThrow();
  });
});

describe('worker', () => {
  it('runs one job at a time, queueing the rest', async () => {
    const worker = createWorker(workspace());
    const order: string[] = [];

    const slow = worker.run('a', async () => {
      order.push('a:start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a:end');
    });
    const queued = worker.run('b', () => {
      order.push('b:start');
      return Promise.resolve();
    });

    // The second job must not begin until the first releases the slot.
    expect(worker.isBusy()).toBe(true);
    await Promise.all([slow, queued]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
    expect(worker.isBusy()).toBe(false);
  });

  it('reports the active job id, for diagnostics', async () => {
    const worker = createWorker(workspace());
    const running = worker.run('job-x', async () => {
      expect(worker.activeJobId()).toBe('job-x');
      await new Promise((r) => setTimeout(r, 5));
    });
    await running;
  });

  it('releases the slot even when the handler throws', async () => {
    // Otherwise one failure would wedge the queue permanently — the single most damaging
    // way this design could break.
    const worker = createWorker(workspace());
    await expect(
      worker.run('bad', () => {
        throw new Error('handler exploded');
      }),
    ).rejects.toThrow('handler exploded');

    expect(worker.isBusy()).toBe(false);
    await expect(worker.run('next', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('cancels the active job via its AbortSignal', async () => {
    const worker = createWorker(workspace());
    let seen: AbortSignal | undefined;

    const running = worker.run('c', (signal) => {
      seen = signal;
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(worker.cancel('c')).toBe(true);
    await running;
    expect(seen?.aborted).toBe(true);
  });

  it('reports false when cancelling a job that is not active', () => {
    const worker = createWorker(workspace());
    expect(worker.cancel('not-running')).toBe(false);
  });

  it('bounds concurrency to one even under load', async () => {
    const worker = createWorker(workspace());
    let concurrent = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        worker.run(`j${i}`, async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await new Promise((r) => setTimeout(r, 5));
          concurrent -= 1;
        }),
      ),
    );

    expect(peak).toBe(1);
  });
});

describe('workspace jobs directory', () => {
  it('rejects traversal in a job id before joining a path', () => {
    const layout = workspace();
    for (const bad of ['../escape', 'a/b', '..', 'with space/../x']) {
      expect(() => layout.jobFile(bad)).toThrow();
      expect(() => layout.jobDir(bad)).toThrow();
    }
  });

  it('keeps job records outside the project directory', () => {
    // Structural guarantee for I-20: a project directory can never contain a job record.
    const layout = workspace();
    expect(layout.jobsDir.startsWith(layout.projectsDir)).toBe(false);
  });

  it('creates the jobs directory on ensure', () => {
    const layout = workspace();
    layout.ensure();
    writeFileSync(join(layout.jobsDir, 'probe'), '');
    expect(readdirSync(layout.jobsDir)).toContain('probe');
  });
});
