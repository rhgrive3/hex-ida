# Requirements Checklist: C++ Object Evidence

**Feature**: `007-cpp-object-evidence`  
**Status**: Normative Checklist  

---

## 1. Core Principles

- [ ] **No Reimplementation**: Existing `js/rtti.js`, `js/decompiler/types/layout.js`, and `js/analysis/summary/scoped-call-candidates.js` are connected, not rewritten.
- [ ] **Stacked PR Ownership**:
  - [ ] PR A (`feat/cpp-object-evidence`) touches ONLY `specs/**`, `js/analysis/**`, `tests/phase7/**`.
  - [ ] PR A does NOT modify `js/decompiler/**`.
  - [ ] PR B (`feat/cpp-object-decompiler-projection`) touches ONLY `js/decompiler/**`, `tests/phase8/**`.
  - [ ] PR B does NOT modify `js/analysis/**`.
- [ ] **Low-Token Test Execution**: Tests run with focused commands. Broad runs use quiet wrappers.

---

## 2. Receiver & Class Requirements

- [ ] **No `x0 == this` shortcut**: `x0` alone is never accepted as `this`.
- [ ] **Non-static member proof**: Only constructors, destructors, cv-qualified members, vtable members, or explicit non-static metadata qualify.
- [ ] **Static member negative**: C++ static members never receive receiver evidence.
- [ ] **Ordinary C negative**: C functions with argument 0 never receive receiver evidence.
- [ ] **Copy transparency**: When `this` is copied via `MOV` or canonical SSA alias, identity is preserved.
- [ ] **Named vs. Anonymous Class**:
  - [ ] Named class emits verified class name (e.g., `Player`).
  - [ ] Anonymous class preserves identity via vtable address/key without inventing names.
- [ ] **Stripped Binary**: No fictitious class names are invented.

---

## 3. Multiple Inheritance & Soundness

- [ ] **Non-zero offset-to-top**: Fails closed / rejected as primary receiver.
- [ ] **Adjusting thunks**: Fails closed / rejected if unadjusted.
- [ ] **Secondary vtables**: Cannot be conflated with primary object.

---

## 4. Virtual Call & Devirtualization

- [ ] **Virtual slot pattern recognized**: `receiver -> vptr -> slot -> indirect call`.
- [ ] **Virtual slot known**: `virtualSlotKnown = true`.
- [ ] **Exact target separated**: `exactTargetKnown = false` unless closed universe is proven.
- [ ] **No synthetic vtable field**: Do not output `this->vtable->slot_8(...)`.

---

## 5. Decompiler Projection (PR B)

- [ ] `this` replaces `a1` only when receiver evidence is exact.
- [ ] `this->field_xx` replaces `a1->field_xx`.
- [ ] Field names are NOT fabricated (stays `field_xx` unless real name metadata exists).
- [ ] Indirect virtual call retains indirect call semantics, with receiver argument updated to `this`.
- [ ] Exact target devirtualization emitted only if target set closure is explicitly proven.

---

## 6. Performance & Budgets

- [ ] No whole-binary rescan per decompile.
- [ ] No vtable re-parsing per function.
- [ ] Lookup cost during decompilation is $O(1)$ / bounded.
- [ ] Fast profile exhibits no significant overhead.
