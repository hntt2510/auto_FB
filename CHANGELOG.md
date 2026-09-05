# Changelog

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
