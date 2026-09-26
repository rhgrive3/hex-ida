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
export const CPP_CANONICAL_MEMBER_SCHEMA = 'cpp-canonical-member-evidence/v1';

const canonicalCppReceiverEvidence = new WeakSet();
const canonicalCppVirtualSlotEvidence = new WeakSet();
const canonicalCppMemberEvidence = new WeakSet();

export function isCanonicalCppReceiverEvidence(value) {
  return value !== null && typeof value === 'object' && canonicalCppReceiverEvidence.has(value);
}

export function isCanonicalCppVirtualSlotEvidence(value) {
  return value !== null && typeof value === 'object' && canonicalCppVirtualSlotEvidence.has(value);
}

/**
 * True only for member evidence issued by `createCppMemberEvidence` in this
 * process. A serialized or hand-built record shaped like member evidence — the
 * obvious way to forge `this->health` as `float` — never passes, exactly like
 * the receiver and virtual-slot guards.
 */
export function isCanonicalCppMemberEvidence(value) {
  return value !== null && typeof value === 'object' && canonicalCppMemberEvidence.has(value);
}

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
    const index = s.index == null
      ? idx
      : (Number.isSafeInteger(s.index) && s.index >= 0 ? s.index : fail('cpp-vtable-slot-index-invalid'));
    const offset = s.offset == null
      ? (2 + index) * pointerBytes
      : (Number.isSafeInteger(s.offset) && s.offset >= 0 ? s.offset : fail('cpp-vtable-slot-offset-invalid'));
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
  const canonical = deepFreeze(record);
  canonicalCppReceiverEvidence.add(canonical);
  return canonical;
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

  // Exact target promotion requires the dispatch itself to be proven virtual,
  // target-set closure authority, and exactly one candidate.
  let exactTargetKnown = false;
  let exactTargetAddress = null;
  if (virtualSlotKnown && closureProven && candidateTargetIds.length === 1 && input.exactTargetAddress != null) {
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
  const canonical = deepFreeze(record);
  canonicalCppVirtualSlotEvidence.add(canonical);
  return canonical;
}

/**
 * Creates an immutable canonical member (field) evidence record.
 *
 * A member record states three separate things, and keeping them separate is
 * the point:
 *
 * - `accessProven`: the function really reads or writes `this + offsetBytes`, so
 *   the *offset* is binary-grounded;
 * - `typeProven`: the access shape proves a *type category*. It is false for a
 *   width-only or contradictory access, and a consumer that renders a type must
 *   require it rather than defaulting to one;
 * - the record never carries a field *name*. A proven offset and a proven type
 *   do not make `this->health` correct, so no name is minted here.
 *
 * `receiverDigest` and `functionId` bind the member to the exact receiver
 * evidence it was derived from, so a member set cannot be replayed against
 * another function or another receiver.
 */
export function createCppMemberEvidence(input = {}) {
  if (!input || typeof input !== 'object') fail('cpp-member-input-invalid');

  const functionId = typeof input.functionId === 'string' && input.functionId.trim()
    ? input.functionId.trim() : fail('cpp-member-function-id-required');

  const receiverDigest = typeof input.receiverDigest === 'string' && input.receiverDigest.trim()
    ? input.receiverDigest.trim() : fail('cpp-member-receiver-digest-required');

  const snapshotId = typeof input.snapshotId === 'string' && input.snapshotId.trim()
    ? input.snapshotId.trim() : fail('cpp-member-snapshot-id-required');

  // A member without a location cannot be binary-grounded, and `nonNegativeBigInt`
  // returns null rather than throwing for a missing value, so an absent offset
  // must be rejected here — exactly as `createCppVtableEvidence` does for its own
  // address. Otherwise the record would carry
  // `accessProven: true, offsetBytes: null`, which claims a proven access to a
  // place the record does not name.
  if (input.offsetBytes == null) fail('cpp-member-offset-invalid', 'offset is required');
  const offsetBytes = nonNegativeBigInt(input.offsetBytes, 'cpp-member-offset-invalid');
  if (offsetBytes == null) fail('cpp-member-offset-invalid', 'offset is required');

  const sizeBytes = Number.isSafeInteger(input.sizeBytes) && input.sizeBytes >= 0 && input.sizeBytes <= 64
    ? input.sizeBytes : fail('cpp-member-size-invalid');

  const category = typeof input.category === 'string' && input.category.trim()
    ? input.category.trim() : null;
  const typeLabel = typeof input.typeLabel === 'string' && input.typeLabel.trim()
    ? input.typeLabel.trim() : null;

  // A label without a category would be a name-shaped claim with no rule behind
  // it, so the two are required together or not at all.
  if ((category == null) !== (typeLabel == null)) {
    fail('cpp-member-type-and-category-must-agree');
  }
  const typeProven = category != null;

  // Every record cites either the rule that proved its type or the reason no
  // type could be proven. "Unclassified" is a result, not an omission.
  const rule = typeof input.rule === 'string' && input.rule ? input.rule : null;
  const reason = input.reason ? String(input.reason) : null;
  if (typeProven && !rule) fail('cpp-member-rule-required');
  if (!typeProven && !reason) fail('cpp-member-unproven-reason-required');

  const readCount = Number.isSafeInteger(input.readCount) && input.readCount >= 0 ? input.readCount : 0;
  const writeCount = Number.isSafeInteger(input.writeCount) && input.writeCount >= 0 ? input.writeCount : 0;
  if (readCount + writeCount === 0) fail('cpp-member-access-count-required');

  const record = {
    schema: CPP_CANONICAL_MEMBER_SCHEMA,
    functionId,
    receiverDigest,
    snapshotId,
    offsetBytes,
    sizeBytes,
    accessProven: true,
    typeProven,
    category,
    typeLabel,
    signedness: input.signedness ? String(input.signedness) : null,
    categoryCandidates: Array.isArray(input.categoryCandidates)
      ? Object.freeze([...new Set(input.categoryCandidates.map(String))].sort())
      : Object.freeze([]),
    mixedWidths: input.mixedWidths === true,
    widthOnly: input.widthOnly === true,
    indexed: input.indexed === true,
    readCount,
    writeCount,
    rule,
    reason,
  };
  record.digest = stableDigest(record);
  const canonical = deepFreeze(record);
  canonicalCppMemberEvidence.add(canonical);
  return canonical;
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
    vtableClassNames = [],
    metadata = {},
    snapshotId = 'snapshot_default',
    architecture = 'arm64',
  } = context;

  // 1. Symbol and membership analysis
  const symInfo = analyzeFunctionSymbol(functionName || rawSymbol, rawSymbol || functionName);

  const hasVtableMembership = functionAddress != null && vtables.some((vt) =>
    vt.slots?.some((slot) => !slot.unresolved && slot.address === BigInt(functionAddress)));

  if ((!symInfo.isCxx || symInfo.isFreeFunction) && !hasVtableMembership) {
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
  const candidateClassNames = [...new Set(vtableClassNames.filter((name) => typeof name === 'string' && name.trim()))];
  // Vtable membership proves `this`, but names its class only when every
  // owning table agrees. A conflicting symbol cannot settle an address shared
  // by unrelated classes (for example after identical code folding).
  const vtableClassName = vtableClassNames.length > 0 &&
    vtableClassNames.every((name) => typeof name === 'string' && name.trim()) &&
    candidateClassNames.length === 1 ? candidateClassNames[0] : null;
  const className = vtables.length
    ? (vtableClassName && (!symInfo.className || symInfo.className === vtableClassName) ? vtableClassName : null)
    : symInfo.className;
  const classIdentity = createCppClassIdentity({
    kind: className ? 'named' : 'anonymous',
    className: className || null,
    vtableAddress: vtables[0]?.vtableAddress ?? null,
    offsetToTop: vtables[0]?.offsetToTop ?? 0n,
    isAnonymous: !className,
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
    const arg0 = ir.values.find(v => v.kind === 'arg' && (v.reg === 'x0' || v.label === 'x0' || v.index === 0));
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

    const receiverAliases = new Set([canonicalReceiverValueId]);
    const stackStores = new Map();
    for (const inst of ir.instructions) {
      if (inst?.op !== 'store') continue;
      const base = inst.loc?.base ?? inst.addr?.base ?? null;
      if (base?.reg !== 'sp') continue;
      const disp = inst.loc?.disp ?? inst.addr?.disp ?? null;
      if (disp == null) continue;
      const source = inst.args?.[0]?.value ?? inst.args?.[0] ?? null;
      const values = stackStores.get(String(disp)) ?? new Set();
      values.add(source?.id == null ? null : source.id);
      stackStores.set(String(disp), values);
    }

    // Stack reloads are aliases only when every visible store to that slot is
    // already a proven receiver alias, so stack-slot reuse fails closed.
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
        } else if (inst.op === 'load' && inst.dst?.id != null) {
          const base = inst.loc?.base ?? inst.addr?.base ?? null;
          const disp = inst.loc?.disp ?? inst.addr?.disp ?? null;
          if (base?.reg !== 'sp' || disp == null || receiverAliases.has(inst.dst.id)) continue;
          const sources = stackStores.get(String(disp));
          if (sources?.size && [...sources].every((id) => id != null && receiverAliases.has(id))) {
            receiverAliases.add(inst.dst.id);
            changed = true;
          }
        }
      }
    }

    const instructionIndex = new Map(ir.instructions.map((inst, index) => [String(inst.id), index]));
    const instructionBlock = new Map();
    for (let blockIndex = 0; blockIndex < (ir.blocks || []).length; blockIndex++) {
      const block = ir.blocks[blockIndex];
      for (const inst of block.insts || block.instructions || []) {
        const id = typeof inst === 'object' ? inst?.id : inst;
        if (id != null) instructionBlock.set(String(id), blockIndex);
      }
    }

    const resolveLoadDefinition = (value) => {
      let current = value;
      const seen = new Set();
      for (let depth = 0; depth < 8 && current?.id != null; depth++) {
        const id = String(current.id);
        if (seen.has(id)) return null;
        seen.add(id);
        const def = valueDef.get(current.id) ?? current.def ?? null;
        if (def?.op === 'load') return def;
        if (!['mov', 'copy'].includes(def?.op) || def.sub != null) return null;
        current = def.args?.[0]?.value ?? def.args?.[0] ?? null;
      }
      return null;
    };

    const machineCallTargetRegister = (inst) => {
      const temporaryId = inst.extra?.attributes?.machineControlEffect?.target?.temporaryId;
      if (typeof temporaryId !== 'string') return null;
      return /(?:^|:)read-([a-z][0-9]+):/i.exec(temporaryId)?.[1]?.toLowerCase() ?? null;
    };

    const reachingCallTarget = (inst, register) => {
      const callIndex = instructionIndex.get(String(inst.id));
      const callBlock = instructionBlock.get(String(inst.id));
      if (callIndex == null || callBlock == null) return null;
      let bestIndex = -1, best = null, tied = false;
      for (const value of ir.values || []) {
        if (value?.reg !== register || value.kind !== 'def' || value.def?.op === 'call') continue;
        const defIndex = instructionIndex.get(String(value.def?.id));
        if (defIndex == null || defIndex >= callIndex
            || instructionBlock.get(String(value.def.id)) !== callBlock) continue;
        if (defIndex > bestIndex) { bestIndex = defIndex; best = value; tied = false; }
        else if (defIndex === bestIndex && String(best?.id) !== String(value.id)) tied = true;
      }
      return tied ? null : best;
    };

    for (const inst of ir.instructions) {
      if (inst.op !== 'call') continue;

      // Compatibility call IR keeps the indirect target in the machine
      // control-effect register and places ABI arguments in `inst.args`.
      // Synthetic/older call IRs carry the target as arg0 instead.
      const targetRegister = machineCallTargetRegister(inst);
      const targetVal = targetRegister
        ? reachingCallTarget(inst, targetRegister)
        : (inst.args?.[0]?.value ?? inst.args?.[0] ?? null);
      const targetDef = resolveLoadDefinition(targetVal);
      if (!targetDef) continue;

      const slotOffset = targetDef.loc?.disp ?? targetDef.addr?.disp;
      if (slotOffset == null) continue;

      const vptrVal = targetDef.loc?.base || targetDef.addr?.base;
      const vptrDef = resolveLoadDefinition(vptrVal);
      if (!vptrDef) continue;

      const vptrOffset = vptrDef.loc?.disp ?? vptrDef.addr?.disp ?? 0n;
      if (BigInt(vptrOffset) !== 0n) continue;

      const objVal = vptrDef.loc?.base || vptrDef.addr?.base;
      if (!objVal || !receiverAliases.has(objVal.id)) continue;

      // Verify that this call passes the receiver as argument 0
      const callArg0 = targetRegister
        ? (inst.args?.[0]?.value ?? inst.args?.[0])
        : (inst.args?.[1]?.value ?? inst.args?.[1]);
      if (callArg0 && !receiverAliases.has(callArg0.id)) continue;

      let slotOffsetBigInt;
      try { slotOffsetBigInt = BigInt(slotOffset); } catch { continue; }
      if (slotOffsetBigInt < 0n || slotOffsetBigInt % BigInt(pointerBytes) !== 0n) continue;
      const slotIndexBigInt = slotOffsetBigInt / BigInt(pointerBytes);
      if (slotIndexBigInt > BigInt(Number.MAX_SAFE_INTEGER)) continue;
      const slotIndex = Number(slotIndexBigInt);
      const slotByteOffset = Number(slotOffsetBigInt);
      if (!Number.isSafeInteger(slotByteOffset)) continue;

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
          // Target-set closure is a call-site property. Function-scoped metadata
          // cannot prove that this particular virtual dispatch has one exhaustive
          // target, especially when a function contains multiple virtual calls.
          // Keep extraction fail-closed until a call-site-scoped authority is
          // supplied by a dedicated producer through createCppVirtualSlotEvidence().
          closureProven: false,
          candidateTargetIds: [],
          exactTargetAddress: null,
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
