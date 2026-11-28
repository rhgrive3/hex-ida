# Conditional SCPA Extensions — Source Contracts

Last updated: 2026-11-28

These opt-in contracts implement bounded conditional analysis extensions (`L03`, `L06`, `L07`, `L09`) inside the scoped analysis service without creating a new global semantic owner or changing default release flags.

## L03: Scalar Induction Over a Host-Owned Model

- Entry points: `check_loop_invariant` / `AnalysisQueryAPI.checkLoopInvariant(snapshot, request, options)` (`js/core/evidence/loop-invariant.js`, `js/core/evidence/loop-synthesis.js`).
- A private host owner `getLoopModelContext(functionId, loopId, { world, assumptions, snapshotId, signal })` supplies `{ model, binding, isCurrent }`. Models and callbacks cannot be supplied by external/AI query arguments; a missing owner returns `unsupported`.
- `scpa-scalar-loop-model/v1` models one unsigned 1–64-bit value, inclusive entry/guard intervals, and a signed constant modular step (canonical decimal strings) under observable contract `unsigned-register-at-header-and-exit-only`.
- The checker analytically verifies initiation, preservation, and exit containment across modular wrap (bounded unrolling is never accepted as induction). An optional non-wrapping monotonic rank proves termination only for the declared model.
- Bounded candidate synthesis (`synthesize: true`) tries at most three templates replayed by the same checker. Saved `capsule` objects require full live rebinding against the current owner.
- Results never authorize decompiler rewrites or claim whole-function proof; general source-to-CFG extraction, flags, memory, faults, and exceptions remain outside this contract.

## L06: Bounded Context-Refinement Admission

- Entry points: `query_demand_precision` / demand precision queries accept optional `adaptiveRefinement: { enabled: true, maximumRefinements, maximumFamilies, warmupSamples, minimumGain, maximumMeasuredWork }`. Omitting it preserves default behavior.
- The policy scopes only the existing conditional range owner without narrowing canonical facts or introducing a parallel semantic cache or SCC scheduler.
- Family identity binds world, assumptions, snapshot, function, source summary digest, SCC revision, and positive artifact ownership. Grants are private, single-use, session-scoped, and survive resume without resetting quotas.
- Hard bounds: at most 32 admissions and 32 families. `maximumMeasuredWork` is a next-admission stop threshold; the parent `ResourceBudget` remains the hard resource cap.

## L07: Order in a Captured-Event Model

- Entry points: `inspect_async_event_order` / `AnalysisQueryAPI.asyncEventOrder(snapshot, request, options)` reading a private `getAsyncEventContext(runtimeSessionId, scope)` owner. Queries never start tasks, attach instrumentation, or capture new events.
- `scpa-async-events/v1` accepts bounded graphs (at most 512 events, 2,048 edges, 32 versioned contracts, depth 128, 1 MiB snapshot). Only explicit contract rules (`sequenced-before`, `task-spawn`, `task-join`, `continuation-resume`, `queue-delivery`) with compatible kinds, one-use tokens, and matching object generation create edges; equal actor/executor IDs or timestamps do not.
- Any cycle in the retained graph prevents presenting a subpath as a consistent order. `lifetimeProven`, `semanticProof`, and `staticHappensBeforeProven` remain `false`.

## L09: Detached Integer & Loop Replay

- Documented in [`../tools/portable-checker/README.md`](../tools/portable-checker/README.md) (`tools/portable-checker/check.mjs`, `tools/portable-checker/bundle.mjs`, `js/core/evidence/portable-replay.js`, `js/core/evidence/portable-loop.js`).
- Reuses the independent arithmetic/loop checker over data-only capsules and multi-certificate bundles. Full live rebinding against the current host owner is required after detached transport; detached replay never confers root-query proof authority on its own.

## Related Documents

- [`SCPA_CONDITIONAL_MODELS.md`](SCPA_CONDITIONAL_MODELS.md) — optional SVE/SME/finite-memory model interfaces, loop synthesis, task idiom views, and `RuntimeEvent` observation binding.
- [`SCPA_FUNCTIONAL_ACCEPTANCE.md`](SCPA_FUNCTIONAL_ACCEPTANCE.md) — native SCPA acceptance scope, test commands, and remaining external gates.
- [`../tools/competitive-arm64/TRIALS.md`](../tools/competitive-arm64/TRIALS.md) — bounded resumable trial protocol.
