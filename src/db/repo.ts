import { db } from './index.js';
import { config } from '../config.js';
import type {
  Customer, Interaction, NewInteraction, NewTrr, Opportunity, ScopeSummary, Settings,
  StoredDigest, SummaryScopeKind, Trr, TrrHistoryEntry, TrUpdate,
} from '../types.js';
import {
  DEFAULT_ARCHIVED_STATUS, DEFAULT_CLOSED_STATUSES, DEFAULT_OUTCOMES,
  DEFAULT_ROLES, DEFAULT_STATUSES, DEFAULT_THEMES, UPDATE_CADENCES, uid,
} from '../types.js';

// --- row mapping -----------------------------------------------------------

type TrrRow = {
  id: string; num: number; customer: string; title: string; status: string; complexity: string;
  priority: string; contact: string; rep: string; target_close: string;
  description: string; my_role: string; outcome: string; value_theme: string;
  deactivated: number; deactivated_at: string; created_at: string; last_contact: string;
  customer_id: string | null; opportunity_id: string | null; parent_id: string | null;
  external_id: string; update_cadence: string;
};

type IntRow = {
  id: string; trr_id: string; type: string; date: string; note: string;
  ai_exec: string; ai_cust: string; sensitive: number; source: string; created_at: string;
};

function toTrr(r: TrrRow): Trr {
  return {
    id: r.id, num: r.num, customer: r.customer, title: r.title,
    status: r.status as Trr['status'], complexity: r.complexity as Trr['complexity'],
    priority: r.priority as Trr['priority'], contact: r.contact, rep: r.rep,
    targetClose: r.target_close, description: r.description,
    myRole: r.my_role, outcome: r.outcome,
    valueThemes: r.value_theme ? r.value_theme.split(',').filter(Boolean) : [],
    deactivated: !!r.deactivated, deactivatedAt: r.deactivated_at,
    createdAt: r.created_at, lastContact: r.last_contact,
    customerId: r.customer_id ?? '', opportunityId: r.opportunity_id ?? '',
    parentId: r.parent_id ?? '', externalId: r.external_id ?? '',
    updateCadence: (UPDATE_CADENCES as readonly string[]).includes(r.update_cadence)
      ? r.update_cadence as Trr['updateCadence'] : '',
  };
}

function toInteraction(r: IntRow): Interaction {
  return {
    id: r.id, trrId: r.trr_id, type: r.type as Interaction['type'], date: r.date,
    note: r.note, aiExec: r.ai_exec, aiCust: r.ai_cust,
    sensitive: !!r.sensitive, source: r.source ?? '', createdAt: r.created_at,
  };
}

// --- TRs -------------------------------------------------------------------

export function listTrrs(scope: 'active' | 'closed' | 'all' = 'all'): Trr[] {
  if (scope === 'all') {
    return (db.prepare('SELECT * FROM trrs').all() as TrrRow[]).map(toTrr);
  }
  // "closed" statuses are user-configurable, so filter dynamically
  const closed = getSettings().closedStatuses;
  const ph = closed.map(() => '?').join(',');
  const where = scope === 'active' ? `WHERE status NOT IN (${ph})` : `WHERE status IN (${ph})`;
  return (db.prepare(`SELECT * FROM trrs ${where}`).all(...closed) as TrrRow[]).map(toTrr);
}

export function getTrr(id: string): Trr | null {
  const r = db.prepare('SELECT * FROM trrs WHERE id = ?').get(id) as TrrRow | undefined;
  return r ? toTrr(r) : null;
}

/** Raised when a save would break the hierarchy rules; the message is user-facing. */
export class HierarchyError extends Error {}

/**
 * Enforce the hierarchy on a TR about to be saved and fill the derived fields:
 *  - one level only: a parent cannot have a parent, and a TR with children cannot become a child;
 *  - a child inherits its parent's customer and opportunity (they are the parent's, not its own);
 *  - otherwise the customer is resolved from customerId, or created from the free-text name;
 *  - an opportunity must belong to the TR's customer, else it is cleared.
 */
function resolveHierarchy<T extends Partial<Trr> & { id: string; customer: string }>(t: T): T & Pick<Trr, 'customerId' | 'opportunityId' | 'parentId'> {
  const out = { ...t, customerId: t.customerId ?? '', opportunityId: t.opportunityId ?? '', parentId: t.parentId ?? '' };
  if (out.parentId) {
    if (out.parentId === out.id) throw new HierarchyError('A TR cannot be its own parent.');
    const parent = getTrr(out.parentId);
    if (!parent) throw new HierarchyError('The selected parent TR no longer exists.');
    if (parent.parentId) throw new HierarchyError(`#${parent.num} is itself a child TR — only one level of children is supported.`);
    if (listChildren(out.id).length) throw new HierarchyError('This TR has child TRs of its own, so it cannot become a child.');
    out.customerId = parent.customerId;
    out.customer = parent.customer;
    out.opportunityId = parent.opportunityId;
    return out;
  }
  const byId = out.customerId ? getCustomer(out.customerId) : null;
  const cust = byId && (!out.customer || byId.name.toLowerCase() === out.customer.trim().toLowerCase())
    ? byId : ensureCustomer(out.customer);
  out.customerId = cust.id;
  out.customer = cust.name;
  if (out.opportunityId) {
    const opp = getOpportunity(out.opportunityId);
    if (!opp || opp.customerId !== cust.id) out.opportunityId = '';
  }
  return out;
}

const nul = (v: string) => (v ? v : null);

export function insertTrr(input: NewTrr): void {
  db.transaction(() => {
    const t = resolveHierarchy({ externalId: '', updateCadence: '', ...input });
    const next = (db.prepare('SELECT COALESCE(MAX(num), 0) + 1 AS n FROM trrs').get() as { n: number }).n;
    db.prepare(`
      INSERT INTO trrs (id, num, customer, title, status, complexity, priority, contact, rep,
        target_close, description, my_role, outcome, value_theme,
        deactivated, deactivated_at, created_at, last_contact,
        customer_id, opportunity_id, parent_id, external_id, update_cadence)
      VALUES (@id, @num, @customer, @title, @status, @complexity, @priority, @contact, @rep,
        @targetClose, @description, @myRole, @outcome, @valueTheme,
        @deactivated, @deactivatedAt, @createdAt, @lastContact,
        @customerIdN, @opportunityIdN, @parentIdN, @externalId, @updateCadence)
    `).run({
      ...t, num: next, valueTheme: t.valueThemes.join(','), deactivated: t.deactivated ? 1 : 0,
      customerIdN: nul(t.customerId), opportunityIdN: nul(t.opportunityId), parentIdN: nul(t.parentId),
    });
    recordHistory(t.id, 'created', '', t.status, t.createdAt);
    if (t.parentId) recordHistory(t.id, 'parent', '', `#${getTrr(t.parentId)?.num ?? '?'}`, t.createdAt);
  })();
}

// Fields whose changes belong in the audit trail.
const TRACKED: { key: keyof Trr; label: string }[] = [
  { key: 'status', label: 'status' },
  { key: 'complexity', label: 'complexity' },
  { key: 'priority', label: 'priority' },
  { key: 'myRole', label: 'my role' },
  { key: 'outcome', label: 'outcome' },
  { key: 'externalId', label: 'TR ID' },
  { key: 'customer', label: 'customer' },
];

export function updateTrr(id: string, patch: Partial<Trr>): void {
  const cur = getTrr(id);
  if (!cur) return;
  db.transaction(() => {
    // A rename of the customer text without a new customerId means "move to that customer".
    const merged = { ...cur, ...patch };
    if (patch.customer !== undefined && patch.customerId === undefined && patch.customer.trim().toLowerCase() !== cur.customer.toLowerCase()) {
      merged.customerId = '';
    }
    const t = resolveHierarchy(merged);
    db.prepare(`
      UPDATE trrs SET customer=@customer, title=@title, status=@status, complexity=@complexity,
        priority=@priority, contact=@contact, rep=@rep, target_close=@targetClose,
        description=@description, my_role=@myRole, outcome=@outcome, value_theme=@valueTheme,
        deactivated=@deactivated, deactivated_at=@deactivatedAt, last_contact=@lastContact,
        customer_id=@customerIdN, opportunity_id=@opportunityIdN, parent_id=@parentIdN,
        external_id=@externalId, update_cadence=@updateCadence
      WHERE id=@id
    `).run({
      ...t, valueTheme: t.valueThemes.join(','), deactivated: t.deactivated ? 1 : 0,
      customerIdN: nul(t.customerId), opportunityIdN: nul(t.opportunityId), parentIdN: nul(t.parentId),
    });
    for (const { key, label } of TRACKED) {
      if (String(cur[key] ?? '') !== String(t[key] ?? '')) {
        recordHistory(id, label, String(cur[key] ?? ''), String(t[key] ?? ''));
      }
    }
    if (cur.opportunityId !== t.opportunityId) {
      recordHistory(id, 'opportunity', oppName(cur.opportunityId), oppName(t.opportunityId));
    }
    if (cur.parentId !== t.parentId) {
      const num = (pid: string) => (pid ? `#${getTrr(pid)?.num ?? '?'}` : '');
      recordHistory(id, 'parent', num(cur.parentId), num(t.parentId));
    }
    const curThemes = cur.valueThemes.join(', ');
    const newThemes = t.valueThemes.join(', ');
    if (curThemes !== newThemes) recordHistory(id, 'value themes', curThemes, newThemes);
    if (cur.deactivated !== t.deactivated) {
      recordHistory(id, 'deactivation', cur.deactivated ? 'deactivated' : 'active',
        t.deactivated ? 'deactivated' : 'active');
    }
    // Children follow their parent's customer and opportunity — and the move is
    // recorded on each child too, so every TR's own trail is complete.
    if (cur.customerId !== t.customerId || cur.opportunityId !== t.opportunityId) {
      const via = `via parent #${cur.num}`;
      for (const c of listChildren(id)) {
        db.prepare('UPDATE trrs SET customer=?, customer_id=?, opportunity_id=? WHERE id=?')
          .run(t.customer, nul(t.customerId), nul(t.opportunityId), c.id);
        if (c.customer !== t.customer) recordHistory(c.id, `customer (${via})`, c.customer, t.customer);
        if (c.opportunityId !== t.opportunityId) {
          recordHistory(c.id, `opportunity (${via})`, oppName(c.opportunityId), oppName(t.opportunityId));
        }
      }
    }
  })();
}

function oppName(id: string): string {
  return id ? (getOpportunity(id)?.name ?? '?') : '';
}

export function deleteTrr(id: string): void {
  // children survive as standalone TRs (parent_id ON DELETE SET NULL)
  db.transaction(() => {
    db.prepare(`DELETE FROM summaries WHERE scope_kind IN ('trr','family') AND scope_id = ?`).run(id);
    db.prepare('DELETE FROM trrs WHERE id = ?').run(id);
  })();
}

// --- Hierarchy -------------------------------------------------------------

export function listChildren(parentId: string): Trr[] {
  return (db.prepare('SELECT * FROM trrs WHERE parent_id = ? ORDER BY num').all(parentId) as TrrRow[]).map(toTrr);
}

/** Map parentId -> children, for rendering trees without N queries. */
export function childrenIndex(trrs: Trr[]): Map<string, Trr[]> {
  const m = new Map<string, Trr[]>();
  for (const t of trrs) {
    if (!t.parentId) continue;
    if (!m.has(t.parentId)) m.set(t.parentId, []);
    m.get(t.parentId)!.push(t);
  }
  for (const list of m.values()) list.sort((a, b) => a.num - b.num);
  return m;
}

/**
 * Health roll-up for display. A parent TR holds the project-management side of
 * a request (assignments, resourcing, coordination) while the work is logged on
 * its children — so a parent counts as actively worked when ANY child is. The
 * returned copies give each parent the family's most recent contact, keeping its
 * own in `ownLastContact`. Children are unchanged. View-only: never save these.
 */
export function withFamilyActivity(trrs: Trr[]): Trr[] {
  const kids = childrenIndex(listTrrs('all'));
  return trrs.map(t => {
    let best = t.lastContact;
    let via: Trr | undefined;
    for (const k of kids.get(t.id) ?? []) {
      if (k.lastContact && k.lastContact > best) { best = k.lastContact; via = k; }
    }
    return via ? { ...t, lastContact: best, ownLastContact: t.lastContact, activityVia: via.num } : t;
  });
}

/** A TR plus its children (or just itself when it has none). */
export function familyOf(id: string): Trr[] {
  const t = getTrr(id);
  if (!t) return [];
  return [t, ...listChildren(t.id)];
}

// --- Customers -------------------------------------------------------------

type CustRow = { id: string; name: string; notes: string; created_at: string };
const toCustomer = (r: CustRow): Customer => ({ id: r.id, name: r.name, notes: r.notes, createdAt: r.created_at });

export function listCustomers(): Customer[] {
  return (db.prepare('SELECT * FROM customers ORDER BY name COLLATE NOCASE').all() as CustRow[]).map(toCustomer);
}

export function getCustomer(id: string): Customer | null {
  const r = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as CustRow | undefined;
  return r ? toCustomer(r) : null;
}

export function findCustomerByName(name: string): Customer | null {
  const r = db.prepare('SELECT * FROM customers WHERE name = ? COLLATE NOCASE').get(name.trim()) as CustRow | undefined;
  return r ? toCustomer(r) : null;
}

/** Find by (case-insensitive) name, or create. */
export function ensureCustomer(name: string): Customer {
  const clean = name.trim();
  if (!clean) throw new HierarchyError('Customer is required.');
  const found = findCustomerByName(clean);
  if (found) return found;
  const c: Customer = { id: uid(), name: clean, notes: '', createdAt: new Date().toISOString() };
  db.prepare('INSERT INTO customers (id, name, notes, created_at) VALUES (@id, @name, @notes, @createdAt)').run(c);
  return c;
}

export function updateCustomer(id: string, patch: { name?: string; notes?: string }): void {
  const cur = getCustomer(id);
  if (!cur) return;
  const name = (patch.name ?? cur.name).trim() || cur.name;
  const clash = findCustomerByName(name);
  if (clash && clash.id !== id) throw new HierarchyError(`A customer named "${clash.name}" already exists — merge into it instead.`);
  db.transaction(() => {
    db.prepare('UPDATE customers SET name = ?, notes = ? WHERE id = ?').run(name, patch.notes ?? cur.notes, id);
    if (name !== cur.name) {
      const ids = db.prepare('SELECT id FROM trrs WHERE customer_id = ?').all(id) as { id: string }[];
      db.prepare('UPDATE trrs SET customer = ? WHERE customer_id = ?').run(name, id);
      for (const r of ids) recordHistory(r.id, 'customer', cur.name, name);
    }
  })();
}

/** Fold one customer into another: TRs and opportunities move, the source is removed. */
export function mergeCustomer(fromId: string, intoId: string): void {
  const from = getCustomer(fromId), into = getCustomer(intoId);
  if (!from || !into || fromId === intoId) return;
  db.transaction(() => {
    const ids = db.prepare('SELECT id FROM trrs WHERE customer_id = ?').all(fromId) as { id: string }[];
    db.prepare('UPDATE trrs SET customer_id = ?, customer = ? WHERE customer_id = ?').run(intoId, into.name, fromId);
    db.prepare('UPDATE opportunities SET customer_id = ? WHERE customer_id = ?').run(intoId, fromId);
    for (const r of ids) recordHistory(r.id, 'customer', from.name, into.name);
    db.prepare(`UPDATE summaries SET scope_id = ? WHERE scope_kind = 'customer' AND scope_id = ?`).run(intoId, fromId);
    db.prepare('DELETE FROM customers WHERE id = ?').run(fromId);
  })();
}

/** Only an empty customer can be deleted (no TRs); its opportunities go with it. */
export function deleteCustomer(id: string): boolean {
  const n = (db.prepare('SELECT count(*) n FROM trrs WHERE customer_id = ?').get(id) as { n: number }).n;
  if (n > 0) return false;
  db.transaction(() => {
    db.prepare(`DELETE FROM summaries WHERE scope_kind = 'opportunity' AND scope_id IN (SELECT id FROM opportunities WHERE customer_id = ?)`).run(id);
    db.prepare(`DELETE FROM summaries WHERE scope_kind = 'customer' AND scope_id = ?`).run(id);
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  })();
  return true;
}

// --- Opportunities ---------------------------------------------------------

type OppRow = { id: string; customer_id: string; name: string; stage: string; rep: string; close_date: string; notes: string; created_at: string };
const toOpp = (r: OppRow): Opportunity => ({
  id: r.id, customerId: r.customer_id, name: r.name, stage: r.stage, rep: r.rep,
  closeDate: r.close_date, notes: r.notes, createdAt: r.created_at,
});

export function listOpportunities(customerId?: string): Opportunity[] {
  const rows = customerId
    ? db.prepare('SELECT * FROM opportunities WHERE customer_id = ? ORDER BY created_at').all(customerId)
    : db.prepare('SELECT * FROM opportunities ORDER BY created_at').all();
  return (rows as OppRow[]).map(toOpp);
}

export function getOpportunity(id: string): Opportunity | null {
  const r = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(id) as OppRow | undefined;
  return r ? toOpp(r) : null;
}

export function insertOpportunity(o: Omit<Opportunity, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Opportunity {
  if (!getCustomer(o.customerId)) throw new HierarchyError('Unknown customer.');
  if (!o.name.trim()) throw new HierarchyError('Opportunity name is required.');
  const opp: Opportunity = { ...o, name: o.name.trim(), id: o.id ?? uid(), createdAt: o.createdAt ?? new Date().toISOString() };
  db.prepare(`INSERT INTO opportunities (id, customer_id, name, stage, rep, close_date, notes, created_at)
    VALUES (@id, @customerId, @name, @stage, @rep, @closeDate, @notes, @createdAt)`).run(opp);
  return opp;
}

export function updateOpportunity(id: string, patch: Partial<Omit<Opportunity, 'id' | 'customerId' | 'createdAt'>>): void {
  const cur = getOpportunity(id);
  if (!cur) return;
  const o = { ...cur, ...patch, name: (patch.name ?? cur.name).trim() || cur.name };
  db.transaction(() => {
    db.prepare(`UPDATE opportunities SET name=@name, stage=@stage, rep=@rep, close_date=@closeDate, notes=@notes WHERE id=@id`).run(o);
    // The trail stores names, so a rename is written to every TR in it to keep the chain readable.
    if (o.name !== cur.name) for (const t of trrsInOpportunity(id)) recordHistory(t.id, 'opportunity (renamed)', cur.name, o.name);
    if (o.stage !== cur.stage) for (const t of trrsInOpportunity(id)) recordHistory(t.id, `opportunity stage (${o.name})`, cur.stage, o.stage);
  })();
}

function trrsInOpportunity(id: string): { id: string }[] {
  return db.prepare('SELECT id FROM trrs WHERE opportunity_id = ?').all(id) as { id: string }[];
}

/** Every opportunity move/rename/delete recorded on TRs, for an opportunity's audit view. */
export function opportunityAudit(names: string[]): (TrrHistoryEntry & { num: number; title: string })[] {
  if (!names.length) return [];
  const ph = names.map(() => '?').join(',');
  return (db.prepare(`
    SELECT h.*, t.num, t.title FROM trr_history h JOIN trrs t ON t.id = h.trr_id
    WHERE h.field LIKE 'opportunity%' AND (h.old_value IN (${ph}) OR h.new_value IN (${ph}))
    ORDER BY h.changed_at DESC, h.id DESC
  `).all(...names, ...names) as { id: number; trr_id: string; changed_at: string; field: string; old_value: string; new_value: string; num: number; title: string }[])
    .map(r => ({ id: r.id, trrId: r.trr_id, changedAt: r.changed_at, field: r.field, oldValue: r.old_value, newValue: r.new_value, num: r.num, title: r.title }));
}

/** TRs in the opportunity become unassigned (ON DELETE SET NULL), never deleted. */
export function deleteOpportunity(id: string): void {
  const cur = getOpportunity(id);
  db.transaction(() => {
    if (cur) for (const t of trrsInOpportunity(id)) recordHistory(t.id, 'opportunity (deleted)', cur.name, '');
    db.prepare(`DELETE FROM summaries WHERE scope_kind = 'opportunity' AND scope_id = ?`).run(id);
    db.prepare('DELETE FROM opportunities WHERE id = ?').run(id);
  })();
}

// --- History (audit trail) -------------------------------------------------

export function recordHistory(trrId: string, field: string, oldValue: string, newValue: string, at?: string): void {
  db.prepare(`
    INSERT INTO trr_history (trr_id, changed_at, field, old_value, new_value)
    VALUES (?, ?, ?, ?, ?)
  `).run(trrId, at ?? new Date().toISOString(), field, oldValue, newValue);
}

export function allHistory(): TrrHistoryEntry[] {
  return (db.prepare('SELECT * FROM trr_history ORDER BY changed_at').all() as
    { id: number; trr_id: string; changed_at: string; field: string; old_value: string; new_value: string }[])
    .map(r => ({ id: r.id, trrId: r.trr_id, changedAt: r.changed_at, field: r.field, oldValue: r.old_value, newValue: r.new_value }));
}

export function listHistory(trrId: string): TrrHistoryEntry[] {
  return (db.prepare('SELECT * FROM trr_history WHERE trr_id = ? ORDER BY changed_at DESC, id DESC')
    .all(trrId) as { id: number; trr_id: string; changed_at: string; field: string; old_value: string; new_value: string }[])
    .map(r => ({ id: r.id, trrId: r.trr_id, changedAt: r.changed_at, field: r.field, oldValue: r.old_value, newValue: r.new_value }));
}

// --- Interactions ----------------------------------------------------------

export function listInteractions(trrId: string): Interaction[] {
  return (db.prepare('SELECT * FROM interactions WHERE trr_id = ? ORDER BY date DESC, created_at DESC')
    .all(trrId) as IntRow[]).map(toInteraction);
}

export function allInteractions(): Interaction[] {
  return (db.prepare('SELECT * FROM interactions').all() as IntRow[]).map(toInteraction);
}

export function getInteraction(id: string): Interaction | null {
  const r = db.prepare('SELECT * FROM interactions WHERE id = ?').get(id) as IntRow | undefined;
  return r ? toInteraction(r) : null;
}

export function insertInteraction(input: NewInteraction): void {
  const i: Interaction = { source: '', ...input };
  db.prepare(`
    INSERT INTO interactions (id, trr_id, type, date, note, ai_exec, ai_cust, sensitive, source, created_at)
    VALUES (@id, @trrId, @type, @date, @note, @aiExec, @aiCust, @sensitive, @source, @createdAt)
  `).run({ ...i, sensitive: i.sensitive ? 1 : 0 });
}

export function updateInteraction(id: string, patch: Partial<Interaction>): void {
  const cur = getInteraction(id);
  if (!cur) return;
  const i = { ...cur, ...patch };
  // A flagged log must not keep anything a model derived from it.
  if (i.sensitive) {
    i.aiExec = '';
    i.aiCust = '';
    db.prepare('DELETE FROM embeddings WHERE interaction_id = ?').run(id);
  }
  db.prepare(`
    UPDATE interactions SET type=@type, date=@date, note=@note, ai_exec=@aiExec,
      ai_cust=@aiCust, sensitive=@sensitive WHERE id=@id
  `).run({ ...i, sensitive: i.sensitive ? 1 : 0 });
}

export function deleteInteraction(id: string): void {
  db.prepare('DELETE FROM interactions WHERE id = ?').run(id);
}

// --- Interaction links (one log, several TRs) --------------------------------

/** Replace the extra TRs a log is linked to (the owning TR is implicit, never a link). */
export function setInteractionLinks(interactionId: string, trrIds: string[]): void {
  const owner = getInteraction(interactionId)?.trrId;
  const ids = [...new Set(trrIds)].filter(id => id && id !== owner && getTrr(id));
  db.transaction(() => {
    db.prepare('DELETE FROM interaction_links WHERE interaction_id = ?').run(interactionId);
    const ins = db.prepare('INSERT INTO interaction_links (interaction_id, trr_id) VALUES (?, ?)');
    for (const id of ids) ins.run(interactionId, id);
  })();
}

export function interactionLinks(interactionId: string): string[] {
  return (db.prepare('SELECT trr_id FROM interaction_links WHERE interaction_id = ?').all(interactionId) as { trr_id: string }[])
    .map(r => r.trr_id);
}

/** interactionId -> linked TR ids, for every link (render-time lookup). */
export function allInteractionLinks(): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const r of db.prepare('SELECT interaction_id, trr_id FROM interaction_links').all() as { interaction_id: string; trr_id: string }[]) {
    if (!m.has(r.interaction_id)) m.set(r.interaction_id, []);
    m.get(r.interaction_id)!.push(r.trr_id);
  }
  return m;
}

/**
 * Every log that belongs to any of these TRs — owned or linked — de-duplicated,
 * newest first. This is the record a TR / family / opportunity / customer view
 * and the weekly update read from.
 */
export function interactionsFor(trrIds: string[]): Interaction[] {
  if (trrIds.length === 0) return [];
  const ph = trrIds.map(() => '?').join(',');
  return (db.prepare(`
    SELECT * FROM interactions WHERE trr_id IN (${ph})
    UNION
    SELECT i.* FROM interactions i JOIN interaction_links l ON l.interaction_id = i.id WHERE l.trr_id IN (${ph})
    ORDER BY date DESC, created_at DESC
  `).all(...trrIds, ...trrIds) as IntRow[]).map(toInteraction);
}

/** Text that may go to a model: flagged logs are reduced to a placeholder, never their content. */
export function aiSafeText(i: Interaction): string {
  return i.sensitive ? '[flagged entry — content withheld from AI]' : (i.aiExec || i.note);
}

/** Interactions with substantive notes and no exec summary yet (backfill queue). */
export function interactionsNeedingExec(limit: number): Interaction[] {
  return (db.prepare(`
    SELECT * FROM interactions
    WHERE length(trim(note)) >= 40 AND ai_exec = '' AND source <> 'update' AND sensitive = 0 ORDER BY date DESC LIMIT ?
  `).all(limit) as IntRow[]).map(toInteraction);
}

// --- Digests ---------------------------------------------------------------

export function getDigest(trrId: string): StoredDigest | null {
  const r = db.prepare('SELECT * FROM digests WHERE trr_id = ?').get(trrId) as
    | { trr_id: string; customer: string; title: string; status: string; interactions: number;
        first: string; last: string; summary: string; model: string; generated_at: string }
    | undefined;
  if (!r) return null;
  return {
    trrId: r.trr_id, customer: r.customer, title: r.title, status: r.status,
    interactions: r.interactions, first: r.first, last: r.last,
    summary: r.summary, model: r.model, generatedAt: r.generated_at,
  };
}

export function listDigests(): StoredDigest[] {
  return (db.prepare('SELECT trr_id FROM digests ORDER BY generated_at DESC').all() as { trr_id: string }[])
    .map(r => getDigest(r.trr_id)!)
    .filter(Boolean);
}

export function upsertDigest(d: StoredDigest): void {
  db.prepare(`
    INSERT INTO digests (trr_id, customer, title, status, interactions, first, last, summary, model, generated_at)
    VALUES (@trrId, @customer, @title, @status, @interactions, @first, @last, @summary, @model, @generatedAt)
    ON CONFLICT(trr_id) DO UPDATE SET customer=@customer, title=@title, status=@status,
      interactions=@interactions, first=@first, last=@last, summary=@summary,
      model=@model, generated_at=@generatedAt
  `).run(d);
}

// --- Period reports (persisted digest runs) --------------------------------

export interface PeriodReportMeta {
  id: number;
  fromDate: string;
  toDate: string;
  model: string;
  generatedAt: string;
  narrativeChars: number;
}

export function insertPeriodReport(r: {
  fromDate: string; toDate: string; statsJson: string; narrative: string; model: string;
}): number {
  const res = db.prepare(`
    INSERT INTO period_reports (from_date, to_date, stats_json, narrative, model, generated_at)
    VALUES (@fromDate, @toDate, @statsJson, @narrative, @model, @generatedAt)
  `).run({ ...r, generatedAt: new Date().toISOString() });
  return Number(res.lastInsertRowid);
}

export function listPeriodReports(): PeriodReportMeta[] {
  return (db.prepare(`
    SELECT id, from_date, to_date, model, generated_at, length(narrative) AS chars
    FROM period_reports ORDER BY generated_at DESC
  `).all() as { id: number; from_date: string; to_date: string; model: string; generated_at: string; chars: number }[])
    .map(r => ({ id: r.id, fromDate: r.from_date, toDate: r.to_date, model: r.model, generatedAt: r.generated_at, narrativeChars: r.chars }));
}

export function getPeriodReport(id: number): { meta: PeriodReportMeta; statsJson: string; narrative: string } | null {
  const r = db.prepare('SELECT * FROM period_reports WHERE id = ?').get(id) as
    | { id: number; from_date: string; to_date: string; stats_json: string; narrative: string; model: string; generated_at: string }
    | undefined;
  if (!r) return null;
  return {
    meta: { id: r.id, fromDate: r.from_date, toDate: r.to_date, model: r.model, generatedAt: r.generated_at, narrativeChars: r.narrative.length },
    statsJson: r.stats_json, narrative: r.narrative,
  };
}

export function deletePeriodReport(id: number): void {
  db.prepare('DELETE FROM period_reports WHERE id = ?').run(id);
}

// --- Weekly updates -----------------------------------------------------------

type UpdRow = {
  id: number; trr_id: string; cycle_due: string; window_from: string; window_to: string;
  interactions: number; text: string; model: string; status: string; edited: number;
  generated_at: string; posted_at: string;
};
const toUpdate = (r: UpdRow): TrUpdate => ({
  id: r.id, trrId: r.trr_id, cycleDue: r.cycle_due, windowFrom: r.window_from, windowTo: r.window_to,
  interactions: r.interactions, text: r.text, model: r.model,
  status: r.status === 'posted' ? 'posted' : 'draft', edited: !!r.edited,
  generatedAt: r.generated_at, postedAt: r.posted_at,
});

export function getUpdate(trrId: string, cycleDue: string): TrUpdate | null {
  const r = db.prepare('SELECT * FROM updates WHERE trr_id = ? AND cycle_due = ?').get(trrId, cycleDue) as UpdRow | undefined;
  return r ? toUpdate(r) : null;
}

export function getUpdateById(id: number): TrUpdate | null {
  const r = db.prepare('SELECT * FROM updates WHERE id = ?').get(id) as UpdRow | undefined;
  return r ? toUpdate(r) : null;
}

export function listUpdates(trrId?: string): TrUpdate[] {
  const rows = trrId
    ? db.prepare('SELECT * FROM updates WHERE trr_id = ? ORDER BY cycle_due DESC').all(trrId)
    : db.prepare('SELECT * FROM updates ORDER BY cycle_due DESC, trr_id').all();
  return (rows as UpdRow[]).map(toUpdate);
}

export function updatesForCycle(cycleDue: string): Map<string, TrUpdate> {
  const rows = db.prepare('SELECT * FROM updates WHERE cycle_due = ?').all(cycleDue) as UpdRow[];
  return new Map(rows.map(r => [r.trr_id, toUpdate(r)]));
}

/** trrId -> the most recent POSTED update (the "since" anchor of the next window). */
export function lastPostedUpdates(before?: string): Map<string, TrUpdate> {
  const rows = (before
    ? db.prepare(`SELECT * FROM updates WHERE status = 'posted' AND cycle_due < ? ORDER BY posted_at`).all(before)
    : db.prepare(`SELECT * FROM updates WHERE status = 'posted' ORDER BY posted_at`).all()) as UpdRow[];
  const m = new Map<string, TrUpdate>();
  for (const r of rows) m.set(r.trr_id, toUpdate(r)); // ascending, so the last write wins
  return m;
}

/** Create or replace the draft for (TR, cycle). A posted update is never overwritten. */
export function saveUpdateDraft(u: Pick<TrUpdate, 'trrId' | 'cycleDue' | 'windowFrom' | 'windowTo' | 'interactions' | 'text' | 'model'> & { edited?: boolean }): TrUpdate {
  const cur = getUpdate(u.trrId, u.cycleDue);
  if (cur?.status === 'posted') return cur;
  db.prepare(`
    INSERT INTO updates (trr_id, cycle_due, window_from, window_to, interactions, text, model, status, edited, generated_at)
    VALUES (@trrId, @cycleDue, @windowFrom, @windowTo, @interactions, @text, @model, 'draft', @edited, @generatedAt)
    ON CONFLICT(trr_id, cycle_due) DO UPDATE SET window_from=@windowFrom, window_to=@windowTo,
      interactions=@interactions, text=@text, model=@model, edited=@edited, generated_at=@generatedAt
  `).run({ ...u, edited: u.edited ? 1 : 0, generatedAt: new Date().toISOString() });
  return getUpdate(u.trrId, u.cycleDue)!;
}

/** Hand edit of a draft or a posted update's text. */
export function editUpdateText(id: number, text: string): void {
  db.prepare('UPDATE updates SET text = ?, edited = 1 WHERE id = ?').run(text, id);
}

export function markUpdatePosted(id: number, at = new Date().toISOString()): void {
  db.prepare(`UPDATE updates SET status = 'posted', posted_at = ?, window_to = CASE WHEN window_to = '' THEN ? ELSE window_to END WHERE id = ?`)
    .run(at, at, id);
}

export function unpostUpdate(id: number): void {
  db.prepare(`UPDATE updates SET status = 'draft', posted_at = '' WHERE id = ?`).run(id);
}

export function deleteUpdate(id: number): void {
  db.prepare('DELETE FROM updates WHERE id = ?').run(id);
}

// --- Summaries to date (versioned) ----------------------------------------------

type SumRow = {
  id: number; scope_kind: string; scope_id: string; label: string; interactions: number;
  first: string; last: string; through: string; summary: string; model: string; mode: string;
  base_id: number | null; generated_at: string;
};
const toSummary = (r: SumRow): ScopeSummary => ({
  id: r.id, scopeKind: r.scope_kind as SummaryScopeKind, scopeId: r.scope_id, label: r.label,
  interactions: r.interactions, first: r.first, last: r.last, through: r.through,
  summary: r.summary, model: r.model, mode: r.mode === 'incremental' ? 'incremental' : 'full',
  baseId: r.base_id, generatedAt: r.generated_at,
});

export function insertSummary(x: Omit<ScopeSummary, 'id' | 'generatedAt'>): number {
  const res = db.prepare(`
    INSERT INTO summaries (scope_kind, scope_id, label, interactions, first, last, through, summary, model, mode, base_id, generated_at)
    VALUES (@scopeKind, @scopeId, @label, @interactions, @first, @last, @through, @summary, @model, @mode, @baseId, @generatedAt)
  `).run({ ...x, generatedAt: new Date().toISOString() });
  return Number(res.lastInsertRowid);
}

export function listSummaries(kind: SummaryScopeKind, scopeId: string): ScopeSummary[] {
  return (db.prepare('SELECT * FROM summaries WHERE scope_kind = ? AND scope_id = ? ORDER BY generated_at DESC, id DESC')
    .all(kind, scopeId) as SumRow[]).map(toSummary);
}

export function latestSummary(kind: SummaryScopeKind, scopeId: string): ScopeSummary | null {
  return listSummaries(kind, scopeId)[0] ?? null;
}

export function getSummary(id: number): ScopeSummary | null {
  const r = db.prepare('SELECT * FROM summaries WHERE id = ?').get(id) as SumRow | undefined;
  return r ? toSummary(r) : null;
}

export function allSummaries(): ScopeSummary[] {
  return (db.prepare('SELECT * FROM summaries ORDER BY generated_at DESC').all() as SumRow[]).map(toSummary);
}

export function deleteSummary(id: number): void {
  db.prepare('DELETE FROM summaries WHERE id = ?').run(id);
}

// --- Reviews (question-driven, persisted) ----------------------------------

export interface ReviewMeta {
  id: number;
  generatedAt: string;
  model: string;
  questionCount: number;
  firstQuestion: string;
  scopeSummary: string;
}

export interface ReviewRow {
  id: number;
  questions: string[];
  instructions: string;
  scopeJson: string;
  answers: string;
  model: string;
  generatedAt: string;
}

export function insertReview(r: {
  questions: string[]; instructions: string; scopeJson: string; answers: string; model: string;
}): number {
  const res = db.prepare(`
    INSERT INTO reviews (questions, instructions, scope_json, answers, model, generated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(JSON.stringify(r.questions), r.instructions, r.scopeJson, r.answers, r.model, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

function scopeSummaryOf(scopeJson: string): string {
  try {
    const s = JSON.parse(scopeJson) as { from?: string; to?: string; trrIds?: string[]; roles?: string[]; themes?: string[] };
    const parts: string[] = [];
    if (s.from || s.to) parts.push(`${s.from || 'start'} → ${s.to || 'now'}`);
    if (s.roles?.length) parts.push(`roles: ${s.roles.join('/')}`);
    if (s.themes?.length) parts.push(`themes: ${s.themes.join(', ')}`);
    if (s.trrIds?.length) parts.push(`${s.trrIds.length} selected TRRs`);
    return parts.join(' · ') || 'all data';
  } catch { return ''; }
}

export function listReviews(): ReviewMeta[] {
  return (db.prepare('SELECT id, questions, scope_json, model, generated_at FROM reviews ORDER BY generated_at DESC')
    .all() as { id: number; questions: string; scope_json: string; model: string; generated_at: string }[])
    .map(r => {
      const qs = JSON.parse(r.questions) as string[];
      return {
        id: r.id, generatedAt: r.generated_at, model: r.model,
        questionCount: qs.length, firstQuestion: qs[0] ?? '',
        scopeSummary: scopeSummaryOf(r.scope_json),
      };
    });
}

export function getReview(id: number): ReviewRow | null {
  const r = db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as
    | { id: number; questions: string; instructions: string; scope_json: string; answers: string; model: string; generated_at: string }
    | undefined;
  if (!r) return null;
  return {
    id: r.id, questions: JSON.parse(r.questions) as string[], instructions: r.instructions,
    scopeJson: r.scope_json, answers: r.answers, model: r.model, generatedAt: r.generated_at,
  };
}

export function deleteReview(id: number): void {
  db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
}

// --- Settings --------------------------------------------------------------

const DEFAULT_CUST_TMPL = `Rewrite these raw interaction notes as a short, plain customer-facing summary.
Rules: factual only — use ONLY what is in the notes. No praise, hype, or value claims the notes do not support. Keep technical specifics (products, versions, IPs, dates). Professional, plain tone.

Customer: {{customer}} | Project: {{project}} | Contact: {{contact}} | Date: {{date}}

Raw notes:
{{notes}}`;

const DEFAULT_EXEC_TMPL = `Condense these raw notes into a terse executive summary for CRM. Output EXACTLY this format, nothing else — no headers, no markdown, no emoji:
-Status: <one line>
-Activity: <one or two lines, concrete facts only>
-Next: <one line, concrete next step or 'none'>

Rules: factual only, use ONLY the notes. Do not invent outcomes or claim wins the notes do not state.

Customer: {{customer}} | Project: {{project}} | Status: {{status}} | Date: {{date}}

Raw notes:
{{notes}}`;

const DEFAULT_EVAL_TMPL = `You are helping the engineer draft a period self-review from their engagement record. Write in first person ("I").

STRICT GROUNDING RULES:
- Use ONLY the facts and official updates provided below. Never invent customers, numbers, outcomes, or dates.
- Do NOT claim the person "led" or "owned" a deal unless the record explicitly says so; otherwise say "contributed to" / "supported".
- No praise or value claims the record does not support. Plain, factual, confident tone.
- If the data does not support a claim, omit it.

Produce concise draft answers for:
Q1. Outcomes achieved relative to goals and their impact.
Q2. One core value best demonstrated, with grounded evidence.
Q3. Skills/capabilities to prioritize next.

=== DETERMINISTIC FACTS (authoritative) ===
{{facts}}

=== OFFICIAL UPDATES (tagged / timestamped) ===
{{official}}`;

const DEFAULT_REVIEW_TMPL = `You are writing ONE answer to ONE question for the engineer's own performance self-evaluation, in their voice. Output ONLY the answer prose — no heading, no restating the question, no preamble, no sign-off. It will be pasted straight into a review form.

HOW TO WRITE IT:
- First person, past tense, confident but factual. A reviewer will read this.
- Flowing paragraphs (2-4). NOT a numbered or bulleted list — unless the question explicitly asks you to enumerate.
- Open with one sentence framing the period, then substantiate it. Where the question is about outcomes or impact, work the authoritative totals below into that opening.
- Name the actual customers, products, and technical specifics from the evidence. Specificity is what makes a self-evaluation credible; vague claims read as padding.
- Inline labels like "Results:" or "Impact:" are welcome where they help a reviewer skim a long answer.
- Aim for roughly 300-500 words unless the instructions below say otherwise.

STRICT GROUNDING RULES:
- Use ONLY the engagement data provided below. Never invent customers, numbers, outcomes, or dates.
- Do not claim I "led" or "owned" work unless the record says so (the "my role" field or an official update).
- For improvement/reflection questions ("what could I do better?"), ground observations in patterns actually visible in the data — stalled engagements, long gaps between contacts, lost deals and their stated reasons, backlog left unfinished. Do not fabricate strengths or weaknesses.
- If the record genuinely cannot support part of the question, say so in one short sentence rather than padding.

{{instructions}}

=== QUESTION ===
{{questions}}

=== DETERMINISTIC FACTS (authoritative, computed in code) ===
{{facts}}

=== OFFICIAL UPDATES (tagged official-record / timestamped — what was actually reported upstream) ===
{{official}}

=== EVIDENCE GATHERED FROM THE FULL RECORD ===
(The record was read in slices; every question-relevant finding from all slices is collected below. Facts above are authoritative for any counting.)
{{findings}}`;

// Map step. Run once per (question x record slice). Output stays terse on
// purpose — these findings are concatenated back into the reduce prompt, so
// verbosity here is what blows the budget at scale.
const DEFAULT_REVIEW_MAP_TMPL = `You are gathering raw material for an engineer's performance review. Below is ONE SLICE of their engagement record and ONE question.

Do NOT answer the question. Extract only the evidence in THIS SLICE that bears on it.

RULES:
- Use ONLY what appears in this slice. Never invent customers, dates, numbers, or outcomes.
- Terse bullets. Each: the customer/engagement, the concrete fact, and the date when present.
- Keep specifics worth quoting later — products, blockers, stated reasons for wins/losses, long gaps in contact, unfinished work.
- If this slice has nothing relevant to the question, reply with exactly: NONE

=== QUESTION ===
{{question}}

=== RECORD SLICE ({{slice}}) ===
{{engagements}}`;

const DEFAULT_TRR_DIGEST_TMPL = `Summarize this single customer engagement so I can get back up to speed on it quickly. Plain and factual, using ONLY the record below — never invent details.

Cover briefly:
- What the customer wanted / the use case
- What we did and key technical points or decisions (products, architecture, versions — keep specifics)
- Current status / outcome
- Open items or next steps still outstanding

Keep it tight — a short paragraph or a few bullets. No praise or filler.

=== ENGAGEMENT ===
Customer: {{customer}} | Title: {{title}} | Status: {{status}} | Complexity: {{complexity}} | Priority: {{priority}}
My role: {{myRole}} | Value theme: {{valueTheme}} | Contact: {{contact}} | Rep: {{rep}}
Description: {{description}}

=== INTERACTIONS (chronological) ===
{{interactions}}`;

// Weekly update: one TR ID, the entries logged since its last posted update.
const DEFAULT_UPDATE_TMPL = `Write the weekly status update for ONE technical request. It will be pasted straight into a tracking system. Output EXACTLY this format, nothing else — no heading, no markdown, no emoji:
-Status: <one line: where the request stands now>
-Activity: <one to three lines that COMBINE everything below into a single summary — not one line per entry>
-Next: <one line, concrete next step, or 'none'>

Rules: factual only, use ONLY the entries below. Never invent outcomes, dates, or next steps. Keep technical specifics (products, versions, sites, counts).

TR ID: {{externalId}} | Customer: {{customer}} | Opportunity: {{opportunity}} | Request: {{title}} | Parent request: {{parent}} | Status: {{status}}
Period: {{from}} to {{to}}

=== ENTRIES SINCE THE LAST UPDATE ({{count}}) ===
{{entries}}`;

// Summary to date for any scope. Full build: {{previous}} is empty. Incremental
// (or a record too big for one window): {{previous}} carries the summary so far
// and the entries are only what is new / the next slice.
const DEFAULT_SUMMARY_TMPL = `Write a summary-to-date of the engagement scope below, so someone can get fully up to speed on it. Plain and factual, using ONLY the material provided — never invent details.

Cover:
- What the customer wants (the use cases / requests)
- What has been done, with key technical points and decisions (keep specifics: products, architecture, versions)
- Current status of each request
- Open items and next steps still outstanding

When the scope holds several requests, open with a one-line overall picture, then a short section per request (lead with its TR ID when it has one). Keep it tight — no praise or filler.

=== SCOPE ===
{{scope}}

=== REQUESTS IN SCOPE ===
{{requests}}
{{previous}}
=== {{entriesLabel}} ===
{{entries}}`;

export function defaultSettings(): Settings {
  return {
    greenDays: 3, yellowDays: 5, archiveDays: 30, autoBackfillHours: 24,
    autoBackupEnabled: true, backupKeep: 14,
    aiEnabled: true,
    statuses: [...DEFAULT_STATUSES],
    closedStatuses: [...DEFAULT_CLOSED_STATUSES],
    archivedStatus: DEFAULT_ARCHIVED_STATUS,
    roles: [...DEFAULT_ROLES],
    outcomes: [...DEFAULT_OUTCOMES],
    themes: [...DEFAULT_THEMES],
    officialTag: 'sfdc',
    model: config.defaultModel,
    digestModel: config.defaultDigestModel,
    embedModel: config.defaultEmbedModel,
    // Conservative defaults: 16k matches the common "-16k" model variants. Raise
    // to match a long-context model (e.g. 131072) only if the server can hold it.
    ctxTokens: 16_384,
    fastCtxTokens: 16_384,
    reviewReserveTokens: 2_000,
    reviewMaxCalls: 150,
    // One neutral example so the feature is discoverable on a fresh install.
    // Delete it or replace it with your own review form's questions.
    questionSets: [{
      name: 'Example: self-evaluation',
      questions: [
        'What outcomes did I achieve against my goals this period, and what was the impact?',
        'Which engagement had the most impact, and what specifically did I do that made the difference?',
        'Where could I have performed better, and what does the record show about why?',
        'What skills or capabilities should I prioritize developing next, based on gaps visible this period?',
        'What patterns across the period are worth calling out — wins, losses, and what I learned?',
      ],
    }],
    updateDueWeekday: 4,
    updateCadence: 'weekly',
    logPostedUpdates: true,
    updateTmpl: DEFAULT_UPDATE_TMPL,
    summaryTmpl: DEFAULT_SUMMARY_TMPL,
    custTmpl: DEFAULT_CUST_TMPL,
    execTmpl: DEFAULT_EXEC_TMPL,
    evalTmpl: DEFAULT_EVAL_TMPL,
    trrDigestTmpl: DEFAULT_TRR_DIGEST_TMPL,
    reviewTmpl: DEFAULT_REVIEW_TMPL,
    reviewMapTmpl: DEFAULT_REVIEW_MAP_TMPL,
  };
}

export function getSettings(): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  // keys starting with '_' are internal metadata (e.g. _seedTrrIds), not settings
  const stored = Object.fromEntries(rows.filter(r => !r.key.startsWith('_')).map(r => [r.key, JSON.parse(r.value)]));
  return { ...defaultSettings(), ...stored };
}

const SETTINGS_KEYS = new Set<keyof Settings>([
  'greenDays', 'yellowDays', 'archiveDays', 'autoBackfillHours',
  'autoBackupEnabled', 'backupKeep',
  'aiEnabled', 'statuses', 'closedStatuses', 'archivedStatus',
  'roles', 'outcomes', 'themes', 'officialTag',
  'model', 'digestModel', 'embedModel',
  'ctxTokens', 'fastCtxTokens', 'reviewReserveTokens', 'reviewMaxCalls', 'questionSets',
  'updateDueWeekday', 'updateCadence', 'logPostedUpdates', 'updateTmpl', 'summaryTmpl',
  'custTmpl', 'execTmpl', 'evalTmpl', 'trrDigestTmpl', 'reviewTmpl', 'reviewMapTmpl',
]);

export function saveSettings(patch: Partial<Settings>): void {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (SETTINGS_KEYS.has(k as keyof Settings) && v !== undefined) stmt.run(k, JSON.stringify(v));
    }
  });
  tx();
}

// --- Demo-data management ---------------------------------------------------

export function seededTrrIds(): string[] {
  const r = db.prepare(`SELECT value FROM settings WHERE key = '_seedTrrIds'`).get() as { value: string } | undefined;
  if (!r) return [];
  const ids = JSON.parse(r.value) as string[];
  // only count ids that still exist (user may have deleted some manually)
  const exists = db.prepare('SELECT 1 FROM trrs WHERE id = ?');
  return ids.filter(id => exists.get(id));
}

/** Delete exactly the demo/seed TRs (cascades interactions, digests, history, embeddings). */
export function removeSeedData(): number {
  const ids = seededTrrIds();
  const r = db.prepare(`SELECT value FROM settings WHERE key = '_seedCustomerIds'`).get() as { value: string } | undefined;
  const custIds = r ? JSON.parse(r.value) as string[] : [];
  db.transaction(() => {
    for (const id of ids) deleteTrr(id);
    for (const id of custIds) deleteCustomer(id); // no-op if the user has since added TRs to it
    db.prepare(`DELETE FROM settings WHERE key IN ('_seedTrrIds', '_seedCustomerIds')`).run();
  })();
  return ids.length;
}

/** Wipe ALL tracked data (TRs, interactions, digests, reports, reviews). Settings survive. */
export function eraseAllData(): void {
  db.transaction(() => {
    db.prepare('UPDATE trrs SET parent_id = NULL').run();
    db.prepare('DELETE FROM trrs').run(); // cascades interactions/digests/history/embeddings/links/updates
    db.prepare('DELETE FROM opportunities').run();
    db.prepare('DELETE FROM customers').run();
    db.prepare('DELETE FROM summaries').run();
    db.prepare('DELETE FROM period_reports').run();
    db.prepare('DELETE FROM reviews').run();
    db.prepare('DELETE FROM imports').run();
    db.prepare(`DELETE FROM settings WHERE key IN ('_seedTrrIds', '_seedCustomerIds')`).run();
  })();
}

// --- Imports ---------------------------------------------------------------

export interface ImportRecord {
  id: string;
  createdAt: string;
  status: 'draft' | 'applied' | 'undone';
  kind: 'table' | 'freeform' | 'migration';
  label: string;
  raw: string;
  tableJson: string;
  mappingJson: string;
  optionsJson: string;
  mapper: string;
  note: string;
  resultJson: string;
  summary: string;
  appliedAt: string;
  undoneAt: string;
}

type ImportRow = {
  id: string; created_at: string; status: string; kind: string; label: string; raw: string;
  table_json: string; mapping_json: string; options_json: string; mapper: string; note: string;
  result_json: string; summary: string; applied_at: string; undone_at: string;
};
const toImport = (r: ImportRow): ImportRecord => ({
  id: r.id, createdAt: r.created_at, status: r.status as ImportRecord['status'], kind: r.kind as ImportRecord['kind'],
  label: r.label, raw: r.raw, tableJson: r.table_json, mappingJson: r.mapping_json, optionsJson: r.options_json,
  mapper: r.mapper, note: r.note, resultJson: r.result_json, summary: r.summary, appliedAt: r.applied_at, undoneAt: r.undone_at,
});

export function insertImport(i: Pick<ImportRecord, 'kind' | 'label' | 'raw' | 'tableJson' | 'mappingJson' | 'optionsJson' | 'mapper' | 'note'>): string {
  const id = uid();
  db.prepare(`INSERT INTO imports (id, created_at, kind, label, raw, table_json, mapping_json, options_json, mapper, note)
    VALUES (@id, @createdAt, @kind, @label, @raw, @tableJson, @mappingJson, @optionsJson, @mapper, @note)`)
    .run({ ...i, id, createdAt: new Date().toISOString() });
  return id;
}

export function getImport(id: string): ImportRecord | null {
  const r = db.prepare('SELECT * FROM imports WHERE id = ?').get(id) as ImportRow | undefined;
  return r ? toImport(r) : null;
}

export function listImports(limit = 30): ImportRecord[] {
  return (db.prepare('SELECT * FROM imports ORDER BY created_at DESC LIMIT ?').all(limit) as ImportRow[]).map(toImport);
}

export function updateImport(id: string, patch: Partial<Pick<ImportRecord, 'status' | 'mappingJson' | 'optionsJson' | 'resultJson' | 'summary' | 'appliedAt' | 'undoneAt'>>): void {
  const cur = getImport(id);
  if (!cur) return;
  const n = { ...cur, ...patch };
  db.prepare(`UPDATE imports SET status=@status, mapping_json=@mappingJson, options_json=@optionsJson,
    result_json=@resultJson, summary=@summary, applied_at=@appliedAt, undone_at=@undoneAt WHERE id=@id`).run(n);
}

export function deleteImport(id: string): void {
  db.prepare(`DELETE FROM imports WHERE id = ? AND status <> 'applied'`).run(id);
}

/** 'pending' after an upgrade from 2.x until the migration wizard is applied or dismissed. */
export function v2UpgradeState(): string {
  const r = db.prepare(`SELECT value FROM settings WHERE key = '_v2Upgrade'`).get() as { value: string } | undefined;
  return r?.value ?? '';
}

export function setV2UpgradeState(v: 'pending' | 'done' | 'dismissed'): void {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('_v2Upgrade', ?)`).run(v);
}

export function findTrrByExternalId(externalId: string): Trr | null {
  const v = externalId.trim();
  if (!v) return null;
  const r = db.prepare('SELECT * FROM trrs WHERE external_id = ? COLLATE NOCASE ORDER BY num LIMIT 1').get(v) as TrrRow | undefined;
  return r ? toTrr(r) : null;
}

// --- Counts ----------------------------------------------------------------

export function counts(): { trrs: number; interactions: number; digests: number; customers: number; opportunities: number } {
  const c = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    trrs: c('SELECT count(*) n FROM trrs'),
    interactions: c('SELECT count(*) n FROM interactions'),
    digests: c('SELECT count(*) n FROM digests'),
    customers: c('SELECT count(*) n FROM customers'),
    opportunities: c('SELECT count(*) n FROM opportunities'),
  };
}
