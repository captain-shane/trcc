import type { Customer, Interaction, Opportunity, ScopeSummary, Settings, StoredDigest, Trr, TrrHistoryEntry } from '../types.js';
import { COMPLEXITIES, PRIORITIES, daysSince, rag } from '../types.js';
import type { Desk, DeskRow } from '../services/updates.js';
import { WEEKDAYS, addDays, daysBetween, localDay, shortDay } from '../services/cycle.js';
import type { PeriodDigest } from '../services/digest.js';
import type { SearchHit } from '../services/search.js';
import { RAG_COLOR, RAG_LABEL, RAG_SYMBOL, esc, md2html, page, priorityBadge, ragDot, statusBadge, badge } from './html.js';
import {
  DESK_STATE, archiveCountdown, breadcrumbs, deskStateBadge, digestBlock, field, hbar, interactionCard, interactionForm,
  select, statTile, summaryPanel, trId, trIdBadge, trrCard, trrForm, updateRowCard, worstRag, type TrrFormCtx,
} from './components.js';

type IntsByTrr = Map<string, Interaction[]>;

// --- Dashboard --------------------------------------------------------------

function backlogBanner(backlog: number, aiEnabled: boolean): string {
  if (backlog === 0 || !aiEnabled) return '';
  return `
  <div class="card banner">
    <div class="row-between wrap">
      <div>🤖 <strong>${backlog}</strong> note${backlog === 1 ? '' : 's'} missing exec summaries
        <span class="small muted2">— auto-backfill runs on a timer (see Settings); or run a batch now</span></div>
      <div class="row">
        <button class="btn btn-sm" hx-post="/ai/backfill" hx-target="#bf-banner-out" hx-swap="innerHTML"
          hx-indicator="#bf-banner-ind">Run batch</button>
        <span id="bf-banner-ind" class="htmx-indicator small muted2">⏳ generating…</span>
      </div>
    </div>
    <div id="bf-banner-out"></div>
  </div>`;
}

export interface DashCtx {
  group: 'family' | 'customer' | 'flat';
  opps: Map<string, Opportunity>;
  customers: Map<string, Customer>;
  kids: Map<string, Trr[]>;       // parentId -> children (all active TRs)
  updatesDue: number;              // due + overdue on the current cycle
  cycleDue: string;
}

export function dashboard(trrs: Trr[], ints: IntsByTrr, s: Settings, filter: string, backlog: number, ctx: DashCtx): string {
  const live = trrs.filter(t => !t.deactivated);
  const ct = { red: 0, yellow: 0, green: 0 };
  for (const t of live) ct[rag(t.lastContact, s)]++;
  const deact = trrs.filter(t => t.deactivated).length;

  const filtered =
    filter === 'deact' ? trrs.filter(t => t.deactivated) :
    filter === 'red' || filter === 'yellow' || filter === 'green'
      ? trrs.filter(t => !t.deactivated && rag(t.lastContact, s) === filter)
      : trrs;

  const order = { red: 0, yellow: 1, green: 2 };
  const byHealth = (a: Trr, b: Trr) => {
    if (a.deactivated !== b.deactivated) return a.deactivated ? 1 : -1;
    return order[rag(a.lastContact, s)] - order[rag(b.lastContact, s)];
  };
  const sorted = [...filtered].sort(byHealth);
  const oppName = (t: Trr) => (t.opportunityId ? ctx.opps.get(t.opportunityId)?.name : undefined);
  const qs = (k: string, v: string) => {
    const p = new URLSearchParams({ f: filter, g: ctx.group, [k]: v });
    if (p.get('f') === 'all') p.delete('f');
    if (p.get('g') === 'family') p.delete('g');
    const str = p.toString();
    return str ? `/?${str}` : '/';
  };

  const tile = (k: string, label: string, count: number, color: string) => `
    <a class="tile tile-link ${filter === k ? 'active' : ''}" href="${qs('f', k)}">
      <div class="tile-value" style="color:${color}">${count}</div>
      <div class="tile-label">${label}</div>
    </a>`;

  // Family view: parents carry their children; a child whose parent is not in
  // the current list (closed, or filtered out) is shown on its own.
  const familyCards = (list: Trr[], opts: { showCustomer?: boolean } = {}) => {
    const ids = new Set(list.map(t => t.id));
    return list.filter(t => !t.parentId || !ids.has(t.parentId)).map(t => {
      const kids = (ctx.kids.get(t.id) ?? []).filter(k => ids.has(k.id));
      return `<div class="family">${trrCard(t, ints.get(t.id) ?? [], s, { opp: oppName(t), children: ctx.kids.get(t.id) ?? [] })}
        ${kids.map(k => trrCard(k, ints.get(k.id) ?? [], s, { child: true, showCustomer: opts.showCustomer })).join('')}</div>`;
    }).join('');
  };

  let body: string;
  const useFamily = ctx.group !== 'flat' && filter === 'all';
  if (ctx.group === 'customer') {
    const groups = new Map<string, Trr[]>();
    for (const t of sorted) {
      const k = t.customerId || t.customer;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(t);
    }
    body = [...groups.entries()]
      .sort((a, b) => (a[1][0]!.customer).localeCompare(b[1][0]!.customer))
      .map(([cid, list]) => {
        const c = ctx.customers.get(cid);
        const wr = worstRag(list, s);
        return `<section class="cust-group" data-txt="${esc(list.map(t => `#${t.num} ${t.externalId} ${t.customer} ${t.title}`).join(' ').toLowerCase())}"
          x-show="!q || $el.dataset.txt.includes(q.toLowerCase())">
          <div class="cust-head row-between">
            <a href="${c ? `/customer/${esc(c.id)}` : '#'}"><strong>${esc(list[0]!.customer)}</strong></a>
            <span class="small muted2">${list.length} TR${list.length === 1 ? '' : 's'}${wr ? ` · worst <span class="rag-g-${wr}">${RAG_SYMBOL[wr]}</span>` : ''}</span>
          </div>
          <div class="trr-grid">${filter === 'all' ? familyCards(list) : list.map(t => trrCard(t, ints.get(t.id) ?? [], s, { opp: oppName(t) })).join('')}</div>
        </section>`;
      }).join('');
  } else if (useFamily) {
    body = `<div class="trr-grid">${familyCards(sorted, { showCustomer: false })}</div>`;
  } else {
    body = `<div class="trr-grid">${sorted.map(t => trrCard(t, ints.get(t.id) ?? [], s, { opp: oppName(t) })).join('')}</div>`;
  }

  const gbtn = (g: DashCtx['group'], label: string) =>
    `<a class="seg ${ctx.group === g ? 'active' : ''}" href="${qs('g', g)}">${label}</a>`;

  return page('Dashboard', '/', `
  <div class="tiles">
    ${tile('red', `${RAG_SYMBOL.red} Stalled`, ct.red, 'var(--red)')}
    ${tile('yellow', `${RAG_SYMBOL.yellow} Aging`, ct.yellow, 'var(--yellow)')}
    ${tile('green', `${RAG_SYMBOL.green} Active`, ct.green, 'var(--green)')}
    ${tile('deact', 'Deactivated', deact, 'var(--muted2)')}
    ${tile('all', 'Total', trrs.length, 'var(--text)')}
    <a class="tile tile-link" href="/updates" title="Weekly updates due ${esc(ctx.cycleDue)}">
      <div class="tile-value" style="color:${ctx.updatesDue ? 'var(--yellow)' : 'var(--green)'}">${ctx.updatesDue}</div>
      <div class="tile-label">${ctx.updatesDue ? '▲' : '●'} Updates due ${esc(shortDay(ctx.cycleDue))}</div>
    </a>
  </div>
  ${backlogBanner(backlog, s.aiEnabled)}
  <div x-data="{q:''}">
    <div class="row dash-tools">
      <input class="list-filter" x-model="q" placeholder="🔍 Filter by #, TR ID, customer, title, status, theme…">
      <div class="segmented" role="group" aria-label="Group by">
        ${gbtn('family', 'Families')}${gbtn('customer', 'By customer')}${gbtn('flat', 'Flat')}
      </div>
    </div>
    ${sorted.length === 0 ? '<div class="card muted center">No TRs match.</div>' : ''}
    ${body}
  </div>
  `);
}

// --- TRR detail -------------------------------------------------------------

function historyTimeline(history: TrrHistoryEntry[]): string {
  if (history.length === 0) return '<div class="small muted2">No changes recorded yet.</div>';
  return `<div class="timeline">${history.map(h => `
    <div class="timeline-row">
      <span class="timeline-date">${esc(h.changedAt.slice(0, 10))}</span>
      <span class="timeline-body">
        ${h.field === 'created'
          ? `created <span class="hl">${esc(h.newValue)}</span>`
          : `${esc(h.field)}: <span class="old">${esc(h.oldValue || '—')}</span> → <span class="hl">${esc(h.newValue || '—')}</span>`}
      </span>
    </div>`).join('')}</div>`;
}

export interface DetailCtx {
  customer: Customer | null;
  opp: Opportunity | null;
  parent: Trr | null;
  children: Trr[];
  related: Trr[];                     // same-customer TRs a log can also apply to
  owners: Map<string, Trr>;           // TR by id, for "logged on #n" badges
  links: Map<string, string[]>;       // interactionId -> linked TR ids
  includeChildren: boolean;           // parent timeline merges children's logs
  summaries: { trr: ScopeSummary[]; family: ScopeSummary[] };
  deskRow: DeskRow | null;            // this TR on the current cycle's desk
  cycleDue: string;
  updates: import('../types.js').TrUpdate[];
}

/** Inline status / priority / outcome controls — saved on change, no page load. */
export function quickControls(t: Trr, s: Settings, flash = ''): string {
  const sel = (name: string, options: readonly string[], value: string, empty?: string) =>
    `<label class="field"><span class="field-label">${esc(name === 'myRole' ? 'my role' : name)}</span>
      <select name="${name}" hx-post="/trr/${esc(t.id)}/quick" hx-trigger="change" hx-target="#trr-quick" hx-swap="outerHTML" hx-include="this">
        ${empty !== undefined ? `<option value="" ${value === '' ? 'selected' : ''}>${esc(empty)}</option>` : ''}
        ${options.map(o => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      </select></label>`;
  return `
  <div class="card quick" id="trr-quick">
    <div class="row-between"><h3 style="margin:0">Quick edit</h3>${flash ? `<span class="small hl" role="status">✓ ${esc(flash)}</span>` : ''}</div>
    <div class="grid2 quick-grid">
      ${sel('status', s.statuses, t.status)}
      ${sel('priority', PRIORITIES, t.priority)}
      ${sel('outcome', s.outcomes, t.outcome, '—')}
      ${sel('myRole', s.roles, t.myRole, '—')}
    </div>
  </div>`;
}

function childrenCard(t: Trr, kids: Trr[], s: Settings): string {
  return `
  <div class="card">
    <div class="row-between"><h3 style="margin:0">Child TRs (${kids.length})</h3>
      ${t.parentId ? '' : `<a class="btn btn-sm" href="/trr/new?parent=${esc(t.id)}">+ Child TR</a>`}</div>
    ${kids.length === 0 ? '<div class="small muted2">None yet. A child TR inherits this request\'s customer and opportunity.</div>' : ''}
    ${kids.map(k => {
      const r = rag(k.lastContact, s);
      return `<a class="child-row" href="/trr/${esc(k.id)}"><span class="rag-glyph rag-g-${r}">${RAG_SYMBOL[r]}</span>
        <span class="trr-num">#${k.num}</span>${trIdBadge(k)}<span class="child-title">${esc(k.title)}</span>${statusBadge(k.status)}</a>`;
    }).join('')}
  </div>`;
}

function updatesCard(t: Trr, ctx: DetailCtx, aiEnabled: boolean): string {
  const posted = ctx.updates.filter(u => u.status === 'posted');
  return `
  <details class="card" ${ctx.deskRow && ctx.deskRow.state !== 'posted' && ctx.deskRow.state !== 'not-due' ? 'open' : ''}>
    <summary><strong>🗓 Weekly update</strong> <span class="small muted2">— cycle due ${esc(shortDay(ctx.cycleDue))}${ctx.deskRow ? ` · ${DESK_STATE[ctx.deskRow.state].label}` : ' · not on the desk'}</span></summary>
    ${ctx.deskRow ? updateRowCard(ctx.deskRow, ctx.cycleDue, aiEnabled) : `<div class="small muted2">${t.parentId || !ctx.children.length ? 'This TR is closed, deactivated, or set to no weekly update.' : 'Parents with children report through their children by default (set a cadence on this TR to include it).'}</div>`}
    ${posted.length ? `<details class="small"><summary class="muted2">Posted updates (${posted.length})</summary>
      ${posted.map(u => `<div class="upd-hist"><div class="muted2">cycle ${esc(u.cycleDue)} · posted ${esc(u.postedAt.slice(0, 10))}</div><pre class="report-pre">${esc(u.text)}</pre></div>`).join('')}
    </details>` : ''}
    <div class="small"><a class="hl" href="/updates">Open the Update Desk →</a></div>
  </details>`;
}

export function trrDetail(t: Trr, ints: Interaction[], s: Settings, digest: StoredDigest | null, history: TrrHistoryEntry[], ctx: DetailCtx): string {
  const r = rag(t.lastContact, s);
  const meta: [string, string][] = [
    ['TR ID', t.externalId || '—'],
    ['Last contact', t.activityVia
      ? `${t.lastContact} (${daysSince(t.lastContact)}d) on child #${t.activityVia} · own: ${t.ownLastContact || 'never'}`
      : t.lastContact ? `${t.lastContact} (${daysSince(t.lastContact)}d)` : 'Never'],
    ['Complexity', t.complexity],
    ['Contact', t.contact || '—'], ['Account rep', t.rep || '—'],
    ['Target close', t.targetClose || '—'], ['Created', t.createdAt.slice(0, 10)],
    ['Weekly update', t.updateCadence || `default`],
    ['Deactivated', t.deactivated ? `Yes — since ${t.deactivatedAt.slice(0, 10)}` : 'No'],
  ];
  const crumbs = breadcrumbs([
    { href: '/accounts', label: 'Accounts' },
    ...(ctx.customer ? [{ href: `/customer/${ctx.customer.id}`, label: ctx.customer.name }] : [{ label: t.customer }]),
    ...(ctx.opp ? [{ href: `/opp/${ctx.opp.id}`, label: ctx.opp.name }] : []),
    ...(ctx.parent ? [{ href: `/trr/${ctx.parent.id}`, label: `${trId(ctx.parent)} ${ctx.parent.title}` }] : []),
    { label: `${trId(t)} ${t.title}` },
  ]);
  const isParent = ctx.children.length > 0;
  const intCard = (i: Interaction) => interactionCard(i, {
    aiEnabled: s.aiEnabled,
    owner: i.trrId !== t.id ? ctx.owners.get(i.trrId) : undefined,
    linkedTo: (ctx.links.get(i.id) ?? []).filter(id => id !== t.id).map(id => ctx.owners.get(id)).filter((x): x is Trr => !!x),
  });
  return page(`${trId(t)} ${t.customer}`, '/', `
  ${crumbs}
  <div class="card" style="border-left:3px solid ${RAG_COLOR[r]}">
    <div class="row-between wrap">
      <div>
        <div class="row">
          ${ragDot(r, t, s)}
          <span class="trr-num">#${t.num}</span>
          ${trIdBadge(t)}
          <strong class="lg">${esc(t.customer)}</strong>
          ${badge(`${RAG_SYMBOL[r]} ${RAG_LABEL[r]}`, `rag-b-${r}`)}
          ${statusBadge(t.status)}
          ${priorityBadge(t.priority)}
          ${isParent ? badge(`parent · ${ctx.children.length} child${ctx.children.length === 1 ? '' : 'ren'}`, 'cx') : ''}
          ${ctx.parent ? `<a class="badge cx" href="/trr/${esc(ctx.parent.id)}">child of #${ctx.parent.num}</a>` : ''}
        </div>
        <div class="muted">${esc(t.title)}</div>
        ${t.valueThemes.length ? `<div class="theme-row">${t.valueThemes.map(v => badge(v, 'theme')).join('')}</div>` : ''}
        ${archiveCountdown(t, s)}
      </div>
      <div class="row wrap">
        <a class="btn" href="#quicklog" onclick="document.getElementById('quicklog').open=true">+ Log</a>
        ${t.parentId ? '' : `<a class="btn btn-outline" href="/trr/new?parent=${esc(t.id)}">+ Child TR</a>`}
        <a class="btn btn-outline" href="/trr/${esc(t.id)}/edit">✏️ Edit</a>
        <form method="post" action="/trr/${esc(t.id)}/toggle-active" style="display:inline">
          <button class="btn btn-outline ${t.deactivated ? '' : 'danger'}" type="submit">
            ${t.deactivated ? 'Reactivate' : 'Deactivate'}</button>
        </form>
      </div>
    </div>
  </div>

  <div class="detail-layout">
    <div class="detail-main">
      <details class="card" id="quicklog">
        <summary><strong>+ Log interaction</strong></summary>
        ${interactionForm(t.id, undefined, ctx.related, [], { bare: true })}
      </details>
      <div class="row-between wrap">
        <h3>Interactions (${ints.length})</h3>
        ${isParent ? `<div class="segmented" role="group" aria-label="Timeline scope">
          <a class="seg ${ctx.includeChildren ? 'active' : ''}" href="/trr/${esc(t.id)}">With children</a>
          <a class="seg ${ctx.includeChildren ? '' : 'active'}" href="/trr/${esc(t.id)}?own=1">This TR only</a></div>` : ''}
      </div>
      ${ints.length === 0 ? '<div class="card muted center">No interactions yet.</div>' : ''}
      ${ints.map(intCard).join('')}
    </div>

    <aside class="detail-side">
      ${quickControls(t, s)}
      ${isParent || !t.parentId ? childrenCard(t, ctx.children, s) : ''}
      ${updatesCard(t, ctx, s.aiEnabled)}
      ${isParent ? summaryPanel('family', t.id, ctx.summaries.family, s.aiEnabled) : ''}
      ${summaryPanel('trr', t.id, ctx.summaries.trr, s.aiEnabled, { open: !isParent })}
      <div class="card">
        <h3>Details</h3>
        <div class="meta-grid side-meta">
          ${meta.map(([l, v]) => `<div><span class="field-label">${esc(l)}</span><div>${esc(v)}</div></div>`).join('')}
        </div>
        ${t.description ? `<hr><div class="muted small">${esc(t.description)}</div>` : ''}
      </div>

      ${digest && !ctx.summaries.trr.length ? `
      <details class="card">
        <summary><strong>🧠 Earlier catch-up digest</strong></summary>
        ${digestBlock(digest, { cached: true })}
      </details>` : ''}

      <details class="card">
        <summary><strong>📜 History</strong> <span class="small muted2">(${history.length})</span></summary>
        ${historyTimeline(history)}
      </details>

      <div class="card">
        <form method="post" action="/trr/${esc(t.id)}/delete" onsubmit="return confirm('Delete this TR and all its interactions?${isParent ? ' Its child TRs are kept and become standalone.' : ''} This cannot be undone.')">
          <button class="btn btn-outline danger btn-sm" type="submit">Delete TR</button>
        </form>
      </div>
    </aside>
  </div>
  `);
}

export function newTrrPage(s: Settings, t: Partial<Trr>, ctx: TrrFormCtx): string {
  const parent = t.parentId ? ` — child of ${esc(t.customer ?? '')}` : '';
  return page('New TR', '/', `<h2>New TR${parent}</h2>${trrForm(t, '/trr', 'Create TR', s, ctx)}`);
}

export function editTrrPage(t: Trr, s: Settings, ctx: TrrFormCtx, draft?: Partial<Trr>): string {
  return page(`Edit — ${t.customer}`, '/', `<h2>Edit TR</h2>${trrForm({ ...t, ...draft }, `/trr/${esc(t.id)}`, 'Save', s, ctx)}`);
}

export function logInteractionPage(t: Trr, related: Trr[] = []): string {
  return page(`Log — ${t.customer}`, '/', `
    <h2>Log interaction — ${esc(t.customer)}</h2>${interactionForm(t.id, undefined, related)}`);
}

export function editInteractionPage(t: Trr, i: Interaction, related: Trr[] = [], linked: string[] = []): string {
  return page(`Edit interaction — ${t.customer}`, '/', `
    <h2>Edit interaction — ${esc(t.customer)}</h2>${interactionForm(t.id, i, related, linked)}`);
}

// --- Accounts: Customer -> Opportunity -> TR tree ------------------------------

function treeRows(list: Trr[], kids: Map<string, Trr[]>, s: Settings): string {
  const ids = new Set(list.map(t => t.id));
  const row = (t: Trr, child: boolean) => {
    const r = rag(t.lastContact, s);
    const closed = s.closedStatuses.includes(t.status);
    return `<a class="tree-row ${child ? 'tree-child' : ''} ${closed || t.deactivated ? 'tree-closed' : ''}" href="/trr/${esc(t.id)}">
      <span class="rag-glyph rag-g-${r}" aria-label="${esc(RAG_LABEL[r])}">${RAG_SYMBOL[r]}</span>
      ${child ? '<span class="muted3" aria-hidden="true">↳</span>' : ''}
      <span class="trr-num">#${t.num}</span>${trIdBadge(t)}
      <span class="tree-title">${esc(t.title)}</span>${statusBadge(t.status)}
      <span class="small muted2 tree-meta">${t.lastContact ? `${daysSince(t.lastContact)}d` : '—'}</span></a>`;
  };
  return list.filter(t => !t.parentId || !ids.has(t.parentId))
    .sort((a, b) => a.num - b.num)
    .map(t => row(t, false) + (kids.get(t.id) ?? []).filter(k => ids.has(k.id)).map(k => row(k, true)).join(''))
    .join('');
}

export function accountsPage(customers: Customer[], trrs: Trr[], opps: Opportunity[], s: Settings): string {
  const kids = new Map<string, Trr[]>();
  for (const t of trrs) if (t.parentId) { if (!kids.has(t.parentId)) kids.set(t.parentId, []); kids.get(t.parentId)!.push(t); }
  return page('Accounts', '/accounts', `
  <div class="row-between wrap">
    <h2>Accounts (${customers.length})</h2>
    <form class="row" method="post" action="/customers"><input name="name" placeholder="New customer name" required style="width:220px"><button class="btn btn-sm" type="submit">+ Customer</button></form>
  </div>
  <div x-data="{q:''}">
    <input class="list-filter" x-model="q" placeholder="🔍 Filter customers, opportunities, TR IDs…">
    ${customers.length === 0 ? '<div class="card muted center">No customers yet — creating a TR creates its customer.</div>' : ''}
    <div class="acct-grid">
    ${customers.map(c => {
      const ct = trrs.filter(t => t.customerId === c.id);
      const open = ct.filter(t => !s.closedStatuses.includes(t.status) && !t.deactivated);
      const co = opps.filter(o => o.customerId === c.id);
      const wr = worstRag(ct, s);
      const txt = `${c.name} ${co.map(o => o.name).join(' ')} ${ct.map(t => `${t.externalId} ${t.title}`).join(' ')}`.toLowerCase();
      return `
      <div class="card acct-card" data-txt="${esc(txt)}" x-show="!q || $el.dataset.txt.includes(q.toLowerCase())">
        <div class="row-between">
          <a href="/customer/${esc(c.id)}"><strong class="lg">${esc(c.name)}</strong></a>
          <span class="small muted2">${wr ? `<span class="rag-g-${wr}">${RAG_SYMBOL[wr]}</span> ` : ''}${open.length}/${ct.length} open · ${co.length} opp${co.length === 1 ? '' : 's'}</span>
        </div>
        ${co.map(o => {
          const ot = ct.filter(t => t.opportunityId === o.id && !s.closedStatuses.includes(t.status));
          return `<div class="tree-opp"><a href="/opp/${esc(o.id)}">◇ ${esc(o.name)}</a>${o.stage ? ` <span class="small muted2">${esc(o.stage)}</span>` : ''}</div>${treeRows(ot, kids, s)}`;
        }).join('')}
        ${(() => {
          const un = ct.filter(t => !t.opportunityId && !s.closedStatuses.includes(t.status));
          return un.length ? `${co.length ? '<div class="tree-opp muted2">No opportunity</div>' : ''}${treeRows(un, kids, s)}` : '';
        })()}
        ${ct.length - ct.filter(t => !s.closedStatuses.includes(t.status)).length
          ? `<a class="small muted2" href="/customer/${esc(c.id)}">+ ${ct.length - ct.filter(t => !s.closedStatuses.includes(t.status)).length} closed</a>` : ''}
      </div>`;
    }).join('')}
    </div>
  </div>`);
}

export function customerPage(c: Customer, all: Customer[], opps: Opportunity[], trrs: Trr[], s: Settings, versions: ScopeSummary[]): string {
  const kids = new Map<string, Trr[]>();
  for (const t of trrs) if (t.parentId) { if (!kids.has(t.parentId)) kids.set(t.parentId, []); kids.get(t.parentId)!.push(t); }
  const un = trrs.filter(t => !t.opportunityId);
  return page(c.name, '/accounts', `
  ${breadcrumbs([{ href: '/accounts', label: 'Accounts' }, { label: c.name }])}
  <div class="card" x-data="{edit:false}">
    <div class="row-between wrap">
      <div x-show="!edit"><strong class="lg">${esc(c.name)}</strong> <span class="small muted2">${trrs.length} TR${trrs.length === 1 ? '' : 's'} · ${opps.length} opportunit${opps.length === 1 ? 'y' : 'ies'}</span>
        ${c.notes ? `<div class="small muted">${esc(c.notes)}</div>` : ''}</div>
      <form x-show="edit" x-cloak method="post" action="/customer/${esc(c.id)}" class="stack" style="flex:1">
        ${field('Name', `<input name="name" value="${esc(c.name)}" required>`)}
        ${field('Notes', `<textarea name="notes" rows="2">${esc(c.notes)}</textarea>`)}
        <div class="row"><button class="btn btn-sm" type="submit">Save</button><button class="btn btn-outline btn-sm" type="button" @click="edit=false">Cancel</button></div>
      </form>
      <div class="row" x-show="!edit">
        <a class="btn btn-sm" href="/trr/new?customer=${esc(c.id)}">+ TR</a>
        <button class="btn btn-outline btn-sm" @click="edit=true">✏️ Rename / notes</button>
      </div>
    </div>
  </div>

  <div class="detail-layout">
    <div class="detail-main">
      ${opps.map(o => {
        const ot = trrs.filter(t => t.opportunityId === o.id);
        return `<div class="card">
          <div class="row-between wrap"><a href="/opp/${esc(o.id)}"><strong>◇ ${esc(o.name)}</strong></a>
            <span class="small muted2">${esc([o.stage, o.rep, o.closeDate && `close ${o.closeDate}`].filter(Boolean).join(' · '))}</span></div>
          ${ot.length ? treeRows(ot, kids, s) : '<div class="small muted2">No TRs in this opportunity yet.</div>'}
          <div class="row"><a class="btn btn-outline btn-sm" href="/trr/new?opp=${esc(o.id)}">+ TR in this opportunity</a></div>
        </div>`;
      }).join('')}
      ${un.length ? `<div class="card"><strong class="muted2">No opportunity</strong>${treeRows(un, kids, s)}</div>` : ''}
      <form class="card stack" method="post" action="/customer/${esc(c.id)}/opps">
        <strong>+ Opportunity</strong>
        <div class="grid2">
          ${field('Name *', '<input name="name" required>')}
          ${field('Stage', '<input name="stage">')}
          ${field('Rep', '<input name="rep">')}
          ${field('Close date', '<input type="date" name="closeDate">')}
        </div>
        <div><button class="btn btn-sm" type="submit">Add opportunity</button></div>
      </form>
    </div>
    <aside class="detail-side">
      ${summaryPanel('customer', c.id, versions, s.aiEnabled, { open: true })}
      <div class="card">
        <h3>Merge</h3>
        <form method="post" action="/customer/${esc(c.id)}/merge" class="row" onsubmit="return confirm('Move every TR and opportunity of ${esc(c.name)} into the selected customer, then remove ${esc(c.name)}?')">
          <select name="into" required><option value="">Merge into…</option>${all.filter(x => x.id !== c.id).map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>
          <button class="btn btn-outline btn-sm" type="submit">Merge</button>
        </form>
        <div class="small muted2">For duplicates left over from free-text names (“Acme” vs “Acme Corp”).</div>
        ${trrs.length === 0 ? `<form method="post" action="/customer/${esc(c.id)}/delete" onsubmit="return confirm('Delete this customer?')" style="margin-top:8px"><button class="btn btn-outline danger btn-sm" type="submit">Delete customer</button></form>` : ''}
      </div>
    </aside>
  </div>`);
}

export function oppPage(o: Opportunity, c: Customer, trrs: Trr[], s: Settings, versions: ScopeSummary[]): string {
  const kids = new Map<string, Trr[]>();
  for (const t of trrs) if (t.parentId) { if (!kids.has(t.parentId)) kids.set(t.parentId, []); kids.get(t.parentId)!.push(t); }
  return page(o.name, '/accounts', `
  ${breadcrumbs([{ href: '/accounts', label: 'Accounts' }, { href: `/customer/${c.id}`, label: c.name }, { label: o.name }])}
  <div class="detail-layout">
    <div class="detail-main">
      <div class="card">
        <div class="row-between wrap"><strong class="lg">◇ ${esc(o.name)}</strong><a class="btn btn-sm" href="/trr/new?opp=${esc(o.id)}">+ TR</a></div>
        ${trrs.length ? treeRows(trrs, kids, s) : '<div class="small muted2">No TRs yet.</div>'}
      </div>
      <form class="card stack" method="post" action="/opp/${esc(o.id)}">
        <strong>Opportunity details</strong>
        <div class="grid2">
          ${field('Name *', `<input name="name" value="${esc(o.name)}" required>`)}
          ${field('Stage', `<input name="stage" value="${esc(o.stage)}">`)}
          ${field('Rep', `<input name="rep" value="${esc(o.rep)}">`)}
          ${field('Close date', `<input type="date" name="closeDate" value="${esc(o.closeDate)}">`)}
        </div>
        ${field('Notes', `<textarea name="notes" rows="3">${esc(o.notes)}</textarea>`)}
        <div class="row"><button class="btn btn-sm" type="submit">Save</button></div>
      </form>
    </div>
    <aside class="detail-side">
      ${summaryPanel('opportunity', o.id, versions, s.aiEnabled, { open: true })}
      <div class="card">
        <form method="post" action="/opp/${esc(o.id)}/delete" onsubmit="return confirm('Delete this opportunity? Its TRs are kept and become unassigned.')">
          <button class="btn btn-outline danger btn-sm" type="submit">Delete opportunity</button>
        </form>
      </div>
    </aside>
  </div>`);
}

// --- Update Desk -------------------------------------------------------------------

export function deskSummaryFragment(desk: Desk, counts: Record<string, number>, aggregate: string): string {
  const tile = (n: number, label: string, cls: string) =>
    `<div class="tile"><div class="tile-value ${cls}">${n}</div><div class="tile-label">${label}</div></div>`;
  const needs = counts.overdue! + counts.due!;
  return `
  <div id="desk-summary" hx-get="/fragments/updates/summary?cycle=${esc(desk.cycleDue)}" hx-trigger="desk-changed from:body" hx-swap="outerHTML">
    <div class="tiles">
      ${tile(counts.overdue!, `${DESK_STATE.overdue.sym} Overdue`, 'ds-overdue')}
      ${tile(counts.due!, `${DESK_STATE.due.sym} Due`, 'ds-due')}
      ${tile(counts.draft!, `${DESK_STATE.draft.sym} Drafts ready`, 'ds-draft')}
      ${tile(counts.posted!, `${DESK_STATE.posted.sym} Posted`, 'ds-posted')}
      ${tile(counts['not-due']!, `${DESK_STATE['not-due'].sym} Not due`, 'ds-notdue')}
      ${tile(counts.quiet!, 'No new activity', '')}
    </div>
    <details class="card" x-data ${needs === 0 && counts.draft! + counts.posted! > 0 ? 'open' : ''}>
      <summary class="row-between"><strong>📋 All updates — one block to paste</strong>
        <button class="btn btn-sm" @click.prevent="navigator.clipboard.writeText($refs.agg.innerText).then(()=>{$el.textContent='✓ copied'; setTimeout(()=>$el.textContent='📋 copy all',1200)})">📋 copy all</button></summary>
      <pre class="report-pre" x-ref="agg">${esc(aggregate)}</pre>
    </details>
  </div>`;
}

export function updateDesk(desk: Desk, s: Settings, counts: Record<string, number>, aggregate: string, filter: string): string {
  const today = localDay();
  const until = daysBetween(today, desk.cycleDue);
  const when = until === 0 ? 'today' : until > 0 ? `in ${until} day${until === 1 ? '' : 's'}` : `${-until} day${until === -1 ? '' : 's'} ago`;
  const show = (r: DeskRow) =>
    filter === 'needs' ? (r.state === 'due' || r.state === 'overdue' || r.state === 'draft') :
    filter === 'posted' ? r.state === 'posted' :
    filter === 'quiet' ? r.state !== 'posted' && r.entries.length === 0 : true;
  const rows = desk.rows.filter(show);
  // group: customer -> rows (children already sit right after their parent family)
  const groups = new Map<string, DeskRow[]>();
  for (const r of rows) {
    const k = r.trr.customer;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  // per-parent completeness: "3/4 children posted"
  const famStats = new Map<string, { parent: Trr; n: number; done: number }>();
  for (const r of desk.rows) if (r.parent) {
    const f = famStats.get(r.parent.id) ?? { parent: r.parent, n: 0, done: 0 };
    f.n++;
    if (r.state === 'posted' || r.state === 'not-due') f.done++;
    famStats.set(r.parent.id, f);
  }
  const fbtn = (k: string, label: string) => `<a class="seg ${filter === k ? 'active' : ''}" href="/updates?cycle=${esc(desk.cycleDue)}${k === 'all' ? '' : `&f=${k}`}">${label}</a>`;
  const seenParent = new Set<string>();
  return page('Update Desk', '/updates', `
  <div class="row-between wrap">
    <div>
      <h2 style="margin-bottom:2px">Update Desk — cycle due ${esc(shortDay(desk.cycleDue))} <span class="muted2 small">(${esc(desk.cycleDue)}, ${when})</span></h2>
      <div class="small muted2">Every TR ID owes an update each ${esc(WEEKDAYS[s.updateDueWeekday]!)}. The window is everything logged since that TR's last <em>posted</em> update, so a missed week rolls forward instead of getting lost.</div>
    </div>
    <div class="row">
      <a class="btn btn-outline btn-sm" href="/updates?cycle=${addDays(desk.cycleDue, -7)}">← previous cycle</a>
      ${desk.current ? '' : `<a class="btn btn-outline btn-sm" href="/updates">current cycle</a>`}
      ${!desk.current && desk.cycleDue < localDay() ? `<a class="btn btn-outline btn-sm" href="/updates?cycle=${addDays(desk.cycleDue, 7)}">next cycle →</a>` : ''}
    </div>
  </div>
  ${desk.current ? '' : `<div class="card banner small">Viewing a past cycle: rows show what was posted or drafted then. Missing rows are TRs that owed an update and never got one.</div>`}
  ${deskSummaryFragment(desk, counts, aggregate)}
  <div class="row-between wrap">
    <div class="segmented" role="group" aria-label="Show">
      ${fbtn('all', `All (${desk.rows.length})`)}${fbtn('needs', 'Needs action')}${fbtn('quiet', 'No new activity')}${fbtn('posted', 'Posted')}
    </div>
    ${desk.current ? `<div class="row">
      ${s.aiEnabled ? `<button class="btn btn-sm" hx-post="/updates/bulk?cycle=${esc(desk.cycleDue)}" hx-target="#bulk-out" hx-swap="innerHTML">🤖 Draft all missing</button>
      ${counts.stale ? `<button class="btn btn-outline btn-sm" hx-post="/updates/bulk?cycle=${esc(desk.cycleDue)}&stale=1" hx-target="#bulk-out" hx-swap="innerHTML">↻ Also redraft ${counts.stale} stale</button>` : ''}` : ''}
      ${counts.draft ? `<form method="post" action="/updates/post-all?cycle=${esc(desk.cycleDue)}" onsubmit="return confirm('Mark all ${counts.draft} drafts as posted? Do this after pasting them into the other system.')"><button class="btn btn-outline btn-sm btn-post" type="submit">✓ Mark all ${counts.draft} drafts posted</button></form>` : ''}
    </div>` : ''}
  </div>
  <div id="bulk-out"></div>
  ${rows.length === 0 ? '<div class="card muted center">Nothing here for this filter.</div>' : ''}
  ${[...groups.entries()].map(([cust, list]) => `
    <section class="desk-group">
      <h3 class="desk-cust">${esc(cust)}</h3>
      ${list.map(r => {
        let head = '';
        if (r.parent && !seenParent.has(r.parent.id)) {
          seenParent.add(r.parent.id);
          const f = famStats.get(r.parent.id)!;
          head = `<div class="desk-parent"><a href="/trr/${esc(r.parent.id)}"><span class="trr-num">#${r.parent.num}</span> ${trIdBadge(r.parent)} ${esc(r.parent.title)}</a>
            <span class="small ${f.done === f.n ? 'ds-posted' : 'warn'}">${f.done}/${f.n} children covered</span></div>`;
        }
        return head + updateRowCard(r, desk.cycleDue, s.aiEnabled && desk.current);
      }).join('')}
    </section>`).join('')}
  `);
}

// --- Archive ----------------------------------------------------------------

export function archive(trrs: Trr[], ints: IntsByTrr): string {
  return page('Archive', '/archive', `
  <h2>Closed / Archived (${trrs.length})</h2>
  <div x-data="{q:''}">
    <input class="list-filter" x-model="q" placeholder="🔍 Filter by #, customer, title…">
    ${trrs.length === 0 ? '<div class="card muted center">No closed TRs.</div>' : ''}
    ${trrs.map(t => `
    <a class="card trr-card" href="/trr/${esc(t.id)}"
       data-txt="${esc(`#${t.num} ${t.customer} ${t.title} ${t.status}`.toLowerCase())}"
       x-show="!q || $el.dataset.txt.includes(q.toLowerCase())">
      <div class="trr-card-main">
        <div class="trr-card-head"><span class="trr-num">#${t.num}</span><strong>${esc(t.customer)}</strong> ${statusBadge(t.status)} ${t.outcome ? badge(t.outcome, 'role') : ''}</div>
        <div class="muted">${esc(t.title)}</div>
      </div>
      <div class="trr-card-side"><div class="small muted2">${esc(t.complexity)} · ${esc(t.priority)} · ${(ints.get(t.id) ?? []).length} logs</div></div>
    </a>`).join('')}
  </div>
  `);
}

// --- Stats (with in-app digest panel — the feature v1 couldn't ship) --------

export function stats(trrs: Trr[], allInts: Interaction[], s: Settings): string {
  const act = trrs.filter(t => !s.closedStatuses.includes(t.status));
  const clo = trrs.filter(t => s.closedStatuses.includes(t.status));
  const live = act.filter(t => !t.deactivated);
  const stalled = live.filter(t => rag(t.lastContact, s) === 'red').length;
  const deact = trrs.filter(t => t.deactivated).length;
  const archDue = trrs.filter(t => t.deactivated && t.deactivatedAt && daysSince(t.deactivatedAt) >= s.archiveDays).length;

  const countBy = (arr: Trr[], key: keyof Trr, domain: readonly string[]) =>
    domain.map(d => [d, arr.filter(t => String(t[key]) === d).length] as const);

  const roleCounts = countBy(trrs, 'myRole', s.roles);
  const themeCounts = new Map<string, number>();
  for (const t of trrs) for (const v of t.valueThemes) themeCounts.set(v, (themeCounts.get(v) ?? 0) + 1);

  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  return page('Stats', '/stats', `
  <div class="tiles">
    ${statTile(live.length, 'Active')}
    ${statTile(clo.length, 'Closed')}
    ${statTile(allInts.length, 'Interactions')}
    ${statTile(stalled, 'Stalled', 'var(--red)')}
    ${statTile(deact, 'Deactivated', 'var(--muted2)')}
    ${statTile(archDue, 'Archive due', 'var(--yellow)')}
  </div>

  <div class="card">
    <div class="row-between wrap">
      <strong>📊 Period digest</strong>
      <span class="small muted2">deterministic stats + optional local-model narrative</span>
    </div>
    <form class="row wrap" hx-get="/fragments/period-digest" hx-target="#pd-out" hx-swap="innerHTML" hx-indicator="#pd-ind">
      ${field('From', `<input type="date" name="from" value="${monthAgo}">`)}
      ${field('To', `<input type="date" name="to" value="${new Date().toISOString().slice(0, 10)}">`)}
      ${s.aiEnabled ? `<label class="check"><input type="checkbox" name="draft" value="1"> AI narrative draft</label>` : ''}
      <button class="btn" type="submit">Run</button>
    </form>
    <span id="pd-ind" class="htmx-indicator small muted2">⏳ computing…</span>
    <div id="pd-out"></div>
  </div>

  <div class="stat-cols">
    <div class="card"><h3>By complexity</h3>
      ${countBy(live, 'complexity', COMPLEXITIES).map(([l, c]) => hbar(l, c, live.length, 'var(--blue)')).join('')}</div>
    <div class="card"><h3>By priority</h3>
      ${countBy(live, 'priority', PRIORITIES).map(([l, c]) => hbar(l, c, live.length,
        l === 'Critical' ? 'var(--red)' : l === 'High' ? 'var(--yellow)' : 'var(--teal)')).join('')}</div>
    <div class="card"><h3>By status</h3>
      ${[...new Set([...s.statuses, ...trrs.map(t => t.status)])].map(st => [st, trrs.filter(t => t.status === st).length] as const)
        .filter(([, c]) => c > 0)
        .map(([l, c]) => hbar(l, c, trrs.length,
          l === 'Closed Won' ? 'var(--green)' : l === 'Closed Lost' ? 'var(--red)' : l === 'Archived' ? 'var(--muted2)' : 'var(--blue)')).join('')}</div>
    <div class="card"><h3>By my role</h3>
      ${roleCounts.map(([l, c]) => hbar(l, c, trrs.length, 'var(--purple)')).join('')}</div>
    <div class="card"><h3>By value theme</h3>
      ${[...themeCounts.entries()].sort((a, b) => b[1] - a[1])
        .map(([l, c]) => hbar(l, c, trrs.length, 'var(--teal)')).join('')}</div>
  </div>
  `);
}

export function periodDigestFragment(d: PeriodDigest): string {
  const kv = (o: Record<string, number>) =>
    Object.entries(o).map(([k, v]) => `${esc(k)}: <strong>${v}</strong>`).join(' · ') || '—';
  return `
  <div class="digest-out">
    <div class="tiles">
      ${statTile(d.totals.engagements, 'Engagements')}
      ${statTile(d.totals.interactions, 'Interactions')}
      ${statTile(d.totals.meetings, 'Meetings')}
      ${statTile(d.totals.officialUpdates, 'Official updates')}
      ${statTile(d.closedWon.length, 'Closed won', 'var(--green)')}
      ${statTile(d.closedLost.length, 'Closed lost', 'var(--red)')}
    </div>
    <div class="small"><span class="field-label">By status</span> ${kv(d.byStatus)}</div>
    <div class="small"><span class="field-label">By role</span> ${kv(d.byRole)}</div>
    <div class="small"><span class="field-label">Theme coverage</span> ${kv(d.themeCoverage)}</div>
    ${d.closedWon.length ? `<div class="small"><span class="field-label">Won</span> ${d.closedWon.map(esc).join(', ')}</div>` : ''}
    <details ${d.perTrr.length <= 8 ? 'open' : ''}><summary class="small muted">Per-engagement (${d.perTrr.length})</summary>
      <table class="table"><thead><tr><th>Customer</th><th>Title</th><th>Status</th><th>Role</th><th>Logs</th><th>Window</th></tr></thead>
      <tbody>${d.perTrr.map(p => `<tr>
        <td>${esc(p.customer)}</td><td class="muted">${esc(p.title)}</td><td>${esc(p.status)}</td>
        <td>${esc(p.myRole || '—')}</td><td>${p.interactions}</td>
        <td class="small muted2">${esc(p.first ?? '')} → ${esc(p.last ?? '')}</td></tr>`).join('')}
      </tbody></table>
    </details>
    ${d.official.length ? `
    <details><summary class="small muted">Official record (${d.official.length})</summary>
      ${d.official.map(o => `<div class="card small"><strong>${esc(o.customer)}</strong> <span class="muted2">${esc(o.date)} · ${esc(o.type)}</span><br>${esc(o.note)}</div>`).join('')}
    </details>` : ''}
    ${d.narrative ? `<div class="ai-block ai-exec"><span class="field-label">Narrative draft (${esc(d.narrativeModel ?? 'local model')})</span><div class="ai-text">${md2html(d.narrative)}</div></div>` : ''}
    ${d.draftNote ? `<div class="small warn">⚠ ${esc(d.draftNote)}</div>` : ''}
    ${d.draftError ? `<div class="small danger">Narrative draft unavailable: ${esc(d.draftError)}</div>` : ''}
    ${d.savedReportId ? `<div class="small muted2">💾 Saved to <a class="hl" href="/reports/p/${d.savedReportId}">Reports</a> — it'll be there when you come back.</div>` : ''}
  </div>`;
}

// --- Reports ----------------------------------------------------------------

export function reports(weeklyText: string, periodReports: import('../db/repo.js').PeriodReportMeta[]): string {
  return page('Reports', '/reports', `
  <div class="card banner">
    <div class="row-between wrap">
      <div><strong>🗓 Weekly updates moved to the Update Desk</strong>
        <div class="small muted2">Per-TR updates since the last posted one, due-day tracking, one-block copy/paste, and who is missing an update.</div></div>
      <a class="btn" href="/updates">Open Update Desk →</a>
    </div>
  </div>
  <details class="card" x-data>
    <summary class="row-between wrap">
      <strong>📋 Activity snapshot (last 7 days)</strong>
      <button class="btn btn-outline btn-sm" @click.prevent="navigator.clipboard.writeText($refs.w.innerText).then(()=>{$el.textContent='✓ copied'; setTimeout(()=>$el.textContent='📋 copy',1200)})">📋 copy</button>
    </summary>
    <pre class="report-pre" x-ref="w">${esc(weeklyText)}</pre>
  </details>

  <h3>Saved period digests (${periodReports.length})</h3>
  <div class="small muted2" style="margin-bottom:8px">Every period-digest narrative run (Stats page) is saved here automatically.</div>
  ${periodReports.length === 0 ? '<div class="card muted center">None yet — run a period digest with “AI narrative draft” on the Stats page.</div>' : ''}
  ${periodReports.map(r => `
  <div class="card trr-card">
    <a class="trr-card-main" href="/reports/p/${r.id}">
      <div class="trr-card-head"><strong>${esc(r.fromDate || 'start')} → ${esc(r.toDate || 'now')}</strong></div>
      <div class="small muted2">generated ${esc(r.generatedAt.slice(0, 16).replace('T', ' '))} · ${esc(r.model)} · ${r.narrativeChars} chars</div>
    </a>
    <div class="trr-card-side">
      <form method="post" action="/reports/p/${r.id}/delete" onsubmit="return confirm('Delete this saved report?')">
        <button class="btn btn-outline btn-sm danger" type="submit">🗑️</button>
      </form>
    </div>
  </div>`).join('')}
  <div class="small muted2">Per-engagement digests live under <a href="/digests" class="hl">Digests</a>.</div>
  `);
}

export function periodReportPage(meta: import('../db/repo.js').PeriodReportMeta, d: PeriodDigest): string {
  return page(`Report ${meta.fromDate || 'start'} → ${meta.toDate || 'now'}`, '/reports', `
  <a class="btn btn-outline btn-sm" href="/reports">← Reports</a>
  <div class="card">
    <div class="row-between wrap">
      <strong>📊 Period digest — ${esc(meta.fromDate || 'start')} → ${esc(meta.toDate || 'now')}</strong>
      <span class="small muted2">generated ${esc(meta.generatedAt.slice(0, 16).replace('T', ' '))} · ${esc(meta.model)}</span>
    </div>
    ${periodDigestFragment(d)}
  </div>
  `);
}

// --- Digests (own page) -----------------------------------------------------

export function digests(stored: StoredDigest[]): string {
  return page('Digests', '/digests', `
  <div class="row-between wrap">
    <h2>Engagement digests (${stored.length})</h2>
    <span class="small muted2">Generated from a TR page, or automatically when a TR is archived. Cached until regenerated.</span>
  </div>
  ${stored.length === 0 ? '<div class="card muted center">None yet — open a TR and hit “Generate digest”, or archive a TR (auto-digest).</div>' : ''}
  <div class="digest-grid">
    ${stored.map(d => digestBlock(d, { cached: true })).join('')}
  </div>
  `);
}

// --- Review (question-driven, scoped, persisted) ----------------------------

import type { ReviewMeta, ReviewRow } from '../db/repo.js';
import type { ReviewPlan, ReviewResult } from '../services/review.js';
import type { ReviewJob } from '../services/reviewJob.js';

export function reviewPage(trrs: Trr[], saved: ReviewMeta[], s: Settings): string {
  const sixMonthsAgo = new Date(Date.now() - 182 * 86_400_000).toISOString().slice(0, 10);
  const savedList = `
  <h3>Saved reviews (${saved.length})</h3>
  ${saved.length === 0 ? '<div class="card muted center">None yet.</div>' : ''}
  ${saved.map(r => `
  <div class="card trr-card">
    <a class="trr-card-main" href="/review/${r.id}">
      <div class="trr-card-head"><strong>${esc(r.firstQuestion.slice(0, 80))}${r.firstQuestion.length > 80 ? '…' : ''}</strong></div>
      <div class="small muted2">${r.questionCount} question${r.questionCount === 1 ? '' : 's'} · ${esc(r.scopeSummary)} · ${esc(r.generatedAt.slice(0, 16).replace('T', ' '))} · ${esc(r.model)}</div>
    </a>
    <div class="trr-card-side">
      <form method="post" action="/review/${r.id}/delete" onsubmit="return confirm('Delete this saved review?')">
        <button class="btn btn-outline btn-sm danger" type="submit">🗑️</button>
      </form>
    </div>
  </div>`).join('')}`;

  if (!s.aiEnabled) {
    return page('Review', '/review', `
    <h2>Review engine</h2>
    <div class="card"><div class="muted">🔌 AI features are switched off in <a class="hl" href="/settings">Settings</a>.
    The review engine needs the local model to answer questions — saved reviews below remain readable.</div></div>
    ${savedList}`);
  }

  return page('Review', '/review', `
  <h2>Review engine</h2>
  <div class="small muted" style="margin-bottom:10px">Ask up to 10 questions of your engagement record — self-evals, 6-month reviews, retros.
  Scope what the model sees; deterministic facts and the tagged official record anchor every answer. Runs are saved below.</div>

  <!-- Standalone targets so the set controls can sit beside the questions box
       without nesting forms inside the review form. -->
  <form id="setsave" method="post" action="/review/sets"></form>
  <form id="setdel" method="post" action="/review/sets/delete"><input type="hidden" name="name" id="qs-del"></form>

  <form class="stack" hx-post="/fragments/review" hx-target="#rv-out" hx-swap="innerHTML" hx-indicator="#rv-ind">
    <div class="card">
      ${field('Questions (one per line, up to 10)', `<textarea name="questions" rows="7" placeholder="What outcomes did I achieve relative to my goals?
Where could I have improved?
What could I do better next half?
Which core value did I best demonstrate, with evidence?
What should I prioritize learning next?"></textarea>`)}
      <script type="application/json" id="qsets">${JSON.stringify(s.questionSets).replace(/</g, '\\u003c')}</script>
      <div class="row wrap" style="gap:8px;align-items:center">
        <select @change="if($event.target.value!==''){ document.querySelector('textarea[name=questions]').value = JSON.parse(document.getElementById('qsets').textContent)[$event.target.value].questions.join(String.fromCharCode(10)); $event.target.value='' }">
          <option value="">↓ Load a question set…</option>
          ${s.questionSets.map((q, i) => `<option value="${i}">${esc(q.name)} (${q.questions.length})</option>`).join('')}
        </select>
        <input form="setsave" name="name" placeholder="Save these questions as…" style="max-width:220px" required>
        <button form="setsave" type="submit" class="btn btn-outline btn-sm"
          onclick="document.getElementById('qs-hidden').value=document.querySelector('textarea[name=questions]').value">💾 save set</button>
        <input form="setsave" type="hidden" name="questions" id="qs-hidden">
      </div>
      ${s.questionSets.length ? `<div class="row wrap" style="gap:6px;align-items:center">
        <span class="small muted2">Delete a set:</span>
        ${s.questionSets.map(q => `<button form="setdel" type="submit" class="btn btn-outline btn-sm" data-n="${esc(q.name)}"
          onclick="document.getElementById('qs-del').value=this.dataset.n; return confirm('Delete the set &quot;'+this.dataset.n+'&quot;?')">✕ ${esc(q.name)}</button>`).join('')}
      </div>` : ''}
      <div class="small muted2">Review forms come round every cycle — save the list once and reload it next time.</div>
      ${field('Output instructions (optional)', `<input name="instructions" placeholder="e.g. formal tone for my manager · bullet points · one paragraph per question">`)}
    </div>
    <div class="card">
      <h3>Scope</h3>
      <div class="grid2">
        ${field('From', `<input type="date" name="from" value="${sixMonthsAgo}">`)}
        ${field('To', `<input type="date" name="to" value="${new Date().toISOString().slice(0, 10)}">`)}
      </div>
      <div class="field"><span class="field-label">Role type <span class="muted2">(none checked = all · e.g. POST = post-sale, others = pre-sale)</span></span>
        <div class="row wrap">${s.roles.map(r0 => `<label class="check"><input type="checkbox" name="roles" value="${esc(r0)}"> ${esc(r0)}</label>`).join('')}</div>
      </div>
      <div class="field"><span class="field-label">Value themes <span class="muted2">(none checked = all)</span></span>
        <div class="theme-grid">${s.themes.map(v => `<label class="check theme-check"><input type="checkbox" name="themes" value="${esc(v)}"> ${esc(v)}</label>`).join('')}</div>
      </div>
      ${field('Limit by TR number (optional)', `<input name="trrNums" placeholder="e.g. 3, 5, 9-12 — combines with any checked below">`)}
      <details x-data="{qq:''}"><summary class="small muted">…or pick from the list (${trrs.length} available — nothing selected = all)</summary>
        <input class="list-filter" x-model="qq" placeholder="🔍 Filter list…" style="margin-top:8px">
        <div class="theme-grid">${trrs.map(t =>
          `<label class="check theme-check" data-txt="${esc(`#${t.num} ${t.customer} ${t.title}`.toLowerCase())}"
             x-show="!qq || $el.dataset.txt.includes(qq.toLowerCase())">
             <input type="checkbox" name="trrIds" value="${esc(t.id)}"> <span class="trr-num">#${t.num}</span> ${esc(t.customer)}</label>`).join('')}</div>
      </details>
    </div>
    <div class="row">
      <button class="btn" type="submit">Run review</button>
      <span id="rv-ind" class="htmx-indicator small muted2">⏳ big model at work — this can take a few minutes on a large scope…</span>
    </div>
  </form>
  <div id="rv-out"></div>
  ${savedList}
  `);
}

/**
 * Reviews are stored as "## Q1. <question>\n\n<answer>" sections joined by ---.
 * Review forms give you one field per question, so split them back apart and let
 * each answer be copied on its own.
 */
function reviewSections(answers: string): { heading: string; body: string }[] {
  return answers.split(/\n\n---\n\n/)
    .map(part => {
      const m = part.match(/^##\s*(.+?)\n\n([\s\S]*)$/);
      return m
        ? { heading: (m[1] ?? '').trim(), body: (m[2] ?? '').trim() }
        : { heading: '', body: part.trim() };
    })
    .filter(s => s.body);
}

function reviewAnswerBlocks(answers: string): string {
  const secs = reviewSections(answers);
  if (!secs.length) return `<div class="ai-text">${md2html(answers)}</div>`;
  return secs.map((s, i) => `
    <div class="qa" x-data>
      <div class="row-between wrap">
        <strong class="small">${esc(s.heading || `Answer ${i + 1}`)}</strong>
        <button type="button" class="btn btn-outline btn-sm"
          @click="navigator.clipboard.writeText($refs.body.innerText).then(()=>{$el.textContent='✓ copied'; setTimeout(()=>$el.textContent='📋 copy answer',1200)})">📋 copy answer</button>
      </div>
      <div class="ai-text" x-ref="body">${md2html(s.body)}</div>
    </div>`).join('');
}

// A long run polls itself: each response re-renders the whole #rv-out container,
// so the final poll simply swaps in the result.
function reviewPoll(jobId: string, inner: string): string {
  return `
  <div class="card" hx-get="/fragments/review/job/${esc(jobId)}" hx-trigger="load delay:3s" hx-target="#rv-out" hx-swap="innerHTML">
    ${inner}
    <div class="small muted2">Runs on the server — you can leave this page. Finished reviews are saved in the list below.</div>
  </div>`;
}

export function reviewStartedFragment(jobId: string, plan: ReviewPlan): string {
  return reviewPoll(jobId, `
    <div class="row-between wrap"><strong>Review started…</strong>
      <span class="small muted2">${plan.trrCount} TRs · ${plan.interactionCount} interactions in scope</span></div>
    <div class="small muted2">${plan.questions} question${plan.questions === 1 ? '' : 's'} × ${plan.batches} record slice${plan.batches === 1 ? '' : 's'} → at least ${plan.totalCalls} model calls${plan.batches === 1 ? ' (whole scope fits one context window)' : ''}${plan.batches > 1 ? ' — consolidating dense evidence can add a few more' : ''}</div>
    <div class="progress"><div class="progress-bar" style="width:0%"></div></div>`);
}

export function reviewProgressFragment(job: ReviewJob): string {
  const p = job.progress;
  const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
  const secs = Math.round((Date.now() - job.startedAt) / 1000);
  const mins = secs >= 90 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  return reviewPoll(job.id, `
    <div class="row-between wrap"><strong>Running review…</strong>
      <span class="small muted2">${p.done}/${p.total} calls · ${pct}% · ${mins}</span></div>
    <div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
    <div class="small muted2">${esc(p.phase)}</div>`);
}

export function reviewResultFragment(r: ReviewResult): string {
  return `
  <div class="card">
    <div class="row-between wrap">
      <strong>Review result</strong>
      <span class="small muted2">${r.trrCount} TRs · ${r.interactionCount} interactions in scope · ${r.batches} slice${r.batches === 1 ? '' : 's'} · ${r.calls} model call${r.calls === 1 ? '' : 's'} · ${esc(r.model)}</span>
    </div>
    ${r.fellBack ? `<div class="small warn">⚠ quality model hit GPU out-of-memory — some parts generated on the fast model instead</div>` : ''}
    ${r.notes.length ? `<div class="small warn">⚠ trimmed to fit the context window: ${esc(r.notes.join(' · '))}</div>` : ''}
    ${r.truncated && !r.notes.length ? `<div class="small warn">⚠ some evidence exceeded the context window — narrow the scope, or raise the context window in Settings, for full coverage</div>` : ''}
    ${reviewAnswerBlocks(r.answers)}
    <div class="small muted2">💾 Saved — <a class="hl" href="/review/${r.id}">permalink</a> (also listed below on reload).</div>
  </div>`;
}

export function reviewViewPage(r: ReviewRow, scopeSummary: string): string {
  return page(`Review #${r.id}`, '/review', `
  <a class="btn btn-outline btn-sm" href="/review">← Review engine</a>
  <div class="card">
    <div class="row-between wrap">
      <strong>Review — ${esc(r.generatedAt.slice(0, 16).replace('T', ' '))}</strong>
      <span class="small muted2">${esc(scopeSummary)} · ${esc(r.model)}</span>
    </div>
    <div class="field"><span class="field-label">Questions</span>
      <ol class="small" style="margin:4px 0 8px 18px">${r.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ol>
    </div>
    ${r.instructions ? `<div class="small muted2">Instructions: ${esc(r.instructions)}</div>` : ''}
    <hr>
    <div x-data>
      <div class="row-between"><span class="field-label">Answers</span>
        <button class="btn btn-outline btn-sm" @click="navigator.clipboard.writeText($refs.all.innerText).then(()=>{$el.textContent='✓ copied'; setTimeout(()=>$el.textContent='📋 copy all',1200)})">📋 copy all</button></div>
      <div x-ref="all">${reviewAnswerBlocks(r.answers)}</div>
    </div>
  </div>
  `);
}

// --- Search -----------------------------------------------------------------

export function searchPage(aiEnabled: boolean): string {
  return page('Search', '/search', `
  <h2>Search interactions</h2>
  <form class="card row wrap search-form" hx-get="/fragments/search" hx-target="#sr" hx-swap="innerHTML"
    hx-indicator="#sr-ind" hx-trigger="submit, input delay:400ms from:find input[name='q']">
    <input name="q" placeholder="e.g. failover, decryption, budget freeze…" autofocus style="flex:1;min-width:200px">
    ${aiEnabled ? `
    <label class="check"><input type="radio" name="mode" value="text" checked> Text</label>
    <label class="check"><input type="radio" name="mode" value="semantic"> Semantic</label>` : ''}
    <button class="btn" type="submit">Search</button>
  </form>
  <details class="card small">
    <summary class="muted">ℹ️ Text vs semantic — which mode when?</summary>
    <table class="table" style="margin-top:8px">
      <thead><tr><th></th><th>Text</th><th>Semantic</th></tr></thead>
      <tbody>
        <tr><td class="muted2">How it works</td>
          <td>Full-text index (SQLite FTS5) — matches the literal words you type, with <mark>highlights</mark></td>
          <td>Local embedding model turns every note and your query into meaning-vectors; results rank by similarity (the %)</td></tr>
        <tr><td class="muted2">Finds</td>
          <td>Exact terms: <code>failover</code>, a customer name, an IP</td>
          <td>Concepts, even with zero shared words: “customer went quiet” → “no response to three follow-ups”</td></tr>
        <tr><td class="muted2">Speed</td>
          <td>Instant</td>
          <td>Fast after the first query (which builds the index once per model)</td></tr>
        <tr><td class="muted2">Needs AI</td>
          <td>No — always available</td>
          <td>Yes — a local model server + embedding model</td></tr>
        <tr><td class="muted2">Use when</td>
          <td>You know the exact word</td>
          <td>You remember the idea but not the wording</td></tr>
      </tbody>
    </table>
  </details>
  <span id="sr-ind" class="htmx-indicator small muted2">⏳ searching…</span>
  <div id="sr"></div>
  `);
}

export function searchResults(hits: SearchHit[], mode: string, q: string): string {
  if (!q.trim()) return '';
  if (hits.length === 0) return `<div class="card muted center">No matches for “${esc(q)}” (${esc(mode)}).</div>`;
  return `
  <div class="small muted2">${hits.length} result${hits.length === 1 ? '' : 's'} · ${esc(mode)} search</div>
  ${hits.map(h => `
  <a class="card trr-card" href="/trr/${esc(h.trrId)}">
    <div class="trr-card-main">
      <div class="trr-card-head"><strong>${esc(h.customer)}</strong>
        <span class="badge st-plain">${esc(h.type)}</span>
        <span class="small muted2">${esc(h.date)}</span>
        ${mode === 'semantic' ? `<span class="small muted2">${(h.score * 100).toFixed(0)}%</span>` : ''}
      </div>
      <div class="muted small">${esc(h.title)}</div>
      <div class="snippet">${h.snippet /* pre-escaped in the search service */}</div>
    </div>
  </a>`).join('')}`;
}

// --- Settings ---------------------------------------------------------------

export interface DataInfo {
  trrs: number;
  interactions: number;
  digests: number;
  seeded: number;
  backups: { name: string; bytes: number; createdAt: string }[];
}

function fmtBytes(n: number): string {
  return n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

export function settingsPage(s: Settings, aiUrl: string, models: string[] | null, apiStyle: string | undefined, data: DataInfo): string {
  const modelSelect = (name: string, value: string) =>
    models && models.length
      ? `<select name="${name}">${models.map(m => `<option ${m === value ? 'selected' : ''}>${esc(m)}</option>`).join('')}${models.includes(value) ? '' : `<option selected>${esc(value)}</option>`}</select>`
      : `<input name="${name}" value="${esc(value)}">`;
  const listArea = (name: keyof Settings, label: string, values: string[], rows = 5) =>
    field(`${label} (one per line)`, `<textarea name="${name}" rows="${rows}" class="mono">${esc(values.join('\n'))}</textarea>`);
  return page('Settings', '/settings', `
  <h2>Settings</h2>
  <!-- Standalone target so the reset button can live inside the settings form
       without nesting one form in another. -->
  <form id="tmplreset" method="post" action="/settings/templates/reset"></form>
  <form method="post" action="/settings" class="stack">
    <div class="card ${s.aiEnabled ? '' : 'banner'}">
      <h3>AI — local only</h3>
      <label class="check" style="font-size:14px;margin-bottom:8px">
        <input type="checkbox" name="aiEnabled" value="1" ${s.aiEnabled ? 'checked' : ''}>
        <strong>Enable AI features</strong>
        <span class="muted2 small">— off = fully usable with no local model server at all: no model calls, AI buttons hidden, schedulers idle. Text search, stats, reports, and all data features keep working.</span>
      </label>
      <div class="small muted">Local model server (Ollama, LM Studio, or any OpenAI-compatible endpoint): <code>${esc(aiUrl)}</code> (set via <code>AI_URL</code> env)
        · ${models ? `<span style="color:var(--green)">reachable · ${apiStyle === 'openai' ? 'OpenAI-compatible API' : 'Ollama-native API'} · ${models.length} models</span>` : '<span class="danger">unreachable</span>'}</div>
      <div class="grid2">
        ${field('Note model (fast — exec summaries)', modelSelect('model', s.model))}
        ${field('Digest model (quality — reports)', modelSelect('digestModel', s.digestModel))}
        ${field('Embedding model (semantic search)', modelSelect('embedModel', s.embedModel))}
      </div>
      <div class="small muted" style="margin-top:10px"><strong>Context budget</strong> — the window the server is told to allocate (Ollama <code>num_ctx</code>). Ollama does <em>not</em> size this to your prompt: set it too low and input is silently dropped; too high and it errors or thrashes VRAM. Reviews slice the record to fit whatever you set here, so bigger is not automatically better — it just means fewer slices.</div>
      <div class="grid2">
        ${field('Quality model context (tokens)', `<input type="number" name="ctxTokens" value="${s.ctxTokens}" min="1024" step="1024">`)}
        ${field('Fast / fallback model context (tokens)', `<input type="number" name="fastCtxTokens" value="${s.fastCtxTokens}" min="1024" step="1024">`)}
        ${field('Reserved for answer + scaffolding (tokens)', `<input type="number" name="reviewReserveTokens" value="${s.reviewReserveTokens}" min="200" step="100">`)}
        ${field('Max model calls per review run', `<input type="number" name="reviewMaxCalls" value="${s.reviewMaxCalls}" min="1">`)}
      </div>
    </div>
    <div class="card">
      <h3>Taxonomies</h3>
      <div class="small muted" style="margin-bottom:8px">Make the tool yours — these lists drive every form, filter, and stat. Existing TRs keep their stored values even if you remove an entry.</div>
      <div class="grid2">
        ${listArea('statuses', 'Statuses', s.statuses, 9)}
        ${listArea('roles', 'My roles', s.roles, 4)}
        ${listArea('outcomes', 'Outcomes', s.outcomes, 6)}
        ${listArea('themes', 'Value themes', s.themes, 9)}
      </div>
      <div class="grid2">
        ${listArea('closedStatuses', 'Closed statuses (drive Archive tab / health)', s.closedStatuses, 3)}
        ${field('Archived status (triggers auto-digest)', `<input name="archivedStatus" value="${esc(s.archivedStatus)}">`)}
        ${field('Official-record tag', `<input name="officialTag" value="${esc(s.officialTag)}">`)}
      </div>
      <div class="small muted2">Notes containing the official-record tag (e.g. “sfdc”, “crm”, “official”) — or a [Name YYYY-MM-DD GMT] stamp — are treated as what was formally reported upstream; digests and reviews weight them as authoritative.</div>
    </div>
    <div class="card">
      <h3>Weekly updates</h3>
      <div class="grid2">
        ${field('Updates are due every', `<select name="updateDueWeekday">${WEEKDAYS.map((d, n) => `<option value="${n}" ${n === s.updateDueWeekday ? 'selected' : ''}>${d}</option>`).join('')}</select>`)}
        ${field('Default cadence', select('updateCadence', ['weekly', 'biweekly', 'none'], s.updateCadence))}
      </div>
      <label class="check"><input type="checkbox" name="logPostedUpdates" value="1" ${s.logPostedUpdates ? 'checked' : ''}> Log each posted update on its TR as an official-record note (tagged “${esc(s.officialTag)}”, so Stats and reviews count it)</label>
      <div class="small muted2">Each TR can override the cadence on its edit page. A parent TR that has children reports through its children unless it sets its own cadence. Dates use the server's time zone (<code>TZ</code> in docker-compose) — currently ${esc(localDay())}, ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}.</div>
    </div>
    <div class="card">
      <h3>Health & automation</h3>
      <div class="grid2">
        ${field('Green ≤ (days)', `<input type="number" name="greenDays" value="${s.greenDays}" min="1">`)}
        ${field('Yellow ≤ (days)', `<input type="number" name="yellowDays" value="${s.yellowDays}" min="1">`)}
        ${field('Archive window (days)', `<input type="number" name="archiveDays" value="${s.archiveDays}" min="1">`)}
        ${field('Auto-backfill every (hours, 0 = off)', `<input type="number" name="autoBackfillHours" value="${s.autoBackfillHours}" min="0">`)}
        ${field('Backups to keep', `<input type="number" name="backupKeep" value="${s.backupKeep}" min="1">`)}
      </div>
      <label class="check"><input type="checkbox" name="autoBackupEnabled" value="1" ${s.autoBackupEnabled ? 'checked' : ''}> Daily automatic database backup</label>
      <div class="small muted2">Auto-backfill drains the exec-summary backlog in the background on this schedule (also runs shortly after startup).</div>
    </div>
    <div class="card">
      <div class="row-between wrap">
        <h3 style="margin:0">Prompt templates</h3>
        <button form="tmplreset" type="submit" class="btn btn-outline btn-sm"
          onclick="return confirm('Reset all prompt templates to the shipped defaults? Any edits you made will be lost.')">↺ reset to defaults</button>
      </div>
      <div class="small muted2">Saved templates override the shipped defaults permanently — so an improved default in a later version will not reach you until you reset.</div>
      <div class="small muted">Variables: {{customer}} {{project}} {{title}} {{status}} {{contact}} {{rep}} {{date}} {{notes}} {{description}} {{interactions}} {{facts}} {{official}} {{myRole}} {{valueTheme}} {{complexity}} {{priority}}</div>
      ${field('Customer-facing (per note)', `<textarea name="custTmpl" rows="8" class="mono">${esc(s.custTmpl)}</textarea>`)}
      ${field('Exec summary (per note)', `<textarea name="execTmpl" rows="8" class="mono">${esc(s.execTmpl)}</textarea>`)}
      ${field('Period self-eval (digest)', `<textarea name="evalTmpl" rows="8" class="mono">${esc(s.evalTmpl)}</textarea>`)}
      ${field('Per-TRR catch-up (digest — auto-run on archive)', `<textarea name="trrDigestTmpl" rows="8" class="mono">${esc(s.trrDigestTmpl)}</textarea>`)}
      ${field('Weekly update ({{externalId}} {{customer}} {{opportunity}} {{title}} {{parent}} {{status}} {{from}} {{to}} {{count}} {{entries}})', `<textarea name="updateTmpl" rows="8" class="mono">${esc(s.updateTmpl)}</textarea>`)}
      ${field('Summary to date ({{scope}} {{requests}} {{previous}} {{entriesLabel}} {{entries}})', `<textarea name="summaryTmpl" rows="8" class="mono">${esc(s.summaryTmpl)}</textarea>`)}
      <div class="small muted" style="margin-top:6px">The review engine runs in two stages: <strong>map</strong> pulls question-relevant evidence out of each record slice, then <strong>reduce</strong> writes the answer from everything gathered.</div>
      ${field('Review — reduce / synthesis ({{questions}} {{facts}} {{official}} {{findings}} {{instructions}})', `<textarea name="reviewTmpl" rows="8" class="mono">${esc(s.reviewTmpl)}</textarea>`)}
      ${field('Review — map / per-slice extraction ({{question}} {{slice}} {{engagements}})', `<textarea name="reviewMapTmpl" rows="8" class="mono">${esc(s.reviewMapTmpl)}</textarea>`)}
    </div>
    <div class="row">
      <button class="btn" type="submit">Save settings</button>
      <a class="btn btn-outline" href="/">Cancel</a>
    </div>
  </form>

  <div class="card" style="margin-top:12px">
    <h3>Data</h3>
    <div class="small muted" style="margin-bottom:8px">${data.trrs} TRs · ${data.interactions} interactions · ${data.digests} stored digests${data.seeded ? ` · <strong>${data.seeded} demo TRs</strong>` : ''}</div>
    <div class="row wrap">
      ${data.seeded ? `
      <form method="post" action="/data/remove-demo" onsubmit="return confirm('Remove the ${data.seeded} demo TRs and everything attached to them?')">
        <button class="btn btn-outline" type="submit">🧹 Remove demo data (${data.seeded})</button>
      </form>` : ''}
      ${data.trrs === 0 ? `
      <form method="post" action="/data/load-demo">
        <button class="btn btn-outline" type="submit">🎲 Load demo data</button>
      </form>` : ''}
      <form method="post" action="/data/erase-all" onsubmit="return confirm('ERASE ALL DATA — every TR, interaction, digest, report, and review. Settings survive. This cannot be undone. Continue?')">
        <button class="btn btn-outline danger" type="submit">💣 Erase ALL data</button>
      </form>
      <a class="btn btn-outline" href="/api/export" download="trcc-export.json">📤 JSON export</a>
    </div>
  </div>

  <div class="card">
    <h3>Backups & restore</h3>
    <div class="small muted" style="margin-bottom:8px">A backup is a complete, consistent snapshot of the database — every TR, note, digest, report, review, setting, and search index. ${s.autoBackupEnabled ? `Daily auto-backup is ON (keeping ${s.backupKeep}).` : 'Daily auto-backup is OFF.'}</div>
    <div class="row wrap" style="margin-bottom:10px">
      <form method="post" action="/data/backup-now">
        <button class="btn" type="submit">💾 Back up now</button>
      </form>
      <form x-data @submit.prevent="
        const f = $refs.file.files[0];
        if (!f) { $refs.out.textContent = 'Pick a .db file first.'; return; }
        if (!confirm('Restore from ' + f.name + '? Current data is replaced (a safety copy is kept) and the app restarts.')) return;
        $refs.out.textContent = 'Uploading…';
        const r = await fetch('/data/restore', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
        $refs.out.textContent = await r.text();" class="row">
        <input type="file" x-ref="file" accept=".db" style="width:auto">
        <button class="btn btn-outline" type="submit">♻️ Restore from file</button>
        <span class="small muted2" x-ref="out"></span>
      </form>
    </div>
    ${data.backups.length === 0 ? '<div class="small muted2">No stored backups yet.</div>' : `
    <table class="table">
      <thead><tr><th>Backup</th><th>Size</th><th>Created</th><th></th></tr></thead>
      <tbody>${data.backups.map(b => `
        <tr>
          <td><a class="hl" href="/data/backups/${esc(b.name)}">${esc(b.name)}</a></td>
          <td>${fmtBytes(b.bytes)}</td>
          <td class="muted2">${esc(b.createdAt.slice(0, 16).replace('T', ' '))}</td>
          <td class="row">
            <form method="post" action="/data/backups/${esc(b.name)}/restore" onsubmit="return confirm('Restore ${esc(b.name)}? Current data is replaced (a safety copy is kept) and the app restarts.')">
              <button class="btn btn-outline btn-sm" type="submit">♻️ restore</button>
            </form>
            <form method="post" action="/data/backups/${esc(b.name)}/delete" onsubmit="return confirm('Delete this backup?')">
              <button class="btn btn-outline btn-sm danger" type="submit">🗑️</button>
            </form>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`}
  </div>
  `);
}

export function notFound(): string {
  return page('Not found', '/', '<div class="card center"><h2>404</h2><p class="muted">Nothing here.</p><a class="btn" href="/">Dashboard</a></div>');
}

export function messagePage(title: string, msg: string, back: string): string {
  return page(title, '/', `<div class="card"><h2>${esc(title)}</h2><p class="danger">${esc(msg)}</p><a class="btn btn-outline" href="${esc(back)}">← Back</a></div>`);
}
