import { db } from './index.js';
import { config } from '../config.js';
import type { Interaction, Settings, StoredDigest, Trr, TrrHistoryEntry } from '../types.js';
import {
  DEFAULT_ARCHIVED_STATUS, DEFAULT_CLOSED_STATUSES, DEFAULT_OUTCOMES,
  DEFAULT_ROLES, DEFAULT_STATUSES, DEFAULT_THEMES,
} from '../types.js';

// --- row mapping -----------------------------------------------------------

type TrrRow = {
  id: string; num: number; customer: string; title: string; status: string; complexity: string;
  priority: string; contact: string; rep: string; target_close: string;
  description: string; my_role: string; outcome: string; value_theme: string;
  deactivated: number; deactivated_at: string; created_at: string; last_contact: string;
};

type IntRow = {
  id: string; trr_id: string; type: string; date: string; note: string;
  ai_exec: string; ai_cust: string; sensitive: number; created_at: string;
};

function toTrr(r: TrrRow): Trr {
  return {
    id: r.id, num: r.num, customer: r.customer, title: r.title,
    status: r.status as Trr['status'], complexity: r.complexity as Trr['complexity'],
    priority: r.priority as Trr['priority'], contact: r.contact, rep: r.rep,
    targetClose: r.target_close, description: r.description,
    myRole: r.my_role, outcome: r.outcome,
    valueThemes: r.value_theme ? r.value_theme.split(',').filter(Boolean) : [],
    deactivated: !!r.deactivated, deactivatedAt: r.deactivated_at,
    createdAt: r.created_at, lastContact: r.last_contact,
  };
}

function toInteraction(r: IntRow): Interaction {
  return {
    id: r.id, trrId: r.trr_id, type: r.type as Interaction['type'], date: r.date,
    note: r.note, aiExec: r.ai_exec, aiCust: r.ai_cust,
    sensitive: !!r.sensitive, createdAt: r.created_at,
  };
}

// --- TRs -------------------------------------------------------------------

export function listTrrs(scope: 'active' | 'closed' | 'all' = 'all'): Trr[] {
  if (scope === 'all') {
    return (db.prepare('SELECT * FROM trrs').all() as TrrRow[]).map(toTrr);
  }
  // "closed" statuses are user-configurable, so filter dynamically
  const closed = getSettings().closedStatuses;
  const ph = closed.map(() => '?').join(',');
  const where = scope === 'active' ? `WHERE status NOT IN (${ph})` : `WHERE status IN (${ph})`;
  return (db.prepare(`SELECT * FROM trrs ${where}`).all(...closed) as TrrRow[]).map(toTrr);
}

export function getTrr(id: string): Trr | null {
  const r = db.prepare('SELECT * FROM trrs WHERE id = ?').get(id) as TrrRow | undefined;
  return r ? toTrr(r) : null;
}

export function insertTrr(t: Omit<Trr, 'num'>): void {
  db.transaction(() => {
    const next = (db.prepare('SELECT COALESCE(MAX(num), 0) + 1 AS n FROM trrs').get() as { n: number }).n;
    db.prepare(`
      INSERT INTO trrs (id, num, customer, title, status, complexity, priority, contact, rep,
        target_close, description, my_role, outcome, value_theme,
        deactivated, deactivated_at, created_at, last_contact)
      VALUES (@id, @num, @customer, @title, @status, @complexity, @priority, @contact, @rep,
        @targetClose, @description, @myRole, @outcome, @valueTheme,
        @deactivated, @deactivatedAt, @createdAt, @lastContact)
    `).run({ ...t, num: next, valueTheme: t.valueThemes.join(','), deactivated: t.deactivated ? 1 : 0 });
    recordHistory(t.id, 'created', '', t.status, t.createdAt);
  })();
}

// Fields whose changes belong in the audit trail.
const TRACKED: { key: keyof Trr; label: string }[] = [
  { key: 'status', label: 'status' },
  { key: 'complexity', label: 'complexity' },
  { key: 'priority', label: 'priority' },
  { key: 'myRole', label: 'my role' },
  { key: 'outcome', label: 'outcome' },
];

export function updateTrr(id: string, patch: Partial<Trr>): void {
  const cur = getTrr(id);
  if (!cur) return;
  const t = { ...cur, ...patch };
  db.transaction(() => {
    db.prepare(`
      UPDATE trrs SET customer=@customer, title=@title, status=@status, complexity=@complexity,
        priority=@priority, contact=@contact, rep=@rep, target_close=@targetClose,
        description=@description, my_role=@myRole, outcome=@outcome, value_theme=@valueTheme,
        deactivated=@deactivated, deactivated_at=@deactivatedAt, last_contact=@lastContact
      WHERE id=@id
    `).run({ ...t, valueTheme: t.valueThemes.join(','), deactivated: t.deactivated ? 1 : 0 });
    for (const { key, label } of TRACKED) {
      if (String(cur[key] ?? '') !== String(t[key] ?? '')) {
        recordHistory(id, label, String(cur[key] ?? ''), String(t[key] ?? ''));
      }
    }
    const curThemes = cur.valueThemes.join(', ');
    const newThemes = t.valueThemes.join(', ');
    if (curThemes !== newThemes) recordHistory(id, 'value themes', curThemes, newThemes);
    if (cur.deactivated !== t.deactivated) {
      recordHistory(id, 'deactivation', cur.deactivated ? 'deactivated' : 'active',
        t.deactivated ? 'deactivated' : 'active');
    }
  })();
}

export function deleteTrr(id: string): void {
  db.prepare('DELETE FROM trrs WHERE id = ?').run(id);
}

// --- History (audit trail) -------------------------------------------------

export function recordHistory(trrId: string, field: string, oldValue: string, newValue: string, at?: string): void {
  db.prepare(`
    INSERT INTO trr_history (trr_id, changed_at, field, old_value, new_value)
    VALUES (?, ?, ?, ?, ?)
  `).run(trrId, at ?? new Date().toISOString(), field, oldValue, newValue);
}

export function allHistory(): TrrHistoryEntry[] {
  return (db.prepare('SELECT * FROM trr_history ORDER BY changed_at').all() as
    { id: number; trr_id: string; changed_at: string; field: string; old_value: string; new_value: string }[])
    .map(r => ({ id: r.id, trrId: r.trr_id, changedAt: r.changed_at, field: r.field, oldValue: r.old_value, newValue: r.new_value }));
}

export function listHistory(trrId: string): TrrHistoryEntry[] {
  return (db.prepare('SELECT * FROM trr_history WHERE trr_id = ? ORDER BY changed_at DESC, id DESC')
    .all(trrId) as { id: number; trr_id: string; changed_at: string; field: string; old_value: string; new_value: string }[])
    .map(r => ({ id: r.id, trrId: r.trr_id, changedAt: r.changed_at, field: r.field, oldValue: r.old_value, newValue: r.new_value }));
}

// --- Interactions ----------------------------------------------------------

export function listInteractions(trrId: string): Interaction[] {
  return (db.prepare('SELECT * FROM interactions WHERE trr_id = ? ORDER BY date DESC, created_at DESC')
    .all(trrId) as IntRow[]).map(toInteraction);
}

export function allInteractions(): Interaction[] {
  return (db.prepare('SELECT * FROM interactions').all() as IntRow[]).map(toInteraction);
}

export function getInteraction(id: string): Interaction | null {
  const r = db.prepare('SELECT * FROM interactions WHERE id = ?').get(id) as IntRow | undefined;
  return r ? toInteraction(r) : null;
}

export function insertInteraction(i: Interaction): void {
  db.prepare(`
    INSERT INTO interactions (id, trr_id, type, date, note, ai_exec, ai_cust, sensitive, created_at)
    VALUES (@id, @trrId, @type, @date, @note, @aiExec, @aiCust, @sensitive, @createdAt)
  `).run({ ...i, sensitive: i.sensitive ? 1 : 0 });
}

export function updateInteraction(id: string, patch: Partial<Interaction>): void {
  const cur = getInteraction(id);
  if (!cur) return;
  const i = { ...cur, ...patch };
  db.prepare(`
    UPDATE interactions SET type=@type, date=@date, note=@note, ai_exec=@aiExec,
      ai_cust=@aiCust, sensitive=@sensitive WHERE id=@id
  `).run({ ...i, sensitive: i.sensitive ? 1 : 0 });
}

export function deleteInteraction(id: string): void {
  db.prepare('DELETE FROM interactions WHERE id = ?').run(id);
}

/** Interactions with substantive notes and no exec summary yet (backfill queue). */
export function interactionsNeedingExec(limit: number): Interaction[] {
  return (db.prepare(`
    SELECT * FROM interactions
    WHERE length(trim(note)) >= 40 AND ai_exec = '' ORDER BY date DESC LIMIT ?
  `).all(limit) as IntRow[]).map(toInteraction);
}

// --- Digests ---------------------------------------------------------------

export function getDigest(trrId: string): StoredDigest | null {
  const r = db.prepare('SELECT * FROM digests WHERE trr_id = ?').get(trrId) as
    | { trr_id: string; customer: string; title: string; status: string; interactions: number;
        first: string; last: string; summary: string; model: string; generated_at: string }
    | undefined;
  if (!r) return null;
  return {
    trrId: r.trr_id, customer: r.customer, title: r.title, status: r.status,
    interactions: r.interactions, first: r.first, last: r.last,
    summary: r.summary, model: r.model, generatedAt: r.generated_at,
  };
}

export function listDigests(): StoredDigest[] {
  return (db.prepare('SELECT trr_id FROM digests ORDER BY generated_at DESC').all() as { trr_id: string }[])
    .map(r => getDigest(r.trr_id)!)
    .filter(Boolean);
}

export function upsertDigest(d: StoredDigest): void {
  db.prepare(`
    INSERT INTO digests (trr_id, customer, title, status, interactions, first, last, summary, model, generated_at)
    VALUES (@trrId, @customer, @title, @status, @interactions, @first, @last, @summary, @model, @generatedAt)
    ON CONFLICT(trr_id) DO UPDATE SET customer=@customer, title=@title, status=@status,
      interactions=@interactions, first=@first, last=@last, summary=@summary,
      model=@model, generated_at=@generatedAt
  `).run(d);
}

// --- Period reports (persisted digest runs) --------------------------------

export interface PeriodReportMeta {
  id: number;
  fromDate: string;
  toDate: string;
  model: string;
  generatedAt: string;
  narrativeChars: number;
}

export function insertPeriodReport(r: {
  fromDate: string; toDate: string; statsJson: string; narrative: string; model: string;
}): number {
  const res = db.prepare(`
    INSERT INTO period_reports (from_date, to_date, stats_json, narrative, model, generated_at)
    VALUES (@fromDate, @toDate, @statsJson, @narrative, @model, @generatedAt)
  `).run({ ...r, generatedAt: new Date().toISOString() });
  return Number(res.lastInsertRowid);
}

export function listPeriodReports(): PeriodReportMeta[] {
  return (db.prepare(`
    SELECT id, from_date, to_date, model, generated_at, length(narrative) AS chars
    FROM period_reports ORDER BY generated_at DESC
  `).all() as { id: number; from_date: string; to_date: string; model: string; generated_at: string; chars: number }[])
    .map(r => ({ id: r.id, fromDate: r.from_date, toDate: r.to_date, model: r.model, generatedAt: r.generated_at, narrativeChars: r.chars }));
}

export function getPeriodReport(id: number): { meta: PeriodReportMeta; statsJson: string; narrative: string } | null {
  const r = db.prepare('SELECT * FROM period_reports WHERE id = ?').get(id) as
    | { id: number; from_date: string; to_date: string; stats_json: string; narrative: string; model: string; generated_at: string }
    | undefined;
  if (!r) return null;
  return {
    meta: { id: r.id, fromDate: r.from_date, toDate: r.to_date, model: r.model, generatedAt: r.generated_at, narrativeChars: r.narrative.length },
    statsJson: r.stats_json, narrative: r.narrative,
  };
}

export function deletePeriodReport(id: number): void {
  db.prepare('DELETE FROM period_reports WHERE id = ?').run(id);
}

// --- Reviews (question-driven, persisted) ----------------------------------

export interface ReviewMeta {
  id: number;
  generatedAt: string;
  model: string;
  questionCount: number;
  firstQuestion: string;
  scopeSummary: string;
}

export interface ReviewRow {
  id: number;
  questions: string[];
  instructions: string;
  scopeJson: string;
  answers: string;
  model: string;
  generatedAt: string;
}

export function insertReview(r: {
  questions: string[]; instructions: string; scopeJson: string; answers: string; model: string;
}): number {
  const res = db.prepare(`
    INSERT INTO reviews (questions, instructions, scope_json, answers, model, generated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(JSON.stringify(r.questions), r.instructions, r.scopeJson, r.answers, r.model, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

function scopeSummaryOf(scopeJson: string): string {
  try {
    const s = JSON.parse(scopeJson) as { from?: string; to?: string; trrIds?: string[]; roles?: string[]; themes?: string[] };
    const parts: string[] = [];
    if (s.from || s.to) parts.push(`${s.from || 'start'} → ${s.to || 'now'}`);
    if (s.roles?.length) parts.push(`roles: ${s.roles.join('/')}`);
    if (s.themes?.length) parts.push(`themes: ${s.themes.join(', ')}`);
    if (s.trrIds?.length) parts.push(`${s.trrIds.length} selected TRRs`);
    return parts.join(' · ') || 'all data';
  } catch { return ''; }
}

export function listReviews(): ReviewMeta[] {
  return (db.prepare('SELECT id, questions, scope_json, model, generated_at FROM reviews ORDER BY generated_at DESC')
    .all() as { id: number; questions: string; scope_json: string; model: string; generated_at: string }[])
    .map(r => {
      const qs = JSON.parse(r.questions) as string[];
      return {
        id: r.id, generatedAt: r.generated_at, model: r.model,
        questionCount: qs.length, firstQuestion: qs[0] ?? '',
        scopeSummary: scopeSummaryOf(r.scope_json),
      };
    });
}

export function getReview(id: number): ReviewRow | null {
  const r = db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as
    | { id: number; questions: string; instructions: string; scope_json: string; answers: string; model: string; generated_at: string }
    | undefined;
  if (!r) return null;
  return {
    id: r.id, questions: JSON.parse(r.questions) as string[], instructions: r.instructions,
    scopeJson: r.scope_json, answers: r.answers, model: r.model, generatedAt: r.generated_at,
  };
}

export function deleteReview(id: number): void {
  db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
}

// --- Settings --------------------------------------------------------------

const DEFAULT_CUST_TMPL = `Rewrite these raw interaction notes as a short, plain customer-facing summary.
Rules: factual only — use ONLY what is in the notes. No praise, hype, or value claims the notes do not support. Keep technical specifics (products, versions, IPs, dates). Professional, plain tone.

Customer: {{customer}} | Project: {{project}} | Contact: {{contact}} | Date: {{date}}

Raw notes:
{{notes}}`;

const DEFAULT_EXEC_TMPL = `Condense these raw notes into a terse executive summary for CRM. Output EXACTLY this format, nothing else — no headers, no markdown, no emoji:
-Status: <one line>
-Activity: <one or two lines, concrete facts only>
-Next: <one line, concrete next step or 'none'>

Rules: factual only, use ONLY the notes. Do not invent outcomes or claim wins the notes do not state.

Customer: {{customer}} | Project: {{project}} | Status: {{status}} | Date: {{date}}

Raw notes:
{{notes}}`;

const DEFAULT_EVAL_TMPL = `You are helping the engineer draft a period self-review from their engagement record. Write in first person ("I").

STRICT GROUNDING RULES:
- Use ONLY the facts and official updates provided below. Never invent customers, numbers, outcomes, or dates.
- Do NOT claim the person "led" or "owned" a deal unless the record explicitly says so; otherwise say "contributed to" / "supported".
- No praise or value claims the record does not support. Plain, factual, confident tone.
- If the data does not support a claim, omit it.

Produce concise draft answers for:
Q1. Outcomes achieved relative to goals and their impact.
Q2. One core value best demonstrated, with grounded evidence.
Q3. Skills/capabilities to prioritize next.

=== DETERMINISTIC FACTS (authoritative) ===
{{facts}}

=== OFFICIAL UPDATES (tagged / timestamped) ===
{{official}}`;

const DEFAULT_REVIEW_TMPL = `You are writing ONE answer to ONE question for the engineer's own performance self-evaluation, in their voice. Output ONLY the answer prose — no heading, no restating the question, no preamble, no sign-off. It will be pasted straight into a review form.

HOW TO WRITE IT:
- First person, past tense, confident but factual. A reviewer will read this.
- Flowing paragraphs (2-4). NOT a numbered or bulleted list — unless the question explicitly asks you to enumerate.
- Open with one sentence framing the period, then substantiate it. Where the question is about outcomes or impact, work the authoritative totals below into that opening.
- Name the actual customers, products, and technical specifics from the evidence. Specificity is what makes a self-evaluation credible; vague claims read as padding.
- Inline labels like "Results:" or "Impact:" are welcome where they help a reviewer skim a long answer.
- Aim for roughly 300-500 words unless the instructions below say otherwise.

STRICT GROUNDING RULES:
- Use ONLY the engagement data provided below. Never invent customers, numbers, outcomes, or dates.
- Do not claim I "led" or "owned" work unless the record says so (the "my role" field or an official update).
- For improvement/reflection questions ("what could I do better?"), ground observations in patterns actually visible in the data — stalled engagements, long gaps between contacts, lost deals and their stated reasons, backlog left unfinished. Do not fabricate strengths or weaknesses.
- If the record genuinely cannot support part of the question, say so in one short sentence rather than padding.

{{instructions}}

=== QUESTION ===
{{questions}}

=== DETERMINISTIC FACTS (authoritative, computed in code) ===
{{facts}}

=== OFFICIAL UPDATES (tagged official-record / timestamped — what was actually reported upstream) ===
{{official}}

=== EVIDENCE GATHERED FROM THE FULL RECORD ===
(The record was read in slices; every question-relevant finding from all slices is collected below. Facts above are authoritative for any counting.)
{{findings}}`;

// Map step. Run once per (question x record slice). Output stays terse on
// purpose — these findings are concatenated back into the reduce prompt, so
// verbosity here is what blows the budget at scale.
const DEFAULT_REVIEW_MAP_TMPL = `You are gathering raw material for an engineer's performance review. Below is ONE SLICE of their engagement record and ONE question.

Do NOT answer the question. Extract only the evidence in THIS SLICE that bears on it.

RULES:
- Use ONLY what appears in this slice. Never invent customers, dates, numbers, or outcomes.
- Terse bullets. Each: the customer/engagement, the concrete fact, and the date when present.
- Keep specifics worth quoting later — products, blockers, stated reasons for wins/losses, long gaps in contact, unfinished work.
- If this slice has nothing relevant to the question, reply with exactly: NONE

=== QUESTION ===
{{question}}

=== RECORD SLICE ({{slice}}) ===
{{engagements}}`;

const DEFAULT_TRR_DIGEST_TMPL = `Summarize this single customer engagement so I can get back up to speed on it quickly. Plain and factual, using ONLY the record below — never invent details.

Cover briefly:
- What the customer wanted / the use case
- What we did and key technical points or decisions (products, architecture, versions — keep specifics)
- Current status / outcome
- Open items or next steps still outstanding

Keep it tight — a short paragraph or a few bullets. No praise or filler.

=== ENGAGEMENT ===
Customer: {{customer}} | Title: {{title}} | Status: {{status}} | Complexity: {{complexity}} | Priority: {{priority}}
My role: {{myRole}} | Value theme: {{valueTheme}} | Contact: {{contact}} | Rep: {{rep}}
Description: {{description}}

=== INTERACTIONS (chronological) ===
{{interactions}}`;

export function defaultSettings(): Settings {
  return {
    greenDays: 3, yellowDays: 5, archiveDays: 30, autoBackfillHours: 24,
    autoBackupEnabled: true, backupKeep: 14,
    aiEnabled: true,
    statuses: [...DEFAULT_STATUSES],
    closedStatuses: [...DEFAULT_CLOSED_STATUSES],
    archivedStatus: DEFAULT_ARCHIVED_STATUS,
    roles: [...DEFAULT_ROLES],
    outcomes: [...DEFAULT_OUTCOMES],
    themes: [...DEFAULT_THEMES],
    officialTag: 'official',
    model: config.defaultModel,
    digestModel: config.defaultDigestModel,
    embedModel: config.defaultEmbedModel,
    // Conservative defaults: 16k matches the common "-16k" model variants. Raise
    // to match a long-context model (e.g. 131072) only if the server can hold it.
    ctxTokens: 16_384,
    fastCtxTokens: 16_384,
    reviewReserveTokens: 2_000,
    reviewMaxCalls: 150,
    // One neutral example so the feature is discoverable on a fresh install.
    // Delete it or replace it with your own review form's questions.
    questionSets: [{
      name: 'Example: self-evaluation',
      questions: [
        'What outcomes did I achieve against my goals this period, and what was the impact?',
        'Which engagement had the most impact, and what specifically did I do that made the difference?',
        'Where could I have performed better, and what does the record show about why?',
        'What skills or capabilities should I prioritize developing next, based on gaps visible this period?',
        'What patterns across the period are worth calling out — wins, losses, and what I learned?',
      ],
    }],
    custTmpl: DEFAULT_CUST_TMPL,
    execTmpl: DEFAULT_EXEC_TMPL,
    evalTmpl: DEFAULT_EVAL_TMPL,
    trrDigestTmpl: DEFAULT_TRR_DIGEST_TMPL,
    reviewTmpl: DEFAULT_REVIEW_TMPL,
    reviewMapTmpl: DEFAULT_REVIEW_MAP_TMPL,
  };
}

export function getSettings(): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  // keys starting with '_' are internal metadata (e.g. _seedTrrIds), not settings
  const stored = Object.fromEntries(rows.filter(r => !r.key.startsWith('_')).map(r => [r.key, JSON.parse(r.value)]));
  return { ...defaultSettings(), ...stored };
}

const SETTINGS_KEYS = new Set<keyof Settings>([
  'greenDays', 'yellowDays', 'archiveDays', 'autoBackfillHours',
  'autoBackupEnabled', 'backupKeep',
  'aiEnabled', 'statuses', 'closedStatuses', 'archivedStatus',
  'roles', 'outcomes', 'themes', 'officialTag',
  'model', 'digestModel', 'embedModel',
  'ctxTokens', 'fastCtxTokens', 'reviewReserveTokens', 'reviewMaxCalls', 'questionSets',
  'custTmpl', 'execTmpl', 'evalTmpl', 'trrDigestTmpl', 'reviewTmpl', 'reviewMapTmpl',
]);

export function saveSettings(patch: Partial<Settings>): void {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (SETTINGS_KEYS.has(k as keyof Settings) && v !== undefined) stmt.run(k, JSON.stringify(v));
    }
  });
  tx();
}

// --- Demo-data management ---------------------------------------------------

export function seededTrrIds(): string[] {
  const r = db.prepare(`SELECT value FROM settings WHERE key = '_seedTrrIds'`).get() as { value: string } | undefined;
  if (!r) return [];
  const ids = JSON.parse(r.value) as string[];
  // only count ids that still exist (user may have deleted some manually)
  const exists = db.prepare('SELECT 1 FROM trrs WHERE id = ?');
  return ids.filter(id => exists.get(id));
}

/** Delete exactly the demo/seed TRs (cascades interactions, digests, history, embeddings). */
export function removeSeedData(): number {
  const ids = seededTrrIds();
  const del = db.prepare('DELETE FROM trrs WHERE id = ?');
  db.transaction(() => {
    for (const id of ids) del.run(id);
    db.prepare(`DELETE FROM settings WHERE key = '_seedTrrIds'`).run();
  })();
  return ids.length;
}

/** Wipe ALL tracked data (TRs, interactions, digests, reports, reviews). Settings survive. */
export function eraseAllData(): void {
  db.transaction(() => {
    db.prepare('DELETE FROM trrs').run(); // cascades interactions/digests/history/embeddings
    db.prepare('DELETE FROM period_reports').run();
    db.prepare('DELETE FROM reviews').run();
    db.prepare(`DELETE FROM settings WHERE key = '_seedTrrIds'`).run();
  })();
}

// --- Counts ----------------------------------------------------------------

export function counts(): { trrs: number; interactions: number; digests: number } {
  const c = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    trrs: c('SELECT count(*) n FROM trrs'),
    interactions: c('SELECT count(*) n FROM interactions'),
    digests: c('SELECT count(*) n FROM digests'),
  };
}
