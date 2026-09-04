# GitHub and Overlap Snapshot

**Observed**: 2026-09-04T01:39:27Z
**Repository**: `rhgrive3/hex-ida`
**Main**: `47f8a44469a5826b6199501a153a12439a280d13`
**Open pull requests**: 93 (`incomplete_results=false`)

## Primary pull requests

| PR | State | Exact head / base | Merge/check state | Campaign decision |
|---|---|---|---|---|
| #3255 | open, non-draft | head `e250c9fb45995ec924cf07e69dad863b732201d2`; base live main | dirty, non-rebaseable; accuracy/invariant/check-test/verify failed; no pending runs | Historical consumer source only. Do not promote or overwrite. Use reviewed minimal local delta on a clean campaign branch. |
| #3382 | merged | accepted main commit `47f8a444`; reviewed head `7481cb653da1e41316712d0dd7434f1059b71899`; base `60980a3c` | reviewed head had failed accuracy/invariants/check/semantic/exact/candidate gates | Preserve as merged production input. Repair remaining `apply_damage` and add a permanent process regression; do not claim the historical evidence was green. |
| #3421 | open | head `0f4d1898bc530bb612d2eec84de618e2a480635d`; base is #3255 head | multiple failed accuracy/invariant/guardrail/exact/ownership checks | Stale/red C4-03 evidence source; reconcile selectively after Stage A. |
| #3422 | open | head `5e95490977249730a8d38b35cf583b78b3823cdb`; base is C4-03 integration | multiple failed accuracy/invariant/semantic/ownership/exact/candidate checks | Stale/red C4-04 evidence source; depends on reconciled C4-03. |
| #3425 | open | head `128542c7bd2a3c648eef01205709ce8c5a487e31`; old main base `835f5f03` | zero GitHub check runs | One active ME authority. Reconcile recovery evidence there/current main; absence of checks is not green. |

All ten dated recovery heads have zero GitHub check runs. No open PR head equals
a dated recovery head or any local Codex recovery head.

## CodeRabbit classification at the observed heads

### PR #3255

`ALREADY_FIXED`: threads `r3902181212`, `r3902181222`, `r3910881268`,
`r3910881279`.

`ACTIONABLE` on head `e250c9fb`:

- `r3911097228`: compiler-truth call scanner skips nested calls and does not mask
  regex literals.
- `r3911097233`: property `.some(...)` can ignore later false spread/duplicate
  overrides.
- Manual review `5105285728`: stack-PHI `resolveStackBefore` and indirect
  `exactStackLoadSource` match a key without the requested load width.

`ALREADY_FIXED`/technical false positive despite unresolved thread:
`r3912103129`; current pipeline checks equal load/store widths.

CodeRabbit reviews were paused after the merged #3382. None of these records is
approval for a new candidate.

### PR #3382

All five CodeRabbit threads (`r3912207835`, `r3912207856`, `r3912207861`,
`r3912207866`, `r3913469182`) are resolved and outdated, so they are classified
`ALREADY_FIXED` for that merged head. A Supervisor policy comment records that
#3382 merged while the latest review was changes-requested and before post-merge
CI was green. The campaign therefore requires a permanent regression for this
release-process failure where technically possible.

## Current main workflow state

All listed runs are completed push runs for exact `main@47f8a444`; none is
pending:

- Phase 7 release validation, [run `33821694602`](https://github.com/rhgrive3/hex-ida/actions/runs/33821694602): failed at
  `tests/decompiler-semantic.mjs:103` because `apply_damage` published
  `local_phi_174` (`semantic 11/11`, decompiler `13/14`). This is the same
  repository semantic defect reproduced locally; the later final-evidence
  assertion is only aggregate propagation.
- Generated userscript sync, [run `33821694577`](https://github.com/rhgrive3/hex-ida/actions/runs/33821694577): the canonical build succeeded
  but proved the two committed products stale. Template serial changed
  `2.0.2322242128 → 2.0.2322242129`, release identity changed
  `3f4a6b… → d6db1e…`, and protected-runtime build ID changed
  `53e900… → 4333b7…`. This requires integration-owner regeneration, never a
  waived diff.
- Invariant Gates, [run `33821694695`](https://github.com/rhgrive3/hex-ida/actions/runs/33821694695): `check-analysis-proof` repeats the
  `apply_damage` defect; `check-phase45` fails because
  `tests/phase4/ownership/integration-contract-repair.test.mjs:114` still
  asserts the retired Phase 4/5 workflow shape instead of the current
  `phase45` coverage/run contract. `check-repo-regression` emits no assertion,
  signal, exact-lane failure, or exit reason and ends during monolithic Phase 6
  after 112 passes; the same tree's isolated local Phase 6 passes 116/116.
  This is insufficient runner-termination evidence and requires a permanent
  isolated-child/status-reporting regression. The aggregate job only reports
  `PLAN_RESULT: success`, `SHARD_RESULT: failure`.
- Cross-binary accuracy, [run `33821694584`](https://github.com/rhgrive3/hex-ida/actions/runs/33821694584): all three real fixtures succeeded;
  the aggregate fails only because
  `tests/issue-497-cross-binary-workflow.mjs:85` expects stale cache generation
  `accuracy-result-v7-` while the current workflow writes validated `v8`.
- Universal binary platform, [run `33821694714`](https://github.com/rhgrive3/hex-ida/actions/runs/33821694714): success.
- Phase 6 release validation, [run `33821694556`](https://github.com/rhgrive3/hex-ida/actions/runs/33821694556): success.

The semantic failure, generated-output drift, and two stale workflow assertions
are repository defects. The monolithic Phase 6 termination is a release-process
evidence defect, not proof of a source assertion failure. All remain Stage A
blockers until fixed with permanent regressions and rerun at the candidate head.

## Ownership overlap summary

- REC-3255 consumer overlaps #3255, #3421, #3422, #3425, #3454, #6341, and #6394.
- REC-ME01 and ME oracle overlap #3425 extensively.
- REC-X02 overlaps #3543, #6324, #6372, #6402, #6410, and ledger-only paths in
  #3421/#3425.
- REC-X03 overlaps #3541, #6372, and ledger-only paths in #3421/#3425.
- REC-SYM01 has no exact-path overlap; #6360 is a semantically related disjoint
  SYM pull request.
- REC-C2-U is superseded on main and overlaps later C2/analysis work; it is not
  an integration candidate.

Every linked PR/head/ref/worktree remains read-only except the living integration
worktree and a deliberately created/adopted campaign PR recorded in `tasks.md`.
