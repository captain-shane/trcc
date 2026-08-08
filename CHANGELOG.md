# Changelog

All notable changes to TR Command Center are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

House rule, shared across these repos and **not** strict SemVer: fixes and gap-fills
that a user can observe are **minor**, not patch.

## [Unreleased]

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
