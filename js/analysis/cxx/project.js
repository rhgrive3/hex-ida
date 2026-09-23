/*
 * Projection seam between the canonical C++ object evidence producer and the
 * consumers that render C++ structure.
 *
 * `extractCppObjectEvidence` can already answer "is this function a proven
 * non-static member function, and where does its receiver live in the IR", but
 * nothing in the product ever called it: the decompiler consumes
 * `opts.cxxEvidence = { receiver, virtualSlots }` and only tests ever supplied
 * it. This module is the missing producer side.
 *
 * Two properties are deliberate and are what keep this affordable on the hot
 * path:
 *
 *   1. The class/vtable index is built **once per slice**, lazily, and is
 *      asynchronous only because reading bytes may be. Per-function projection
 *      is fully synchronous, so a synchronous analysis entrypoint can consume
 *      it without a second pass over the binary.
 *   2. Until the index is ready, `projectForFunction` returns `null`. It never
 *      falls back to a cheaper guess, so "not ready" and "nothing proven"
 *      render identically to the previous behaviour instead of producing
 *      unproven `this`.
 *
 * Nothing here invents identity. A function with no positive non-static proof
 * gets `null`, class names come only from the producer's RTTI/`_ZTV` evidence,
 * and a virtual slot never carries an exact target unless a call-site-scoped
 * closure authority supplied one (`exactTargetKnown` stays false).
 */

import {
  createCppMemberEvidence,
  extractCppObjectEvidence,
  isCanonicalCppMemberEvidence,
  isCanonicalCppReceiverEvidence,
  isCanonicalCppVirtualSlotEvidence,
} from './object-evidence.js';
import { recoverMemberTypeEvidence } from './member-types.js';
import {
  buildCxxClassEvidence,
  vtableEvidenceFor,
} from './rtti-evidence.js';

export const CPP_EVIDENCE_PROJECTION_SCHEMA = 'cpp-evidence-projection/v2';

/*
 * Cheapest possible prefilter. A slice with no Itanium-mangled symbol cannot
 * have a `_ZTV`/`_ZTI` family, so the producer is never invoked and no memory
 * is read at all. This is the reason a C-only binary pays one character test
 * per symbol instead of a vtable scan.
 */
const MANGLED_PREFIX = /^_?_Z/;

const providers = new WeakSet();

/*
 * Alias closure over the function's own IR, anchored on the *proven* receiver.
 *
 * The receiver evidence says which IR value is `this`; a member access can be
 * reached through that value, a copy of it, a width-preserving cast of it, or a
 * spill/reload through the frame. Nothing else counts, so an unrelated pointer
 * that happens to sit in a member-shaped load is not credited to this class.
 */
function receiverBasePredicate(receiver, ir) {
  const aliasIds = new Set([String(receiver.canonicalValueId)]);
  const spilled = new Map();
  const instructions = ir?.instructions;
  if (!Array.isArray(instructions)) return null;

  // Spill/reload propagation is intentionally fail-closed. A stack slot is
  // accepted as carrying `this` only when every store we can see for that slot
  // writes a value already proven to alias the receiver. Treating "any historic
  // receiver store" as sufficient is unsound because compiler stack slots are
  // routinely reused for unrelated pointers later in the function.
  for (const inst of instructions) {
    if (inst?.op !== 'store') continue;
    const loc = inst.loc ?? null;
    const base = loc?.base ?? inst.addr?.base ?? null;
    if (base?.reg !== 'sp') continue;
    const disp = loc?.disp ?? inst.addr?.disp ?? null;
    if (disp == null) continue;
    const source = inst.args?.[0]?.value ?? inst.args?.[0] ?? null;
    const key = disp.toString();
    const sources = spilled.get(key) ?? new Set();
    sources.add(source?.id == null ? null : String(source.id));
    spilled.set(key, sources);
  }

  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const inst of instructions) {
      const dst = inst?.dst ?? null;
      if (dst?.id == null) continue;
      if (inst.op === 'mov' || inst.op === 'copy' || inst.op === 'un' || inst.op === 'unary') {
        const source = inst.args?.[0]?.value ?? inst.args?.[0] ?? null;
        if (source?.id == null || !aliasIds.has(String(source.id))) continue;
        // A width-changing copy is a different value, not an alias of `this`.
        if (dst.bits != null && source.bits != null && dst.bits !== source.bits) continue;
      } else if (inst.op === 'load') {
        const loc = inst.loc ?? null;
        const base = loc?.base ?? inst.addr?.base ?? null;
        if (base?.reg !== 'sp') continue;
        const disp = loc?.disp ?? inst.addr?.disp ?? null;
        if (disp == null) continue;
        const sources = spilled.get(disp.toString());
        if (!sources?.size || ![...sources].every((id) => id !== null && aliasIds.has(id))) continue;
      } else {
        continue;
      }
      if (aliasIds.has(String(dst.id))) continue;
      aliasIds.add(String(dst.id));
      changed = true;
    }
    if (!changed) break;
  }

  return (value) => value?.id != null && aliasIds.has(String(value.id));
}

/**
 * Projects the proven receiver's member accesses into canonical member evidence.
 *
 * The producer is asked only after `this` is proven, and its answer is
 * canonicalised here: every record is bound to the receiver digest it came from
 * and one label-only claim is impossible (see `createCppMemberEvidence`). A
 * function whose receiver is unproven yields no members at all, so an
 * unclassified offset can never be presented as a typed field.
 */
function projectMembers({ receiver, ir, functionId, snapshotId, maxFields }) {
  if (!isCanonicalCppReceiverEvidence(receiver)) return Object.freeze([]);
  const isReceiverBase = receiverBasePredicate(receiver, ir);
  if (!isReceiverBase) return Object.freeze([]);

  let report;
  try {
    report = recoverMemberTypeEvidence({ ir, isReceiverBase, maxFields });
  } catch {
    return Object.freeze([]);
  }

  const members = [];
  for (const field of report?.fields || []) {
    try {
      members.push(createCppMemberEvidence({
        functionId,
        receiverDigest: receiver.digest,
        snapshotId,
        offsetBytes: field.offset,
        sizeBytes: field.size,
        category: field.category,
        typeLabel: field.typeLabel,
        signedness: field.signedness,
        categoryCandidates: field.categoryCandidates,
        mixedWidths: field.mixedWidths,
        widthOnly: field.widthOnly,
        indexed: field.indexed,
        readCount: field.readCount,
        writeCount: field.writeCount,
        rule: field.rule,
        reason: field.reason,
      }));
    } catch {
      // A record the canonicaliser rejects is dropped, never repaired by hand.
    }
  }
  return Object.freeze(members);
}

/**
 * True only for provider objects issued by `createCxxEvidenceProvider` in this
 * process. Serialized or hand-built look-alikes never pass.
 */
export function isCxxEvidenceProvider(value) {
  return providers.has(value);
}

function hasCxxSymbol(symbols) {
  const names = symbols?.names;
  if (!names || !Number.isSafeInteger(names.length)) return false;
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    if (typeof name === 'string' && MANGLED_PREFIX.test(name)) return true;
  }
  return false;
}

const EMPTY_INDEX = Object.freeze({ empty: true, report: null, vtables: Object.freeze([]) });

/**
 * Indexes the built class evidence by the function addresses its vtable slots
 * point at, so per-function lookup is O(1) instead of scanning every slot of
 * every class.
 */
function indexFromReport(report) {
  const vtables = [];
  const bySlotAddress = new Map();
  let slotCount = 0;

  for (const record of report.classes || []) {
    const vtable = vtableEvidenceFor(record, { pointerBytes: report.pointerBytes });
    if (!vtable) continue;
    const vtableIndex = vtables.length;
    vtables.push(vtable);
    for (const slot of vtable.slots) {
      if (slot.address == null) continue;
      slotCount++;
      const key = slot.address.toString();
      const owners = bySlotAddress.get(key);
      if (owners) {
        if (!owners.includes(vtableIndex)) owners.push(vtableIndex);
      } else {
        bySlotAddress.set(key, [vtableIndex]);
      }
    }
  }

  return Object.freeze({
    empty: false,
    report,
    vtables: Object.freeze(vtables),
    bySlotAddress,
    slotCount,
  });
}

/**
 * Builds one canonical class-evidence index for a slice and projects it onto
 * the per-function evidence shape consumers already accept.
 *
 * @param {object} input
 * @param {object} [input.symbols]            Symbol index (`{ addrs, names }`).
 * @param {Function} input.read               Bounded address reader.
 * @param {number} [input.pointerBytes=8]
 * @param {string} [input.architecture='arm64']
 * @param {string} [input.snapshotId='snapshot_default'] Slice/snapshot identity recorded on the evidence.
 * @param {Function} [input.symbolSizeOf]     Declared symbol size, when the loader retains it.
 * @param {Function} [input.sectionEndOf]     End address of the containing section.
 * @param {object} [input.cache]              Optional `createCxxEvidenceCache()`.
 * @param {string} [input.cacheKey]           Required for `cache` to be used.
 * @param {number} [input.maxMembers=256]     Per-function member record cap.
 */
export function createCxxEvidenceProvider(input = {}) {
  const {
    symbols = null,
    read = null,
    pointerBytes = 8,
    architecture = 'arm64',
    snapshotId = 'snapshot_default',
    symbolSizeOf = null,
    sectionEndOf = null,
    cache = null,
    cacheKey = null,
    maxClasses = 128,
    maxSlots = 64,
    maxReads = 4096,
    maxMembers = 256,
  } = input;

  let index = null;
  let pending = null;
  let builds = 0;
  let attempts = 0;
  let provided = 0;
  let unproven = 0;
  let memberFields = 0;
  let typedMemberFields = 0;
  let lastAttempt = null;

  function producerInput() {
    return {
      symbols,
      read,
      pointerBytes,
      maxClasses,
      maxSlots,
      maxReads,
      symbolSizeOf,
      sectionEndOf,
    };
  }

  const provider = {
    /**
     * Idempotent. Concurrent callers share one build; a resolved index is
     * reused. Returns the internal index (or the empty index).
     */
    async build() {
      if (index) return index;
      if (pending) return pending;
      if (!hasCxxSymbol(symbols)) {
        index = EMPTY_INDEX;
        return index;
      }
      builds++;
      pending = (async () => {
        const report = cache
          ? await cache.get(producerInput(), cacheKey)
          : await buildCxxClassEvidence(producerInput());
        index = report ? indexFromReport(report) : EMPTY_INDEX;
        return index;
      })();
      try {
        return await pending;
      } finally {
        pending = null;
      }
    },

    /**
     * Synchronous per-function projection.
     *
     * Returns `null` — never a partial guess — when the index was not built, the
     * slice has no C++ family, or the function has no positive non-static
     * member proof.
     */
    projectForFunction(request = {}) {
      const {
        functionId = null,
        functionAddress = null,
        functionName = null,
        rawSymbol = null,
        ir = null,
        metadata = {},
      } = request;
      if (index) attempts++;

      // Every exit records the request identity together with its outcome, so a
      // caller never has to infer "which function does this belong to" from the
      // call order. Returning `null` through here is what makes `lastAttempt()`
      // safe to read on a function that proved nothing.
      const bind = (projection) => {
        lastAttempt = Object.freeze({
          functionId: functionId != null ? String(functionId) : null,
          functionAddress: functionAddress ?? null,
          projection,
        });
        return projection;
      };

      if (!index) return bind(null);
      if (index.empty) return bind(null);
      if (functionId == null && functionAddress == null) return bind(null);

      // Only the vtables that actually reference this address can prove
      // membership, so a function is never attributed to an unrelated class.
      const vtables = [];
      if (functionAddress != null) {
        let key;
        try {
          key = BigInt(functionAddress).toString();
        } catch {
          key = null;
        }
        if (key != null) {
          for (const vtableIndex of index.bySlotAddress.get(key) || []) {
            vtables.push(index.vtables[vtableIndex]);
          }
        }
      }

      let report;
      try {
        report = extractCppObjectEvidence({
          functionId: functionId != null ? String(functionId) : `sub_${BigInt(functionAddress).toString(16)}`,
          functionAddress,
          functionName,
          rawSymbol,
          ir,
          vtables,
          metadata,
          snapshotId,
          architecture,
        });
      } catch {
        unproven++;
        return bind(null);
      }

      const receiver = report?.receiver ?? null;
      if (!isCanonicalCppReceiverEvidence(receiver)) {
        unproven++;
        return bind(null);
      }

      const members = projectMembers({
        receiver,
        ir,
        functionId: report.functionId,
        snapshotId,
        maxFields: maxMembers,
      });

      provided++;
      memberFields += members.length;
      for (const member of members) if (member.typeProven) typedMemberFields++;

      const projection = Object.freeze({
        schema: CPP_EVIDENCE_PROJECTION_SCHEMA,
        functionId: report.functionId,
        receiver,
        virtualSlots: report.virtualSlots ?? Object.freeze([]),
        members,
        status: report.status ?? 'verified-cpp-object',
        reason: report.reason ?? null,
      });
      return bind(projection);
    },

    /**
     * The result of the most recent `projectForFunction` call, whatever it was,
     * for diagnostics and measurement.
     *
     * The result is bound to the request it answered — `{ functionId,
     * functionAddress, projection }` with `projection === null` when that request
     * proved nothing — rather than being a slot that keeps the last *successful*
     * projection. That distinction is the whole point: a bare "last projection"
     * makes a caller count calls to tell "this function proved nothing" from "a
     * previous function proved something", and any counter that also contains
     * failed attempts (as `attempts` does) attributes one function's members to
     * the next one.
     */
    lastAttempt() {
      return lastAttempt;
    },

    /** The raw canonical RTTI/vtable report, once built. Useful for reports. */
    classEvidence() {
      return index?.report ?? null;
    },

    stats() {
      return Object.freeze({
        ready: index != null,
        builds,
        attempts,
        provided,
        unproven,
        classes: index?.report?.classes?.length ?? 0,
        vtables: index?.vtables?.length ?? 0,
        slots: index?.slotCount ?? 0,
        reads: index?.report?.reads ?? 0,
        memberFields,
        typedMemberFields,
      });
    },

    clear() {
      index = null;
      pending = null;
      lastAttempt = null;
    },
  };

  const frozen = Object.freeze(provider);
  providers.add(frozen);
  return frozen;
}

/**
 * Fail-closed consumer gate.
 *
 * Accepts any value a caller claims is C++ evidence and returns the exact
 * `{ receiver, virtualSlots, members }` contract, or `null`. Hand-written,
 * serialized or otherwise non-canonical data is dropped; a forged object cannot
 * become `this` — or a typed `this->field_38` — by simply looking like evidence.
 *
 * Member records are kept only when they were issued by the canonical producer
 * *and* they are bound to the receiver that survived this same check, so a valid
 * member set cannot be replayed against a function or receiver it does not
 * belong to.
 */
export function normalizeCxxEvidenceInput(value) {
  if (!value || typeof value !== 'object') return null;

  const receiver = isCanonicalCppReceiverEvidence(value.receiver) ? value.receiver : null;

  const rawSlots = value.virtualSlots;
  const candidates = Array.isArray(rawSlots) ? rawSlots
    : rawSlots instanceof Map ? [...rawSlots.values()] : [];
  const virtualSlots = [];
  for (const slot of candidates) {
    if (!isCanonicalCppVirtualSlotEvidence(slot)) continue;
    if (slot.virtualSlotKnown !== true) continue;
    virtualSlots.push(slot);
  }

  const rawMembers = value.members;
  const memberCandidates = Array.isArray(rawMembers) ? rawMembers
    : rawMembers instanceof Map ? [...rawMembers.values()] : [];
  const members = [];
  for (const member of memberCandidates) {
    if (!isCanonicalCppMemberEvidence(member)) continue;
    if (!receiver || member.receiverDigest !== receiver.digest) continue;
    members.push(member);
  }

  if (!receiver && virtualSlots.length === 0) return null;
  return Object.freeze({
    receiver,
    virtualSlots: Object.freeze(virtualSlots),
    members: Object.freeze(members),
  });
}
