import * as repo from '../db/repo.js';
import { computePeriodDigest } from './digest.js';
import { fillTemplate, generateWithFallback } from './ai.js';
import type { Settings, Trr } from '../types.js';

// The review engine: free-form questions answered against a SCOPED slice of the
// engagement record (date range, selected TRs, role type, value themes).
//
// It is MAP-REDUCE rather than one large prompt, because the record outgrows any
// context window — a bigger model buys headroom, not a solution. Records are
// packed into batches sized to the CONFIGURED window; each question is mapped
// over every batch to pull relevant evidence, then reduced into one answer.
// Deterministic stats are computed in code and passed whole, so no count is ever
// lost to slicing, and nothing is dropped silently.

export interface ReviewScope {
  from?: string;
  to?: string;
  trrIds?: string[];  // empty = all
  roles?: string[];   // filter by myRole
  themes?: string[];  // any-overlap on valueThemes
}

export function scopeFilter(scope: ReviewScope): (t: Trr) => boolean {
  return t => {
    if (scope.trrIds?.length && !scope.trrIds.includes(t.id)) return false;
    if (scope.roles?.length && !scope.roles.includes(t.myRole)) return false;
    if (scope.themes?.length && !t.valueThemes.some(v => scope.themes!.includes(v))) return false;
    return true;
  };
}

/**
 * Conservative chars-per-token: better to under-fill than overflow. Kept low
 * on purpose — JSON facts and structured note lines tokenise far denser than
 * prose, and overflowing costs the whole answer (the prompt fills the window
 * and the model has no room left to generate).
 */
const CHARS_PER_TOKEN = 3.2;
/** Per-interaction body budget. Generous now that batching carries the volume. */
const NOTE_CHARS = 1_400;
const CALL_TIMEOUT = 480_000;

function usableChars(tokens: number, reserve: number): number {
  return Math.max(2_000, Math.floor((tokens - reserve) * CHARS_PER_TOKEN));
}

interface RecordBlock { trrId: string; text: string }

/** One block per in-scope TR: header + description + its interaction lines. */
function blocksFor(scope: ReviewScope): { blocks: RecordBlock[]; trrCount: number; interactionCount: number } {
  const filter = scopeFilter(scope);
  const trrs = repo.listTrrs('all')
    .filter(t => t.customer.toLowerCase() !== 'test')
    .filter(filter);

  const blocks: RecordBlock[] = [];
  let interactionCount = 0;
  for (const t of trrs) {
    const its = repo.listInteractions(t.id)
      .filter(i => (!scope.from || i.date >= scope.from) && (!scope.to || i.date <= scope.to))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (its.length === 0 && (scope.from || scope.to)) continue; // nothing in window
    interactionCount += its.length;

    const head = `## ${t.customer} — ${t.title} ` +
      `[${t.status} | ${t.complexity} | ${t.priority}` +
      `${t.myRole ? ` | my role: ${t.myRole}` : ''}` +
      `${t.outcome ? ` | outcome: ${t.outcome}` : ''}` +
      `${t.valueThemes.length ? ` | themes: ${t.valueThemes.join(', ')}` : ''}]`;
    const desc = t.description ? t.description.replace(/\s+/g, ' ').slice(0, 600) : '';
    const lines = its.map(i => {
      const body = (i.aiExec || i.note).replace(/\s+/g, ' ').trim().slice(0, NOTE_CHARS);
      return `- [${i.date}] ${i.type}: ${body}`;
    });
    blocks.push({ trrId: t.id, text: [head, desc, ...lines].filter(Boolean).join('\n') });
  }
  return { blocks, trrCount: trrs.length, interactionCount };
}

/**
 * The full in-scope record as one string, plus counts. This is the whole corpus
 * with nothing dropped — batching happens later, at call time. Used for scope
 * previews and by the tests.
 */
export function buildContext(scope: ReviewScope): {
  trrCount: number; interactionCount: number; engagements: string; blocks: number;
} {
  const { blocks, trrCount, interactionCount } = blocksFor(scope);
  return {
    trrCount, interactionCount,
    engagements: blocks.map(b => b.text).join('\n\n'),
    blocks: blocks.length,
  };
}

/** A single TR bigger than one batch is split at interaction boundaries, header repeated. */
function splitBlock(b: RecordBlock, budget: number): RecordBlock[] {
  if (b.text.length <= budget) return [b];
  const lines = b.text.split('\n');
  const header = lines[0] ?? '';
  const room = Math.max(400, budget - header.length - 16);
  const out: RecordBlock[] = [];
  let cur = [header];
  let len = header.length;
  for (const ln of lines.slice(1)) {
    // one pathological line still has to land somewhere
    const piece = ln.length > room ? ln.slice(0, room) + ' […line truncated]' : ln;
    if (len + piece.length + 1 > budget && cur.length > 1) {
      out.push({ trrId: b.trrId, text: cur.join('\n') });
      cur = [`${header} (cont.)`];
      len = header.length + 8;
    }
    cur.push(piece);
    len += piece.length + 1;
  }
  if (cur.length > 1) out.push({ trrId: b.trrId, text: cur.join('\n') });
  return out;
}

/** Bin-pack whole TRs into batches that fit the window. */
function packBatches(blocks: RecordBlock[], budget: number): string[] {
  const batches: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const b0 of blocks) {
    for (const b of splitBlock(b0, budget)) {
      if (len + b.text.length + 2 > budget && cur.length) {
        batches.push(cur.join('\n\n'));
        cur = []; len = 0;
      }
      cur.push(b.text);
      len += b.text.length + 2;
    }
  }
  if (cur.length) batches.push(cur.join('\n\n'));
  return batches;
}

/** Split already-generated text into window-sized chunks at line boundaries. */
function chunkText(text: string, budget: number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const ln of text.split('\n')) {
    const piece = ln.length > budget ? ln.slice(0, budget) : ln;
    if (len + piece.length + 1 > budget && cur.length) { out.push(cur.join('\n')); cur = []; len = 0; }
    cur.push(piece);
    len += piece.length + 1;
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

function mapBudget(s: Settings, questions: string[]): number {
  const longestQ = questions.reduce((m, q) => Math.max(m, q.length), 0);
  const overhead = s.reviewMapTmpl.length + longestQ + 600;
  return Math.max(4_000, usableChars(s.ctxTokens, s.reviewReserveTokens) - overhead);
}

export interface ReviewPlan {
  trrCount: number;
  interactionCount: number;
  corpusChars: number;
  batchBudgetChars: number;
  batches: number;
  questions: number;
  mapCalls: number;
  reduceCalls: number;
  totalCalls: number;
  maxCalls: number;
  overCallBudget: boolean;
}

/** What a run would cost, without running it. Drives the pre-flight estimate. */
export function planReview(questions: string[], scope: ReviewScope): ReviewPlan {
  const s = repo.getSettings();
  const { blocks, trrCount, interactionCount } = blocksFor(scope);
  const budget = mapBudget(s, questions);
  const batches = packBatches(blocks, budget);
  const q = questions.length;
  // one batch fits the window outright: skip the map pass entirely
  const mapCalls = batches.length > 1 ? q * batches.length : 0;
  const reduceCalls = q;
  const totalCalls = mapCalls + reduceCalls;
  return {
    trrCount, interactionCount,
    corpusChars: blocks.reduce((n, b) => n + b.text.length, 0),
    batchBudgetChars: budget,
    batches: batches.length,
    questions: q,
    mapCalls, reduceCalls, totalCalls,
    maxCalls: s.reviewMaxCalls,
    overCallBudget: totalCalls > s.reviewMaxCalls,
  };
}

export interface ReviewProgress { done: number; total: number; phase: string }
export type ProgressFn = (p: ReviewProgress) => void;

export interface ReviewResult {
  id: number;
  answers: string;
  model: string;
  fellBack: boolean;
  trrCount: number;
  interactionCount: number;
  truncated: boolean;
  notes: string[];   // exactly what was trimmed to fit, if anything
  batches: number;
  calls: number;
}

export async function runReview(
  questions: string[], scope: ReviewScope, instructions: string, onProgress?: ProgressFn,
): Promise<ReviewResult> {
  const s = repo.getSettings();
  const plan = planReview(questions, scope);
  if (plan.overCallBudget) {
    throw new Error(
      `This run needs ${plan.totalCalls} model calls (${plan.questions} questions x ${plan.batches} record slices), ` +
      `over the limit of ${plan.maxCalls}. Narrow the scope, ask fewer questions, ` +
      `raise the context window so fewer slices are needed, or raise the call limit in Settings.`);
  }

  const { blocks, trrCount, interactionCount } = blocksFor(scope);
  const batches = packBatches(blocks, mapBudget(s, questions));
  const digest = computePeriodDigest(scope.from, scope.to, scopeFilter(scope));

  // --- Reduce-prompt budget --------------------------------------------------
  // EVERYTHING in the reduce call has to fit the window with room left over to
  // actually WRITE the answer. facts and the official record both grow with the
  // record, so each gets a bounded share and evidence takes the remainder. Left
  // unbounded, a large official record fills the whole window and the model
  // returns an empty answer.
  const trimNotes: string[] = [];
  const reduceBudget = Math.max(
    4_000,
    usableChars(s.ctxTokens, s.reviewReserveTokens) - (s.reviewTmpl.length + instructions.length + 600));
  const factsCap = Math.floor(reduceBudget * 0.25);
  const officialCap = Math.floor(reduceBudget * 0.30);

  const factsBase = {
    period: digest.period, totals: digest.totals, byStatus: digest.byStatus,
    byComplexity: digest.byComplexity, byPriority: digest.byPriority, byRole: digest.byRole,
    closedWon: digest.closedWon, closedLost: digest.closedLost,
    themeCoverage: digest.themeCoverage,
  };
  let facts = JSON.stringify({ ...factsBase, engagements: digest.perTrr }, null, 1);
  if (facts.length > factsCap) {
    // aggregates are what the model must never get wrong; the per-engagement
    // list is the expendable part
    facts = JSON.stringify({
      ...factsBase,
      engagements: `[${digest.perTrr.length} engagements — per-engagement list omitted to fit the window; totals above are complete]`,
    }, null, 1);
    trimNotes.push('per-engagement facts list omitted (totals still complete)');
  }

  let official = digest.official.map(o => `- [${o.date}] ${o.customer}: ${o.note}`).join('\n') || '(none in scope)';
  if (official.length > officialCap) {
    // keep the most recent — they are the ones a review period is about
    const lines = official.split('\n');
    const kept: string[] = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i] ?? '';
      if (used + l.length + 1 > officialCap) break;
      kept.unshift(l);
      used += l.length + 1;
    }
    const dropped = lines.length - kept.length;
    official = `${kept.join('\n')}\n[… ${dropped} older official updates omitted to fit the window]`;
    trimNotes.push(`${dropped} older official updates omitted`);
  }

  let calls = 0;
  let fellBack = false;
  let modelUsed = s.digestModel;
  let truncated = trimNotes.length > 0;
  const total = plan.totalCalls;
  const bump = (r: { model: string; fellBack: boolean }) => {
    calls++;
    if (r.fellBack) { fellBack = true; modelUsed = r.model; }
  };
  const gen = (prompt: string) =>
    generateWithFallback(prompt, s.digestModel, s.model, CALL_TIMEOUT, s.ctxTokens, s.fastCtxTokens);

  const sections: string[] = [];
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const label = `Q${qi + 1}. ${q}`;
    let findings: string;

    if (batches.length <= 1) {
      // whole scope fits the window: no map pass needed
      findings = batches[0] ?? '(no records in scope)';
    } else {
      const parts: string[] = [];
      for (let bi = 0; bi < batches.length; bi++) {
        onProgress?.({ done: calls, total, phase: `Q${qi + 1}/${questions.length}: reading slice ${bi + 1}/${batches.length}` });
        const r = await gen(fillTemplate(s.reviewMapTmpl, {
          question: label, slice: `${bi + 1} of ${batches.length}`, engagements: batches[bi] ?? '',
        }));
        bump(r);
        const txt = r.text.trim();
        if (txt && !/^NONE\b/i.test(txt)) parts.push(`— from slice ${bi + 1} —\n${txt}`);
      }
      findings = parts.join('\n\n') || '(no relevant evidence found in the record for this question)';
    }

    // Whatever the bounded facts and official record leave behind belongs to
    // evidence. No floor here: forcing a minimum would push the prompt past the
    // window, which costs the entire answer.
    const reduceRoom = Math.max(1_000, reduceBudget - facts.length - official.length - label.length);

    // Evidence itself can overflow: consolidate in rounds rather than clipping.
    // These rounds are NOT in the pre-flight plan (their need only shows up once
    // the map output exists), so they respect the call budget too — hitting the
    // cap stops the fold and falls through to an honest truncation notice
    // instead of quietly blowing past the limit.
    let depth = 0;
    while (findings.length > reduceRoom && depth < 3 && calls < s.reviewMaxCalls) {
      const condensed: string[] = [];
      for (const chunk of chunkText(findings, reduceRoom)) {
        onProgress?.({ done: calls, total, phase: `Q${qi + 1}/${questions.length}: consolidating evidence (pass ${depth + 1})` });
        const r = await gen(fillTemplate(s.reviewMapTmpl, {
          question: label, slice: `consolidation pass ${depth + 1}`, engagements: chunk,
        }));
        bump(r);
        const t = r.text.trim();
        if (t && !/^NONE\b/i.test(t)) condensed.push(t);
      }
      findings = condensed.join('\n\n');
      depth++;
    }
    if (findings.length > reduceRoom) {
      findings = findings.slice(0, reduceRoom) + '\n[… evidence still exceeded the window after consolidation]';
      truncated = true;
    }

    onProgress?.({ done: calls, total, phase: `Q${qi + 1}/${questions.length}: writing the answer` });
    const r = await gen(fillTemplate(s.reviewTmpl, {
      questions: label,
      instructions: instructions ? `OUTPUT INSTRUCTIONS: ${instructions}` : '',
      facts, official,
      findings,
      engagements: findings, // back-compat: older saved templates use {{engagements}}
    }));
    bump(r);
    const answer = r.text.trim();
    if (!answer) {
      // Almost always means the prompt consumed the whole window, leaving no
      // room to generate. Say so plainly instead of saving a blank section.
      truncated = true;
      sections.push(`## ${label}\n\n_The model returned an empty answer. This usually means the prompt filled the entire context window, leaving no room to generate — narrow the scope, or raise the context window in Settings._`);
    } else {
      sections.push(`## ${label}\n\n${answer}`);
    }
  }

  onProgress?.({ done: calls, total, phase: 'done' });
  const answers = sections.join('\n\n---\n\n');
  const id = repo.insertReview({
    questions, instructions, scopeJson: JSON.stringify(scope), answers,
    model: modelUsed + (fellBack ? ' (fallback)' : ''),
  });
  return {
    id, answers, model: modelUsed, fellBack,
    trrCount, interactionCount, truncated, notes: trimNotes,
    batches: batches.length, calls,
  };
}
