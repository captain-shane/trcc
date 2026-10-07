import { db } from './index.js';
import * as repo from './repo.js';
import { addDays, cycleDueFor, localDay } from '../services/cycle.js';
import { POSTED_MARK } from '../services/updates.js';
import { computePeriodDigest } from '../services/digest.js';
import { uid, type Complexity, type Interaction, type Priority, type SummaryScopeKind, type UpdateCadence } from '../types.js';

// Demo-data engine, shared by both flavors. The flavor's seed.ts holds only the
// STORY (customers, opportunities, requests, notes, updates…) in relative days,
// so a fresh install always looks current; this file turns it into rows.
//
// Every table a showcase needs is filled: the hierarchy, health spread, flagged
// and linked logs, imported logs, posted / draft / missing weekly updates over
// several cycles, versioned summaries, digests, a saved period report, an
// applied import, and audit history (status changes, opportunity moves and
// stage changes). "Remove demo data" deletes exactly what this created.

export interface SeedOpp {
  key: string; customer: string; name: string; stage: string; rep: string;
  closeDaysAhead: number; createdDaysAgo: number;
  stageHistory?: [daysAgo: number, from: string, to: string][];
  renamedFrom?: [daysAgo: number, oldName: string];
}

export interface SeedTr {
  key: string; customer: string; opp?: string; parent?: string; externalId?: string;
  title: string; status: string; complexity: Complexity; priority: Priority;
  contact?: string; rep?: string; targetCloseDaysAhead?: number; description: string;
  myRole?: string; outcome?: string; themes?: string[]; createdDaysAgo: number;
  deactivatedDaysAgo?: number; cadence?: UpdateCadence;
  history?: [daysAgo: number, field: string, from: string, to: string][];
  /** moved between opportunities (recorded on the TR and, for a parent, on each child) */
  moves?: [daysAgo: number, fromOpp: string, toOpp: string][];
}

export interface SeedLog {
  tr: string; type: Interaction['type']; daysAgo: number; note: string;
  flagged?: boolean; also?: string[]; exec?: string; imported?: boolean;
}

export interface SeedUpdate { tr: string; cyclesAgo: number; status: 'posted' | 'draft'; text: string; ai?: boolean; edited?: boolean }
export interface SeedSummary { scope: SummaryScopeKind; key: string; versions: { daysAgo: number; text: string }[] }
export interface SeedDigest { tr: string; daysAgo: number; text: string }
export interface SeedReport { fromDaysAgo: number; toDaysAgo: number; daysAgo: number; narrative: string }
export interface SeedImport { label: string; daysAgo: number; raw: string }

export interface SeedStory {
  customerNotes?: Record<string, string>;
  opps: SeedOpp[];
  trs: SeedTr[];
  logs: SeedLog[];
  updates: SeedUpdate[];
  summaries?: SeedSummary[];
  digests?: SeedDigest[];
  reports?: SeedReport[];
  imports?: SeedImport[];
}

const iso = (daysAgo: number, hour = 10) => {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  d.setHours(hour, (daysAgo * 37) % 60, 0, 0);
  // "today at 10:00" must not be in the future when seeding at 07:00
  return new Date(Math.min(d.getTime(), Date.now() - 60_000 * (1 + (daysAgo % 50)))).toISOString();
};
const day = (daysAgo: number) => localDay(new Date(Date.now() - daysAgo * 86_400_000));
const daysAgoOf = (dayStr: string) => Math.round((Date.now() - new Date(`${dayStr}T12:00:00`).getTime()) / 86_400_000);

export function runSeed(story: SeedStory): { trs: number; logs: number } {
  const s = repo.getSettings();
  const ids = new Map<string, string>();       // tr key -> id
  const oppIds = new Map<string, string>();    // opp key -> id
  const reportIds: number[] = [];
  const importIds: string[] = [];
  const need = (m: Map<string, string>, k: string, what: string) => {
    const v = m.get(k);
    if (!v) throw new Error(`seed: unknown ${what} "${k}"`);
    return v;
  };

  db.transaction(() => {
    // customers, then opportunities
    for (const c of new Set([...story.opps.map(o => o.customer), ...story.trs.filter(t => !t.parent).map(t => t.customer)])) {
      const cust = repo.ensureCustomer(c);
      db.prepare('UPDATE customers SET created_at = ?, notes = ? WHERE id = ?')
        .run(iso(Math.max(...story.trs.filter(t => t.customer === c).map(t => t.createdDaysAgo), 30) + 2), story.customerNotes?.[c] ?? '', cust.id);
    }
    for (const o of story.opps) {
      const cust = repo.findCustomerByName(o.customer)!;
      const opp = repo.insertOpportunity({
        customerId: cust.id, name: o.name, stage: o.stage, rep: o.rep, closeDate: day(-o.closeDaysAhead), notes: '',
        createdAt: iso(o.createdDaysAgo),
      });
      oppIds.set(o.key, opp.id);
    }

    // requests: parents (and standalone) first, then children
    const ordered = [...story.trs.filter(t => !t.parent), ...story.trs.filter(t => t.parent)];
    for (const t of ordered) {
      const id = uid() + ids.size;
      ids.set(t.key, id);
      repo.insertTrr({
        id, customer: t.customer, title: t.title, status: t.status, complexity: t.complexity, priority: t.priority,
        contact: t.contact ?? '', rep: t.rep ?? '', targetClose: t.targetCloseDaysAhead != null ? day(-t.targetCloseDaysAhead) : '',
        description: t.description, myRole: t.myRole ?? '', outcome: t.outcome ?? '', valueThemes: t.themes ?? [],
        deactivated: t.deactivatedDaysAgo != null, deactivatedAt: t.deactivatedDaysAgo != null ? iso(t.deactivatedDaysAgo) : '',
        createdAt: iso(t.createdDaysAgo, 9), lastContact: '',
        opportunityId: t.opp && !t.parent ? need(oppIds, t.opp, 'opportunity') : '',
        parentId: t.parent ? need(ids, t.parent, 'parent TR') : '',
        externalId: t.externalId ?? '', updateCadence: t.cadence ?? '',
      });
    }

    // logs
    const logIdsImported: string[] = [];
    for (const l of story.logs) {
      const lid = uid() + Math.random().toString(36).slice(2, 6);
      const imported = !!l.imported;
      repo.insertInteraction({
        id: lid, trrId: need(ids, l.tr, 'TR'), type: l.type, date: day(l.daysAgo), note: l.note,
        aiExec: l.flagged ? '' : l.exec ?? '', aiCust: '', sensitive: !!l.flagged,
        source: imported ? 'import' : '', createdAt: imported ? iso(story.imports?.[0]?.daysAgo ?? l.daysAgo, 11) : iso(l.daysAgo, 9 + (l.daysAgo % 8)),
      });
      if (l.also?.length) repo.setInteractionLinks(lid, l.also.map(k => need(ids, k, 'TR')));
      if (imported) logIdsImported.push(lid);
    }

    // weekly updates: past cycles posted on their due day, the current cycle as given
    const currentDue = cycleDueFor(localDay(), s.updateDueWeekday);
    const byTr = new Map<string, SeedUpdate[]>();
    for (const u of story.updates) byTr.set(u.tr, [...(byTr.get(u.tr) ?? []), u]);
    for (const [key, list] of byTr) {
      const trrId = need(ids, key, 'TR');
      const tr = repo.getTrr(trrId)!;
      let windowFrom = '';
      for (const u of [...list].sort((a, b) => b.cyclesAgo - a.cyclesAgo)) {
        const due = addDays(currentDue, -7 * u.cyclesAgo);
        const postedDaysAgo = Math.max(0, daysAgoOf(due));
        const at = u.cyclesAgo === 0 ? iso(0, 8) : iso(postedDaysAgo, 15);
        const row = repo.saveUpdateDraft({
          trrId, cycleDue: due, windowFrom, windowTo: at,
          interactions: story.logs.filter(l => l.tr === key && (!windowFrom || iso(l.daysAgo) > windowFrom) && l.daysAgo >= postedDaysAgo).length,
          text: u.text, model: u.ai ? s.model : '', edited: u.edited,
        });
        db.prepare('UPDATE updates SET generated_at = ? WHERE id = ?').run(u.cyclesAgo === 0 ? iso(0, 7) : iso(postedDaysAgo + 1, 16), row.id);
        if (u.status === 'posted') {
          repo.markUpdatePosted(row.id, at);
          windowFrom = at;
          if (s.logPostedUpdates) {
            repo.insertInteraction({
              id: uid() + Math.random().toString(36).slice(2, 6), trrId, type: 'Note', date: localDay(at),
              note: `[${s.officialTag}] ${POSTED_MARK(due)}${tr.externalId ? ` (${tr.externalId})` : ''}:\n${u.text}`,
              aiExec: '', aiCust: '', sensitive: false, source: 'update', createdAt: at,
            });
          }
        }
      }
    }

    // last contact = newest log (posted-update notes are records, not contact)
    for (const id of ids.values()) {
      const r = db.prepare(`SELECT max(date) d FROM interactions WHERE trr_id = ? AND source <> 'update'`).get(id) as { d: string | null };
      const linked = db.prepare(`SELECT max(i.date) d FROM interaction_links l JOIN interactions i ON i.id = l.interaction_id WHERE l.trr_id = ?`).get(id) as { d: string | null };
      const d = [r.d ?? '', linked.d ?? ''].sort().pop();
      if (d) db.prepare('UPDATE trrs SET last_contact = ? WHERE id = ?').run(d, id);
    }

    // audit history
    const h = (id: string, daysAgo: number, field: string, from: string, to: string) => repo.recordHistory(id, field, from, to, iso(daysAgo, 12));
    for (const t of story.trs) {
      const id = ids.get(t.key)!;
      for (const [d, f, a, b] of t.history ?? []) h(id, d, f, a, b);
      for (const [d, a, b] of t.moves ?? []) {
        h(id, d, 'opportunity', a, b);
        for (const k of story.trs.filter(x => x.parent === t.key)) {
          h(ids.get(k.key)!, d, `opportunity (via parent #${repo.getTrr(id)!.num})`, a, b);
        }
      }
      if (t.parent) h(id, t.createdDaysAgo, 'parent', '', `#${repo.getTrr(ids.get(t.parent)!)!.num}`);
    }
    for (const o of story.opps) {
      const members = story.trs.filter(t => t.opp === o.key || (t.parent && story.trs.find(p => p.key === t.parent)?.opp === o.key));
      for (const [d, a, b] of o.stageHistory ?? []) for (const m of members) h(ids.get(m.key)!, d, `opportunity stage (${o.name})`, a, b);
      if (o.renamedFrom) for (const m of members) h(ids.get(m.key)!, o.renamedFrom[0], 'opportunity (renamed)', o.renamedFrom[1], o.name);
    }

    // summaries to date: a version chain per scope
    for (const sm of story.summaries ?? []) {
      const scopeId = sm.scope === 'opportunity' ? need(oppIds, sm.key, 'opportunity')
        : sm.scope === 'customer' ? repo.findCustomerByName(sm.key)!.id : need(ids, sm.key, 'TR');
      const scopeTrs = sm.scope === 'trr' ? [scopeId] : sm.scope === 'family' ? repo.familyOf(scopeId).map(t => t.id)
        : sm.scope === 'opportunity' ? repo.listTrrs('all').filter(t => t.opportunityId === scopeId).map(t => t.id)
        : repo.listTrrs('all').filter(t => t.customerId === scopeId).map(t => t.id);
      const label = sm.scope === 'customer' ? sm.key : sm.scope === 'opportunity' ? `${story.opps.find(o => o.key === sm.key)!.customer} — ${story.opps.find(o => o.key === sm.key)!.name}`
        : (() => { const t = repo.getTrr(scopeId)!; return `${t.externalId || `#${t.num}`} ${t.customer} — ${t.title}${sm.scope === 'family' ? ' (+ children)' : ''}`; })();
      let base: number | null = null;
      for (const [n, v] of [...sm.versions].sort((a, b) => b.daysAgo - a.daysAgo).entries()) {
        const covered = repo.interactionsFor(scopeTrs).filter(i => i.source !== 'update' && i.createdAt <= iso(v.daysAgo, 18));
        const dates = covered.map(i => i.date).sort();
        const sid = repo.insertSummary({
          scopeKind: sm.scope, scopeId, label, interactions: covered.length, first: dates[0] ?? '', last: dates[dates.length - 1] ?? '',
          through: covered.reduce((m, i) => (i.createdAt > m ? i.createdAt : m), ''), summary: v.text, model: s.digestModel,
          mode: n === 0 ? 'full' : 'incremental', baseId: base,
        });
        db.prepare('UPDATE summaries SET generated_at = ? WHERE id = ?').run(iso(v.daysAgo, 18), sid);
        base = sid;
      }
    }

    // catch-me-up digests
    for (const d of story.digests ?? []) {
      const t = repo.getTrr(need(ids, d.tr, 'TR'))!;
      const its = repo.listInteractions(t.id).filter(i => i.source !== 'update').map(i => i.date).sort();
      repo.upsertDigest({
        trrId: t.id, customer: t.customer, title: t.title, status: t.status, interactions: its.length,
        first: its[0] ?? '', last: its[its.length - 1] ?? '', summary: d.text, model: s.digestModel, generatedAt: iso(d.daysAgo, 17),
      });
    }

    // a saved period report (stats computed from the seeded data, narrative from the story)
    for (const r of story.reports ?? []) {
      const from = day(r.fromDaysAgo), to = day(r.toDaysAgo);
      const stats = computePeriodDigest(from, to);
      const rid = repo.insertPeriodReport({ fromDate: from, toDate: to, statsJson: JSON.stringify(stats), narrative: r.narrative, model: s.digestModel });
      db.prepare('UPDATE period_reports SET generated_at = ? WHERE id = ?').run(iso(r.daysAgo, 16), rid);
      reportIds.push(rid);
    }

    // an applied import (its logs are the ones marked imported)
    for (const im of story.imports ?? []) {
      const iid = repo.insertImport({
        kind: 'table', label: im.label, raw: im.raw, tableJson: '{}', mappingJson: '[]', optionsJson: '{}', mapper: s.model, note: '',
      });
      const n = logIdsImported.length;
      repo.updateImport(iid, {
        status: 'applied', appliedAt: iso(im.daysAgo, 11),
        resultJson: JSON.stringify({ trrs: [], logs: logIdsImported, customers: [], opps: [], updated: [], stages: [] }),
        summary: `${n} log${n === 1 ? '' : 's'} added`,
      });
      db.prepare('UPDATE imports SET created_at = ? WHERE id = ?').run(iso(im.daysAgo, 11), iid);
      importIds.push(iid);
    }

    // remember exactly what was seeded, for "Remove demo data"
    const custIds = [...new Set([...ids.values()].map(id => repo.getTrr(id)!.customerId))];
    const put = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    put.run('_seedTrrIds', JSON.stringify([...ids.values()]));
    put.run('_seedCustomerIds', JSON.stringify(custIds));
    put.run('_seedExtra', JSON.stringify({ reports: reportIds, imports: importIds }));
  })();
  return { trs: ids.size, logs: story.logs.length };
}
