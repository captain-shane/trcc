import type { Settings } from '../types.js';
import type { ImportRecord } from '../db/repo.js';
import { FIELDS, fieldLabel, type Draft, type FieldKey, type ImportResult, type Plan, type PlanItem } from '../services/importer.js';
import { badge, esc, page } from './html.js';

// Import: paste → preview (mapping + plan, every choice editable) → apply → undo.

const FORMAT_LABEL: Record<string, string> = {
  tsv: 'tab-separated (Google Sheets / Excel copy)', csv: 'comma-separated (CSV)', semicolon: 'semicolon-separated',
  markdown: 'Markdown table', extracted: 'read from free text by the model',
};

const STATUS_BADGE: Record<ImportRecord['status'], string> = {
  draft: badge('◆ Draft', 'ds ds-draft'), applied: badge('● Applied', 'ds ds-posted'), undone: badge('○ Undone', 'ds ds-notdue'),
};

function recentList(recent: ImportRecord[]): string {
  if (!recent.length) return '<div class="small muted2">No imports yet.</div>';
  return `<div class="imp-list">${recent.map(r => `
    <a class="tree-row" href="/import/${esc(r.id)}">
      <span class="small muted2 imp-when">${esc(r.createdAt.slice(0, 16).replace('T', ' '))}</span>
      ${STATUS_BADGE[r.status]}
      <span class="tree-title">${esc(r.label || '(untitled)')}</span>
      <span class="small muted2 tree-meta">${esc(r.summary)}</span>
    </a>`).join('')}</div>`;
}

export function importPage(recent: ImportRecord[], s: Settings, opts: { error?: string; text?: string; label?: string } = {}): string {
  const ai = s.aiEnabled;
  return page('Import', '', `
  <h2>Import</h2>
  ${opts.error ? `<div class="card"><div class="danger">${esc(opts.error)}</div></div>` : ''}
  <form class="card" method="post" action="/import" x-data>
    <p class="small muted">Copy the cells straight out of Google Sheets, <strong>header row included</strong>, and paste them here.
      CSV and Markdown tables work too. A row can be a request or a dated note about one; rows with the same TR ID are combined.
      You get a preview first, and nothing is saved until you apply it. An applied import can be undone.</p>
    <textarea class="mono" name="text" rows="14" x-ref="ta" required
      placeholder="TR ID&#9;Customer&#9;Opportunity&#9;Title&#9;Status&#9;Notes&#10;TR-10421&#9;Meridian Health&#9;Clinical cloud FY27&#9;Cloud migration&#9;In Progress&#9;10/1 – kickoff with Dana…">${esc(opts.text ?? '')}</textarea>
    <div class="row wrap imp-tools">
      <label class="small muted2">or a file <input type="file" accept=".csv,.tsv,.txt,.md,text/plain,text/csv"
        @change="const f = $event.target.files[0]; if (f) f.text().then(t => $refs.ta.value = t)"></label>
      <input name="label" placeholder="Label (optional)" value="${esc(opts.label ?? '')}" style="max-width:260px">
    </div>
    <label class="check">
      <input type="checkbox" name="ai" value="1" ${ai ? 'checked' : 'disabled'}>
      Use the local model${ai ? ` (${esc(s.model)})` : ' — AI is off in Settings'} to suggest the column mapping, or to read text that isn't a table
    </label>
    <div class="small muted2 imp-privacy">For a table, the model sees only the column headers and the first 5 rows (each cell cut to 80 characters).
      Free text is sent whole. It goes to your local model only, but it is read <em>before</em> any row can be flagged, so untick this if the paste holds notes that must never reach AI.</div>
    <div class="row"><button class="btn" type="submit">Preview import →</button></div>
  </form>
  <details class="card">
    <summary><strong>Fields an import can fill</strong></summary>
    <div class="imp-fields">${['Request', 'Account', 'Log'].map(g => `
      <div><div class="tree-opp">${g}</div>${FIELDS.filter(f => f.group === g).map(f =>
        `<div class="small"><strong>${esc(f.label)}</strong> <span class="muted2">— ${esc(f.hint)}</span></div>`).join('')}</div>`).join('')}
    </div>
    <p class="small muted2">A notes cell with dated lines (<code>10/1 – called Tom</code>, <code>2026-10-01: …</code>, <code>Oct 1 …</code>) becomes one log per date.
      Notes with no date use the row's log date or last-contact date; failing both they are added to the TR's description, never logged as today.
      Logs already on the TR (same date and text) are skipped, so pasting the same sheet again is safe.</p>
  </details>
  <div class="card"><strong>Recent imports</strong>${recentList(recent)}</div>`);
}

function fieldSelect(c: number, value: FieldKey): string {
  const groups = ['', 'Request', 'Account', 'Log'];
  return `<select name="col${c}" aria-label="Field for column ${c + 1}">${groups.map(g => {
    const opts = FIELDS.filter(f => f.group === g).map(f => `<option value="${f.key}" ${f.key === value ? 'selected' : ''}>${esc(f.label)}</option>`).join('');
    return g ? `<optgroup label="${g}">${opts}</optgroup>` : opts;
  }).join('')}</select>`;
}

const ACTION: Record<PlanItem['action'], { sym: string; label: string; cls: string }> = {
  create: { sym: '✚', label: 'New', cls: 'ds-posted' },
  update: { sym: '✎', label: 'Update', cls: 'ds-draft' },
  unchanged: { sym: '＝', label: 'No change', cls: 'ds-notdue' },
  skipped: { sym: '○', label: 'Skipped', cls: 'ds-notdue' },
  error: { sym: '■', label: 'Error', cls: 'ds-overdue' },
};

function planItem(it: PlanItem): string {
  const a = ACTION[it.action];
  const toggle = it.action === 'create' || it.action === 'update' || it.action === 'skipped';
  const newLogs = it.logs.filter(l => !l.dup);
  const dups = it.logs.length - newLogs.length;
  const where = it.parentKey || it.parentId
    ? `↳ child of ${esc(it.parentLabel)}`
    : `${esc(it.customer)}${it.customerNew ? ' <span class="badge imp-new">new</span>' : ''}${it.opportunity ? ` › ◇ ${esc(it.opportunity)}${it.opportunityNew ? ' <span class="badge imp-new">new</span>' : ''}` : ''}`;
  return `
  <div class="imp-item imp-${it.action}">
    <div class="row imp-item-head">
      ${toggle ? `<input type="checkbox" name="include" value="${esc(it.key)}" ${it.action === 'skipped' ? '' : 'checked'} aria-label="Include ${esc(it.label)}"><input type="hidden" name="keys" value="${esc(it.key)}">` : '<span class="imp-nobox"></span>'}
      <span class="badge ds ${a.cls}">${a.sym} ${a.label}</span>
      ${it.existing ? `<a href="/trr/${esc(it.existing.id)}" target="_blank" class="trr-num">#${it.existing.num}</a>` : ''}
      ${it.fields.externalId ? `<span class="badge ext-id">${esc(it.fields.externalId)}</span>` : ''}
      <strong class="imp-title">${esc(it.title || it.label)}</strong>
      <span class="small muted2">${where}</span>
      <span class="tspacer"></span>
      <span class="small muted2">row${it.rows.length === 1 ? '' : 's'} ${esc(compactRows(it.rows))}</span>
    </div>
    ${it.errors.map(e => `<div class="small danger">■ ${esc(e)}</div>`).join('')}
    ${it.changes.length ? `<div class="small imp-changes">${it.changes.map(ch =>
      `<span>${esc(ch.label)}: <span class="old">${esc(clip(ch.from) || '—')}</span> → <span class="hl">${esc(clip(ch.to))}</span></span>`).join('')}</div>` : ''}
    ${it.stageChange ? `<div class="small imp-changes"><span>opportunity stage: <span class="old">${esc(it.stageChange)}</span> → <span class="hl">${esc(it.oppStage)}</span></span></div>` : ''}
    ${it.action === 'create' ? `<div class="small muted2">${[it.fields.status, it.fields.priority, it.fields.myRole, ...(it.fields.valueThemes ?? [])].filter(Boolean).map(v => esc(v!)).join(' · ')}</div>` : ''}
    ${it.logs.length ? `
      <details class="imp-logs"><summary class="small">${newLogs.length} log${newLogs.length === 1 ? '' : 's'} to add${dups ? ` · ${dups} already there (skipped)` : ''}</summary>
        ${it.logs.map(l => `<div class="small imp-log ${l.dup ? 'imp-dup' : ''}"><span class="muted2">${esc(l.date)} · ${esc(l.type)}${l.flagged ? ' · 🚩' : ''}${l.dup ? ' · duplicate' : ''}</span> ${esc(clip(l.note, 220))}</div>`).join('')}
      </details>` : ''}
    ${it.undated && it.action === 'create' ? `<div class="small muted2">Undated notes → added to the description</div>` : ''}
    ${it.warnings.map(w => `<div class="small imp-warn">▲ ${esc(w)}</div>`).join('')}
  </div>`;
}

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');

function compactRows(rows: number[]): string {
  if (rows.length <= 3) return rows.join(', ');
  return `${rows[0]}–${rows[rows.length - 1]} (${rows.length})`;
}

/** The editable part of a draft: re-rendered on every change. */
export function importMain(d: Draft, plan: Plan, s: Settings): string {
  const { table, mapping, opts, rec } = d;
  const c = plan.counts;
  const n = (x: number, w: string) => `${x} ${w}${x === 1 ? '' : 's'}`;
  const ready = c.create + c.update;
  const samples = (col: number) => table.rows.slice(0, 3).map(r => r[col] ?? '').filter(Boolean);
  return `
  <div id="import-main">
  <form method="post" action="/import/${esc(rec.id)}/apply">
    <div hx-post="/import/${esc(rec.id)}/preview" hx-trigger="change" hx-target="#import-main" hx-swap="outerHTML" hx-include="closest form">
    <input type="hidden" name="opts" value="1">
    <div class="card">
      <div class="row-between wrap">
        <strong>Columns</strong>
        <span class="small muted2">${esc(FORMAT_LABEL[table.format] ?? table.format)} · ${n(table.rows.length, 'row')} ·
          mapping ${rec.mapper === 'heuristic' ? 'from the header names' : rec.mapper ? `suggested by ${esc(rec.mapper)}` : ''}</span>
      </div>
      ${rec.note ? `<div class="small imp-warn">▲ ${esc(rec.note)}</div>` : ''}
      ${table.format !== 'extracted' ? `<label class="check small"><input type="checkbox" name="headerRow" value="1" ${opts.headerRow ? 'checked' : ''}> First row is the header</label>` : ''}
      <div class="imp-map">
        ${table.headers.map((h, col) => `
        <div class="imp-col ${mapping[col] === 'ignore' ? 'imp-ignored' : ''}">
          <div class="imp-col-head"><strong>${esc(h)}</strong></div>
          <div class="small muted2 imp-samples">${samples(col).map(v => esc(clip(v, 40))).join('<br>') || '(empty)'}</div>
          ${fieldSelect(col, mapping[col] ?? 'ignore')}
        </div>`).join('')}
      </div>
      <div class="row wrap imp-opts">
        <label class="check small"><input type="checkbox" name="updateExisting" value="1" ${opts.updateExisting ? 'checked' : ''}> Update fields on TRs that already exist (matched by TR ID; a blank cell never clears a field)</label>
        <label class="check small"><input type="checkbox" name="flagAll" value="1" ${opts.flagAll ? 'checked' : ''}> 🚩 Flag every imported log (won't be passed to AI)</label>
      </div>
    </div>

    <div class="card">
      <div class="row-between wrap">
        <strong>Preview</strong>
        <span class="small">
          ${c.create ? `<span class="ds-posted">✚ ${n(c.create, 'new TR')}</span> · ` : ''}
          ${c.update ? `<span class="ds-draft">✎ ${n(c.update, 'update')}</span> · ` : ''}
          ${n(c.logs, 'log')}${c.dupLogs ? ` <span class="muted2">(${c.dupLogs} duplicate${c.dupLogs === 1 ? '' : 's'} skipped)</span>` : ''}
          ${plan.newCustomers.length ? ` · ${n(plan.newCustomers.length, 'new customer')}` : ''}
          ${plan.newOpps.length ? ` · ${plan.newOpps.length} new opportunit${plan.newOpps.length === 1 ? 'y' : 'ies'}` : ''}
          ${c.unchanged ? ` · <span class="muted2">${c.unchanged} unchanged</span>` : ''}
          ${c.skipped ? ` · <span class="muted2">${c.skipped} skipped</span>` : ''}
          ${c.error ? ` · <span class="ds-overdue">■ ${n(c.error, 'error')}</span>` : ''}
        </span>
      </div>
      ${mapping.every(k => k === 'ignore') ? '<div class="small muted2">Map at least one column above.</div>' : ''}
      ${!mapping.some(k => k === 'trId' || k === 'title') && !mapping.every(k => k === 'ignore')
        ? '<div class="small imp-warn">▲ Map a TR ID or a Title column so rows can be matched to requests.</div>' : ''}
      <div class="imp-items">${plan.items.map(planItem).join('')}</div>
    </div>
    </div>
    <div class="row imp-apply">
      <button class="btn" type="submit" ${ready ? '' : 'disabled'}>Apply import${ready ? ` — ${n(c.create, 'new TR')}, ${n(c.update, 'update')}, ${n(c.logs, 'log')}` : ''}</button>
      <button class="btn btn-outline" type="submit" form="imp-discard">Discard</button>
    </div>
  </form>
  <form id="imp-discard" method="post" action="/import/${esc(rec.id)}/delete"></form>
  </div>`;
}

function rawBlock(rec: ImportRecord): string {
  return `<details class="card"><summary class="small"><strong>Pasted text</strong> <span class="muted2">(${rec.raw.length.toLocaleString()} characters)</span></summary>
    <pre class="imp-raw">${esc(rec.raw.slice(0, 50_000))}${rec.raw.length > 50_000 ? '\n…' : ''}</pre></details>`;
}

export function importDraftPage(d: Draft, plan: Plan | null, s: Settings, opts: { job?: string; error?: string } = {}): string {
  const { rec } = d;
  const head = `
  <div class="row-between wrap"><h2>Import — ${esc(rec.label || 'pasted text')}</h2><a class="small muted2" href="/import">← All imports</a></div>
  ${opts.error ? `<div class="card"><div class="danger">${esc(opts.error)}</div></div>` : ''}`;
  if (opts.job) return page('Import', '', `${head}<div class="card">${opts.job}</div>${rawBlock(rec)}`);
  if (!plan) {
    return page('Import', '', `${head}<div class="card"><div class="danger">${esc(rec.note || 'The model found nothing to import in that text.')}</div>
      <form method="post" action="/import/${esc(rec.id)}/delete"><button class="btn btn-outline" type="submit">Discard</button></form></div>${rawBlock(rec)}`);
  }
  return page('Import', '', `${head}${importMain(d, plan, s)}${rawBlock(rec)}`);
}

export function importDonePage(rec: ImportRecord, res: ImportResult | null, created: { id: string; label: string }[], updated: { id: string; label: string }[]): string {
  const link = (x: { id: string; label: string }) => `<a class="tree-row" href="/trr/${esc(x.id)}"><span class="tree-title">${esc(x.label)}</span></a>`;
  return page('Import', '', `
  <div class="row-between wrap"><h2>Import — ${esc(rec.label || 'pasted text')}</h2><a class="small muted2" href="/import">← All imports</a></div>
  <div class="card">
    <div class="row-between wrap">
      <span>${STATUS_BADGE[rec.status]} <strong>${esc(rec.summary)}</strong></span>
      <span class="small muted2">${rec.status === 'applied' ? `applied ${esc(rec.appliedAt.slice(0, 16).replace('T', ' '))}` : `undone ${esc(rec.undoneAt.slice(0, 16).replace('T', ' '))}`}</span>
    </div>
    ${rec.status === 'applied' && res ? `
      ${created.length ? `<div class="tree-opp">Created</div>${created.map(link).join('')}` : ''}
      ${updated.length ? `<div class="tree-opp">Updated</div>${updated.map(link).join('')}` : ''}
      <form method="post" action="/import/${esc(rec.id)}/undo" class="row imp-apply"
        onsubmit="return confirm('Undo this import? Logs it added are removed, TRs it created are deleted (unless activity was added to them since), and fields it changed go back to what they were — overwriting any edits made to those fields since.')">
        <button class="btn btn-outline danger" type="submit">↶ Undo this import</button>
      </form>` : ''}
  </div>
  ${rawBlock(rec)}`);
}

export { fieldLabel };
