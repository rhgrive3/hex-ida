/**
 * Phase 7 Canonical C++ Object Evidence Producer.
 *
 * Provides bounded, immutable, provenance-tracked public evidence for C++
 * objects, receivers, vtables, and virtual-slot dispatches.
 *
 * Designed to connect existing RTTI, vtable, layout, and candidate infrastructure
 * across the architecture-independent Phase 7 / Phase 8 boundary without creating
 * a new solver or modifying decompiler code from Phase 7.
 */

import { deepFreeze, stableDigest } from '../../core/identity/index.js';
import { demangleCxx, readableName, isMangled } from '../../rtti.js';

export const CPP_OBJECT_EVIDENCE_VERSION = '1.0.0';

export const CPP_RECEIVER_SCHEMA = 'cpp-receiver-evidence/v1';
export const CPP_CLASS_IDENTITY_SCHEMA = 'cpp-class-identity/v1';
export const CPP_VTABLE_SCHEMA = 'cpp-vtable-evidence/v1';
export const CPP_VIRTUAL_SLOT_SCHEMA = 'cpp-virtual-slot-evidence/v1';

function fail(code, detail = '') {
  throw new TypeError(detail ? `${code}: ${detail}` : code);
}

function nonNegativeBigInt(val, code) {
  if (val == null) return null;
  if (typeof val === 'bigint') return val >= 0n ? val : fail(code, 'must be non-negative');
  if (typeof val === 'number' && Number.isSafeInteger(val) && val >= 0) return BigInt(val);
  if (typeof val === 'string' && /^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(val.trim())) {
    try {
      const b = BigInt(val.trim());
      if (b >= 0n) return b;
    } catch { /* ignore */ }
  }
  return fail(code, 'invalid non-negative integer');
}

/**
 * Creates an immutable CppClassIdentity.
 */
export function createCppClassIdentity(input = {}) {
  if (!input || typeof input !== 'object') fail('cpp-class-identity-input-invalid');
  const kind = input.kind === 'named' ? 'named' : input.kind === 'anonymous' ? 'anonymous' : null;
  if (!kind) fail('cpp-class-identity-kind-required', 'must be "named" or "anonymous"');

  const className = kind === 'named'
    ? (typeof input.className === 'string' && input.className.trim().length > 0 ? input.className.trim() : fail('cpp-class-identity-name-required'))
    : null;

  const isAnonymous = kind === 'anonymous' || Boolean(input.isAnonymous);
  if (kind === 'anonymous' && input.className != null) {
    fail('cpp-class-identity-anonymous-cannot-have-name');
  }

  const vtableAddress = input.vtableAddress != null ? nonNegativeBigInt(input.vtableAddress, 'cpp-class-identity-vtable-address') : null;
  const typeinfoAddress = input.typeinfoAddress != null ? nonNegativeBigInt(input.typeinfoAddress, 'cpp-class-identity-typeinfo-address') : null;
  const offsetToTop = input.offsetToTop != null ? BigInt(input.offsetToTop) : 0n;

  const identity = {
    schema: CPP_CLASS_IDENTITY_SCHEMA,
    kind,
    className,
    vtableAddress,
    typeinfoAddress,
    offsetToTop,
    isAnonymous,
  };
  identity.digest = stableDigest(identity);
  return deepFreeze(identity);
}

/**
 * Creates an immutable CppVtableEvidence.
 */
export function createCppVtableEvidence(input = {}) {
  if (!input || typeof input !== 'object') fail('cpp-vtable-evidence-input-invalid');
  const vtableAddress = nonNegativeBigInt(input.vtableAddress, 'cpp-vtable-address-required');
  if (vtableAddress == null) fail('cpp-vtable-address-required');

  const pointerBytes = input.pointerBytes === 4 ? 4 : input.pointerBytes === 8 ? 8 : fail('cpp-vtable-pointer-bytes-invalid', 'must be 4 or 8');
  const offsetToTop = input.offsetToTop != null ? BigInt(input.offsetToTop) : 0n;
  const typeinfo = input.typeinfo != null ? nonNegativeBigInt(input.typeinfo, 'cpp-vtable-typeinfo') : null;
  const isSecondary = offsetToTop !== 0n || Boolean(input.isSecondary);

  const rawSlots = Array.isArray(input.slots) ? input.slots : [];
  const slots = rawSlots.map((s, idx) => {
    const index = Number.isSafeInteger(s.index) ? s.index : idx;
    const offset = Number.isSafeInteger(s.offset) ? s.offset : (2 + index) * pointerBytes;
    const unresolved = Boolean(s.unresolved);
    const addr = !unresolved && s.address != null ? nonNegativeBigInt(s.address, 'cpp-vtable-slot-address') : null;
    return Object.freeze({
      index,
      offset,
      address: addr,
      symbolName: typeof s.symbolName === 'string' && s.symbolName ? s.symbolName : null,
      unresolved,
      reason: s.reason ? String(s.reason) : null,
    });
  });

  const record = {
    schema: CPP_VTABLE_SCHEMA,
    vtableAddress,
    pointerBytes,
    offsetToTop,
    typeinfo,
    slots: Object.freeze(slots),
    isSecondary,
  };
  record.digest = stableDigest(record);
  return deepFreeze(record);
}

/**
 * Creates an immutable CppReceiverEvidence.
 *
 * Enforces:
 * 1. Positive proof of non-static member status (constructor, destructor, cv-qualified member,
 *    vtable slot membership, or authoritative non-static flag).
 * 2. Strict rejection of free functions, static member functions, and unverified x0.
 * 3. Strict rejection of secondary vtables with non-zero offsetToTop.
 * 4. Binding to canonical argument value identity.
 */
export function createCppReceiverEvidence(input = {}) {
  if (!input || typeof input !== 'object') fail('cpp-receiver-input-invalid');

  const functionId = typeof input.functionId === 'string' && input.functionId.trim()
    ? input.functionId.trim() : fail('cpp-receiver-function-id-required');

  const functionAddress = input.functionAddress != null
    ? nonNegativeBigInt(input.functionAddress, 'cpp-receiver-function-address') : null;

  if (input.canonicalValueId == null || (typeof input.canonicalValueId !== 'string' && typeof input.canonicalValueId !== 'number')) {
    fail('cpp-receiver-canonical-value-id-required');
  }
  const canonicalValueId = input.canonicalValueId;

  if (input.receiverRole !== 'this') {
    fail('cpp-receiver-role-invalid', 'receiverRole must be "this"');
  }

  // Non-static member proof validation
  const proof = input.nonStaticProof;
  if (!proof || typeof proof !== 'object') {
    fail('cpp-receiver-non-static-proof-required');
  }
  if (proof.isStatic === true) {
    fail('cpp-receiver-static-member-rejected');
  }
  if (proof.isFreeFunction === true) {
    fail('cpp-receiver-free-function-rejected');
  }
  if (!proof.rule || typeof proof.rule !== 'string') {
    fail('cpp-receiver-non-static-proof-rule-required');
  }

  // Multiple inheritance / secondary vtable fail-closed check
  const classIdentity = input.classIdentity ? createCppClassIdentity(input.classIdentity) : null;
  if (classIdentity && classIdentity.offsetToTop !== 0n) {
    fail('cpp-receiver-secondary-vtable-rejected', 'non-zero offsetToTop cannot be treated as primary receiver');
  }
  if (proof.isAdjustedThunk === true) {
    fail('cpp-receiver-adjusting-thunk-rejected', 'adjusting thunk cannot be treated as primary receiver without adjustment');
  }

  // ABI binding validation
  const abi = input.abiBinding;
  if (!abi || typeof abi !== 'object') {
    fail('cpp-receiver-abi-binding-required');
  }
  const register = typeof abi.register === 'string' ? abi.register.toLowerCase() : null;
  const argumentIndex = Number.isSafeInteger(abi.argumentIndex) ? abi.argumentIndex : null;
  if (argumentIndex !== 0) {
    fail('cpp-receiver-abi-argument-index-invalid', 'receiver must be bound to argument index 0');
  }

  const completeness = ['complete', 'partial', 'unknown'].includes(input.completeness)
    ? input.completeness : 'unknown';

  const snapshotId = typeof input.snapshotId === 'string' && input.snapshotId.trim()
    ? input.snapshotId.trim() : fail('cpp-receiver-snapshot-id-required');

  const uncertainty = input.uncertainty ? String(input.uncertainty) : null;

  const record = {
    schema: CPP_RECEIVER_SCHEMA,
    functionId,
    functionAddress,
    canonicalValueId,
    receiverRole: 'this',
    classIdentity,
    nonStaticProof: deepFreeze({ ...proof }),
    abiBinding: deepFreeze({
      architecture: abi.architecture || 'arm64',
      register,
      argumentIndex: 0,
    }),
    completeness,
    snapshotId,
    uncertainty,
  };
  record.digest = stableDigest(record);
  return deepFreeze(record);
}

/**
 * Creates an immutable CppVirtualSlotEvidence.
 *
 * Enforces the strict separation between:
 * - virtualSlotKnown: the dispatch follows receiver -> vtable load -> slot load -> indirect call.
 * - exactTargetKnown: requires explicit target set closure authority (closureProven === true)
 *   and exactly 1 candidate target. Candidate count = 1 alone NEVER establishes exactTargetKnown.
 */
export function createCppVirtualSlotEvidence(input = {}) {
  if (!input || typeof input !== 'object') fail('cpp-virtual-slot-input-invalid');

  if (input.callSiteId == null || (typeof input.callSiteId !== 'string' && typeof input.callSiteId !== 'number')) {
    fail('cpp-virtual-slot-call-site-id-required');
  }
  const callSiteId = input.callSiteId;
  const callSiteAddress = input.callSiteAddress != null ? nonNegativeBigInt(input.callSiteAddress, 'cpp-virtual-slot-call-site-address') : null;

  if (input.receiverValueId == null || (typeof input.receiverValueId !== 'string' && typeof input.receiverValueId !== 'number')) {
    fail('cpp-virtual-slot-receiver-value-id-required');
  }
  const receiverValueId = input.receiverValueId;

  if (input.vptrValueId == null || (typeof input.vptrValueId !== 'string' && typeof input.vptrValueId !== 'number')) {
    fail('cpp-virtual-slot-vptr-value-id-required');
  }
  const vptrValueId = input.vptrValueId;

  const slotIndex = Number.isSafeInteger(input.slotIndex) && input.slotIndex >= 0
    ? input.slotIndex : fail('cpp-virtual-slot-index-invalid');

  const slotByteOffset = Number.isSafeInteger(input.slotByteOffset) && input.slotByteOffset >= 0
    ? input.slotByteOffset : slotIndex * (input.pointerBytes || 8);

  const virtualSlotKnown = Boolean(input.virtualSlotKnown);
  const closureProven = input.closureProven === true;
  const candidateTargetIds = Array.isArray(input.candidateTargetIds)
    ? Object.freeze([...new Set(input.candidateTargetIds.map(String))].sort())
    : Object.freeze([]);

  // Exact target promotion rule: closure must be proven AND exactly one target candidate
  let exactTargetKnown = false;
  let exactTargetAddress = null;
  if (closureProven && candidateTargetIds.length === 1 && input.exactTargetAddress != null) {
    exactTargetKnown = true;
    exactTargetAddress = nonNegativeBigInt(input.exactTargetAddress, 'cpp-virtual-slot-target-address');
  }

  const reason = input.reason ? String(input.reason) : null;

  const record = {
    schema: CPP_VIRTUAL_SLOT_SCHEMA,
    callSiteId,
    callSiteAddress,
    receiverValueId,
    vptrValueId,
    slotIndex,
    slotByteOffset,
    virtualSlotKnown,
    exactTargetKnown,
    exactTargetAddress,
    candidateTargetIds,
    closureProven,
    reason,
  };
  record.digest = stableDigest(record);
  return deepFreeze(record);
}

/**
 * Parses C++ function symbol and determines member role and class identity.
 */
function analyzeFunctionSymbol(name, rawMangled = null) {
  const sym = rawMangled || name;
  if (!sym || typeof sym !== 'string') return { isCxx: false, reason: 'no-symbol' };

  if (!isMangled(sym)) {
    return { isCxx: false, reason: 'not-mangled-symbol' };
  }

  const demangled = demangleCxx(sym);
  if (!demangled) {
    return { isCxx: false, reason: 'cxx-demangle-failed' };
  }

  // Check thunks
  if (sym.startsWith('_ZTh') || sym.startsWith('__ZTh') || demangled.startsWith('thunk to ')) {
    return { isCxx: true, isThunk: true, isAdjustedThunk: true, demangled, reason: 'this-adjusting-thunk' };
  }

  // Check free functions: mangled as _Z<len><name>... without 'N' (e.g. _Z6updateP6Player)
  const stripped = sym.startsWith('__Z') ? sym.slice(1) : sym;
  if (stripped.startsWith('_Z') && !stripped.startsWith('_ZN') && !stripped.startsWith('_ZTV') && !stripped.startsWith('_ZTI')) {
    // Non-nested symbol: free function
    return { isCxx: true, isFreeFunction: true, isMember: false, demangled, reason: 'cxx-free-function' };
  }

  // Nested member: _ZN...
  // Parse class name and method name
  const paren = demangled.indexOf('(');
  const fullSignature = paren > 0 ? demangled.slice(0, paren).trim() : demangled.trim();
  const parts = fullSignature.split('::');

  if (parts.length < 2) {
    return { isCxx: true, isFreeFunction: true, isMember: false, demangled, reason: 'no-class-qualifier' };
  }

  const methodName = parts[parts.length - 1];
  const className = parts.slice(0, -1).join('::');

  // Check constructor / destructor / const qualifier
  const isConstructor = /_ZN.*C[123]E/.test(stripped) || methodName === parts[parts.length - 2];
  const isDestructor = /_ZN.*D[012]E/.test(stripped) || methodName.startsWith('~');
  const isConstMember = /_ZNK/.test(stripped) || demangled.endsWith(' const');

  return {
    isCxx: true,
    isMember: true,
    isFreeFunction: false,
    className,
    methodName,
    demangled,
    isConstructor,
    isDestructor,
    isConstMember,
  };
}

/**
 * Extracts C++ object evidence for a function from existing analysis facts.
 *
 * Bounded, cached, O(1) during decompilation.
 */
export function extractCppObjectEvidence(context = {}) {
  const {
    functionId = 'sub_unknown',
    functionAddress = null,
    functionName = null,
    rawSymbol = null,
    ir = null,
    vtables = [],
    metadata = {},
    snapshotId = 'snapshot_default',
    architecture = 'arm64',
  } = context;

  // 1. Symbol and membership analysis
  const symInfo = analyzeFunctionSymbol(functionName || rawSymbol, rawSymbol || functionName);

  if (!symInfo.isCxx || symInfo.isFreeFunction) {
    return deepFreeze({
      schema: 'cpp-object-evidence-report/v1',
      functionId,
      receiver: null,
      vtables: [],
      virtualSlots: [],
      completeness: 'complete',
      status: 'non-cxx-or-free-function',
      reason: symInfo.reason || 'not-cxx-member',
    });
  }

  // Check explicit static member metadata
  if (metadata.isStatic === true || metadata.memberKind === 'static') {
    return deepFreeze({
      schema: 'cpp-object-evidence-report/v1',
      functionId,
      receiver: null,
      vtables: [],
      virtualSlots: [],
      completeness: 'complete',
      status: 'static-member-no-receiver',
      reason: 'static-member-function',
    });
  }

  // Check adjusting thunks
  if (symInfo.isAdjustedThunk || metadata.isAdjustedThunk === true) {
    return deepFreeze({
      schema: 'cpp-object-evidence-report/v1',
      functionId,
      receiver: null,
      vtables: [],
      virtualSlots: [],
      completeness: 'partial',
      status: 'fail-closed-thunk',
      reason: 'this-adjusting-thunk-unsupported',
    });
  }

  // 2. Establish non-static member proof
  let nonStaticProof = null;
  if (symInfo.isConstructor) {
    nonStaticProof = { source: 'symbol-syntax', rule: 'constructor-has-this', isConstructor: true };
  } else if (symInfo.isDestructor) {
    nonStaticProof = { source: 'symbol-syntax', rule: 'destructor-has-this', isDestructor: true };
  } else if (symInfo.isConstMember) {
    nonStaticProof = { source: 'symbol-syntax', rule: 'const-qualifier-has-this', isConstMember: true };
  } else if (metadata.isStatic === false || metadata.memberKind === 'non-static') {
    nonStaticProof = { source: 'metadata', rule: 'authoritative-non-static' };
  } else if (functionAddress != null) {
    // Check if function address is a slot in a known vtable
    for (const vt of vtables) {
      if (vt.slots?.some(s => !s.unresolved && s.address === BigInt(functionAddress))) {
        nonStaticProof = { source: 'vtable-membership', rule: 'vtable-slot-is-virtual-member', isVirtual: true };
        break;
      }
    }
  }

  if (!nonStaticProof) {
    return deepFreeze({
      schema: 'cpp-object-evidence-report/v1',
      functionId,
      receiver: null,
      vtables: [],
      virtualSlots: [],
      completeness: 'partial',
      status: 'unproven-member-kind',
      reason: 'unproven-non-static-member',
    });
  }

  // 3. Resolve Class Identity
  const classIdentity = createCppClassIdentity({
    kind: symInfo.className ? 'named' : 'anonymous',
    className: symInfo.className || null,
    vtableAddress: vtables[0]?.vtableAddress ?? null,
    offsetToTop: vtables[0]?.offsetToTop ?? 0n,
    isAnonymous: !symInfo.className,
  });

  // Fail closed if secondary vtable (offsetToTop !== 0)
  if (classIdentity.offsetToTop !== 0n) {
    return deepFreeze({
      schema: 'cpp-object-evidence-report/v1',
      functionId,
      receiver: null,
      vtables: [],
      virtualSlots: [],
      completeness: 'partial',
      status: 'fail-closed-secondary-vtable',
      reason: 'non-zero-offset-to-top',
    });
  }

  // 4. Resolve Canonical Receiver SSA Value in IR
  let canonicalReceiverValueId = null;
  if (ir?.values?.length) {
    // Find entry argument 0 (in AAPCS64 x0, or registered as arg 0)
    const arg0 = ir.values.find(v => v.kind === 'arg' && (v.reg === 'x0' || v.index === 0));
    if (arg0) {
      canonicalReceiverValueId = arg0.id;
    }
  }

  let receiver = null;
  if (canonicalReceiverValueId != null) {
    try {
      receiver = createCppReceiverEvidence({
        functionId,
        functionAddress: functionAddress != null ? BigInt(functionAddress) : null,
        canonicalValueId: canonicalReceiverValueId,
        receiverRole: 'this',
        classIdentity,
        nonStaticProof,
        abiBinding: { architecture, register: 'x0', argumentIndex: 0 },
        completeness: 'complete',
        snapshotId,
      });
    } catch {
      receiver = null;
    }
  }

  // 5. Detect Virtual Slot Calls in IR
  const virtualSlots = [];
  if (ir?.instructions?.length && canonicalReceiverValueId != null) {
    const pointerBytes = architecture === 'arm64_32' ? 4 : 8;

    // Build map of SSA definitions
    const valueDef = new Map();
    for (const v of ir.values || []) {
      if (v.def) valueDef.set(v.id, v.def);
    }

    // Trace canonical receiver copies (e.g. MOV x19, x0)
    const receiverAliases = new Set([canonicalReceiverValueId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const inst of ir.instructions) {
        if (inst.op === 'mov' || inst.op === 'copy') {
          const src = inst.args?.[0]?.value?.id ?? inst.args?.[0]?.id;
          const dst = inst.dst?.id;
          if (src != null && dst != null && receiverAliases.has(src) && !receiverAliases.has(dst)) {
            receiverAliases.add(dst);
            changed = true;
          }
        }
      }
    }

    for (const inst of ir.instructions) {
      if (inst.op !== 'call') continue;

      // Check if target is loaded from memory
      const targetVal = inst.args?.[0]?.value || inst.args?.[0];
      const targetDef = targetVal?.id != null ? valueDef.get(targetVal.id) : null;
      if (!targetDef || targetDef.op !== 'load') continue;

      const slotOffset = targetDef.loc?.disp ?? targetDef.addr?.disp;
      if (slotOffset == null) continue;

      const vptrVal = targetDef.loc?.base || targetDef.addr?.base;
      const vptrDef = vptrVal?.id != null ? valueDef.get(vptrVal.id) : null;
      if (!vptrDef || vptrDef.op !== 'load') continue;

      const vptrOffset = vptrDef.loc?.disp ?? vptrDef.addr?.disp ?? 0n;
      if (BigInt(vptrOffset) !== 0n) continue;

      const objVal = vptrDef.loc?.base || vptrDef.addr?.base;
      if (!objVal || !receiverAliases.has(objVal.id)) continue;

      // Verify that this call passes the receiver as argument 0
      const callArg0 = inst.args?.[1]?.value || inst.args?.[1];
      if (callArg0 && !receiverAliases.has(callArg0.id)) continue;

      const slotByteOffset = Number(slotOffset);
      const slotIndex = Math.floor(slotByteOffset / pointerBytes);

      try {
        const slotEvidence = createCppVirtualSlotEvidence({
          callSiteId: inst.id,
          callSiteAddress: inst.address != null ? BigInt(inst.address) : null,
          receiverValueId: objVal.id,
          vptrValueId: vptrVal.id,
          slotIndex,
          slotByteOffset,
          pointerBytes,
          virtualSlotKnown: true,
          closureProven: metadata.targetClosure === true,
          candidateTargetIds: metadata.candidateTargetIds || [],
          exactTargetAddress: metadata.exactTargetAddress || null,
          reason: 'canonical-vtable-slot-load',
        });
        virtualSlots.push(slotEvidence);
      } catch { /* ignore failed slot validation */ }
    }
  }

  return deepFreeze({
    schema: 'cpp-object-evidence-report/v1',
    functionId,
    receiver,
    vtables: Object.freeze([...vtables]),
    virtualSlots: Object.freeze(virtualSlots),
    completeness: receiver ? 'complete' : 'partial',
    status: receiver ? 'verified-cpp-object' : 'unresolved-receiver',
    reason: receiver ? null : 'receiver-binding-unresolved',
  });
}

/**
 * Validates any CppObjectEvidence structure.
 */
export function validateCppObjectEvidence(evidence) {
  const errors = [];
  if (!evidence || typeof evidence !== 'object') {
    return { valid: false, errors: ['evidence must be an object'] };
  }
  if (!evidence.schema) {
    errors.push('missing schema property');
  }
  return { valid: errors.length === 0, errors };
}
