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

function exactBitWidth(value) {
  const bits = value?.bits;
  return typeof bits === 'number' && Number.isSafeInteger(bits) && bits > 0 ? bits : null;
}

function exactProjectionSource(value, accessBits) {
  if (!value || exactBitWidth(value) !== accessBits) return null;
  let current = value;
  const seen = new Set();
  while (current?.def?.op === 'mov') {
    const key = current.id ?? current;
    if (seen.has(key)) return null;
    seen.add(key);
    const def = current.def;
    if (def.dst && def.dst !== current) return null;
    if (def.args?.length !== 1 || def.args[0]?.shift != null) return null;
    const source = def.args[0]?.value ?? null;
    const dstBits = exactBitWidth(current);
    const sourceBits = exactBitWidth(source);
    if (dstBits == null || sourceBits == null) return null;
    if (def.sub === 'trunc') {
      if (sourceBits <= dstBits) return null;
    } else if (def.sub == null || def.sub === '') {
      if (sourceBits !== dstBits) return null;
    } else {
      return null;
    }
    current = source;
  }
  return exactBitWidth(current) >= accessBits ? current : null;
}

/* A register-width value may be carried in a wider SSA object while the
 * machine operand on an exact-width store explicitly selects its low bits
 * (for example `str w8` with a 64-bit x8 PHI). */
function exactStoredProjectionSource(operand, accessBits) {
  const value = operand?.value ?? null;
  const declaredBits = Number(operand?.bits ?? 0);
  if (declaredBits === accessBits && exactBitWidth(value) >= accessBits) return value;
  return exactProjectionSource(value, accessBits);
}

function isExactLowBitsProjectionOf(value, source, accessBits) {
  if (!value || !source || exactBitWidth(value) !== accessBits) return false;
  let current = value;
  const seen = new Set();
  for (;;) {
    if (current === source || (current.id != null && source.id != null && current.id === source.id)) {
      const sourceBits = exactBitWidth(source);
      return sourceBits != null && sourceBits >= accessBits;
    }
    const key = current.id ?? current;
    if (seen.has(key)) return false;
    seen.add(key);
    const def = current?.def;
    if (def?.op !== 'mov' || (def.dst && def.dst !== current)
        || def.args?.length !== 1 || def.args[0]?.shift != null) return false;
    const next = def.args[0]?.value ?? null;
    const dstBits = exactBitWidth(current);
    const nextBits = exactBitWidth(next);
    if (dstBits == null || nextBits == null) return false;
    if (def.sub === 'trunc') {
      if (nextBits <= dstBits) return false;
    } else if (def.sub == null || def.sub === '') {
      if (nextBits !== dstBits) return false;
    } else {
      return false;
    }
    current = next;
  }
}

const PURE_AFTER_STORE = new Set([
  'const', 'mov', 'bin', 'un', 'mac', 'bfx', 'bfi', 'cmp', 'sel', 'load', 'addr', 'phi', 'br', 'cbr',
]);

function terminalCommittedFieldStore(projected, predecessor, incomingValue, accessBits) {
  const block = projected?.blocks?.[predecessor];
  if (!block || !incomingValue) return null;
  const insts = [...(block.insts ?? [])]
    .sort((a, b) => Number(b.row) - Number(a.row) || Number(b.id) - Number(a.id));
  for (const inst of insts) {
    if (PURE_AFTER_STORE.has(inst?.op)) continue;
    if (inst?.op !== 'store') return null;
    if (inst.loc?.kind !== 'field' || typeof inst.loc?.key !== 'string' || !inst.loc.key) return null;
    if (inst.args?.[0]?.shift != null
        || !isExactLowBitsProjectionOf(inst.args?.[0]?.value, incomingValue, accessBits)) return null;
    return inst;
  }
  return null;
}

/*
 * A legacy field location can lose its original pointer root when the same
 * object pointer is saved in a private stack slot and reloaded on another
 * CFG path.  The legacy lifter intentionally gives that reload a fresh
 * `loaded:<id>` alias root.  Recover that root only through an exact,
 * MemorySSA-backed stack load: the load and store must have the same location
 * and width, the load's reaching definition must be that store, and the store
 * value must itself have one exact pointer root.  This is a forwarding proof,
 * not an alias guess; unknown loads, calls, mixed PHIs, and widened copies
 * remain unrooted and fail closed.
 */
function exactForwardedPointerRoot(value, active = new Set()) {
  if (!value) return null;
  const key = value.id ?? value;
  if (active.has(key)) return null;
  active.add(key);

  let root = null;
  if (value.kind === 'arg' && typeof value.reg === 'string' && value.reg.length > 0) {
    root = `arg:${value.reg}`;
  }

  const def = value.def;
  if (!root && def?.op === 'mov' && def.args?.length === 1 && def.args[0]?.shift == null) {
    const source = def.args[0]?.value ?? null;
    if (exactBitWidth(value) === exactBitWidth(source)) root = exactForwardedPointerRoot(source, active);
  }

  if (!root && def?.op === 'load' && def.loc?.kind === 'stack') {
    const store = def.reachingStore ?? null;
    const stored = store?.args?.[0]?.value ?? null;
    const loadSize = exactAccessSize(def);
    const storeSize = exactAccessSize(store);
    const memoryUse = def.memUse ?? null;
    const sameLocation = typeof def.loc.key === 'string' && def.loc.key.length > 0
      && def.loc.key === store?.loc?.key;
    const exactWidth = loadSize != null && loadSize === storeSize
      && exactBitWidth(value) === loadSize * 8
      && exactBitWidth(stored) === loadSize * 8;
    const exactDefinition = memoryUse?.kind === 'store'
      && (!memoryUse.inst || memoryUse.inst === store || memoryUse.inst === store.id
        || String(memoryUse.inst) === String(store.id));
    if (store?.op === 'store' && sameLocation && exactWidth && exactDefinition) {
      root = exactForwardedPointerRoot(stored, active);
    }
  }

  if (!root && def?.op === 'phi') {
    const incoming = Array.isArray(def.incoming) ? def.incoming : def.args;
    if (Array.isArray(incoming) && incoming.length > 0) {
      const roots = incoming.map((item) => exactForwardedPointerRoot(item?.value ?? null, active));
      if (roots.every(Boolean) && roots.every((candidate) => candidate === roots[0])) root = roots[0];
    }
  }

  if (!root && def?.op === 'bin' && (def.sub === 'add' || def.sub === 'sub') && def.args?.length >= 2) {
    const left = def.args[0]?.value ?? null;
    const right = def.args[1]?.value ?? null;
    if (right?.const != null) root = exactForwardedPointerRoot(left, active);
    else if (def.sub === 'add' && left?.const != null) root = exactForwardedPointerRoot(right, active);
  }

  active.delete(key);
  return root;
}

function sourceEvidenceForInstruction(instruction) {
  if (!instruction || instruction.address == null || instruction.row == null || instruction.id == null) return null;
  return {
    addresses:[instruction.address],
    rows:[instruction.row],
    ir:[instruction.id],
    evidence:[{ reason:'exact private-stack pointer forwarding' }],
  };
}

function mergePointerSourceEvidence(...sources) {
  const out = { addresses:[], rows:[], ir:[], evidence:[] };
  for (const source of sources) {
    if (!source) continue;
    for (const key of ['addresses', 'rows', 'ir']) {
      for (const value of source[key] ?? []) {
        if (!out[key].some((existing) => String(existing) === String(value))) out[key].push(value);
      }
    }
    out.evidence.push(...(source.evidence ?? []));
  }
  return out.addresses.length || out.rows.length || out.ir.length || out.evidence.length ? out : null;
}

/* Return the physical source records for the exact forwarding proof above.
 * These records are presentation evidence only; they never authorize a
 * rewrite without the root/width/location checks in exactFieldIdentity(). */
function exactForwardedPointerSourceEvidence(value, active = new Set()) {
  if (!value) return null;
  const key = value.id ?? value;
  if (active.has(key)) return null;
  active.add(key);
  let evidence = null;
  const def = value.def;
  if (def?.op === 'mov' && def.args?.length === 1 && def.args[0]?.shift == null
      && exactBitWidth(value) === exactBitWidth(def.args[0]?.value)) {
    evidence = exactForwardedPointerSourceEvidence(def.args[0]?.value, active);
  } else if (def?.op === 'load' && def.loc?.kind === 'stack') {
    const store = def.reachingStore ?? null;
    const stored = store?.args?.[0]?.value ?? null;
    const loadSize = exactAccessSize(def);
    const storeSize = exactAccessSize(store);
    const memoryUse = def.memUse ?? null;
    const sameLocation = typeof def.loc.key === 'string' && def.loc.key.length > 0
      && def.loc.key === store?.loc?.key;
    const exactWidth = loadSize != null && loadSize === storeSize
      && exactBitWidth(value) === loadSize * 8
      && exactBitWidth(stored) === loadSize * 8;
    const exactDefinition = memoryUse?.kind === 'store'
      && (!memoryUse.inst || memoryUse.inst === store || memoryUse.inst === store.id
        || String(memoryUse.inst) === String(store.id));
    if (store?.op === 'store' && sameLocation && exactWidth && exactDefinition
        && exactForwardedPointerRoot(stored) != null) {
      evidence = mergePointerSourceEvidence(
        exactForwardedPointerSourceEvidence(stored, active),
        sourceEvidenceForInstruction(store),
        sourceEvidenceForInstruction(def),
      );
    }
  } else if (def?.op === 'phi') {
    const incoming = Array.isArray(def.incoming) ? def.incoming : def.args;
    if (Array.isArray(incoming) && incoming.length > 0) {
      const parts = incoming.map((item) => exactForwardedPointerSourceEvidence(item?.value ?? null, active));
      if (parts.every((part) => part != null)) evidence = mergePointerSourceEvidence(...parts);
    }
  } else if (def?.op === 'bin' && (def.sub === 'add' || def.sub === 'sub') && def.args?.length >= 2) {
    const left = def.args[0]?.value ?? null;
    const right = def.args[1]?.value ?? null;
    if (right?.const != null) evidence = exactForwardedPointerSourceEvidence(left, active);
    else if (def.sub === 'add' && left?.const != null) evidence = exactForwardedPointerSourceEvidence(right, active);
  }
  active.delete(key);
  return evidence;
}

function annotateExactForwardedFieldStore(store) {
  const base = store?.loc?.rawBase ?? store?.loc?.base ?? null;
  if (!base || exactForwardedPointerRoot(base) == null) return;
  const evidence = exactForwardedPointerSourceEvidence(base);
  if (!evidence) return;
  store.extra = {
    ...(store.extra ?? {}),
    compatExactPointerProvenance:evidence,
  };
}

function exactFieldIdentity(store) {
  const loc = store?.loc;
  const size = exactAccessSize(store);
  const baseEntityId = typeof loc?.baseEntityId === 'string' && loc.baseEntityId ? loc.baseEntityId : null;
  if (loc?.kind !== 'field' || typeof loc.key !== 'string' || !loc.key || !loc.base || size == null) return null;
  const root = exactForwardedPointerRoot(loc.rawBase ?? loc.base);
  // Keep the existing canonical entity proof when available.  A precise
  // forwarded pointer root is the equivalent proof for legacy locations that
  // predate `baseEntityId` metadata.
  if (!baseEntityId && !root) return null;
  return { key:loc.key, baseEntityId, root, disp:String(loc.disp ?? store?.addr?.disp ?? ''), size };
}

function sameFieldIdentity(left, right) {
  if (!left || !right || left.disp !== right.disp || left.size !== right.size) return false;
  if (left.root || right.root) return !!left.root && !!right.root && left.root === right.root;
  return left.key === right.key && left.baseEntityId === right.baseEntityId;
}

function valueDominatesInstruction(value, inst, projected) {
  if (!value || !inst) return false;
  if (value.kind === 'arg') return true;
  const definition = value.def;
  if (!definition || definition === inst) return false;
  if (definition.block === inst.block) return Number(definition.row) <= Number(inst.row);
  const dominators = projected?.dominators?.[inst.block];
  return dominators instanceof Set && dominators.has(definition.block);
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
 * its exact low-bit projection is the terminal committed value of the exact
 * same rooted field, at the exact same access width.  The rendering base must
 * dominate the spill.  The synthetic view is deliberately not inserted into
 * the physical instruction list; it exists only so legacy consumers can render
 * the already-proven memory identity instead of inventing a local_phi temporary.
 * Any missing predecessor, different field/root/width, widening/conversion,
 * non-dominating base, intervening call/unknown/store, or ambiguous operand
 * fails closed.
 */
function materializeExactPhiFieldSpills(projected) {
  let nextValueId = nextNumericId(projected?.values);
  let nextInstructionId = nextNumericId(projected?.instructions);
  let nextVid = Math.max(0, ...(projected?.values ?? []).map((value) =>
    Number.isSafeInteger(Number(value?.vid)) ? Number(value.vid) : 0)) + 1;

  for (const stackStore of projected?.instructions ?? []) {
    if (stackStore?.op !== 'store' || stackStore.loc?.kind !== 'stack') continue;
    const stackSize = exactAccessSize(stackStore);
    const accessBits = stackSize == null ? null : stackSize * 8;
    const operand = stackStore.args?.[0] ?? null;
    const spilled = operand?.value ?? null;
    const phiValue = accessBits == null ? null : exactStoredProjectionSource(operand, accessBits);
    const phi = phiValue?.def;
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
      const store = terminalCommittedFieldStore(projected, pred, incomingByPred.get(pred), accessBits);
      annotateExactForwardedFieldStore(store);
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

    const fieldBase = fieldStores.map((store) => store.loc?.base ?? null)
      .find((base) => valueDominatesInstruction(base, stackStore, projected)) ?? null;
    if (!fieldBase) continue;
    const bits = accessBits;
    const fieldLoc = { ...fieldStores[0].loc, base:fieldBase };
    const pointerEvidence = mergePointerSourceEvidence(
      ...fieldStores.map((store) => store.extra?.compatExactPointerProvenance),
    );
    const templateAddr = fieldStores[0].addr ?? {};
    const syntheticDef = {
      id:nextInstructionId++,
      op:'load', sub:'compat-phi-field-view', block:stackStore.block, row:stackStore.row,
      address:stackStore.address ?? null, text:stackStore.text ?? null, args:[], dst:null,
      loc:fieldLoc, size:identity.size,
      addr:{ ...templateAddr, base:fieldBase, disp:fieldLoc.disp ?? templateAddr.disp, size:identity.size },
      extra:{
        compatSyntheticView:true,
        compatPhiFieldIdentity:identity.key,
        compatPhiFieldEvidence:fieldStores.map((store) => store.id),
        ...(pointerEvidence ? { compatExactPointerProvenance:pointerEvidence } : {}),
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

  // This is an SSA/value-shape projection only; it does not remove a memory
  // barrier or claim that the stack is private.  Apply it before the escape
  // guard so an otherwise conservative call cannot force an equivalent exact
  // scalar PHI to leak as a synthetic local.
  materializeExactPhiFieldSpills(projected);

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
