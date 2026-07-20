import { Router } from 'express';
import * as repo from '../db/repo.js';
import { computePeriodDigest } from '../services/digest.js';
import { listModels } from '../services/ai.js';

// JSON API for scripts, exports, and automation. Read-mostly by design;
// mutation happens through the app forms.

export const api = Router();

api.get('/export', (_req, res) => {
  res.json({
    exportedAt: new Date().toISOString(),
    trrs: repo.listTrrs('all'),
    interactions: repo.allInteractions(),
    digests: repo.listDigests(),
    history: repo.allHistory(),
    periodReports: repo.listPeriodReports().map(m => repo.getPeriodReport(m.id)),
    reviews: repo.listReviews().map(m => repo.getReview(m.id)),
    settings: repo.getSettings(),
  });
});

api.get('/trrs', (_req, res) => res.json(repo.listTrrs('all')));

api.get('/trr/:id', (req, res) => {
  const t = repo.getTrr(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json({ ...t, interactions: repo.listInteractions(t.id) });
});

api.get('/digest', (req, res) => {
  const from = req.query.from ? String(req.query.from) : undefined;
  const to = req.query.to ? String(req.query.to) : undefined;
  res.json(computePeriodDigest(from, to));
});

api.get('/reports', (_req, res) => {
  res.json({
    reports: repo.listDigests().map(({ summary, ...meta }) => ({ ...meta, chars: summary.length })),
  });
});

api.get('/backups', async (_req, res) => {
  const { listBackups } = await import('../services/backup.js');
  res.json({ backups: listBackups() }); // newest first; download at /data/backups/<name>
});

api.get('/models', async (_req, res) => {
  try {
    res.json({ models: await listModels() });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});
