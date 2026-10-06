import * as repo from '../db/repo.js';
import { fillTemplate, generateWithFallback } from './ai.js';
import { usableChars } from './review.js';
import { startJob, type JobProgress } from './jobs.js';
import type { Interaction, ScopeSummary, SummaryScopeKind, Trr } from '../types.js';

// "Summary to date" for any level of the hierarchy: one TR, a parent with its
// children, an opportunity, or a whole customer.
//
// Runs are VERSIONED (each one kept, never overwritten) and INCREMENTAL: when a
// previous summary exists, only the entries logged since it are sent, together
// with that summary, and the model revises it. A record too big for one window
// is handled the same way — summarise the first slice, then fold in the next
// slice, and so on — so nothing is dropped silently.

export const SCOPE_LABEL: Record<SummaryScopeKind, string> = {
  trr: 'This TR', family: 'TR + children', opportunity: 'Opportunity', customer: 'Customer',
};

export interface ResolvedScope {
  kind: SummaryScopeKind;
  id: string;
  label: string;   // human title of the scope
  trrs: Trr[];
}

export function resolveScope(kind: SummaryScopeKind, id: string): ResolvedScope | null {
  if (kind === 'trr' || kind === 'family') {
    const t = repo.getTrr(id);
    if (!t) return null;
    const trrs = kind === 'family' ? repo.familyOf(id) : [t];
    return { kind, id, label: `${t.externalId || `#${t.num}`} ${t.customer} — ${t.title}${kind === 'family' ? ' (+ children)' : ''}`, trrs };
  }
  if (kind === 'opportunity') {
    const o = repo.getOpportunity(id);
    if (!o) return null;
    const c = repo.getCustomer(o.customerId);
    return { kind, id, label: `${c?.name ?? '?'} — ${o.name}`, trrs: repo.listTrrs('all').filter(t => t.opportunityId === id) };
  }
  const c = repo.getCustomer(id);
  if (!c) return null;
  return { kind, id, label: c.name, trrs: repo.listTrrs('all').filter(t => t.customerId === id) };
}

function scopeEntries(scope: ResolvedScope): Interaction[] {
  // Posted-update notes restate other entries — leave them out of the source record.
  return repo.interactionsFor(scope.trrs.map(t => t.id))
    .filter(i => i.source !== 'update')
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
}

function requestsText(scope: ResolvedScope): string {
  const byId = new Map(scope.trrs.map(t => [t.id, t]));
  const opps = new Map(repo.listOpportunities().map(o => [o.id, o.name]));
  return scope.trrs
    .sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0) || a.num - b.num)
    .map(t => {
      const parent = t.parentId ? byId.get(t.parentId) ?? repo.getTrr(t.parentId) : null;
      return `- ${t.externalId || `#${t.num}`}: ${t.title} [${t.status}` +
        `${t.myRole ? ` | my role: ${t.myRole}` : ''}${t.outcome ? ` | outcome: ${t.outcome}` : ''}` +
        `${t.opportunityId ? ` | opportunity: ${opps.get(t.opportunityId) ?? '?'}` : ''}` +
        `${parent ? ` | child of ${parent.externalId || `#${parent.num}`}` : ''}]` +
        `${t.description ? `\n  ${t.description.replace(/\s+/g, ' ').slice(0, 500)}` : ''}`;
    }).join('\n');
}

function entryLine(i: Interaction, byId: Map<string, Trr>): string {
  const t = byId.get(i.trrId);
  const tag = t ? (t.externalId || `#${t.num}`) : '?';
  const raw = i.sensitive ? repo.aiSafeText(i) : (i.aiExec && i.note.length > 1_400 ? i.aiExec : i.note);
  const body = raw.replace(/\s+/g, ' ').trim().slice(0, 1_400);
  return `- [${i.date}] ${tag} ${i.type}: ${body}`;
}

function chunkLines(lines: string[], budget: number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const ln of lines) {
    if (len + ln.length + 1 > budget && cur.length) { out.push(cur.join('\n')); cur = []; len = 0; }
    cur.push(ln);
    len += ln.length + 1;
  }
  if (cur.length) out.push(cur.join('\n'));
  return out.length ? out : ['(no logged entries yet)'];
}

export interface SummaryPlan {
  mode: 'full' | 'incremental' | 'up-to-date';
  base: ScopeSummary | null;
  newEntries: number;
  totalEntries: number;
  calls: number;
}

function newSince(entries: Interaction[], base: ScopeSummary): Interaction[] {
  return entries.filter(i => i.createdAt > base.through || i.date > base.last);
}

function budgetFor(scope: ResolvedScope, previousLen: number): number {
  const s = repo.getSettings();
  const fixed = s.summaryTmpl.length + scope.label.length + requestsText(scope).length + previousLen + 600;
  return Math.max(3_000, usableChars(s.ctxTokens, s.reviewReserveTokens) - fixed);
}

export function planSummary(kind: SummaryScopeKind, id: string, full = false): SummaryPlan | null {
  const scope = resolveScope(kind, id);
  if (!scope) return null;
  const entries = scopeEntries(scope);
  const base = full ? null : repo.latestSummary(kind, id);
  const fresh = base ? newSince(entries, base) : entries;
  if (base && fresh.length === 0) return { mode: 'up-to-date', base, newEntries: 0, totalEntries: entries.length, calls: 0 };
  const byId = new Map(scope.trrs.map(t => [t.id, t]));
  const chunks = chunkLines(fresh.map(i => entryLine(i, byId)), budgetFor(scope, base ? base.summary.length + 300 : 3_000));
  return { mode: base ? 'incremental' : 'full', base, newEntries: fresh.length, totalEntries: entries.length, calls: chunks.length };
}

/** Generate (and persist) a new summary version. Returns the stored row. */
export async function runSummary(
  kind: SummaryScopeKind, id: string, full = false, progress: (p: JobProgress) => void = () => {},
): Promise<ScopeSummary> {
  const scope = resolveScope(kind, id);
  if (!scope) throw new Error('That scope no longer exists.');
  const s = repo.getSettings();
  const entries = scopeEntries(scope);
  const base = full ? null : repo.latestSummary(kind, id);
  const fresh = base ? newSince(entries, base) : entries;
  if (base && fresh.length === 0) return base;

  const byId = new Map(scope.trrs.map(t => [t.id, t]));
  const lines = fresh.map(i => entryLine(i, byId));
  const reqs = requestsText(scope);
  let previous = base?.summary ?? '';
  let previousAsOf = base?.last ?? '';
  let model = '';
  let fellBack = false;

  // Chunk against the budget left once the summary-so-far is in the prompt; a
  // summary is short, so reserve a generous fixed allowance for it.
  const chunks = chunkLines(lines, budgetFor(scope, Math.max(previous.length, 3_000) + 300));
  for (let n = 0; n < chunks.length; n++) {
    progress({ done: n, total: chunks.length, phase: chunks.length > 1 ? `slice ${n + 1} of ${chunks.length}` : 'summarising' });
    const prompt = fillTemplate(s.summaryTmpl, {
      scope: `${SCOPE_LABEL[kind]}: ${scope.label}`,
      requests: reqs,
      previous: previous
        ? `\n=== SUMMARY SO FAR (as of ${previousAsOf || 'earlier'}) — revise and extend it with the entries below: keep what is still true, update what changed, add what is new. Output the complete revised summary. ===\n${previous}\n`
        : '',
      entriesLabel: previous ? 'NEW ENTRIES SINCE THE SUMMARY ABOVE (chronological)' : 'ENTRIES (chronological)',
      entries: chunks[n]!,
    });
    const r = await generateWithFallback(prompt, s.digestModel, s.model, 480_000, s.ctxTokens, s.fastCtxTokens);
    if (!r.text.trim()) throw new Error('The model returned an empty summary.');
    previous = r.text.trim();
    previousAsOf = chunks[n]!.match(/\[(\d{4}-\d{2}-\d{2})\][^\n]*$/)?.[1] ?? previousAsOf;
    model = r.model;
    fellBack ||= r.fellBack;
  }
  progress({ done: chunks.length, total: chunks.length, phase: 'saving' });

  const through = entries.reduce((m, i) => (i.createdAt > m ? i.createdAt : m), base?.through ?? '');
  const row = {
    scopeKind: kind, scopeId: id, label: scope.label,
    interactions: entries.length, first: entries[0]?.date ?? '', last: entries[entries.length - 1]?.date ?? '',
    through, summary: previous, model: model + (fellBack ? ' (fallback)' : ''),
    mode: (base ? 'incremental' : 'full') as 'full' | 'incremental', baseId: base?.id ?? null,
  };
  const newId = repo.insertSummary(row);
  // A single-TR summary is also that TR's "catch me up" digest (Digests page).
  if (kind === 'trr') {
    const t = scope.trrs[0]!;
    repo.upsertDigest({
      trrId: t.id, customer: t.customer, title: t.title, status: t.status,
      interactions: row.interactions, first: row.first, last: row.last,
      summary: row.summary, model: row.model, generatedAt: new Date().toISOString(),
    });
  }
  return repo.getSummary(newId)!;
}

export function startSummaryJob(kind: SummaryScopeKind, id: string, full: boolean): string {
  const plan = planSummary(kind, id, full);
  return startJob('summary', `summary:${kind}:${id}`, `Summary — ${SCOPE_LABEL[kind]}`, plan?.calls || 1,
    async progress => (await runSummary(kind, id, full, progress)).id);
}
