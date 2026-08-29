# HEX-C3-02 Delivery Checklist

**Feature**: [spec.md](../spec.md)  
**Plan**: [plan.md](../plan.md)  
**Owner**: Luna C3-02  
**Status**: pre-implementation; current-main correction is recorded, and the
production gate awaits refreshed `ANALYZE=CLEAN` plus Sol approval

## Ownership and identity

- [ ] `js/targets/abi/**` remains the sole ABI semantic owner.
- [ ] Adapter, Semantic IR, summary, prototype, and decompiler facts carry one
  matching ABI identity/version and architecture/profile identity.
- [ ] arm64e identity is retained and does not silently imply Apple platform ABI.
- [ ] No decompiler-private, points-to-private, or architecture-name heuristic
  ABI path exists in the changed files.
- [ ] Binary/slice/function/call and Semantic IR version dependencies reject
  stale facts atomically.

## Aggregate and prototype positives

- [ ] Integer, FP, and pointer argument rows agree across classifier, adapter,
  Semantic IR, summary, and prototype consumers.
- [ ] Integer and FP return rows agree across all consumers.
- [ ] Small aggregate one-byte/eight-byte/sixteen-byte boundary rows preserve
  layout, alignment, padding, and piece order.
- [ ] Multi-register aggregate rows preserve all pieces and ordering.
- [ ] Split register/stack aggregate rows are not repacked by consumers.
- [ ] HFA/HVA rows require complete member/layout evidence.
- [ ] Hidden sret is represented as a hidden ABI input, not a visible argument.
- [ ] Stack offsets, register classes, alignment, and padding agree by profile.
- [ ] Known variadic prototypes expose only the proven fixed prefix.

## Conservative negatives

- [ ] Unsupported ABI publishes no exact placement or prototype.
- [ ] Stale/mismatched profile or architecture identity publishes no exact fact.
- [ ] Malformed or incomplete aggregate evidence remains explicit.
- [ ] Unknown/anonymous variadic frontier remains possible/unknown.
- [ ] Indirect-call, thunk, tail-call, and caller/callee contradictions remain
  conflict/unknown rather than majority-selected.
- [ ] Cancellation, deadline, truncation, budget exhaustion, and failed
  classifier runs publish no staged exact result.
- [ ] Partial profile outcomes (including LP64F/LP64D aggregate flattening and
  vectorcall non-HVA returns) are never upgraded to exact.

## Proof and delivery

- [x] Historical baseline counterexample fails at the recorded base SHA.
- [x] Current-main stale-identity and aggregate-grouping counterexamples fail
  at the recorded live-main SHA without production edits.
- [ ] Identical post-fix counterexample passes without weakened assertions.
- [ ] Paired negatives pass and direct downstream behavior is demonstrated.
- [ ] Spec Kit analyze is CLEAN.
- [ ] Spec Kit converge is CLEAN after all tasks.
- [ ] Review Pass 1 is fresh, adversarial, and performed by a non-owner Luna.
- [ ] Sol targeted semantic review is GO on the exact reviewed head.
- [ ] Review Pass 2 is independent, fresh, and performed after moving-main
  reconciliation.
- [ ] Canonical generated build is clean on repeated runs when applicable.
- [ ] Exact-head CI is successful or rule-driven skipped on the intended head.
- [ ] Candidate merge tree is validated against newest live main.
- [ ] Live-main post-merge verification records `RESULT: PASS`.
