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

export function isCppReceiverAlias(value, rec) {
  if (!value || !rec) return false;
  const visited = new Set(), pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    if (sameId(current.id, rec.canonicalValueId)) return true;
    const definition = current.def;
    if (!definition) continue;
    if (definition.op === 'mov' || definition.op === 'copy') {
      const source = definition.args?.[0]?.value ?? definition.args?.[0] ?? null;
      if (source) pending.push(source);
      continue;
    }
    if (definition.op === 'unary' || definition.op === 'un') {
      if (['sxt64', 'uxt64', 'bitcast', 'zext', 'sext'].includes(definition.sub)) {
        const source = definition.args?.[0]?.value ?? definition.args?.[0] ?? null;
        if (source && isWidthPreservingAliasCast(current, source)) pending.push(source);
      }
    }
  }
  return false;
}

export function currentCppVirtualSlot(opts = {}, ir = null, inst = null, callReceiver = null) {
  if (!ir || !inst || !callReceiver) return null;
  const receiver = currentCppReceiver(opts, ir);
  if (!receiver || !isCppReceiverAlias(callReceiver, receiver)) return null;

  const source = opts?.cxxEvidence?.virtualSlots;
  const slots = Array.isArray(source) ? source
    : source instanceof Map ? [...source.values()] : [];
  return slots.find(slot => {
    if (!isCanonicalCppVirtualSlotEvidence(slot) || slot.virtualSlotKnown !== true) return false;
    const slotReceiver = ir.values?.find?.(value => sameId(value?.id, slot.receiverValueId)) ?? null;
    if (!slotReceiver || !isCppReceiverAlias(slotReceiver, receiver)) return false;
    if (slot.callSiteId != null && sameId(slot.callSiteId, inst.id)) return true;
    return slot.callSiteAddress != null && inst.address != null
      && sameAddress(slot.callSiteAddress, inst.address);
  }) ?? null;
}


/**
 * Returns canonical member evidence for a field access through the current
 * proven C++ receiver.
 *
 * This is deliberately a presentation-side lookup only. It never infers a
 * field, type, or receiver: all three must already have been issued by the C++
 * evidence producer. A member is accepted only when it is bound to the exact
 * receiver digest/function being rendered and the access base is an alias of
 * that receiver. That keeps a valid member record from being replayed onto an
 * unrelated pointer that happens to use the same byte offset.
 */
export function currentCppMember(opts = {}, ir = null, base = null, offset = null) {
  if (!ir || !base || offset == null) return null;
  const receiver = currentCppReceiver(opts, ir);
  if (!receiver || !isCppReceiverAlias(base, receiver)) return null;

  let wanted;
  try { wanted = BigInt(offset); } catch { return null; }

  const source = opts?.cxxEvidence?.members;
  const members = Array.isArray(source) ? source
    : source instanceof Map ? [...source.values()] : [];
  return members.find((member) => {
    if (!isCanonicalCppMemberEvidence(member) || member.accessProven !== true) return false;
    if (member.receiverDigest !== receiver.digest) return false;
    if (!sameId(member.functionId, receiver.functionId)) return false;
    try { return BigInt(member.offsetBytes) === wanted; } catch { return false; }
  }) ?? null;
}