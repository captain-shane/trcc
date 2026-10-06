import type { Settings } from '../types.js';
import { MIGRATE_FIELDS, derivePattern, type MigrateOptions, type MigratePlan, type MigrateRow, type Shape } from '../services/migrate2.js';
import { badge, esc, page, statusBadge } from './html.js';

// 2.x → 3.0 restructure wizard: pick the identifier, pick the fields, review, apply.

function row(r: MigrateRow): string {
  const t = r.trr;
  const list = `ids-${esc(t.id)}`;
  return `
  <div class="mig-row ${r.skipped ? 'imp-skipped' : ''}">
    <input type="checkbox" name="include" value="${esc(t.id)}" ${r.skipped ? '' : 'checked'} aria-label="Include #${t.num}">
    <input type="hidden" name="keys" value="${esc(t.id)}">
    <a class="trr-num" href="/trr/${esc(t.id)}" target="_blank">#${t.num}</a>
    <span class="mig-title">${esc(t.title)}</span>
    ${statusBadge(t.status)}
    <span class="tspacer"></span>
    <input class="mig-id mono" name="id_${esc(t.id)}" value="${esc(r.chosen)}" list="${list}" placeholder="no TR ID" aria-label="TR ID for #${t.num}">
    <datalist id="${list}">${r.candidates.map(c => `<option value="${esc(c.id)}">${esc(c.field)}${c.count > 1 ? ` ×${c.count}` : ''}</option>`).join('')}</datalist>
    <span class="small muted2 mig-src">${r.chosen ? esc(r.source || '') : '<span class="imp-warn">not found</span>'}</span>
    ${r.warnings.map(w => `<div class="small imp-warn mig-warn">▲ ${esc(w)}</div>`).join('')}
  </div>`;
}

export function migrateMain(id: string, opts: MigrateOptions, plan: MigratePlan, shapes: Shape[]): string {
  const c = plan.counts;
  const derived = derivePattern(opts.example);
  return `
  <div id="mig-main">
  <form method="post" action="/migrate/${esc(id)}/apply"
    onsubmit="return confirm('Restructure ${c.trrs} TRs: write their TR IDs, create ${c.newOpps} opportunities and ${c.newParents} parent TRs, and move the TRs under them? It can be undone afterwards.')">
    <div hx-post="/migrate/${esc(id)}/preview" hx-trigger="change, keyup changed delay:600ms from:.mig-ex" hx-target="#mig-main" hx-swap="outerHTML" hx-include="closest form">
    <input type="hidden" name="opts" value="1">
    <div class="card">
      <strong>1 · What does a TR ID look like?</strong>
      <div class="row wrap mig-ex-row">
        <input class="mig-ex mono" name="example" value="${esc(opts.example)}" placeholder="e.g. TRR123123" x-ref="ex" style="max-width:220px">
        ${shapes.length ? `<span class="small muted2">Found in your data:</span>${shapes.map(sh =>
          `<button type="button" class="btn btn-sm btn-outline" title="${esc(sh.shape)} — in ${sh.trrs} TR${sh.trrs === 1 ? '' : 's'}"
            onclick="const e = this.closest('form').querySelector('.mig-ex'); e.value = '${esc(sh.example)}'; e.dispatchEvent(new Event('change', { bubbles: true }))">${esc(sh.example)} <span class="muted2">· ${sh.trrs}</span></button>`).join('')}` : ''}
      </div>
      <details class="small"><summary class="muted2">Pattern ${opts.pattern ? '(custom)' : derived ? `<code>${esc(derived)}</code>` : ''}</summary>
        <input class="mono" name="pattern" value="${esc(opts.pattern)}" placeholder="${esc(derived || 'derived from the example')}">
        <div class="muted2">Leave empty to use the one made from the example: letters as written (any case), digit runs of about the same length, an optional separator.</div>
      </details>
      ${plan.patternError ? `<div class="small imp-warn">▲ ${esc(plan.patternError)}</div>` : ''}

      <strong class="mig-step">2 · Where to look for it</strong>
      <div class="row wrap">${MIGRATE_FIELDS.map(f => `<label class="check"><input type="checkbox" name="fields" value="${f.key}" ${opts.fields.includes(f.key) ? 'checked' : ''}> ${esc(f.label)}</label>`).join('')}</div>
      <div class="small muted2">Fields are tried in this order; the first ID found wins. Pick another per TR below when a TR mentions several.</div>
      <label class="check mig-step"><input type="checkbox" name="includeClosed" value="1" ${opts.includeClosed ? 'checked' : ''}> Include closed TRs</label>
    </div>

    <div class="card">
      <div class="row-between wrap">
        <strong>3 · Review</strong>
        <span class="small">${c.trrs} TRs · <span class="ds-posted">${c.withId} with a TR ID</span>${c.withoutId ? ` · <span class="imp-warn">${c.withoutId} without</span>` : ''}
          · ${c.newOpps} new opportunit${c.newOpps === 1 ? 'y' : 'ies'} · ${c.newParents} new parent${c.newParents === 1 ? '' : 's'}
          ${c.skipped ? ` · <span class="muted2">${c.skipped} left out</span>` : ''}</span>
      </div>
      <div class="small muted2">Each TR's title becomes its opportunity, under its customer. Every opportunity gets one parent TR (titled after it) and its TRs become that parent's children. TR titles are kept.
        ${plan.untouched ? ` ${plan.untouched} TRs already in a parent/child family are left alone.` : ''}${plan.closedLeftOut ? ` ${plan.closedLeftOut} closed TRs not included.` : ''}</div>
      ${plan.groups.length === 0 ? '<div class="muted center">No flat TRs to restructure.</div>' : ''}
      ${plan.groups.map(g => `
        <div class="mig-group">
          <div class="mig-head">
            <strong>${esc(g.customer)}</strong> <span class="muted2">›</span>
            ◇ ${esc(g.oppName)} ${g.opp ? badge('existing', 'ds ds-notdue') : badge('new', 'imp-new')}
            <span class="muted2">›</span>
            ${g.parent ? `parent <a class="trr-num" href="/trr/${esc(g.parent.id)}" target="_blank">#${g.parent.num}</a>` : `<span class="small">⬚ new parent</span>`}
          </div>
          ${g.rows.map(row).join('')}
        </div>`).join('')}
    </div>
    </div>
    <div class="row imp-apply">
      <button class="btn" type="submit" ${c.trrs && !plan.patternError ? '' : 'disabled'}>Restructure ${c.trrs} TR${c.trrs === 1 ? '' : 's'}</button>
      <span class="small muted2">You can undo it afterwards from Import → Recent imports.</span>
    </div>
  </form>
  </div>`;
}

export function migratePage(id: string, opts: MigrateOptions, plan: MigratePlan, shapes: Shape[], s: Settings, error = ''): string {
  void s;
  return page('2.x restructure', '', `
  <div class="row-between wrap"><h2>Restructure 2.x TRs</h2>
    <form method="post" action="/migrate/dismiss"><button class="btn btn-sm btn-outline" type="submit" title="Hide the dashboard reminder; this page stays under Settings → Data">Not now</button></form></div>
  ${error ? `<div class="card"><div class="danger">${esc(error)}</div></div>` : ''}
  <div class="card banner small">
    In 2.x each TR was one request, its title named the opportunity, and its request number sat in the text.
    This one-time step fills each TR's <strong>TR ID</strong> from the fields you choose, makes the title an
    <strong>opportunity</strong> under the customer, and gives every opportunity a <strong>parent TR</strong> with the
    requests as its children. Nothing changes until you press Restructure, and it can be undone.
  </div>
  ${migrateMain(id, opts, plan, shapes)}`);
}

export function migrateBanner(): string {
  return `
  <div class="card banner">
    <div class="row-between wrap">
      <div><strong>Upgraded from 2.x</strong> <span class="small muted2">— restructure your TRs into opportunities, parents and children, with TR IDs filled from your notes.</span></div>
      <div class="row">
        <a class="btn btn-sm" href="/migrate">Open the wizard</a>
        <form method="post" action="/migrate/dismiss"><button class="btn btn-sm btn-outline" type="submit">Not now</button></form>
      </div>
    </div>
  </div>`;
}
