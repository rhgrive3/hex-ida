# Tasks: C++ Object Readability Implementation

**Feature**: `007-cpp-object-evidence`  
**Status**: Ready for Implementation  

---

## PR A — Phase 7 Producer (`feat/cpp-object-evidence`)

- [ ] **Task A1: Spec Kit Completion**
  - [x] Create `specs/007-cpp-object-evidence/spec.md`
  - [x] Create `specs/007-cpp-object-evidence/research.md`
  - [x] Create `specs/007-cpp-object-evidence/data-model.md`
  - [x] Create `specs/007-cpp-object-evidence/contracts/cpp-object-evidence.contract.md`
  - [x] Create `specs/007-cpp-object-evidence/checklists/requirements.md`
  - [x] Create `specs/007-cpp-object-evidence/checklists/soundness.md`
  - [x] Create `specs/007-cpp-object-evidence/plan.md`
  - [x] Create `specs/007-cpp-object-evidence/tasks.md`

- [ ] **Task A2: Public Evidence Module Implementation (`js/analysis/cxx/object-evidence.js`)**
  - [ ] Implement `createCppReceiverEvidence`
  - [ ] Implement `createCppClassIdentity`
  - [ ] Implement `createCppVtableEvidence`
  - [ ] Implement `createCppVirtualSlotEvidence`
  - [ ] Implement `extractCppObjectEvidence`
  - [ ] Implement `validateCppObjectEvidence`
  - [ ] Implement `js/analysis/cxx/index.js` exports

- [ ] **Task A3: Unit, Soundness, and Mutation Tests (`tests/phase7/cxx-object-evidence.test.mjs`)**
  - [ ] Positive receiver (C++ non-static member, ctor, dtor, const member, vtable member)
  - [ ] Ordinary C negative (ARM64 x0 first arg rejected)
  - [ ] Static member negative (C++ static member rejected)
  - [ ] Copy transparency (MOV / SSA alias maintains identity)
  - [ ] Named class vs Anonymous class (no fabricated class names)
  - [ ] Virtual slot detection (`virtualSlotKnown = true`, `exactTargetKnown = false`)
  - [ ] Non-vtable table negative (callback / jump table rejected)
  - [ ] Multiple inheritance fail-closed (`offsetToTop !== 0n` rejected)
  - [ ] Incomplete evidence fail-closed (`completeness: 'partial'` or stale snapshot rejected)
  - [ ] Adversarial mutation test suite (11 mutations)

- [ ] **Task A4: Verification & Ownership Gate for PR A**
  - [ ] Run focused tests: `node --test tests/phase7/cxx-object-evidence.test.mjs`
  - [ ] Validate Phase 7 ownership: `node tools/validation/phase7-ownership.mjs --files-json '<pr_a_files>'`
  - [ ] Verify zero modified files outside Phase 7 lane (no edits to `js/decompiler/**`)
  - [ ] Commit PR A changes on `feat/cpp-object-evidence`

---

## PR B — Phase 8 Consumer (`feat/cpp-object-decompiler-projection`)

- [ ] **Task B1: Branch Creation**
  - [ ] Create branch `feat/cpp-object-decompiler-projection` based on `feat/cpp-object-evidence` HEAD

- [ ] **Task B2: Decompiler Receiver & Field Presentation (`js/decompiler/semantic-core.js`)**
  - [ ] Wire C++ receiver evidence into `argName(v, ctx)`: emit `this` for verified receiver
  - [ ] Wire receiver into `MK.FIELD` handler: emit `this->field_xx`
  - [ ] Preserve offset-based field names (`field_xx`) unless authoritative metadata exists
  - [ ] Wire receiver into indirect calls matching `virtualSlotEvidence`: update receiver arg to `this`
  - [ ] Maintain indirect call semantics (do NOT emit synthetic `this->vtable->slot_8`)
  - [ ] Emit exact devirtualized target ONLY when `exactTargetKnown === true`

- [ ] **Task B3: Unit, Soundness, and Mutation Tests (`tests/phase8/cxx-object-decompiler-projection.test.mjs`)**
  - [ ] Receiver presentation (`a1` -> `this`)
  - [ ] Field presentation (`a1->field_38` -> `this->field_38`)
  - [ ] Ordinary C function negative (remains `a1`)
  - [ ] Unknown field (remains `field_38`, no fake names)
  - [ ] Virtual indirect call presentation (preserves indirect call syntax, receiver becomes `this`)
  - [ ] Exact target presentation (only when `exactTargetKnown === true`)
  - [ ] Mutation tests (mutating receiver evidence reverts output to safe fallback)

- [ ] **Task B4: Verification & Ownership Gate for PR B**
  - [ ] Run focused tests: `node --test tests/phase8/cxx-object-decompiler-projection.test.mjs`
  - [ ] Validate Phase 8 ownership: `node tools/validation/phase8-ownership.mjs --files-json '<pr_b_files>'`
  - [ ] Verify zero modified files outside Phase 8 lane (no edits to `js/analysis/**`)
  - [ ] Build and verify generated output: `npm run userscript:build` with zero diff
  - [ ] Commit PR B changes on `feat/cpp-object-decompiler-projection`

---

## Task B5: Final Adversarial Review & Reporting
- [ ] Self-review both branches against the 12 adversarial invariants
- [ ] Compile final structured report with PR URLs, evidence summary, and performance analysis
