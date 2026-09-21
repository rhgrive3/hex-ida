# Contract: C++ Object Evidence (`cpp-object-evidence`)

**Path**: `js/analysis/cxx/object-evidence.js`  
**Phase**: Phase 7 (Producer)  
**Consumer**: Phase 8 (`js/decompiler/**`)  
**Contract Version**: `1.0.0`  

---

## 1. Module Exports

```javascript
export const CPP_OBJECT_EVIDENCE_VERSION = '1.0.0';

export function createCppReceiverEvidence(input: CppReceiverEvidenceInput): CppReceiverEvidence;
export function createCppClassIdentity(input: CppClassIdentityInput): CppClassIdentity;
export function createCppVtableEvidence(input: CppVtableEvidenceInput): CppVtableEvidence;
export function createCppVirtualSlotEvidence(input: CppVirtualSlotEvidenceInput): CppVirtualSlotEvidence;

export function extractCppObjectEvidence(context: CppExtractionContext): CppObjectEvidenceReport;
export function validateCppObjectEvidence(evidence: unknown): { valid: boolean; errors: string[] };
```

---

## 2. Invariants & Fail-Closed Rules

1. **Non-Static Proof Required**:
   `createCppReceiverEvidence` throws `TypeError('cpp-receiver-non-static-proof-required')` if `nonStaticProof` is missing or falsy.
2. **No x0-only Inference**:
   Passing register `x0` without independent member authority throws or yields `valid: false`.
3. **Secondary Vtable Rejection**:
   If `offsetToTop !== 0n`, `createCppReceiverEvidence` rejects primary receiver binding (`TypeError('cpp-receiver-secondary-vtable-rejected')`).
4. **Frozen Immutability**:
   Every returned evidence record is deeply frozen using `deepFreeze`.
5. **Deterministic Digest**:
   Every evidence record carries a SHA-256 / stable digest computed over its canonical fields.
6. **Separation of Virtual Slot and Exact Target**:
   `CppVirtualSlotEvidence` must never have `exactTargetKnown === true` unless `closureProven === true`.
