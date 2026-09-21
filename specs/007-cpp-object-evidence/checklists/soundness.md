# Soundness & Adversarial Review Checklist

**Feature**: `007-cpp-object-evidence`  
**Purpose**: Pre-merge and post-implementation verification against negative cases and counter-examples.  

---

## Adversarial Review Checklist (12 Invariants)

1. [ ] **Ordinary ARM64 x0 treated as this?**  
   *Counter-example*: `void do_something(int a1)` with `x0`. Must stay `a1`.
2. [ ] **Static member treated as this?**  
   *Counter-example*: `static void Player::Reset()` with `x0`. Must stay `a1`.
3. [ ] **Demangled name alone treated as receiver?**  
   *Counter-example*: Demangled `Player::Reset()` without non-static proof must not produce receiver claim.
4. [ ] **Arbitrary pointer table treated as vtable?**  
   *Counter-example*: Callback table / jump table without RTTI / vptr semantics must be rejected.
5. [ ] **Candidate 1 treated as exact target?**  
   *Counter-example*: Single candidate in `scopedCallTargetRows` without closed universe must keep `exactTargetKnown = false`.
6. [ ] **Partial candidate set treated as closed?**  
   *Counter-example*: Non-exhaustive candidates must remain `closureProven = false`.
7. [ ] **Multiple inheritance causing wrong this / target?**  
   *Counter-example*: Secondary vtable with `offsetToTop = -16n` must fail closed.
8. [ ] **Stale evidence consumed across functions or snapshots?**  
   *Counter-example*: Stale `snapshotId` must be rejected immediately.
9. [ ] **Anonymous class given a fictitious name?**  
   *Counter-example*: Vtable without symbol must have `className = null`, never `Class_1234`.
10. [ ] **Field offset used to fabricate semantic field names?**  
    *Counter-example*: Offset `0x38` must render as `field_38`, never `health`.
11. [ ] **Whole-binary rescan on every decompile?**  
    *Counter-example*: Decompile must perform $O(1)$ lookup into pre-extracted evidence index.
12. [ ] **Product output reaches decompiled code?**  
    *Counter-example*: Pseudocode output must verifiably change from `a1->field_38` to `this->field_38`.
