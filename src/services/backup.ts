import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { db, MIGRATION_COUNT } from '../db/index.js';
import { config } from '../config.js';

// Backup & restore for the SQLite database.
//
// Backup: `VACUUM INTO` produces a consistent, compacted snapshot even while
// the app is running (WAL-safe). It captures EVERYTHING — TRs, interactions,
// history, digests, reports, reviews, settings, embeddings.
//
// Restore: an uploaded/selected snapshot is validated, then staged as
// `restore-pending.db`. The actual swap happens at next startup BEFORE the
// database is opened (see db/index.ts), with a safety copy of the previous
// database kept alongside. The restore endpoint exits the process so a
// supervisor (Docker `restart: unless-stopped`, systemd) brings it back up.

const dataDir = () => dirname(resolve(config.dbPath));
export const backupsDir = () => join(dataDir(), 'backups');
export const pendingPath = () => join(dataDir(), 'restore-pending.db');

const NAME_RE = /^[\w][\w.-]*\.db$/;

export interface BackupInfo {
  name: string;
  bytes: number;
  createdAt: string;
}

let seq = 0;
function stamp(): string {
  const d = new Date().toISOString().replace(/[-:.TZ]/g, '');
  return `${d.slice(0, 8)}-${d.slice(8, 14)}${d.slice(14, 17)}-${(seq++ % 1000).toString().padStart(3, '0')}`;
}

/** Create a consistent snapshot in the backups dir. Returns its info. */
export function createBackup(prefix = 'trcc-backup'): BackupInfo {
  mkdirSync(backupsDir(), { recursive: true });
  const name = `${prefix}-${stamp()}.db`;
  const path = join(backupsDir(), name);
  db.prepare('VACUUM INTO ?').run(path);
  const st = statSync(path);
  return { name, bytes: st.size, createdAt: st.mtime.toISOString() };
}

export function listBackups(): BackupInfo[] {
  if (!existsSync(backupsDir())) return [];
  return readdirSync(backupsDir())
    .filter(f => NAME_RE.test(f))
    .map(name => {
      const st = statSync(join(backupsDir(), name));
      return { name, bytes: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Resolve a backup name to its path, refusing traversal or odd names. */
export function backupPath(name: string): string | null {
  if (!NAME_RE.test(name)) return null;
  const p = join(backupsDir(), name);
  return existsSync(p) ? p : null;
}

export function deleteBackup(name: string): boolean {
  const p = backupPath(name);
  if (!p) return false;
  rmSync(p);
  return true;
}

/** Keep the newest `keep` backups, delete the rest. Returns pruned count. */
export function pruneBackups(keep: number): number {
  const extra = listBackups().slice(Math.max(1, keep));
  for (const b of extra) deleteBackup(b.name);
  return extra.length;
}

/** Validate that a file is a plausible database for this app. */
export function validateSnapshot(path: string): { ok: true } | { ok: false; reason: string } {
  let probe: InstanceType<typeof Database> | null = null;
  try {
    probe = new Database(path, { readonly: true, fileMustExist: true });
    const integrity = probe.pragma('integrity_check', { simple: true }) as string;
    if (integrity !== 'ok') return { ok: false, reason: `integrity check failed: ${integrity}` };
    const version = probe.pragma('user_version', { simple: true }) as number;
    if (version > MIGRATION_COUNT) {
      return { ok: false, reason: `snapshot schema v${version} is newer than this app (v${MIGRATION_COUNT}) — upgrade the app first` };
    }
    const hasTrrs = probe.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='trrs'`).get();
    if (!hasTrrs) return { ok: false, reason: 'not a TR Command Center database (no trrs table)' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  } finally {
    probe?.close();
  }
}

/**
 * Stage a snapshot for restore. The swap happens at next startup.
 * Source may be a raw buffer (upload) or an existing backup name.
 */
export function stageRestore(source: Buffer | { backupName: string }): { ok: true } | { ok: false; reason: string } {
  const tmp = join(dataDir(), `restore-incoming-${Date.now()}.db`);
  try {
    if (Buffer.isBuffer(source)) {
      writeFileSync(tmp, source);
    } else {
      const p = backupPath(source.backupName);
      if (!p) return { ok: false, reason: 'unknown backup' };
      copyFileSync(p, tmp); // snapshot files are closed; plain copy is fine
    }
    const v = validateSnapshot(tmp);
    if (!v.ok) {
      rmSync(tmp, { force: true });
      return v;
    }
    renameSync(tmp, pendingPath());
    return { ok: true };
  } catch (e) {
    rmSync(tmp, { force: true });
    return { ok: false, reason: (e as Error).message };
  }
}

/** Exit soon so the supervisor restarts us and the boot-time swap runs. */
export function scheduleRestartForRestore(): void {
  console.log('Restore staged — exiting for restart-swap.');
  setTimeout(() => process.exit(0), 800);
}
