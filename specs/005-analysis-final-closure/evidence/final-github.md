# T043 GitHub observation after the performance handoff

Observation: 2026-09-08. **PENDING**, not protected-main admission.

PR [#7097](https://github.com/rhgrive3/hex-ida/pull/7097) was observed at
`4f49c3d5ebf707b4074e35cb10ca2d5e3f11d1c4`. All six CircleCI status contexts
passed on that SHA. CodeRabbit's separate success means Draft review skipped,
not approval. The PR remains OPEN/Draft and GitHub reports CONFLICTING.
The main commit selected for one reconciliation is
`5ba6f468e7fc2ff59f383146a1ebe3a2ca50cf71`; the independently verified 97621
checkout and the published performance handoff remain unchanged.

The PR description has been updated to the completed 97621 canonical check,
browser/shadow results, the later focused jsonSafe validation, generated handoff,
and the owner's performance transfer. Each result retains its own source SHA;
the description does not label an older source as the current PR head.

## Complete remote inventory and remaining findings

Paginated API captures contain **16 review records, 9 issue comments, and 0
inline review comments**. The GraphQL thread collection is also empty with
`hasNextPage: false`. All 16 review records are COMMENTED; no APPROVED review
was observed. Review text requesting changes remains actionable even though
the API's formal state is COMMENTED.

The earlier 10 reviews and 5 comments are inventoried in `stage-a-github.md`.
Their server-enforcement, final-product identity and reconciliation findings
remain applicable. The additional records are classified below.

| Record ID | Classification | Disposition |
| --- | --- | --- |
| Review 5140170402 | HISTORICAL BUT CURRENTLY APPLICABLE | Earlier full-check observation has been superseded; required server admission and a reconciled final product remain outstanding. |
| Review 5140715360 | ALREADY FIXED + ACTIONABLE/CURRENT | Stale PR-body source labeling is corrected. Exact final-product proof and server-required admission remain outstanding. |
| Review 5141310300 | ALREADY FIXED + ACTIONABLE/CURRENT | Stale body and old CI observations are superseded; reconciliation and server enforcement remain outstanding. |
| Review 5141909008 | ALREADY FIXED + ACTIONABLE/CURRENT | Repaired-source full check and generated output now have scoped results; final performance, external provenance, active deployment and admission are not complete. |
| Review 5142613198 | ALREADY FIXED + ACTIONABLE/CURRENT | PR body now distinguishes tested sources and completed results; final release requirements remain outstanding. |
| Review 5142651360 | ALREADY FIXED + ACTIONABLE/CURRENT | 97621 canonical check finished PASS. Cold 379.479ms still exceeds 250ms and is transferred to the external performance lane; reconciliation and admission remain outstanding. |
| Comment 5584928682 | ACTIONABLE/CURRENT | Preserve #5997 untyped-unknown/no-bits and #5636 RISC invalid-FP-width regressions when absorbing main; do not assume overlapping hunks are equivalent. |
| Comment 5585106099 | ACTIONABLE/CURRENT | Verify preservation of the reported main #5997 fix; #5636/#5586 ownership/adoption requests are not resolved by silence. |
| Comment 5585564966 | ACTIONABLE/CURRENT | Check #5636 RISC-V validation, #5586 proven 1024-bit HVA plus official examples/unproven negative, and #4992 intrinsic byte snapshot preserving #6009 failure classification against actual main/candidate code. |
| Comment 5586360427 | ACTIONABLE/CURRENT | Preserve Darwin #5601 forceStack anonymous aggregate marker; keep this distinct from the separate explicit-alignment change. No outbound adoption agreement is inferred. |

These records are classified, not declared resolved. The reconciliation owner
has the concrete preservation requirements. No comment was posted or thread
resolved as part of this observation. Physical execution stays DEFERRED under
the owner's explicit amendment; review prose does not override that instruction.

## Server enforcement and next boundary

Ruleset 22276485 still has deletion, non-fast-forward and pull-request rules,
but **no required_status_checks rule**. PR #6991 remains OPEN/Draft at
`1d63baae25684e04d8539fd343d7d6b660f46cb1`, unmerged. The controller module
`tools/validation/final-head-admission.mjs` is absent from the pinned main
commit (GitHub contents API HTTP 404). The prepared bootstrap and protection
proposal have not been applied; the earlier requested adoption authorization
is still unanswered. Requiring the absent controller status first would create
an admission deadlock.

No main merge, deployment, protection change or release approval is claimed.
Performance work is not restarted in this lane. Remaining locally actionable
work is the pinned-main reconciliation and its affected checks, followed by
the applicable final-source proof when the external inputs are ready.

Raw API packet:
`/mnt/workspace/.dev-state/hex-development-batch/t043-github-4f49c3d5e/`
(`reviews.json`, `comments.json`, `inline.json`, `statuses.json`, `ruleset.json`).

## Pinned-main reconciliation completed

Merge `2d1d1b14b9943aedbda5d847d8d2e123cd05c0ac` (tree
`bb6d3cc47cc48555105ea92ffbd8f32394d0015f`) has parents `4f49c3d5e` and
the pinned main `5ba6f468e`. All six textual conflicts were resolved, retaining
both sides' package test commands and the campaign's development commands.
Three Luna Max owners completed the isolated reconciliation; root integrated
the clean merge by fast-forward. The performance handoff ref was not moved.

The added main regressions exposed two automatic-merge defects: untyped unknown
returns incorrectly gained a bits property (#5997), and Darwin HFA placement
used unvalidated explicit alignment (#7348). Both were repaired without changing
their test assertions. The seven ABI/decoder preservation files now pass
(29/29 tests). The ABI boundary suite passes 64/64, symbolic regressions pass
43/43, and the delegated discovery/Mach-O checks pass. A wide expression's
deserialization now uses the same connective factory with an array argument,
avoiding call-argument overflow without changing the node budget. The #5498
fixture uses the registered SolverBackend contract instead of a plain object.

Canonical generated output was refreshed from 2d1d1b14b (build PASS, 3.1s).
These are development reconciliation and focused-check results, not a full check
of the new product or fresh-main release admission. The 97621 full-check result
retains its original identity. Do not repeatedly reconcile unrelated newer main
changes while the external performance result and admission inputs are pending.
