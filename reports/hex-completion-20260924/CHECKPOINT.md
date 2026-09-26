# Hex completion checkpoint — 2026-09-24

Source: `handoff/codex-20260924` at `8ebdc35b6`; initial product base `a5fd5618`.
The original A–J acceptance contract is in `reports/handoff-codex-20260924/ORIGINAL_REQUEST.md` on the handoff branch.

Status: **IN PROGRESS**. This living integration branch accepts one verified product change at a time. This checkpoint is an evidence ledger, not a completion claim. No `DONE`, freeze, or merge-readiness claim is valid until every row below has a concrete changed-file inventory, exact candidate merge tree, focused and broad validation, current-main reconciliation, and refetched-main proof.

## Acceptance ledger

| Item | Required evidence | Current state |
| --- | --- | --- |
| A — OpenMW | Production fix, focused regression, rerun, `result.json` | **BLOCKED / NOT PRESENT IN THIS HEAD** |
| B — FAST tail | General optimization, before/after equivalence, repeated p50/p95/p99 | **BLOCKED / NOT PRESENT IN THIS HEAD** |
| C — #9520 | Phase-split source/backup identity guards, regressions, closeout | **BLOCKED / NOT PRESENT IN THIS HEAD** |
| D — C++ projection | RTTI→vtable→slot→virtual target→receiver/class→field/member/type projection plus matched debug holdout | **BLOCKED / NOT PRESENT IN THIS HEAD** |
| E — Pinpoint/Jev | Shortlist ≤255, truth retention, preference-only/fail-closed router, prospective holdout | **BLOCKED / NOT PRESENT IN THIS HEAD** |
| F — Latest-main weakness re-measure | Current values for goto/unstructured/unknown instructions/raw syntax/TU failures and targeted fixes | **BLOCKED / NOT PRESENT IN THIS HEAD** |
| G — 160-case ARM64 benchmark | Exact candidate set, toolchain/runtime identity, complete results | **BLOCKED / NOT PRESENT IN THIS HEAD** |
| H — Final real-game acceptance | OpenMW/OpenTTD reruns, crash count 0, result artifacts | **BLOCKED / NOT PRESENT IN THIS HEAD** |
| I — Final performance benchmark | Repeated FAST and real-game measurements with provenance | **BLOCKED / NOT PRESENT IN THIS HEAD** |
| J — Freeze | Zero unexplained blockers, focused/full gates green, final report committed, open critical/major issues 0 | **BLOCKED / NOT PRESENT IN THIS HEAD** |

## Verified baseline only

- `rhgrive3/actions` run `35899282597` succeeded for the OpenMW/OpenTTD baseline on `a5fd5618` and ran the 32-case FAST screen.
- Baseline totals: OpenMW `1,845` vtables / `2,564` typeinfos; OpenTTD `200` / `354`.
- These are historical baseline measurements, not current-main or final-product proof.
- Existing FAST PRs `#9552–#9554` are reviewed separately as main moves.
- Open issues `#9523`, `#9534`, and `#9550` remain external blockers owned by the user.

## Current-main reconciliation (still blocking)

`main` at `60aa41b5b` was merged into this integration branch at `889b42eaf`.
The generated userscript was rebuilt and committed at `2bf303289`, then a
second canonical build produced zero diff. The exact-head `semantic-v2` gate
failed in 13 places. The same 13 failure families occur on the exact current
`main` head, with zero new integration failures. The gate remains **BLOCKING**;
no component is accepted while it is red. Exact SHA, merge tree, changed-file
inventory, and failure comparison are in `MAIN_RECONCILIATION.json`.

## Merge gate

Keep this PR draft and non-mergeable until the acceptance ledger is filled with actual evidence. The next accepted commit must add one verified product change (not just another status update) and record its exact changed-file inventory, candidate merge tree, focused/broad validation, updated product head, and current-main/refetched-main proof. Do not treat a green fast gate or this checkpoint alone as acceptance evidence.
