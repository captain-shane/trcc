import { db } from '../db/index.js';
import * as repo from '../db/repo.js';
import { generate, generateWithFallback } from './ai.js';
import { usableChars } from './review.js';
import { startJob, type JobProgress } from './jobs.js';
import { localDay } from './cycle.js';
import {
  COMPLEXITIES, INTERACTION_TYPES, PRIORITIES, UPDATE_CADENCES, uid,
  type Complexity, type InteractionType, type Priority, type Settings, type Trr, type UpdateCadence,
} from '../types.js';

// Import from pasted text — usually a copy out of Google Sheets.
//
// Deterministic first, the model only assists:
//  1. PARSE in code: tab-separated (what Sheets puts on the clipboard), CSV,
//     semicolon, or a Markdown table. Quoted cells may span lines.
//  2. MAP columns to fields: header names first, then — when AI is on — the
//     local model looks at the headers and a few trimmed sample rows and
//     suggests a mapping. The operator can change every column before applying.
//     Text that is not a table at all (an email, a list of notes) is handed to
//     the model to extract rows; that needs AI.
//  3. NORMALISE values in code (dates, statuses, priorities, themes…) and build
//     a PLAN: which TRs are created or updated (matched by TR ID), which
//     customers / opportunities are new, which logs are added or are duplicates.
//  4. APPLY in one transaction, keeping what was created and what each changed
//     field was before, so the whole import can be UNDONE.

export type FieldKey =
  | 'ignore' | 'trId' | 'parentTrId' | 'customer' | 'opportunity' | 'oppStage' | 'title' | 'description'
  | 'status' | 'priority' | 'complexity' | 'myRole' | 'outcome' | 'themes' | 'contact' | 'rep'
  | 'targetClose' | 'opened' | 'lastContact' | 'cadence' | 'logDate' | 'logType' | 'logNote' | 'logFlag';

interface FieldDef { key: FieldKey; label: string; group: string; hint: string; syn: string[] }

export const FIELDS: FieldDef[] = [
  { key: 'ignore', label: '— ignore —', group: '', hint: '', syn: [] },
  { key: 'trId', label: 'TR ID', group: 'Request', hint: "the request's ID in the upstream system, e.g. TR-12345",
    syn: ['tr id', 'tr', 'trid', 'tr #', 'tr#', 'tr number', 'tr no', 'request id', 'request #', 'request number', 'req id', 'req #', 'ticket', 'ticket id', 'external id', 'id'] },
  { key: 'parentTrId', label: 'Parent TR ID', group: 'Request', hint: 'TR ID of the parent request this one belongs to',
    syn: ['parent', 'parent tr', 'parent id', 'parent tr id', 'parent request', 'parent ticket', 'master tr', 'parent #'] },
  { key: 'title', label: 'Title', group: 'Request', hint: 'short name of the request',
    syn: ['title', 'request', 'request title', 'request name', 'summary', 'subject', 'name', 'tr title', 'tr name', 'topic'] },
  { key: 'description', label: 'Description', group: 'Request', hint: 'longer description / scope of the request',
    syn: ['description', 'details', 'scope', 'request details', 'requirements', 'ask', 'use case'] },
  { key: 'status', label: 'Status', group: 'Request', hint: 'workflow status', syn: ['status', 'state', 'tr status', 'request status'] },
  { key: 'priority', label: 'Priority', group: 'Request', hint: 'Low / Medium / High / Critical', syn: ['priority', 'prio', 'urgency', 'severity'] },
  { key: 'complexity', label: 'Complexity', group: 'Request', hint: 'Simple / Medium / Complex', syn: ['complexity', 'size', 'effort', 'level of effort', 'loe'] },
  { key: 'myRole', label: 'My role', group: 'Request', hint: 'my role on it, e.g. Lead / Supporting / SME', syn: ['role', 'my role'] },
  { key: 'outcome', label: 'Outcome', group: 'Request', hint: 'result, e.g. Tech Win / Closed Lost', syn: ['outcome', 'result', 'resolution'] },
  { key: 'themes', label: 'Value themes', group: 'Request', hint: 'technology areas / categories, comma separated',
    syn: ['theme', 'themes', 'value theme', 'value themes', 'category', 'categories', 'tags', 'technology', 'tech area', 'product', 'products'] },
  { key: 'contact', label: 'Customer contact', group: 'Request', hint: 'person at the customer',
    syn: ['contact', 'customer contact', 'poc', 'champion', 'requester', 'requestor', 'requested by'] },
  { key: 'rep', label: 'Rep', group: 'Request', hint: 'account executive / sales rep',
    syn: ['rep', 'ae', 'account executive', 'account manager', 'sales rep', 'sales', 'am', 'account owner'] },
  { key: 'targetClose', label: 'Target close', group: 'Request', hint: 'target / due date',
    syn: ['target close', 'close date', 'due', 'due date', 'target date', 'deadline', 'target', 'eta'] },
  { key: 'opened', label: 'Opened', group: 'Request', hint: 'date the request was opened',
    syn: ['created', 'opened', 'date opened', 'open date', 'created date', 'created on', 'request date', 'submitted', 'date submitted', 'start date', 'start'] },
  { key: 'lastContact', label: 'Last contact', group: 'Request', hint: 'date of the latest activity',
    syn: ['last contact', 'last contacted', 'last updated', 'last update date', 'updated', 'updated on', 'last activity', 'last touch', 'modified'] },
  { key: 'cadence', label: 'Update cadence', group: 'Request', hint: 'weekly / biweekly / none', syn: ['cadence', 'update cadence', 'update frequency'] },
  { key: 'customer', label: 'Customer', group: 'Account', hint: 'customer / account name',
    syn: ['customer', 'account', 'client', 'company', 'customer name', 'account name', 'client name', 'org', 'organization', 'end user'] },
  { key: 'opportunity', label: 'Opportunity', group: 'Account', hint: 'opportunity / deal name',
    syn: ['opportunity', 'opp', 'opportunity name', 'opp name', 'deal', 'deal name', 'sfdc opportunity', 'sfdc opp'] },
  { key: 'oppStage', label: 'Opportunity stage', group: 'Account', hint: 'sales stage of the opportunity',
    syn: ['stage', 'opp stage', 'opportunity stage', 'sales stage', 'deal stage'] },
  { key: 'logDate', label: 'Log date', group: 'Log', hint: 'date of the note / activity in this row',
    syn: ['date', 'log date', 'activity date', 'note date', 'entry date', 'update date', 'week', 'week of'] },
  { key: 'logType', label: 'Log type', group: 'Log', hint: 'Call / Email / Meeting / Chat / Note…',
    syn: ['type', 'log type', 'activity', 'activity type', 'interaction', 'interaction type', 'channel'] },
  { key: 'logNote', label: 'Log note', group: 'Log', hint: 'notes / updates text — becomes logged entries',
    syn: ['notes', 'note', 'comments', 'comment', 'update', 'updates', 'activity notes', 'latest update', 'status update', 'weekly update', 'next steps', 'log', 'history', 'remarks', 'progress'] },
  { key: 'logFlag', label: 'Flag (not sent to AI)', group: 'Log', hint: 'yes/no — the note is flagged and never passed to AI',
    syn: ['flag', 'flagged', 'sensitive', 'confidential', 'private'] },
];

const FIELD_KEYS = new Set(FIELDS.map(f => f.key));
const MULTI: ReadonlySet<FieldKey> = new Set(['logNote', 'ignore']); // may be mapped from several columns
const DATE_FIELDS: ReadonlySet<FieldKey> = new Set(['targetClose', 'opened', 'lastContact', 'logDate']);
export const fieldLabel = (k: FieldKey) => FIELDS.find(f => f.key === k)?.label ?? k;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();

// --- 1. Parse ----------------------------------------------------------------

export type TableFormat = 'tsv' | 'csv' | 'semicolon' | 'markdown' | 'extracted';

export interface ParsedTable {
  format: TableFormat;
  headerRow: boolean;      // first row holds the column names
  headers: string[];       // names shown for the columns (from the header row, or "Column A"…)
  rows: string[][];        // data rows only
  allRows: string[][];     // every parsed row, so the header choice can be flipped
}

function splitDelimited(text: string, d: string, quotes: boolean): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && quotes && cell.trim() === '') { q = true; cell = ''; continue; }
    if (ch === d) { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (q) return null; // unbalanced quote: not real quoting
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c));
}

function delimited(text: string, d: string): string[][] {
  return splitDelimited(text, d, true) ?? splitDelimited(text, d, false)!;
}

function markdownRows(text: string): string[][] {
  return text.split(/\r?\n/)
    .filter(l => /^\s*\|.*\|\s*$/.test(l) && !/^\s*\|?\s*:?-{2,}/.test(l))
    .map(l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()))
    .filter(r => r.some(c => c));
}

function consistent(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const widths = new Map<number, number>();
  for (const r of rows) widths.set(r.length, (widths.get(r.length) ?? 0) + 1);
  const [w, n] = [...widths.entries()].sort((a, b) => b[1] - a[1])[0]!;
  if (w < 2 || n / rows.length < 0.8) return false;
  const cells = rows.flat().filter(c => c).map(c => c.length).sort((a, b) => a - b);
  return (cells[Math.floor(cells.length / 2)] ?? 0) < 120; // prose has long "cells"
}

/** Squares the grid and drops columns that are empty in every row. */
function tidy(rows: string[][]): string[][] {
  const w = Math.max(...rows.map(r => r.length));
  const sq = rows.map(r => [...r, ...Array(w - r.length).fill('')]);
  const keep = [...Array(w).keys()].filter(c => sq.some(r => r[c]));
  return sq.map(r => keep.map(c => r[c]!));
}

const colName = (i: number) => `Column ${i < 26 ? String.fromCharCode(65 + i) : i + 1}`;

export function withHeaderChoice(t: Pick<ParsedTable, 'format' | 'allRows'>, headerRow: boolean): ParsedTable {
  const w = t.allRows[0]?.length ?? 0;
  const head = t.allRows[0] ?? [];
  return {
    format: t.format, allRows: t.allRows, headerRow,
    headers: headerRow ? head.map((h, i) => h || colName(i)) : [...Array(w).keys()].map(colName),
    rows: headerRow ? t.allRows.slice(1) : t.allRows,
  };
}

function looksLikeHeader(row: string[]): boolean {
  const filled = row.filter(c => c);
  const hits = filled.filter(c => guessField(c) !== 'ignore').length;
  if (hits >= 1 && hits >= filled.length * 0.3) return true;
  return filled.every(c => c.length <= 40 && !parseDate(c) && !/^[\d.,$%-]+$/.test(c))
    && new Set(filled.map(c => c.toLowerCase())).size === filled.length && hits > 0;
}

/** Parse pasted text as a table; null when it is not tabular (free text). */
export function parseTable(text: string): ParsedTable | null {
  const t = text.replace(/^﻿/, '');
  const lines = t.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return null;
  const sample = lines.slice(0, 40);
  let format: TableFormat | null = null;
  let rows: string[][] = [];
  if (sample.filter(l => /^\s*\|.*\|\s*$/.test(l)).length >= Math.max(2, sample.length * 0.6)) {
    format = 'markdown'; rows = markdownRows(t);
  } else if (sample.filter(l => l.includes('\t')).length >= Math.max(1, sample.length * 0.5)) {
    format = 'tsv'; rows = delimited(t, '\t');
  } else {
    for (const [d, f] of [[',', 'csv'], [';', 'semicolon']] as const) {
      const r = delimited(t, d);
      if (consistent(r)) { format = f; rows = r; break; }
    }
  }
  if (!format || rows.length < 1) return null;
  rows = tidy(rows);
  if ((rows[0]?.length ?? 0) < 1) return null;
  const header = rows.length > 1 && looksLikeHeader(rows[0]!);
  return withHeaderChoice({ format, allRows: rows }, header);
}

// --- 2. Map columns ------------------------------------------------------------

const SYN_PAIRS = FIELDS.flatMap(f => f.syn.map(s => [s, f.key] as const)).sort((a, b) => b[0].length - a[0].length);

export function guessField(header: string): FieldKey {
  const h = norm(header);
  if (!h) return 'ignore';
  for (const [s, k] of SYN_PAIRS) if (s === h) return k;
  for (const [s, k] of SYN_PAIRS) if (s.length >= 4 && new RegExp(`(^| )${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(h)) return k;
  return 'ignore';
}

/** Header-name mapping, then sanity checks on the values themselves. */
export function heuristicMapping(t: ParsedTable): FieldKey[] {
  const m = t.headerRow ? t.headers.map(guessField) : t.headers.map(() => 'ignore' as FieldKey);
  // A column of TR-like IDs is the TR ID even without a telling header.
  if (!m.includes('trId')) {
    const idx = t.headers.findIndex((_, c) => m[c] === 'ignore' && share(t, c, v => /^[A-Z]{1,6}[-_ ]?\d{3,}$/i.test(v) || /^\d{5,10}$/.test(v)) >= 0.8);
    if (idx >= 0) m[idx] = 'trId';
  }
  return sanitize(t, m);
}

function share(t: ParsedTable, col: number, pred: (v: string) => boolean): number {
  const vals = t.rows.map(r => r[col] ?? '').filter(v => v);
  return vals.length ? vals.filter(pred).length / vals.length : 0;
}

/** One column per field (notes excepted); a "date" column that is mostly not dates is not a date. */
export function sanitize(t: ParsedTable, m: FieldKey[]): FieldKey[] {
  const seen = new Set<FieldKey>();
  // a stage with no opportunity to belong to is where the request stands
  const input = m.includes('oppStage') && !m.includes('opportunity') && !m.includes('status')
    ? m.map(k => (k === 'oppStage' ? 'status' : k)) : m;
  return input.map((k, c) => {
    if (!FIELD_KEYS.has(k)) return 'ignore';
    if (DATE_FIELDS.has(k) && t.rows.length && share(t, c, v => !!parseDate(v)) < 0.5) {
      return /update|note|comment|activity|progress/i.test(t.headers[c] ?? '') && !seen.has('logNote') ? 'logNote' : 'ignore';
    }
    if (!MULTI.has(k) && seen.has(k)) return 'ignore';
    seen.add(k);
    return k;
  });
}

function extractJson(text: string): unknown {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('The model did not return JSON.');
  return JSON.parse(text.slice(a, b + 1));
}

/** Field list for prompts; with settings, the operator's own value lists are shown so values can be recognised. */
function fieldGuide(s?: Settings): string {
  const vocab: Partial<Record<FieldKey, readonly string[]>> = s
    ? { status: s.statuses, myRole: s.roles, outcome: s.outcomes, themes: s.themes, priority: PRIORITIES, complexity: COMPLEXITIES, logType: INTERACTION_TYPES }
    : {};
  return FIELDS.filter(f => f.key !== 'ignore').map(f => {
    const v = vocab[f.key];
    return `- ${f.key}: ${f.hint}${v ? ` (values like: ${v.join(', ')})` : ''}`;
  }).join('\n');
}

const SAMPLE_ROWS = 5;
const SAMPLE_CHARS = 80;

/** Ask the local model to map columns. Only headers and a few trimmed sample cells are sent. */
export async function aiMapping(t: ParsedTable, s: Settings): Promise<{ mapping: FieldKey[]; model: string }> {
  const cols = t.headers.map((h, c) => {
    const vals = t.rows.slice(0, SAMPLE_ROWS).map(r => (r[c] ?? '').replace(/\s+/g, ' ').slice(0, SAMPLE_CHARS)).filter(v => v);
    return `${c}: ${t.headerRow ? JSON.stringify(h) : '(no header)'} — samples: ${vals.map(v => JSON.stringify(v)).join(' | ') || '(empty)'}`;
  }).join('\n');
  const prompt = `You map spreadsheet columns onto the fields of a technical-request tracker.
Hierarchy: customer -> opportunity -> request (TR) -> child requests. A row is either one request, or one dated log entry about a request.

FIELDS:
${fieldGuide(s)}
- ignore: fits none of the above

COLUMNS (index: header — sample values):
${cols}

Rules: each field at most once, except logNote (several note columns may all be logNote). A free-text notes/updates column is logNote, not description, unless it clearly describes the request itself. Where a request stands (open, in progress, won…) is status; oppStage is only a sales stage of an opportunity. Prefer "ignore" over guessing.
Answer with JSON only, no prose: {"columns": {"0": "<field>", "1": "<field>", ...}}`;
  const text = await generate(prompt, s.model, 120_000, s.fastCtxTokens);
  const parsed = extractJson(text) as { columns?: Record<string, string> };
  const heur = heuristicMapping(t);
  const mapping = t.headers.map((_, c) => {
    const v = parsed.columns?.[String(c)] as FieldKey | undefined;
    return v && FIELD_KEYS.has(v) ? v : heur[c]!;
  });
  return { mapping: sanitize(t, mapping), model: s.model };
}

/** Free text (an email, a notes dump): the model extracts rows in the field vocabulary. */
export async function aiExtract(text: string, s: Settings, progress: (p: JobProgress) => void = () => {}): Promise<{ table: ParsedTable; model: string }> {
  const budget = Math.max(2_000, usableChars(s.ctxTokens, s.reviewReserveTokens) - 2_500);
  const paras = text.replace(/\r/g, '').split(/\n{2,}/);
  const chunks: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > budget) { chunks.push(cur); cur = ''; }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > budget) { chunks.push(cur.slice(0, budget)); cur = cur.slice(budget); }
  }
  if (cur.trim()) chunks.push(cur);

  const keys = FIELDS.filter(f => f.key !== 'ignore').map(f => f.key);
  const out: Record<string, string>[] = [];
  let model = '';
  for (let n = 0; n < chunks.length; n++) {
    progress({ done: n, total: chunks.length, phase: chunks.length > 1 ? `reading part ${n + 1} of ${chunks.length}` : 'reading the text' });
    const prompt = `Extract technical requests (TRs) and dated log entries from the text below for a request tracker.
Hierarchy: customer -> opportunity -> request (TR) -> child requests.

FIELDS:
${fieldGuide(s)}

Rules:
- One object per log entry (a dated note, call, email, update). Repeat the request's fields (trId, customer, title…) on each of its entries.
- A request with no log entries is one object without log fields.
- Copy values from the text; never invent them. Leave a key out when the text does not say.
- Dates as YYYY-MM-DD when the text gives a date.
Answer with JSON only, no prose: {"rows": [{"trId": "...", "customer": "...", "title": "...", "logDate": "...", "logNote": "..."}]}

TEXT:
${chunks[n]}`;
    const r = await generateWithFallback(prompt, s.digestModel, s.model, 480_000, s.ctxTokens, s.fastCtxTokens);
    model = r.model;
    const parsed = extractJson(r.text) as { rows?: Record<string, unknown>[] };
    for (const row of parsed.rows ?? []) {
      const clean: Record<string, string> = {};
      for (const k of keys) if (row[k] != null && String(row[k]).trim()) clean[k] = String(row[k]).trim();
      if (Object.keys(clean).length) out.push(clean);
    }
  }
  progress({ done: chunks.length, total: chunks.length, phase: 'building the preview' });
  const used = keys.filter(k => out.some(r => r[k]));
  const allRows = [used.map(k => k), ...out.map(r => used.map(k => r[k] ?? ''))];
  return { table: { format: 'extracted', headerRow: true, headers: used, rows: allRows.slice(1), allRows }, model };
}

// --- 3. Normalise values ---------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');

function ymd(y: number, m: number, d: number): string {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return '';
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : '';
}

function withYear(m: number, d: number, today: string): string {
  const y = Number(today.slice(0, 4));
  const v = ymd(y, m, d);
  // no year given: the most recent such date (a week of slack for "this Friday")
  return v && v > addDaysIso(today, 7) ? ymd(y - 1, m, d) : v;
}

function addDaysIso(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const month = (s: string) => {
  const i = MONTHS.indexOf(s.slice(0, 3).toLowerCase());
  return i >= 0 && (s.length <= 3 || /^[a-z]+$/i.test(s)) ? i + 1 : 0;
};
const year = (s: string | undefined) => (!s ? 0 : s.length === 2 ? 2000 + Number(s) : Number(s));

/** Parse the date formats people paste; '' when it is not a date. US month/day unless the first part is > 12. */
export function parseDate(raw: string, today = localDay()): string {
  const s = raw.trim().replace(/^[[(]|[\])]$/g, '').replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, '').trim();
  if (!s) return '';
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/))) return ymd(+m[1]!, +m[2]!, +m[3]!);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2}))?(?:[\sT,].*)?$/))) {
    let mo = +m[1]!, d = +m[2]!;
    if (mo > 12 && d <= 12) [mo, d] = [d, mo];
    return m[3] ? ymd(year(m[3]), mo, d) : withYear(mo, d, today);
  }
  if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]([A-Za-z]{3,9})\.?,?(?:[\s-](\d{4}|\d{2}))?(?:\s.*)?$/))) {
    const mo = month(m[2]!);
    return mo ? (m[3] ? ymd(year(m[3]), mo, +m[1]!) : withYear(mo, +m[1]!, today)) : '';
  }
  if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?:[\s,].*)?$/))) {
    const mo = month(m[1]!);
    return mo ? (m[3] ? ymd(+m[3], mo, +m[2]!) : withYear(mo, +m[2]!, today)) : '';
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) { // Sheets / Excel serial day number
    const n = Math.floor(Number(s));
    if (n > 30_000 && n < 70_000) return new Date(Date.UTC(1899, 11, 30) + n * 86_400_000).toISOString().slice(0, 10);
  }
  return '';
}

// A dated line inside a notes cell: "10/1 - called Tom", "2026-10-01: …", "[Oct 1] …"
const DATED_LINE = /^\s*[[(]?((?:\d{4}-\d{1,2}-\d{1,2})|(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)|(?:[A-Za-z]{3,9}\.? \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?)|(?:\d{1,2}[- ][A-Za-z]{3,9}[- ]\d{2,4}))[\])]?\s*(?:[:\-–—|]\s*|\s+)/;

/** Split a notes cell into dated entries; text before the first date (or with no date) is returned as undated. */
export function splitDated(text: string, today = localDay()): { entries: { date: string; note: string }[]; undated: string } {
  const entries: { date: string; note: string }[] = [];
  const pre: string[] = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const m = line.match(DATED_LINE);
    const d = m ? parseDate(m[1]!, today) : '';
    if (d) entries.push({ date: d, note: line.slice(m![0].length).trim() });
    else if (entries.length) entries[entries.length - 1]!.note += `\n${line}`;
    else pre.push(line);
  }
  return {
    entries: entries.map(e => ({ ...e, note: e.note.trim() })).filter(e => e.note),
    undated: pre.join('\n').trim(),
  };
}

interface Matched { value: string; exact: boolean }

function matchOption(raw: string, options: readonly string[], syn: Record<string, string> = {}): Matched | null {
  const n = norm(raw);
  if (!n) return null;
  const exact = options.find(o => norm(o) === n);
  if (exact) return { value: exact, exact: true };
  const viaSyn = syn[n];
  if (viaSyn && options.includes(viaSyn)) return { value: viaSyn, exact: true };
  const part = options.find(o => { const no = norm(o); return no.length >= 3 && n.length >= 3 && (n.includes(no) || no.includes(n)); });
  return part ? { value: part, exact: false } : null;
}

const STATUS_SYN: Record<string, string> = {
  open: 'New', 'not started': 'New', submitted: 'New', wip: 'In Progress', active: 'In Progress', working: 'In Progress',
  started: 'In Progress', 'in flight': 'In Progress', won: 'Closed Won', lost: 'Closed Lost', 'on hold': 'Waiting Internal',
  blocked: 'Waiting Internal', 'pending customer': 'Waiting Customer', 'awaiting customer': 'Waiting Customer',
};
const PRIORITY_SYN: Record<string, string> = {
  p1: 'Critical', p0: 'Critical', urgent: 'Critical', blocker: 'Critical', sev1: 'Critical', p2: 'High', p3: 'Medium',
  med: 'Medium', normal: 'Medium', p4: 'Low', minor: 'Low',
};
const COMPLEXITY_SYN: Record<string, string> = {
  low: 'Simple', easy: 'Simple', small: 'Simple', s: 'Simple', moderate: 'Medium', med: 'Medium', m: 'Medium',
  high: 'Complex', hard: 'Complex', large: 'Complex', l: 'Complex', xl: 'Complex',
};
const TYPE_SYN: Record<string, string> = {
  phone: 'Call', 'phone call': 'Call', 'e mail': 'Email', mail: 'Email', mtg: 'Meeting', 'meeting notes': 'Meeting',
  slack: 'Chat', teams: 'Chat', im: 'Chat', webex: 'Meeting', zoom: 'Meeting', workshop: 'Meeting', update: 'Note',
};
const CADENCE_SYN: Record<string, string> = { 'every week': 'weekly', 'bi weekly': 'biweekly', fortnightly: 'biweekly', 'every 2 weeks': 'biweekly', never: 'none', 'n a': 'none', no: 'none' };
const truthy = (v: string) => /^(y|yes|true|x|1|✓|✔|🚩|flag|flagged|sensitive|confidential|private)$/i.test(v.trim());

// --- 4. Plan -----------------------------------------------------------------------

export interface ImportOptions {
  headerRow: boolean;
  updateExisting: boolean;   // change fields on TRs matched by TR ID (never blanks a field)
  flagAll: boolean;          // flag every imported log (never sent to AI)
  skip: string[];            // plan item keys the operator unticked
}

export const DEFAULT_OPTIONS: ImportOptions = { headerRow: true, updateExisting: true, flagAll: false, skip: [] };

export interface PlanLog { date: string; type: InteractionType; note: string; flagged: boolean; dup: boolean }
export interface PlanChange { key: string; label: string; from: string; to: string }

export interface PlanItem {
  key: string;
  rows: number[];                 // 1-based data row numbers, for the operator
  label: string;                  // TR ID, or the title
  action: 'create' | 'update' | 'unchanged' | 'error' | 'skipped';
  existing: Trr | null;
  title: string;
  customer: string; customerNew: boolean;
  opportunity: string; opportunityNew: boolean; oppStage: string; stageChange: string;
  parentKey: string;              // plan key of a parent created in this import
  parentId: string;               // existing parent TR
  parentLabel: string;
  fields: Partial<Trr>;           // normalised values from the paste
  changes: PlanChange[];          // for an existing TR
  logs: PlanLog[];
  undated: string;                // note text with no date — appended to the description
  errors: string[];
  warnings: string[];
}

export interface Plan {
  items: PlanItem[];
  counts: { create: number; update: number; unchanged: number; error: number; skipped: number; logs: number; dupLogs: number };
  newCustomers: string[];
  newOpps: string[];
}

type RowVals = Partial<Record<FieldKey, string>>;

function rowValues(row: string[], mapping: FieldKey[]): RowVals {
  const v: RowVals = {};
  mapping.forEach((k, c) => {
    const cell = (row[c] ?? '').trim();
    if (k === 'ignore' || !cell) return;
    v[k] = k === 'logNote' && v.logNote ? `${v.logNote}\n${cell}` : (v[k] ?? cell);
  });
  return v;
}

const TR_FIELDS: FieldKey[] = ['trId', 'parentTrId', 'customer', 'opportunity', 'oppStage', 'title', 'description', 'status', 'priority',
  'complexity', 'myRole', 'outcome', 'themes', 'contact', 'rep', 'targetClose', 'opened', 'lastContact', 'cadence'];
const LOG_FIELDS: FieldKey[] = ['logDate', 'logType', 'logNote', 'logFlag'];

const noteKey = (date: string, note: string) => `${date}|${note.replace(/\s+/g, ' ').trim().toLowerCase()}`;

function findByTitle(customer: string, title: string): Trr | null {
  if (!customer || !title) return null;
  const r = db.prepare('SELECT id FROM trrs WHERE customer = ? COLLATE NOCASE AND title = ? COLLATE NOCASE ORDER BY num LIMIT 1')
    .get(customer.trim(), title.trim()) as { id: string } | undefined;
  return r ? repo.getTrr(r.id) : null;
}

export function buildPlan(t: ParsedTable, mapping: FieldKey[], opts: ImportOptions, s: Settings, today = localDay()): Plan {
  // Group rows into requests: by TR ID, else customer + title. A row with only
  // log columns continues the request above it (merged cells copy out blank).
  const groups: { key: string; rows: number[]; vals: RowVals[] }[] = [];
  const byKey = new Map<string, (typeof groups)[number]>();
  let last: (typeof groups)[number] | null = null;
  const orphans: number[] = [];
  t.rows.forEach((row, r) => {
    const v = rowValues(row, mapping);
    const hasTr = TR_FIELDS.some(k => v[k]);
    const hasLog = LOG_FIELDS.some(k => v[k]);
    if (!hasTr && !hasLog) return;
    let key = '';
    if (v.trId) key = `id:${v.trId.toLowerCase()}`;
    else if (v.title && (v.customer || v.parentTrId)) key = `t:${(v.customer ?? v.parentTrId ?? '').toLowerCase()}|${v.title.toLowerCase()}`;
    if (!key) {
      if (last && !v.customer && !v.title) { last.rows.push(r + 1); last.vals.push(v); return; }
      orphans.push(r + 1);
      return;
    }
    let g = byKey.get(key);
    if (!g) { g = { key, rows: [], vals: [] }; byKey.set(key, g); groups.push(g); }
    g.rows.push(r + 1);
    g.vals.push(v);
    last = g;
  });

  const customers = new Map(repo.listCustomers().map(c => [c.name.toLowerCase(), c]));
  const oppsAll = repo.listOpportunities();
  const newCustomers = new Set<string>();
  const newOpps = new Set<string>();
  const stageSet = new Set<string>();
  const parentKeys = new Set<string>(); // plan keys referenced as a parent

  const items: PlanItem[] = groups.map(g => {
    const first = (k: FieldKey) => g.vals.find(v => v[k])?.[k] ?? '';
    const warnings: string[] = [];
    const errors: string[] = [];
    const conflict = (k: FieldKey) => {
      const vals = new Set(g.vals.map(v => v[k]).filter(Boolean).map(x => x!.toLowerCase()));
      if (vals.size > 1) warnings.push(`rows disagree on ${fieldLabel(k)} — using "${first(k)}"`);
    };
    (['customer', 'title', 'status', 'opportunity'] as FieldKey[]).forEach(conflict);

    const fields: Partial<Trr> = {};
    const en = <T extends string>(k: FieldKey, options: readonly T[], syn: Record<string, string>, set: (v: T) => void) => {
      const raw = first(k);
      if (!raw) return;
      const m = matchOption(raw, options, syn);
      if (!m) warnings.push(`${fieldLabel(k)} "${raw}" is not one of yours — left unset`);
      else { if (!m.exact) warnings.push(`${fieldLabel(k)} "${raw}" read as "${m.value}"`); set(m.value as T); }
    };
    en('status', s.statuses, STATUS_SYN, v => { fields.status = v; });
    en('priority', PRIORITIES, PRIORITY_SYN, v => { fields.priority = v as Priority; });
    en('complexity', COMPLEXITIES, COMPLEXITY_SYN, v => { fields.complexity = v as Complexity; });
    en('myRole', s.roles, {}, v => { fields.myRole = v; });
    en('outcome', s.outcomes, {}, v => { fields.outcome = v; });
    en('cadence', UPDATE_CADENCES, CADENCE_SYN, v => { fields.updateCadence = v as UpdateCadence; });
    if (first('themes')) {
      const parts = first('themes').split(/[,;/|\n]+/).map(x => x.trim()).filter(Boolean);
      const got = new Set<string>();
      for (const p of parts) {
        const m = matchOption(p, s.themes);
        if (m) got.add(m.value); else warnings.push(`theme "${p}" is not one of yours — skipped`);
      }
      if (got.size) fields.valueThemes = [...got];
    }
    const date = (k: FieldKey) => {
      const raw = first(k);
      if (!raw) return '';
      const d = parseDate(raw, today);
      if (!d) warnings.push(`${fieldLabel(k)} "${raw}" is not a date — skipped`);
      return d;
    };
    const targetClose = date('targetClose');
    if (targetClose) fields.targetClose = targetClose;
    const opened = date('opened');
    const lastDate = date('lastContact');
    for (const k of ['contact', 'rep', 'description'] as const) if (first(k)) fields[k] = first(k);
    const trId = first('trId');
    if (trId) fields.externalId = trId;

    // logs, row by row
    const logs: PlanLog[] = [];
    const undated: string[] = [];
    for (const v of g.vals) {
      if (!v.logNote) continue;
      const tm = v.logType ? matchOption(v.logType, INTERACTION_TYPES, TYPE_SYN) : null;
      if (v.logType && !tm) warnings.push(`log type "${v.logType}" not recognised — logged as Note`);
      const type = (tm?.value ?? 'Note') as InteractionType;
      const flagged = opts.flagAll || (v.logFlag ? truthy(v.logFlag) : false);
      const rowDate = v.logDate ? parseDate(v.logDate, today) : '';
      if (v.logDate && !rowDate) warnings.push(`log date "${v.logDate}" is not a date`);
      const split = splitDated(v.logNote, today);
      if (rowDate && !split.entries.length) { logs.push({ date: rowDate, type, note: v.logNote, flagged, dup: false }); continue; }
      for (const e of split.entries) logs.push({ date: e.date, type, note: e.note, flagged, dup: false });
      if (split.undated) {
        const d = rowDate || lastDate;
        if (d) logs.push({ date: d, type, note: split.undated, flagged, dup: false });
        else undated.push(split.undated);
      }
    }

    // match an existing TR
    const existing = trId ? repo.findTrrByExternalId(trId) : findByTitle(first('customer'), first('title'));
    let title = first('title');
    if (!title && !existing) {
      title = (fields.description ?? '').split('\n')[0]!.slice(0, 80) || (trId ? `Request ${trId}` : '');
      if (title) warnings.push('no title — one was made from the description / TR ID');
    }
    if (title) fields.title = title;

    // parent
    let parentKey = '', parentId = '', parentLabel = '', parentCustomer = '';
    const pRef = first('parentTrId');
    if (pRef) {
      parentLabel = pRef;
      if (trId && pRef.toLowerCase() === trId.toLowerCase()) errors.push('its parent TR ID is its own TR ID');
      else if (byKey.has(`id:${pRef.toLowerCase()}`)) {
        parentKey = `id:${pRef.toLowerCase()}`;
        parentKeys.add(parentKey);
        const pg = byKey.get(parentKey)!;
        parentCustomer = pg.vals.find(v => v.customer)?.customer ?? repo.findTrrByExternalId(pRef)?.customer ?? '';
      }
      else {
        const p = repo.findTrrByExternalId(pRef);
        if (!p) errors.push(`parent TR ID "${pRef}" is neither in this paste nor in the app`);
        else if (p.parentId) errors.push(`parent ${pRef} is itself a child TR — only one level of children`);
        else { parentId = p.id; parentLabel = `#${p.num} ${pRef}`; parentCustomer = p.customer; }
      }
      if (existing && repo.listChildren(existing.id).length) errors.push('this TR has children of its own, so it cannot become a child');
    }

    // customer & opportunity (a child takes both from its parent)
    const isChild = !!(parentKey || parentId || (existing?.parentId && !pRef));
    let customer = '', customerNew = false, opportunity = '', opportunityNew = false, oppStage = '', stageChange = '';
    if (isChild) {
      const own = first('customer');
      if ((own && parentCustomer && own.toLowerCase() !== parentCustomer.toLowerCase()) || (own && !parentCustomer)) {
        warnings.push(`a child TR takes its customer from its parent${parentCustomer ? ` (${parentCustomer})` : ''} — "${own}" is ignored`);
      }
    } else {
      customer = first('customer') || existing?.customer || '';
      if (!customer) { if (!pRef) errors.push('no customer (and no parent TR to take one from)'); }
      else {
        const c = customers.get(customer.toLowerCase());
        if (c) customer = c.name; else { customerNew = true; newCustomers.add(customer); }
      }
      opportunity = first('opportunity');
      oppStage = first('oppStage');
      if (opportunity && customer) {
        const c = customers.get(customer.toLowerCase());
        const o = c ? oppsAll.find(x => x.customerId === c.id && x.name.toLowerCase() === opportunity.toLowerCase()) : undefined;
        if (o) {
          opportunity = o.name;
          const sk = o.id;
          if (oppStage && oppStage !== o.stage && !stageSet.has(sk)) { stageChange = o.stage || '—'; stageSet.add(sk); }
        } else { opportunityNew = true; newOpps.add(`${customer} › ${opportunity}`); }
      } else if (oppStage && !opportunity) warnings.push('an opportunity stage without an opportunity — skipped');
    }

    // logs already in the app (or repeated in this paste) are skipped
    const seen = new Set((existing ? repo.listInteractions(existing.id) : []).map(i => noteKey(i.date, i.note)));
    for (const l of logs) {
      const k = noteKey(l.date, l.note);
      l.dup = seen.has(k);
      seen.add(k);
    }

    if (opened) fields.createdAt = new Date(`${opened}T12:00:00`).toISOString();
    if (lastDate) fields.lastContact = lastDate;

    // diff against the existing TR
    const changes: PlanChange[] = [];
    if (existing) {
      if (!opts.updateExisting) {
        if (TR_FIELDS.some(k => k !== 'trId' && first(k))) warnings.push('matched an existing TR — fields left as they are (only logs are added)');
      } else {
        const cmp: [keyof Trr, string][] = [['title', 'title'], ['status', 'status'], ['priority', 'priority'], ['complexity', 'complexity'],
          ['myRole', 'my role'], ['outcome', 'outcome'], ['contact', 'contact'], ['rep', 'rep'], ['targetClose', 'target close'],
          ['description', 'description'], ['updateCadence', 'update cadence'], ['externalId', 'TR ID']];
        for (const [k, label] of cmp) {
          const nv = fields[k];
          if (typeof nv === 'string' && nv && nv !== existing[k]) changes.push({ key: k, label, from: String(existing[k] ?? ''), to: nv });
        }
        if (fields.valueThemes && fields.valueThemes.join(',') !== existing.valueThemes.join(',')) {
          changes.push({ key: 'valueThemes', label: 'themes', from: existing.valueThemes.join(', '), to: fields.valueThemes.join(', ') });
        }
        if (!isChild && customer && customer.toLowerCase() !== existing.customer.toLowerCase()) {
          changes.push({ key: 'customer', label: 'customer', from: existing.customer, to: customer });
          warnings.push(`moves this TR from ${existing.customer} to ${customer}`);
        }
        if (!isChild && opportunity) {
          const cur = existing.opportunityId ? repo.getOpportunity(existing.opportunityId)?.name ?? '' : '';
          if (cur.toLowerCase() !== opportunity.toLowerCase()) changes.push({ key: 'opportunity', label: 'opportunity', from: cur, to: opportunity });
        }
        if ((parentKey || parentId) && !existing.parentId) changes.push({ key: 'parent', label: 'parent', from: '', to: parentLabel });
        else if (parentId && existing.parentId && existing.parentId !== parentId) changes.push({ key: 'parent', label: 'parent', from: `#${repo.getTrr(existing.parentId)?.num ?? '?'}`, to: parentLabel });
      }
      // already appended by an earlier import of the same sheet: nothing new
      const squash = (x: string) => x.replace(/\s+/g, ' ').trim().toLowerCase();
      const fresh = undated.filter(u => !squash(existing.description).includes(squash(u)));
      undated.length = 0;
      undated.push(...fresh);
      if (undated.length) changes.push({ key: 'description', label: 'description (notes appended)', from: '', to: undated.join('\n') });
    }

    const newLogs = logs.filter(l => !l.dup).length;
    const action: PlanItem['action'] = errors.length ? 'error'
      : opts.skip.includes(g.key) ? 'skipped'
      : !existing ? 'create'
      : changes.length || newLogs || stageChange ? 'update' : 'unchanged';
    return {
      key: g.key, rows: g.rows, label: trId || title || '(untitled)', action, existing, title: title || existing?.title || '',
      customer, customerNew, opportunity, opportunityNew, oppStage, stageChange,
      parentKey, parentId, parentLabel, fields, changes, logs, undated: undated.join('\n'), errors, warnings,
    };
  });

  // one level only: a TR referenced as a parent in this paste cannot itself be a child
  for (const it of items) {
    if (parentKeys.has(it.key) && (it.parentKey || it.parentId)) {
      it.errors.push('it is the parent of another row and also has a parent — only one level of children');
      it.action = 'error';
    }
  }
  for (const it of items) {
    const p = it.parentKey ? items.find(x => x.key === it.parentKey) : null;
    if (p && (p.action === 'error' || p.action === 'skipped') && it.action !== 'error' && it.action !== 'skipped') {
      it.errors.push(`its parent ${p.label} is ${p.action === 'error' ? 'in error' : 'skipped'}`);
      it.action = 'error';
    }
  }
  for (const r of orphans) {
    items.push({
      key: `row:${r}`, rows: [r], label: `row ${r}`, action: 'error', existing: null, title: '', customer: '', customerNew: false,
      opportunity: '', opportunityNew: false, oppStage: '', stageChange: '', parentKey: '', parentId: '', parentLabel: '',
      fields: {}, changes: [], logs: [], undated: '', warnings: [],
      errors: ['no TR ID, and no customer + title to identify the request'],
    });
  }

  const counts = { create: 0, update: 0, unchanged: 0, error: 0, skipped: 0, logs: 0, dupLogs: 0 };
  for (const it of items) {
    counts[it.action]++;
    if (it.action === 'create' || it.action === 'update') {
      counts.logs += it.logs.filter(l => !l.dup).length;
      counts.dupLogs += it.logs.filter(l => l.dup).length;
    }
  }
  const live = items.filter(i => i.action === 'create' || i.action === 'update');
  return {
    items, counts,
    newCustomers: [...newCustomers].filter(c => live.some(i => i.customerNew && i.customer.toLowerCase() === c.toLowerCase())),
    newOpps: [...newOpps].filter(o => live.some(i => i.opportunityNew && `${i.customer} › ${i.opportunity}` === o)),
  };
}

// --- Draft state -----------------------------------------------------------------

export interface Draft { rec: repo.ImportRecord; table: ParsedTable; mapping: FieldKey[]; opts: ImportOptions }

export function loadDraft(id: string): Draft | null {
  const rec = repo.getImport(id);
  if (!rec) return null;
  const opts = { ...DEFAULT_OPTIONS, ...(JSON.parse(rec.optionsJson || '{}') as Partial<ImportOptions>) };
  const base = JSON.parse(rec.tableJson || '{}') as Partial<ParsedTable>;
  const table = withHeaderChoice({ format: base.format ?? 'tsv', allRows: base.allRows ?? [] }, opts.headerRow);
  const raw = JSON.parse(rec.mappingJson || '[]') as FieldKey[];
  const mapping = table.headers.map((_, c) => (FIELD_KEYS.has(raw[c]!) ? raw[c]! : 'ignore'));
  return { rec, table, mapping, opts };
}

const running = new Map<string, string>(); // import id -> job id (AI mapping / extraction)
export const importJobId = (id: string) => running.get(id);

/** Create a draft from pasted text. AI work (mapping or extraction) runs as a background job. */
export function createDraft(text: string, s: Settings, useAi: boolean, label = ''): { id: string; error?: string } {
  const raw = text.replace(/\r\n/g, '\n').trim();
  if (!raw) return { id: '', error: 'Paste something to import first.' };
  const table = parseTable(raw);
  const ai = useAi && s.aiEnabled;
  if (!table && !ai) {
    return { id: '', error: s.aiEnabled
      ? 'That does not look like a table. Tick "Use the local model" to have it read free text, or paste the rows straight from the sheet.'
      : 'That does not look like a table, and reading free text needs AI (it is off in Settings). Paste the rows straight from the sheet.' };
  }
  const opts: ImportOptions = { ...DEFAULT_OPTIONS, headerRow: table?.headerRow ?? true };
  const id = repo.insertImport({
    kind: table ? 'table' : 'freeform', label: label || firstLine(raw), raw,
    tableJson: JSON.stringify(table ? { format: table.format, allRows: table.allRows } : { format: 'extracted', allRows: [] }),
    mappingJson: JSON.stringify(table ? heuristicMapping(table) : []),
    optionsJson: JSON.stringify(opts), mapper: table ? 'heuristic' : '', note: '',
  });
  if (!ai) return { id };
  const jobId = startJob('import', `import:${id}`, table ? 'Suggesting the column mapping' : 'Reading the text', 1, async progress => {
    if (table) {
      progress({ done: 0, total: 1, phase: `asking ${s.model}` });
      try {
        const r = await aiMapping(table, s);
        setMapping(id, r.mapping, r.model);
      } catch (e) {
        noteOnDraft(id, `The model could not suggest a mapping (${(e as Error).message}) — columns were matched by header name.`);
      }
      return id;
    }
    const r = await aiExtract(raw, s, progress);
    db.prepare(`UPDATE imports SET table_json = ?, mapping_json = ?, mapper = ? WHERE id = ?`)
      .run(JSON.stringify({ format: r.table.format, allRows: r.table.allRows }), JSON.stringify(r.table.headers), r.model, id);
    return id;
  });
  running.set(id, jobId);
  return { id };
}

function firstLine(s: string): string {
  return s.split('\n')[0]!.replace(/\t+/g, ' · ').slice(0, 80);
}

function setMapping(id: string, mapping: FieldKey[], mapper: string): void {
  db.prepare('UPDATE imports SET mapping_json = ?, mapper = ? WHERE id = ?').run(JSON.stringify(mapping), mapper, id);
}

function noteOnDraft(id: string, note: string): void {
  db.prepare('UPDATE imports SET note = ? WHERE id = ?').run(note, id);
}

export function saveChoices(id: string, mapping: FieldKey[], opts: ImportOptions): void {
  repo.updateImport(id, { mappingJson: JSON.stringify(mapping), optionsJson: JSON.stringify(opts) });
}

// --- 5. Apply & undo -------------------------------------------------------------------

export interface ImportResult {
  trrs: string[];                                         // created, in creation order
  logs: string[];                                         // created
  customers: string[];
  opps: string[];
  updated: { id: string; before: Partial<Trr> }[];
  stages: { id: string; before: string }[];
}

export class ImportError extends Error {}

export function applyImport(id: string): { summary: string; result: ImportResult } {
  const d = loadDraft(id);
  if (!d) throw new ImportError('That import no longer exists.');
  if (d.rec.status !== 'draft') throw new ImportError(`That import was already ${d.rec.status}.`);
  const s = repo.getSettings();
  const plan = buildPlan(d.table, d.mapping, d.opts, s);
  const todo = plan.items.filter(i => i.action === 'create' || i.action === 'update');
  if (!todo.length) throw new ImportError('Nothing to import — every row is unchanged, skipped or in error.');

  const custBefore = new Set(repo.listCustomers().map(c => c.id));
  const oppBefore = new Set(repo.listOpportunities().map(o => o.id));
  const res: ImportResult = { trrs: [], logs: [], customers: [], opps: [], updated: [], stages: [] };
  const now = new Date().toISOString();
  const tag = `import ${localDay(now)}`;

  db.transaction(() => {
    const idByKey = new Map<string, string>();
    const resolveOpp = (customerName: string, name: string, stage: string): string => {
      if (!name) return '';
      const c = repo.ensureCustomer(customerName);
      const o = repo.listOpportunities(c.id).find(x => x.name.toLowerCase() === name.toLowerCase());
      if (o) {
        if (stage && stage !== o.stage && !res.stages.some(x => x.id === o.id)) {
          res.stages.push({ id: o.id, before: o.stage });
          repo.updateOpportunity(o.id, { stage });
        }
        return o.id;
      }
      return repo.insertOpportunity({ customerId: c.id, name, stage, rep: '', closeDate: '', notes: '' }).id;
    };
    // parents before the children that point at them
    const ordered = [...todo.filter(i => !i.parentKey), ...todo.filter(i => i.parentKey)];
    for (const it of ordered) {
      const parentId = it.parentKey ? idByKey.get(it.parentKey) ?? plan.items.find(x => x.key === it.parentKey)?.existing?.id ?? '' : it.parentId;
      let trrId: string;
      if (it.action === 'create') {
        trrId = uid();
        const desc = [it.fields.description ?? '', it.undated ? `Imported notes:\n${it.undated}` : ''].filter(Boolean).join('\n\n');
        repo.insertTrr({
          id: trrId, customer: it.customer, title: it.title,
          status: it.fields.status ?? s.statuses[0] ?? 'New', complexity: it.fields.complexity ?? 'Simple',
          priority: it.fields.priority ?? 'Medium', contact: it.fields.contact ?? '', rep: it.fields.rep ?? '',
          targetClose: it.fields.targetClose ?? '', description: desc, myRole: it.fields.myRole ?? '',
          outcome: it.fields.outcome ?? '', valueThemes: it.fields.valueThemes ?? [], deactivated: false, deactivatedAt: '',
          createdAt: it.fields.createdAt ?? now, lastContact: '',
          opportunityId: parentId ? '' : resolveOpp(it.customer, it.opportunity, it.oppStage),
          parentId, externalId: it.fields.externalId ?? '', updateCadence: it.fields.updateCadence ?? '',
        });
        repo.recordHistory(trrId, 'imported', '', tag);
        res.trrs.push(trrId);
      } else {
        const ex = it.existing!;
        trrId = ex.id;
        const patch: Partial<Trr> = {};
        for (const ch of it.changes) {
          if (ch.key === 'customer') patch.customer = ch.to;
          else if (ch.key === 'opportunity') patch.opportunityId = resolveOpp(patch.customer ?? ex.customer, ch.to, it.oppStage);
          else if (ch.key === 'parent') patch.parentId = parentId;
          else if (ch.key === 'description') patch.description = it.undated && ch.label.includes('appended')
            ? [patch.description ?? ex.description, `Imported notes (${localDay(now)}):\n${it.undated}`].filter(Boolean).join('\n\n')
            : String(it.fields.description ?? ex.description);
          else (patch as Record<string, unknown>)[ch.key] = (it.fields as Record<string, unknown>)[ch.key];
        }
        if (patch.customer && !patch.opportunityId) patch.opportunityId = ''; // the old opportunity belonged to the old customer
        if (it.stageChange && it.opportunity && !patch.opportunityId) resolveOpp(ex.customer, it.opportunity, it.oppStage);
        if (Object.keys(patch).length) {
          const before: Partial<Trr> = {};
          for (const k of Object.keys(patch) as (keyof Trr)[]) (before as Record<string, unknown>)[k] = ex[k];
          if (patch.customer) before.customerId = ex.customerId;
          res.updated.push({ id: ex.id, before });
          repo.updateTrr(ex.id, patch);
          repo.recordHistory(ex.id, 'imported', '', tag);
        }
      }
      idByKey.set(it.key, trrId);

      let latest = '';
      for (const l of it.logs) {
        if (l.dup) continue;
        const lid = uid();
        repo.insertInteraction({ id: lid, trrId, type: l.type, date: l.date, note: l.note, aiExec: '', aiCust: '', sensitive: l.flagged, source: 'import', createdAt: now });
        res.logs.push(lid);
        if (l.date > latest) latest = l.date;
      }
      const cur = repo.getTrr(trrId)!;
      const lc = [cur.lastContact, latest, it.fields.lastContact ?? ''].reduce((a, b) => (b > a ? b : a), '');
      if (lc && lc !== cur.lastContact) {
        const prev = res.updated.find(u => u.id === trrId);
        if (prev) { if (!('lastContact' in prev.before)) prev.before.lastContact = cur.lastContact; }
        else if (!res.trrs.includes(trrId)) res.updated.push({ id: trrId, before: { lastContact: cur.lastContact } });
        repo.updateTrr(trrId, { lastContact: lc });
      }
    }
    res.customers = repo.listCustomers().filter(c => !custBefore.has(c.id)).map(c => c.id);
    res.opps = repo.listOpportunities().filter(o => !oppBefore.has(o.id)).map(o => o.id);
  })();

  const n = (x: number, w: string) => `${x} ${w}${x === 1 ? '' : 's'}`;
  const parts = [
    res.trrs.length && `${n(res.trrs.length, 'TR')} created`,
    res.updated.length && `${n(res.updated.length, 'TR')} updated`,
    res.logs.length && `${n(res.logs.length, 'log')} added`,
    res.customers.length && `${n(res.customers.length, 'new customer')}`,
    res.opps.length && `${n(res.opps.length, 'new opportunity').replace('opportunitys', 'opportunities')}`,
  ].filter(Boolean);
  const summary = parts.join(' · ') || 'nothing changed';
  repo.updateImport(id, { status: 'applied', resultJson: JSON.stringify(res), summary, appliedAt: now });
  return { summary, result: res };
}

/** Reverse an applied import. TRs that gained logs or children since are kept (and reported). */
export function undoImport(id: string): { summary: string; kept: string[] } {
  const rec = repo.getImport(id);
  if (!rec || rec.status !== 'applied') throw new ImportError('Only an applied import can be undone.');
  const res = JSON.parse(rec.resultJson) as ImportResult;
  const ours = new Set(res.logs);
  const kept: string[] = [];
  let removed = 0, restored = 0;
  db.transaction(() => {
    for (const lid of res.logs) repo.deleteInteraction(lid);
    for (const u of [...res.updated].reverse()) {
      if (!repo.getTrr(u.id)) continue;
      repo.updateTrr(u.id, u.before);
      repo.recordHistory(u.id, rec.kind === 'migration' ? 'restructure undone' : 'import undone', '', `${rec.kind === 'migration' ? '2.x restructure' : 'import'} ${localDay(rec.appliedAt)}`);
      restored++;
    }
    for (const st of res.stages) if (repo.getOpportunity(st.id)) repo.updateOpportunity(st.id, { stage: st.before });
    // children first, so a parent is never left pointing at nothing
    const created = res.trrs.map(tid => repo.getTrr(tid)).filter((t): t is Trr => !!t)
      .sort((a, b) => (a.parentId ? 0 : 1) - (b.parentId ? 0 : 1));
    for (const t of created) {
      const foreignLogs = repo.listInteractions(t.id).some(i => !ours.has(i.id));
      const foreignKids = repo.listChildren(t.id).some(k => !res.trrs.includes(k.id));
      if (foreignLogs || foreignKids) { kept.push(`#${t.num}`); continue; }
      repo.deleteTrr(t.id);
      removed++;
    }
    for (const oid of res.opps) {
      const n = (db.prepare('SELECT count(*) n FROM trrs WHERE opportunity_id = ?').get(oid) as { n: number }).n;
      if (!n) repo.deleteOpportunity(oid);
    }
    for (const cid of res.customers) {
      const n = (db.prepare('SELECT count(*) n FROM opportunities WHERE customer_id = ?').get(cid) as { n: number }).n;
      if (!n) repo.deleteCustomer(cid);
    }
  })();
  const summary = `undone: ${removed} TR${removed === 1 ? '' : 's'} removed, ${restored} restored, ${res.logs.length} log${res.logs.length === 1 ? '' : 's'} removed`
    + (kept.length ? ` — kept ${kept.join(', ')} (activity added after the import)` : '');
  repo.updateImport(id, { status: 'undone', undoneAt: new Date().toISOString(), summary });
  if (rec.kind === 'migration') repo.setV2UpgradeState('pending'); // the wizard is offered again
  return { summary, kept };
}
