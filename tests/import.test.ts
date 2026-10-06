import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Import: parsing, mapping, normalising, plan / apply / undo. Own throwaway DB, no model server.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'trr-imp-')), 'test.db');

const repo = await import('../src/db/repo.js');
await import('../src/db/index.js');
const imp = await import('../src/services/importer.js');
type FieldKey = import('../src/services/importer.js').FieldKey;

const TODAY = '2026-10-06';

beforeAll(() => {
  repo.saveSettings({ aiEnabled: false });
  repo.eraseAllData();
});

describe('parsing', () => {
  it('reads a Sheets copy (tabs) with a quoted multi-line cell', () => {
    const t = imp.parseTable('TR ID\tCustomer\tNotes\nTR-1\tAcme\t"line one\nline ""two"""\nTR-2\tBeta\tx')!;
    expect(t.format).toBe('tsv');
    expect(t.headerRow).toBe(true);
    expect(t.rows).toEqual([['TR-1', 'Acme', 'line one\nline "two"'], ['TR-2', 'Beta', 'x']]);
  });

  it('reads CSV and Markdown tables, and refuses prose', () => {
    expect(imp.parseTable('Customer,Title\nAcme,"Big, important"\nBeta,Small')!.rows[0]).toEqual(['Acme', 'Big, important']);
    const md = imp.parseTable('| Customer | Title |\n|---|---|\n| Acme | One |\n| Beta | Two |')!;
    expect(md.format).toBe('markdown');
    expect(md.rows).toEqual([['Acme', 'One'], ['Beta', 'Two']]);
    expect(imp.parseTable('Hi team, quick recap of the week. We met Acme on Tuesday, and Beta on Thursday.\nMore next week.')).toBeNull();
  });

  it('drops empty columns and spots a header-less table by its TR IDs', () => {
    const t = imp.parseTable('TR-100\t\tAcme\nTR-101\t\tBeta')!;
    expect(t.headers.length).toBe(2);
    expect(t.headerRow).toBe(false);
    expect(imp.heuristicMapping(t)[0]).toBe('trId');
  });
});

describe('mapping and values', () => {
  it('maps common header names', () => {
    const m = ['TR #', 'Account', 'Opp', 'Request', 'Prio', 'Parent TR', 'Latest Update', 'Date Opened'].map(imp.guessField);
    expect(m).toEqual(['trId', 'customer', 'opportunity', 'title', 'priority', 'parentTrId', 'logNote', 'opened']);
  });

  it('demotes a "date" column that holds text', () => {
    const t = imp.parseTable('TR ID\tLast Updated\nTR-1\tcalled them, waiting\nTR-2\tsent the doc')!;
    expect(imp.sanitize(t, ['trId', 'lastContact'])).toEqual(['trId', 'logNote']);
  });

  it('parses the dates people paste', () => {
    const d = (s: string) => imp.parseDate(s, TODAY);
    expect(d('2026-10-01')).toBe('2026-10-01');
    expect(d('10/1/2026')).toBe('2026-10-01');
    expect(d('25/9/2026')).toBe('2026-09-25');          // day first when it must be
    expect(d('10/1')).toBe('2026-10-01');
    expect(d('12/20')).toBe('2025-12-20');               // no year, would be future: last year
    expect(d('Oct 1, 2026')).toBe('2026-10-01');
    expect(d('Thu, Oct 1')).toBe('2026-10-01');
    expect(d('1-Oct-26')).toBe('2026-10-01');
    expect(d('46296')).toBe('2026-10-01');               // Sheets serial
    expect(d('Call 10 people')).toBe('');
    expect(d('2/30/2026')).toBe('');
  });

  it('splits a notes cell into dated entries', () => {
    const r = imp.splitDated('Context first.\n9/15 - workshops booked\n10/2: approved\nsecond line of it', TODAY);
    expect(r.undated).toBe('Context first.');
    expect(r.entries).toEqual([
      { date: '2026-09-15', note: 'workshops booked' },
      { date: '2026-10-02', note: 'approved\nsecond line of it' },
    ]);
  });
});

function draft(text: string, mapping?: FieldKey[], opts: Partial<import('../src/services/importer.js').ImportOptions> = {}) {
  const r = imp.createDraft(text, repo.getSettings(), false, 'test');
  expect(r.error).toBeUndefined();
  const d = imp.loadDraft(r.id)!;
  imp.saveChoices(r.id, mapping ?? d.mapping, { ...d.opts, ...opts });
  return r.id;
}

const SHEET = [
  ['TR #', 'Account', 'Opp', 'Request', 'Status', 'Prio', 'Parent TR', 'Latest Update', 'Flag'],
  ['TR-1', 'Acme Rail', 'SASE FY27', 'Program', 'WIP', 'P2', '', '"Kickoff.\n9/15 - workshops\n10/2: approved"', ''],
  ['TR-2', 'acme rail', '', 'Wave 1', 'New', '', 'TR-1', '10/1 – sites list', ''],
  ['', '', '', '', '', '', '', '10/3 – review booked', 'yes'],
  ['TR-9', '', '', 'Orphan', '', '', 'TR-404', '', ''],
].map(r => r.join('\t')).join('\n');

describe('plan, apply, undo', () => {
  it('plans a parent with children, continuation rows, flags and errors', () => {
    const id = draft(SHEET);
    const d = imp.loadDraft(id)!;
    const plan = imp.buildPlan(d.table, d.mapping, d.opts, repo.getSettings(), TODAY);
    const by = (l: string) => plan.items.find(i => i.label === l)!;
    expect(by('TR-1').action).toBe('create');
    expect(by('TR-1').fields.status).toBe('In Progress');
    expect(by('TR-1').fields.priority).toBe('High');
    expect(by('TR-1').customerNew).toBe(true);
    expect(by('TR-1').opportunityNew).toBe(true);
    expect(by('TR-1').undated).toBe('Kickoff.');          // no date anywhere: goes to the description
    expect(by('TR-2').parentKey).toBe('id:tr-1');
    expect(by('TR-2').logs.map(l => [l.date, l.flagged])).toEqual([['2026-10-01', false], ['2026-10-03', true]]);
    expect(by('TR-2').warnings.join()).not.toContain('customer');   // same customer as its parent
    expect(by('TR-9').action).toBe('error');
    expect(plan.newCustomers).toEqual(['Acme Rail']);
  });

  it('applies, is idempotent on a second paste, and undoes cleanly', () => {
    const before = repo.counts();
    const id = draft(SHEET);
    const { result } = imp.applyImport(id);
    expect(result.trrs.length).toBe(2);
    const p = repo.findTrrByExternalId('TR-1')!;
    const c = repo.findTrrByExternalId('TR-2')!;
    expect(c.parentId).toBe(p.id);
    expect(c.customerId).toBe(p.customerId);
    expect(p.description).toContain('Kickoff.');
    expect(p.lastContact).toBe('2026-10-02');
    const logs = repo.listInteractions(c.id);
    expect(logs.every(l => l.source === 'import')).toBe(true);
    expect(logs.find(l => l.date === '2026-10-03')!.sensitive).toBe(true);
    expect(repo.listHistory(p.id).some(h => h.field === 'imported')).toBe(true);

    // the same paste again: nothing new
    const again = draft(SHEET);
    const d2 = imp.loadDraft(again)!;
    const plan2 = imp.buildPlan(d2.table, d2.mapping, d2.opts, repo.getSettings(), TODAY);
    expect(plan2.counts.create + plan2.counts.update).toBe(0);
    expect(plan2.counts.dupLogs).toBe(0);                  // only counted on live rows
    expect(() => imp.applyImport(again)).toThrow(/Nothing to import/);
    repo.deleteImport(again);

    imp.undoImport(id);
    expect(repo.counts()).toEqual(before);
    expect(repo.getImport(id)!.status).toBe('undone');
  });

  it('updates an existing TR without blanking fields, and undo restores it', () => {
    const id0 = draft('TR ID\tCustomer\tTitle\tStatus\tContact\nTR-50\tZeta\tGateway\tNew\tDana');
    imp.applyImport(id0);
    const t = repo.findTrrByExternalId('TR-50')!;

    const id = draft('TR ID\tStatus\tContact\tNotes\nTR-50\tPOC\t\t2026-10-05 demo went well');
    const d = imp.loadDraft(id)!;
    const plan = imp.buildPlan(d.table, d.mapping, d.opts, repo.getSettings(), TODAY);
    expect(plan.items[0]!.action).toBe('update');
    expect(plan.items[0]!.changes.map(ch => ch.key)).toEqual(['status']);
    imp.applyImport(id);
    const u = repo.getTrr(t.id)!;
    expect(u.status).toBe('POC');
    expect(u.contact).toBe('Dana');
    expect(u.lastContact).toBe('2026-10-05');

    imp.undoImport(id);
    const back = repo.getTrr(t.id)!;
    expect(back.status).toBe('New');
    expect(back.lastContact).toBe('');
    expect(repo.listInteractions(t.id).length).toBe(0);
  });

  it('keeps a created TR on undo when activity was added after the import', () => {
    const id = draft('TR ID\tCustomer\tTitle\nTR-60\tOmega\tKeep me');
    imp.applyImport(id);
    const t = repo.findTrrByExternalId('TR-60')!;
    repo.insertInteraction({ id: 'later-log', trrId: t.id, type: 'Call', date: TODAY, note: 'logged by hand later', aiExec: '', aiCust: '', sensitive: false, createdAt: new Date().toISOString() });
    const r = imp.undoImport(id);
    expect(r.kept).toEqual([`#${t.num}`]);
    expect(repo.getTrr(t.id)).not.toBeNull();
  });

  it('honours "update existing" off and skipped rows', () => {
    const id = draft('TR ID\tStatus\tNotes\nTR-50\tClosed Won\t10/4 - note', undefined, { updateExisting: false });
    const d = imp.loadDraft(id)!;
    let plan = imp.buildPlan(d.table, d.mapping, d.opts, repo.getSettings(), TODAY);
    expect(plan.items[0]!.changes).toEqual([]);
    expect(plan.items[0]!.action).toBe('update');          // the log still goes in
    plan = imp.buildPlan(d.table, d.mapping, { ...d.opts, skip: [plan.items[0]!.key] }, repo.getSettings(), TODAY);
    expect(plan.items[0]!.action).toBe('skipped');
  });
});
