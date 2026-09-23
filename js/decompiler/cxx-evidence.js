import {
  isCanonicalCppMemberEvidence,
  isCanonicalCppReceiverEvidence,
  isCanonicalCppVirtualSlotEvidence,
} from '../analysis/cxx/object-evidence.js';

function sameId(left, right) {
  return left != null && right != null
    && (left === right || String(left) === String(right));
}

function sameAddress(left, right) {
  if (left == null || right == null) return false;
  try { return BigInt(left) === BigInt(right); } catch { return false; }
}

function currentFunctionAddress(opts, ir) {
  return opts?.addr ?? ir?.startAddress ?? ir?.instructions?.[0]?.address ?? null;
}

function valueWidthBits(value) {
  for (const candidate of [
    value?.bits,
    value?.widthBits,
    value?.machineType?.widthBits,
    value?.type?.bits,
    value?.type?.widthBits,
  ]) {
    const width = Number(candidate);
    if (Number.isSafeInteger(width) && width > 0) return width;
  }
  return null;
}

function isWidthPreservingAliasCast(current, source) {
  const currentBits = valueWidthBits(current);
  const sourceBits = valueWidthBits(source);
  return currentBits != null && sourceBits != null && currentBits === sourceBits;
}

export function currentCppReceiver(opts = {}, ir = null) {
  const rec = opts?.cxxEvidence?.receiver;
  if (!isCanonicalCppReceiverEvidence(rec)
      || rec.receiverRole !== 'this'
      || rec.completeness !== 'complete'
      || rec.uncertainty
      || rec.abiBinding?.argumentIndex !== 0
      || typeof rec.abiBinding?.register !== 'string'
      || !ir || !Array.isArray(ir.values)) return null;

  const addressMatches = rec.functionAddress != null
    && sameAddress(rec.functionAddress, currentFunctionAddress(opts, ir));
  const functionIdMatches = sameId(rec.functionId, ir.functionId);
  if (!addressMatches && !functionIdMatches) return null;

  const canonical = ir.values.find(value => sameId(value?.id, rec.canonicalValueId));
  if (!canonical) return null;

  const register = String(rec.abiBinding.register);
  const mapped = ir.args?.get?.(register) ?? null;
  if (mapped && !sameId(mapped.id, canonical.id)) return null;
  if (!mapped && typeof canonical.reg === 'string' && canonical.reg !== register) return null;
  return rec;
}

const receiverAliasClosureCache = new WeakMap();

function receiverAliasSource(inst, currentValue = null) {
  if (!inst) return null;
  if (inst.op === 'mov' || inst.op === 'copy') {
    return inst.args?.[0]?.value ?? inst.args?.[0] ?? null;
  }
  if (inst.op === 'unary' || inst.op === 'un') {
    if (!['sxt64', 'uxt64', 'bitcast', 'zext', 'sext'].includes(inst.sub)) return null;
    const source = inst.args?.[0]?.value ?? inst.args?.[0] ?? null;
    const target = currentValue ?? inst.dst ?? null;
    return source && target && isWidthPreservingAliasCast(target, source) ? source : null;
  }
  return null;
}

function receiverAliasClosure(rec, ir) {
  if (!rec || !ir || !Array.isArray(ir.instructions)) return null;
  let byReceiver = receiverAliasClosureCache.get(ir);
  if (!byReceiver) {
    byReceiver = new Map();
    receiverAliasClosureCache.set(ir, byReceiver);
  }
  const key = String(rec.digest ?? rec.canonicalValueId ?? '');
  if (byReceiver.has(key)) return byReceiver.get(key);

  const aliasIds = new Set([String(rec.canonicalValueId)]);
  const spilled = new Map();
  for (const inst of ir.instructions) {
    if (inst?.op !== 'store') continue;
    const loc = inst.loc ?? null;
    const base = loc?.base ?? inst.addr?.base ?? null;
    if (base?.reg !== 'sp') continue;
    const disp = loc?.disp ?? inst.addr?.disp ?? null;
    if (disp == null) continue;
    const source = inst.args?.[0]?.value ?? inst.args?.[0] ?? null;
    const slot = String(disp);
    const sources = spilled.get(slot) ?? new Set();
    sources.add(source?.id == null ? null : String(source.id));
    spilled.set(slot, sources);
  }

  // This intentionally mirrors the producer-side receiver closure: stack
  // reloads only become `this` aliases when *every* visible store to that slot
  // is already a proven receiver alias. Stack-slot reuse therefore fails closed.
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const inst of ir.instructions) {
      const dst = inst?.dst ?? null;
      if (dst?.id == null) continue;
      const source = receiverAliasSource(inst);
      if (source) {
        if (source.id == null || !aliasIds.has(String(source.id))) continue;
        if (dst.bits != null && source.bits != null && Number(dst.bits) !== Number(source.bits)) continue;
      } else if (inst.op === 'load') {
        const loc = inst.loc ?? null;
        const base = loc?.base ?? inst.addr?.base ?? null;
        if (base?.reg !== 'sp') continue;
        const disp = loc?.disp ?? inst.addr?.disp ?? null;
        if (disp == null) continue;
        const sources = spilled.get(String(disp));
        if (!sources?.size || ![...sources].every(id => id !== null && aliasIds.has(id))) continue;
      } else {
        continue;
      }
      const id = String(dst.id);
      if (!aliasIds.has(id)) {
        aliasIds.add(id);
        changed = true;
      }
    }
    if (!changed) break;
  }

  byReceiver.set(key, aliasIds);
  return aliasIds;
}

export function isCppReceiverAlias(value, rec, ir = null) {
  if (!value || !rec) return false;
  if (ir) {
    const closure = receiverAliasClosure(rec, ir);
    if (value.id != null && closure?.has(String(value.id))) return true;
  }
  const visited = new Set(), pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    if (sameId(current.id, rec.canonicalValueId)) return true;
    const source = receiverAliasSource(current.def, current);
    if (source) pending.push(source);
  }
  return false;
}

export function currentCppVirtualSlot(opts = {}, ir = null, inst = null, callReceiver = null) {
  if (!ir || !inst || !callReceiver) return null;
  const receiver = currentCppReceiver(opts, ir);
  if (!receiver || !isCppReceiverAlias(callReceiver, receiver, ir)) return null;

  const source = opts?.cxxEvidence?.virtualSlots;
  const slots = Array.isArray(source) ? source
    : source instanceof Map ? [...source.values()] : [];
  return slots.find(slot => {
    if (!isCanonicalCppVirtualSlotEvidence(slot) || slot.virtualSlotKnown !== true) return false;
    const slotReceiver = ir.values?.find?.(value => sameId(value?.id, slot.receiverValueId)) ?? null;
    if (!slotReceiver || !isCppReceiverAlias(slotReceiver, receiver, ir)) return false;
    if (slot.callSiteId != null && sameId(slot.callSiteId, inst.id)) return true;
    return slot.callSiteAddress != null && inst.address != null
      && sameAddress(slot.callSiteAddress, inst.address);
  }) ?? null;
}


/**
 * Returns the one canonical member record that is bound to the current
 * receiver and exact byte offset. Ambiguous/replayed evidence fails closed.
 */
export function currentCppMember(opts = {}, ir = null, baseValue = null, offsetBytes = null) {
  if (!ir || !baseValue || offsetBytes == null) return null;
  const receiver = currentCppReceiver(opts, ir);
  if (!receiver || !isCppReceiverAlias(baseValue, receiver, ir)) return null;

  let offset;
  try { offset = BigInt(offsetBytes); } catch { return null; }
  if (offset < 0n) return null;

  const source = opts?.cxxEvidence?.members;
  const members = Array.isArray(source) ? source
    : source instanceof Map ? [...source.values()] : [];
  const matches = members.filter(member => {
    if (!isCanonicalCppMemberEvidence(member) || member.accessProven !== true) return false;
    if (!sameId(member.functionId, receiver.functionId)) return false;
    if (member.receiverDigest !== receiver.digest) return false;
    if (member.snapshotId !== receiver.snapshotId) return false;
    return sameAddress(member.offsetBytes, offset);
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Presentation-only type label for a canonical member. The member producer is
 * authoritative for the label; comments/control characters are still rejected
 * here so even future producers cannot accidentally escape a C comment.
 */
export function cppMemberTypeLabel(member) {
  if (!isCanonicalCppMemberEvidence(member) || member.typeProven !== true) return null;
  const label = typeof member.typeLabel === 'string' ? member.typeLabel.trim() : '';
  if (!label || label.length > 160 || /[\r\n]/.test(label) || label.includes('/*') || label.includes('*/')) return null;
  return label;
}
