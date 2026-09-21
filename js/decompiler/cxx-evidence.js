import {
  isCanonicalCppReceiverEvidence,
  isCanonicalCppVirtualSlotEvidence,
} from '../analysis/cxx/object-evidence.js';

function sameId(left, right) {
  return left != null && right != null
    && (left === right || String(left) === String(right));
}

function sameAddress(left, right) {
  if (left == null || right == null) return true;
  try { return BigInt(left) === BigInt(right); } catch { return false; }
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

  if (!sameAddress(rec.functionAddress, opts?.addr)) return null;
  if (ir.functionId != null && rec.functionId != null
      && String(ir.functionId) !== String(rec.functionId)) return null;

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
        if (source) pending.push(source);
      }
    }
  }
  return false;
}

export function currentCppVirtualSlot(opts = {}, inst = null) {
  if (!inst) return null;
  const source = opts?.cxxEvidence?.virtualSlots;
  const slots = Array.isArray(source) ? source
    : source instanceof Map ? [...source.values()] : [];
  return slots.find(slot => {
    if (!isCanonicalCppVirtualSlotEvidence(slot) || slot.virtualSlotKnown !== true) return false;
    if (slot.callSiteId != null && sameId(slot.callSiteId, inst.id)) return true;
    return slot.callSiteAddress != null && inst.address != null
      && sameAddress(slot.callSiteAddress, inst.address);
  }) ?? null;
}
