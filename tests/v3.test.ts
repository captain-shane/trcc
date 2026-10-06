import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// v3: hierarchy, interaction links, weekly-update desk, summaries. Own throwaway DB.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'trr-v3-')), 'test.db');

const repo = await import('../src/db/repo.js');
const { MIGRATIONS } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const upd = await import('../src/services/updates.js');
const cyc = await import('../src/services/cycle.js');
const { planSummary } = await import('../src/services/summary.js');
const { uid } = await import('../src/types.js');
type NewTrr = import('../src/types.js').NewTrr;

const base = (over: Partial<NewTrr> = {}): NewTrr => ({
  id: uid(), customer: 'Acme', title: 't', status: 'New', complexity: 'Simple', priority: 'Low',
  contact: '', rep: '', targetClose: '', description: '', myRole: '', outcome: '', valueThemes: [],
  deactivated: false, deactivatedAt: '', createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), lastContact: '',
  ...over,
});

const log = (trrId: string, daysAgo: number, note = 'did a thing worth noting for the record') => {
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  const id = uid() + Math.random().toString(36).slice(2, 5);
  repo.insertInteraction({
    id, trrId, type: 'Call', date: cyc.localDay(at), note, aiExec: '', aiCust: '', sensitive: false,
    createdAt: at.toISOString(),
  });
  return id;
};

beforeAll(() => {
  repo.saveSettings({ aiEnabled: false }); // every path here must work with no model server
});

describe('migration v6 on an existing v5 database', () => {
  it('turns free-text customers into rows, folding case and whitespace, earliest spelling wins', () => {
    const db = new Database(join(mkdtempSync(join(tmpdir(), 'trr-mig-')), 'm.db'));
    db.pragma('foreign_keys = ON');
    for (const sql of MIGRATIONS.slice(0, 5)) db.exec(sql);
    const ins = db.prepare(`INSERT INTO trrs (id, customer, title, created_at, num) VALUES (?, ?, 't', ?, ?)`);
    ins.run('a', 'Acme Corp', '2026-01-01T00:00:00Z', 1);
    ins.run('b', '  acme corp ', '2026-02-01T00:00:00Z', 2);
    ins.run('c', 'Beta', '2026-03-01T00:00:00Z', 3);
    db.prepare(`INSERT INTO interactions (id, trr_id, date, note, created_at) VALUES ('i1', 'a', '2026-01-02', 'n', '2026-01-02T00:00:00Z')`).run();
    db.exec(MIGRATIONS[5]!);
    const custs = db.prepare('SELECT name FROM customers ORDER BY name').all() as { name: string }[];
    expect(custs.map(c => c.name)).toEqual(['Acme Corp', 'Beta']);
    const rows = db.prepare('SELECT id, customer, customer_id, parent_id, external_id FROM trrs ORDER BY id').all() as
      { id: string; customer: string; customer_id: string; parent_id: string | null; external_id: string }[];
    expect(rows[0]!.customer_id).toBe(rows[1]!.customer_id);   // same customer
    expect(rows[1]!.customer).toBe('Acme Corp');                // display name normalised
    expect(rows.every(r => r.parent_id === null && r.external_id === '')).toBe(true);
    expect((db.prepare(`SELECT source FROM interactions`).get() as { source: string }).source).toBe('');
    db.close();
  });
});

describe('hierarchy', () => {
  it('a child inherits its parent customer and opportunity, and follows them when they change', () => {
    const p = base({ customer: 'Hier Co', title: 'parent' });
    repo.insertTrr(p);
    const pt = repo.getTrr(p.id)!;
    const opp = repo.insertOpportunity({ customerId: pt.customerId, name: 'Opp 1', stage: '', rep: '', closeDate: '', notes: '' });
    repo.updateTrr(p.id, { opportunityId: opp.id });
    const c = base({ customer: 'Something Else', title: 'child', parentId: p.id });
    repo.insertTrr(c);
    const ct = repo.getTrr(c.id)!;
    expect(ct.customer).toBe('Hier Co');
    expect(ct.opportunityId).toBe(opp.id);

    repo.updateTrr(p.id, { customer: 'Hier Co Renamed' }); // moves the parent to a new customer
    const moved = repo.getTrr(c.id)!;
    expect(moved.customer).toBe('Hier Co Renamed');
    expect(moved.opportunityId).toBe(''); // the opportunity belonged to the old customer
  });

  it('allows only one level of children', () => {
    const p = base({ title: 'p' }); repo.insertTrr(p);
    const c = base({ title: 'c', parentId: p.id }); repo.insertTrr(c);
    expect(() => repo.insertTrr(base({ title: 'grandchild', parentId: c.id }))).toThrow(repo.HierarchyError);
    const other = base({ title: 'other' }); repo.insertTrr(other);
    expect(() => repo.updateTrr(p.id, { parentId: other.id })).toThrow(/child TRs of its own/);
    expect(() => repo.updateTrr(p.id, { parentId: p.id })).toThrow(/own parent/);
  });

  it('a parent shows as actively worked when any child is, without changing stored data', () => {
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
    const fresh = new Date(Date.now() - 1 * 86_400_000).toISOString().slice(0, 10);
    const p = base({ customer: 'Roll Co', title: 'pm parent' }); repo.insertTrr(p);
    repo.updateTrr(p.id, { lastContact: old });
    const c = base({ customer: 'Roll Co', title: 'busy child', parentId: p.id }); repo.insertTrr(c);
    repo.updateTrr(c.id, { lastContact: fresh });
    const [view] = repo.withFamilyActivity([repo.getTrr(p.id)!]);
    expect(view!.lastContact).toBe(fresh);
    expect(view!.ownLastContact).toBe(old);
    expect(view!.activityVia).toBe(repo.getTrr(c.id)!.num);
    expect(repo.getTrr(p.id)!.lastContact).toBe(old); // stored value untouched
    const [kid] = repo.withFamilyActivity([repo.getTrr(c.id)!]);
    expect(kid!.activityVia).toBeUndefined();          // children keep their own health
  });

  it('deleting a parent keeps its children as standalone TRs', () => {
    const p = base({ title: 'doomed parent' }); repo.insertTrr(p);
    const c = base({ title: 'survivor', parentId: p.id }); repo.insertTrr(c);
    repo.deleteTrr(p.id);
    expect(repo.getTrr(c.id)!.parentId).toBe('');
  });

  it('renames and merges customers, keeping trrs.customer in sync', () => {
    const a = base({ customer: 'Dup Inc' }); repo.insertTrr(a);
    const b = base({ customer: 'Dup Incorporated' }); repo.insertTrr(b);
    const ca = repo.getTrr(a.id)!.customerId, cb = repo.getTrr(b.id)!.customerId;
    expect(() => repo.updateCustomer(ca, { name: 'dup incorporated' })).toThrow(/already exists/);
    repo.mergeCustomer(ca, cb);
    expect(repo.getTrr(a.id)!.customer).toBe('Dup Incorporated');
    expect(repo.getCustomer(ca)).toBeNull();
    repo.updateCustomer(cb, { name: 'Dup Group' });
    expect(repo.getTrr(a.id)!.customer).toBe('Dup Group');
    expect(repo.deleteCustomer(cb)).toBe(false); // has TRs
  });
});

describe('interaction links', () => {
  it('a linked log shows on every TR it applies to, once', () => {
    const t1 = base({ customer: 'Link Co', title: 'one' }); repo.insertTrr(t1);
    const t2 = base({ customer: 'Link Co', title: 'two' }); repo.insertTrr(t2);
    const iid = log(t1.id, 1);
    repo.setInteractionLinks(iid, [t2.id, t1.id, 'nope']); // owner + unknown ids are ignored
    expect(repo.interactionLinks(iid)).toEqual([t2.id]);
    expect(repo.interactionsFor([t2.id]).map(i => i.id)).toContain(iid);
    expect(repo.interactionsFor([t1.id, t2.id]).filter(i => i.id === iid)).toHaveLength(1);
  });
});

describe('cycle arithmetic', () => {
  it('finds the due day on or after a date', () => {
    expect(cyc.cycleDueFor('2026-10-06', 4)).toBe('2026-10-08'); // Tue -> Thu
    expect(cyc.cycleDueFor('2026-10-08', 4)).toBe('2026-10-08'); // Thu is its own due day
    expect(cyc.cycleDueFor('2026-10-09', 4)).toBe('2026-10-15'); // Fri -> next Thu
    expect(cyc.addDays('2026-03-07', 7)).toBe('2026-03-14');     // across a DST change
    expect(cyc.isValidDay('2026-02-30')).toBe(false);
  });
});

describe('update desk', () => {
  const due = () => upd.currentCycleDue(repo.getSettings());

  it('state: overdue when the previous cycle was missed, due when it is new, posted after posting', () => {
    const old = base({ customer: 'Desk Co', title: 'old one', externalId: 'TR-1' }); repo.insertTrr(old);
    const fresh = base({ customer: 'Desk Co', title: 'brand new', createdAt: new Date().toISOString() }); repo.insertTrr(fresh);
    log(old.id, 2);
    const rows = upd.buildDesk().rows;
    expect(rows.find(r => r.trr.id === old.id)!.state).toBe('overdue');
    expect(rows.find(r => r.trr.id === fresh.id)!.state).toBe('due');
  });

  it('the window starts at the last POSTED update, not seven days ago', async () => {
    const t = base({ customer: 'Window Co', title: 'w' }); repo.insertTrr(t);
    log(t.id, 12, 'before the last update');
    log(t.id, 1, 'after the last update');
    const prev = cyc.addDays(due(), -7);
    const u = repo.saveUpdateDraft({ trrId: t.id, cycleDue: prev, windowFrom: '', windowTo: '', interactions: 0, text: 'x', model: '' });
    repo.markUpdatePosted(u.id, new Date(Date.now() - 5 * 86_400_000).toISOString());
    const row = upd.deskRow(t.id)!;
    expect(row.entries.map(i => i.note)).toEqual(['after the last update']);
    expect(row.state).toBe('due'); // posted last cycle, so not overdue
    const d = await upd.draftUpdate(t.id, due()); // AI off -> plain draft
    expect(d.text).toContain('after the last update');
    expect(d.model).toBe('');
  });

  it('posting logs an official-record note that never counts as new activity, and unpost removes it', async () => {
    const t = base({ customer: 'Post Co', title: 'p', externalId: 'TR-77' }); repo.insertTrr(t);
    log(t.id, 1);
    const d = await upd.draftUpdate(t.id, due());
    upd.postUpdate(d.id);
    const notes = repo.listInteractions(t.id).filter(i => i.source === 'update');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.note).toMatch(new RegExp(`^\\[${repo.getSettings().officialTag}\\]`));
    expect(upd.windowEntries(t.id, '').some(i => i.source === 'update')).toBe(false);
    expect(repo.interactionsNeedingExec(500).some(i => i.source === 'update')).toBe(false);
    expect(upd.deskRow(t.id)!.state).toBe('posted');
    upd.unpostUpdate(d.id);
    expect(repo.listInteractions(t.id).filter(i => i.source === 'update')).toHaveLength(0);
    expect(upd.deskRow(t.id)!.state).toBe('draft');
  });

  it('a parent with children reports through them unless it sets its own cadence; biweekly skips a week', () => {
    const p = base({ customer: 'Fam Co', title: 'parent' }); repo.insertTrr(p);
    const c = base({ customer: 'Fam Co', title: 'kid', parentId: p.id }); repo.insertTrr(c);
    let ids = upd.buildDesk().rows.map(r => r.trr.id);
    expect(ids).toContain(c.id);
    expect(ids).not.toContain(p.id);
    repo.updateTrr(p.id, { updateCadence: 'weekly' });
    ids = upd.buildDesk().rows.map(r => r.trr.id);
    expect(ids).toContain(p.id);

    const b = base({ customer: 'Fam Co', title: 'biweekly', updateCadence: 'biweekly' }); repo.insertTrr(b);
    const prev = cyc.addDays(due(), -7);
    const u = repo.saveUpdateDraft({ trrId: b.id, cycleDue: prev, windowFrom: '', windowTo: '', interactions: 0, text: 'x', model: '' });
    repo.markUpdatePosted(u.id);
    expect(upd.deskRow(b.id)!.state).toBe('not-due');
  });

  it('closed and deactivated TRs drop off the desk', () => {
    const t = base({ customer: 'Gone Co', title: 'closing' }); repo.insertTrr(t);
    repo.updateTrr(t.id, { status: 'Closed Won' });
    expect(upd.deskRow(t.id)).toBeNull();
  });

  it('aggregates every draft into one block and lists who is missing', async () => {
    const t = base({ customer: 'Agg Co', title: 'agg', externalId: 'TR-900' }); repo.insertTrr(t);
    log(t.id, 1);
    await upd.draftUpdate(t.id, due());
    const text = upd.aggregateText(upd.buildDesk());
    expect(text).toContain('TR-900 — Agg Co — agg');
    expect(text).toMatch(/No update yet \(\d+\):/);
  });

  it('a posted update is never overwritten by a redraft', async () => {
    const t = base({ customer: 'Keep Co', title: 'k' }); repo.insertTrr(t);
    log(t.id, 1);
    const d = await upd.draftUpdate(t.id, due());
    repo.editUpdateText(d.id, 'hand written');
    upd.postUpdate(d.id);
    await upd.draftUpdate(t.id, due());
    expect(repo.getUpdateById(d.id)!.text).toBe('hand written');
  });
});

describe('summary planning', () => {
  it('is incremental after the first version and up to date when nothing is new', () => {
    const t = base({ customer: 'Sum Co', title: 's' }); repo.insertTrr(t);
    log(t.id, 3);
    expect(planSummary('trr', t.id)!.mode).toBe('full');
    const entries = repo.interactionsFor([t.id]);
    repo.insertSummary({
      scopeKind: 'trr', scopeId: t.id, label: 's', interactions: entries.length,
      first: entries[0]!.date, last: entries[0]!.date, through: entries[0]!.createdAt,
      summary: 'so far', model: 'm', mode: 'full', baseId: null,
    });
    expect(planSummary('trr', t.id)!.mode).toBe('up-to-date');
    log(t.id, 0, 'something new');
    const plan = planSummary('trr', t.id)!;
    expect(plan.mode).toBe('incremental');
    expect(plan.newEntries).toBe(1);
    expect(planSummary('trr', t.id, true)!.mode).toBe('full');
  });
});

describe('demo data', () => {
  it('seeds a hierarchy and removes it cleanly, customers included', () => {
    repo.eraseAllData();
    seedIfEmpty();
    const all = repo.listTrrs('all');
    expect(all.some(t => t.parentId)).toBe(true);
    expect(all.filter(t => t.externalId).length).toBeGreaterThan(5);
    expect(repo.listOpportunities().length).toBeGreaterThan(0);
    expect(repo.listUpdates().some(u => u.status === 'posted')).toBe(true);
    repo.removeSeedData();
    const c = repo.counts();
    expect(c.trrs).toBe(0);
    expect(c.customers).toBe(0);
    expect(c.opportunities).toBe(0);
  });
});
