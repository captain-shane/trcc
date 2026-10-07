import { db } from '../db/index.js';
import * as repo from '../db/repo.js';
import { localDay } from './cycle.js';
import { PRIORITIES, uid, type Opportunity, type Priority, type Settings, type Trr } from '../types.js';
import type { ImportResult } from './importer.js';

// One-time 2.x → 3.0 restructure. A 2.x TR was in practice one request (a child):
// its title named the opportunity, and its request number sat somewhere in the
// text. For every flat TR this wizard:
//  - finds the TR ID by searching the fields the operator ticks for an
//    identifier shaped like the operator's example (TRR123123, TR-10421, …);
//  - makes the title an opportunity under the TR's customer (reusing one that exists);
//  - creates ONE parent TR per opportunity, titled after it, and moves the TRs under it.
// Deterministic, previewed row by row, applied in one transaction, and undoable
// through the same record an import uses (imports.kind = 'migration').

export const MIGRATE_FIELDS = [
  { key: 'title', label: 'Title' },
  { key: 'description', label: 'Description' },
  { key: 'outcome', label: 'Outcome' },
  { key: 'contact', label: 'Contact' },
  { key: 'rep', label: 'Rep' },
  { key: 'logs', label: 'Interaction notes (logs)' },
] as const;
export type MigrateField = (typeof MIGRATE_FIELDS)[number]['key'];

export interface MigrateOptions {
  example: string;                     // the operator's sample identifier, e.g. TRR123123
  pattern: string;                     // regex source; derived from the example unless edited
  fields: MigrateField[];              // where to look, in this order of preference
  includeClosed: boolean;
  overrides: Record<string, string>;   // trrId -> TR ID chosen by hand ('' = none)
  skip: string[];                      // trrIds left out
}

export const DEFAULT_MIGRATE: MigrateOptions = {
  example: '', pattern: '', fields: ['title', 'description'], includeClosed: true, overrides: {}, skip: [],
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex from an example: letters literal (any case), digit runs by length (±2), separators optional. */
export function derivePattern(example: string): string {
  const parts = example.trim().match(/[A-Za-z]+|\d+|[^A-Za-z\d]+/g) ?? [];
  if (!parts.length) return '';
  const kind = (p: string) => (/^[A-Za-z]+$/.test(p) ? 'a' : /^\d+$/.test(p) ? 'd' : 's');
  // people write TRR123, TRR-123 and trr 123 for the same thing: a separator is
  // optional wherever letters meet digits, whether or not the example has one
  const src = parts.map((p, i) => {
    const k = kind(p);
    const glue = i > 0 && k !== 's' && kind(parts[i - 1]!) !== 's' && kind(parts[i - 1]!) !== k ? '[-_ #.:/]?' : '';
    return glue + (k === 'a' ? esc(p) : k === 'd' ? `\\d{${Math.max(3, p.length - 2)},${p.length + 2}}` : '[-_ #.:/]?');
  }).join('');
  return `(?<![A-Za-z0-9])${src}(?![0-9])`;
}

export function compilePattern(src: string): RegExp | null {
  if (!src.trim()) return null;
  try { return new RegExp(src, 'gi'); } catch { return null; }
}

/** One spelling per ID: letters upper-case, separators as in the example. */
export function normalizeId(found: string, example: string): string {
  const sep = example.match(/[^A-Za-z\d]+/)?.[0] ?? '';
  return (found.match(/[A-Za-z]+|\d+|[^A-Za-z\d]+/g) ?? [])
    .map(p => /^[A-Za-z]+$/.test(p) ? p.toUpperCase() : /^\d+$/.test(p) ? p : sep).join('');
}

// --- suggestions: what identifier shapes exist in the data? --------------------

export interface Shape { example: string; shape: string; trrs: number }

/** Identifier-looking tokens across all TRs, grouped by shape ("TRR + 6 digits"), most widespread first. */
export function suggestShapes(fields: MigrateField[] = ['title', 'description', 'outcome', 'logs']): Shape[] {
  const tok = /(?<![A-Za-z0-9])([A-Za-z]{2,6})([-_ #]?)(\d{4,10})(?![0-9])/g;
  const seen = new Map<string, { example: string; trrs: Set<string> }>();
  const logs = fields.includes('logs') ? logsByTrr() : new Map<string, string>();
  for (const t of repo.listTrrs('all')) {
    for (const m of textFor(t, fields, logs).matchAll(tok)) {
      // TRR400100 and trr-400101 are one shape: the derived pattern accepts either spelling
      const shape = `${m[1]!.toUpperCase()} + ${m[3]!.length} digits`;
      const e = seen.get(shape) ?? { example: `${m[1]!.toUpperCase()}${m[2]}${m[3]}`, trrs: new Set() };
      if (!m[2] && /[^A-Z\d]/.test(e.example)) e.example = `${m[1]!.toUpperCase()}${m[3]}`; // prefer the compact spelling
      e.trrs.add(t.id);
      seen.set(shape, e);
    }
  }
  return [...seen.entries()].map(([shape, e]) => ({ shape, example: e.example, trrs: e.trrs.size }))
    .sort((a, b) => b.trrs - a.trrs).slice(0, 8);
}

function logsByTrr(): Map<string, string> {
  const m = new Map<string, string>();
  // Posted-update notes are written by the app ("…for cycle 2026-10-08"), not by the user: skip them.
  for (const i of repo.allInteractions()) if (i.source !== 'update') m.set(i.trrId, `${m.get(i.trrId) ?? ''}\n${i.note}`);
  return m;
}

function fieldText(t: Trr, f: MigrateField, logs: Map<string, string>): string {
  return f === 'logs' ? logs.get(t.id) ?? '' : String(t[f] ?? '');
}

function textFor(t: Trr, fields: MigrateField[], logs: Map<string, string>): string {
  return fields.map(f => fieldText(t, f, logs)).join('\n');
}

// --- plan ------------------------------------------------------------------------

export interface Candidate { id: string; field: MigrateField; count: number }

export interface MigrateRow {
  trr: Trr;
  candidates: Candidate[];
  chosen: string;                      // TR ID that will be written ('' = none)
  source: string;                      // where it came from: a field label, 'by hand', 'already set'
  skipped: boolean;
  warnings: string[];
}

export interface MigrateGroup {
  key: string;
  customer: string;
  customerId: string;
  oppName: string;
  opp: Opportunity | null;             // existing opportunity reused
  parent: Trr | null;                  // existing parent reused
  rows: MigrateRow[];
}

export interface MigratePlan {
  groups: MigrateGroup[];
  untouched: number;                   // TRs already in a family (parent or child) — left alone
  closedLeftOut: number;
  counts: { trrs: number; withId: number; withoutId: number; newOpps: number; newParents: number; skipped: number };
  patternError: string;
}

const FIELD_ORDER = (fields: MigrateField[]) => (f: MigrateField) => fields.indexOf(f);

export function buildMigrationPlan(opts: MigrateOptions, s: Settings): MigratePlan {
  const pattern = opts.pattern || derivePattern(opts.example);
  const re = compilePattern(pattern);
  const patternError = !opts.example && !opts.pattern ? 'Enter an example TR ID (or pick one of the shapes found in your data).'
    : !re ? 'That pattern is not a valid regular expression.' : '';
  const all = repo.listTrrs('all');
  const kids = repo.childrenIndex(all);
  const inFamily = (t: Trr) => !!t.parentId || !!kids.get(t.id)?.length;
  const isClosed = (t: Trr) => s.closedStatuses.includes(t.status);
  const eligible = all.filter(t => !inFamily(t) && (opts.includeClosed || !isClosed(t))).sort((a, b) => a.num - b.num);
  const logs = opts.fields.includes('logs') ? logsByTrr() : new Map<string, string>();
  const order = FIELD_ORDER(opts.fields);
  const label = (f: MigrateField) => MIGRATE_FIELDS.find(x => x.key === f)?.label ?? f;

  const rows: MigrateRow[] = eligible.map(t => {
    const found = new Map<string, Candidate>();
    if (re) {
      for (const f of opts.fields) {
        for (const m of fieldText(t, f, logs).matchAll(re)) {
          const id = normalizeId(m[0], opts.example || m[0]);
          const c = found.get(id);
          if (c) c.count++; else found.set(id, { id, field: f, count: 1 });
        }
      }
    }
    const candidates = [...found.values()].sort((a, b) => order(a.field) - order(b.field) || b.count - a.count);
    const warnings: string[] = [];
    let chosen: string, source: string;
    if (t.id in opts.overrides) { chosen = opts.overrides[t.id]!.trim(); source = 'by hand'; }
    else if (t.externalId) { chosen = t.externalId; source = 'already set'; }
    else { chosen = candidates[0]?.id ?? ''; source = candidates[0] ? label(candidates[0].field) : ''; }
    if (candidates.length > 1 && source !== 'by hand' && source !== 'already set') {
      warnings.push(`${candidates.length} IDs found — using the first; pick another if it is wrong`);
    }
    return { trr: t, candidates, chosen, source, skipped: opts.skip.includes(t.id), warnings };
  });

  // the same TR ID on two TRs is worth a look (it may be a genuine duplicate)
  const byId = new Map<string, MigrateRow[]>();
  for (const r of rows) if (r.chosen && !r.skipped) byId.set(r.chosen.toLowerCase(), [...(byId.get(r.chosen.toLowerCase()) ?? []), r]);
  for (const [, rs] of byId) if (rs.length > 1) for (const r of rs) r.warnings.push(`same TR ID as ${rs.filter(x => x !== r).map(x => `#${x.trr.num}`).join(', ')}`);
  for (const r of rows) {
    if (!r.chosen || r.skipped) continue;
    const other = repo.findTrrByExternalId(r.chosen);
    if (other && other.id !== r.trr.id && inFamily(other)) r.warnings.push(`#${other.num} already has this TR ID`);
  }

  // group by customer + opportunity (an opportunity already set on the TR wins over its title)
  const opps = repo.listOpportunities();
  const groups = new Map<string, MigrateGroup>();
  for (const r of rows) {
    const t = r.trr;
    const opp = t.opportunityId ? opps.find(o => o.id === t.opportunityId) ?? null
      : opps.find(o => o.customerId === t.customerId && o.name.toLowerCase() === t.title.trim().toLowerCase()) ?? null;
    const oppName = opp?.name ?? t.title.trim();
    const key = opp ? `o:${opp.id}` : `n:${t.customerId}|${oppName.toLowerCase()}`;
    let g = groups.get(key);
    if (!g) {
      const parent = opp ? all.find(x => x.opportunityId === opp.id && !x.parentId && kids.get(x.id)?.length) ?? null : null;
      g = { key, customer: t.customer, customerId: t.customerId, oppName, opp, parent, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(r);
  }
  const list = [...groups.values()].sort((a, b) => a.customer.localeCompare(b.customer) || a.oppName.localeCompare(b.oppName));
  const live = list.filter(g => g.rows.some(r => !r.skipped));
  const liveRows = rows.filter(r => !r.skipped);
  return {
    groups: list,
    untouched: all.filter(inFamily).length,
    closedLeftOut: opts.includeClosed ? 0 : all.filter(t => !inFamily(t) && isClosed(t)).length,
    counts: {
      trrs: liveRows.length,
      withId: liveRows.filter(r => r.chosen).length,
      withoutId: liveRows.filter(r => !r.chosen).length,
      newOpps: live.filter(g => !g.opp).length,
      newParents: live.filter(g => !g.parent).length,
      skipped: rows.length - liveRows.length,
    },
    patternError,
  };
}

// --- draft, apply ---------------------------------------------------------------------

export function currentDraft(): { id: string; opts: MigrateOptions } {
  const r = db.prepare(`SELECT id, options_json FROM imports WHERE kind = 'migration' AND status = 'draft' ORDER BY created_at DESC LIMIT 1`)
    .get() as { id: string; options_json: string } | undefined;
  if (r) return { id: r.id, opts: { ...DEFAULT_MIGRATE, ...(JSON.parse(r.options_json) as Partial<MigrateOptions>) } };
  const opts = { ...DEFAULT_MIGRATE };
  const id = repo.insertImport({
    kind: 'migration', label: '2.x → 3.0 restructure', raw: '', tableJson: '{}', mappingJson: '[]',
    optionsJson: JSON.stringify(opts), mapper: '', note: '',
  });
  return { id, opts };
}

export function saveMigrateOptions(id: string, opts: MigrateOptions): void {
  repo.updateImport(id, { optionsJson: JSON.stringify(opts) });
}

const PRIO_RANK = (p: Priority) => PRIORITIES.indexOf(p);

export function applyMigration(id: string): { summary: string } {
  const rec = repo.getImport(id);
  if (!rec || rec.kind !== 'migration' || rec.status !== 'draft') throw new Error('That restructure is no longer a draft.');
  const s = repo.getSettings();
  const opts = { ...DEFAULT_MIGRATE, ...(JSON.parse(rec.optionsJson) as Partial<MigrateOptions>) };
  const plan = buildMigrationPlan(opts, s);
  const groups = plan.groups.map(g => ({ ...g, rows: g.rows.filter(r => !r.skipped) })).filter(g => g.rows.length);
  if (!groups.length) throw new Error('Nothing to restructure.');

  const now = new Date().toISOString();
  const tag = `2.x restructure ${localDay(now)}`;
  const res: ImportResult = { trrs: [], logs: [], customers: [], opps: [], updated: [], stages: [] };
  db.transaction(() => {
    for (const g of groups) {
      let oppId = g.opp?.id ?? '';
      if (!oppId) {
        oppId = repo.insertOpportunity({ customerId: g.customerId, name: g.oppName, stage: '', rep: '', closeDate: '', notes: '' }).id;
        res.opps.push(oppId);
      }
      let parentId = g.parent?.id ?? '';
      if (!parentId) {
        const ts = g.rows.map(r => r.trr);
        const open = ts.filter(t => !s.closedStatuses.includes(t.status));
        const status = open.length ? (s.statuses.includes('In Progress') ? 'In Progress' : open[0]!.status) : ts[0]!.status;
        parentId = uid();
        repo.insertTrr({
          id: parentId, customer: g.customer, customerId: g.customerId, opportunityId: oppId, title: g.oppName, status,
          complexity: 'Medium', priority: ts.map(t => t.priority).sort((a, b) => PRIO_RANK(b) - PRIO_RANK(a))[0] ?? 'Medium',
          contact: ts.find(t => t.contact)?.contact ?? '', rep: ts.find(t => t.rep)?.rep ?? '', targetClose: '',
          description: `Parent for the ${g.oppName} opportunity, created by the 2.x restructure. Use it for project-management notes: assignment timings, chasing resources, anything that spans its child TRs.`,
          myRole: '', outcome: '', valueThemes: [], deactivated: false, deactivatedAt: '',
          createdAt: ts.map(t => t.createdAt).sort()[0] ?? now, lastContact: '',
        });
        repo.recordHistory(parentId, 'created by', '', tag);
        res.trrs.push(parentId);
      }
      for (const r of g.rows) {
        const t = r.trr;
        const before: Partial<Trr> = { externalId: t.externalId, parentId: t.parentId, opportunityId: t.opportunityId };
        res.updated.push({ id: t.id, before });
        repo.updateTrr(t.id, { externalId: r.chosen || t.externalId, parentId });
        repo.recordHistory(t.id, 'restructured', '', tag);
      }
    }
  })();
  const n = (x: number, w: string) => `${x} ${w}${x === 1 ? '' : 's'}`;
  const withId = groups.flatMap(g => g.rows).filter(r => r.chosen).length;
  const summary = `${n(res.updated.length, 'TR')} restructured (${withId} with a TR ID) · ${n(res.trrs.length, 'parent')} created · `
    + `${res.opps.length} new opportunit${res.opps.length === 1 ? 'y' : 'ies'}`;
  repo.updateImport(id, { status: 'applied', resultJson: JSON.stringify(res), summary, appliedAt: now });
  repo.setV2UpgradeState('done');
  return { summary };
}
