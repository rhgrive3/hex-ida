# Conditional SCPA extensions — experimental source contracts

These extensions implement preparatory parts of architecture section 33.3 (L03, L06, L07, L09). They do **not** satisfy its measured-production-bottleneck triggers or release exits. The normal scoped host remains opt-in, no release flag changes, and no new global semantic owner is created.

## L03: scalar induction over a host-owned model

`check_loop_invariant` / `AnalysisQueryAPI.checkLoopInvariant(snapshot, request, options)` accepts a function locator, loop ID, a postcondition, and either a candidate invariant or bounded `synthesize: true`; a saved `capsule` may also be supplied for full live rebinding. A privately configured `getLoopModelContext(functionId, loopId, {world, assumptions, snapshotId, signal})` supplies `{model, binding, isCurrent}`. No model or callback may be passed by an AI query. An absent owner returns unsupported.

`scpa-scalar-loop-model/v1` describes one unsigned 1–64-bit value, inclusive entry and guard intervals, and a signed constant modular step. All integer bounds/steps are canonical decimal strings. The observable contract is `unsigned-register-at-header-and-exit-only`. The checker analytically checks initiation, preservation and exit containment over every model state, including modular wrap; it does not accept bounded unrolling as induction. An optional non-wrapping monotonic rank establishes termination only for that model. Counterexamples are model-state witnesses, not necessarily reachable machine states.

The private binding contains current world, assumptions, snapshot, function, loop, revision, artifact and nonempty source references. The caller's model correspondence is **not** independently proved by those labels. Source-to-CFG extraction, general automatic invariant synthesis, simulation relations, flags, memory, faults, exceptions and other registers remain open. Session11 adds only three bounded candidate templates replayed by the existing checker. Results never authorize rewrites or claim whole-function proof.

## L06: bounded, measured context-refinement admission

The existing `query_demand_precision` tool and demand query accept optional `adaptiveRefinement: {enabled: true, maximumRefinements, maximumFamilies, warmupSamples, minimumGain, maximumMeasuredWork}`. Omit it to preserve existing behavior. The policy may restrict only the existing conditional range owner; it does not narrow canonical facts or create another semantic cache or SCC scheduler.

Family identity includes world, assumptions, snapshot, function, source summary digest, SCC revision and positive artifact ownership. Grants are private, single-use, session-scoped and survive resume without resetting quotas. Concurrent grants, foreign/serialized specializations and retired sessions are refused. Actual parent work and I/O counter differences are recorded. The gain metric counts comparable owner-local constants or full-to-nonfull ranges, not semantic recall, task success or proof. No shared denominator, incomplete execution and ambiguous duplicate IDs are unmeasured, not zero-gain samples.

Finite bounds are 32 admissions and 32 families at most. `maximumMeasuredWork` is a **next-admission stop threshold**, not a per-child hard quota: one admitted owner evaluation can cross it. The existing parent `ResourceBudget` remains the hard limit. Real recall/latency/memory tuning, deeper/adaptive call-string partitions, production corpus triggers and default rollout remain open.

## L07: order in a captured-event model

`inspect_async_event_order` / `AnalysisQueryAPI.asyncEventOrder(snapshot, request, options)` reads a private `getAsyncEventContext(runtimeSessionId, scope)` owner. It never starts tasks, attaches instrumentation or captures new events. Binding includes world, assumptions, snapshot, runtime session, epoch, module generation and owner revision; both owner and service must remain current through publication.

The bounded `scpa-async-events/v1` source has events, relations, versioned contracts and explicit remaining obligations. Only sequenced-before, task-spawn, task-join, continuation-resume and queue-delivery contract rules can supply edges. Paired operations require compatible kinds, a one-use token and the same object generation. Equal actor/executor IDs or timestamps do not create order. Unsupported/mismatched contracts, duplicate strand sequencing, competing token partners, missing events, depth cuts and cycles remain explicit. A cycle anywhere in the retained graph prevents an attractive subpath from being presented as consistent order.

Optional lifetime queries compare only captured allocation/use/disposal boundaries of the same object generation. `lifetimeProven`, `semanticProof` and `staticHappensBeforeProven` remain false. This is not a Swift runtime implementation, race detector, memory-order oracle, complete trace or proof of natural execution. Bounds: 512 events, 2,048 edges, 32 contracts, depth 128 and a 1 MiB input snapshot. Current browser/runtime capture adapters and qualified version-specific runtime contracts remain open.

## L09: small detached integer replay

See `tools/portable-checker/README.md`. Current native proposals/source bytes and a core-only portable replay surface are wired through the existing scoped API and read-only tools. The independent arithmetic rule is reused from U04, not counted again as a new checker. Full live rebind is required after detached transport; even a matching capsule is not a root-query proof. No WASM/native provider, dynamic executable input or automatic provider installation is added.

## Verification boundary

The focused tests include actual native worker/range/proposal paths for L06/L09; L03/L07 use explicit model/host fixtures. Small-width loop obligations are compared against exhaustive finite states, not against a production ISA oracle. Tests intentionally cover failure, empty input, stale generations, cancellation and finite quotas. Passing these fixtures does not qualify production bottleneck triggers, device operation, full repository gates or competitor outcomes.

## Session11 extensions

See `SCPA_CONDITIONAL_MODELS.md` for optional SVE/SME/finite-memory model interfaces, loop candidate synthesis, task views, and the read-only current RuntimeEvent bridge. These additions do not enable default execution or confer native semantic authority. See `../tools/portable-checker/README.md` for integer/loop replay and certificate bundles.


## Session12: functional evidence and resumable trials

See `docs/SCPA_FUNCTIONAL_ACCEPTANCE.md` for the actual ELF/decoder/Worker/public QueryAPI acceptance path and explicit remaining gates. Bounded trial continuation is documented in `tools/competitive-arm64/TRIALS.md`. Historical source percentages are not converted to feature or release acceptance; the90% target is not admitted.
