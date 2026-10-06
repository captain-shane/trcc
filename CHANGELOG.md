# Changelog

All notable changes to TR Command Center are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

House rule, shared across these repos and **not** strict SemVer: fixes and gap-fills
that a user can observe are **minor**, not patch.

## [Unreleased]

## [3.0.0] - 2026-10-06

The data model grows a hierarchy, and weekly reporting becomes a workflow.
**Major** because the core model changes and the schema migration (v6) is
forward-only: going back to 2.x code means restoring a pre-upgrade backup.
The migration is additive — no column is dropped, `trrs.customer` is kept and
kept in sync — so existing data, settings, and templates carry over untouched.

### Added
- **Customer → Opportunity → TR → child TRs.** Customers become records
  (existing free-text names are folded case- and whitespace-insensitively;
  the earliest spelling wins). Opportunities group TRs per customer. A TR can
  have child TRs — one level — and a child always inherits its parent's
  customer and opportunity.
- **TR ID** on every TR: the request's number in your upstream system.
- **One log, several TRs.** "Also applies to" links an interaction to related
  TRs; it shows on each, updates each one's last contact, and counts toward
  each one's weekly update.
- **Update Desk** (`/updates`). Due day (default Thursday) and default cadence
  in Settings, per-TR override (weekly / every two weeks / none). States:
  overdue, due, draft ready, posted, not due — each with its own shape, never
  colour alone. The window for an update is everything logged since that TR's
  last *posted* update, so a missed week rolls forward. AI or plain drafts,
  hand edits, "Draft all missing" in the background, one paste-ready block for
  the whole cycle with a list of who is missing, "Mark posted" (optionally
  logged as an official-record note), and past cycles to see who never got one.
- **Summary to date** for a TR, a parent + children, an opportunity, or a
  customer — versioned and incremental, run in the background with progress.
- **Accounts** page and per-customer / per-opportunity pages, with customer
  rename, merge (for duplicate free-text names), and opportunity editing.
- **Parent health follows its children.** A parent TR carries the
  project-management side (assignments, resourcing, coordination notes) while
  the work is logged on its children, so its Green/Yellow/Red uses the most
  recent contact across the family — any active child means the request is
  being worked. The tooltip and card say which child carries it; children keep
  their own health, and stalled children are still counted on the parent card.
- **Dashboard views**: *Families* (parent cards with their children);
  *Customer grid* (one tile per customer, worst health first, TRs grouped by
  opportunity with health counts); *Tree* (collapsible Customer › Opportunity ›
  Parent › Child with status, priority, role and last note); *Requests* (only
  the TRs that carry the work, children and standalone TRs, each showing the
  parent it belongs to). Breadcrumbs on every TR.
- **Inline edits** on the TR page (status, priority, outcome, role) and an
  in-page log form.
- **Flagged logs are never passed to AI.** The old "Sensitive" checkbox is now
  🚩 *Flag this log (won't be passed to AI)* and it is enforced everywhere a model
  is called: per-note AI, exec-summary backfill, catch-up digests, period and
  review narratives (including the official record), weekly drafts, summaries,
  and semantic-search embeddings. Models see a "[flagged entry — content
  withheld]" placeholder at most. Flagging a log clears any AI text already made
  from it; plain (non-AI) weekly drafts mark the entry without quoting it.
  Before 3.0 the flag was only a badge.
- **Opportunity audit trail.** Every opportunity move is recorded on the TR — and
  on each child, marked "via parent #N", when a parent moves — plus opportunity
  renames, stage changes, and deletes (TRs become unassigned, with a record).
  The opportunity page shows its own trail of TRs moved in and out.
- `TZ` in docker-compose so due days follow your calendar, not UTC.
- API: `/api/updates` (the desk as JSON), `/api/customers`; `/api/export` now
  includes customers, opportunities, links, updates, and summaries.

### Changed
- The Reports page's weekly text moved behind the Update Desk; a last-7-days
  activity snapshot remains there.
- The TR page's "Catch me up" panel is now the TR-level summary to date
  (it still writes the digest shown on the Digests page).
- A parent TR that has children is left off the Update Desk by default — it
  reports through its children — unless it sets its own cadence.

## [2.2.0] - 2026-08-08

### Added
- **The version is now visible in the app.** A footer on every page shows the build,
  and `/healthz` reports the same value — so a user and an operator can confirm they
  are looking at the same build before comparing notes.

### Fixed
- **`/healthz` reported a hardcoded `2.0.0`.** It was a string literal in `server.ts`,
  so it went stale the moment `package.json` moved and would have kept reporting 2.0.0
  forever. Version is now read from `package.json` at startup as the single source.


## [2.1.0] - 2026-08-08

### Added
- **Colour-blind-safe health indicators.** Each state now carries a distinct *shape* as
  well as a colour, so status is legible without colour discrimination.
- `UPGRADE.md` — a safe in-place upgrade runbook.
- `SECURITY.md` — private vulnerability reporting policy.

## [2.0.0]

Shipped publicly on 2026-07-20 and went live internally the following day, but was
released **untagged** — `package.json` declared `2.0.0` with no corresponding tag and no
changelog, so this section is reconstructed from git history rather than from a release
record. The exact 2.0.0 boundary is therefore approximate, and no `v2.0.0` tag has been
created retroactively rather than invent one.

### Added
- TR Command Center — local-first Technical Request tracking.
- Backups and restore: snapshots, daily automatic backup, validated restart-swap
  restore, and `/api/backups` listing, with operational guidance and recovery docs.
- Review engine scaled via map-reduce chunking over the record.

### Note
- The v1 lineage predates this repository. v1 data was migrated into the v2 instance;
  that history is not represented here.
