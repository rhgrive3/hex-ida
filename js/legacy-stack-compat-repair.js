/*
 * Legacy-v1 compatibility repair for private caller stack state.
 *
 * The historical ARM64 oracle treats the incoming x29 frame pointer as a stack
 * root. Saving that value into the callee's own frame is normal AAPCS64 frame
 * preservation, not an escape of the callee's private stack. When that false
 * escape reaches MemorySSA, every opaque call is allowed to clobber every local
 * stack slot and exact post-call spill recovery is lost.
 *
 * This compatibility repair is deliberately fail-closed. It changes legacy
 * metadata only when no stack-derived value can be proven to escape through a
 * call, unknown operation, or non-stack store. Unknown memory stores remain
 * barriers, and stack values reloaded from an exact local store keep their
 * provenance when checking for a later escape.
 */

function directStackProof(value, stackPointerProvenanceOf) {
  try {
    // Any non-null provenance means the value may carry a stack address.  The
    // producer's `must:false` form is intentionally still an escape barrier.
    return stackPointerProvenanceOf?.(value) != null;
  } catch {
    return false;
  }
}

function valueMayCarryStackAddress(value, stackPointerProvenanceOf, memo = new Map(), active = new Set()) {
  if (!value) return false;
  const key = value.id ?? value;
  if (memo.has(key)) return memo.get(key);
  if (active.has(key)) return false;
  if (directStackProof(value, stackPointerProvenanceOf)) {
    memo.set(key, true);
    return true;
  }

  active.add(key);
  const def = value.def;
  let carries = false;
  if (def?.op === 'load' && def.loc?.kind === 'stack' && def.reachingStore?.op === 'store') {
    carries = valueMayCarryStackAddress(def.reachingStore.args?.[0]?.value,
      stackPointerProvenanceOf, memo, active);
  } else if (def?.op === 'mov' && def.args?.length === 1) {
    carries = valueMayCarryStackAddress(def.args[0]?.value, stackPointerProvenanceOf, memo, active);
  } else if (def?.op === 'phi') {
    carries = (def.incoming ?? def.args ?? []).some((incoming) =>
      valueMayCarryStackAddress(incoming?.value, stackPointerProvenanceOf, memo, active));
  } else if (def?.op === 'bin' && (def.sub === 'add' || def.sub === 'sub') && def.args?.length >= 2) {
    const left = def.args[0]?.value;
    const right = def.args[1]?.value;
    if (right?.const != null) {
      carries = valueMayCarryStackAddress(left, stackPointerProvenanceOf, memo, active);
    } else if (def.sub === 'add' && left?.const != null) {
      carries = valueMayCarryStackAddress(right, stackPointerProvenanceOf, memo, active);
    }
  }
  active.delete(key);
  memo.set(key, carries);
  return carries;
}

export function canonicalizeLegacyRootedFieldBases(projected) {
  const roots = new Map();
  for (const value of projected?.values ?? []) {
    if (value?.semanticValueId == null) continue;
    const id = String(value.semanticValueId);
    if (!roots.has(id)) roots.set(id, value);
  }
  if (!roots.size) return projected;

  const locations = new Set();
  for (const loc of projected?.locations?.values?.() ?? []) locations.add(loc);
  for (const inst of projected?.instructions ?? []) if (inst?.loc) locations.add(inst.loc);

  for (const loc of locations) {
    if (loc?.kind !== 'field' || loc.baseEntityId == null) continue;
    const baseEntityId = String(loc.baseEntityId);
    const root = roots.get(baseEntityId) ?? null;
    if (!root) continue;
    if (typeof loc.key !== 'string' || !loc.key.startsWith(`field:${baseEntityId}+`)) continue;
    // A rooted-offset MemorySSA region already proves the canonical root
    // entity. Keep the legacy projection attached to that root instead of an
    // access-local reload of the same pointer. This is representation repair,
    // not an alias inference: the region/key proof is unchanged and malformed
    // or unrooted locations remain untouched.
    loc.base = root;
  }
  return projected;
}

function stackAddressEscapesFunction(projected, stackPointerProvenanceOf) {
  const memo = new Map();
  for (const inst of projected?.instructions ?? []) {
    if (inst?.stackArgsMayContainPointers === true) return true;
    if (inst?.op === 'store' && inst.loc?.kind === 'stack') continue;
    if (!['call', 'store', 'unknown'].includes(inst?.op)) continue;
    if ((inst.args ?? []).some((arg) =>
      valueMayCarryStackAddress(arg?.value, stackPointerProvenanceOf, memo))) return true;
  }
  return false;
}

function exactAccessSize(inst) {
  const raw = inst?.loc?.size ?? inst?.size ?? inst?.addr?.size ?? null;
  const size = Number(raw);
  return Number.isSafeInteger(size) && size > 0 ? size : null;
}

const PURE_AFTER_STORE = new Set([
  'const', 'mov', 'bin', 'un', 'mac', 'bfx', 'bfi', 'cmp', 'sel', 'load', 'addr', 'phi', 'br', 'cbr',
]);

function terminalCommittedFieldStore(projected, predecessor, incomingValue) {
  const block = projected?.blocks?.[predecessor];
  if (!block || !incomingValue) return null;
  const insts = [...(block.insts ?? [])]
    .sort((a, b) => Number(b.row) - Number(a.row) || Number(b.id) - Number(a.id));
  for (const inst of insts) {
    if (PURE_AFTER_STORE.has(inst?.op)) continue;
    if (inst?.op !== 'store') return null;
    if (inst.loc?.kind !== 'field' || typeof inst.loc?.key !== 'string' || !inst.loc.key) return null;
    if (inst.args?.[0]?.shift != null || inst.args?.[0]?.value?.id !== incomingValue.id) return null;
    return inst;
  }
  return null;
}

function exactFieldIdentity(store) {
  const loc = store?.loc;
  const size = exactAccessSize(store);
  if (loc?.kind !== 'field' || typeof loc.key !== 'string' || !loc.key || !loc.base || size == null) return null;
  return { key:loc.key, base:loc.base, disp:String(loc.disp ?? store?.addr?.disp ?? ''), size };
}

function sameFieldIdentity(left, right) {
  return !!left && !!right && left.key === right.key && left.base === right.base
    && left.disp === right.disp && left.size === right.size;
}

function nextNumericId(items) {
  let max = -1;
  for (const item of items ?? []) {
    const id = Number(item?.id);
    if (Number.isSafeInteger(id) && id > max) max = id;
  }
  return max + 1;
}

/*
 * Legacy-v1 has no first-class way to say that a scalar PHI is also the exact
 * current value of one memory field.  That matters for a common clang pattern:
 * each branch commits its scalar result to the same field, the merge PHI is
 * spilled to a private stack slot, and the slot is reloaded after an opaque
 * call for the function return.
 *
 * Preserve the PHI itself as SSA truth.  Only rewrite the private stack STORE's
 * operand to a synthetic field-load *view* when every predecessor proves that
 * its exact incoming scalar is the terminal committed value of the exact same
 * field, at the exact same width.  The synthetic view is deliberately not
 * inserted into the physical instruction list; it exists only so legacy
 * consumers can render the already-proven memory identity instead of inventing
 * a local_phi temporary.  Any missing predecessor, different field/base/width,
 * intervening call/unknown/store, or non-exact operand fails closed.
 */
function materializeExactPhiFieldSpills(projected) {
  let nextValueId = nextNumericId(projected?.values);
  let nextInstructionId = nextNumericId(projected?.instructions);
  let nextVid = Math.max(0, ...(projected?.values ?? []).map((value) =>
    Number.isSafeInteger(Number(value?.vid)) ? Number(value.vid) : 0)) + 1;

  for (const stackStore of projected?.instructions ?? []) {
    if (stackStore?.op !== 'store' || stackStore.loc?.kind !== 'stack') continue;
    const stackSize = exactAccessSize(stackStore);
    const operand = stackStore.args?.[0] ?? null;
    const spilled = operand?.value ?? null;
    const phi = spilled?.def;
    if (stackSize == null || operand?.shift != null || phi?.op !== 'phi'
        || phi.block !== stackStore.block || !Array.isArray(phi.incoming)) continue;

    const merge = projected.blocks?.[stackStore.block];
    const predecessors = [...(merge?.pred ?? [])];
    if (predecessors.length < 2 || phi.incoming.length !== predecessors.length) continue;
    const incomingByPred = new Map();
    let malformed = false;
    for (const incoming of phi.incoming) {
      if (!Number.isInteger(incoming?.from) || !incoming?.value || incomingByPred.has(incoming.from)) {
        malformed = true;
        break;
      }
      incomingByPred.set(incoming.from, incoming.value);
    }
    if (malformed || predecessors.some((pred) => !incomingByPred.has(pred))) continue;

    const fieldStores = [];
    let identity = null;
    for (const pred of predecessors) {
      const store = terminalCommittedFieldStore(projected, pred, incomingByPred.get(pred));
      const candidate = exactFieldIdentity(store);
      if (!store || !candidate || (identity && !sameFieldIdentity(identity, candidate))) {
        identity = null;
        fieldStores.length = 0;
        break;
      }
      identity ??= candidate;
      fieldStores.push(store);
    }
    if (!identity || fieldStores.length !== predecessors.length || identity.size !== stackSize) continue;

    const bits = Number(spilled.bits ?? stackSize * 8);
    if (!Number.isSafeInteger(bits) || bits !== stackSize * 8) continue;
    const fieldLoc = fieldStores[0].loc;
    const templateAddr = fieldStores[0].addr ?? {};
    const syntheticDef = {
      id:nextInstructionId++,
      op:'load', sub:'compat-phi-field-view', block:stackStore.block, row:stackStore.row,
      address:stackStore.address ?? null, text:stackStore.text ?? null, args:[], dst:null,
      loc:fieldLoc, size:identity.size,
      addr:{ ...templateAddr, base:fieldLoc.base, disp:fieldLoc.disp ?? templateAddr.disp, size:identity.size },
      extra:{
        compatSyntheticView:true,
        compatPhiFieldIdentity:identity.key,
        compatPhiFieldEvidence:fieldStores.map((store) => store.id),
      },
    };
    const syntheticValue = {
      id:nextValueId++, vid:nextVid++, kind:'def', reg:null, stateKey:null, version:0,
      bits, def:syntheticDef, uses:[stackStore], const:null, range:spilled.range ?? null,
      signed:spilled.signed ?? null, nullable:spilled.nullable ?? null, type:spilled.type ?? null,
      label:`compat_${identity.key}`, semanticValueId:null, semanticSsaValueId:null,
      sourceSemanticValueId:null, sourceEntityId:null, machineType:spilled.machineType ?? null,
      origin:phi.origin ?? stackStore.origin ?? null,
    };
    syntheticDef.dst = syntheticValue;

    if (Array.isArray(spilled.uses)) spilled.uses = spilled.uses.filter((use) => use !== stackStore);
    stackStore.args[0] = { ...operand, value:syntheticValue, bits };
    stackStore.extra = {
      ...(stackStore.extra ?? {}),
      compatPhiFieldSpill:true,
      compatPhiFieldIdentity:identity.key,
      compatPhiFieldEvidence:fieldStores.map((store) => store.id),
    };
    projected.values.push(syntheticValue);
  }
  return projected;
}

export function restoreLegacyPrivateStackForwarding(projected, stackPointerProvenanceOf) {
  if (!projected) return projected;
  canonicalizeLegacyRootedFieldBases(projected);
  if (stackAddressEscapesFunction(projected, stackPointerProvenanceOf)) return projected;

  materializeExactPhiFieldSpills(projected);

  const repairedCalls = new Set();
  for (const inst of projected.instructions ?? []) {
    if (inst?.op !== 'call' || !Array.isArray(inst.memKills)) continue;
    const before = inst.memKills.length;
    inst.memKills = inst.memKills.filter((loc) => loc?.kind !== 'stack');
    if (inst.memKills.length !== before) repairedCalls.add(inst);
  }
  if (!repairedCalls.size) return projected;

  for (const load of projected.instructions ?? []) {
    if (load?.op !== 'load' || load.loc?.kind !== 'stack' || load.reachingStore) continue;
    if (load.memUse?.kind !== 'clobber' || !repairedCalls.has(load.memUse?.inst)) continue;
    const block = projected.blocks?.[load.block];
    if (!block) continue;
    const loadSize = exactAccessSize(load);
    if (loadSize == null) continue;

    const prior = [...(block.insts ?? [])]
      .filter((inst) => Number(inst.row) < Number(load.row))
      .sort((a, b) => Number(b.row) - Number(a.row) || Number(b.id) - Number(a.id));
    let store = null;
    for (const inst of prior) {
      if (inst?.op === 'unknown') break;
      if (inst?.op === 'store' && (!inst.loc?.key || inst.loc?.kind === 'unknown')) break;
      if (inst?.op === 'store' && inst.loc?.kind === 'stack'
          && inst.loc.key === load.loc.key && exactAccessSize(inst) === loadSize) {
        store = inst;
        break;
      }
    }
    if (!store?.memDef) continue;
    load.reachingStore = store;
    load.memUse = store.memDef;
    load.extra = {
      ...(load.extra ?? {}),
      compatStackCallPreservation:true,
      compatStackCallPreservationEvidence:'no-stack-derived-value-escapes-function',
    };
  }
  return projected;
}
