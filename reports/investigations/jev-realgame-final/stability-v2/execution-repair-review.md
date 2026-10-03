# stability-v2-review-verify — B1/N2/N3 repair verification (same authorized lane)

**Scope honored:** read only the guard, its main wiring, execution-freeze, the N3 advisory line, and
the focused execution-rejection test. **No holdout, results, or API logs were read; no source edits;
one test command only.** `TMPDIR/TMP/TEMP=/mnt/workspace/.dev-state/agent-work/scratch`.

**Head / identities:** worktree HEAD `0e8e0b08dbf35eacfb8a998593af227bb2861b79` (prompt lineage
`505bf3500 → 7e32114cf → …`); worktree has one uncommitted file, `tests/jev-realgame-final.test.mjs`
(+53 — the rejection test itself; note below). Hashes (sha256):
- guard `scripts/jev-stability-execution-guard.mjs` `c1c3bdd1ef5eb5ab0e3de6b5828d487de4033bbfd4a89b1eb5e3a7a66443391e`
- evaluator `26714f56e5fff80b6946601fd9e2f3d2f7532696c006b015ec576bf5c951eb5e`
- verifier `4f6245c34b2248871776aec32dd53130ee2bc36149c36cb785d051d7c486822a`
- controls runner `948cfce8734ac4e403a858664e7564df064c52402e8dc02b82afb4f4c76406c4`
- `stability-v2/execution-freeze.json` `78520ffef3714baa722f9f28948b8b548b364a22e14719ca669f9194e77a51d6`
  (prior freeze sha recorded inside as `executionGuardRepair.priorExecutionFreezeSha256` `fa46a0f8…`)

## Verdict: B1 REPAIRED; N2 and N3 REPAIRED. Residual notes are minor.

**B1 (runtime enforcement of the execution freeze) — repaired.** `assertStabilityExecution` is
imported and invoked in all three runners **before any API client is constructed**, by line order:
- evaluator: guard at line 55, `new RealGameJevClient` map at line 63;
- controls: guard at line 11, client at line 21;
- verifier `main`: guard at line 119 (offline, with snapshots).

Guard asserts exactly the reviewed gap: freeze `policySha256` vs policy bytes; every frozen
`sourceHashes` entry present (own file, client, contract, guard) **and** matching disk (all-pass when
checked); `maxAttempts===1`, `totalTimeoutMs===15000`, `primaryRepeat`/`repeats` equal to policy,
`controlRepeats===5`; per-snapshot `productSha===collectionProductSha` and `policySha256` match —
closing the previously unasserted collection-SHA claim too. Failures are `assert` throws → no client
is ever built on drift (the focused test name states exactly this invariant and passes).
Residual (accepted): the freeze file itself is not hash-pinned by the guard, but it is git-committed
and now records its own prior sha + repair disclosure, so drift is auditable.

**N2 (verifier sha history) — repaired.** `verifierSourceHistory` lists all three commits and each
entry matches the actual git blob: `18d7d7436 → 5f9d433856f3…`, `505bf3500 → e7bd8cc27e8b…`,
`7e32114cf → 00c82f97f76e…` (verified via `git show <commit>:scripts/verify-jev-realgame-stability.mjs`).
The prior `priorVerifierSha256`/freeze-entry discontinuity I flagged is now explained by a complete,
checkable chain.

**N3 (identical OPTIONAL_ADVISORY conjuncts) — repaired.** Evaluator (lines 31–33) and verifier
(lines 104–106) now both include `summaries.ADVISORY.regression === summaries.R1.regression`, the
R1-committed repeatedKeys identity, and the controls committed-correct condition. The only textual
difference is `controls?.rows.every(...)` vs `controls != null && controls.rows.every(...)` —
semantically identical (both false when controls are absent). Runner and independent replay now agree
by construction.

**Focused test (only command run):**
`node --test --test-name-pattern='V2 execution rejects' tests/jev-realgame-final.test.mjs`
→ **1 test, 1 pass, 0 fail** (exit 0): "V2 execution rejects changed evaluator or collection before
any client is constructed".

**Disclosure noted (not a defect):** `executionGuardRepair` records the pre-guard completed run
(`preGuardCompletedCases: 50`, `preGuardCalls: 471`, `preGuardOutcomesInspected: false`), retained
separately as non-final evidence, with the release evaluation rerun unchanged behind the guard and
`policyAndPromptChanged: false` — consistent with the instruction that the earlier run is not final
proof and its outcomes remain unread by this lane.

**Minor notes (no action required before the rerun):**
1. The rejection test file is uncommitted (`M tests/jev-realgame-final.test.mjs`); commit it with the
   guard work so the permanent regression is bound to the same head as the frozen sources.
2. `execution-freeze.sourceHashes` does not cover `evaluate-jev-realgame-final.mjs` (imported by the
   evaluator for `summarize`) — out of the reviewed B1 list; acceptable, but a future hardening could
   include it since classification math flows through it.

No holdout bodies, oracle names, results, or API logs were read. Parent owns any follow-up.
