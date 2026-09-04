# Contract: Tiered Exact QF_BV Solver

1. `TieredBvBackend` has exact authority only while both configured tiers satisfy `isExactProofBackend`.
2. `classifyTieredQuery` is deterministic and never routes malformed/unsupported input.
3. The exhaustive tier is preferred only for complete feasible <=8-bit domains; a resource-limited exhaustive attempt may fall through only to the exact bit-blast tier.
4. The bit-blast tier returns SAT/UNSAT only for supported QF_BV formulas and only after complete compilation/search.
5. Every SAT model satisfies the original `VerificationQuery` under `validateSatModel`; failure becomes non-publishable `provider-failure`.
6. SAT bindings are complete, contain no extra keys, and use primitive Boolean or canonical in-range `bigint` BV values; result/model/evidence snapshots are transitively read-only.
7. Constructor constraint/node/depth/yield ceilings are global route authority. Per-check and per-session options may only narrow them.
8. Query identity accepts canonical plain data only and is independently bounded by node, reference-edge, and longest-DAG-depth ceilings.
9. Exhaustive enumeration checks a monotonic host deadline and cancellation internally, independent of task-queue yields.
6. The canonical query hash is recomputed from expression and identity content at session, router, host, and Worker boundaries. Caller-supplied hash reuse with changed content is invalid; every proof result then matches the recomputed hash, provider ID/version, routed backend identity, and Worker request ID/token.
7. Unsupported, invalid, unknown, resource-limited, timeout, cancel, stale, disposed, corrupt-model, and corrupt-transport outcomes never publish exact evidence.
8. The production default contains no heuristic/test backend and has no network/runtime dependency.
9. Identical input and deterministic ceilings yield identical semantic/structural evidence. Timing and host-memory samples are observational only.
10. DAG inspection is iterative, call-local, cycle-aware, and stops at the exact node ceiling. Capability and runtime budgets accept only primitive safe integers and never coerce or widen malformed values.
