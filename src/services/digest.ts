import * as repo from '../db/repo.js';
import { fillTemplate, generate, generateWithFallback } from './ai.js';
import type { StoredDigest, Trr } from '../types.js';

// Deterministic-first digest engine, ported from v1:
// portfolio stats are computed IN CODE; the LLM only ever writes narrative
// from those facts plus the "official record" (SFDC-tagged / timestamped
// notes — the updates that were actually reported to management).

// A note is part of the "official record" when it carries the configured tag
// (default: sfdc — configurable in Settings) or a [Name YYYY-MM-DD ... GMT]
// timestamp stamp: the updates that were actually reported upstream.
const STAMP_RE = /\[[^\]]*\d{4}-\d{2}-\d{2}[^\]]*GMT\]/;

function officialRe(): RegExp {
  const tag = repo.getSettings().officialTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${tag || 'sfdc'}\\b`, 'i');
}

export interface PeriodDigest {
  period: { from: string | null; to: string | null };
  totals: { engagements: number; interactions: number; meetings: number; officialUpdates: number };
  byStatus: Record<string, number>;
  byComplexity: Record<string, number>;
  byPriority: Record<string, number>;
  byRole: Record<string, number>;
  closedWon: string[];
  closedLost: string[];
  themeCoverage: Record<string, number>;
  perTrr: {
    customer: string; title: string; status: string; complexity: string; priority: string;
    myRole: string; valueTheme: string; interactions: number; first?: string; last?: string;
  }[];
  official: { customer: string; date: string; type: string; note: string }[];
  narrative?: string | null;
  narrativeModel?: string;
  draftNote?: string;   // e.g. quality model OOM'd, fast model stepped in
  draftError?: string;
  savedReportId?: number; // set when this run was persisted to Reports
}

export function computePeriodDigest(from?: string, to?: string, trrFilter?: (t: Trr) => boolean): PeriodDigest {
  let trrs = repo.listTrrs('all').filter(t => t.customer.toLowerCase() !== 'test');
  if (trrFilter) trrs = trrs.filter(trrFilter);
  const byId = new Map(trrs.map(t => [t.id, t]));
  const inWindow = repo.allInteractions().filter(i =>
    byId.has(i.trrId) && (!from || i.date >= from) && (!to || i.date <= to));

  const touched = new Map<string, typeof inWindow>();
  for (const i of inWindow) {
    if (!touched.has(i.trrId)) touched.set(i.trrId, []);
    touched.get(i.trrId)!.push(i);
  }
  const active = trrs.filter(t => touched.has(t.id));

  const count = (arr: Trr[], key: keyof Trr) =>
    arr.reduce<Record<string, number>>((m, t) => {
      const k = String(t[key] || '?');
      m[k] = (m[k] ?? 0) + 1;
      return m;
    }, {});

  const themeList = repo.getSettings().themes;
  const themeCoverage: Record<string, number> = {};
  for (const t of active) {
    // structured fields first; fall back to keyword scan of freetext
    const structured = t.valueThemes.filter(v => v !== 'Other');
    if (structured.length) {
      for (const theme of structured) themeCoverage[theme] = (themeCoverage[theme] ?? 0) + 1;
      continue;
    }
    const hay = `${t.description} ${t.title}`.toLowerCase();
    for (const kw of themeList) {
      if (kw !== 'Other' && hay.includes(kw.toLowerCase())) {
        themeCoverage[kw] = (themeCoverage[kw] ?? 0) + 1;
      }
    }
  }

  const tagRe = officialRe();
  const official = inWindow
    .filter(i => tagRe.test(i.note) || STAMP_RE.test(i.note))
    .map(i => ({
      customer: byId.get(i.trrId)?.customer ?? '?',
      date: i.date, type: i.type,
      note: i.note.replace(/\s+/g, ' ').trim(),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const perTrr = active.map(t => {
    const its = [...touched.get(t.id)!].sort((a, b) => a.date.localeCompare(b.date));
    return {
      customer: t.customer, title: t.title, status: t.status, complexity: t.complexity,
      priority: t.priority, myRole: t.myRole || '', valueTheme: t.valueThemes.join(', '),
      interactions: its.length, first: its[0]?.date, last: its[its.length - 1]?.date,
    };
  }).sort((a, b) => b.interactions - a.interactions);

  return {
    period: { from: from || null, to: to || null },
    totals: {
      engagements: active.length,
      interactions: inWindow.length,
      meetings: inWindow.filter(i => i.type === 'Meeting').length,
      officialUpdates: official.length,
    },
    byStatus: count(active, 'status'),
    byComplexity: count(active, 'complexity'),
    byPriority: count(active, 'priority'),
    byRole: count(active, 'myRole'),
    closedWon: active.filter(t => t.status === 'Closed Won').map(t => t.customer),
    closedLost: active.filter(t => t.status === 'Closed Lost').map(t => t.customer),
    themeCoverage, perTrr, official,
  };
}

/** Period digest + optional local-model narrative draft. */
export async function periodDigest(from?: string, to?: string, draft = true): Promise<PeriodDigest> {
  const digest = computePeriodDigest(from, to);
  if (!draft) return digest;
  const s = repo.getSettings();
  const facts = JSON.stringify({
    period: digest.period, totals: digest.totals, byStatus: digest.byStatus,
    byComplexity: digest.byComplexity, byPriority: digest.byPriority, byRole: digest.byRole,
    closedWon: digest.closedWon, closedLost: digest.closedLost, themeCoverage: digest.themeCoverage,
    engagements: digest.perTrr,
  }, null, 1);
  const officialBlock = digest.official.map(o => `- [${o.date}] ${o.customer}: ${o.note}`).join('\n');
  const prompt = fillTemplate(s.evalTmpl, { facts, official: officialBlock });
  const statsJson = JSON.stringify(digest); // pure stats snapshot, pre-narrative
  try {
    const r = await generateWithFallback(prompt, s.digestModel, s.model);
    digest.narrative = r.text;
    digest.narrativeModel = r.model;
    if (r.fellBack) digest.draftNote = `digest model (${s.digestModel}) hit GPU out-of-memory — narrative generated on ${r.model} instead`;
    // A narrative run costs real model time — persist it as a report.
    digest.savedReportId = repo.insertPeriodReport({
      fromDate: from ?? '', toDate: to ?? '', statsJson, narrative: r.text, model: r.model,
    });
  } catch (e) {
    digest.narrative = null;
    digest.draftError = (e as Error).message;
  }
  return digest;
}

/** Per-TRR "catch me up" digest. Cached in the digests table unless regen. */
export async function trrDigest(id: string, { regen = false, store = true } = {}): Promise<StoredDigest> {
  if (!regen) {
    const cached = repo.getDigest(id);
    if (cached?.summary) return cached;
  }
  const t = repo.getTrr(id);
  if (!t) throw new Error('TR not found');
  const its = [...repo.listInteractions(id)].sort((a, b) => a.date.localeCompare(b.date));
  const s = repo.getSettings();
  const prompt = fillTemplate(s.trrDigestTmpl, {
    customer: t.customer, title: t.title, status: t.status, complexity: t.complexity,
    priority: t.priority, myRole: t.myRole, valueTheme: t.valueThemes.join(', '),
    contact: t.contact, rep: t.rep,
    description: t.description.replace(/\s+/g, ' ').trim(),
    interactions: its.map(i => `[${i.date}] ${i.type}: ${i.note.replace(/\s+/g, ' ').trim()}`).join('\n'),
  });
  const r = await generateWithFallback(prompt, s.digestModel, s.model);
  const entry: StoredDigest = {
    trrId: t.id, customer: t.customer, title: t.title, status: t.status,
    interactions: its.length, first: its[0]?.date ?? '', last: its[its.length - 1]?.date ?? '',
    summary: r.text, model: r.model + (r.fellBack ? ' (fallback)' : ''),
    generatedAt: new Date().toISOString(),
  };
  if (store && r.text) repo.upsertDigest(entry);
  return entry;
}

// --- Exec-summary enrichment (on-save + backfill), serialized ---------------

let enriching = false;

export async function enrichExecSummaries(limit = 8): Promise<{ generated: number; remaining: number } | { skipped: true }> {
  if (enriching) return { skipped: true };
  enriching = true;
  let generated = 0;
  try {
    const s = repo.getSettings();
    const pending = repo.interactionsNeedingExec(limit + 200); // total queue size for "remaining"
    for (const it of pending.slice(0, limit)) {
      const t = repo.getTrr(it.trrId);
      if (!t) continue;
      const prompt = fillTemplate(s.execTmpl, {
        customer: t.customer, project: t.title, status: t.status,
        contact: t.contact, date: it.date, notes: it.note,
      });
      const text = await generate(prompt, s.model);
      if (text) {
        // Merge by id: only fill if still empty, so concurrent edits never lose data.
        const fresh = repo.getInteraction(it.id);
        if (fresh && !fresh.aiExec) {
          repo.updateInteraction(it.id, { aiExec: text });
          generated++;
        }
      }
    }
    return { generated, remaining: Math.max(0, pending.length - generated) };
  } finally {
    enriching = false;
  }
}

// --- Auto-digest on archival, serialized ------------------------------------

let digestQueue: Promise<void> = Promise.resolve();

export function queueArchivalDigest(id: string): void {
  digestQueue = digestQueue
    .then(() => trrDigest(id, { regen: true, store: true }))
    .then(d => console.log(`auto-digest stored: ${d.customer}`))
    .catch(e => console.warn(`auto-digest failed: ${(e as Error).message}`));
}
