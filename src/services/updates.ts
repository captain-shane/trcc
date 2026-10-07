import * as repo from '../db/repo.js';
import { fillTemplate, generateWithFallback } from './ai.js';
import { usableChars } from './review.js';
import { startJob } from './jobs.js';
import { addDays, cycleDueFor, daysBetween, localDay } from './cycle.js';
import {
  CADENCE_DAYS, uid,
  type Interaction, type Opportunity, type Settings, type Trr, type TrUpdate, type UpdateCadence,
} from '../types.js';

// The weekly-update workflow (the Update Desk).
//
// Every TR ID owes an update each cycle (default: every Thursday). The window
// for an update is "everything since my LAST POSTED update" — not a fixed seven
// days — so a missed week rolls into the next one instead of being lost. The
// model only condenses the entries in that window; whether an update is due,
// overdue, drafted or posted is computed here, in code.

export type DeskState = 'posted' | 'draft' | 'overdue' | 'due' | 'not-due';

export interface DeskRow {
  trr: Trr;
  parent: Trr | null;
  opp: Opportunity | null;
  cadence: UpdateCadence;
  state: DeskState;
  update: TrUpdate | null;     // this cycle's draft / posted update
  lastPosted: TrUpdate | null; // newest posted update BEFORE this cycle
  windowFrom: string;          // ISO datetime the window starts after
  entries: Interaction[];      // logs in the window (newest first)
  stale: boolean;              // draft exists but newer activity has been logged since
}

export interface Desk {
  cycleDue: string;
  current: boolean;            // the cycle containing today
  rows: DeskRow[];
}

/** Effective cadence: the TR's own, else 'none' for a parent with children, else the default. */
export function resolveCadence(t: Trr, s: Settings, hasChildren: boolean): UpdateCadence {
  if (t.updateCadence) return t.updateCadence;
  return hasChildren ? 'none' : s.updateCadence;
}

export function currentCycleDue(s: Settings, today = localDay()): string {
  return cycleDueFor(today, s.updateDueWeekday);
}

/** Logs that count as new since `from` (an ISO datetime): logged after it, or dated after its day. */
export function windowEntries(trrId: string, from: string): Interaction[] {
  const fromDay = from ? localDay(from) : '';
  // Imported logs are dated history, not something done this week: they count by their own date only.
  return repo.interactionsFor([trrId]).filter(i =>
    i.source !== 'update' && (!from || (i.source !== 'import' && i.createdAt > from) || i.date > fromDay));
}

function windowStart(lastPosted: TrUpdate | null, cadence: UpdateCadence, now: Date): string {
  if (lastPosted?.postedAt) return lastPosted.postedAt;
  // No update posted yet: look back one cadence period.
  const days = CADENCE_DAYS[cadence] || 7;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export function deskState(
  t: Trr, cadence: UpdateCadence, cycleDue: string, update: TrUpdate | null, lastPosted: TrUpdate | null,
): DeskState {
  if (update?.status === 'posted') return 'posted';
  if (update) return 'draft';
  const period = CADENCE_DAYS[cadence] || 7;
  // biweekly: posted last week covers this week too
  if (lastPosted && daysBetween(lastPosted.cycleDue, cycleDue) < period) return 'not-due';
  const prevDue = addDays(cycleDue, -period);
  const existedThen = localDay(t.createdAt) <= prevDue;
  const missedPrev = !lastPosted || lastPosted.cycleDue < prevDue;
  return existedThen && missedPrev ? 'overdue' : 'due';
}

/** Build the desk for a cycle (default: the current one). */
export function buildDesk(cycleDue?: string, now = new Date()): Desk {
  const s = repo.getSettings();
  const current = currentCycleDue(s, localDay(now));
  const due = cycleDue ?? current;
  const all = repo.listTrrs('all');
  const byId = new Map(all.map(t => [t.id, t]));
  const kids = repo.childrenIndex(all);
  const opps = new Map(repo.listOpportunities().map(o => [o.id, o]));
  const cycleUpdates = repo.updatesForCycle(due);
  const posted = repo.lastPostedUpdates(due);

  const rows: DeskRow[] = [];
  for (const t of all) {
    const update = cycleUpdates.get(t.id) ?? null;
    const cadence = resolveCadence(t, s, (kids.get(t.id)?.length ?? 0) > 0);
    const eligible = !t.deactivated && !s.closedStatuses.includes(t.status) && cadence !== 'none'
      && localDay(t.createdAt) <= due;
    if (!eligible && !update) continue; // a TR that has this cycle's update stays visible after closing
    const lastPosted = posted.get(t.id) ?? null;
    const from = update?.status === 'posted' ? update.windowFrom : windowStart(lastPosted, cadence, now);
    const entries = due === current || update ? windowEntries(t.id, from) : [];
    const stale = update?.status === 'draft' && entries.some(i => i.createdAt > update.generatedAt);
    rows.push({
      trr: t, parent: t.parentId ? byId.get(t.parentId) ?? null : null,
      opp: t.opportunityId ? opps.get(t.opportunityId) ?? null : null,
      cadence, state: deskState(t, cadence, due, update, lastPosted),
      update, lastPosted, windowFrom: from, entries, stale,
    });
  }
  // Group by customer, then parent family, then TR number.
  const familyKey = (r: DeskRow) => (r.parent ? r.parent.num : r.trr.num);
  rows.sort((a, b) =>
    a.trr.customer.localeCompare(b.trr.customer) ||
    familyKey(a) - familyKey(b) ||
    (a.parent ? 1 : 0) - (b.parent ? 1 : 0) ||
    a.trr.num - b.trr.num);
  return { cycleDue: due, current: due === current, rows };
}

export function deskRow(trrId: string, cycleDue?: string): DeskRow | null {
  // Small enough at this scale to rebuild; keeps one source of truth for state.
  return buildDesk(cycleDue).rows.find(r => r.trr.id === trrId) ?? null;
}

// --- Drafting ------------------------------------------------------------------

const ENTRY_CHARS = 1_400;

function entryLine(i: Interaction, owner: Trr): string {
  const body = repo.aiSafeText(i).replace(/\s+/g, ' ').trim().slice(0, ENTRY_CHARS);
  const via = i.trrId !== owner.id ? ` (logged on #${repo.getTrr(i.trrId)?.num ?? '?'})` : '';
  return `- [${i.date}] ${i.type}${via}: ${body}`;
}

/** Fit the entries into the model's window, oldest dropped first (and said so). */
function packEntries(lines: string[], budget: number): string {
  const kept: string[] = [];
  let len = 0;
  for (const ln of lines) { // newest first
    if (len + ln.length + 1 > budget && kept.length) break;
    kept.push(ln);
    len += ln.length + 1;
  }
  const dropped = lines.length - kept.length;
  const out = kept.reverse().join('\n'); // back to chronological
  return dropped ? `(${dropped} earlier entr${dropped === 1 ? 'y' : 'ies'} omitted for length)\n${out}` : out;
}

/** The no-AI draft: status line plus one bullet per entry. Always available. */
export function plainDraft(row: Pick<DeskRow, 'trr' | 'entries' | 'windowFrom'>): string {
  const t = row.trr;
  if (row.entries.length === 0) {
    return `-Status: ${t.status}\n-Activity: No new activity since the last update (${localDay(row.windowFrom)}).\n-Next: none recorded`;
  }
  const bullets = [...row.entries].reverse().map(i => {
    // Flagged entries are marked, not quoted: this text is pasted into another system.
    if (i.sensitive) return `  • ${i.date} ${i.type}: 🚩 flagged entry (content not included)`;
    const first = (i.aiExec || i.note).replace(/\s+/g, ' ').trim();
    return `  • ${i.date} ${i.type}: ${first.length > 160 ? first.slice(0, 157) + '…' : first}`;
  });
  return `-Status: ${t.status}\n-Activity:\n${bullets.join('\n')}\n-Next: `;
}

/** Draft (or redraft) this cycle's update for one TR. Never touches a posted update. */
export async function draftUpdate(trrId: string, cycleDue: string, opts: { useAi?: boolean } = {}): Promise<TrUpdate> {
  const row = deskRow(trrId, cycleDue);
  if (!row) throw new Error('This TR is not on the Update Desk for that cycle.');
  if (row.update?.status === 'posted') return row.update;
  const s = repo.getSettings();
  const t = row.trr;
  let text = plainDraft(row);
  let model = '';
  // A quiet window still goes through the prompt, so the draft keeps the prompt's format.
  if ((opts.useAi ?? true) && s.aiEnabled) {
    const vars = {
      externalId: t.externalId || `#${t.num}`, customer: t.customer, opportunity: row.opp?.name ?? '—',
      title: t.title, parent: row.parent ? `${row.parent.externalId || `#${row.parent.num}`} ${row.parent.title}` : '—',
      status: t.status, targetClose: t.targetClose || 'not set',
      from: localDay(row.windowFrom), to: localDay(), count: row.entries.length, entries: '',
    };
    const budget = usableChars(s.ctxTokens, s.reviewReserveTokens) - fillTemplate(s.updateTmpl, vars).length - 200;
    vars.entries = row.entries.length
      ? packEntries(row.entries.map(i => entryLine(i, t)), Math.max(2_000, budget))
      : '(none — nothing has been logged since the last update)';
    const r = await generateWithFallback(fillTemplate(s.updateTmpl, vars), s.digestModel, s.model,
      240_000, s.ctxTokens, s.fastCtxTokens);
    if (r.text.trim()) {
      text = r.text.trim();
      model = r.model + (r.fellBack ? ' (fallback)' : '');
    }
  }
  return repo.saveUpdateDraft({
    trrId, cycleDue, windowFrom: row.windowFrom, windowTo: new Date().toISOString(),
    interactions: row.entries.length, text, model,
  });
}

/** Regenerate a posted update: back to draft (record note removed), then a fresh AI draft. */
export async function regenerateUpdate(id: number): Promise<TrUpdate | null> {
  const u = repo.getUpdateById(id);
  if (!u) return null;
  if (u.status === 'posted') unpostUpdate(u.id);
  return draftUpdate(u.trrId, u.cycleDue);
}

/** Save hand-written text as this cycle's draft (creating the row if needed). */
export function saveDraftText(trrId: string, cycleDue: string, text: string): TrUpdate {
  const row = deskRow(trrId, cycleDue);
  const cur = repo.getUpdate(trrId, cycleDue);
  if (cur) {
    repo.editUpdateText(cur.id, text);
    return repo.getUpdateById(cur.id)!;
  }
  return repo.saveUpdateDraft({
    trrId, cycleDue, windowFrom: row?.windowFrom ?? '', windowTo: new Date().toISOString(),
    interactions: row?.entries.length ?? 0, text, model: '', edited: true,
  });
}

export const POSTED_MARK = (cycleDue: string) => `Weekly update posted for cycle ${cycleDue}`;

/** Mark posted; optionally record it on the TR as an official-record note. */
export function postUpdate(id: number): TrUpdate | null {
  const u = repo.getUpdateById(id);
  if (!u || u.status === 'posted' || !u.text.trim()) return u;
  const s = repo.getSettings();
  const at = new Date().toISOString();
  repo.markUpdatePosted(id, at);
  if (s.logPostedUpdates) {
    const t = repo.getTrr(u.trrId);
    repo.insertInteraction({
      id: uid(), trrId: u.trrId, type: 'Note', date: localDay(),
      note: `[${s.officialTag}] ${POSTED_MARK(u.cycleDue)}${t?.externalId ? ` (${t.externalId})` : ''}:\n${u.text}`,
      aiExec: '', aiCust: '', sensitive: false, source: 'update', createdAt: at,
    });
  }
  return repo.getUpdateById(id);
}

/** Undo a post: back to draft, and remove the auto-logged record note. */
export function unpostUpdate(id: number): void {
  const u = repo.getUpdateById(id);
  if (!u || u.status !== 'posted') return;
  repo.unpostUpdate(id);
  for (const i of repo.listInteractions(u.trrId)) {
    if (i.source === 'update' && i.note.includes(POSTED_MARK(u.cycleDue))) repo.deleteInteraction(i.id);
  }
}

// --- Aggregation ---------------------------------------------------------------

export function rowHeader(r: Pick<DeskRow, 'trr' | 'parent'>): string {
  const t = r.trr;
  const id = t.externalId || `#${t.num}`;
  const parent = r.parent ? ` [parent: ${r.parent.externalId || `#${r.parent.num}`} ${r.parent.title}]` : '';
  return `${id} — ${t.customer} — ${t.title}${parent}`;
}

/** One block to paste: every drafted/posted update in the cycle, then what is missing. */
export function aggregateText(desk: Desk): string {
  const withText = desk.rows.filter(r => r.update?.text.trim());
  const missing = desk.rows.filter(r => !r.update && (r.state === 'due' || r.state === 'overdue'));
  const blocks = withText.map(r => `${rowHeader(r)}\n${r.update!.text.trim()}`);
  let out = `TR updates — cycle due ${desk.cycleDue}\n\n${blocks.join('\n\n') || '(no drafts yet)'}`;
  if (missing.length) out += `\n\nNo update yet (${missing.length}):\n${missing.map(r => `  - ${rowHeader(r)}`).join('\n')}`;
  return out;
}

export function deskCounts(desk: Desk): Record<DeskState | 'quiet' | 'stale', number> {
  const c = { posted: 0, draft: 0, overdue: 0, due: 0, 'not-due': 0, quiet: 0, stale: 0 };
  for (const r of desk.rows) {
    c[r.state]++;
    if (r.state !== 'posted' && r.entries.length === 0) c.quiet++;
    if (r.stale) c.stale++;
  }
  return c;
}

// --- Bulk ----------------------------------------------------------------------

/** Draft every due/overdue TR without one (plus stale, un-edited drafts) in the background. */
export function startBulkDrafts(cycleDue: string, opts: { redoStale?: boolean } = {}): string {
  const targets = buildDesk(cycleDue).rows.filter(r =>
    r.state === 'due' || r.state === 'overdue' ||
    (opts.redoStale && r.state === 'draft' && r.stale && !r.update?.edited));
  return startJob('update-drafts', `drafts:${cycleDue}`, `Drafting ${targets.length} updates`, targets.length,
    async progress => {
      let done = 0;
      const failed: string[] = [];
      for (const r of targets) {
        progress({ done, total: targets.length, phase: `${r.trr.externalId || `#${r.trr.num}`} ${r.trr.title}` });
        try {
          await draftUpdate(r.trr.id, cycleDue);
        } catch (e) {
          failed.push(`${r.trr.externalId || `#${r.trr.num}`}: ${(e as Error).message}`);
        }
        done++;
      }
      progress({ done, total: targets.length, phase: 'done' });
      return { drafted: done - failed.length, failed };
    });
}
