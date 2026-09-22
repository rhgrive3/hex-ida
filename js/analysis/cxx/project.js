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
  extractCppObjectEvidence,
  isCanonicalCppReceiverEvidence,
  isCanonicalCppVirtualSlotEvidence,
} from './object-evidence.js';
import {
  buildCxxClassEvidence,
  vtableEvidenceFor,
} from './rtti-evidence.js';

export const CPP_EVIDENCE_PROJECTION_SCHEMA = 'cpp-evidence-projection/v1';

/*
 * Cheapest possible prefilter. A slice with no Itanium-mangled symbol cannot
 * have a `_ZTV`/`_ZTI` family, so the producer is never invoked and no memory
 * is read at all. This is the reason a C-only binary pays one character test
 * per symbol instead of a vtable scan.
 */
const MANGLED_PREFIX = /^_?_Z/;

const providers = new WeakSet();

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
  } = input;

  let index = null;
  let pending = null;
  let builds = 0;
  let projections = 0;
  let provided = 0;
  let unproven = 0;

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
      if (!index) return null;
      if (index.empty) return null;
      projections++;

      const {
        functionId = null,
        functionAddress = null,
        functionName = null,
        rawSymbol = null,
        ir = null,
        metadata = {},
      } = request;
      if (functionId == null && functionAddress == null) return null;

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
        return null;
      }

      const receiver = report?.receiver ?? null;
      if (!isCanonicalCppReceiverEvidence(receiver)) {
        unproven++;
        return null;
      }

      provided++;
      return Object.freeze({
        schema: CPP_EVIDENCE_PROJECTION_SCHEMA,
        functionId: report.functionId,
        receiver,
        virtualSlots: report.virtualSlots ?? Object.freeze([]),
        status: report.status ?? 'verified-cpp-object',
        reason: report.reason ?? null,
      });
    },

    /** The raw canonical RTTI/vtable report, once built. Useful for reports. */
    classEvidence() {
      return index?.report ?? null;
    },

    stats() {
      return Object.freeze({
        ready: index != null,
        builds,
        projections,
        provided,
        unproven,
        classes: index?.report?.classes?.length ?? 0,
        vtables: index?.vtables?.length ?? 0,
        slots: index?.slotCount ?? 0,
        reads: index?.report?.reads ?? 0,
      });
    },

    clear() {
      index = null;
      pending = null;
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
 * `{ receiver, virtualSlots }` contract, or `null`. Hand-written, serialized or
 * otherwise non-canonical data is dropped; a forged object cannot become
 * `this` by simply looking like evidence.
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

  if (!receiver && virtualSlots.length === 0) return null;
  return Object.freeze({
    receiver,
    virtualSlots: Object.freeze(virtualSlots),
  });
}
