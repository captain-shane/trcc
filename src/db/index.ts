import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config } from '../config.js';

// Single connection, synchronous access — ideal for a local single-user app.
mkdirSync(dirname(config.dbPath), { recursive: true });

// --- Restore swap (runs BEFORE the database is opened) ----------------------
// If a validated restore is staged (services/backup.ts), swap it in now:
// keep a safety copy of the current database, then promote the staged file.
export function swapPendingRestore(dbPath: string): boolean {
  const dir = dirname(resolve(dbPath));
  const pending = join(dir, 'restore-pending.db');
  if (!existsSync(pending)) return false;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  if (existsSync(dbPath)) copyFileSync(dbPath, join(dir, `pre-restore-${stamp}.db`));
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  renameSync(pending, dbPath);
  console.log(`Restore applied from staged snapshot (safety copy: pre-restore-${stamp}.db)`);
  return true;
}

swapPendingRestore(config.dbPath);

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Versioned migrations. Each entry runs at most once, tracked in user_version.
const migrations: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE trrs (
    id             TEXT PRIMARY KEY,
    customer       TEXT NOT NULL,
    title          TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'New',
    complexity     TEXT NOT NULL DEFAULT 'Simple',
    priority       TEXT NOT NULL DEFAULT 'Medium',
    contact        TEXT NOT NULL DEFAULT '',
    rep            TEXT NOT NULL DEFAULT '',
    target_close   TEXT NOT NULL DEFAULT '',
    description    TEXT NOT NULL DEFAULT '',
    my_role        TEXT NOT NULL DEFAULT '',
    outcome        TEXT NOT NULL DEFAULT '',
    value_theme    TEXT NOT NULL DEFAULT '',
    deactivated    INTEGER NOT NULL DEFAULT 0,
    deactivated_at TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL,
    last_contact   TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE interactions (
    id         TEXT PRIMARY KEY,
    trr_id     TEXT NOT NULL REFERENCES trrs(id) ON DELETE CASCADE,
    type       TEXT NOT NULL DEFAULT 'Call',
    date       TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    ai_exec    TEXT NOT NULL DEFAULT '',
    ai_cust    TEXT NOT NULL DEFAULT '',
    sensitive  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_interactions_trr ON interactions(trr_id, date);

  CREATE TABLE digests (
    trr_id       TEXT PRIMARY KEY REFERENCES trrs(id) ON DELETE CASCADE,
    customer     TEXT NOT NULL,
    title        TEXT NOT NULL,
    status       TEXT NOT NULL,
    interactions INTEGER NOT NULL,
    first        TEXT NOT NULL DEFAULT '',
    last         TEXT NOT NULL DEFAULT '',
    summary      TEXT NOT NULL,
    model        TEXT NOT NULL DEFAULT '',
    generated_at TEXT NOT NULL
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE embeddings (
    interaction_id TEXT NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
    chunk_index    INTEGER NOT NULL,
    chunk_text     TEXT NOT NULL,
    model          TEXT NOT NULL,
    vector         BLOB NOT NULL,
    PRIMARY KEY (interaction_id, chunk_index)
  );

  -- Full-text search over interaction notes, kept in sync by triggers.
  CREATE VIRTUAL TABLE interactions_fts USING fts5(
    note, content='interactions', content_rowid='rowid'
  );
  CREATE TRIGGER interactions_ai AFTER INSERT ON interactions BEGIN
    INSERT INTO interactions_fts(rowid, note) VALUES (new.rowid, new.note);
  END;
  CREATE TRIGGER interactions_ad AFTER DELETE ON interactions BEGIN
    INSERT INTO interactions_fts(interactions_fts, rowid, note) VALUES ('delete', old.rowid, old.note);
  END;
  CREATE TRIGGER interactions_au AFTER UPDATE OF note ON interactions BEGIN
    INSERT INTO interactions_fts(interactions_fts, rowid, note) VALUES ('delete', old.rowid, old.note);
    INSERT INTO interactions_fts(rowid, note) VALUES (new.rowid, new.note);
  END;
  `,
  // v2 — audit trail of TRR field changes (status/complexity/priority/role/
  // outcome/themes/deactivation), so a project's shifts are traceable
  // from start to finish.
  `
  CREATE TABLE trr_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    trr_id     TEXT NOT NULL REFERENCES trrs(id) ON DELETE CASCADE,
    changed_at TEXT NOT NULL,
    field      TEXT NOT NULL,
    old_value  TEXT NOT NULL DEFAULT '',
    new_value  TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_history_trr ON trr_history(trr_id, changed_at);
  `,
  // v3 — persisted period reports: a period digest run (stats + narrative)
  // is a report worth keeping, not a throwaway page fragment.
  `
  CREATE TABLE period_reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    from_date    TEXT NOT NULL DEFAULT '',
    to_date      TEXT NOT NULL DEFAULT '',
    stats_json   TEXT NOT NULL,
    narrative    TEXT NOT NULL DEFAULT '',
    model        TEXT NOT NULL DEFAULT '',
    generated_at TEXT NOT NULL
  );
  `,
  // v4 — the review engine: free-form questions answered by the big model
  // against a scoped slice of the engagement record. Runs persist for later
  // processing (self-evals, 6-month reviews, retros).
  `
  CREATE TABLE reviews (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    questions    TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    scope_json   TEXT NOT NULL,
    answers      TEXT NOT NULL,
    model        TEXT NOT NULL DEFAULT '',
    generated_at TEXT NOT NULL
  );
  `,
  // v5 — short human-friendly TRR numbers (#1, #42): customer names are too
  // long to work with at scale; numbers give a compact handle for filtering
  // and range selection ("3, 5, 9-12").
  `
  ALTER TABLE trrs ADD COLUMN num INTEGER NOT NULL DEFAULT 0;
  UPDATE trrs SET num = (
    SELECT COUNT(*) FROM trrs t2
    WHERE t2.created_at < trrs.created_at
       OR (t2.created_at = trrs.created_at AND t2.id <= trrs.id)
  );
  `,
];

export const MIGRATION_COUNT = migrations.length;

export function migrate(): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

migrate();
