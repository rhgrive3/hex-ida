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
| Can a checkpoint self-certify or conflate merge and product? | PASS | Every accepted component uses the four-commit `I_i -> M_i -> G_i -> E_i` transaction; gate identities and generated evidence are recomputed from exact `G_i` content, and arbitrary hash-shaped or self-certifying reports are invalid. |

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
│   ├── integration-inventory.json
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
│   ├── stage-a-checkpoints.md        # one exact T049 record per accepted component
│   ├── stage-a-*.md                 # expected new during Stage A integration
│   ├── stage-b-preflight.md          # expected before roadmap reconciliation
│   ├── stage-b-checkpoints.md        # one exact T050 record per accepted residual
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
reviewed minimal delta in the living integration worktree; only the explicitly
listed coordination, contract, and evidence files shown above are
unconditionally new campaign paths.

`contracts/integration-inventory.json` follows a stage-scoped lifecycle. During
Stage A it is cumulative for the living integration candidate: the recorded
base-to-candidate `expectedChangedPaths`, `actualChangedPaths`,
`unionChangedPaths`, and entry paths cover every accepted component and
integration change, remain duplicate-free and exactly equal, and are refreshed
when the integration owner reconciles a moving base. After the Stage-A
post-merge proof is complete, T047 replaces (rather than appends to) those
values for Stage B with the exact current `origin/main` base and the new
Stage-B diff. Stage-A paths and identities are not silently carried into the
Stage-B inventory.

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
6. Every component branch/worktree is named
   `component/final-closure-tNNN-*` and targets the living integration branch. Before it is
   accepted, the integration owner tests its exact component candidate merge
   tree with every safe-argv `owned`, `rolling`, and `shadow` command frozen for
   that task in `contracts/task-ownership.json#/candidateGates`; the component
   cannot edit the integration-base registry that governs it. T049 then executes
   the §3.4 `I_i -> M_i -> G_i -> E_i` transaction: immutable component handoff
   `C_i`, exact two-parent candidate merge `M_i`, integration-owned generated
   product `G_i` with two-run zero diff, and evidence-only child `E_i` carrying
   content-derived rolling/shadow proof before the next component merge.
7. Prove the exact head and final candidate merge tree, classify every CodeRabbit
   finding, merge through protection, refetch main, and run post-merge smoke gates.

### Stage B: Analysis improvement

1. T047 starts a new clean branch/worktree from the exact current `origin/main`
   SHA obtained by refetch. That SHA MUST be proven by ancestry to contain the
   accepted Stage-A merge commit and the complete machine-readable Stage-A
   post-merge proof packet (four merge identities, smoke result, and document
   updates). T047 records this current SHA as the Stage-B base and clean state,
   then preserves both the original workspace and recovery ref read-only. This
   is an ancestry/base relationship: the new Stage-B candidate and inventory are
   not required to equal the Stage-A candidate or inventory.
2. T025 reconciles all 23 roadmap findings with production source, wiring, tests,
   specifications, open work, and recent commits.
3. T048 publishes a machine-readable residual-coverage packet bound to the
   Stage B base, exact T025 handoff, roadmap-matrix bytes, all 23 finding IDs,
   and every candidate task. It proves an exact bijection from every
   `PARTIAL`/`REMAINING` row to one fully contracted task, appending missing
   tasks before any Stage B component fanout. Missing or invalid coverage after
   T048 fails closed with no static component-set fallback. The matrix identity
   is derived independently from the raw T025 handoff commit blob; current-tree
   bytes and a recomputed packet cannot replace that historical authority. The
   verifier derives T025's canonical handoff from the unique first-DONE
   transition across the full reachable Git DAG and rejects status regression,
   so T048 cannot re-anchor it to a later substituted-matrix ancestor or hide it
   behind a reversed-parent merge.
4. Admit campaign-owned component work only for packet action `IMPLEMENT`;
   `RECONCILE_OWNER` remains closed to duplicate implementation but an exactly
   adopted concurrent-owner handoff still enters T050. `NO_EDIT` terminal rows
   create neither an implementation handoff nor a checkpoint row. Order active
   work by the roadmap dependency graph: ground truth; MachineEffects; IR/CFG/SSA/MSSA;
   alias/summaries; value precision; types; decompiler; symbolic; native rebuild;
   runtime; managed frontends; recognition/diff/capabilities; platform; browser UX.
5. Integrate independent lanes continuously after their contracts stabilize.
   T050 performs the Stage B §3.4 `I_i -> M_i -> G_i -> E_i` transaction after
   each accepted residual: cumulative inventory refresh, shared reconciliation,
   exact candidate merge, canonical generated output plus zero-diff second
   generation, rolling product gates and independent verifier bound to `G_i`,
   then the evidence-only publication before another merge.
6. Run the applicable T3 denominator, independent verifier, benchmark, generated,
   runtime, browser, and target-device gates on the exact final candidate.
7. Merge through protection, refetch, verify, and update the roadmap and finding
   ledger with final commit/evidence. Authoritative `PARTIAL`, `REMAINING`, and
   `BLOCKED` must all be zero.

### Checkpoint transaction design

The §3.4 checkpoint is a product transaction with an auditable commit chain.
For checkpoint `i`, the integration owner constructs exactly:

```text
I_i -> M_i -> G_i -> E_i
          ^
          C_i
```

`I_i` is the prior living-integration head (`I_1` is the unique full-DAG
canonical T046 first-DONE transition). Later inputs either equal the preceding `E` in `NOOP`
mode or are its exact ordered two-parent merge with refetched current main in
`EXACT_MERGE` mode; `C_i` is the immutable component handoff
head/tree from the accepted task. `M_i` is a two-parent commit whose ordered
parents are `I_i`, then `C_i`, and whose tree is the exact candidate merge tree.
`G_i` is a one-parent child of `M_i`, made by the integration owner after
reconciling and canonically generating all combined output. Every non-generated
`M_i -> G_i` change is recorded in an exact T049/T050-owned reconciliation
manifest and cannot overlap component or evidence-publication paths. Its
canonical generated set includes
`js/userscript/deployment-identity.generated.js`,
`userscript/hex.user.template.js`, and `userscript/release-version.json`. The
generator runs twice and the second tracked diff must be empty. `E_i` is a
one-parent, evidence-only child of `G_i`; its changed paths are limited to the
exact stage allowlist (`contracts/integration-inventory.json`, the matching
stage checkpoint ledger, and `tasks.md`). The next component cannot be accepted
until `E_i` is green and becomes the next `I` directly or the verified first
parent of its moving-main reconciliation.

The checkpoint row records the four serialized commit identities `I_i`, `C_i`,
`M_i`, and `G_i`, plus the candidate-gate registry digest, content-derived
generation evidence, rolling gate results, independent shadow results,
`mainReconciliation`, `integrationReconciliation`, and cumulative inventory
digest. `E_i` is not serialized inside the row: the row is
contained by the evidence-only `E_i` commit, which the verifier derives from its
historical checkpoint path and ancestry; the next row's `I_i` fixes the prior
`E_(i-1)` without a self-referential field. Generation, rolling, and shadow
evidence all bind the exact `G_i` head/tree and are recomputed from Git blobs and
exact command output. Rolling schema v2 records the exact registry Git blob,
the cumulative accepted-task set, registered/executed argv, child
exit/signal/spawn/output-limit state, and per-invocation stdout/stderr byte
length and SHA-256. Replay compares stable process semantics while preserving
those output hashes as audit receipts, so nondeterministic reporter timings are
not semantic authority. Shadow proof uses registry-pinned foundation contracts
outside component ownership and two separately executed raw-observation
providers: an independently owned oracle projection and an exact-candidate
product projection. The central verifier alone derives comparisons,
dispositions, denominators, all seven hard-zero counters, and the verdict.
Denominators count only explicitly tagged cases, and final cumulative evidence
must cover all seven counters. The report binds the governing parent separately
from the candidate (the component candidate's first parent, or `G_i`'s sole
`M_i` parent), including its foundation and judge blobs; self-authority is
invalid.
Runtime checkpoint verification MUST load the exact frozen gate registry,
install dependencies from the exact `G_i` lockfile, detach `G_i`, rerun the
canonical generator twice with a zero tracked diff, and rerun every rolling and
shadow argv for all tasks accepted through row `i` against that exact `G_i`
identity while protecting all persistent refs and rejecting undeclared runtime
files outside the fixed ephemeral roots. Arbitrary hash-shaped values, copied
identities, a truthy `PASS`, two sides supplied by one task-owned process, or a
verifier certifying only its own report cannot satisfy the contract. A historical
checkpoint is accepted only after replaying the exact `M_i -> G_i -> E_i`
ancestry and evidence; any identity or content change invalidates dependent
checkpoints.

## Validation Strategy

| Tier | When | Minimum content |
|---|---|---|
| T0 | Each edit | syntax/static checks, ownership and schema invariants |
| T1 | Each counterexample | smallest positive, negative, boundary, adversarial regression |
| T2 | Each lane integration | subsystem runner plus affected producer/consumer boundary |
| T3 | Stable candidate, exact PR head, merge tree, post-merge | canonical quiet `npm run check`, required verifiers/corpora, the exact `I_i -> M_i -> G_i -> E_i` checkpoint transaction with generated zero-diff and content-derived gate evidence, CI, review, runtime/browser/device evidence |

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
  nonempty `allowedPaths`, nonempty `forbiddenOverlap`, tests, evidence, and exit
  condition in `tasks.md`.
- `contracts/task-ownership.json` is the machine-readable ownership authority.
  It MUST contain exactly one nonempty `allowedPaths` array and one nonempty
  `forbiddenOverlap` array for every task ID; a missing, duplicate, empty, or
  concurrently violated entry blocks assignment and merge.
- The same contract contains the frozen initial component candidate-gate
  registry. Every applicable component has nonempty `owned`, `rolling`, and
  `shadow` argv arrays; the workflow executes them directly without a shell on
  the detached exact synthetic candidate merge commit. T048 may append only
  fully contracted T058+ rows.
- `contracts/integration-inventory.json` MUST validate the exact actual
  base-to-candidate path set. Its expected, actual, union, and entry path sets
  are duplicate-free and exactly equal, and each actual path must be allowed by
  its owner without violating any applicable forbidden-overlap rule.
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
| Main moves during proof | Invalidate the affected `I_i -> M_i -> G_i -> E_i` transaction, reconcile once through the living integration owner, rebuild the candidate merge tree, and rerun the prescribed subset. |
| Generated hashes disagree | Do not copy or repair hashes in evidence; regenerate `G_i` from the combined tree as integration owner, run a second generation, require zero diff, and regenerate the content-derived gate evidence. |
| Open PR overlaps campaign paths | Record ownership collision and reuse or wait; do not create a duplicate engine or mutate unrelated issue work. |
| Required compiler/oracle is absent | Use committed readable-byte corpus where contract permits; otherwise record the exact external dependency without weakening the gate. |
| Physical iPad proof is unavailable | Continue all repository-solvable work, retain the exact target-device requirement as blocking, and state the minimum authorized runner action. |

## Complexity Tracking

No constitutional violation or new architectural component is proposed.
