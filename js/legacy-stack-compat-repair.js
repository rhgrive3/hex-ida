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
    const proof = stackPointerProvenanceOf?.(value);
    return proof?.must === true || proof?.may === true;
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

export function restoreLegacyPrivateStackForwarding(projected, stackPointerProvenanceOf) {
  if (!projected) return projected;
  canonicalizeLegacyRootedFieldBases(projected);
  if (stackAddressEscapesFunction(projected, stackPointerProvenanceOf)) return projected;

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

    const prior = [...(block.insts ?? [])]
      .filter((inst) => Number(inst.row) < Number(load.row))
      .sort((a, b) => Number(b.row) - Number(a.row) || Number(b.id) - Number(a.id));
    let store = null;
    for (const inst of prior) {
      if (inst?.op === 'store' && inst.loc?.key === load.loc.key) {
        store = inst;
        break;
      }
      if (inst?.op === 'unknown') break;
      if (inst?.op === 'store' && (!inst.loc?.key || inst.loc?.kind === 'unknown')) break;
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
