/**
 * Phase 3 call-site-scoped virtual dispatch recovery.
 *
 * Input is the canonical class evidence from `rtti-evidence.js` plus a slot
 * index. Output is a **target set**, never a single global answer:
 *
 * - Every class reachable from the receiver's class by an RTTI-proven
 *   inheritance edge contributes its own slot target. Legal multiple targets
 *   stay a set.
 * - `closureProven` is only ever true when the caller supplies a per-call-site
 *   proof that the receiver's dynamic type is exactly one class
 *   (`dynamicClassProven`) *and* an explicit closure rule + call-site id. A
 *   class with a single discovered target is not by itself a proof, because a
 *   derived class outside the discovered set could legally override the slot.
 * - When the binary has no RTTI the derived-class set is unknown, so the result
 *   is marked `partial` with an explicit reason instead of pretending the
 *   static class's slot is the whole answer.
 */

import { deepFreeze, stableDigest } from '../../core/identity/index.js';
import { createCppVirtualSlotEvidence } from './object-evidence.js';

export const CPP_VIRTUAL_TARGET_SET_SCHEMA = 'cpp-virtual-target-set/v1';

/** Closure rules a caller may cite. Anything else is rejected. */
export const CPP_CLOSURE_RULES = Object.freeze([
  // The receiver's vtable pointer was stored from this exact class's vtable in
  // the same function (constructor / placement-construct evidence).
  'constructor-vtable-store',
  // The receiver is an object whose exact type is proven by its own definition
  // (file-scope/local object of that class in this image).
  'exact-object-definition',
]);

function classesOf(classEvidence) {
  const classes = classEvidence?.classes;
  if (Array.isArray(classes)) return classes;
  if (classes && typeof classes[Symbol.iterator] === 'function') return [...classes];
  return [];
}

/**
 * Transitive derived classes of `className`, from RTTI-proven edges only.
 */
export function derivedClassesOf(classEvidence, className) {
  if (!className) return [];
  const classes = classesOf(classEvidence);
  const out = new Set();
  const queue = [className];
  while (queue.length) {
    const current = queue.shift();
    for (const record of classes) {
      if (record.className !== current) continue;
      for (const child of record.derivedFrom || []) {
        if (out.has(child)) continue;
        out.add(child);
        queue.push(child);
      }
    }
  }
  return [...out].sort();
}

function candidateFromRecord(record, slotIndex) {
  const slot = (record.slots || [])[slotIndex];
  if (!slot) return null;
  if (slot.unresolved || slot.address == null) {
    return Object.freeze({
      address: null,
      unresolved: true,
      reason: slot.reason || 'slot-target-unresolved',
      viaClass: record.className,
      viaVtableAddress: record.vtableAddress,
      slotIndex,
      aliases: Object.freeze([]),
    });
  }
  return Object.freeze({
    address: slot.address,
    unresolved: false,
    reason: null,
    viaClass: record.className,
    viaVtableAddress: record.vtableAddress,
    slotIndex,
    aliases: Object.freeze([...(slot.aliases || [])]),
  });
}

/**
 * Recovers the possible targets of `receiverClass->vtable[slotIndex]()`.
 *
 * @param {object} input
 * @param {object} input.classEvidence  Report from `buildCxxClassEvidence`.
 * @param {string} input.receiverClass  Proven class of the receiver expression.
 * @param {number} input.slotIndex
 * @param {boolean} [input.dynamicClassProven]
 * @param {{rule: string, callSiteId: string|number}} [input.closureAuthority]
 */
export function resolveVirtualTargetSet({
  classEvidence = null,
  receiverClass = null,
  slotIndex = null,
  dynamicClassProven = false,
  closureAuthority = null,
} = {}) {
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0) {
    throw new TypeError('cpp-virtual-target-set-slot-index-invalid');
  }
  if (typeof receiverClass !== 'string' || !receiverClass.trim()) {
    throw new TypeError('cpp-virtual-target-set-receiver-class-required');
  }

  const records = classesOf(classEvidence).filter((record) => record.className === receiverClass);
  if (!records.length) {
    // Same builder as the normal path: a consumer may key on any field
    // (`candidateAddresses`, `digest`, ...), so an empty answer must not be a
    // narrower record than a populated one.
    return buildTargetSet({
      receiverClass,
      slotIndex,
      candidates: [],
      possibleCandidates: [],
      derivedClasses: [],
      closureProven: false,
      closureRule: null,
      completeness: 'unknown',
      rttiPresent: Boolean(classEvidence?.rttiPresent),
      reason: 'receiver-class-not-in-evidence',
    });
  }

  const rttiPresent = Boolean(classEvidence?.rttiPresent);
  const derived = derivedClassesOf(classEvidence, receiverClass);
  const participating = [receiverClass, ...derived];
  const classes = classesOf(classEvidence);

  const collect = (names) => {
    const out = [];
    const seen = new Set();
    for (const name of names) {
      for (const record of classes) {
        if (record.className !== name) continue;
        const candidate = candidateFromRecord(record, slotIndex);
        if (!candidate) continue;
        const key = `${candidate.address ?? 'unresolved'}@${record.vtableAddress}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(candidate);
      }
    }
    return out;
  };

  // The statically possible set: the receiver's class and every in-image class
  // derived from it can legally supply the slot.
  const possibleCandidates = collect(participating);

  // An exact dynamic class means only that class's own vtables can be
  // dispatched through; derived classes cannot be the receiver.
  const exactCandidates = collect(participating.filter((name) => name === receiverClass));

  let closureProven = false;
  let closureRule = null;
  let reason = null;
  if (dynamicClassProven && closureAuthority && typeof closureAuthority === 'object') {
    const rule = closureAuthority.rule;
    const callSiteId = closureAuthority.callSiteId;
    if (typeof rule === 'string' && CPP_CLOSURE_RULES.includes(rule)
        && callSiteId != null && (typeof callSiteId === 'string' || typeof callSiteId === 'number')) {
      const exactResolved = [...new Set(exactCandidates.filter((c) => !c.unresolved).map((c) => c.address))];
      if (exactCandidates.length > 0 && exactCandidates.every((c) => !c.unresolved) && exactResolved.length === 1) {
        closureProven = true;
        closureRule = rule;
      } else if (!exactCandidates.length) {
        reason = 'exact-class-slot-missing';
      } else {
        reason = exactResolved.length > 1 ? 'exact-class-slot-not-single-target' : 'exact-class-slot-unresolved';
      }
    } else {
      reason = 'closure-authority-invalid';
    }
  } else if (dynamicClassProven) {
    reason = 'closure-authority-required';
  }

  // A proven closure NARROWS the candidate set: a call site that must dispatch
  // through one exact class's vtable cannot reach a derived override. Without
  // closure the full possible set is the answer.
  const candidates = closureProven ? exactCandidates : possibleCandidates;
  const hasUnresolved = candidates.some((candidate) => candidate.unresolved);

  let completeness = 'complete';
  if (!rttiPresent) { completeness = 'partial'; reason = reason || 'rtti-absent-derived-classes-unknown'; }
  if (hasUnresolved) { completeness = 'partial'; reason = reason || 'slot-target-unresolved'; }
  if (!candidates.length) { completeness = 'unknown'; reason = reason || 'no-slot-evidence'; }

  return buildTargetSet({
    receiverClass,
    slotIndex,
    candidates,
    possibleCandidates,
    derivedClasses: derived,
    closureProven,
    closureRule,
    completeness,
    rttiPresent,
    reason,
  });
}

/**
 * The single record shape for a call-site target set.
 *
 * Address lists are always derived from the candidate lists here rather than
 * passed in twice, so an empty set and a populated set cannot drift apart.
 */
function buildTargetSet({
  receiverClass,
  slotIndex,
  candidates,
  possibleCandidates,
  derivedClasses,
  closureProven,
  closureRule,
  completeness,
  rttiPresent,
  reason,
}) {
  const addresses = (list) => [...new Set(list.filter((candidate) => !candidate.unresolved).map((candidate) => candidate.address))]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const report = {
    schema: CPP_VIRTUAL_TARGET_SET_SCHEMA,
    receiverClass,
    slotIndex,
    scope: 'call-site',
    candidates: Object.freeze([...candidates]),
    candidateAddresses: Object.freeze(addresses(candidates)),
    possibleCandidates: Object.freeze([...possibleCandidates]),
    possibleAddresses: Object.freeze(addresses(possibleCandidates)),
    derivedClasses: Object.freeze([...derivedClasses]),
    closureProven,
    closureRule,
    completeness,
    rttiPresent,
    reason,
  };
  report.digest = stableDigest({
    schema: report.schema,
    receiverClass,
    slotIndex,
    candidates: report.candidates.map((c) => ({ address: c.address, viaClass: c.viaClass, unresolved: c.unresolved })),
    closureProven,
    completeness,
  });
  return deepFreeze(report);
}

/**
 * Projects a resolved target set into the canonical `CppVirtualSlotEvidence`
 * consumed by the decompiler path.
 *
 * The candidate set is preserved either way; `exactTargetKnown` only becomes
 * true through `createCppVirtualSlotEvidence`'s own closure rule.
 */
export function virtualSlotEvidenceFor({
  targetSet = null,
  callSiteId = null,
  callSiteAddress = null,
  receiverValueId = null,
  vptrValueId = null,
  pointerBytes = 8,
  reason = null,
} = {}) {
  if (!targetSet) throw new TypeError('cpp-virtual-slot-target-set-required');
  const slotByteOffset = Number(targetSet.slotIndex) * pointerBytes;
  return createCppVirtualSlotEvidence({
    callSiteId,
    callSiteAddress,
    receiverValueId,
    vptrValueId,
    slotIndex: targetSet.slotIndex,
    slotByteOffset,
    pointerBytes,
    virtualSlotKnown: true,
    closureProven: targetSet.closureProven === true,
    candidateTargetIds: (targetSet.candidates || [])
      .filter((candidate) => !candidate.unresolved && candidate.address != null)
      .map((candidate) => candidate.address.toString()),
    exactTargetAddress: targetSet.closureProven
      ? (targetSet.candidateAddresses?.[0] ?? null)
      : null,
    reason: reason ?? targetSet.reason ?? 'call-site-scoped-target-set',
  });
}

