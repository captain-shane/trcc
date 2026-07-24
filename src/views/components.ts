import type { Interaction, Settings, StoredDigest, Trr } from '../types.js';
import { COMPLEXITIES, INTERACTION_TYPES, PRIORITIES, daysSince, rag } from '../types.js';
import { RAG_COLOR, RAG_LABEL, badge, esc, md2html, priorityBadge, ragDot, statusBadge } from './html.js';

export function archiveCountdown(t: Trr, s: Settings): string {
  if (!t.deactivated || !t.deactivatedAt) return '';
  const elapsed = daysSince(t.deactivatedAt);
  const remaining = s.archiveDays - elapsed;
  return remaining <= 0
    ? `<div class="small danger">Archive overdue by ${elapsed - s.archiveDays}d</div>`
    : `<div class="small warn">Archive in ${remaining}d</div>`;
}

export function trrCard(t: Trr, ints: Interaction[], s: Settings): string {
  const r = rag(t.lastContact, s);
  const last = ints[0];
  const txt = `#${t.num} ${t.customer} ${t.title} ${t.status} ${t.valueThemes.join(' ')}`.toLowerCase();
  return `
  <a class="card trr-card rag-${r} ${t.deactivated ? 'deact' : ''}" href="/trr/${esc(t.id)}"
     data-txt="${esc(txt)}" x-show="!q || $el.dataset.txt.includes(q.toLowerCase())">
    <div class="trr-card-main">
      <div class="trr-card-head">
        ${ragDot(r, t, s)}
        <span class="trr-num">#${t.num}</span>
        <strong>${esc(t.customer)}</strong>
        ${badge(t.complexity, 'cx')}
        ${statusBadge(t.status)}
        ${t.myRole ? badge(t.myRole, 'role') : ''}
        ${t.deactivated ? badge('Deactivated', 'st-arch') : ''}
      </div>
      <div class="muted">${esc(t.title)}</div>
      ${t.valueThemes.length ? `<div class="theme-row">${t.valueThemes.map(v => badge(v, 'theme')).join('')}</div>` : ''}
      ${last ? `<div class="small muted2">Last: ${esc(last.type)} · ${esc(last.date)} · ${esc(last.note.slice(0, 70))}${last.note.length > 70 ? '…' : ''}</div>` : ''}
      ${archiveCountdown(t, s)}
    </div>
    <div class="trr-card-side">
      <div class="small" style="color:${RAG_COLOR[r]};font-weight:600">${t.lastContact ? `${daysSince(t.lastContact)}d ago` : 'No contact'}</div>
      <div class="small muted2">${esc(t.priority)} · ${ints.length} log${ints.length === 1 ? '' : 's'}</div>
    </div>
  </a>`;
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

function select(name: string, options: readonly string[], value: string, opts: { allowEmpty?: string } = {}): string {
  const empty = opts.allowEmpty !== undefined
    ? `<option value="" ${value === '' ? 'selected' : ''}>${esc(opts.allowEmpty)}</option>` : '';
  return `<select name="${esc(name)}">${empty}${options.map(o =>
    `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
}

export function field(label: string, control: string): string {
  return `<label class="field"><span class="field-label">${esc(label)}</span>${control}</label>`;
}

export function trrForm(t: Partial<Trr>, action: string, submitLabel: string, s: Settings): string {
  const v = (k: keyof Trr) => esc((t[k] as string) ?? '');
  return `
  <form method="post" action="${esc(action)}" class="stack">
    <div class="grid2">
      ${field('Customer *', `<input name="customer" required value="${v('customer')}" placeholder="Acme Corp">`)}
      ${field('Title *', `<input name="title" required value="${v('title')}" placeholder="Platform evaluation">`)}
      ${field('Status', select('status', s.statuses, t.status ?? s.statuses[0] ?? 'New'))}
      ${field('Complexity', select('complexity', COMPLEXITIES, t.complexity ?? 'Simple'))}
      ${field('Priority', select('priority', PRIORITIES, t.priority ?? 'Medium'))}
      ${field('Target close', `<input type="date" name="targetClose" value="${v('targetClose')}">`)}
      ${field('Contact', `<input name="contact" value="${v('contact')}">`)}
      ${field('Account rep', `<input name="rep" value="${v('rep')}">`)}
      ${field('My role', select('myRole', s.roles, t.myRole ?? '', { allowEmpty: '—' }))}
      ${field('Outcome', select('outcome', s.outcomes, t.outcome ?? '', { allowEmpty: '—' }))}
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

export function interactionForm(trrId: string, i?: Interaction): string {
  const action = i ? `/interactions/${esc(i.id)}/update` : `/trr/${esc(trrId)}/interactions`;
  return `
  <form method="post" action="${action}" class="stack card">
    <div class="grid2">
      ${field('Type', select('type', INTERACTION_TYPES, i?.type ?? 'Call'))}
      ${field('Date', `<input type="date" name="date" value="${esc(i?.date ?? new Date().toISOString().slice(0, 10))}">`)}
    </div>
    ${field('Notes', `<textarea name="note" rows="10" placeholder="Dump notes here — meeting notes, call transcripts, pasted email threads…">${esc(i?.note ?? '')}</textarea>`)}
    <label class="check"><input type="checkbox" name="sensitive" ${i?.sensitive ? 'checked' : ''}> Sensitive (extra caution flag)</label>
    <div class="row">
      <button class="btn" type="submit">${i ? 'Update' : 'Log interaction'}</button>
      <a class="btn btn-outline" href="/trr/${esc(trrId)}">Cancel</a>
    </div>
  </form>`;
}

export function interactionCard(i: Interaction, opts: { aiError?: string; aiEnabled?: boolean } = {}): string {
  const hasAi = !!(i.aiCust || i.aiExec);
  const ai = opts.aiEnabled !== false;
  return `
  <div class="card int-card" id="int-${esc(i.id)}">
    <div class="int-head">
      <div class="row">
        ${badge(i.type, 'st-plain')}
        <span class="small muted2">${esc(i.date)}</span>
        ${i.sensitive ? badge('Sensitive', 'st-lost') : ''}
        ${hasAi ? badge('AI', 'st-won') : ''}
      </div>
      <div class="row">
        <a class="btn btn-outline btn-sm" href="/interactions/${esc(i.id)}/edit">✏️</a>
        ${ai ? `<button class="btn btn-outline btn-sm" title="Generate customer + exec versions"
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

export function errorBox(msg: string): string {
  return `<div class="card"><div class="danger">${esc(msg)}</div></div>`;
}

export { RAG_COLOR, RAG_LABEL, badge, esc, priorityBadge, statusBadge };
