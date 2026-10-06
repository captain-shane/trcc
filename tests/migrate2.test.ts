import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 2.x → 3.0 restructure wizard. Own throwaway DB, no model server.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'trr-mig-')), 'test.db');

const repo = await import('../src/db/repo.js');
await import('../src/db/index.js');
const mig = await import('../src/services/migrate2.js');
const { undoImport } = await import('../src/services/importer.js');
const { uid } = await import('../src/types.js');
type NewTrr = import('../src/types.js').NewTrr;

const flat = (over: Partial<NewTrr>) => {
  const t: NewTrr = {
    id: uid(), customer: 'Acme', title: 'Opp', status: 'In Progress', complexity: 'Simple', priority: 'Low',
    contact: '', rep: '', targetClose: '', description: '', myRole: '', outcome: '', valueThemes: [],
    deactivated: false, deactivatedAt: '', createdAt: new Date().toISOString(), lastContact: '', ...over,
  };
  repo.insertTrr(t);
  return t.id;
};

beforeAll(() => {
  repo.saveSettings({ aiEnabled: false });
  repo.eraseAllData();
});

describe('identifier pattern', () => {
  it('derives a pattern that tolerates case and separators, and normalises', () => {
    const re = new RegExp(mig.derivePattern('TRR123123'), 'gi');
    const hits = (s: string) => [...s.matchAll(re)].map(m => mig.normalizeId(m[0], 'TRR123123'));
    expect(hits('TRR400100 and trr-400101; see TRR 400102.')).toEqual(['TRR400100', 'TRR400101', 'TRR400102']);
    expect(hits('XTRR400103 TRR12 TRR4001039999')).toEqual([]);
    expect(mig.normalizeId('tr 10421', 'TR-10421')).toBe('TR-10421');
    expect(mig.compilePattern('(')).toBeNull();
  });
});

describe('restructure', () => {
  it('fills TR IDs, builds one opportunity + parent per title, and undoes exactly', () => {
    const a = flat({ customer: 'Acme', title: 'SASE rollout', description: 'Request TRR400100 for the pilot' });
    const b = flat({ customer: 'acme', title: 'SASE Rollout', description: 'follow-on, ref trr-400101' });
    const c = flat({ customer: 'Beta', title: 'Firewall refresh', description: 'mentions TRR400102 and TRR400103' });
    const d = flat({ customer: 'Beta', title: 'No id here', description: 'nothing', status: 'Closed Won' });
    const before = repo.counts();

    const { id } = mig.currentDraft();
    const opts = { ...mig.DEFAULT_MIGRATE, example: 'TRR123123', fields: ['title', 'description'] as import('../src/services/migrate2.js').MigrateField[], overrides: { [c]: 'TRR400103' } };
    mig.saveMigrateOptions(id, opts);
    const plan = mig.buildMigrationPlan(opts, repo.getSettings());
    expect(plan.counts.trrs).toBe(4);
    expect(plan.counts.newParents).toBe(3);           // "SASE rollout" (both Acme TRs), Firewall refresh, No id here
    const rowOf = (tid: string) => plan.groups.flatMap(g => g.rows).find(r => r.trr.id === tid)!;
    expect(rowOf(a).chosen).toBe('TRR400100');
    expect(rowOf(b).chosen).toBe('TRR400101');
    expect(rowOf(c).chosen).toBe('TRR400103');         // picked by hand over the first match
    expect(rowOf(d).chosen).toBe('');

    mig.applyMigration(id);
    const ta = repo.getTrr(a)!, tb = repo.getTrr(b)!;
    expect(ta.externalId).toBe('TRR400100');
    expect(ta.parentId).toBeTruthy();
    expect(tb.parentId).toBe(ta.parentId);
    const parent = repo.getTrr(ta.parentId)!;
    expect(parent.title).toBe('SASE rollout');
    expect(repo.getOpportunity(parent.opportunityId)!.name).toBe('SASE rollout');
    expect(ta.opportunityId).toBe(parent.opportunityId);
    expect(ta.title).toBe('SASE rollout');            // titles are kept
    expect(repo.getTrr(d)!.parentId).toBeTruthy();    // closed TRs included by default
    expect(repo.v2UpgradeState()).toBe('done');
    expect(repo.listHistory(a).some(h => h.field === 'restructured')).toBe(true);

    // a second run finds nothing flat
    const again = mig.currentDraft();
    expect(mig.buildMigrationPlan({ ...mig.DEFAULT_MIGRATE, example: 'TRR123123' }, repo.getSettings()).counts.trrs).toBe(0);
    repo.deleteImport(again.id);

    undoImport(id);
    expect(repo.counts()).toEqual(before);
    for (const tid of [a, b, c, d]) {
      const t = repo.getTrr(tid)!;
      expect([t.externalId, t.parentId, t.opportunityId]).toEqual(['', '', '']);
    }
    expect(repo.v2UpgradeState()).toBe('pending');
  });

  it('suggests the identifier shapes found in the data', () => {
    const shapes = mig.suggestShapes(['description']);
    expect(shapes[0]!.shape).toBe('TRR + 6 digits');
    expect(shapes[0]!.trrs).toBe(3);             // TRR400100, trr-400101 and TRR400102 are one shape
    expect(shapes[0]!.example).toBe('TRR400100');
  });
});
