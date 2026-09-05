# Operator-Assisted Live Canary Checklist

This checklist documents the steps for a ONE controlled live canary post.
It is an external acceptance item — not automated in CI.

## Prerequisites

- [ ] Real Facebook account added and session healthy
- [ ] At least one active group assignment for that account
- [ ] Draft with READY status containing test content
- [ ] Queue item created from that draft targeting the assigned group
- [ ] Application built and running (dev or packaged)

## Pre-Canary Verification

1. [ ] Run DRY_RUN preflight on the queue item — verify PASSED
2. [ ] Confirm `Settings > Publishing > Execution Mode` is `DRY_RUN`
3. [ ] Confirm `Settings > Publishing > Canary Mode` is ON
4. [ ] Confirm scheduler is DISARMED
5. [ ] Run the queue item in DRY_RUN — verify preflight completes without errors
6. [ ] Open diagnostic screenshot and confirm Facebook Create Post dialog was found

## Live Canary Execution

7. [ ] Switch Execution Mode to `LIVE`
8. [ ] Keep Canary Mode ON (allows exactly 1 LIVE item per run)
9. [ ] Run the single queue item
10. [ ] Wait for the automated result
11. [ ] Record the result status (SUBMITTED / SUCCEEDED / FAILED / NEEDS_ATTENTION)

## Post-Canary Verification

12. [ ] If SUBMITTED: manually verify the post exists in the target Facebook group
13. [ ] If SUBMITTED: mark as VERIFIED with evidence (post URL or screenshot description)
14. [ ] If SUCCEEDED: confirm automated verification detected the published post
15. [ ] If FAILED or NEEDS_ATTENTION: record the error code and diagnostic details
16. [ ] Switch Execution Mode back to `DRY_RUN`
17. [ ] Confirm scheduler remains DISARMED

## Reporting

- Record: date, account used, group targeted, result status, post URL (if published)
- This result is reported as an external acceptance item in the release notes
- CI does NOT require this canary to pass

## Safety Notes

> [!CAUTION]
> Never run the live canary with Canary Mode OFF — this would allow batch execution.
> Never arm the scheduler during canary testing.
> Always switch back to DRY_RUN immediately after the canary completes.
