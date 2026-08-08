import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config, APP_VERSION } from './config.js';
import './db/index.js';                    // opens DB + runs migrations
import { seedIfEmpty } from './db/seed.js';
import { counts, getSettings } from './db/repo.js';
import { enrichExecSummaries } from './services/digest.js';
import { pages } from './routes/pages.js';
import { actions } from './routes/actions.js';
import { api } from './routes/api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// First run on an empty database gets seed data so there's something to see.
// Disable with SEED_ON_EMPTY=false.
if ((process.env.SEED_ON_EMPTY ?? 'true') !== 'false') seedIfEmpty();

const app = express();
// Restore uploads arrive as a raw body on this one route (no multipart dep).
app.use('/data/restore', express.raw({ type: () => true, limit: '2gb' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false, limit: '5mb' })); // large pasted notes are a first-class use case

// Vendored client JS + static assets (no CDN, no build step)
app.use('/vendor', express.static(join(__dirname, '..', 'public', 'vendor'), { maxAge: '7d' }));
app.use('/css', express.static(join(__dirname, '..', 'public', 'css')));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, version: APP_VERSION, ...counts() });
});

app.use('/api', api);
app.use(pages);
app.use(actions);

app.use((_req, res) => res.status(404).send('Not found'));

// --- Auto-backfill scheduler -------------------------------------------------
// Drains the exec-summary backlog on a timer (settings.autoBackfillHours,
// 0 = off). Checked every 15 minutes; also runs once shortly after startup so
// a backlog never just sits there.
let lastBackfill = 0;
async function backfillTick(force = false): Promise<void> {
  const s = getSettings();
  if (!s.aiEnabled) return; // global AI off switch
  const hours = s.autoBackfillHours;
  if (!force && (hours <= 0 || Date.now() - lastBackfill < hours * 3_600_000)) return;
  lastBackfill = Date.now();
  try {
    const r = await enrichExecSummaries(25);
    if ('generated' in r && r.generated > 0) {
      console.log(`auto-backfill: generated ${r.generated}, ${r.remaining} remaining`);
    }
  } catch (e) {
    console.warn(`auto-backfill skipped: ${(e as Error).message}`);
  }
}
setInterval(() => void backfillTick(), 15 * 60_000);
setTimeout(() => void backfillTick(true), 2 * 60_000); // shortly after boot

// --- Daily auto-backup -------------------------------------------------------
import { createBackup, listBackups, pruneBackups } from './services/backup.js';

function maybeAutoBackup(): void {
  const s = getSettings();
  if (!s.autoBackupEnabled) return;
  const newest = listBackups()[0];
  if (newest && Date.now() - new Date(newest.createdAt).getTime() < 24 * 3_600_000) return;
  try {
    const b = createBackup('trcc-auto');
    pruneBackups(s.backupKeep);
    console.log(`auto-backup: ${b.name}`);
  } catch (e) {
    console.warn(`auto-backup failed: ${(e as Error).message}`);
  }
}
setInterval(maybeAutoBackup, 15 * 60_000);
setTimeout(maybeAutoBackup, 60_000); // shortly after boot

app.listen(config.port, () => {
  const c = counts();
  console.log(`TR Command Center v2 on :${config.port}`);
  console.log(`  db:     ${config.dbPath} (${c.trrs} TRRs / ${c.interactions} interactions)`);
  console.log(`  local models: ${config.aiUrl}`);
});
