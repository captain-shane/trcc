import * as repo from '../db/repo.js';
import { computePeriodDigest } from './digest.js';
import { fillTemplate, generateWithFallback } from './ai.js';
import type { Trr } from '../types.js';

// The review engine: up to 10 free-form questions ("what could I do better?",
// "outcomes vs goals?") answered by the quality model against a SCOPED slice
// of the engagement record — date range, selected TRRs, role type (pre-sale
// Lead/Supporting/SME vs post-sale POST), value themes. Deterministic facts
// and the official record anchor the model; every run persists.

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

const NOTE_CHARS = 260;         // per-interaction line budget
const ENGAGEMENTS_CHARS = 22_000; // total engagement-detail budget (~7k tokens)

interface ReviewContext {
  facts: string;
  official: string;
  engagements: string;
  trrCount: number;
  interactionCount: number;
  truncated: boolean;
}

export function buildContext(scope: ReviewScope): ReviewContext {
  const filter = scopeFilter(scope);
  const digest = computePeriodDigest(scope.from, scope.to, filter);

  const facts = JSON.stringify({
    period: digest.period, totals: digest.totals, byStatus: digest.byStatus,
    byComplexity: digest.byComplexity, byPriority: digest.byPriority, byRole: digest.byRole,
    closedWon: digest.closedWon, closedLost: digest.closedLost,
    themeCoverage: digest.themeCoverage, engagements: digest.perTrr,
  }, null, 1);

  const official = digest.official.map(o => `- [${o.date}] ${o.customer}: ${o.note}`).join('\n') || '(none in scope)';

  const trrs = repo.listTrrs('all')
    .filter(t => t.customer.toLowerCase() !== 'test')
    .filter(filter);

  const blocks: string[] = [];
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
    const desc = t.description ? t.description.replace(/\s+/g, ' ').slice(0, 300) : '';
    const lines = its.map(i => {
      // prefer the terse exec summary; fall back to a truncated raw note
      const body = (i.aiExec || i.note).replace(/\s+/g, ' ').trim().slice(0, NOTE_CHARS);
      return `- [${i.date}] ${i.type}: ${body}`;
    });
    blocks.push([head, desc, ...lines].filter(Boolean).join('\n'));
  }

  let engagements = blocks.join('\n\n');
  let truncated = false;
  if (engagements.length > ENGAGEMENTS_CHARS) {
    engagements = engagements.slice(0, ENGAGEMENTS_CHARS) + '\n\n[... truncated for context budget — narrow the scope for full detail]';
    truncated = true;
  }

  return { facts, official, engagements, trrCount: trrs.length, interactionCount, truncated };
}

export interface ReviewResult {
  id: number;
  answers: string;
  model: string;
  fellBack: boolean;
  trrCount: number;
  interactionCount: number;
  truncated: boolean;
}

export async function runReview(questions: string[], scope: ReviewScope, instructions: string): Promise<ReviewResult> {
  const s = repo.getSettings();
  const ctx = buildContext(scope);
  const questionBlock = questions.map((q, i) => `Q${i + 1}. ${q}`).join('\n');
  const prompt = fillTemplate(s.reviewTmpl, {
    questions: questionBlock,
    instructions: instructions ? `OUTPUT INSTRUCTIONS: ${instructions}` : '',
    facts: ctx.facts,
    official: ctx.official,
    engagements: ctx.engagements,
  });
  // Long context + big model: generous timeout, OOM fallback like digests.
  const r = await generateWithFallback(prompt, s.digestModel, s.model, 480_000);
  const id = repo.insertReview({
    questions, instructions, scopeJson: JSON.stringify(scope), answers: r.text,
    model: r.model + (r.fellBack ? ' (fallback)' : ''),
  });
  return {
    id, answers: r.text, model: r.model, fellBack: r.fellBack,
    trrCount: ctx.trrCount, interactionCount: ctx.interactionCount, truncated: ctx.truncated,
  };
}
