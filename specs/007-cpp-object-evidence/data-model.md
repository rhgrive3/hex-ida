# Data Model & Contracts: C++ Object Evidence

**Feature**: `007-cpp-object-evidence`  
**Date**: 2026-09-21  
**Status**: Draft  

---

## 1. Public Evidence Schema

All evidence types are defined as deeply frozen objects with explicit provenance and validation.

```mermaid
classDiagram
    class CppReceiverEvidence {
        +string schema
        +string functionId
        +bigint functionAddress
        +string canonicalValueId
        +string receiverRole
        +CppClassIdentity classIdentity
        +CppNonStaticProof nonStaticProof
        +CppAbiBinding abiBinding
        +string completeness
        +string snapshotId
        +string uncertainty
        +string digest
    }

    class CppClassIdentity {
        +string kind
        +string className
        +bigint vtableAddress
        +bigint typeinfoAddress
        +boolean isAnonymous
    }

    class CppNonStaticProof {
        +string source
        +string rule
        +boolean isVirtual
        +boolean isConstructor
        +boolean isDestructor
        +boolean isConstMember
    }

    class CppAbiBinding {
        +string architecture
        +string register
        +number argumentIndex
    }

    class CppVtableEvidence {
        +string schema
        +bigint vtableAddress
        +number pointerBytes
        +bigint offsetToTop
        +bigint typeinfo
        +Array~CppVtableSlot~ slots
        +boolean isSecondary
        +string digest
    }

    class CppVirtualSlotEvidence {
        +string schema
        +string callSiteId
        +bigint callSiteAddress
        +string receiverValueId
        +string vptrValueId
        +number slotIndex
        +number slotByteOffset
        +boolean virtualSlotKnown
        +boolean exactTargetKnown
        +bigint exactTargetAddress
        +Array~string~ candidateTargetIds
        +boolean closureProven
        +string reason
        +string digest
    }

    CppReceiverEvidence --> CppClassIdentity
    CppReceiverEvidence --> CppNonStaticProof
    CppReceiverEvidence --> CppAbiBinding
    CppVirtualSlotEvidence --> CppVtableEvidence
```

---

## 2. Entity Details

### 2.1 `CppReceiverEvidence`
```typescript
interface CppReceiverEvidence {
  schema: 'cpp-receiver-evidence/v1';
  functionId: string;
  functionAddress: bigint | null;
  canonicalValueId: string | number;
  receiverRole: 'this';
  classIdentity: CppClassIdentity;
  nonStaticProof: CppNonStaticProof;
  abiBinding: CppAbiBinding;
  completeness: 'complete' | 'partial' | 'unknown';
  snapshotId: string;
  uncertainty: string | null;
  digest: string;
}
```
**Invariants**:
- `canonicalValueId` must correspond to argument 0 of the function's entry block.
- `receiverRole` is always `'this'`.
- `nonStaticProof` must carry verified evidence (e.g. constructor/destructor/cv-qualified symbol, or vtable slot membership, or authoritative non-static flag). It must NEVER be created for free functions, static member functions, or ordinary C functions.
- If `uncertainty != null` or `completeness !== 'complete'`, the decompiler consumer must NOT treat the receiver as exact.

### 2.2 `CppClassIdentity`
```typescript
interface CppClassIdentity {
  kind: 'named' | 'anonymous';
  className: string | null;
  vtableAddress: bigint | null;
  typeinfoAddress: bigint | null;
  isAnonymous: boolean;
}
```
**Invariants**:
- `kind === 'named'`: `className` is a non-empty string derived from RTTI or mangled symbol authority.
- `kind === 'anonymous'`: `className` is `null`, `isAnonymous: true`. No synthetic name like `Class_1234` or `Player` is ever fabricated.

### 2.3 `CppVtableEvidence`
```typescript
interface CppVtableEvidence {
  schema: 'cpp-vtable-evidence/v1';
  vtableAddress: bigint;
  pointerBytes: 4 | 8;
  offsetToTop: bigint;
  typeinfo: bigint | null;
  slots: Array<CppVtableSlot>;
  isSecondary: boolean;
  digest: string;
}

interface CppVtableSlot {
  index: number;
  offset: number;
  address: bigint | null;
  symbolName: string | null;
  unresolved: boolean;
  reason: string | null;
}
```
**Invariants**:
- `offsetToTop === 0n` indicates a primary vtable.
- `offsetToTop !== 0n` indicates a secondary vtable (multiple inheritance). `isSecondary: true`.
- If `unresolved === true`, the slot pointer was tagged, authenticated with PAC, or bound to a relocation that was not resolved. It cannot be treated as an address.

### 2.4 `CppVirtualSlotEvidence`
```typescript
interface CppVirtualSlotEvidence {
  schema: 'cpp-virtual-slot-evidence/v1';
  callSiteId: string | number;
  callSiteAddress: bigint | null;
  receiverValueId: string | number;
  vptrValueId: string | number;
  slotIndex: number;
  slotByteOffset: number;
  virtualSlotKnown: boolean;
  exactTargetKnown: boolean;
  exactTargetAddress: bigint | null;
  candidateTargetIds: Array<string>;
  closureProven: boolean;
  reason: string | null;
  digest: string;
}
```
**Invariants**:
- `virtualSlotKnown === true` whenever the canonical pattern (`receiver -> vptr load -> constant slot -> call`) is established.
- `exactTargetKnown` is `true` ONLY when `closureProven === true` (target candidate set is proven closed / exhaustive) and exactly one candidate target exists.
- In all other cases, `exactTargetKnown === false`, `exactTargetAddress === null`.

---

## 3. Evidence State Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Unanalyzed
    Unanalyzed --> NonMember : Free function / C symbol / static member
    NonMember --> FailClosed : No receiver evidence emitted
    
    Unanalyzed --> CandidateMember : Symbol or vtable entry found
    CandidateMember --> SecondaryVtable : offsetToTop != 0 or adjusting thunk
    SecondaryVtable --> FailClosed : Downgraded / Rejected
    
    CandidateMember --> VerifiedReceiver : Primary vtable, non-static proof, ABI match
    VerifiedReceiver --> CompleteEvidence : All inputs validated, clean snapshot
    CompleteEvidence --> DecompilerProjection : Consumed by Phase 8 (PR B)
    
    VerifiedReceiver --> PartialEvidence : Stale snapshot, missing relocation
    PartialEvidence --> FailClosed : Consumer skips 'this' promotion
```
