# Research: C++ Object Evidence & Subsystem Connection

**Feature**: C++ Object Readability for Game Analysis (`007-cpp-object-evidence`)  
**Date**: 2026-09-21  
**Status**: Completed  

---

## 1. Existing Subsystem Inventory

| Subsystem | File / Seam | Implemented Capabilities | Gap / Missing Connection to Decompiler |
|---|---|---|---|
| **RTTI & Mangling** | `js/rtti.js` | `demangleCxx`: Itanium mangling, nested namespaces, const/volatile/restrict, constructors (`C1`/`C2`), destructors (`D0`/`D1`/`D2`), operators, thunks (`_ZTh`).<br>`findCxxClasses`: Discovers classes via `_ZTV`, `_ZTI`, `_ZTS` symbols.<br>`readVtable`: Reads `offsetToTop` (word 0), `typeinfo` (word 1), virtual slots (words 2..N). Handles chained pointers (formats 1, 2, 6, 7, 9, 10, 12) and ILP32 (`arm64_32`, 4-byte slots). | No connection to Phase 7/8 analysis pipeline. Discovered classes and parsed vtables are currently only queried ad-hoc in UI tools (`js/tools-base.js`). Never published as canonical function/receiver evidence. |
| **Field & Aggregate Layout** | `js/decompiler/types/layout.js` | `recoverAggregateLayouts`: Infers `kind: 'struct-or-object'` or `array` from MemorySSA loads/stores at fixed non-overlapping offsets. Generates `field_OFFSET` or resolves via `fieldFor`. | `struct-or-object` is purely structural. It has no nominal C++ class authority. Fixed-offset accesses on `x0` do not prove `Player *`. |
| **Presentation Core** | `js/decompiler/semantic-core.js` | `MK.FIELD`: Renders `base->field_xx`.<br>`argName`: Renders `self` only if `ctx.opts.receiverType` or `methodKind === 'objc'`. Otherwise renders `a1`..`a8`.<br>`renderCall`: Renders `call(args)`. If target is indirect, renders `unknown_call(...)`. | Has no concept of C++ `this`. First parameter in non-static C++ member functions always renders as `a1`. Field accesses render as `a1->field_xx`. Indirect virtual calls render as `unknown_call(...)` or pointer cast call without identifying `this`. |
| **Call Targets** | `js/analysis/query/semantic/call-targets.js` | `scopedCallTargetRows`: Resolves literal/ranged targets. Explicitly states: *\"Selected canonical target references, not discovery or target-set closure. exact: false, closed: false\"*. | Candidate references are non-closed. Cannot be used to assert exact devirtualization without an explicit closure proof. |
| **Call Candidate Summaries** | `js/analysis/summary/scoped-call-candidates.js` | `bindScopedSummaryCallCandidates`: Bounded linking of indirect call candidate functions. Explicitly sets `targetClosure: 'unknown'`, `exact: false`. | Does not prove target-set closure. Candidate count = 1 does not mean exact singleton dispatch target. |
| **Semantic IR & SSA** | `js/semantics/ir/`, `js/decompiler/semantic-core.js` | Explicit value IDs, `OP.LOAD`, `OP.STORE`, `OP.MOV`, `OP.CALL`. Values track `kind === 'arg'`, `reg === 'x0'`, `uses`, and `def`. | SSA value identities exist, but there is no canonical contract asserting that a given value represents a verified C++ object receiver. |

---

## 2. Research Findings by Area

### A1. RTTI & Vtable Authority
1. **Class Identity Authority**:
   - In unstripped binaries, class identity originates from Itanium mangled symbols:
     - `_ZTV<class>` (vtable)
     - `_ZTI<class>` (typeinfo)
     - `_ZTS<class>` (typeinfo name)
   - In stripped binaries, class symbols do not exist. However, vtable structures (word 0: offset-to-top, word 1: typeinfo, words 2..N: function pointers) may exist in read-only data segments. For stripped binaries, we assign a stable anonymous identity (`vtable:0x...`) without synthesizing a fictitious class name (such as `Player` or `Class_1000`).
2. **Vtable Identity & Layout**:
   - In Itanium C++ ABI, the object's vptr points to slot 0, which is `vtableAddress + 2 * pointerBytes` (skipping `offsetToTop` and `typeinfo`).
   - Slot index $k \ge 0$ is located at byte offset $(2 + k) \times \text{pointerBytes}$ from the vtable symbol base, or $k \times \text{pointerBytes}$ from the vptr.
3. **Slot Target Exactness**:
   - A slot target pointer is exact only if relocation / fixup resolution succeeds (`unresolved === false`).
   - If PAC authentication or chained pointer binding cannot be resolved, the slot entry remains unresolved (`unresolved: true`) and cannot be trusted as an address.
4. **Inheritance & Secondary Vtables**:
   - **Primary base**: `offsetToTop === 0n`.
   - **Secondary base (Multiple Inheritance)**: `offsetToTop !== 0n` (negative offset). Non-virtual thunks (`_ZThn...`) adjust `this` by this offset before jumping to the actual method.
   - **Guardrail**: If `offsetToTop !== 0n` or adjusting thunks are present, we MUST NOT equate the pointer with the primary object. If adjustment is unhandled, we MUST fail closed (downgrade receiver/class/target claims).
5. **ARM64e and ARM64_32**:
   - `pointerBytes` is 8 for LP64, 4 for ILP32 (`arm64_32`).
   - Chained pointer decoding formats 1, 2, 6, 7, 9, 10, 12 must be respected. Never mask high bits to guess addresses.

### A2. Field & Layout
1. `recoverAggregateLayouts` observes MemorySSA accesses. While it identifies non-overlapping fixed offsets and tags them `struct-or-object`, this is purely structural.
2. A fixed-offset access pattern `base + 0x38` does NOT prove that `base` is a C++ class instance or nominal type `Player *`.
3. In decompilation, field spelling `field_38` must be preserved unless authoritative field name metadata (e.g. from debug info or notes) explicitly maps offset `0x38` to a named member. Fabricating field names (e.g., `health`, `position`) from offsets alone is strictly forbidden.

### A3. C++ Receiver
1. **AAPCS64 Argument Binding**:
   - AAPCS64 specifies that the first argument is passed in register `x0`.
   - `x0` is simply argument 0; it is NOT inherently `this`. Treating every `x0` as `this` is a major violation.
2. **Proof of Non-Static Member**:
   - Non-static member status requires positive evidence:
     - Mangled symbol with explicit constructor (`_ZN...C1...`), destructor (`_ZN...D0...`), or cv-qualifier (`_ZNK...`), OR
     - Presence of the function address in a valid class vtable slot, OR
     - Explicit authoritative metadata indicating `isStatic: false` / `memberKind: 'non-static'`.
   - Free functions (e.g., `_Z6updateP6Player`) and C functions (`sub_1000`) MUST NOT produce receiver evidence.
   - Static member functions (e.g., `_ZN6Player5ResetEv` with `isStatic: true`) MUST NOT produce receiver evidence.
3. **Canonical Value Identity & Copy Chains**:
   - The receiver is bound to the canonical IR argument value at entry (`v.kind === 'arg'`, `v.reg === 'x0'`).
   - If `this` is copied via `MOV` (e.g. `MOV x19, x0`), the SSA value retains the same canonical identity.
   - If the value is clobbered, overwritten, or re-assigned, receiver identity is broken.

### A4. Indirect & Virtual Call
1. **Canonical Virtual Call Pattern**:
   ```
   vptr = load [receiver + 0]
   method_ptr = load [vptr + slot_offset]
   call method_ptr(receiver, ...)
   ```
2. **Virtual Slot vs. Exact Target**:
   - When the above pattern is established:
     - `virtualSlotKnown = true`
     - `slotIndex = slot_offset / pointerBytes`
   - However, `exactTargetKnown` CANNOT be assumed from candidate count = 1.
   - `scopedCallTargetRows` and `scoped-call-candidates.js` explicitly state: *`targetClosure: 'unknown'`, `exact: false`*.
   - Unless an authoritative proof establishes target-set closure (e.g., final class, or constructor context where dynamic type cannot vary), `exactTargetKnown` MUST remain `false`.
   - In decompiler projection:
     - Virtual call semantics are preserved: indirect call syntax is maintained.
     - The receiver argument passed to the call is improved from `a1` to `this`.
     - Exact call projection (`Player::Update(this)`) is emitted ONLY when target set closure is explicitly proven.

---

## 3. Performance & Complexity Architecture

To guarantee zero impact on fast profiling and bounded latency:
1. **No whole-binary rescan during decompilation**:
   - Class and vtable extraction is performed once per binary / artifact session and cached.
   - Function decompilation performs an $O(1)$ lookup in the indexed evidence table.
2. **Immutable & Frozen Data Structures**:
   - All evidence records are deeply frozen (`deepFreeze`) with provenance digests.
3. **Fail-Closed Strategy**:
   - Any missing relocation, non-zero offset-to-top, conflicting assignment, or stale snapshot ID yields an explicit `rejected` status or `completeness: 'partial'` without emitting false claims.
