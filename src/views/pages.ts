import type { Interaction, Settings, StoredDigest, Trr, TrrHistoryEntry } from '../types.js';
import { COMPLEXITIES, PRIORITIES, daysSince, rag } from '../types.js';
import type { PeriodDigest } from '../services/digest.js';
import type { SearchHit } from '../services/search.js';
import { RAG_COLOR, RAG_LABEL, esc, md2html, page, priorityBadge, statusBadge, badge } from './html.js';
import {
  archiveCountdown, digestBlock, field, hbar, interactionCard, interactionForm,
  statTile, trrCard, trrForm,
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

export function dashboard(trrs: Trr[], ints: IntsByTrr, s: Settings, filter: string, backlog: number): string {
  const live = trrs.filter(t => !t.deactivated);
  const ct = { red: 0, yellow: 0, green: 0 };
  for (const t of live) ct[rag(t.lastContact, s)]++;
  const deact = trrs.filter(t => t.deactivated).length;

  const filtered =
    filter === 'deact' ? trrs.filter(t => t.deactivated) :
    filter === 'red' || filter === 'yellow' || filter === 'green'
      ? trrs.filter(t => !t.deactivated && rag(t.lastContact, s) === filter)
      : trrs;

  const sorted = [...filtered].sort((a, b) => {
    if (a.deactivated !== b.deactivated) return a.deactivated ? 1 : -1;
    const order = { red: 0, yellow: 1, green: 2 };
    return order[rag(a.lastContact, s)] - order[rag(b.lastContact, s)];
  });

  const tile = (k: string, label: string, count: number, color: string) => `
    <a class="tile tile-link ${filter === k ? 'active' : ''}" href="${k === 'all' ? '/' : `/?f=${k}`}">
      <div class="tile-value" style="color:${color}">${count}</div>
      <div class="tile-label">${label}</div>
    </a>`;

  return page('Dashboard', '/', `
  <div class="tiles">
    ${tile('red', 'Stalled', ct.red, 'var(--red)')}
    ${tile('yellow', 'Aging', ct.yellow, 'var(--yellow)')}
    ${tile('green', 'Active', ct.green, 'var(--green)')}
    ${tile('deact', 'Deactivated', deact, 'var(--muted2)')}
    ${tile('all', 'Total', trrs.length, 'var(--text)')}
  </div>
  ${backlogBanner(backlog, s.aiEnabled)}
  <div x-data="{q:''}">
    <input class="list-filter" x-model="q" placeholder="🔍 Filter by #, customer, title, status, theme…">
    ${sorted.length === 0 ? '<div class="card muted center">No TRs match.</div>' : ''}
    <div class="trr-grid">
      ${sorted.map(t => trrCard(t, ints.get(t.id) ?? [], s)).join('')}
    </div>
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

export function trrDetail(t: Trr, ints: Interaction[], s: Settings, digest: StoredDigest | null, history: TrrHistoryEntry[]): string {
  const r = rag(t.lastContact, s);
  const meta: [string, string][] = [
    ['Status', t.status], ['Complexity', t.complexity], ['Priority', t.priority],
    ['Last contact', t.lastContact ? `${t.lastContact} (${daysSince(t.lastContact)}d)` : 'Never'],
    ['My role', t.myRole || '—'], ['Outcome', t.outcome || '—'],
    ['Contact', t.contact || '—'], ['Account rep', t.rep || '—'],
    ['Target close', t.targetClose || '—'], ['Created', t.createdAt.slice(0, 10)],
    ['Deactivated', t.deactivated ? `Yes — since ${t.deactivatedAt.slice(0, 10)}` : 'No'],
  ];
  return page(t.customer, '/', `
  <a class="btn btn-outline btn-sm" href="/">← Back</a>
  <div class="card" style="border-left:3px solid ${RAG_COLOR[r]}">
    <div class="row-between wrap">
      <div>
        <div class="row">
          <span class="dot" style="background:${RAG_COLOR[r]}"></span>
          <span class="trr-num">#${t.num}</span>
          <strong class="lg">${esc(t.customer)}</strong>
          ${badge(RAG_LABEL[r], `rag-b-${r}`)}
          ${statusBadge(t.status)}
          ${priorityBadge(t.priority)}
        </div>
        <div class="muted">${esc(t.title)}</div>
        ${t.valueThemes.length ? `<div class="theme-row">${t.valueThemes.map(v => badge(v, 'theme')).join('')}</div>` : ''}
        ${archiveCountdown(t, s)}
      </div>
      <div class="row wrap">
        <a class="btn" href="/trr/${esc(t.id)}/log">+ Log interaction</a>
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
      <h3>Interactions (${ints.length})</h3>
      ${ints.length === 0 ? '<div class="card muted center">No interactions yet.</div>' : ''}
      ${ints.map(i => interactionCard(i, { aiEnabled: s.aiEnabled })).join('')}
    </div>

    <aside class="detail-side">
      <div class="card">
        <h3>Details</h3>
        <div class="meta-grid side-meta">
          ${meta.map(([l, v]) => `<div><span class="field-label">${esc(l)}</span><div>${esc(v)}</div></div>`).join('')}
        </div>
        ${t.description ? `<hr><div class="muted small">${esc(t.description)}</div>` : ''}
      </div>

      ${s.aiEnabled || digest ? `
      <details class="card" ${digest ? 'open' : ''}>
        <summary><strong>🧠 Catch me up</strong></summary>
        <div id="trr-digest">
          ${digest
            ? digestBlock(digest, { cached: true })
            : `<button class="btn btn-outline" hx-get="/fragments/trr-digest/${esc(t.id)}"
                 hx-target="#trr-digest" hx-swap="innerHTML" hx-indicator="#dg-load">Generate digest</button>
               <span id="dg-load" class="htmx-indicator small muted2">⏳ generating on local model (can take ~30s)…</span>`}
        </div>
      </details>` : ''}

      <details class="card" open>
        <summary><strong>📜 History</strong> <span class="small muted2">(${history.length})</span></summary>
        ${historyTimeline(history)}
      </details>

      <div class="card">
        <form method="post" action="/trr/${esc(t.id)}/delete" onsubmit="return confirm('Delete this TR and all its interactions? This cannot be undone.')">
          <button class="btn btn-outline danger btn-sm" type="submit">Delete TR</button>
        </form>
      </div>
    </aside>
  </div>
  `);
}

export function newTrrPage(s: Settings): string {
  return page('New TR', '/', `<h2>New TR</h2>${trrForm({}, '/trr', 'Create TR', s)}`);
}

export function editTrrPage(t: Trr, s: Settings): string {
  return page(`Edit — ${t.customer}`, '/', `<h2>Edit TR</h2>${trrForm(t, `/trr/${esc(t.id)}`, 'Save', s)}`);
}

export function logInteractionPage(t: Trr): string {
  return page(`Log — ${t.customer}`, '/', `
    <h2>Log interaction — ${esc(t.customer)}</h2>${interactionForm(t.id)}`);
}

export function editInteractionPage(t: Trr, i: Interaction): string {
  return page(`Edit interaction — ${t.customer}`, '/', `
    <h2>Edit interaction — ${esc(t.customer)}</h2>${interactionForm(t.id, i)}`);
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
  <div class="card" x-data>
    <div class="row-between wrap">
      <strong>📋 Weekly report</strong>
      <button class="btn btn-outline btn-sm" @click="navigator.clipboard.writeText($refs.w.innerText).then(()=>{$el.textContent='✓ copied'; setTimeout(()=>$el.textContent='📋 copy',1200)})">📋 copy</button>
    </div>
    <pre class="report-pre" x-ref="w">${esc(weeklyText)}</pre>
  </div>

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
      ${field('Per-TRR catch-up (digest)', `<textarea name="trrDigestTmpl" rows="8" class="mono">${esc(s.trrDigestTmpl)}</textarea>`)}
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
