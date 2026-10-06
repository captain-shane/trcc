import { Router } from 'express';
import * as repo from '../db/repo.js';
import { getJob } from '../services/jobs.js';
import {
  FIELDS, ImportError, applyImport, buildPlan, createDraft, importJobId, loadDraft, saveChoices, undoImport,
  type FieldKey, type ImportOptions, type ImportResult,
} from '../services/importer.js';
import { importDonePage, importDraftPage, importMain, importPage } from '../views/imports.js';
import { errorBox, jobProgress } from '../views/components.js';
import { HierarchyError } from '../db/repo.js';
import {
  DEFAULT_MIGRATE, MIGRATE_FIELDS, applyMigration, buildMigrationPlan, currentDraft, saveMigrateOptions, suggestShapes,
  type MigrateField, type MigrateOptions,
} from '../services/migrate2.js';
import { migrateMain, migratePage } from '../views/migrate.js';

export const imports = Router();

const KEYS = new Set(FIELDS.map(f => f.key));
const list = (v: unknown) => (v == null ? [] : Array.isArray(v) ? v : [v]).map(String);

imports.get('/import', (_req, res) => {
  res.send(importPage(repo.listImports(), repo.getSettings()));
});

imports.post('/import', (req, res) => {
  const s = repo.getSettings();
  const text = String(req.body.text ?? '').slice(0, 2_000_000);
  const label = String(req.body.label ?? '').slice(0, 120).trim();
  const r = createDraft(text, s, req.body.ai === '1', label);
  if (r.error) return res.send(importPage(repo.listImports(), s, { error: r.error, text, label }));
  res.redirect(303, `/import/${r.id}`);
});

function jobFragment(id: string): string | null {
  const jid = importJobId(id);
  const job = jid ? getJob(jid) : undefined;
  return job && job.status === 'running' ? jobProgress(job, `/fragments/import/${id}/job`) : null;
}

imports.get('/import/:id', (req, res) => {
  const id = String(req.params.id);
  const d = loadDraft(id);
  if (!d) return res.status(404).send(importPage(repo.listImports(), repo.getSettings(), { error: 'That import no longer exists.' }));
  if (d.rec.kind === 'migration' && d.rec.status === 'draft') return res.redirect(303, '/migrate');
  const s = repo.getSettings();
  if (d.rec.status !== 'draft') {
    const result = d.rec.resultJson ? JSON.parse(d.rec.resultJson) as ImportResult : null;
    const lbl = (tid: string) => { const t = repo.getTrr(tid); return t ? { id: t.id, label: `#${t.num} ${t.externalId ? `${t.externalId} · ` : ''}${t.customer} — ${t.title}` } : null; };
    const created = (result?.trrs ?? []).map(lbl).filter((x): x is { id: string; label: string } => !!x);
    const updated = (result?.updated ?? []).map(u => lbl(u.id)).filter((x): x is { id: string; label: string } => !!x);
    return res.send(importDonePage(d.rec, result, created, updated));
  }
  const job = jobFragment(id);
  if (job) return res.send(importDraftPage(d, null, s, { job }));
  const jid = importJobId(id);
  const failed = jid ? getJob(jid) : undefined;
  const error = failed?.status === 'error' ? `The model could not read that text: ${failed.error}` : undefined;
  if (!d.table.allRows.length) return res.send(importDraftPage(d, null, s, { error }));
  res.send(importDraftPage(d, buildPlan(d.table, d.mapping, d.opts, s), s, { error }));
});

imports.get('/fragments/import/:id/job', (req, res) => {
  const id = String(req.params.id);
  const frag = jobFragment(id);
  if (frag) return res.send(frag);
  res.setHeader('HX-Refresh', 'true');
  res.send('');
});

function choicesFromForm(body: Record<string, unknown>, width: number, extracted: boolean): { mapping: FieldKey[]; opts: ImportOptions } {
  const mapping = [...Array(width).keys()].map(c => {
    const v = String(body[`col${c}`] ?? 'ignore') as FieldKey;
    return KEYS.has(v) ? v : 'ignore';
  });
  const include = new Set(list(body.include));
  const opts: ImportOptions = {
    headerRow: extracted ? true : body.headerRow === '1',
    updateExisting: body.updateExisting === '1',
    flagAll: body.flagAll === '1',
    skip: list(body.keys).filter(k => !include.has(k)),
  };
  return { mapping, opts };
}

imports.post('/import/:id/preview', (req, res) => {
  const id = String(req.params.id);
  const d = loadDraft(id);
  if (!d || d.rec.status !== 'draft') return res.send(errorBox('That import is no longer a draft — reload the page.'));
  const { mapping, opts } = choicesFromForm(req.body, d.table.headers.length, d.table.format === 'extracted');
  // flipping the header row changes which row is data: keep the mapping, re-plan
  saveChoices(id, mapping, opts);
  const fresh = loadDraft(id)!;
  const s = repo.getSettings();
  res.send(importMain(fresh, buildPlan(fresh.table, fresh.mapping, fresh.opts, s), s));
});

imports.post('/import/:id/apply', (req, res) => {
  const id = String(req.params.id);
  const d = loadDraft(id);
  if (!d) return res.redirect(303, '/import');
  const s = repo.getSettings();
  if (d.rec.status === 'draft' && req.body.opts === '1') {
    const { mapping, opts } = choicesFromForm(req.body, d.table.headers.length, d.table.format === 'extracted');
    saveChoices(id, mapping, opts);
  }
  try {
    applyImport(id);
    res.redirect(303, `/import/${id}`);
  } catch (e) {
    if (!(e instanceof ImportError || e instanceof HierarchyError)) throw e;
    const fresh = loadDraft(id)!;
    res.send(importDraftPage(fresh, fresh.rec.status === 'draft' ? buildPlan(fresh.table, fresh.mapping, fresh.opts, s) : null, s,
      { error: `Nothing was imported: ${(e as Error).message}` }));
  }
});

imports.post('/import/:id/undo', (req, res) => {
  const id = String(req.params.id);
  try {
    undoImport(id);
  } catch (e) {
    if (!(e instanceof ImportError)) throw e;
  }
  res.redirect(303, `/import/${id}`);
});

imports.post('/import/:id/delete', (req, res) => {
  repo.deleteImport(String(req.params.id));
  res.redirect(303, '/import');
});

// --- 2.x → 3.0 restructure wizard ------------------------------------------------

const MFIELDS = new Set<string>(MIGRATE_FIELDS.map(f => f.key));

/** Form → options. A TR ID typed by hand is kept only where it differs from what the search found. */
function migrateFromForm(body: Record<string, unknown>, prev: MigrateOptions): MigrateOptions {
  const fields = list(body.fields).filter(f => MFIELDS.has(f)) as MigrateField[];
  const include = new Set(list(body.include));
  const base: MigrateOptions = {
    example: String(body.example ?? '').trim().slice(0, 60),
    pattern: String(body.pattern ?? '').trim().slice(0, 300),
    fields, includeClosed: body.includeClosed === '1', overrides: {}, skip: list(body.keys).filter(k => !include.has(k)),
  };
  // a new example or new fields re-run the search: earlier hand edits no longer apply
  const searchChanged = base.example !== prev.example || base.pattern !== prev.pattern || base.fields.join() !== prev.fields.join();
  const auto = buildMigrationPlan(base, repo.getSettings());
  const autoChosen = new Map(auto.groups.flatMap(g => g.rows).map(r => [r.trr.id, r.chosen]));
  if (!searchChanged) {
    for (const [k, v] of Object.entries(body)) {
      if (!k.startsWith('id_')) continue;
      const tid = k.slice(3);
      const typed = String(v).trim().slice(0, 100);
      if (autoChosen.has(tid) && typed !== autoChosen.get(tid)) base.overrides[tid] = typed;
    }
  }
  return base;
}

function migrateView(error = ''): string {
  const { id, opts } = currentDraft();
  const s = repo.getSettings();
  return migratePage(id, opts, buildMigrationPlan(opts, s), suggestShapes(), s, error);
}

imports.get('/migrate', (_req, res) => res.send(migrateView()));

imports.post('/migrate/:id/preview', (req, res) => {
  const id = String(req.params.id);
  const rec = repo.getImport(id);
  if (!rec || rec.kind !== 'migration' || rec.status !== 'draft') return res.send(errorBox('That restructure is no longer a draft — reload the page.'));
  const prev = { ...DEFAULT_MIGRATE, ...(JSON.parse(rec.optionsJson) as Partial<MigrateOptions>) };
  const opts = migrateFromForm(req.body, prev);
  saveMigrateOptions(id, opts);
  res.send(migrateMain(id, opts, buildMigrationPlan(opts, repo.getSettings()), suggestShapes()));
});

imports.post('/migrate/:id/apply', (req, res) => {
  const id = String(req.params.id);
  const rec = repo.getImport(id);
  if (!rec || rec.kind !== 'migration' || rec.status !== 'draft') return res.redirect(303, '/migrate');
  if (req.body.opts === '1') {
    const prev = { ...DEFAULT_MIGRATE, ...(JSON.parse(rec.optionsJson) as Partial<MigrateOptions>) };
    saveMigrateOptions(id, migrateFromForm(req.body, prev));
  }
  try {
    applyMigration(id);
    res.redirect(303, `/import/${id}`);
  } catch (e) {
    if (!(e instanceof HierarchyError) && !(e instanceof Error)) throw e;
    res.send(migrateView(`Nothing was changed: ${(e as Error).message}`));
  }
});

imports.post('/migrate/dismiss', (_req, res) => {
  if (repo.v2UpgradeState() === 'pending') repo.setV2UpgradeState('dismissed');
  res.redirect(303, '/');
});
