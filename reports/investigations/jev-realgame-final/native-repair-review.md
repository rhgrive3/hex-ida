# Native SSA dependency hang repair + collection policy binding — independent source-only review

- Reviewer: **freebuff5** (MiMo 2.6 Flash). Fresh session; prior interrupted GLM review produced no accepted result and was not used.
- Date: 2026-09-30 UTC.
- Worktree: `/mnt/workspace/.dev-state/agent-work/checkouts/jev-realgame-final/hex-ida`
- **Exact HEAD reviewed: `1c274ec00d8006354a01db415a8c91b86f3a2dc0`** — "Bound SSA dependency reachability and preserve spills on incomplete evidence". `git status --porcelain` empty before and after the review (0 dirty files; no source edits made).
- Review range: `13d80f83c..1c274ec00` (3 commits: `86a4a6b77`, `db78d0942`, `1c274ec00`) — the complete current diff of every in-scope file since the prior receipt `recovery-final-review-verify.md` (G1–G4 verified at `13d80f83c`).
- Constraints honored: source-only; no commits, no API/live calls, no holdout/candidate/outcome reads, no delegation; only the one sanctioned test command executed; TMPDIR/TMP/TEMP pointed at `…/agent-work/scratch`.

## Verdict: **PASS — no blockers**

## 1. Changes reviewed (sha256 of worktree bytes; worktree == HEAD, tree clean)

| file | sha256 |
|---|---|
| `js/decompiler/pipeline-core.js` | `4d9d06926723927c6460113a0052bffcaf8b0a6a5dc40ae9ca60298245dff492` |
| `js/decompiler/value-dependency.js` (new) | `1136e2de7f7deee6fcfc413ad70a23e1cce03117dca665fcbc9b5309d104924e` |
| `tests/decompiler/value-dependency.test.mjs` (new) | `effef95240c5438c29d1378f0a9445e6db45578b2fb8c171b4a809d99ef10b7c` |
| `scripts/collect-jev-realgame-recovery.mjs` | `62dbd492e6054bc0a182fd8926b3720b6a96d5ba01e70b9ea87ce45d0d5553ab` |
| `scripts/evaluate-jev-realgame-recovery.mjs` | `3aec57dac414b95d45ec47c3552845b357b2f14d0ef04ee5c20e8904161064ac` |
| `scripts/verify-jev-realgame-recovery.mjs` | `5a317b0295e37c3333d9da3e98144ddb46f21e2022ba65c1420619e31d0befa4` |
| `package.json` (wiring) | `1b4f1f8456b27bdde46da9f0b710d9f8e22280e3ebf9b4a0f5d94edf6010a879` |
| `tests/decompiler/run.mjs` (wiring) | `1d126883c135106e8c9f82bcaf7134262cba3eb9700e92effb7e1090b4eabad7` |

## 2. Checklist findings

### 2.1 Iterative traversal is exact for shared DAGs and cycles — PASS
`js/decompiler/value-dependency.js` replaces the removed inline recursion from `pipeline-core.js` (old `valueDependsOnAny`, previously ~L1610–1623, which had no budget and no abort check — the hang source).

- Worklist (`pending`) + identity-keyed `seen` set (L8): each value object is expanded at most once, so a shared DAG of N nodes with many paths is O(nodes+edges), not once-per-path. The test proves this by asserting the `def` getter is evaluated exactly 6000 times for a 6000-node double-diamond chain (was exponential-path under the old id-keyed *path* guard).
- Target check ordering is exact: L13 skips only nodes already in `seen`, and a node enters `seen` (L16) only *after* the target check (L14) has run on that same object — so no target node can be skipped, and a node popped twice cannot be double-reported. A cycle (`a→b→a`) terminates via `seen` and still reaches targets through `incoming` edges; covered by the cycle assertions in the test.
- Only complete worklist exhaustion returns `false` (L26). `false` — the load-bearing "definitely absent" answer — is therefore only ever returned after the full reachable set was explored.

### 2.2 Bounded — PASS
- Budgets `maxNodes=12000`, `maxEdges=96000` (L4), validated with `Number.isSafeInteger` and rejected via `TypeError` for invalid values (L6–L7). Call sites never pass budgets, so production uses the defaults.
- Node budget enforced at L15 (`seen.size >= maxNodes` → `null`), edge budget at L21 (`++edges > maxEdges` → `null`). Every push is gated behind an edge increment, so `pending` length is bounded by `1 + maxEdges`; total iterations are bounded. Termination does not depend on graph shape.
- Abort hook `shouldAbort` checked every worklist iteration (L11) and every edge (L21); both call sites thread `state.opts?.shouldAbort` (`pipeline-core.js:1646,1658`), matching the established pattern used at `pipeline-core.js:639,744,1346`.
- Budget/abort exhaustion returns `null`, never `false`.

### 2.3 Tri-state unknown cannot hide a spill — PASS
Two call sites, both fail-safe toward *preserving* the store:
- **`pipeline-core.js:1646`** (call-argument must not depend on spill address base): `valueDependsOnAny(...) !== false` → `null` (unknown) or `true` ⇒ `return false` from `isElidableReturnSpillStore` ⇒ store **not elided**. Unknown can only block elision, never enable it.
- **`pipeline-core.js:1658`** (returned value must depend on the loaded slot): `valueDependsOnAny(...) !== true` → `null` or `false` ⇒ `continue` ⇒ no elision witness found ⇒ store **not elided**.
- `null` propagates in exactly one direction (keep spill). `true`/`false` are only returned on exact traversals (§2.1). A falsy `value` argument returns `false` (no node, no dependency), identical to the removed recursive implementation — no behavior regression at either site.
- The only `throw` in the new module is the invalid-budget `TypeError` (L6–L7), a programmer-error guard on options, not on graph shape or evidence — no new exception path can fire during normal analysis, and neither call site passes budgets.

### 2.4 No new default pass; no oracle or query exceptions — PASS
- `git diff 13d80f83c..1c274ec00 -- js/decompiler/passes/ js/analysis/` → **empty**. The `pipeline-core.js` diff is 22 lines: one import (L19), the two unknown-safe call-site rewrites (L1646, L1658), and deletion of the old recursive helper. No `PassManager`/pass-registration change; both policy freezes still carry `highCostNewPass:false` (unchanged in range).
- Frozen contracts unchanged in range: `scripts/jev-realgame-recovery-contract.mjs`, `scripts/jev-realgame-final-contract.mjs`, `recovery-policy-freeze.json`, `recovery-policy-freeze-development.json` → `git diff --stat` empty.
- The verifier's oracle guard is intact and unchanged: `verify-jev-realgame-recovery.mjs` still asserts `call.criteria` vs `recoveryRequestBody(...).questions.pick.criteria` with message `'oracle leakage or payload drift'`, plus bodyHash/choice/funnel/failureCauses/finalPolicy re-derivations. No try/catch swallowing or check deletion in either script diff (both diffs only replace the single policy-binding line with the two-freeze form).

### 2.5 Only two immutable known collection policies, accepted when recovery parameters are identical — PASS
- `scripts/evaluate-jev-realgame-recovery.mjs:25–29` and `scripts/verify-jev-realgame-recovery.mjs:22–26`: snapshot `policySha256` must byte-match **one of exactly** `recovery-policy-freeze.json` / `recovery-policy-freeze-development.json` (no match ⇒ `throw 'collection policy binding'` / `assert.ok(...,'unfrozen collection policy')`), **and** the matched file's `.collection` must deep-equal `policy.collection` (evaluator: `JSON.stringify` equality; verifier: `assert.deepEqual`, `'collection parameters drift'`). A third/modified policy file cannot be accepted.
- On-disk state verified: exactly 2 `recovery-policy*` files exist; their `.collection` objects are byte-identical (`JSON.stringify` equality confirmed programmatically), differing only in `arms` (release has the extra `current` arm) — i.e. evaluation arms differ only at evaluation, recovery/collection parameters identical, as required.
- Retained bindings unchanged: `s.complete` (evaluate:29 / verify:21), per-file source-hash re-hashing against current disk (evaluate:30 `'source hash binding'`, verify:29 `'current source drift'`), `summary.policySha256 == sha256(policyBytes)` (verify:19), experiment-freeze `corpora[role]` case/policy binding (evaluate:11–12; verify main), `s.sourceHashes` deepEqual summary (verify:27), `keyCollisions==0` (verify:28).
- `scripts/collect-jev-realgame-recovery.mjs:64–66`: snapshot `sourceHashes` now additionally binds `js/decompiler/pipeline-core.js` and `js/decompiler/value-dependency.js`, so any post-collection drift of the repaired sources fails closed in evaluate/verify.

### 2.6 Canonical wiring — PASS
- `package.json`: `test` script now contains `node --test tests/decompiler/value-dependency.test.mjs` (single occurrence; inserted by `1c274ec00`; `86a4a6b77` separately added `node tests/pinpoint-cxx-query-recovery-browser.mjs`). The same range also added `value-dependency.test.mjs` to the `decompiler:test` runner.
- `tests/decompiler/run.mjs:22`: `path.join(DIRECTORY, 'value-dependency.test.mjs')` in the canonical `files` list — discovered by `npm run decompiler:test` → `integration:test` → `test`.
- Repo-wide grep: `valueDependsOnAny` exists only in the new module, its one import, the two call sites, and its test — no duplicate/competing definition.

## 3. Focused test evidence (the only command run)

```
$ TMPDIR/TMP/TEMP=/mnt/workspace/.dev-state/agent-work/scratch \
  node --test tests/decompiler/value-dependency.test.mjs
✔ shared SSA diamonds are visited once, and deep cyclic graphs need no recursion (97ms)
✔ dependency budgets and cancellation return unknown, never an absence proof (0.5ms)
tests 2 · pass 2 · fail 0 · cancelled 0 · skipped 0 · duration_ms 796.6
EXIT=0
```

No broad, realgame, holdout, or performance suites were run locally.

## 4. Out-of-brief files changed in range (observed, not reviewed — noted for inventory completeness)

`reports/investigations/jev-realgame-final/recovery-runtime-repair.json`, `tests/jev-realgame-final.test.mjs`, `tools/validation/phase7/cross-lane-inventory.mjs`, `userscript/hex.user.template.js`, `userscript/release-version.json`. These are outside this brief's explicit review scope; the realgame report/test are untouched here because outcome/holdout reads are forbidden for this review.

## 5. Blockers

**None.** No defect, scope violation, oracle/query exception, or binding gap found in the in-scope files at HEAD `1c274ec00`.

## 6. Non-claims

This receipt attests source inspection and the single focused graph-test run at the exact head above only. It is not release evidence: no broad gate, real-game suite, candidate-merge-tree proof, or exact-SHA CI run was executed as part of this review.
