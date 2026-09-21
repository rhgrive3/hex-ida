# Implementation Plan: C++ Object Readability & Evidence Boundary

**Feature**: `007-cpp-object-evidence`  
**Base**: `main` (`3794a4fe0ddf9dd3452c4ba915c7e2cf1ce342fb`)  
**Strategy**: Two-stage stacked PRs with strict phase ownership isolation.  

---

## 1. Architectural Seams & Ownership

```
[Phase 7 Producer - PR A: feat/cpp-object-evidence]
  js/rtti.js (readVtable, demangleCxx, findCxxClasses)
         │
         ▼
  js/analysis/cxx/object-evidence.js (NEW: Canonical Evidence Producer)
         │
         ├── CppReceiverEvidence
         ├── CppClassIdentity
         ├── CppVtableEvidence
         └── CppVirtualSlotEvidence
         │
         ▼
  tests/phase7/cxx-object-evidence.test.mjs (Unit, Invariant & Mutation Tests)

─────────────────────────────── Boundary (No Cross-Phase Edits) ───────────────────────────────

[Phase 8 Consumer - PR B: feat/cpp-object-decompiler-projection]
         │ (consumes public evidence via decompiler options / context)
         ▼
  js/decompiler/semantic-core.js
         ├── argName: renders 'this' for verified C++ receiver
         ├── MK.FIELD: renders 'this->field_xx' for verified receiver base
         └── renderCall: renders indirect virtual calls with 'this' argument
         │
         ▼
  tests/phase8/cxx-object-decompiler-projection.test.mjs (Unit, Invariant & Mutation Tests)
```

---

## 2. PR A: Phase 7 Producer Implementation Plan

1. **Target Files**:
   - `specs/007-cpp-object-evidence/**`
   - `js/analysis/cxx/object-evidence.js` (NEW)
   - `js/analysis/cxx/index.js` (NEW)
   - `tests/phase7/cxx-object-evidence.test.mjs` (NEW)
2. **Key Capabilities in `js/analysis/cxx/object-evidence.js`**:
   - `createCppReceiverEvidence`: Validates non-static proof, ABI binding, and class identity. Rejects static members, free functions, secondary vtables (`offsetToTop !== 0n`), and unverified `x0`.
   - `createCppClassIdentity`: Differentiates named classes (`className: 'Player'`) from anonymous classes (`className: null`, `isAnonymous: true`).
   - `createCppVtableEvidence`: Encapsulates vtable layout, pointerBytes, offsetToTop, and resolved slots.
   - `createCppVirtualSlotEvidence`: Detects `receiver -> vtable load -> slot load -> indirect call`. Enforces `exactTargetKnown = false` unless target closure is proven.
   - `extractCppObjectEvidence`: Given function metadata, symbols, and optional vtable, returns complete indexed evidence.
3. **Tests in PR A (`tests/phase7/cxx-object-evidence.test.mjs`)**:
   - Positive receiver (constructor, destructor, const member, vtable slot).
   - Ordinary C negative (ARM64 `x0` first arg rejected).
   - Static member negative (C++ static member rejected).
   - Copy transparency (MOV / SSA alias maintains identity).
   - Named class vs Anonymous class (no fabricated names).
   - Virtual slot detection (`virtualSlotKnown = true`, `exactTargetKnown = false`).
   - Non-vtable table negative (callback/jump tables rejected).
   - Multiple inheritance fail-closed (`offsetToTop !== 0n` rejected).
   - Incomplete evidence fail-closed (`completeness: 'partial'` or stale snapshot rejected).
   - Mutation tests (counter-examples fail closed).
4. **Validation**:
   - Run focused Phase 7 test: `node --test tests/phase7/cxx-object-evidence.test.mjs`.
   - Run ownership check: `node tools/validation/phase7-ownership.mjs --files-json '<changed_files>'`.

---

## 3. PR B: Phase 8 Consumer Implementation Plan

1. **Branch**: `feat/cpp-object-decompiler-projection` created on top of PR A HEAD.
2. **Target Files**:
   - `js/decompiler/semantic-core.js`
   - `tests/phase8/cxx-object-decompiler-projection.test.mjs` (NEW)
3. **Key Capabilities in `js/decompiler/semantic-core.js`**:
   - In `argName(v, ctx)`:
     - Check `ctx.opts.cxxEvidence?.receiver` or `ctx.opts.cxxReceiverEvidence`.
     - If verified C++ receiver matches `v`, render `this`.
   - In `renderValueText` / `loc.kind === MK.FIELD`:
     - If base is verified receiver, render `this->field_xx`.
     - Preserve offset-based field name unless authoritative field metadata exists.
   - In `callRecord` / `renderCall`:
     - If call matches `virtualSlotEvidence`, ensure receiver argument renders as `this`.
     - Maintain indirect call syntax (do NOT emit synthetic `this->vtable->slot_8`).
     - Devirtualize to exact target only if `exactTargetKnown === true`.
4. **Tests in PR B (`tests/phase8/cxx-object-decompiler-projection.test.mjs`)**:
   - Receiver presentation: `a1` -> `this`.
   - Field presentation: `a1->field_38` -> `this->field_38`.
   - Ordinary function preservation: `a1` and `a1->field_38` unchanged without evidence.
   - Unknown field: preserves `field_38` without fabricated name.
   - Indirect call: maintains indirect call syntax with `this` argument.
   - Exact target: only when exact is proven.
   - Mutation tests.
5. **Validation**:
   - Run focused Phase 8 test: `node --test tests/phase8/cxx-object-decompiler-projection.test.mjs`.
   - Run ownership check: `node tools/validation/phase8-ownership.mjs --files-json '<changed_files>'`.
   - Verify generated userscript builds cleanly (`npm run userscript:build`) with zero diff on re-run.
