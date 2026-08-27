# Implementation Plan: Loaded-Pointer Recovery

**Branch**: `research-close/integration` | **Date**: 2026-08-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-loaded-pointer-recovery/spec.md`

## Summary

Close HEX-C1-01 by letting the canonical local points-to fixed point consume a current,
identity-valid MemorySSA use/definition proof for a pointer-typed load. A load refines from
`unresolved-load` only when one MustAlias concrete store, exact compatible bytes, a complete stored
pointer fact, and matching provenance are all proven. The current MemorySSA builder remains the sole
memory truth. Production orchestration builds MemorySSA from the baseline points-to floor and then
performs one monotone, atomically published points-to refinement; no MemorySSA rebuild or recursive
memory engine is introduced.

## Technical Context

**Language/Version**: JavaScript ES modules on Node.js v24.14.0 for validation; browser-compatible production JavaScript

**Primary Dependencies**: Existing Semantic IR, SSA, MemorySSA, analysis status, identity,
points-to lattice, and Phase 7 alias solver; no new runtime dependency

**Storage**: In-memory, immutable per-function analysis artifacts; no persistent product storage

**Testing**: `node:test`, recursive Phase 7 runner, Semantic V2 runner, Phase 7 exact-head verifier,
canonical generated-output build, and GitHub Actions exact-head/candidate proof

**Target Platform**: Browser and iOS/iPadOS WebKit fast path; Node.js CI/offline verification

**Project Type**: Browser-first reverse-engineering analysis engine with offline validation tooling

**Performance Goals**: Preserve the current 32-iteration, 65,536-value, 8-target points-to limits;
build MemorySSA lookup indexes once in linear work and add constant-time lookup per load per fixed-
point iteration; no new whole-program or quadratic scan

**Constraints**: Architecture-neutral; deterministic; cancellable; bounded; no MayAlias or unknown
promotion; no partial publication; no second reaching-definition implementation; no unrelated Issue
work; generated output committed only by integration owner

**Scale/Scope**: One function-local points-to analysis and its current canonical MemorySSA artifact;
one exact stored pointer per recovered load. Multi-store byte reconstruction remains HEX-C2-01.

## Current-Main Evidence

- Exact base: `852fcc559711eac680f6853644d390fdb5c1b7f8` after the mandatory pre-implementation moving-main reconciliation from the original audit base `e29187c5be7a62cdf966a821c1d9a0623d8f6ce3`.
- `analyzeLocalPointsTo` returns `TOP/unresolved-load` for every load.
- `reachingConcreteStore` returns a definition only for MustAlias plus `memory-def`, but has no
  indexed production caller.
- `buildSemanticV2CompatibilityPipeline` creates the Phase 7 alias solver before MemorySSA, uses it
  as MemorySSA's canonical alias provider, validates MemorySSA, and projects the same artifact.
- `createAnalysisSurface` already accepts MemorySSA but does not provide it to the points-to solver.
- Phase 7 ownership allows `js/analysis/**` and constrained routing changes in
  `js/semantics/compat/index.js`; it forbids changes to Semantic IR, SSA, MemorySSA, target, core
  identity, and earlier-phase contracts.
- Open PR overlap at preflight: none. No recent unmerged research branch implements C1-01.

## Minimal Failing Case

An architecture-neutral Semantic IR function contains a known pointer value, a complete ordinary
store of that value, and a later complete ordinary load at the same canonical region, width, and
endianness. Validated MemorySSA reports one MustAlias `memory-def` reaching the load. Before the
production change, the loaded value is `TOP` with `unresolved-load`. The first regression freezes
that failure before the bridge is implemented.

Paired negative cases vary one fact at a time: MayAlias, unknown clobber, incomplete call, partial
or incompatible bytes, unknown volatile/atomic semantics, mismatched stored-value width,
provenance mismatch, stale binding, malformed metadata, cancellation, and budget truncation. Each
must remain unresolved.

## Canonical Producer and Consumer Flow

```text
MachineEffects
  -> Semantic IR load/store + exact memory descriptors
  -> scalar SSA
  -> baseline Phase 7 points-to/alias floor
  -> canonical MemorySSA build + validation
  -> identity/completeness/byte/provenance checked loaded-pointer boundary fact
  -> one monotone local points-to refinement
  -> canonical PointsToSet + AnalysisStatus
  -> existing alias/escape/analysis-surface consumers
  -> Phase 7 metrics/verifier and Phase 8 downstream corpus
  -> integration-owned userscript generated artifacts
```

The refinement may consume MemorySSA but MUST NOT feed back into or rebuild that same artifact.
This keeps the dependency acyclic and makes the post-MemorySSA pass a consumer rather than a second
memory authority.

## Implementation Boundary

### Expected changed files

- `js/analysis/pointsto/local.js`: validate and consume the loaded-pointer boundary fact.
- `js/analysis/alias/solver.js`: stage baseline and post-MemorySSA refinement atomically; invalidate
  cached escape facts after a successful replacement.
- `js/analysis/index.js`: pass the already accepted MemorySSA artifact and snapshot binding to the
  canonical solver.
- `js/semantics/compat/index.js`: constrained orchestration only if required to install the
  validated post-build MemorySSA refinement in the production compatibility path.
- `tests/phase7/pointsto/loaded-pointer-recovery.test.mjs`: deterministic positive, negative,
  malformed, cancellation, budget, stale-binding, replay, and downstream cases.
- `tests/phase7/ownership/manifest.test.mjs` or a narrower new ownership regression only if needed
  to machine-enforce the actual inventory before worker fanout.
- `specs/001-loaded-pointer-recovery/**` and
  `docs/analysis-improvement-finding-ledger.md`: Spec Kit and checkpoint evidence.
- `userscript/hex.user.template.js` and `userscript/release-version.json`: only through the canonical
  builder, only at the integration checkpoint.

### Explicitly forbidden files

- `js/semantics/memoryssa/**`, `js/semantics/ssa/**`, `js/semantics/ir/**`, and
  `js/semantics/cfg/**`.
- `js/targets/**`, `js/decompiler/**`, `js/symbolic/**`, and `js/core/identity/**`.
- Earlier-phase tests/verifiers, capability declarations, unrelated Issue tests, and Issue-Agent
  branches or pull requests.
- Hand edits to generated userscript artifacts or deployment identity.

If implementation evidence proves a forbidden contract must change, analysis stops and the plan is
revised; the boundary is not crossed implicitly.

## Completeness and Failure Semantics

- Eligible recovery requires a current binding to the same function/snapshot and supported
  MemorySSA build identity, validated source node IDs, one load use, one MustAlias concrete store,
  matching access metadata, complete load/store nodes, one stored value, equal pointer/load/store
  widths and endianness, ordinary non-volatile/non-atomic sequencing, and a finite stored points-to
  set with compatible provenance.
- Any missing or contradictory item returns the existing conservative loaded-pointer state. A
  refusal may enrich diagnostics but cannot manufacture a target.
- A partial/truncated/cancelled refinement is not installed. The baseline points-to result remains
  authoritative, so no partially staged precision leaks to alias or escape consumers.
- Multiple stores or partial-store reconstruction are not accepted even if bytes appear to agree;
  they belong to HEX-C2-01's byte-proof object.
- Unknown provider, incomplete call, unknown memory effect, memory phi/non-convergence, and stale
  snapshot all fail closed.

## Invalidation and Identity

- The boundary binding includes snapshot, function, Semantic IR contract, MemorySSA build, source
  load/store node, use/definition, access metadata, and proof identities.
- Runtime validation cross-checks the MemorySSA source entities and memory descriptors against the
  current immutable IR rather than trusting a matching function name.
- Successful refined points-to replacement invalidates the cached escape analysis; failed
  refinement changes no cache.
- A changed IR, MemorySSA build, snapshot, function, access metadata, or proof source requires a new
  refinement. No old green result is reused across those identities.

## Performance, Cancellation, and Budgets

- Pre-index IR nodes, values, MemorySSA uses, definitions, and access metadata once. Do not scan all
  MemorySSA rows from every load transfer.
- Preserve `maxValues`, `maxIterations`, `widenAfterIterations`, and `maxTargetsPerSet` behavior.
- Check cancellation before indexing, during fixed-point iterations, and at publication. A cancel or
  budget stop keeps the baseline result and records the conservative status.
- No worker, thread, solver, persistent cache, or architecture-specific path is added.

## Test and Integration Strategy

### T0

- Syntax-check changed modules and the focused test.
- `npm run lint`.
- Phase 7 ownership manifest and actual inventory check.

### T1

- Pre-fix deterministic counterexample fails for the expected `unresolved-load` result.
- Positive exact store/load and field-offset cases.
- MayAlias, unknown/partial/incomplete call, width, endian, provenance, volatile/atomic, malformed,
  stale, truncation, cancellation, and budget negatives.
- Two-run deterministic replay and lattice monotonicity.

### T2

- `npm run phase7:test`.
- `npm run semantic-v2:test` because the bridge consumes Semantic V2 artifacts.
- Existing analysis-surface downstream positive/negative regression.
- `npm run phase8:test` to catch decompiler consumer and provenance regressions.
- Architecture-neutral fixture replay.

### T3

- Refetch live main and reconcile once through Sol.
- `npm run phase7:ownership` on the actual candidate inventory.
- Canonical `npm run userscript:build`, commit owned output, rebuild, and require zero diff.
- `npm run phase7:verify -- --expect-sha <exact-head>` and applicable rolling gates.
- Build and test the actual candidate merge tree against current main.
- Required GitHub CI green on the exact PR head; no unexplained red workflow.
- Sol final diff/soundness review, expected-head merge, refetch main, and post-merge verifier.

## Constitution Check

*GATE: Passed before Phase 0 research and re-checked after Phase 1 design.*

| Gate | Result | Evidence |
|---|---|---|
| One canonical semantic truth | PASS | Existing MemorySSA query is consumed; no memory engine or private decompiler path is added |
| Explicit uncertainty and false-certainty blockers | PASS | Every incomplete/unknown/stale/unsupported case remains unresolved |
| Deterministic counterexample and negative proof | PASS | T1 freezes positive and per-boundary negative cases before implementation |
| Bounded/cancellable/browser-safe | PASS | Existing function-local limits retained; indexed linear bridge; no new dependency/thread |
| Exact product/integration proof | PASS | T3 binds exact head, candidate tree, generated output, verifier, CI, merge, and live main |
| Ownership and Issue-Agent isolation | PASS | Phase 7 manifest defines allowed/forbidden paths; open PR overlap is zero |
| Denominator and assertion integrity | PASS | Existing corpora remain unchanged except additive cases; no weakened checks |

Post-design review found no constitution violation and no item requiring Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/001-loaded-pointer-recovery/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── loaded-pointer-boundary.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
js/analysis/
├── index.js
├── alias/solver.js
└── pointsto/local.js

js/semantics/compat/
└── index.js

tests/phase7/
├── pointsto/
└── ownership/

tools/validation/phase7/
userscript/
```

**Structure Decision**: Extend the existing Phase 7 owner and constrained Semantic V2 compatibility
routing seam. Add no new subsystem, package, or semantic contract.

## Dependency Graph

```text
C1-03 provenance roots [complete]
  -> C1-01 loaded-pointer recovery [this feature]
      -> C2-01 byte-exact reconstruction
      -> C3-02 prototype/aggregate consumers
      -> C4-03 projection provenance

C4-01 lifecycle [complete] and X-01/S2 identity gates [complete]
  -> verification prerequisites only
```

## Complexity Tracking

No constitution violation requires justification.
