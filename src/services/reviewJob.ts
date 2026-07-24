import { runReview, type ReviewProgress, type ReviewResult, type ReviewScope } from './review.js';
import { uid } from '../types.js';

// A review fans out to many model calls across many record slices — minutes to
// hours, far longer than a browser request will wait. So runs happen in the
// background and the page polls for progress.
//
// Jobs are in-memory by design: the finished review is persisted by runReview
// (it shows up in the saved list either way), but a run still in flight does
// not survive a restart.

export interface ReviewJob {
  id: string;
  status: 'running' | 'done' | 'error';
  progress: ReviewProgress;
  startedAt: number;
  finishedAt?: number;
  result?: ReviewResult;
  error?: string;
}

const jobs = new Map<string, ReviewJob>();
const RETAIN_MS = 60 * 60_000; // keep finished jobs around for an hour

function sweep(): void {
  const cutoff = Date.now() - RETAIN_MS;
  for (const [id, j] of jobs) if (j.finishedAt && j.finishedAt < cutoff) jobs.delete(id);
}

export function startReview(questions: string[], scope: ReviewScope, instructions: string, total: number): string {
  sweep();
  const id = uid();
  const job: ReviewJob = {
    id, status: 'running', startedAt: Date.now(),
    progress: { done: 0, total, phase: 'starting' },
  };
  jobs.set(id, job);
  void (async () => {
    try {
      job.result = await runReview(questions, scope, instructions, p => { job.progress = p; });
      job.status = 'done';
    } catch (e) {
      job.status = 'error';
      job.error = (e as Error).message;
    } finally {
      job.finishedAt = Date.now();
    }
  })();
  return id;
}

export function getReviewJob(id: string): ReviewJob | undefined {
  return jobs.get(id);
}

/** Rough seconds elapsed — used to show a running clock alongside progress. */
export function elapsedSeconds(job: ReviewJob): number {
  return Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000);
}
