# Changelog

## 0.8.0 - Release Candidate

- Added reproducible GitHub Actions CI workflow for Windows runner (`.github/workflows/ci.yml`) covering typecheck, lint, test, and compilation.
- Added Database Release Integrity Verification service (`DatabaseIntegrityService`) checking `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, schema version (8), and schema table presence, with UI execution in About page.
- Added Campaign-aware operational traceability: surfaced Campaign name and Variant label in Queue rows, Queue detail modal, History table, and sanitized CSV/JSON exports.
- Added Schema-8 backup/restore regression coverage proving complete Campaign Workspace entities and queue linkage survive backup and restoration.
- Extended Release Diagnostics Bundle with OS platform info and campaign provenance while maintaining strict redaction of sensitive credentials.
- Added Release Artifact Checksum Manifest generator (`scripts/release-manifest.mjs`) calculating SHA-256 digests for release outputs.
- Added Publishing Invariant Audit test suite (`PublishingInvariantAudit.test.ts`) ensuring `DRY_RUN`, canary mode, and bounded pacing safety defaults.
- Documented operator-assisted controlled Facebook live-canary checklist (`docs/CANARY_CHECKLIST.md`).

## Campaign Workspace V1
 
- Added Campaign Workspace V1 for multi-variant and multi-target campaign planning without duplicating the publishing engine.
- Implemented formal approval workflow: `DRAFT` → `IN_REVIEW` → `APPROVED` → `QUEUED` / `ARCHIVED`.
- Added stale-approved recovery cycle: allowed approved campaigns to explicitly transition back to `DRAFT` via `Request Changes` / `Reopen for Changes`, invalidating old simulations and clearing hashes for re-approval.
- Integrated strict content integrity hashing (`buildSnapshotHash`): post-approval draft or media changes immediately trigger `APPROVAL_STALE` and block execution.
- Added Queue-equivalent duplicate detection in simulation: identical planned targets (`draftId + hash + accountId + groupId + scheduledAt`) are blocked (`DUPLICATE_QUEUE_ITEM`, status `BLOCKED`).
- Aligned simulation schedule conflict detection with Planner: 15-minute conflict warnings across account for existing `PENDING`/`PAUSED` queue rows.
- Hardened provenance and deletion invariants: permanent queue item lineage preserved across `requeue()`, and campaign deletion restricted strictly to `DRAFT` status with zero historical queue references.
- Added read-only Queue Simulation providing pre-materialization conflict detection, planned row previews, and deterministic freshness tokens.
- Added transactional all-or-nothing "Commit to Queue" that materializes immutable queue rows under existing validation semantics.
- Extended Schema Migration to Version 8 with new tables `campaigns`, `campaign_variants`, and `campaign_plan_items`, and queue campaign linkage.
- Preserved complete backward compatibility for manual and legacy queue items.

## 0.7.0 - Production Operations V2

- Added controlled scheduler arming, overdue review, per-session caps, and stop-after-current behavior.
- Added workload planning, transactional queue batch controls, operational health summaries, history, and sanitized exports.
- Hardened managed media validation and upload readiness reporting without claiming live media compatibility.
- Added managed database backup/restore, local storage maintenance, Dashboard V2, and release information.

## Earlier milestones

- Account Manager: isolated persistent profiles, fixed proxies, lifecycle health, and audit logs.
- Content Workspace: groups, assignments, drafts, managed media, and immutable queue snapshots.
- Publishing Engine: visible-browser preflight and publishing with atomic claims and reconciliation.
- Canary safety: explicit LIVE safeguards, selector probes, and no-submit DRY_RUN behavior.
- Live text publishing: validated Facebook group, Create Post dialog, Lexical editor, and text-only submission flow.
