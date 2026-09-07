# HEX-C3-02 Delivery Checklist

**Feature**: [spec.md](../spec.md)
**Plan**: [plan.md](../plan.md)
**Owner**: Luna C3-02
**Status**: implementation, correction, moving-main, generated-output, and
candidate-tree gates complete; independent review, exact-head CI, and live-main
delivery gates remain open

## Ownership and identity

- [x] `js/targets/abi/**` remains the sole ABI semantic owner.
- [x] Adapter, Semantic IR, summary, prototype, and decompiler facts carry one
  matching ABI identity/version and architecture/profile identity.
- [x] arm64e identity is retained and does not silently imply Apple platform ABI.
- [x] No decompiler-private, points-to-private, or architecture-name heuristic
  ABI path exists in the changed files.
- [x] Binary/slice/function/call and Semantic IR version dependencies reject
  stale facts atomically.

## Aggregate and prototype positives

- [x] Integer, FP, and pointer argument rows agree across classifier, adapter,
  Semantic IR, summary, and prototype consumers.
- [x] Integer and FP return rows agree across all consumers.
- [x] Small aggregate one-byte/eight-byte/sixteen-byte boundary rows preserve
  layout, alignment, padding, and piece order.
- [x] Multi-register aggregate rows preserve all pieces and ordering.
- [x] Split register/stack aggregate rows are not repacked by consumers.
- [x] HFA/HVA rows require complete member/layout evidence.
- [x] Hidden sret is represented as a hidden ABI input, not a visible argument.
- [x] Stack offsets, register classes, alignment, and padding agree by profile.
- [x] Known variadic prototypes expose only the proven fixed prefix.
- [x] Forced-stack AAPCS64 HFA/HVA elements use canonical physical slots
  (`max(8, elementBytes)`) with no overlap into the next argument.
- [x] Aggregate padding is fully located, non-overlapping, and deterministic;
  unknown trailing padding is not accepted as exact evidence.
- [x] All exact argument/return stack intervals are safe-integer, overflow-safe,
  and globally non-overlapping except for an explicitly proven canonical split.

## Conservative negatives

- [x] Unsupported ABI publishes no exact placement or prototype.
- [x] Stale/mismatched profile or architecture identity publishes no exact fact.
- [x] Malformed or incomplete aggregate evidence remains explicit.
- [x] Unknown/anonymous variadic frontier remains possible/unknown.
- [x] Indirect-call, thunk, tail-call, and caller/callee contradictions remain
  conflict/unknown rather than majority-selected.
- [x] Cancellation, deadline, truncation, budget exhaustion, and failed
  classifier runs publish no staged exact result.
- [x] Partial profile outcomes (including LP64F/LP64D aggregate flattening and
  vectorcall non-HVA returns) are never upgraded to exact.
- [x] Duplicate scalar stack evidence and contradictory physical intervals
  invalidate the complete result.
- [x] Registry replacement cannot reuse a stale stack-layout cache: cache
  identity is the registered object plus generation/classifier digest.

## Proof and delivery

- [x] Historical baseline counterexample fails at the recorded base SHA.
- [x] Current-main stale-identity and aggregate-grouping counterexamples fail
  at the recorded live-main SHA without production edits.
- [x] Identical post-fix counterexample passes without weakened assertions.
- [x] Paired negatives pass and direct downstream behavior is demonstrated.
- [x] Spec Kit analyze is CLEAN for the current correction artifacts.
- [x] Spec Kit converge is CLEAN for implementation tasks; reviewer/delivery
  tasks remain intentionally open.
- [ ] Review Pass 1 is fresh, adversarial, and performed by a non-owner Luna.
- [ ] Sol targeted semantic review is GO on the exact reviewed head.
- [ ] Review Pass 2 is independent, fresh, and performed after moving-main
  reconciliation.
- [x] Canonical generated build is clean on repeated runs when applicable.
- [ ] Exact-head CI is successful or rule-driven skipped on the intended head.
- [x] Candidate merge tree is validated against newest live main.
- [ ] Live-main post-merge verification records `RESULT: PASS`.
