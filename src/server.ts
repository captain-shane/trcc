import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
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
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false, limit: '5mb' })); // large pasted notes are a first-class use case

// Vendored client JS + static assets (no CDN, no build step)
app.use('/vendor', express.static(join(__dirname, '..', 'public', 'vendor'), { maxAge: '7d' }));
app.use('/css', express.static(join(__dirname, '..', 'public', 'css')));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, version: '2.0.0', ...counts() });
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

app.listen(config.port, () => {
  const c = counts();
  console.log(`TR Command Center v2 on :${config.port}`);
  console.log(`  db:     ${config.dbPath} (${c.trrs} TRRs / ${c.interactions} interactions)`);
  console.log(`  local models: ${config.aiUrl}`);
});
