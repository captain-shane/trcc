import type { Customer, Interaction, Opportunity, Rag, ScopeSummary, Settings, StoredDigest, SummaryScopeKind, Trr } from '../types.js';
import { COMPLEXITIES, INTERACTION_TYPES, PRIORITIES, UPDATE_CADENCES, daysSince, rag } from '../types.js';
import type { Job } from '../services/jobs.js';
import type { DeskRow, DeskState } from '../services/updates.js';
import { localDay, shortDay } from '../services/cycle.js';
import { RAG_COLOR, RAG_LABEL, RAG_SYMBOL, badge, esc, md2html, priorityBadge, ragDot, statusBadge } from './html.js';

export function archiveCountdown(t: Trr, s: Settings): string {
  if (!t.deactivated || !t.deactivatedAt) return '';
  const elapsed = daysSince(t.deactivatedAt);
  const remaining = s.archiveDays - elapsed;
  return remaining <= 0
    ? `<div class="small danger">Archive overdue by ${elapsed - s.archiveDays}d</div>`
    : `<div class="small warn">Archive in ${remaining}d</div>`;
}

/** Worst health across a set of TRs (red beats yellow beats green). */
export function worstRag(trrs: Trr[], s: Settings): Rag | null {
  const live = trrs.filter(t => !t.deactivated && !s.closedStatuses.includes(t.status));
  if (!live.length) return null;
  const order: Rag[] = ['red', 'yellow', 'green'];
  return order.find(r => live.some(t => rag(t.lastContact, s) === r)) ?? null;
}

/** Short handle: the upstream TR ID when set, else #num. */
export function trId(t: Trr): string {
  return t.externalId || `#${t.num}`;
}

export function trIdBadge(t: Trr): string {
  return t.externalId ? `<span class="badge ext-id" title="TR ID">${esc(t.externalId)}</span>` : '';
}

export interface CardCtx {
  opp?: string;          // opportunity name
  children?: Trr[];      // this TR's children (it is a parent)
  child?: boolean;       // render as a nested child card
  showCustomer?: boolean;
}

export function trrCard(t: Trr, ints: Interaction[], s: Settings, ctx: CardCtx = {}): string {
  const r = rag(t.lastContact, s);
  const last = ints[0];
  const kids = ctx.children ?? [];
  const txt = `#${t.num} ${t.externalId} ${t.customer} ${t.title} ${t.status} ${ctx.opp ?? ''} ${t.valueThemes.join(' ')} ${kids.map(k => `${k.externalId} ${k.title}`).join(' ')}`.toLowerCase();
  const openKids = kids.filter(k => !k.deactivated && !s.closedStatuses.includes(k.status));
  const stalledKids = openKids.filter(k => rag(k.lastContact, s) === 'red').length;
  return `
  <a class="card trr-card rag-${r} ${t.deactivated ? 'deact' : ''} ${ctx.child ? 'child-card' : ''}" href="/trr/${esc(t.id)}"
     data-txt="${esc(txt)}" x-show="!q || $el.dataset.txt.includes(q.toLowerCase())">
    <div class="trr-card-main">
      <div class="trr-card-head">
        ${ragDot(r, t, s)}
        ${ctx.child ? '<span class="muted3" aria-hidden="true">↳</span>' : ''}
        <span class="trr-num">#${t.num}</span>
        ${trIdBadge(t)}
        ${ctx.child && !ctx.showCustomer ? '' : `<strong>${esc(t.customer)}</strong>`}
        ${badge(t.complexity, 'cx')}
        ${statusBadge(t.status)}
        ${t.myRole ? badge(t.myRole, 'role') : ''}
        ${t.deactivated ? badge('Deactivated', 'st-arch') : ''}
      </div>
      <div class="${ctx.child ? 'child-title' : 'muted'}">${esc(t.title)}</div>
      ${ctx.opp && !ctx.child ? `<div class="small muted2">◇ ${esc(ctx.opp)}</div>` : ''}
      ${kids.length ? `<div class="small family-line">⬚ ${kids.length} child TR${kids.length === 1 ? '' : 's'} · ${openKids.length} open${t.activityVia ? ` · latest activity on #${t.activityVia}` : ''}${stalledKids ? ` · <span class="rag-g-red">${RAG_SYMBOL.red}</span> ${stalledKids} stalled` : ''}</div>` : ''}
      ${t.valueThemes.length && !ctx.child ? `<div class="theme-row">${t.valueThemes.map(v => badge(v, 'theme')).join('')}</div>` : ''}
      ${last ? `<div class="small muted2">Last: ${esc(last.type)} · ${esc(last.date)} · ${esc(last.note.slice(0, 70))}${last.note.length > 70 ? '…' : ''}</div>` : ''}
      ${archiveCountdown(t, s)}
    </div>
    <div class="trr-card-side">
      <div class="small" style="color:${RAG_COLOR[r]};font-weight:600">${t.lastContact ? `${daysSince(t.lastContact)}d ago${t.activityVia ? ` (#${t.activityVia})` : ''}` : 'No contact'}</div>
      <div class="small muted2">${esc(t.priority)} · ${ints.length} log${ints.length === 1 ? '' : 's'}</div>
    </div>
  </a>`;
}

/** Customer › Opportunity › Parent › this — every level a link. */
export function breadcrumbs(parts: { href?: string; label: string }[]): string {
  return `<nav class="crumbs" aria-label="Breadcrumb">${parts.map((p, n) =>
    `${n ? '<span class="crumb-sep" aria-hidden="true">›</span>' : ''}${p.href ? `<a href="${esc(p.href)}">${esc(p.label)}</a>` : `<span aria-current="page">${esc(p.label)}</span>`}`).join('')}</nav>`;
}

export function statTile(value: string | number, label: string, color = ''): string {
  return `<div class="tile"><div class="tile-value" ${color ? `style="color:${color}"` : ''}>${esc(value)}</div><div class="tile-label">${esc(label)}</div></div>`;
}

export function hbar(label: string, count: number, total: number, color: string): string {
  const pct = total ? Math.round((count / total) * 100) : 0;
  return `
  <div class="hbar">
    <span class="hbar-label">${esc(label)}</span>
    <div class="hbar-track"><div class="hbar-fill" style="width:${Math.max(pct, count ? 6 : 0)}%;background:${color}">${count || ''}</div></div>
  </div>`;
}

export function select(name: string, options: readonly string[], value: string, opts: { allowEmpty?: string } = {}): string {
  const empty = opts.allowEmpty !== undefined
    ? `<option value="" ${value === '' ? 'selected' : ''}>${esc(opts.allowEmpty)}</option>` : '';
  return `<select name="${esc(name)}">${empty}${options.map(o =>
    `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
}

export function field(label: string, control: string): string {
  return `<label class="field"><span class="field-label">${esc(label)}</span>${control}</label>`;
}

export interface TrrFormCtx {
  customers: Customer[];
  opps: Opportunity[];     // of the selected customer
  parents: Trr[];          // eligible parents (same customer, top-level, not this TR)
  hasChildren: boolean;    // this TR is a parent — it cannot become a child
  error?: string;
}

/** The part of the TR form that depends on the chosen customer — re-rendered by htmx. */
export function trrLinksFragment(sel: { opportunityId?: string; parentId?: string }, ctx: Pick<TrrFormCtx, 'opps' | 'parents' | 'hasChildren'>): string {
  const opt = (v: string, label: string, cur?: string) => `<option value="${esc(v)}" ${v === (cur ?? '') ? 'selected' : ''}>${esc(label)}</option>`;
  return `
  <div id="trr-links" class="grid2">
    ${field('Opportunity', `<select name="opportunityId" x-model="opp">
      ${opt('', '— none —', sel.opportunityId)}
      ${ctx.opps.map(o => opt(o.id, `${o.name}${o.stage ? ` (${o.stage})` : ''}`, sel.opportunityId)).join('')}
      ${opt('__new', '+ New opportunity…', sel.opportunityId)}
    </select>`)}
    <label class="field" x-show="opp === '__new'" x-cloak><span class="field-label">New opportunity name</span>
      <input name="newOpportunity" placeholder="e.g. FY27 SASE expansion"></label>
    ${ctx.hasChildren
      ? `<div class="field"><span class="field-label">Parent TR</span><div class="small muted2">This TR is a parent — it has child TRs, so it can't be a child itself.</div></div>`
      : field('Parent TR', `<select name="parentId">
          ${opt('', '— none (top-level request) —', sel.parentId)}
          ${ctx.parents.map(p => opt(p.id, `#${p.num}${p.externalId ? ` ${p.externalId}` : ''} — ${p.title}`, sel.parentId)).join('')}
        </select>`)}
  </div>`;
}

export function trrForm(t: Partial<Trr>, action: string, submitLabel: string, s: Settings, ctx: TrrFormCtx): string {
  const v = (k: keyof Trr) => esc((t[k] as string) ?? '');
  const isChild = !!t.parentId;
  return `
  <form method="post" action="${esc(action)}" class="stack" x-data="{opp: '${(t.opportunityId ?? '').replace(/[^\w-]/g, '')}'}">
    ${ctx.error ? `<div class="card danger" role="alert">${esc(ctx.error)}</div>` : ''}
    <div class="grid2">
      ${field('Customer *', `<input name="customer" required value="${v('customer')}" placeholder="Acme Corp" list="customer-list" autocomplete="off"
        hx-get="/fragments/trr-form/links" hx-trigger="change, keyup changed delay:500ms" hx-target="#trr-links" hx-swap="outerHTML"
        hx-include="[name=opportunityId],[name=parentId]" hx-vals='{"trr": "${esc(t.id ?? '')}"}'>
        <datalist id="customer-list">${ctx.customers.map(c => `<option value="${esc(c.name)}">`).join('')}</datalist>`)}
      ${field('TR ID', `<input name="externalId" value="${v('externalId')}" placeholder="request number in your tracking system">`)}
      ${field('Title *', `<input name="title" required value="${v('title')}" placeholder="Platform evaluation">`)}
      ${field('Status', select('status', s.statuses, t.status ?? s.statuses[0] ?? 'New'))}
    </div>
    ${trrLinksFragment({ opportunityId: t.opportunityId, parentId: t.parentId }, ctx)}
    <div class="small muted2">A child TR always sits under its parent's customer and opportunity — those follow the parent automatically.${isChild ? ' (This TR is a child.)' : ''}</div>
    <div class="grid2">
      ${field('Complexity', select('complexity', COMPLEXITIES, t.complexity ?? 'Simple'))}
      ${field('Priority', select('priority', PRIORITIES, t.priority ?? 'Medium'))}
      ${field('Target close', `<input type="date" name="targetClose" value="${v('targetClose')}">`)}
      ${field('Contact', `<input name="contact" value="${v('contact')}">`)}
      ${field('Account rep', `<input name="rep" value="${v('rep')}">`)}
      ${field('My role', select('myRole', s.roles, t.myRole ?? '', { allowEmpty: '—' }))}
      ${field('Outcome', select('outcome', s.outcomes, t.outcome ?? '', { allowEmpty: '—' }))}
      ${field('Weekly update', `<select name="updateCadence">
        <option value="" ${!t.updateCadence ? 'selected' : ''}>Default (${esc(s.updateCadence)}; none for a parent with children)</option>
        ${UPDATE_CADENCES.map(c => `<option ${t.updateCadence === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>`)}
    </div>
    <div class="field">
      <span class="field-label">Value themes <span class="muted2">(select all that apply)</span></span>
      <div class="theme-grid">
        ${s.themes.map(v => `<label class="check theme-check">
          <input type="checkbox" name="valueThemes" value="${esc(v)}" ${(t.valueThemes ?? []).includes(v) ? 'checked' : ''}> ${esc(v)}</label>`).join('')}
      </div>
    </div>
    ${field('Description', `<textarea name="description" rows="4">${v('description')}</textarea>`)}
    <div class="row">
      <button class="btn" type="submit">${esc(submitLabel)}</button>
      <a class="btn btn-outline" href="${t.id ? `/trr/${esc(t.id)}` : '/'}">Cancel</a>
    </div>
  </form>`;
}

export function interactionForm(trrId: string, i?: Interaction, related: Trr[] = [], linked: string[] = [], opts: { bare?: boolean } = {}): string {
  const action = i ? `/interactions/${esc(i.id)}/update` : `/trr/${esc(trrId)}/interactions`;
  const others = related.filter(r => r.id !== trrId);
  return `
  <form method="post" action="${action}" class="stack ${opts.bare ? '' : 'card'}">
    <div class="grid2">
      ${field('Type', select('type', INTERACTION_TYPES, i?.type ?? 'Call'))}
      ${field('Date', `<input type="date" name="date" value="${esc(i?.date ?? new Date().toISOString().slice(0, 10))}">`)}
    </div>
    ${field('Notes', `<textarea name="note" rows="10" placeholder="Dump notes here — meeting notes, call transcripts, pasted email threads…">${esc(i?.note ?? '')}</textarea>`)}
    <label class="check"><input type="checkbox" name="sensitive" ${i?.sensitive ? 'checked' : ''}> 🚩 Flag this log <span class="muted2">(won't be passed to AI — no summaries, drafts, reviews, or semantic search; any AI text already made from it is cleared)</span></label>
    ${others.length ? `
    <details class="field" ${linked.length ? 'open' : ''}>
      <summary class="field-label">Also applies to (${others.length} related TR${others.length === 1 ? '' : 's'})</summary>
      <div class="theme-grid">
        ${others.map(r => `<label class="check theme-check"><input type="checkbox" name="alsoTrr" value="${esc(r.id)}" ${linked.includes(r.id) ? 'checked' : ''}>
          #${r.num}${r.externalId ? ` ${esc(r.externalId)}` : ''} ${esc(r.title)}</label>`).join('')}
      </div>
      <div class="small muted2">The log is recorded once and shows on every TR it applies to — and counts toward each one's weekly update.</div>
    </details>` : ''}
    <div class="row">
      <button class="btn" type="submit">${i ? 'Update' : 'Log interaction'}</button>
      <a class="btn btn-outline" href="/trr/${esc(trrId)}">Cancel</a>
    </div>
  </form>`;
}

export interface IntCardOpts {
  aiError?: string;
  aiEnabled?: boolean;
  owner?: Trr;          // set when the log is shown on a TR other than its owner
  linkedTo?: Trr[];     // other TRs the log also applies to
}

export function interactionCard(i: Interaction, opts: IntCardOpts = {}): string {
  const hasAi = !!(i.aiCust || i.aiExec);
  const ai = opts.aiEnabled !== false;
  return `
  <div class="card int-card" id="int-${esc(i.id)}">
    <div class="int-head">
      <div class="row">
        ${badge(i.type, 'st-plain')}
        <span class="small muted2">${esc(i.date)}</span>
        ${i.sensitive ? `<span class="badge st-lost" title="Flagged: this log is never passed to AI">🚩 Flagged · not sent to AI</span>` : ''}
        ${hasAi ? badge('AI', 'st-won') : ''}
        ${i.source === 'update' ? badge('Posted update', 'role') : ''}
        ${opts.owner ? `<a class="badge cx" href="/trr/${esc(opts.owner.id)}" title="Logged on this TR">from #${opts.owner.num} ${esc(opts.owner.externalId)}</a>` : ''}
        ${opts.linkedTo?.length ? `<span class="small muted2" title="This log also applies to">↔ ${opts.linkedTo.map(t => `#${t.num}`).join(', ')}</span>` : ''}
      </div>
      <div class="row">
        <a class="btn btn-outline btn-sm" href="/interactions/${esc(i.id)}/edit">✏️</a>
        ${ai && !i.sensitive ? `<button class="btn btn-outline btn-sm" title="Generate customer + exec versions"
          hx-post="/interactions/${esc(i.id)}/ai" hx-target="#int-${esc(i.id)}" hx-swap="outerHTML"
          hx-indicator="#int-${esc(i.id)} .ai-ind">🤖 AI</button>` : ''}
        <form method="post" action="/interactions/${esc(i.id)}/delete" onsubmit="return confirm('Delete this interaction?')" style="display:inline">
          <button class="btn btn-outline btn-sm danger" type="submit">🗑️</button>
        </form>
      </div>
    </div>
    <div class="int-note">${esc(i.note)}</div>
    <span class="ai-ind htmx-indicator small muted2">⏳ generating on local model…</span>
    ${opts.aiError ? `<div class="small danger">AI error: ${esc(opts.aiError)}</div>` : ''}
    ${hasAi ? `
    <div class="ai-out">
      ${i.aiCust ? aiBlock('Customer version', i.aiCust, 'cust') : ''}
      ${i.aiExec ? aiBlock('Exec summary', i.aiExec, 'exec') : ''}
    </div>` : ''}
  </div>`;
}

function aiBlock(label: string, text: string, kind: string): string {
  return `
  <div class="ai-block ai-${kind}" x-data>
    <div class="row-between">
      <span class="field-label">${esc(label)}</span>
      <button class="btn btn-outline btn-sm" @click="navigator.clipboard.writeText($refs.t.innerText).then(()=>{$el.textContent='✓ copied'; setTimeout(()=>$el.textContent='📋 copy',1200)})">📋 copy</button>
    </div>
    <div class="ai-text" x-ref="t">${md2html(text)}</div>
  </div>`;
}

export function digestBlock(d: StoredDigest, opts: { cached: boolean }): string {
  return `
  <div class="card digest-card">
    <div class="row-between">
      <strong>${esc(d.customer)} — catch me up</strong>
      <span class="small muted2">${opts.cached ? 'cached' : 'fresh'} · ${esc(d.model)} · ${esc(d.generatedAt.slice(0, 16).replace('T', ' '))}</span>
    </div>
    <div class="small muted2">${d.interactions} interactions · ${esc(d.first)} → ${esc(d.last)} · ${esc(d.status)}</div>
    <div class="ai-text">${md2html(d.summary)}</div>
    <button class="btn btn-outline btn-sm" hx-get="/fragments/trr-digest/${esc(d.trrId)}?regen=1"
      hx-target="closest .digest-card" hx-swap="outerHTML" hx-indicator="closest .digest-card .dg-ind">↺ regenerate</button>
    <span class="dg-ind htmx-indicator small muted2">⏳ regenerating…</span>
  </div>`;
}

// --- Summary to date -----------------------------------------------------------

export function summaryBlock(x: ScopeSummary, opts: { note?: string } = {}): string {
  return `
  <div class="summary-block" x-data>
    <div class="row-between wrap">
      <span class="small muted2">as of <strong>${esc(x.last || x.generatedAt.slice(0, 10))}</strong> · ${x.interactions} entr${x.interactions === 1 ? 'y' : 'ies'} · ${x.mode} · ${esc(x.model)} · ${esc(x.generatedAt.slice(0, 16).replace('T', ' '))}</span>
      <button class="btn btn-outline btn-sm" @click="navigator.clipboard.writeText($refs.t.innerText).then(()=>{$el.textContent='✓ copied'; setTimeout(()=>$el.textContent='📋 copy',1200)})">📋 copy</button>
    </div>
    ${opts.note ? `<div class="small hl">${esc(opts.note)}</div>` : ''}
    <div class="ai-text" x-ref="t">${md2html(x.summary)}</div>
  </div>`;
}

const SCOPE_NAMES: Record<SummaryScopeKind, string> = {
  trr: 'this TR', family: 'TR + children', opportunity: 'this opportunity', customer: 'this customer',
};

/**
 * On-demand summary panel for a scope: the latest version, a run button
 * (incremental by default), a full-rebuild option, and earlier versions.
 */
export function summaryPanel(kind: SummaryScopeKind, id: string, versions: ScopeSummary[], aiEnabled: boolean, opts: { open?: boolean; alt?: { kind: SummaryScopeKind; id: string; label: string } } = {}): string {
  const latest = versions[0];
  const pid = `sum-${kind}-${esc(id)}`;
  return `
  <details class="card summary-panel" ${opts.open || latest ? 'open' : ''} id="${pid}">
    <summary><strong>🧠 Summary to date</strong> <span class="small muted2">— ${SCOPE_NAMES[kind]}${versions.length ? ` · ${versions.length} version${versions.length === 1 ? '' : 's'}` : ''}</span></summary>
    ${opts.alt ? `<div class="small"><a class="hl" href="#sum-${opts.alt.kind}-${esc(opts.alt.id)}">${esc(opts.alt.label)} ↓</a></div>` : ''}
    <div class="sum-out" id="${pid}-out">${latest ? summaryBlock(latest) : '<div class="small muted2">No summary yet.</div>'}</div>
    ${aiEnabled ? `
    <div class="row">
      <button class="btn btn-sm" hx-post="/summaries/${kind}/${esc(id)}" hx-target="#${pid} .sum-job" hx-swap="innerHTML">${latest ? '↻ Bring up to date' : 'Generate summary'}</button>
      ${latest ? `<button class="btn btn-outline btn-sm" hx-post="/summaries/${kind}/${esc(id)}?full=1" hx-target="#${pid} .sum-job" hx-swap="innerHTML"
        hx-confirm="Rebuild from the whole record instead of updating the latest version?">Full rebuild</button>` : ''}
    </div>
    <div class="sum-job"></div>` : '<div class="small muted2">🔌 AI is switched off in Settings.</div>'}
    ${versions.length > 1 ? `
    <details class="small"><summary class="muted2">Earlier versions (${versions.length - 1})</summary>
      ${versions.slice(1).map(v => `<details class="card"><summary class="small">${esc(v.last || v.generatedAt.slice(0, 10))} · ${v.interactions} entries · ${esc(v.mode)}</summary>${summaryBlock(v)}</details>`).join('')}
    </details>` : ''}
  </details>`;
}

// --- Background jobs ---------------------------------------------------------------

/** Self-polling progress card; the done state is rendered by the caller's route. */
export function jobProgress(j: Job, pollUrl: string): string {
  const pct = j.progress.total ? Math.round((j.progress.done / j.progress.total) * 100) : 0;
  return `
  <div class="job-card" hx-get="${esc(pollUrl)}" hx-trigger="load delay:2s" hx-swap="outerHTML">
    <div class="small">⏳ ${esc(j.label)} — ${esc(j.progress.phase)} <span class="muted2">(${j.progress.done}/${j.progress.total})</span></div>
    <div class="hbar-track"><div class="hbar-fill" style="width:${Math.max(pct, 4)}%;background:var(--blue)"></div></div>
  </div>`;
}

// --- Update Desk ---------------------------------------------------------------------

// State is never colour alone: each has its own shape (same rule as health).
export const DESK_STATE: Record<DeskState, { sym: string; label: string; cls: string }> = {
  overdue: { sym: '■', label: 'Overdue', cls: 'ds-overdue' },
  due: { sym: '▲', label: 'Due', cls: 'ds-due' },
  draft: { sym: '◆', label: 'Draft ready', cls: 'ds-draft' },
  posted: { sym: '●', label: 'Posted', cls: 'ds-posted' },
  'not-due': { sym: '○', label: 'Not due', cls: 'ds-notdue' },
};

export function deskStateBadge(st: DeskState): string {
  const d = DESK_STATE[st];
  return `<span class="badge ds ${d.cls}" role="img" aria-label="${esc(d.label)}">${d.sym} ${esc(d.label)}</span>`;
}

export function updateRowCard(r: DeskRow, cycleDue: string, aiEnabled: boolean, opts: { flash?: string; error?: string; edit?: boolean } = {}): string {
  const t = r.trr;
  const u = r.update;
  const rid = `upd-${esc(t.id)}`;
  const base = `/updates/${esc(t.id)}/${esc(cycleDue)}`;
  const since = r.lastPosted ? `since last update (${esc(localDay(r.windowFrom))})` : `in the last ${r.cadence === 'biweekly' ? 14 : 7} days (no update posted yet)`;
  const act = r.state === 'posted'
    ? `${u?.interactions ?? 0} entr${u?.interactions === 1 ? 'y' : 'ies'} covered`
    : r.entries.length ? `${r.entries.length} entr${r.entries.length === 1 ? 'y' : 'ies'} ${since}` : `<span class="warn">no activity ${since}</span>`;
  const editable = !!u && u.status === 'draft';
  return `
  <div class="card upd-row ${r.parent ? 'child-card' : ''} ${DESK_STATE[r.state].cls}-row" id="${rid}" x-data="{edit:${opts.edit ? 'true' : 'false'}}">
    <div class="row-between wrap">
      <div class="row">
        ${deskStateBadge(r.state)}
        ${r.parent ? '<span class="muted3" aria-hidden="true">↳</span>' : ''}
        <a class="trr-num" href="/trr/${esc(t.id)}">#${t.num}</a>
        ${trIdBadge(t)}
        <a href="/trr/${esc(t.id)}"><strong>${esc(t.title)}</strong></a>
        ${r.stale ? `<span class="badge st-lost" title="New activity was logged after this draft was generated">new activity since draft</span>` : ''}
        ${r.cadence === 'biweekly' ? badge('every 2 weeks', 'cx') : ''}
      </div>
      <div class="small muted2">${act}</div>
    </div>
    ${opts.error ? `<div class="small danger">${esc(opts.error)}</div>` : ''}
    ${u ? `
    <div x-show="!edit">
      <pre class="report-pre upd-text" x-ref="txt">${esc(u.text)}</pre>
      <div class="small muted2">${u.status === 'posted' ? `posted ${esc(u.postedAt.slice(0, 16).replace('T', ' '))}` : `drafted ${esc(u.generatedAt.slice(0, 16).replace('T', ' '))}`} · ${u.model ? esc(u.model) : 'plain'}${u.edited ? ' · edited' : ''}</div>
    </div>
    <form x-show="edit" x-cloak hx-post="${base}/text" hx-target="#${rid}" hx-swap="outerHTML" class="stack">
      <textarea name="text" rows="6" class="mono">${esc(u.text)}</textarea>
      <div class="row"><button class="btn btn-sm" type="submit">Save</button><button class="btn btn-outline btn-sm" type="button" @click="edit=false">Cancel</button></div>
    </form>` : ''}
    <div class="row upd-actions" x-show="!edit">
      ${r.state !== 'posted' ? `
        ${aiEnabled && r.entries.length ? `<button class="btn btn-sm" hx-post="${base}/draft" hx-target="#${rid}" hx-swap="outerHTML" hx-indicator="#${rid} .upd-ind"
          ${u?.edited ? 'hx-confirm="Replace your edited draft with a fresh AI draft?"' : ''}>🤖 ${u ? 'Redraft' : 'Draft'}</button>` : ''}
        <button class="btn btn-outline btn-sm" hx-post="${base}/draft?plain=1" hx-target="#${rid}" hx-swap="outerHTML"
          ${u ? 'hx-confirm="Replace the current draft with a plain list of the entries?"' : ''}>${r.entries.length ? '≡ Plain draft' : '“No change” draft'}</button>
        ${u ? `<button class="btn btn-outline btn-sm" @click="edit=true">✏️ Edit</button>` : `<button class="btn btn-outline btn-sm" hx-post="${base}/text" hx-vals='{"text": ""}' hx-target="#${rid}" hx-swap="outerHTML">✏️ Write</button>`}
      ` : ''}
      ${u?.text ? `<button class="btn btn-outline btn-sm" @click="navigator.clipboard.writeText($refs.txt.innerText).then(()=>{$el.textContent='✓ copied'; setTimeout(()=>$el.textContent='📋 copy',1200)})">📋 copy</button>` : ''}
      ${editable && u!.text.trim() ? `<button class="btn btn-sm btn-post" hx-post="/updates/u/${u!.id}/post" hx-target="#${rid}" hx-swap="outerHTML">✓ Mark posted</button>` : ''}
      ${u?.status === 'posted' ? `<button class="btn btn-outline btn-sm" hx-post="/updates/u/${u.id}/unpost" hx-target="#${rid}" hx-swap="outerHTML" hx-confirm="Move this back to draft? The logged record note is removed.">↶ Unpost</button>` : ''}
      <span class="upd-ind htmx-indicator small muted2">⏳ drafting on local model…</span>
      ${opts.flash ? `<span class="small hl">${esc(opts.flash)}</span>` : ''}
    </div>
    ${r.entries.length && r.state !== 'posted' ? `
    <details class="small"><summary class="muted2">Entries in this window (${r.entries.length})</summary>
      ${r.entries.map(i => `<div class="upd-entry"><span class="muted2">${esc(i.date)} ${esc(i.type)}</span> ${i.sensitive ? '🚩 <em>flagged — not sent to AI</em> · ' : ''}${esc((i.aiExec || i.note).replace(/\s+/g, ' ').slice(0, 220))}</div>`).join('')}
    </details>` : ''}
  </div>`;
}

export function cycleLabel(due: string): string {
  return shortDay(due);
}

export function errorBox(msg: string): string {
  return `<div class="card"><div class="danger">${esc(msg)}</div></div>`;
}

export { RAG_COLOR, RAG_LABEL, badge, esc, priorityBadge, statusBadge };
