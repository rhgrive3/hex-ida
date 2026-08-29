# Quickstart and Evidence Gates: HEX-C2-02

This document records reproducible lane commands. Commands are run from the
repository root of the isolated worktree. The pre-fix failure is retained
unchanged beside the post-fix proof; review, CI, merge, and post-merge evidence
remain open until the supervisor closes those gates.

## Base and identity

```text
BASE_SHA=609c9560104da321eb21487f05c12c73a851fc66
PRE_FIX_BASE_SHA=8a614ccd0184d6c25257c25d930b68af7e9ac81f
BRANCH=codex/hex-c2-02
FEATURE=specs/002-wrapped-interval-congruence
```

The authoritative remote is `https://github.com/rhgrive3/ida-245.git`, which
GitHub resolves to `rhgrive3/hex-ida`. The initial live-main preflight was
`8a614ccd0184d6c25257c25d930b68af7e9ac81f`; live `origin/main` subsequently
advanced through `be5636b1baeadfaef5ae10d81406f02118dca780`
(the C3 prototype-recovery merge) and then to
`03def51c52da869b53929ee537546aedddbe689b`, `48a0b429...`, and finally
`609c9560104da321eb21487f05c12c73a851fc66`. The lane was reconciled onto that
newest SHA before implementation acceptance. Its moving-main delta touches
only AI/query, ARM64, runtime, project, UI, and generated userscript files plus
their tests; it does not overlap this lane's canonical range/SCCP files,
scalar/integration tests, or generated inputs. The latest implementation
preflight resolved `origin/main=44e8fecb9af615a25f59b1ed9439bb11c0585077` at
`2026-08-29T23:09:56Z`. Since the lane base, no current-main commit touches
the Phase 8 canonical owner, C2-02 tests, or this feature's Spec Kit inputs;
the moving-main changes remain outside this semantic/test/generated input
surface. A fresh remote/open-PR check remains required before Review 2 and
merge.

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
POST_FIX_SHA=d361c5330f65fa295b3dc63bd4d82ffa5d5ca347
node --test tests/phase8/scalar/c2-02-pre-fix.test.mjs
```

`POST_FIX_COMMAND`: `node --test tests/phase8/scalar/c2-02-pre-fix.test.mjs`.
`POST_FIX_PASS`: the focused C2-02 suite is 148 tests, 148 pass, 0 fail at the
implementation head above. Both
original assertions are unchanged; the edge object retains a compatibility
`.get()` view while publishing structured edge facts.

Additional implementation-head evidence:

```text
T0: git diff --check; node --check index.js/range.js/sccp.js; npm run lint — PASS
T1: range.test.mjs + sccp.test.mjs + pre-fix regression + downstream/lifecycle suites — PASS (148 tests)
T2: `npm run phase8:test` — 312/313 passed; one no-op corpus assertion can
  observe a deadline-cancelled ARM64 optimizer run under load, so the run is
  not claimed as a pass. The identical target is complete on isolated replay.
Downstream: c2-02-downstream-range.test.mjs — PASS; GVN/induction/vertical
  stale-identity and atomic-publication regressions — PASS
Ownership: npm run phase8:ownership — PASS
Convergence: Spec Kit artifacts rechecked after implementation; no remaining
spec/plan/task gap was found; `CONVERGENCE_RESULT=CLEAN`.
Generated output: no generated files changed; canonical generator not owned by this lane.
```

The implementation is represented by source commits through
`d361c5330f65fa295b3dc63bd4d82ffa5d5ca347`; this evidence update is
documentation-only. The publication digest covers canonical
facts, edge/block-entry refinements, identity/provenance, completeness, budget,
and diagnostics. Subsequent documentation-only evidence updates must not be
confused with the original pre-fix comparison.

## Review 1 correction evidence

Review 1 identified six soundness and lifecycle gaps at implementation head
`4610456206e659f5a6142e4e5c307d79f5a82c9c`. The following permanent
regressions were added before the corresponding production corrections:

```text
wrapped join [0,2] U [2,0] at 8 bits covers every member of both inputs;
non-divisor residues are dropped rather than propagated through machine wrap;
known-bit/congruence/range contradictions, out-of-width masks, cyclic evidence,
and incompatible switch labels fail closed; a partial vertical run preserves a
prior complete artifact; canonical identity is required and stale SCCP/GVN/
induction inputs are rejected; replacing ranges invalidates valueNumbers,
induction, and aggregates.
```

The identical focused regressions pass at semantic correction commit
`534e7e89c9d6c3d6ee06a48223e88720810a8c7c`: 125 tests, 125 pass, 0 fail.
The implementation uses the existing `range.js`/`sccp.js` scalar owner and a
shared identity-validation boundary; it does not add a competing value or
range engine. Reviewer-owned checklist items remain open for the supervisor's
independent review passes.

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
before changing production files. The implementation lane reached
`CONVERGENCE_RESULT=CLEAN` after the final source/test changes; reviewer-owned
tasks T037–T050 remain open for the supervisor's review, reconciliation, CI,
merge, and post-merge gates. Every semantic head change invalidates both review
approvals and requires convergence plus both review passes again.

The clean-tree verifier run at `d361c5330f65fa295b3dc63bd4d82ffa5d5ca347`
reported `P8_VERDICT=BLOCKING`: all measured hard-zero safety counters were
zero, but two transform-determinism observations were caused by complete versus
deadline-cancelled optimizer ledgers, and the active-function median was
490.9 ms against the 250 ms profile limit. No expectation or budget was weakened;
the generated verifier reports were restored and are not part of the lane diff.

The two independent review passes must inspect the actual final diff. Review 1
constructs fresh malformed, stale, incomplete/cancelled, ambiguity, and boundary
attacks. Review 2 checks moving-main ownership, generated state, exact-head CI,
candidate merge structure, and current consumer collisions.
