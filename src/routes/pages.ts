import { Router } from 'express';
import * as repo from '../db/repo.js';
import * as views from '../views/pages.js';
import { serverInfo } from '../services/ai.js';
import { config } from '../config.js';
import { daysSince, rag, type Interaction } from '../types.js';

export const pages = Router();

function intsByTrr(): Map<string, Interaction[]> {
  const m = new Map<string, Interaction[]>();
  for (const i of repo.allInteractions()) {
    if (!m.has(i.trrId)) m.set(i.trrId, []);
    m.get(i.trrId)!.push(i);
  }
  for (const list of m.values()) list.sort((a, b) => b.date.localeCompare(a.date));
  return m;
}

pages.get('/', (req, res) => {
  const filter = String(req.query.f ?? 'all');
  const backlog = repo.interactionsNeedingExec(500).length;
  res.send(views.dashboard(repo.listTrrs('active'), intsByTrr(), repo.getSettings(), filter, backlog));
});

pages.get('/trr/new', (_req, res) => res.send(views.newTrrPage(repo.getSettings())));

pages.get('/trr/:id', (req, res) => {
  const t = repo.getTrr(req.params.id);
  if (!t) return res.status(404).send(views.notFound());
  res.send(views.trrDetail(t, repo.listInteractions(t.id), repo.getSettings(),
    repo.getDigest(t.id), repo.listHistory(t.id)));
});

pages.get('/trr/:id/edit', (req, res) => {
  const t = repo.getTrr(req.params.id);
  if (!t) return res.status(404).send(views.notFound());
  res.send(views.editTrrPage(t, repo.getSettings()));
});

pages.get('/trr/:id/log', (req, res) => {
  const t = repo.getTrr(req.params.id);
  if (!t) return res.status(404).send(views.notFound());
  res.send(views.logInteractionPage(t));
});

pages.get('/interactions/:id/edit', (req, res) => {
  const i = repo.getInteraction(req.params.id);
  const t = i && repo.getTrr(i.trrId);
  if (!i || !t) return res.status(404).send(views.notFound());
  res.send(views.editInteractionPage(t, i));
});

pages.get('/archive', (_req, res) => {
  res.send(views.archive(repo.listTrrs('closed'), intsByTrr()));
});

pages.get('/digests', (_req, res) => {
  res.send(views.digests(repo.listDigests()));
});

pages.get('/stats', (_req, res) => {
  res.send(views.stats(repo.listTrrs('all'), repo.allInteractions(), repo.getSettings()));
});

pages.get('/reports', (_req, res) => {
  const s = repo.getSettings();
  const act = repo.listTrrs('active');
  const byTrr = intsByTrr();
  const lines = act
    .sort((a, b) => (a.deactivated === b.deactivated ? 0 : a.deactivated ? 1 : -1))
    .map(t => {
      const r = rag(t.lastContact, s).toUpperCase();
      const its = byTrr.get(t.id) ?? [];
      const week = its.filter(i => daysSince(i.date) <= 7);
      return `${t.deactivated ? '[DEACT] ' : ''}[${r}] ${t.customer} — ${t.title}\n` +
        `  Status: ${t.status} | ${t.complexity} | ${t.priority}${t.myRole ? ` | role: ${t.myRole}` : ''}\n` +
        `  Last: ${t.lastContact || 'Never'}${t.lastContact ? ` (${daysSince(t.lastContact)}d)` : ''}\n` +
        `  This week: ${week.length ? week.map(i => `${i.type}(${i.date})`).join(', ') : 'No activity'}\n`;
    });
  const weekly = `TR Weekly Report — ${new Date().toISOString().slice(0, 10)}\n${'='.repeat(45)}\n` +
    `Active: ${act.length} | Stalled: ${act.filter(t => !t.deactivated && rag(t.lastContact, s) === 'red').length}` +
    ` | Deactivated: ${act.filter(t => t.deactivated).length}\n\n${lines.join('\n')}`;
  res.send(views.reports(weekly, repo.listPeriodReports()));
});

pages.get('/reports/p/:id', (req, res) => {
  const r = repo.getPeriodReport(Number(req.params.id));
  if (!r) return res.status(404).send(views.notFound());
  const d = JSON.parse(r.statsJson) as import('../services/digest.js').PeriodDigest;
  d.narrative = r.narrative;
  d.narrativeModel = r.meta.model;
  res.send(views.periodReportPage(r.meta, d));
});

pages.get('/search', (_req, res) => res.send(views.searchPage(repo.getSettings().aiEnabled)));

pages.get('/review', (_req, res) => {
  const trrs = repo.listTrrs('all').filter(t => t.customer.toLowerCase() !== 'test')
    .sort((a, b) => a.customer.localeCompare(b.customer));
  res.send(views.reviewPage(trrs, repo.listReviews(), repo.getSettings()));
});

pages.get('/review/:id', (req, res) => {
  const r = repo.getReview(Number(req.params.id));
  if (!r) return res.status(404).send(views.notFound());
  const meta = repo.listReviews().find(m => m.id === r.id);
  res.send(views.reviewViewPage(r, meta?.scopeSummary ?? ''));
});

pages.get('/settings', async (_req, res) => {
  const info = await serverInfo(); // null when unreachable
  const c = repo.counts();
  res.send(views.settingsPage(repo.getSettings(), config.aiUrl, info?.models ?? null, info?.style, {
    trrs: c.trrs, interactions: c.interactions, digests: c.digests,
    seeded: repo.seededTrrIds().length,
  }));
});
