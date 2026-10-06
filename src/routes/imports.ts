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
