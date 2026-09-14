# Quickstart and Evidence Gates: HEX-C2-02

This document records reproducible lane commands and the current implementation
checkpoint. Commands run from the repository root of the isolated worktree.
Implementation and convergence evidence is closed; independent review, CI,
candidate-tree approval, merge, and post-merge delivery remain open.

## Exact identities and moving-main record

```text
ORIGINAL_EXACT_HEAD=bccc757c8162cf36aaef76351298cecb289cb954
BRANCH=codex/hex-c2-02
FEATURE=specs/002-wrapped-interval-congruence
INITIAL_LIVE_MAIN=99bb9a40420c5611601c0c4b6a28af22185ecbe0
SEMANTIC_HEAD=80a53ff279d6e8b94f4e844d490f9e5cfb31941a
RECONCILED_LIVE_MAIN=0c6df2d5981e64296a2b3fba380bed1e032fc726
RECONCILED_HEAD=c908ef30b7118e3c1f571af4365d7f2624c78aa7
```

The authoritative remote is `https://github.com/rhgrive3/ida-245.git`, which
GitHub resolves to `rhgrive3/hex-ida`. The initial live-main and open-PR
preflight recorded PR #2777 at `470ac2e627bde450bd1194600e592926ec8504bf`
and PR #2745 at `39d26ee928868b9c16fb75a6e3c96b22ebb5f009`; the reviewer
reported no Phase 8 ownership overlap. After semantic work, the one required
late fetch advanced `origin/main` through `776a3f898742180a7dd316adbe92a6eca4ee4a90`
to `0c6df2d5981e64296a2b3fba380bed1e032fc726` (2026-08-30). The upstream
64-file delta had no content overlap with the ten C2-02 files. It was merged
once with the `ort` strategy as `c908ef30`; no further fetch/rebase was done.

The final packet must record the clean evidence head and tree produced after
the ledger commit with:

```bash
git rev-parse HEAD
git rev-parse HEAD^{tree}
git status --porcelain
```

## Minimum pre-fix regression

The deterministic regression was committed as a test-only proof before the
production changes and is retained unchanged:

```bash
node --test tests/phase8/scalar/c2-02-pre-fix.test.mjs
```

### PRE_FIX_RESULT

**FAIL (expected) at `8a614ccd0184d6c25257c25d930b68af7e9ac81f`.** The exact
run reported two failing tests and zero passing tests:

```text
tests 2
pass 0
fail 2
```

Failure 1: a mask-derived trailing-zero congruence was missing. Failure 2: a
symbolic unsigned-bound true-edge fact set was missing. The unchanged test
also asserts that the global value remains full when edge facts are added.

## Implementation and adversarial evidence

`SEMANTIC_HEAD` contains the cumulative Review 1 corrections and permanent
family-wide regressions. The implementation keeps `range.js`/SCCP as the
single scalar owner and adds no alternate arithmetic, identity, cache, or
publication engine. No gate, denominator, threshold, hard-zero counter, or
generated artifact was weakened or edited.

The matrix covers every named Review 1 defect plus sibling public entrypoints:

```text
alignment, pointer offsets, constructors, casts, arithmetic, bitwise facts,
comparison refinement, joins, widening, and cross-domain/root/value negatives;
pure integer congruence remains separate from pointer alignment;
definition.extra, instructions, blocks, edges, loops, root maps, value/memory
metadata, Map/Set/object insertion order, sparse arrays, undefined/null,
accessors, non-enumerable properties, symbol keys, cycles, and identity-source
descriptors; default and explicit budgets, delayed scheduling, cancellation,
invalid deadlines, and fail-closed partial publication.
```

## Reproducible test gates

Focused post-fix evidence on the reconciled source tree:

```text
node --test tests/phase8/scalar/*.mjs --test-reporter=dot
  PASS: 123 tests, 123 pass, 0 fail
node --test tests/phase8/scalar/c2-02-adversarial-matrix.test.mjs --test-reporter=spec
  PASS: 24 tests, 24 pass, 0 fail
node --test tests/phase8/performance/budget.test.mjs --test-reporter=spec
  PASS: 5 tests, 5 pass, 0 fail
npm run lint
  PASS: syntax lint: 1693 files ok
npm run phase8:ownership
  PASS: manifest version 1, lane p8 valid
git diff --check; node --check <all ten changed JS/MJS files>
  PASS
```

The canonical full Phase 8 gate was run after the single moving-main
reconciliation using the required quiet wrapper:

```bash
node ../ida-245/scripts/run-quiet-command.mjs --label phase8 -- npm run phase8:test
```

It completed with `phase8: PASS (339.5s)` across 31 discovered test files and
the expanded scalar corpus remained 123/123. The final packet should also
record the machine-reporter total if a count is required by the receiving
supervisor; the command above is the canonical gate and its success is not
replaced by a subset.

The delayed-scheduling regressions prove that the public optimizer and decoded
function pipeline produce the same publication/completeness/digest under
different scheduling delays. The default path uses a deterministic bounded
work budget. An explicit finite wall deadline remains supported; cancellation,
invalid deadlines, and partial results remain fail-closed.

## Spec Kit convergence and task ledger

The prerequisite command passed:

```bash
bash .specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks
```

The `speckit-converge` assessment checked `spec.md`, `plan.md`, `tasks.md`, the
constitution, named source paths, and the adversarial matrix. There were no
missing, partial, contradictory, or unrequested implementation findings, so
no convergence section was appended. `CONVERGENCE_RESULT=CLEAN`.

Task reconciliation is intentionally limited to completed semantic/workflow
items:

```text
T037 [x] Spec Kit convergence audit is clean; no implementation tasks added.
T038 [ ] independent Review 1 (reviewer-owned)
T039 [x] Review 1 defects fixed and T0/T1/T2 rerun; fresh review remains open.
T040 [ ] Sol semantic review (reviewer-owned)
T041 [x] one late live-main fetch/reconciliation recorded above.
T042 [ ] independent Review 2 (reviewer-owned)
T043 [ ] Review 2 fixes/re-review lifecycle (reviewer-owned)
T044 [ ] canonical generator/build delivery check
T045 [ ] exact-head CI
T046 [ ] candidate merge-tree validation
T047 [ ] Sol final packet approval
T048 [ ] merge to live main
T049 [ ] post-merge verification
T050 [ ] mark merged
```

No review, PR, CI approval, candidate merge-tree approval, merge, or post-merge
claim is made by this lane. The ledger remains `FINDING_STATUS=IMPLEMENTED;
DELIVERY_GATES_OPEN` until those owners act.

## Ownership, generated output, and Graft handling

The changed-file inventory is limited to:

```text
js/decompiler/phase8/analysis-identity.js
js/decompiler/phase8/index.js
js/decompiler/phase8/range.js
js/decompiler/pipeline-core.js
js/decompiler/pipeline.js
tests/phase8/performance/budget.test.mjs
tests/phase8/scalar/c2-02-adversarial-matrix.test.mjs
tests/phase8/scalar/range.test.mjs
tests/phase8/scalar/sccp.test.mjs
tools/validation/phase8/decoded-function-adapter.mjs
```

`npm run phase8:ownership` is green. No generated userscript or release file
was changed; generator/build delivery remains integration-owned. Reports under
`reports/phase8/` are verifier-owned ignored outputs and are not committed as
lane source. The final clean-tree verifier runs must regenerate them atomically
and record their exact report path, product SHA/tree, verifier version, corpus,
toolchain, and verdict.

This environment is outside GitHub Codespaces (`CODESPACES` is unset). Per the
guardrails, Graft was not installed, invoked, emulated, or treated as a
blocker; normal repository inspection/search was used. Graft savings are
therefore `$0` API/token/runtime savings, with no graph trace to report.

## Exact verifier and remaining delivery commands

Run each verifier invocation in a fresh shell on a clean exact head and record
the output/report before the next invocation:

```bash
git status --porcelain
HEAD_SHA="$(git rev-parse HEAD)"
npm run phase8:verify -- --expect-sha "$HEAD_SHA"
node -e "const r=require('./reports/phase8/phase8-release-evidence.json'); console.log(JSON.stringify({verdict:r.verdict,commit:r.product.commitSha,tree:r.product.treeSha,clean:r.product.workingTreeClean,determinism:r.safety.transformDeterminismFailureCount},null,2))"
```

The required final evidence is multiple isolated repetitions with
`verdict=READY`, exact commit/tree identity, clean status, and
`transformDeterminismFailureCount=0`. A `BLOCKING` result is recorded and
diagnosed; thresholds and hard-zero rules must not be relaxed.

After verifier evidence is complete, the supervisor may run the still-open
delivery gates. This lane performs no review, PR, merge, or post-merge action.
