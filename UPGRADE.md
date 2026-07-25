# Upgrading TR Command Center

## The one rule: your data is on a volume, not in the image

The SQLite database **and all backups** live on the Docker named volume
**`trr-data`** (mounted at `/app/data`). The container image is disposable —
pulling new code, rebuilding the image, and recreating the container never
touch the volume. That is exactly what makes an in-place upgrade safe.

**The only way to lose data is to delete that volume.** So:

| Safe — keeps the volume | ❌ Destroys data |
|---|---|
| `docker compose up -d --build` | `docker compose down -v`  ← the `-v` deletes the volume |
| `docker compose restart` | `docker volume rm <project>_trr-data` |
| `docker compose stop` / `start` | `docker volume prune` / `docker system prune --volumes` |
| `docker compose down` (no `-v`) | changing `DB_PATH` to point off the volume |

If you ever see the app come up "empty" after an upgrade, you did **not** lose
data — you're almost certainly pointing at a *different* volume or `DB_PATH`.
Stop, don't add data, and check the volume mount before anything else.

## Safe upgrade — the runbook

```bash
# 1. Back up FIRST (always) — takes a consistent snapshot even while running.
#    App: Settings → Backups → "Back up now", or:
curl -s -X POST http://localhost:3000/data/backup-now
#    Snapshots land in  data/backups/*.db  on the volume (VACUUM INTO).

# 2. Get the new code.
cd /opt/trcc
git fetch origin && git reset --hard origin/palo-alto     # or origin/main for the agnostic flavor

# 3. Rebuild in place. The running container keeps serving until the new
#    image is built, then compose swaps it. The volume is reused.
docker compose up -d --build

# 4. Verify.
docker compose ps                       # trcc = Up (healthy)
curl -s http://localhost:3000/healthz   # {"ok":true,"trrs":N,"interactions":M,...}
```

Confirm the `trrs` / `interactions` counts match what you expect. Schema
**migrations run automatically at boot** — they are versioned (`user_version`),
forward-only, and idempotent, so restarting on the same or newer code is safe.

## Rollback

- **Bad build, no schema change you care about** — roll the code back:
  ```bash
  cd /opt/trcc && git reset --hard <previous-sha> && docker compose up -d --build
  ```
- **A migration changed the database and you want the prior state** — roll the
  code back as above, **then restore the pre-upgrade snapshot** (Settings →
  Backups → Restore; it is staged and swapped in at the next boot, with a safety
  copy kept). Migrations are forward-only, so downgrading code *without*
  restoring the DB can leave the schema ahead of the code — restore the snapshot
  to bring them back in sync.

## What backups do and do not protect

- In-app backups (`data/backups/`) guard against **bad migrations, fat-finger
  edits, and app-level corruption** — restore in seconds.
- They do **NOT** protect against **volume deletion** or **loss of the whole
  container / host** — they sit on the same volume as the live database.
- For disaster protection, do at least one of:
  - copy backups **off the box** on a schedule (`GET /api/backups` → download the
    newest from `data/backups/` → NAS / another host), and/or
  - snapshot the whole container at the hypervisor (e.g. a Proxmox/PVE backup
    job for the container).

## Fresh install vs upgrade

- **First run** on an empty volume seeds demo data (disable with
  `SEED_ON_EMPTY=false`).
- **Upgrade** never re-seeds — seeding only happens when the database is empty.
