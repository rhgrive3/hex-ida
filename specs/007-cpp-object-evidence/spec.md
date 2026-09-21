# Feature Specification: C++ Object Readability & Public Evidence

**Feature**: `007-cpp-object-evidence`  
**Base**: `rhgrive3/hex-ida` latest `main`  
**Author**: Antigravity  
**Created**: 2026-09-21  
**Status**: Draft (Spec Kit)  

---

## 1. Overview & Objectives

In reverse engineering and game binary analysis, decompilation of C++ binaries currently displays member function receivers and object accesses with generic names (e.g., `a1->field_38`, `(*(code **)(*(long *)a1 + 0x40))(a1);`).

The objective is to connect existing subsystems (RTTI parsing in `js/rtti.js`, layout inference in `js/decompiler/types/layout.js`, call candidates in `js/analysis/summary/scoped-call-candidates.js`, and semantic presentation in `js/decompiler/semantic-core.js`) via safe, immutable, public canonical evidence.

### Two-Stage Stacked Delivery
- **PR A — Phase 7 Producer (`feat/cpp-object-evidence` from `main`)**:
  - Scope: `specs/**`, `js/analysis/**`, `tests/phase7/**`.
  - Delivers: `CppReceiverEvidence`, `CppObjectIdentityEvidence`, `CppVtableEvidence`, `CppVirtualSlotEvidence`.
  - Strict Rule: MUST NOT modify `js/decompiler/**`.
- **PR B — Phase 8 Consumer (`feat/cpp-object-decompiler-projection` from PR A)**:
  - Scope: `js/decompiler/**`, `tests/phase8/**`.
  - Delivers: Receiver presentation (`this`), receiver-aware field presentation (`this->field_xx`), virtual-slot call parameter presentation (`(*(code **)(...))(this);`).
  - Strict Rule: MUST NOT modify `js/analysis/**`.

---

## 2. User Scenarios & Acceptance Criteria

### User Story 1 — Proven C++ Member Function Receiver (Priority: P1)
As a reverse engineer analyzing game logic, I want verified C++ non-static member functions to display the receiver argument as `this` instead of `a1`, so that object-oriented code is immediately recognizable.

**Acceptance Criteria**:
1. **Given** a function identified as a C++ non-static member function with positive evidence (e.g. constructor `Player::Player()`, destructor `Player::~Player()`, const member `Player::get() const`, or vtable slot entry),  
   **When** decompiled,  
   **Then** the first argument is presented as `this` instead of `a1`.
2. **Given** an ordinary C function with an `x0` argument,  
   **When** decompiled,  
   **Then** the argument remains `a1` (no change).
3. **Given** a C++ static member function (e.g., `Player::Reset()` marked static in metadata),  
   **When** decompiled,  
   **Then** the first argument remains `a1` (never `this`).

---

### User Story 2 — Receiver-Aware Field Presentation (Priority: P1)
As a reverse engineer, I want accesses to object member fields from the proven receiver to render as `this->field_xx`, while strictly preserving offset-based names unless an authoritative field name is known.

**Acceptance Criteria**:
1. **Given** an access to offset `0x38` on a verified `this` pointer without symbolic field name metadata,  
   **When** decompiled,  
   **Then** it renders as `this->field_38` (replacing `a1->field_38`).
2. **Given** no authoritative debug or host metadata for the field,  
   **When** rendered,  
   **Then** the field name is NOT guessed (no fictitious names like `health` or `ammo`).
3. **Given** an access to an unverified pointer or ordinary C struct pointer,  
   **When** rendered,  
   **Then** it remains `a1->field_38`.

---

### User Story 3 — Virtual-Slot Call Preservation & Receiver Improvement (Priority: P1)
As an analyst reading virtual dispatch calls, I want virtual call sites to retain accurate indirect call semantics while improving the receiver parameter passed into the call to `this`.

**Acceptance Criteria**:
1. **Given** an indirect call through a virtual table slot (`receiver -> vptr -> slot -> indirect call`),  
   **When** decompiled without an authoritative target-set closure proof,  
   **Then** indirect call syntax is preserved, but the receiver argument is displayed as `this`.
2. **Given** that candidate sets in existing pipeline are non-closed (`targetClosure: 'unknown'`),  
   **When** evaluating exact target devirtualization,  
   **Then** the call is NOT devirtualized to an exact target function unless closure is explicitly proven.

---

### User Story 4 — Multi-Inheritance & Secondary Vtable Soundness (Priority: P1)
As a security researcher analyzing complex C++ class hierarchies with multiple inheritance, I want secondary base class subobjects with non-zero offset-to-top to fail closed, preventing incorrect attribution to the primary class.

**Acceptance Criteria**:
1. **Given** a vtable with `offsetToTop !== 0n` (secondary vtable in multiple inheritance),  
   **When** evaluated for primary object identity,  
   **Then** it fails closed (claim is downgraded or rejected; never conflated with primary `this`).
2. **Given** a this-adjusting thunk (`_ZThn...`),  
   **When** evaluated without pointer adjustment handling,  
   **Then** exact receiver claim is rejected.

---

### User Story 5 — Stripped Binary Stability (Priority: P2)
As an analyst examining stripped release binaries, I want vtable and object family identity to remain stable even when class symbols are stripped, without generating fictitious class names.

**Acceptance Criteria**:
1. **Given** a binary without RTTI symbol names (`_ZTV`),  
   **When** object evidence is extracted from existing vtable/points-to facts,  
   **Then** anonymous class identity is retained (e.g. keyed by vtable address) without inventing fabricated class names.

---

## 3. Functional Requirements

- **FR-001**: PR A MUST define immutable, frozen public evidence structures in `js/analysis/cxx/object-evidence.js`:
  - `CppReceiverEvidence`
  - `CppObjectIdentityEvidence`
  - `CppVtableEvidence`
  - `CppVirtualSlotEvidence`
- **FR-002**: `CppReceiverEvidence` MUST contain:
  - `functionId` (string)
  - `functionAddress` (bigint | null)
  - `canonicalValueId` (string | number)
  - `receiverRole` ('this')
  - `classIdentity` (object: `kind`, `className`, `vtableAddress`, `isAnonymous`)
  - `nonStaticProof` (object: `source`, `rule`)
  - `abiBinding` (object: `architecture`, `register`, `argumentIndex`)
  - `completeness` ('complete' | 'partial' | 'unknown')
  - `snapshotId` (string)
  - `uncertainty` (string | null)
- **FR-003**: Evidence extraction MUST distinguish non-static member functions from static member functions, free functions, constructors, destructors, thunks, and ordinary C functions. `x0` alone MUST NEVER be treated as `this`.
- **FR-004**: If `offsetToTop !== 0n` or adjusting thunks are present, the evidence extraction MUST fail closed to prevent incorrect primary receiver claims.
- **FR-005**: If relocation/fixup resolution fails on a vtable slot, the slot MUST be marked `unresolved: true` and excluded from target claims.
- **FR-006**: Virtual slot evidence MUST maintain separation between `virtualSlotKnown` and `exactTargetKnown`. Candidate count = 1 MUST NOT be treated as exact target proof without an explicit closure authority.
- **FR-007**: PR A MUST NOT modify `js/decompiler/**`.
- **FR-008**: PR B MUST consume PR A's public evidence strictly through caller options / context without invoking private Phase 7 solvers.
- **FR-009**: PR B MUST project exact receiver evidence to format argument 0 as `this` in pseudocode and C-AST.
- **FR-010**: PR B MUST project receiver-bound field accesses `base->field_xx` as `this->field_xx`.
- **FR-011**: PR B MUST NOT invent fabricated field names from offset alone (e.g. `field_38` remains `field_38` unless authoritative field name metadata exists).
- **FR-012**: PR B MUST NOT synthesize artificial syntax like `this->vtable->slot_8()` as real fields.
- **FR-013**: PR B MUST NOT modify `js/analysis/**`.
- **FR-014**: Both PR A and PR B MUST satisfy repository ownership guardrails (`phase7-ownership.mjs` and `phase8-ownership.mjs`).
- **FR-015**: Generated outputs (`userscript/hex.user.template.js`, `userscript/release-version.json`) MUST remain synchronized with zero diff on rebuild.

---

## 4. Success Criteria

- **SC-001 (PR A Evidence Soundness)**: All unit tests and adversarial mutation tests in `tests/phase7/cxx-object-evidence.test.mjs` pass.
- **SC-002 (PR A Ownership)**: `tools/validation/phase7-ownership.mjs` reports 0 violations.
- **SC-003 (PR B Projection)**: Receiver presentation changes `a1` -> `this` and `a1->field_xx` -> `this->field_xx` on proven receivers.
- **SC-004 (PR B Non-Regression)**: Ordinary C functions, static member functions, and Objective-C/Swift functions exhibit zero regressions.
- **SC-005 (PR B Ownership)**: `tools/validation/phase8-ownership.mjs` reports 0 violations.
- **SC-006 (Performance)**: Decompilation retains $O(1)$ / bounded lookup latency for C++ object evidence. No whole-binary rescanning during function decompilation.
