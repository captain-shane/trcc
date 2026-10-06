import { Router } from 'express';
import * as repo from '../db/repo.js';
import * as views from '../views/pages.js';
import { serverInfo } from '../services/ai.js';
import { config } from '../config.js';
import { daysSince, rag, type Interaction, type Trr } from '../types.js';
import { buildDesk, aggregateText, deskCounts, currentCycleDue, deskRow } from '../services/updates.js';
import { isValidDay } from '../services/cycle.js';
import type { TrrFormCtx } from '../views/components.js';

export const pages = Router();

/** Options for the TR form that depend on the chosen customer. */
export function formCtx(customerName: string, trrId?: string): TrrFormCtx {
  const cust = customerName ? repo.findCustomerByName(customerName) : null;
  const all = repo.listTrrs('all');
  const closed = repo.getSettings().closedStatuses;
  return {
    customers: repo.listCustomers(),
    opps: cust ? repo.listOpportunities(cust.id) : [],
    parents: cust
      ? all.filter(t => t.customerId === cust.id && !t.parentId && t.id !== trrId && !closed.includes(t.status))
          .sort((a, b) => a.num - b.num)
      : [],
    hasChildren: trrId ? all.some(t => t.parentId === trrId) : false,
  };
}

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
  const g = String(req.query.g ?? 'family');
  const group = g === 'customer' || g === 'flat' ? g : 'family';
  const backlog = repo.interactionsNeedingExec(500).length;
  const s = repo.getSettings();
  const active = repo.listTrrs('active');
  const desk = buildDesk();
  const c = deskCounts(desk);
  res.send(views.dashboard(active, intsByTrr(), s, filter, backlog, {
    group,
    opps: new Map(repo.listOpportunities().map(o => [o.id, o])),
    customers: new Map(repo.listCustomers().map(x => [x.id, x])),
    kids: repo.childrenIndex(active),
    updatesDue: c.due + c.overdue,
    cycleDue: desk.cycleDue,
  }));
});

/** TRs a log on `t` could also apply to: its family first, then the rest of the customer's open TRs. */
function relatedTrrs(t: Trr): Trr[] {
  const closed = repo.getSettings().closedStatuses;
  const familyRoot = t.parentId || t.id;
  return repo.listTrrs('all')
    .filter(x => x.customerId === t.customerId && x.id !== t.id && (!closed.includes(x.status) || x.id === familyRoot))
    .sort((a, b) => {
      const fa = a.id === familyRoot || a.parentId === familyRoot ? 0 : 1;
      const fb = b.id === familyRoot || b.parentId === familyRoot ? 0 : 1;
      return fa - fb || a.num - b.num;
    });
}

pages.get('/trr/new', (req, res) => {
  const s = repo.getSettings();
  const draft: Partial<Trr> = {};
  const parent = req.query.parent ? repo.getTrr(String(req.query.parent)) : null;
  const opp = req.query.opp ? repo.getOpportunity(String(req.query.opp)) : null;
  const cust = req.query.customer ? repo.getCustomer(String(req.query.customer)) : null;
  if (parent && !parent.parentId) {
    // a child starts as a copy of its parent's context
    Object.assign(draft, {
      parentId: parent.id, customer: parent.customer, opportunityId: parent.opportunityId,
      contact: parent.contact, rep: parent.rep, myRole: parent.myRole, complexity: parent.complexity,
      priority: parent.priority, valueThemes: parent.valueThemes,
    });
  } else if (opp) {
    Object.assign(draft, { customer: repo.getCustomer(opp.customerId)?.name ?? '', opportunityId: opp.id, rep: opp.rep });
  } else if (cust) {
    draft.customer = cust.name;
  }
  res.send(views.newTrrPage(s, draft, formCtx(draft.customer ?? '')));
});

pages.get('/trr/:id', (req, res) => {
  const t = repo.getTrr(req.params.id);
  if (!t) return res.status(404).send(views.notFound());
  const s = repo.getSettings();
  const children = repo.listChildren(t.id);
  const includeChildren = children.length > 0 && req.query.own !== '1';
  const ints = repo.interactionsFor(includeChildren ? [t.id, ...children.map(c => c.id)] : [t.id]);
  const owners = new Map(repo.listTrrs('all').map(x => [x.id, x]));
  const cycleDue = currentCycleDue(s);
  res.send(views.trrDetail(t, ints, s, repo.getDigest(t.id), repo.listHistory(t.id), {
    customer: t.customerId ? repo.getCustomer(t.customerId) : null,
    opp: t.opportunityId ? repo.getOpportunity(t.opportunityId) : null,
    parent: t.parentId ? repo.getTrr(t.parentId) : null,
    children, related: relatedTrrs(t), owners, links: repo.allInteractionLinks(), includeChildren,
    summaries: { trr: repo.listSummaries('trr', t.id), family: children.length ? repo.listSummaries('family', t.id) : [] },
    deskRow: deskRow(t.id, cycleDue), cycleDue, updates: repo.listUpdates(t.id),
  }));
});

pages.get('/trr/:id/edit', (req, res) => {
  const t = repo.getTrr(req.params.id);
  if (!t) return res.status(404).send(views.notFound());
  res.send(views.editTrrPage(t, repo.getSettings(), formCtx(t.customer, t.id)));
});

pages.get('/trr/:id/log', (req, res) => {
  const t = repo.getTrr(req.params.id);
  if (!t) return res.status(404).send(views.notFound());
  res.send(views.logInteractionPage(t, relatedTrrs(t)));
});

pages.get('/interactions/:id/edit', (req, res) => {
  const i = repo.getInteraction(req.params.id);
  const t = i && repo.getTrr(i.trrId);
  if (!i || !t) return res.status(404).send(views.notFound());
  res.send(views.editInteractionPage(t, i, relatedTrrs(t), repo.interactionLinks(i.id)));
});

pages.get('/accounts', (_req, res) => {
  res.send(views.accountsPage(repo.listCustomers(), repo.listTrrs('all'), repo.listOpportunities(), repo.getSettings()));
});

pages.get('/customer/:id', (req, res) => {
  const c = repo.getCustomer(req.params.id);
  if (!c) return res.status(404).send(views.notFound());
  res.send(views.customerPage(c, repo.listCustomers(), repo.listOpportunities(c.id),
    repo.listTrrs('all').filter(t => t.customerId === c.id), repo.getSettings(), repo.listSummaries('customer', c.id)));
});

pages.get('/opp/:id', (req, res) => {
  const o = repo.getOpportunity(req.params.id);
  const c = o && repo.getCustomer(o.customerId);
  if (!o || !c) return res.status(404).send(views.notFound());
  res.send(views.oppPage(o, c, repo.listTrrs('all').filter(t => t.opportunityId === o.id), repo.getSettings(),
    repo.listSummaries('opportunity', o.id)));
});

pages.get('/updates', (req, res) => {
  const q = String(req.query.cycle ?? '');
  const desk = buildDesk(isValidDay(q) ? q : undefined);
  const f = String(req.query.f ?? 'all');
  res.send(views.updateDesk(desk, repo.getSettings(), deskCounts(desk), aggregateText(desk),
    ['needs', 'posted', 'quiet'].includes(f) ? f : 'all'));
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
  const { listBackups } = await import('../services/backup.js');
  const info = await serverInfo(); // null when unreachable
  const c = repo.counts();
  res.send(views.settingsPage(repo.getSettings(), config.aiUrl, info?.models ?? null, info?.style, {
    trrs: c.trrs, interactions: c.interactions, digests: c.digests,
    seeded: repo.seededTrrIds().length,
    backups: listBackups(),
  }));
});
