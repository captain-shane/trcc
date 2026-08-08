import { APP_VERSION } from '../config.js';
import type { Rag, Settings, Trr } from '../types.js';
import { daysSince } from '../types.js';

/** HTML-escape untrusted text. Every interpolation of user data goes through this. */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export const RAG_COLOR: Record<Rag, string> = {
  green: 'var(--green)', yellow: 'var(--yellow)', red: 'var(--red)',
};

export const RAG_LABEL: Record<Rag, string> = {
  green: 'Active', yellow: 'Aging', red: 'Stalled',
};

// Health is never encoded by colour alone (WCAG 1.4.1). Each state also gets a
// distinct SHAPE that survives greyscale and red-green colour blindness, mapping
// to familiar sign semantics: circle = go, triangle = caution, square = stop.
export const RAG_SYMBOL: Record<Rag, string> = {
  green: '●', yellow: '▲', red: '■',
};

/** Human-readable health explanation for a tooltip: state, recency, and the rule. */
export function ragTitle(r: Rag, t: Trr, s: Settings): string {
  const contact = t.lastContact ? `${daysSince(t.lastContact)}d since last contact` : 'never contacted';
  const rule = r === 'green' ? `≤ ${s.greenDays}d`
    : r === 'yellow' ? `${s.greenDays + 1}–${s.yellowDays}d`
    : `> ${s.yellowDays}d`;
  return `${RAG_LABEL[r]} — ${contact} (health threshold: ${rule})`;
}

/**
 * Health indicator: shape + colour + a native hover/focus tooltip. The shape
 * carries the meaning on its own; colour and the tooltip reinforce it. The
 * aria-label makes it announce as e.g. "Stalled — 8d since last contact" to a
 * screen reader rather than reading out a geometric character.
 */
export function ragDot(r: Rag, t: Trr, s: Settings): string {
  const title = ragTitle(r, t, s);
  return `<span class="rag-glyph rag-g-${r}" tabindex="0" role="img" title="${esc(title)}" aria-label="${esc(title)}">${RAG_SYMBOL[r]}</span>`;
}

export function badge(text: string, cls = ''): string {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

export function priorityBadge(p: Trr['priority']): string {
  return badge(p, `pri-${p.toLowerCase()}`);
}

export function statusBadge(s: string): string {
  const cls = s === 'Closed Won' ? 'st-won' : s === 'Closed Lost' ? 'st-lost' : s === 'Archived' ? 'st-arch' : 'st-plain';
  return badge(s, cls);
}

const NAV = [
  ['/', 'Dashboard'],
  ['/archive', 'Archive'],
  ['/digests', 'Digests'],
  ['/stats', 'Stats'],
  ['/reports', 'Reports'],
  ['/review', 'Review'],
  ['/search', 'Search'],
] as const;

export function page(title: string, active: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(title)} — TR Command Center</title>
<link rel="stylesheet" href="/css/app.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎯</text></svg>">
<script src="/vendor/htmx.min.js"></script>
<script defer src="/vendor/alpine.min.js"></script>
</head>
<body hx-boost="true">
<header class="topbar">
  <a class="brand" href="/">🎯 <span>TR Command Center</span> <small>v2</small></a>
  <div class="topbar-actions">
    <a class="btn" href="/trr/new">+ New TR</a>
    <a class="btn btn-outline" href="/settings" title="Settings">⚙️</a>
  </div>
</header>
<nav class="tabs">
  ${NAV.map(([href, label]) =>
    `<a class="tab ${active === href ? 'active' : ''}" href="${href}">${label}</a>`).join('')}
</nav>
<main class="container">
${content}
</main>
<footer class="app-footer">
  <span class="app-version" title="TR Command Center version — quote this when reporting a problem">TR Command Center v${APP_VERSION}</span>
</footer>
</body>
</html>`;
}

export function md2html(text: string): string {
  // Minimal, safe rendering for AI output: escape everything, then allow
  // paragraph/line structure and **bold** only.
  const escaped = esc(text);
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .split(/\n{2,}/)
    .map(p => `<p>${p.replaceAll('\n', '<br>')}</p>`)
    .join('');
}
