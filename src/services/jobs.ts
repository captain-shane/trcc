import { uid } from '../types.js';

// Generic background jobs for work that outlives a browser request (bulk weekly
// drafts, large summaries). Same model as the review runner: in-memory, the page
// polls for progress, and the RESULT is always persisted by the job itself — so a
// restart loses only the progress bar, never finished work.

export interface JobProgress { done: number; total: number; phase: string }

export interface Job {
  id: string;
  kind: string;
  key: string;          // de-duplication key: one running job per key
  label: string;
  status: 'running' | 'done' | 'error';
  progress: JobProgress;
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
}

const jobs = new Map<string, Job>();
const RETAIN_MS = 60 * 60_000;

function sweep(): void {
  const cutoff = Date.now() - RETAIN_MS;
  for (const [id, j] of jobs) if (j.finishedAt && j.finishedAt < cutoff) jobs.delete(id);
}

/** Start a job, or return the id of the one already running under the same key. */
export function startJob(
  kind: string, key: string, label: string, total: number,
  run: (progress: (p: JobProgress) => void) => Promise<unknown>,
): string {
  sweep();
  for (const j of jobs.values()) if (j.key === key && j.status === 'running') return j.id;
  const job: Job = {
    id: uid(), kind, key, label, status: 'running', startedAt: Date.now(),
    progress: { done: 0, total, phase: 'starting' },
  };
  jobs.set(job.id, job);
  void (async () => {
    try {
      job.result = await run(p => { job.progress = p; });
      job.status = 'done';
    } catch (e) {
      job.status = 'error';
      job.error = (e as Error).message;
    } finally {
      job.finishedAt = Date.now();
    }
  })();
  return job.id;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function jobSeconds(j: Job): number {
  return Math.round(((j.finishedAt ?? Date.now()) - j.startedAt) / 1000);
}
