# Quickstart and Evidence Gates: HEX-C2-02

This document records reproducible lane commands. Commands are run from the
repository root of the isolated worktree. The pre-fix failure is retained
unchanged beside the post-fix proof; review, CI, merge, and post-merge evidence
remain open until the supervisor closes those gates.

## Base and identity

```text
BASE_SHA=8a614ccd0184d6c25257c25d930b68af7e9ac81f
BRANCH=codex/hex-c2-02
FEATURE=specs/002-wrapped-interval-congruence
```

The authoritative remote is `https://github.com/rhgrive3/ida-245.git`, which
GitHub resolves to `rhgrive3/hex-ida`. The initial live-main preflight was
`8a614ccd0184d6c25257c25d930b68af7e9ac81f`; before this checkpoint live
`origin/main` first advanced to `be5636b1baeadfaef5ae10d81406f02118dca780`
(the C3 prototype-recovery merge) and then to
`03def51c52da869b53929ee537546aedddbe689b` (the cross-binary CI scheduling
merge). The cumulative moving-main delta changes only
`js/decompiler/types/prototype.js`,
`tests/phase8/integration/issue-2478-abi-prototype-recovery.test.mjs`,
`.github/workflows/cross-binary-accuracy.yml`, and
`tests/issue-497-cross-binary-workflow.mjs`; it does not overlap this lane's
canonical range/SCCP files or pre-fix test. The lane remains based on the stable
`BASE_SHA` until the required reconciliation before Review 2. A fresh
`git ls-remote` and open-PR check are required again before Review 2 and merge.

## Minimum pre-fix regression

The deterministic regression is intentionally committed as a test-only proof
before production changes:

```bash
node --test tests/phase8/scalar/c2-02-pre-fix.test.mjs
```

### PRE_FIX_RESULT

**FAIL (expected) at `8a614ccd0184d6c25257c25d930b68af7e9ac81f`.** The exact run
reported two failing tests and zero passing tests:

```text
tests 2
pass 0
fail 2
```

Failure 1: `mask-derived trailing-zero congruence must be published`; current
`evaluateBinaryRange('and', fullRange(32), singleton(0xFC))` returns a `full`
range with no `congruence` field (`undefined !== 4n`).

Failure 2: `true-edge fact set must be published`; current SCCP leaves the
symbolic `x <u 10` branches executable but publishes no `edgeFacts` map.

This proves the first divergence without weakening any expectation. The test
also asserts that the global `x` fact remains full once edge facts are added.

## Post-fix evidence

After implementation, run the identical test and record the exact SHA/output:

```bash
POST_FIX_SHA=0902585b2b6113db996404768a58a88e85293255
node --test tests/phase8/scalar/c2-02-pre-fix.test.mjs
```

`POST_FIX_COMMAND`: `node --test tests/phase8/scalar/c2-02-pre-fix.test.mjs`.
`POST_FIX_PASS`: 2 tests, 2 pass, 0 fail at the implementation head above. Both
original assertions are unchanged; the edge object retains a compatibility
`.get()` view while publishing structured edge facts.

Additional implementation-head evidence:

```text
T0: git diff --check; node --check range.js; node --check sccp.js — PASS
T1: range.test.mjs + sccp.test.mjs + pre-fix regression — PASS
T2: npm run phase8:test — PASS (296 tests, 30/30 discovered files)
Downstream: c2-02-downstream-range.test.mjs — PASS (2 tests)
Generated output: no generated files changed; canonical generator not owned by this lane.
```

The implementation commit is `0902585b2b6113db996404768a58a88e85293255`.
Subsequent documentation-only evidence updates must not be confused with this
production/test head when reproducing the pre/post comparison.

## Staged validation

### T0 — contract and hygiene

```bash
git diff --check
node --check js/decompiler/phase8/range.js
node --check js/decompiler/phase8/sccp.js
.specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks
```

Also verify that changed files are within the expected component/test/spec set,
no forbidden owner/generated file is present, and all task lines use the required
checkbox/ID/path format.

### T1 — scalar and lifecycle proof

Run the minimum test first, then the focused range/bitvector/SCCP suites and all
required positive/paired-negative cases: modular add/subtract, signed extrema,
signed/unsigned divergence, comparisons, switch/default, phi/loop, budget,
known bits/residue, alignment/pointer offset, impossible branches, stale,
malformed, cancellation, and deterministic replay.

### T2 — owning subsystem and downstream

Use the repository's actual Phase 8 runner and package scripts discovered on the
implementation head, then run the direct GVN/induction/aggregate/structuring or
projection regression proving one observable precision gain. Do not substitute a
single unit test for these gates.

### T3 — integration/release

After convergence and both independent reviews:

1. refetch/reconcile current `main` once before Review 2 and again before merge;
2. regenerate only through the canonical generator, build twice, and require no
   second diff (this lane commits no generated output);
3. run exact-head CI and require success or an explicitly rule-driven skip;
4. verify the candidate merge tree against newest live `main`; and
5. merge, refetch live `main`, and run post-merge verification.

## Convergence and review evidence

Use the installed Spec Kit workflow through `specify`, clarify (no unresolved
questions), actual Graft trace, plan, checklist, tasks, read-only analyze, implementation, and
converge. `ANALYZE=CLEAN` and Sol's architecture/soundness spot-check are required
before changing production files. Every semantic head change invalidates both
review approvals and requires convergence plus both review passes again.

The two independent review passes must inspect the actual final diff. Review 1
constructs fresh malformed, stale, incomplete/cancelled, ambiguity, and boundary
attacks. Review 2 checks moving-main ownership, generated state, exact-head CI,
candidate merge structure, and current consumer collisions.
