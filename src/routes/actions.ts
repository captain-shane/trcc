import { Router } from 'express';
import * as repo from '../db/repo.js';
import * as views from '../views/pages.js';
import { interactionCard, digestBlock, errorBox, jobProgress, summaryBlock, trrLinksFragment, updateRowCard } from '../views/components.js';
import { formCtx } from './pages.js';
import { HierarchyError } from '../db/repo.js';
import { getJob } from '../services/jobs.js';
import { planSummary, startSummaryJob } from '../services/summary.js';
import {
  aggregateText, buildDesk, deskCounts, deskRow, draftUpdate, plainDraft, postUpdate,
  saveDraftText, startBulkDrafts, unpostUpdate,
} from '../services/updates.js';
import { isValidDay } from '../services/cycle.js';
import { enrichExecSummaries, periodDigest, queueArchivalDigest, trrDigest } from '../services/digest.js';
import { planReview } from '../services/review.js';
import { getReviewJob, startReview } from '../services/reviewJob.js';
import { fillTemplate, generate } from '../services/ai.js';
import { semanticSearch, textSearch } from '../services/search.js';
import {
  COMPLEXITIES, INTERACTION_TYPES, PRIORITIES, UPDATE_CADENCES,
  uid, type Interaction, type NewTrr, type Settings, type SummaryScopeKind, type Trr,
} from '../types.js';
import { esc } from '../views/html.js';

export const actions = Router();

// --- form parsing helpers ---------------------------------------------------

function pick<T extends string>(v: unknown, domain: readonly T[], fallback: T): T {
  return domain.includes(v as T) ? (v as T) : fallback;
}

function pickStr(v: unknown, domain: string[], fallback: string): string {
  return domain.includes(String(v)) ? String(v) : fallback;
}

function pickOrEmpty(v: unknown, domain: string[]): string {
  return domain.includes(String(v)) ? String(v) : '';
}

function str(v: unknown, max = 10_000): string {
  return String(v ?? '').slice(0, max).trim();
}

function themesFromForm(v: unknown, domain: string[]): string[] {
  // checkbox group: absent, single string, or array of strings
  const raw = (v == null ? [] : Array.isArray(v) ? v : [v]).map(String);
  return domain.filter(t => raw.includes(t));
}

function trrFromForm(body: Record<string, unknown>, s: Settings, existing?: Trr): NewTrr & Pick<Trr, 'customerId' | 'opportunityId' | 'parentId' | 'externalId' | 'updateCadence'> {
  const customer = str(body.customer, 200);
  return {
    id: existing?.id ?? uid(),
    customer,
    // typing a different customer name moves the TR; the repo resolves / creates it
    customerId: existing && existing.customer.toLowerCase() === customer.toLowerCase() ? existing.customerId : '',
    opportunityId: str(body.opportunityId, 64),
    parentId: str(body.parentId, 64),
    externalId: str(body.externalId, 100),
    updateCadence: pickOrEmpty(body.updateCadence, [...UPDATE_CADENCES]) as Trr['updateCadence'],
    title: str(body.title, 300),
    status: pickStr(body.status, s.statuses, existing?.status ?? s.statuses[0] ?? 'New'),
    complexity: pick(body.complexity, COMPLEXITIES, existing?.complexity ?? 'Simple'),
    priority: pick(body.priority, PRIORITIES, existing?.priority ?? 'Medium'),
    contact: str(body.contact, 200),
    rep: str(body.rep, 200),
    targetClose: str(body.targetClose, 10),
    description: str(body.description, 50_000),
    myRole: pickOrEmpty(body.myRole, s.roles),
    outcome: pickOrEmpty(body.outcome, s.outcomes),
    valueThemes: themesFromForm(body.valueThemes, s.themes),
    deactivated: existing?.deactivated ?? false,
    deactivatedAt: existing?.deactivatedAt ?? '',
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastContact: existing?.lastContact ?? '',
  };
}

// --- TRR CRUD ---------------------------------------------------------------

/** "+ New opportunity…" in the TR form: create it under the TR's customer first. */
function resolveNewOpportunity(t: { customer: string; opportunityId: string; parentId: string }, body: Record<string, unknown>): void {
  if (t.opportunityId !== '__new') return;
  t.opportunityId = '';
  const name = str(body.newOpportunity, 200);
  if (!name || t.parentId) return; // a child takes its parent's opportunity anyway
  const cust = repo.ensureCustomer(t.customer);
  t.opportunityId = repo.insertOpportunity({ customerId: cust.id, name, stage: '', rep: '', closeDate: '', notes: '' }).id;
}

actions.post('/trr', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const s = repo.getSettings();
  const t = trrFromForm(b, s);
  if (!t.customer || !t.title) return res.status(400).send(views.newTrrPage(s, t, { ...formCtx(t.customer), error: 'Customer and title are required.' }));
  try {
    resolveNewOpportunity(t, b);
    repo.insertTrr(t);
  } catch (e) {
    if (!(e instanceof HierarchyError)) throw e;
    return res.status(400).send(views.newTrrPage(s, t, { ...formCtx(t.customer), error: e.message }));
  }
  res.redirect(303, `/trr/${t.id}`);
});

function maybeArchivalDigest(s: Settings, before: Trr, afterStatus: string): void {
  // Newly archived → auto-generate + store a catch-up digest in the background.
  if (s.aiEnabled && afterStatus === s.archivedStatus && before.status !== s.archivedStatus) {
    queueArchivalDigest(before.id);
  }
}

actions.post('/trr/:id', (req, res) => {
  const existing = repo.getTrr(req.params.id);
  if (!existing) return res.status(404).send(views.notFound());
  const s = repo.getSettings();
  const b = req.body as Record<string, unknown>;
  const t = trrFromForm(b, s, existing);
  try {
    resolveNewOpportunity(t, b);
    repo.updateTrr(existing.id, t);
  } catch (e) {
    if (!(e instanceof HierarchyError)) throw e;
    return res.status(400).send(views.editTrrPage(existing, s, { ...formCtx(t.customer, existing.id), error: e.message }, t));
  }
  maybeArchivalDigest(s, existing, t.status);
  res.redirect(303, `/trr/${existing.id}`);
});

// Inline edits from the TR page — one field, saved on change.
const QUICK_FIELDS = ['status', 'priority', 'outcome', 'myRole'] as const;
actions.post('/trr/:id/quick', (req, res) => {
  const t = repo.getTrr(req.params.id);
  if (!t) return res.status(404).send('');
  const s = repo.getSettings();
  const b = req.body as Record<string, unknown>;
  const key = QUICK_FIELDS.find(k => b[k] !== undefined);
  if (!key) return res.send(views.quickControls(t, s));
  const v = String(b[key]);
  const domain: Record<typeof key, string[]> = {
    status: s.statuses, priority: [...PRIORITIES], outcome: ['', ...s.outcomes], myRole: ['', ...s.roles],
  };
  if (!domain[key].includes(v)) return res.send(views.quickControls(t, s));
  repo.updateTrr(t.id, { [key]: v } as Partial<Trr>);
  if (key === 'status') maybeArchivalDigest(s, t, v);
  res.setHeader('HX-Trigger', 'trr-changed');
  res.send(views.quickControls(repo.getTrr(t.id)!, s, `${key === 'myRole' ? 'role' : key} saved`));
});

actions.post('/trr/:id/delete', (req, res) => {
  repo.deleteTrr(req.params.id);
  res.redirect(303, '/');
});

actions.post('/trr/:id/toggle-active', (req, res) => {
  const t = repo.getTrr(req.params.id);
  if (!t) return res.status(404).send(views.notFound());
  const now = new Date();
  const flag = !t.deactivated;
  repo.updateTrr(t.id, { deactivated: flag, deactivatedAt: flag ? now.toISOString() : '' });
  repo.insertInteraction({
    id: uid(), trrId: t.id, type: 'Note', date: now.toISOString().slice(0, 10),
    note: `[${flag ? 'DEACTIVATED' : 'REACTIVATED'}] TR ${flag ? 'deactivated' : 'reactivated'} on ${now.toISOString().slice(0, 10)}.`,
    aiExec: '', aiCust: '', sensitive: false, createdAt: now.toISOString(),
  });
  res.redirect(303, `/trr/${t.id}`);
});

// --- Interactions -----------------------------------------------------------

actions.post('/trr/:id/interactions', (req, res) => {
  const t = repo.getTrr(req.params.id);
  if (!t) return res.status(404).send(views.notFound());
  const b = req.body as Record<string, unknown>;
  const i: Interaction = {
    id: uid(), trrId: t.id,
    type: pick(b.type, INTERACTION_TYPES, 'Call'),
    date: str(b.date, 10) || new Date().toISOString().slice(0, 10),
    note: str(b.note, 500_000),
    aiExec: '', aiCust: '',
    sensitive: b.sensitive === 'on' || b.sensitive === '1',
    source: '',
    createdAt: new Date().toISOString(),
  };
  repo.insertInteraction(i);
  repo.setInteractionLinks(i.id, formList(b.alsoTrr));
  for (const id of [t.id, ...repo.interactionLinks(i.id)]) {
    const x = repo.getTrr(id);
    if (x && (!x.lastContact || i.date > x.lastContact)) repo.updateTrr(x.id, { lastContact: i.date });
  }
  // fire-and-forget: enrich new substantive notes with exec summaries
  if (repo.getSettings().aiEnabled) {
    enrichExecSummaries(4).catch(e => console.warn('auto-enrich:', (e as Error).message));
  }
  res.redirect(303, `/trr/${t.id}`);
});

actions.post('/interactions/:id/update', (req, res) => {
  const i = repo.getInteraction(req.params.id);
  if (!i) return res.status(404).send(views.notFound());
  const b = req.body as Record<string, unknown>;
  repo.updateInteraction(i.id, {
    type: pick(b.type, INTERACTION_TYPES, i.type),
    date: str(b.date, 10) || i.date,
    note: str(b.note, 500_000),
    sensitive: b.sensitive === 'on' || b.sensitive === '1',
  });
  repo.setInteractionLinks(i.id, formList(b.alsoTrr));
  res.redirect(303, `/trr/${i.trrId}`);
});

actions.post('/interactions/:id/delete', (req, res) => {
  const i = repo.getInteraction(req.params.id);
  if (i) repo.deleteInteraction(i.id);
  res.redirect(303, i ? `/trr/${i.trrId}` : '/');
});

const AI_OFF_MSG = '<div class="card"><div class="muted">🔌 AI features are switched off in Settings.</div></div>';

/** Generate customer + exec versions for one interaction (htmx fragment). */
actions.post('/interactions/:id/ai', async (req, res) => {
  const i = repo.getInteraction(req.params.id);
  const t = i && repo.getTrr(i.trrId);
  if (!i || !t) return res.status(404).send('');
  const s = repo.getSettings();
  if (!s.aiEnabled) return res.send(AI_OFF_MSG);
  if (i.sensitive) return res.send(interactionCard(i, { aiError: 'This log is flagged — it is never sent to AI.' }));
  const vars = {
    customer: t.customer, project: t.title, contact: t.contact,
    status: t.status, date: i.date, notes: i.note,
  };
  try {
    const aiCust = await generate(fillTemplate(s.custTmpl, vars), s.model);
    const aiExec = await generate(fillTemplate(s.execTmpl, vars), s.model);
    repo.updateInteraction(i.id, { aiCust, aiExec });
    res.send(interactionCard(repo.getInteraction(i.id)!));
  } catch (e) {
    res.send(interactionCard(i, { aiError: (e as Error).message }));
  }
});

// --- AI fragments -----------------------------------------------------------

actions.get('/fragments/trr-digest/:id', async (req, res) => {
  if (!repo.getSettings().aiEnabled) return res.send(AI_OFF_MSG);
  try {
    const regen = req.query.regen === '1';
    const d = await trrDigest(req.params.id, { regen, store: true });
    res.send(digestBlock(d, { cached: !regen && repo.getDigest(req.params.id) !== null }));
  } catch (e) {
    res.send(errorBox(`Digest failed: ${(e as Error).message}`));
  }
});

actions.get('/fragments/period-digest', async (req, res) => {
  const from = str(req.query.from, 10) || undefined;
  const to = str(req.query.to, 10) || undefined;
  // deterministic stats always work; the narrative draft needs AI enabled
  const draft = req.query.draft === '1' && repo.getSettings().aiEnabled;
  try {
    const d = await periodDigest(from, to, draft);
    res.send(views.periodDigestFragment(d));
  } catch (e) {
    res.send(errorBox(`Digest failed: ${(e as Error).message}`));
  }
});

actions.get('/fragments/search', async (req, res) => {
  const q = str(req.query.q, 500);
  const mode = req.query.mode === 'semantic' && repo.getSettings().aiEnabled ? 'semantic' : 'text';
  if (!q) return res.send('');
  try {
    const hits = mode === 'semantic' ? await semanticSearch(q) : textSearch(q);
    res.send(views.searchResults(hits, mode, q));
  } catch (e) {
    res.send(errorBox(`Search failed: ${(e as Error).message}`));
  }
});

actions.post('/ai/backfill', async (_req, res) => {
  if (!repo.getSettings().aiEnabled) return res.send(AI_OFF_MSG);
  try {
    const r = await enrichExecSummaries(8);
    if ('skipped' in r) return res.send('<div class="small muted2">A batch is already running — try again shortly.</div>');
    res.send(`<div class="small">Generated <strong>${r.generated}</strong> exec summar${r.generated === 1 ? 'y' : 'ies'} · ${r.remaining} remaining.</div>`);
  } catch (e) {
    res.send(`<div class="small danger">Backfill failed: ${esc((e as Error).message)}</div>`);
  }
});

actions.post('/reports/p/:id/delete', (req, res) => {
  repo.deletePeriodReport(Number(req.params.id));
  res.redirect(303, '/reports');
});

// --- Review engine ----------------------------------------------------------

function formList(v: unknown): string[] {
  return v == null ? [] : (Array.isArray(v) ? v : [v]).map(x => String(x));
}

/** Parse "3, 5, 9-12" into [3,5,9,10,11,12]. Ignores junk; caps range size. */
function parseNumRanges(input: string): number[] {
  const out = new Set<number>();
  for (const token of input.split(',')) {
    const t = token.trim();
    if (!t) continue;
    const range = t.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const a = parseInt(range[1]!, 10), b = parseInt(range[2]!, 10);
      if (b >= a && b - a <= 1000) for (let n = a; n <= b; n++) out.add(n);
    } else if (/^\d+$/.test(t)) {
      out.add(parseInt(t, 10));
    }
  }
  return [...out];
}

actions.post('/fragments/review', async (req, res) => {
  const sSet = repo.getSettings();
  if (!sSet.aiEnabled) return res.send(AI_OFF_MSG);
  const b = req.body as Record<string, unknown>;
  const questions = str(b.questions, 5_000)
    .split('\n').map(q => q.trim()).filter(Boolean).slice(0, 10);
  if (questions.length === 0) {
    return res.send('<div class="card"><div class="danger">Enter at least one question.</div></div>');
  }
  // TRR selection = union of checked boxes and "3, 5, 9-12" number ranges
  const nums = parseNumRanges(str(b.trrNums, 500));
  const idsFromNums = nums.length
    ? repo.listTrrs('all').filter(t => nums.includes(t.num)).map(t => t.id)
    : [];
  const scope = {
    from: str(b.from, 10) || undefined,
    to: str(b.to, 10) || undefined,
    roles: formList(b.roles).filter(r0 => sSet.roles.includes(r0)),
    themes: formList(b.themes).filter(t0 => sSet.themes.includes(t0)),
    trrIds: [...new Set([...formList(b.trrIds), ...idsFromNums])].slice(0, 500),
  };
  try {
    // Pre-flight: know the cost before committing to it.
    const plan = planReview(questions, scope);
    if (plan.overCallBudget) {
      return res.send(errorBox(
        `This run needs ${plan.totalCalls} model calls (${plan.questions} questions × ${plan.batches} record slices), ` +
        `over the limit of ${plan.maxCalls}. Narrow the scope, ask fewer questions, raise the context window in ` +
        `Settings so fewer slices are needed, or raise the call limit.`));
    }
    const jobId = startReview(questions, scope, str(b.instructions, 2_000), plan.totalCalls);
    res.send(views.reviewStartedFragment(jobId, plan));
  } catch (e) {
    res.send(errorBox(`Review failed: ${(e as Error).message}`));
  }
});

// Progress poll for a running review (the fragment re-renders itself until done).
actions.get('/fragments/review/job/:id', (req, res) => {
  const job = getReviewJob(String(req.params.id));
  if (!job) {
    return res.send(errorBox(
      'That review run is no longer tracked (the server may have restarted). Any review that finished is saved in the list below.'));
  }
  if (job.status === 'error') return res.send(errorBox(`Review failed: ${job.error ?? 'unknown error'}`));
  if (job.status === 'done' && job.result) return res.send(views.reviewResultFragment(job.result));
  res.send(views.reviewProgressFragment(job));
});

// Settings are stored as an overlay on the shipped defaults, so once a template
// has been saved it shadows the default forever — an improved default in a later
// version silently never applies. Make restoring them one click.
actions.post('/settings/templates/reset', (_req, res) => {
  const d = repo.defaultSettings();
  repo.saveSettings({
    custTmpl: d.custTmpl, execTmpl: d.execTmpl, evalTmpl: d.evalTmpl,
    trrDigestTmpl: d.trrDigestTmpl, reviewTmpl: d.reviewTmpl, reviewMapTmpl: d.reviewMapTmpl,
    updateTmpl: d.updateTmpl, summaryTmpl: d.summaryTmpl,
  });
  res.redirect(303, '/settings');
});

// Saved question sets — the same review form comes round every cycle.
actions.post('/review/sets', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const name = str(b.name, 80).trim();
  const questions = str(b.questions, 5_000).split('\n').map(q => q.trim()).filter(Boolean).slice(0, 10);
  if (name && questions.length) {
    const others = repo.getSettings().questionSets.filter(q => q.name !== name); // re-saving replaces
    repo.saveSettings({ questionSets: [...others, { name, questions }].slice(0, 25) });
  }
  res.redirect(303, '/review');
});

actions.post('/review/sets/delete', (req, res) => {
  const name = str((req.body as Record<string, unknown>).name, 80);
  repo.saveSettings({ questionSets: repo.getSettings().questionSets.filter(q => q.name !== name) });
  res.redirect(303, '/review');
});

actions.post('/review/:id/delete', (req, res) => {
  repo.deleteReview(Number(req.params.id));
  res.redirect(303, '/review');
});

// --- Backups & restore ------------------------------------------------------

import {
  backupPath, createBackup, deleteBackup, listBackups, pruneBackups,
  scheduleRestartForRestore, stageRestore,
} from '../services/backup.js';

actions.post('/data/backup-now', (_req, res) => {
  const b = createBackup();
  pruneBackups(repo.getSettings().backupKeep);
  console.log(`Backup created: ${b.name} (${b.bytes} bytes)`);
  res.redirect(303, '/settings');
});

actions.get('/data/backups/:name', (req, res) => {
  const p = backupPath(req.params.name);
  if (!p) return res.status(404).send('Not found');
  res.download(p, req.params.name);
});

actions.post('/data/backups/:name/delete', (req, res) => {
  deleteBackup(req.params.name);
  res.redirect(303, '/settings');
});

const RESTART_PAGE = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="6;url=/settings">
<body style="background:#090b10;color:#c8d0e0;font-family:sans-serif;padding:40px">
<h2>♻️ Restore staged — restarting…</h2>
<p>The app applies the snapshot on startup (a safety copy of the current database is kept in the data directory).</p>
<p>Under Docker/systemd it restarts automatically — this page reloads in a few seconds.
If you run it manually (<code>npm run dev</code>), start it again yourself.</p></body>`;

actions.post('/data/backups/:name/restore', (req, res) => {
  const r = stageRestore({ backupName: req.params.name });
  if (!r.ok) return res.status(400).send(`Restore rejected: ${r.reason}`);
  res.send(RESTART_PAGE);
  scheduleRestartForRestore();
});

/** Upload restore: raw body (see express.raw mount in server.ts). */
actions.post('/data/restore', (req, res) => {
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length < 512) {
    return res.status(400).send('Restore rejected: no file received');
  }
  const r = stageRestore(body);
  if (!r.ok) return res.status(400).send(`Restore rejected: ${r.reason}`);
  res.send('Restore staged — restarting. Refresh in ~6 seconds.');
  scheduleRestartForRestore();
});

// --- Data management --------------------------------------------------------

actions.post('/data/remove-demo', (_req, res) => {
  const n = repo.removeSeedData();
  console.log(`Removed ${n} demo TRs`);
  res.redirect(303, '/settings');
});

actions.post('/data/load-demo', async (_req, res) => {
  const { seedIfEmpty } = await import('../db/seed.js');
  seedIfEmpty();
  res.redirect(303, '/');
});

actions.post('/data/erase-all', (_req, res) => {
  repo.eraseAllData();
  console.log('All data erased via Settings');
  res.redirect(303, '/settings');
});

// --- Settings ---------------------------------------------------------------

actions.post('/settings', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const num = (v: unknown, fallback: number, min = 1) => {
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  const cur = repo.getSettings();
  const lines = (v: unknown, fallback: string[], max = 50) => {
    const parsed = str(v, 5_000).split('\n').map(x => x.trim()).filter(Boolean).slice(0, max);
    return parsed.length ? parsed : fallback; // never allow an empty taxonomy
  };
  repo.saveSettings({
    greenDays: num(b.greenDays, cur.greenDays),
    yellowDays: num(b.yellowDays, cur.yellowDays),
    archiveDays: num(b.archiveDays, cur.archiveDays),
    autoBackfillHours: num(b.autoBackfillHours, cur.autoBackfillHours, 0),
    autoBackupEnabled: b.autoBackupEnabled === '1',
    backupKeep: num(b.backupKeep, cur.backupKeep),
    aiEnabled: b.aiEnabled === '1',   // unchecked checkbox = absent = off
    statuses: lines(b.statuses, cur.statuses),
    closedStatuses: lines(b.closedStatuses, cur.closedStatuses),
    archivedStatus: str(b.archivedStatus, 100) || cur.archivedStatus,
    roles: lines(b.roles, cur.roles),
    outcomes: lines(b.outcomes, cur.outcomes),
    themes: lines(b.themes, cur.themes),
    officialTag: str(b.officialTag, 50) || cur.officialTag,
    model: str(b.model, 200) || cur.model,
    digestModel: str(b.digestModel, 200) || cur.digestModel,
    embedModel: str(b.embedModel, 200) || cur.embedModel,
    ctxTokens: num(b.ctxTokens, cur.ctxTokens, 1_024),
    fastCtxTokens: num(b.fastCtxTokens, cur.fastCtxTokens, 1_024),
    reviewReserveTokens: num(b.reviewReserveTokens, cur.reviewReserveTokens, 200),
    reviewMaxCalls: num(b.reviewMaxCalls, cur.reviewMaxCalls),
    custTmpl: str(b.custTmpl, 50_000) || cur.custTmpl,
    execTmpl: str(b.execTmpl, 50_000) || cur.execTmpl,
    evalTmpl: str(b.evalTmpl, 50_000) || cur.evalTmpl,
    trrDigestTmpl: str(b.trrDigestTmpl, 50_000) || cur.trrDigestTmpl,
    reviewTmpl: str(b.reviewTmpl, 50_000) || cur.reviewTmpl,
    reviewMapTmpl: str(b.reviewMapTmpl, 50_000) || cur.reviewMapTmpl,
    updateDueWeekday: Math.min(6, num(b.updateDueWeekday, cur.updateDueWeekday, 0)),
    updateCadence: pickStr(b.updateCadence, [...UPDATE_CADENCES], cur.updateCadence) as Settings['updateCadence'],
    logPostedUpdates: b.logPostedUpdates === '1',
    updateTmpl: str(b.updateTmpl, 50_000) || cur.updateTmpl,
    summaryTmpl: str(b.summaryTmpl, 50_000) || cur.summaryTmpl,
  });
  res.redirect(303, '/settings');
});

// --- Customers & opportunities ------------------------------------------------

function hierarchyGuard(res: import('express').Response, fn: () => void, back: string): void {
  try {
    fn();
    res.redirect(303, back);
  } catch (e) {
    if (!(e instanceof HierarchyError)) throw e;
    res.status(400).send(views.messagePage('Could not save', e.message, back));
  }
}

actions.post('/customers', (req, res) => {
  const name = str((req.body as Record<string, unknown>).name, 200);
  if (!name) return res.redirect(303, '/accounts');
  const c = repo.ensureCustomer(name);
  res.redirect(303, `/customer/${c.id}`);
});

actions.post('/customer/:id', (req, res) => {
  const b = req.body as Record<string, unknown>;
  hierarchyGuard(res, () => repo.updateCustomer(req.params.id, { name: str(b.name, 200), notes: str(b.notes, 5_000) }), `/customer/${req.params.id}`);
});

actions.post('/customer/:id/merge', (req, res) => {
  const into = str((req.body as Record<string, unknown>).into, 64);
  if (!repo.getCustomer(into)) return res.redirect(303, `/customer/${req.params.id}`);
  repo.mergeCustomer(req.params.id, into);
  res.redirect(303, `/customer/${into}`);
});

actions.post('/customer/:id/delete', (req, res) => {
  const ok = repo.deleteCustomer(req.params.id);
  res.redirect(303, ok ? '/accounts' : `/customer/${req.params.id}`);
});

actions.post('/customer/:id/opps', (req, res) => {
  const b = req.body as Record<string, unknown>;
  let id = '';
  try {
    id = repo.insertOpportunity({
      customerId: req.params.id, name: str(b.name, 200), stage: str(b.stage, 100),
      rep: str(b.rep, 200), closeDate: str(b.closeDate, 10), notes: '',
    }).id;
  } catch (e) {
    if (!(e instanceof HierarchyError)) throw e;
    return res.status(400).send(views.messagePage('Could not add opportunity', e.message, `/customer/${req.params.id}`));
  }
  res.redirect(303, `/opp/${id}`);
});

actions.post('/opp/:id', (req, res) => {
  const b = req.body as Record<string, unknown>;
  repo.updateOpportunity(req.params.id, {
    name: str(b.name, 200), stage: str(b.stage, 100), rep: str(b.rep, 200),
    closeDate: str(b.closeDate, 10), notes: str(b.notes, 5_000),
  });
  res.redirect(303, `/opp/${req.params.id}`);
});

actions.post('/opp/:id/delete', (req, res) => {
  const o = repo.getOpportunity(req.params.id);
  repo.deleteOpportunity(req.params.id);
  res.redirect(303, o ? `/customer/${o.customerId}` : '/accounts');
});

/** TR form: opportunity + parent choices for whatever customer is typed. */
actions.get('/fragments/trr-form/links', (req, res) => {
  const customer = str(req.query.customer, 200);
  const trr = str(req.query.trr, 64);
  const ctx = formCtx(customer, trr || undefined);
  res.send(trrLinksFragment({ opportunityId: str(req.query.opportunityId, 64), parentId: str(req.query.parentId, 64) }, ctx));
});

// --- Summaries to date ------------------------------------------------------------

const SCOPE_KINDS: SummaryScopeKind[] = ['trr', 'family', 'opportunity', 'customer'];

actions.post('/summaries/:kind/:id', (req, res) => {
  if (!repo.getSettings().aiEnabled) return res.send(AI_OFF_MSG);
  const kind = SCOPE_KINDS.find(k => k === req.params.kind);
  if (!kind) return res.status(404).send('');
  const full = req.query.full === '1';
  const plan = planSummary(kind, req.params.id, full);
  if (!plan) return res.send(errorBox('That scope no longer exists.'));
  if (plan.mode === 'up-to-date') {
    return res.send('<div class="small hl" role="status">✓ Already up to date — nothing new has been logged since the latest version. Use “Full rebuild” to regenerate anyway.</div>');
  }
  const jobId = startSummaryJob(kind, req.params.id, full);
  const job = getJob(jobId)!;
  res.send(jobProgress(job, `/fragments/summary-job/${jobId}?pid=${encodeURIComponent(`sum-${kind}-${req.params.id}`)}`));
});

actions.get('/fragments/summary-job/:id', (req, res) => {
  const job = getJob(String(req.params.id));
  const pid = str(req.query.pid, 120).replace(/[^\w-]/g, '');
  if (!job) return res.send(errorBox('That run is no longer tracked (the server may have restarted). Finished summaries are saved — reload the page.'));
  if (job.status === 'error') return res.send(errorBox(`Summary failed: ${job.error ?? 'unknown error'}`));
  if (job.status === 'running') return res.send(jobProgress(job, `/fragments/summary-job/${job.id}?pid=${encodeURIComponent(pid)}`));
  const sum = repo.getSummary(Number(job.result));
  if (!sum) return res.send(errorBox('Summary finished but could not be loaded — reload the page.'));
  res.send(`<div id="${pid}-out" hx-swap-oob="innerHTML">${summaryBlock(sum)}</div>
    <div class="small hl" role="status">✓ New version saved (${sum.mode}). Earlier versions are kept — reload to see the list.</div>`);
});

// --- Update Desk ---------------------------------------------------------------

function cycleParam(v: unknown): string | undefined {
  const c = str(v, 10);
  return isValidDay(c) ? c : undefined;
}

function sendRow(res: import('express').Response, trrId: string, cycleDue: string, opts: { flash?: string; error?: string; edit?: boolean } = {}): void {
  const row = deskRow(trrId, cycleDue);
  res.setHeader('HX-Trigger', 'desk-changed');
  if (!row) return void res.send(errorBox(opts.error ?? 'This TR is no longer on the desk for that cycle.'));
  const desk = buildDesk(cycleDue);
  res.send(updateRowCard(row, cycleDue, repo.getSettings().aiEnabled && desk.current, opts));
}

actions.post('/updates/:trrId/:cycle/draft', async (req, res) => {
  const cycle = cycleParam(req.params.cycle);
  if (!cycle) return res.status(400).send('');
  try {
    await draftUpdate(req.params.trrId, cycle, { useAi: req.query.plain !== '1' });
    sendRow(res, req.params.trrId, cycle, { flash: 'draft saved' });
  } catch (e) {
    sendRow(res, req.params.trrId, cycle, { error: `Draft failed: ${(e as Error).message}` });
  }
});

actions.post('/updates/:trrId/:cycle/text', (req, res) => {
  const cycle = cycleParam(req.params.cycle);
  if (!cycle) return res.status(400).send('');
  if (!repo.getTrr(req.params.trrId)) return res.status(404).send('');
  let text = str((req.body as Record<string, unknown>).text, 20_000);
  const isNew = !repo.getUpdate(req.params.trrId, cycle);
  if (!text && isNew) {
    const row = deskRow(req.params.trrId, cycle);
    text = row ? plainDraft(row) : '';
  }
  saveDraftText(req.params.trrId, cycle, text);
  sendRow(res, req.params.trrId, cycle, isNew ? { edit: true } : { flash: 'saved' });
});

actions.post('/updates/u/:id/post', (req, res) => {
  const u = postUpdate(Number(req.params.id));
  if (!u) return res.status(404).send('');
  sendRow(res, u.trrId, u.cycleDue, { flash: 'posted' });
});

actions.post('/updates/u/:id/unpost', (req, res) => {
  const u = repo.getUpdateById(Number(req.params.id));
  if (!u) return res.status(404).send('');
  unpostUpdate(u.id);
  sendRow(res, u.trrId, u.cycleDue, { flash: 'back to draft' });
});

actions.post('/updates/bulk', (req, res) => {
  if (!repo.getSettings().aiEnabled) return res.send(AI_OFF_MSG);
  const cycle = cycleParam(req.query.cycle) ?? buildDesk().cycleDue;
  const jobId = startBulkDrafts(cycle, { redoStale: req.query.stale === '1' });
  res.send(jobProgress(getJob(jobId)!, `/fragments/updates/job/${jobId}`));
});

actions.get('/fragments/updates/job/:id', (req, res) => {
  const job = getJob(String(req.params.id));
  if (!job) return res.send(errorBox('That run is no longer tracked — drafts that finished are saved. Reload the page.'));
  if (job.status === 'running') return res.send(jobProgress(job, `/fragments/updates/job/${job.id}`));
  if (job.status === 'error') return res.send(errorBox(`Bulk drafting failed: ${job.error ?? 'unknown error'}`));
  const r = job.result as { drafted: number; failed: string[] };
  res.setHeader('HX-Refresh', 'true'); // every row changed — reload the desk
  res.send(`<div class="small hl">✓ Drafted ${r.drafted}.${r.failed.length ? ` Failed: ${esc(r.failed.join('; '))}` : ''}</div>`);
});

actions.post('/updates/post-all', (req, res) => {
  const cycle = cycleParam(req.query.cycle) ?? buildDesk().cycleDue;
  for (const r of buildDesk(cycle).rows) {
    if (r.update?.status === 'draft' && r.update.text.trim()) postUpdate(r.update.id);
  }
  res.redirect(303, `/updates?cycle=${cycle}`);
});

actions.get('/fragments/updates/summary', (req, res) => {
  const desk = buildDesk(cycleParam(req.query.cycle));
  res.send(views.deskSummaryFragment(desk, deskCounts(desk), aggregateText(desk)));
});
