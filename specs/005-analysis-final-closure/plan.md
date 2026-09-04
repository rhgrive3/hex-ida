# Implementation Plan: Recovery and Analysis Final Closure

**Branch**: `recovery/final-closure-20260904` | **Date**: 2026-09-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-analysis-final-closure/spec.md`

## Summary

Recover the work described by `origin/wip/recovery-handoff-20260904` at
`84d277a962515031c1bcc4eba0dca4c44c41f0b7` without duplicating work already in
live `origin/main`, promote the recovered product only with exact candidate and
candidate-merge-tree proof, then start again from the verified post-recovery
`main` and close all 23 findings in `docs/解析ツール改善.md.txt`. The implementation
uses the existing canonical producers and feature specifications, a single
living integration owner, counterexample-first changes, independent semantic
review for high-risk lanes, and staged T0-T3 validation. Historical branch,
pull-request, and roadmap claims are inputs to reconciliation, not completion
authority.

## Technical Context

**Language/Version**: JavaScript ES modules on Node.js 22.14.0; browser JavaScript;
WebAssembly artifacts; Python only where an existing independent oracle requires it

**Primary Dependencies**: Browser Web APIs, Web Workers, IndexedDB/OPFS, Capstone
WASM; development tooling is Playwright 1.55.0, esbuild 0.28.1, and Wrangler 4.x

**Storage**: ByteSource-backed binaries, IndexedDB/OPFS artifact storage, bounded
hot caches, versioned project and evidence artifacts

**Testing**: Native Node `.mjs` runners, repository phase verifiers, compiler-truth
and real-binary corpora, Playwright browser tests, canonical `npm run check`, and
GitHub exact-head checks

**Target Platform**: Browser-first static application, including production-faithful
Safari/WebKit and physical iPadOS evidence where required; Node.js is the repository
validation host

**Project Type**: Browser binary-analysis platform with worker-based semantic,
decompiler, runtime, managed-frontend, rebuild, and AI/tooling subsystems

**Performance Goals**: Preserve the repository's frozen benchmark baselines,
bounded time-to-first-useful-analysis, cancellation latency, reopen/cache behavior,
and target-device peak-memory limits. Each task records its metric, unit, comparison
operator, threshold, denominator, and fixture/build/device identity from
`tests/benchmark-baseline.json`, the relevant `tools/validation/*/profile.json`,
`tools/validation/stage2/profile-denominators.lock.json`, or the pre-implementation
H9 authority `contracts/final-platform-locks.json` before implementation.

**Constraints**: One canonical semantic truth; zero false exactness; fail-closed
unknown/cancel/budget/stale states; bounded hostile-input parsing; no whole-binary
resident assumption; deterministic generated output; no proxy for required exact-head,
candidate-tree, independent-verifier, active-runtime, or physical-device evidence

**Scale/Scope**: 10 recovery rows, 23 canonical analysis findings, the current
production graph from ByteSource through UI/AI, and all affected phase/release gates

## Constitution Check

### Before Phase 0 research

| Principle | Result | Evidence in this plan |
|---|---|---|
| I. One Canonical Semantic Truth | PASS | Residual work modifies or reuses the existing canonical producer; private consumer inference engines are forbidden. |
| II. Explicit uncertainty | PASS | Every lane has a negative counterexample and must preserve unknown, partial, stale, cancellation, and resource-limit outcomes. |
| III. Deterministic proof | PASS | A pre-change deterministic counterexample is required before each technically testable implementation delta. |
| IV. Bounded, cancellable, portable | PASS | Budgets, cancellation, hostile-input bounds, browser fallback, WebKit, and iPad evidence are explicit gates. |
| V. Exact product proof | PASS | Head, base, merge-tree, verifier, corpus, toolchain, runtime, and generated identities are recorded and invalidated together. |

No constitutional exception is requested.

### After Phase 1 design

| Design question | Result | Decision |
|---|---|---|
| Does the ledger admit unsupported completion? | PASS | The state machines in `data-model.md` prevent terminal completion without evidence. |
| Can evidence be reused after identity changes? | PASS | The evidence contract makes any head, base, corpus, verifier, toolchain, runtime, or artifact change stale. |
| Can workers overlap or publish generated output? | PASS | Concurrent owned paths are disjoint and every task has an explicit machine-readable forbidden-overlap entry; sequential reuse is dependency-gated. Only the Supervisor/integration owner may regenerate or commit combined output. |
| Is post-merge main a separate product state? | PASS | Stage B cannot start until Stage A ancestry and post-merge smoke proof are recorded. |
| Are external target requirements weakened? | PASS | Missing physical iPad evidence remains `BLOCKED`; simulation cannot promote it. |

No design-stage constitutional exception is present.

## Current Reality Baseline

| Identity | Current observed value | Authority rule |
|---|---|---|
| Repository | `https://github.com/rhgrive3/hex-ida.git` | Re-resolve from `git remote -v` before every release transition. |
| Initial live main | `47f8a44469a5826b6199501a153a12439a280d13` | Historical after live main moves; refetch before use. |
| Recovery handoff ref | `origin/wip/recovery-handoff-20260904` | Preserve through Stage A post-merge verification. |
| Recovery handoff head | `84d277a962515031c1bcc4eba0dca4c44c41f0b7` | The handoff document at this commit is the recovery inventory source. |
| Handoff merge base | `0971c491bde06b3c939f0e26f319bcd70d12b706` | Recovery branch was 4 ahead and 1 behind at preflight. |
| Original workspace | `main` with untracked `transcripts/` | Must remain untouched. |
| Living integration workspace | `/teamspace/studios/this_studio/ida-245-recovery-final` | Sole combined-tree and generated-output owner. |

All values above are observations from 2026-09-04, not permanent release
identities. Tasks must update the durable evidence when any live value changes.

## Delivery Architecture

```text
live remote + handoff + local recovery refs + open PRs
                         |
                         v
                recovery item ledger
                         |
       reuse proven commits / implement missing deltas
                         |
                         v
              one Stage A integration candidate
                         |
       exact head + merge tree + CI + review + runtime
                         |
                         v
                 protected merge to main
                         |
              refetch + ancestry + smoke proof
                         |
                         v
          fresh Stage B branch from verified main
                         |
          23-finding roadmap reconciliation ledger
                         |
          residual work in dependency-ordered lanes
                         |
                         v
         final candidate + protected merge + closure
```

The flow is deliberately sequential at the Stage A/Stage B boundary. Within a
stage, parallel work is permitted only for independent, explicitly owned paths
after shared contracts are stable. High-risk semantic changes require an
implementation review independent from the implementer, followed by Supervisor
verification of the actual diff and tests.

## Project Structure

### Documentation for this campaign

```text
specs/005-analysis-final-closure/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── closure-ledger.md
│   ├── task-ownership.json
│   ├── performance-locks.json
│   └── final-platform-locks.json
├── checklists/
│   ├── requirements.md
│   └── release-evidence.md
├── evidence/
│   ├── github-state.md
│   ├── recovery-matrix.md
│   ├── roadmap-matrix.md
│   ├── speckit-analysis.md          # expected new before implementation
│   ├── pre-fanout.md                 # expected before component implementation
│   ├── stage-a-*.md                 # expected new during Stage A integration
│   ├── stage-b-preflight.md          # expected before roadmap reconciliation
│   ├── stage-b-residual-coverage.md  # expected before Stage B fanout
│   └── final-*.md                   # expected new during final promotion
└── tasks.md
```

### Existing production and verification surfaces

```text
js/
├── architecture/          # architecture-owned decoding/control-flow contracts
├── semantics/             # MachineEffects adapters, Semantic IR, SSA, MemorySSA
├── core/                  # identity, evidence, scheduling, budgets, artifacts
├── runtime/               # identity-bound debugger/instrumentation/trace providers
├── managed/               # WASM, DEX, CIL, JVM frontends and VM effects
├── phase12/               # package/provider/identity/budget boundaries
├── analyze.js             # legacy production orchestration boundary
└── dataflow.js            # canonical legacy analysis consumer boundaries

tests/
├── machine-effects/
├── semantic-v2/
├── compiler-truth/
├── phase4/ ... phase12/
├── ui/
└── *.mjs                  # focused, integration, platform, runtime, metadata gates

tools/validation/          # independent phase, ownership, corpus, and release verifiers
scripts/                   # quiet runners, generated userscript, deployment identity
userscript/                # generated/release browser package
docs/                      # architecture, guardrails, roadmap, finding ledger
```

**Structure Decision**: Reuse the repository's existing semantic and validation
owners. This campaign adds only durable Spec Kit coordination artifacts unless a
proven residual requires a minimal source or test change. It does not introduce a
new engine, package, storage layer, or generated-output owner.

Recovery refs and open-PR heads are historical/read-only sources, not expected
new files. Any production or test path taken from them is first reduced to a
reviewed minimal delta in the living integration worktree; only the evidence
files shown above are unconditionally new campaign paths.

## Stage Plan

### Stage A: Recovery

1. Freeze the exact handoff inventory and live overlap evidence.
2. Classify every handoff row as `DONE`, `PARTIAL`, `NOT STARTED`,
   `SUPERSEDED`, or `CONFLICTED` using current source, wiring, and tests.
3. Before component fanout, create the living integration pull request and prove
   all Guardrails §3.1 preflight rows: exact-SHA verifier invocation, ownership
   regression, production walking skeleton, target contract, reconciliation owner,
   and invalidation rules. Component work remains blocked until `PREFLIGHT_GREEN`.
4. Reuse only useful minimal commits from recovery refs; never merge a stale lane
   wholesale when it contains superseded or duplicate code.
5. For each incomplete row, add the first deterministic failing counterexample,
   repair the canonical boundary, and run T0/T1/T2 evidence.
6. Reconcile through the living integration owner with current main. Regenerate
   combined artifacts only there.
7. Prove the exact head and candidate merge tree, classify every CodeRabbit
   finding, merge through protection, refetch main, and run post-merge smoke gates.

### Stage B: Analysis improvement

1. T047 starts a new clean branch/worktree from the refetched and verified Stage A
   `origin/main`, records the base identity and clean state, and preserves both the
   original workspace and recovery ref read-only.
2. T025 reconciles all 23 roadmap findings with production source, wiring, tests,
   specifications, open work, and recent commits.
3. T048 proves an exact bijection from every `PARTIAL`/`REMAINING` row to one fully
   contracted task, appending missing tasks before any Stage B component fanout.
4. Convert only `PARTIAL` and `REMAINING` rows into implementation tasks, ordered
   by the roadmap dependency graph: ground truth; MachineEffects; IR/CFG/SSA/MSSA;
   alias/summaries; value precision; types; decompiler; symbolic; native rebuild;
   runtime; managed frontends; recognition/diff/capabilities; platform; browser UX.
5. Integrate independent lanes continuously after their contracts stabilize.
6. Run the applicable T3 denominator, independent verifier, benchmark, generated,
   runtime, browser, and target-device gates on the exact final candidate.
7. Merge through protection, refetch, verify, and update the roadmap and finding
   ledger with final commit/evidence. Authoritative `PARTIAL`, `REMAINING`, and
   `BLOCKED` must all be zero.

## Validation Strategy

| Tier | When | Minimum content |
|---|---|---|
| T0 | Each edit | syntax/static checks, ownership and schema invariants |
| T1 | Each counterexample | smallest positive, negative, boundary, adversarial regression |
| T2 | Each lane integration | subsystem runner plus affected producer/consumer boundary |
| T3 | Stable candidate, exact PR head, merge tree, post-merge | canonical quiet `npm run check`, required verifiers/corpora, generated zero-diff, CI, review, runtime/browser/device evidence |

Broad local gates use `node scripts/run-quiet-command.mjs` so output suppression
does not change the canonical command. A failure is diagnosed with the smallest
failing command and `HEX_TEST_OUTPUT=verbose` when supported.

## Ownership and Integration Rules

- Supervisor/integration owner: SOL Ultra; owns contracts, candidate, conflict
  decisions, generated output, merge, post-merge proof, and final roadmap closure.
- Sol implementation/review lanes: high-risk MachineEffects, alias/summary,
  MemorySSA, type, decompiler, symbolic, native, runtime, and semantic review.
- Luna Max lanes: bounded archaeology, deterministic fixtures, mechanical
  migration, test/benchmark harnesses, documentation synchronization, and
  independent negative tests with fixed contracts.
- Every delegated task records ID, owner/model, risk, dependencies, owned paths,
  forbidden overlap, tests, evidence, and exit condition in `tasks.md`.
- `contracts/task-ownership.json` is the machine-readable forbidden-overlap
  authority. It MUST contain exactly one nonempty entry for every task ID; a
  missing, duplicate, or concurrently violated entry blocks assignment and merge.
- Workers do not spawn workers, merge current main independently, commit combined
  generated output, or treat their report as release authority.
- All recovery refs, pull-request heads, and linked worktrees other than the living
  integration worktree are read-only: no checkout-for-edit, rebase, commit, delete,
  or force update is permitted.
- Before a focused feature spec is reused, its revision, canonical producer, every
  production consumer, current tests, and contract drift are recorded.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Historical recovered work conflicts with newer main | Inspect minimal commit/tree diffs and current tests before selective reuse. |
| A positive fixture hides false exactness | Require negative/unknown/adversarial counterexamples and locked denominator metrics. |
| Main moves during proof | Invalidate affected evidence, rebuild the candidate merge tree once, and rerun the prescribed subset. |
| Generated hashes disagree | Regenerate from the combined tree as integration owner, run a second generation, require zero diff. |
| Open PR overlaps campaign paths | Record ownership collision and reuse or wait; do not create a duplicate engine or mutate unrelated issue work. |
| Required compiler/oracle is absent | Use committed readable-byte corpus where contract permits; otherwise record the exact external dependency without weakening the gate. |
| Physical iPad proof is unavailable | Continue all repository-solvable work, retain the exact target-device requirement as blocking, and state the minimum authorized runner action. |

## Complexity Tracking

No constitutional violation or new architectural component is proposed.
