import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the app at a throwaway DB before any module under test loads.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'trr-test-')), 'test.db');

const repo = await import('../src/db/repo.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { computePeriodDigest } = await import('../src/services/digest.js');
const { textSearch } = await import('../src/services/search.js');
const { uid } = await import('../src/types.js');
const { esc } = await import('../src/views/html.js');

beforeAll(() => {
  seedIfEmpty();
});

describe('seed + repo', () => {
  it('seeds TRRs and interactions', () => {
    const c = repo.counts();
    expect(c.trrs).toBeGreaterThanOrEqual(10);
    expect(c.interactions).toBeGreaterThanOrEqual(28);
  });

  it('sets last_contact from interactions', () => {
    for (const t of repo.listTrrs('all')) {
      const ints = repo.listInteractions(t.id);
      if (ints.length) expect(t.lastContact).toBe(ints[0]!.date); // list is date-desc
    }
  });

  it('round-trips a TRR with structured fields', () => {
    const id = uid();
    repo.insertTrr({
      id, customer: 'Test Co', title: 'Roundtrip', status: 'New', complexity: 'Simple',
      priority: 'Low', contact: '', rep: '', targetClose: '', description: '',
      myRole: 'Lead', outcome: 'Ongoing', valueThemes: ['Networking', 'Automation'],
      deactivated: false, deactivatedAt: '', createdAt: new Date().toISOString(), lastContact: '',
    });
    const t = repo.getTrr(id)!;
    expect(t.myRole).toBe('Lead');
    expect(t.valueThemes).toEqual(['Networking', 'Automation']);
    repo.updateTrr(id, { status: 'POC', deactivated: true, deactivatedAt: new Date().toISOString() });
    expect(repo.getTrr(id)!.status).toBe('POC');
    expect(repo.getTrr(id)!.deactivated).toBe(true);
    repo.deleteTrr(id);
    expect(repo.getTrr(id)).toBeNull();
  });

  it('records an audit trail of tracked field changes', () => {
    const id = uid();
    repo.insertTrr({
      id, customer: 'Audit Co', title: 'x', status: 'New', complexity: 'Simple',
      priority: 'Low', contact: '', rep: '', targetClose: '', description: '',
      myRole: '', outcome: '', valueThemes: ['Security'],
      deactivated: false, deactivatedAt: '', createdAt: new Date().toISOString(), lastContact: '',
    });
    repo.updateTrr(id, { status: 'POC', myRole: 'Lead', valueThemes: ['Security', 'Cloud'] });
    repo.updateTrr(id, { status: 'Closed Won', outcome: 'Closed Won' });
    const hist = repo.listHistory(id);
    const asPairs = hist.map(h => `${h.field}:${h.oldValue}->${h.newValue}`);
    expect(asPairs).toContain('created:->New');
    expect(asPairs).toContain('status:New->POC');
    expect(asPairs).toContain('my role:->Lead');
    expect(asPairs).toContain('value themes:Security->Security, Cloud');
    expect(asPairs).toContain('status:POC->Closed Won');
    expect(asPairs).toContain('outcome:->Closed Won');
    // untouched fields produce no entries
    expect(hist.filter(h => h.field === 'complexity')).toHaveLength(0);
    repo.deleteTrr(id);
    expect(repo.listHistory(id)).toHaveLength(0); // cascades
  });

  it('cascades interaction deletes with the TRR', () => {
    const id = uid();
    repo.insertTrr({
      id, customer: 'Cascade Co', title: 'x', status: 'New', complexity: 'Simple',
      priority: 'Low', contact: '', rep: '', targetClose: '', description: '',
      myRole: '', outcome: '', valueThemes: [],
      deactivated: false, deactivatedAt: '', createdAt: new Date().toISOString(), lastContact: '',
    });
    repo.insertInteraction({
      id: uid(), trrId: id, type: 'Call', date: '2026-07-01', note: 'hello world',
      aiExec: '', aiCust: '', sensitive: false, createdAt: new Date().toISOString(),
    });
    expect(repo.listInteractions(id)).toHaveLength(1);
    repo.deleteTrr(id);
    expect(repo.listInteractions(id)).toHaveLength(0);
  });
});

describe('period digest (deterministic)', () => {
  it('computes totals from seed data', () => {
    const d = computePeriodDigest(); // all time
    expect(d.totals.engagements).toBeGreaterThanOrEqual(10);
    expect(d.totals.interactions).toBeGreaterThanOrEqual(28);
    expect(d.closedWon.length).toBeGreaterThanOrEqual(1);
    expect(d.closedLost.length).toBeGreaterThanOrEqual(1);
    expect(d.totals.officialUpdates).toBeGreaterThanOrEqual(4); // tagged/stamped notes in seed
  });

  it('respects date windows', () => {
    const none = computePeriodDigest('1990-01-01', '1990-12-31');
    expect(none.totals.interactions).toBe(0);
    expect(none.totals.engagements).toBe(0);
  });

  it('uses structured valueThemes for theme coverage', () => {
    const d = computePeriodDigest();
    expect(Object.keys(d.themeCoverage).length).toBeGreaterThanOrEqual(2);
    // every covered theme must come from at least one TR's structured field or description
    expect(Math.max(...Object.values(d.themeCoverage))).toBeGreaterThanOrEqual(1);
  });
});

describe('review scoping', () => {
  it('filters by role (pre-sale vs post-sale style)', async () => {
    const { buildContext } = await import('../src/services/review.js');
    const all = buildContext({});
    const leads = buildContext({ roles: ['Lead'] });
    expect(leads.trrCount).toBeGreaterThan(0);
    expect(leads.trrCount).toBeLessThan(all.trrCount);
    expect(leads.engagements).toContain('my role: Lead');
    expect(leads.engagements).not.toContain('my role: Supporting');
  });

  it('filters by theme overlap', async () => {
    const { buildContext } = await import('../src/services/review.js');
    // pick a theme from the seed and a TR that does NOT carry it
    const all = repo.listTrrs('all');
    const withTheme = all.find(t => t.valueThemes.length > 0)!;
    const theme = withTheme.valueThemes[0]!;
    const without = all.find(t => !t.valueThemes.includes(theme))!;
    const scoped = buildContext({ themes: [theme] });
    expect(scoped.trrCount).toBeGreaterThanOrEqual(1);
    expect(scoped.engagements).toContain(withTheme.customer);
    expect(scoped.engagements).not.toContain(without.customer);
  });

  it('date window excludes out-of-range interactions', async () => {
    const { buildContext } = await import('../src/services/review.js');
    const narrow = buildContext({ from: '1990-01-01', to: '1990-12-31' });
    expect(narrow.interactionCount).toBe(0);
  });

  it('scoped digest counts only in-scope interactions', () => {
    const all = computePeriodDigest();
    const scoped = computePeriodDigest(undefined, undefined, t => t.myRole === 'Lead');
    expect(scoped.totals.interactions).toBeLessThan(all.totals.interactions);
    expect(scoped.totals.engagements).toBeLessThan(all.totals.engagements);
  });
});

describe('review batching (map-reduce planning)', () => {
  it('derives slices from the configured window and keeps the call math honest', async () => {
    const { planReview, buildContext } = await import('../src/services/review.js');
    const before = repo.getSettings();
    try {
      repo.saveSettings({ ctxTokens: 1_500, reviewReserveTokens: 200 });
      const plan = planReview(['q1', 'q2'], {});
      const ctx = buildContext({});
      expect(plan.trrCount).toBe(ctx.trrCount); // same scope either way
      if (plan.corpusChars > plan.batchBudgetChars) {
        expect(plan.batches).toBeGreaterThan(1);
        expect(plan.mapCalls).toBe(plan.questions * plan.batches);
      } else {
        expect(plan.batches).toBe(1);
        expect(plan.mapCalls).toBe(0);
      }
      expect(plan.totalCalls).toBe(plan.mapCalls + plan.reduceCalls);
    } finally {
      repo.saveSettings({ ctxTokens: before.ctxTokens, reviewReserveTokens: before.reviewReserveTokens });
    }
  });

  it('skips the map pass when the whole scope fits one window', async () => {
    const { planReview } = await import('../src/services/review.js');
    const before = repo.getSettings();
    try {
      repo.saveSettings({ ctxTokens: 200_000, reviewReserveTokens: 2_000 });
      const plan = planReview(['q1', 'q2'], {});
      expect(plan.batches).toBe(1);
      expect(plan.mapCalls).toBe(0);
      expect(plan.totalCalls).toBe(2); // one reduce per question, nothing else
    } finally {
      repo.saveSettings({ ctxTokens: before.ctxTokens, reviewReserveTokens: before.reviewReserveTokens });
    }
  });

  it('flags a run that would blow the call budget instead of silently running it', async () => {
    const { planReview } = await import('../src/services/review.js');
    const before = repo.getSettings();
    try {
      repo.saveSettings({ reviewMaxCalls: 1 });
      const plan = planReview(['a', 'b', 'c'], {});
      expect(plan.totalCalls).toBeGreaterThan(1);
      expect(plan.overCallBudget).toBe(true);
    } finally {
      repo.saveSettings({ reviewMaxCalls: before.reviewMaxCalls });
    }
  });
});

describe('text search', () => {
  it('finds seeded notes via FTS', () => {
    const hits = textSearch('failover');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet).toContain('<mark>');
  });

  it('escapes note content in snippets', () => {
    const id = uid();
    repo.insertTrr({
      id, customer: 'XSS Co', title: 'x', status: 'New', complexity: 'Simple',
      priority: 'Low', contact: '', rep: '', targetClose: '', description: '',
      myRole: '', outcome: '', valueThemes: [],
      deactivated: false, deactivatedAt: '', createdAt: new Date().toISOString(), lastContact: '',
    });
    repo.insertInteraction({
      id: uid(), trrId: id, type: 'Note', date: '2026-07-02',
      note: 'zebra <script>alert(1)</script> zebra',
      aiExec: '', aiCust: '', sensitive: false, createdAt: new Date().toISOString(),
    });
    const hits = textSearch('zebra');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet).not.toContain('<script>');
    expect(hits[0]!.snippet).toContain('&lt;script&gt;');
    repo.deleteTrr(id);
  });
});

describe('backup & restore', () => {
  it('creates a valid, complete snapshot', async () => {
    const { createBackup, listBackups, backupPath, validateSnapshot } = await import('../src/services/backup.js');
    const before = repo.counts();
    const b = createBackup('test');
    expect(b.bytes).toBeGreaterThan(10_000);
    expect(listBackups().some(x => x.name === b.name)).toBe(true);
    const p = backupPath(b.name)!;
    expect(validateSnapshot(p)).toEqual({ ok: true });
    // snapshot contains the same data
    const Database = (await import('better-sqlite3')).default;
    const snap = new Database(p, { readonly: true });
    const n = (snap.prepare('SELECT count(*) n FROM trrs').get() as { n: number }).n;
    snap.close();
    expect(n).toBe(before.trrs);
  });

  it('prunes to the retention limit', async () => {
    const { createBackup, listBackups, pruneBackups } = await import('../src/services/backup.js');
    createBackup('test'); createBackup('test'); createBackup('test');
    pruneBackups(2);
    expect(listBackups().length).toBe(2);
  });

  it('rejects garbage uploads', async () => {
    const { stageRestore } = await import('../src/services/backup.js');
    const r = stageRestore(Buffer.from('this is not a sqlite database at all, not even close'));
    expect(r.ok).toBe(false);
  });

  it('refuses path traversal in backup names', async () => {
    const { backupPath } = await import('../src/services/backup.js');
    expect(backupPath('../../etc/passwd')).toBeNull();
    expect(backupPath('..%2Fescape.db')).toBeNull();
  });

  it('boot-time swap promotes a staged restore with a safety copy', async () => {
    const { swapPendingRestore } = await import('../src/db/index.js');
    const { mkdtempSync, writeFileSync, readFileSync, readdirSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'trr-swap-'));
    const dbPath = join(dir, 'app.db');
    writeFileSync(dbPath, 'OLD');
    writeFileSync(join(dir, 'restore-pending.db'), 'NEW');
    expect(swapPendingRestore(dbPath)).toBe(true);
    expect(readFileSync(dbPath, 'utf8')).toBe('NEW');
    expect(readdirSync(dir).some(f => f.startsWith('pre-restore-'))).toBe(true);
    expect(swapPendingRestore(dbPath)).toBe(false); // nothing staged now
  });
});

// NOTE: destructive — keep this block LAST in the file.
describe('demo data management', () => {
  it('removes exactly the seeded demo data, then reseeds', () => {
    const before = repo.counts();
    expect(repo.seededTrrIds().length).toBeGreaterThanOrEqual(10);
    const removed = repo.removeSeedData();
    expect(removed).toBeGreaterThanOrEqual(10);
    const after = repo.counts();
    expect(after.trrs).toBe(before.trrs - removed);
    expect(repo.seededTrrIds()).toHaveLength(0);
    // load-demo works again on an empty db
    if (after.trrs === 0) {
      expect(seedIfEmpty()).toBe(true);
      expect(repo.counts().trrs).toBeGreaterThanOrEqual(10);
    }
  });

  it('erases everything but keeps settings', () => {
    repo.saveSettings({ greenDays: 7 });
    repo.eraseAllData();
    const c = repo.counts();
    expect(c.trrs).toBe(0);
    expect(c.interactions).toBe(0);
    expect(c.digests).toBe(0);
    expect(repo.getSettings().greenDays).toBe(7); // settings survive
  });
});

describe('html escaping', () => {
  it('escapes the usual suspects', () => {
    expect(esc(`<a href="x" onclick='y'>&`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
  });
});
