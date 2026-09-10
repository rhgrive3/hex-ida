import { stableDigest } from "../../core/identity/index.js";
import { ANALYSIS_COMPLETENESS } from "../status.js";
import {
  assertAnalysisSnapshot,
  createAnalysisSnapshot,
  AnalysisSnapshotStaleError,
  normalizeAnalysisArtifactVersions,
} from "./snapshot.js";

const COMPLETENESS = new Set(ANALYSIS_COMPLETENESS);
const TYPED_ARRAY_MUTATORS = new Set(["set", "copyWithin", "fill", "reverse", "sort"]);
const TYPED_ARRAY_CALLBACKS = new Set([
  "forEach", "map", "filter", "every", "some", "find", "findIndex", "findLast", "findLastIndex",
]);

function artifactVersionsEqual(left, right) {
  try {
    const normalizedLeft = normalizeAnalysisArtifactVersions(left);
    const normalizedRight = normalizeAnalysisArtifactVersions(right);
    return stableDigest(normalizedLeft) === stableDigest(normalizedRight);
  } catch {
    return false;
  }
}

function safeNonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sameSnapshotIdentity(snapshot, current) {
  const currentRevision = safeNonNegativeInteger(current?.projectRevision === undefined ? 0 : current?.projectRevision);
  const currentEpoch = safeNonNegativeInteger(current?.analysisEpoch === undefined ? 0 : current?.analysisEpoch);
  if (currentRevision == null || currentEpoch == null || typeof current?.binaryId !== "string") return false;
  return current.binaryId === snapshot.binaryId
    && currentRevision === snapshot.projectRevision
    && currentEpoch === snapshot.analysisEpoch
    && artifactVersionsEqual(current?.artifactVersions, snapshot.artifactVersions);
}

function aborted(options) {
  if (!options?.signal?.aborted) return;
  const reason = options.signal.reason;
  // Abort reasons are arbitrary values, including explicit null and falsy values.
  if (reason !== undefined) throw reason;
  const err = new Error("AbortError");
  err.name = "AbortError";
  throw err;
}

function unavailable(method) {
  return {
    value: null,
    status: {
      completeness: "unsupported",
      reason: `analysis-query-adapter-${method}-unavailable`,
    },
  };
}

function readonlyQueryMutation() {
  throw new TypeError("analysis-query-value-readonly");
}

function readonlyArrayBuffer(target, seen) {
  let proxy;
  proxy = new Proxy(target, {
    set: readonlyQueryMutation,
    defineProperty: readonlyQueryMutation,
    deleteProperty: readonlyQueryMutation,
    setPrototypeOf: readonlyQueryMutation,
    get(buffer, prop) {
      if (prop === "constructor") return buffer.constructor;
      if (prop === "valueOf") return () => proxy;
      if (prop === Symbol.iterator) return function* bytes() { yield* new Uint8Array(buffer); };
      if (prop === "resize" || prop === "transfer" || prop === "transferToFixedLength") {
        return readonlyQueryMutation;
      }
      const value = Reflect.get(buffer, prop, buffer);
      return typeof value === "function" ? value.bind(buffer) : value;
    },
  });
  seen.set(target, proxy);
  Object.freeze(target);
  return proxy;
}

function readonlyBufferView(target, buffer) {
  let proxy;
  proxy = new Proxy(target, {
    set: readonlyQueryMutation,
    defineProperty: readonlyQueryMutation,
    deleteProperty: readonlyQueryMutation,
    setPrototypeOf: readonlyQueryMutation,
    get(view, prop) {
      if (prop === "constructor") return view.constructor;
      if (prop === "valueOf") return () => proxy;
      if (prop === "buffer") return buffer;
      if (TYPED_ARRAY_MUTATORS.has(prop)
        || (view instanceof DataView && typeof prop === "string" && prop.startsWith("set"))) {
        return readonlyQueryMutation;
      }
      if (!(view instanceof DataView) && prop === "subarray") {
        return (...args) => readonlyBufferView(view.subarray(...args), buffer);
      }
      if (!(view instanceof DataView) && TYPED_ARRAY_CALLBACKS.has(prop)) {
        return (callback, thisArg) => view[prop]((value, index) => callback.call(thisArg, value, index, proxy));
      }
      if (!(view instanceof DataView) && (prop === "reduce" || prop === "reduceRight")) {
        return (callback, ...args) => view[prop]((acc, value, index) => callback(acc, value, index, proxy), ...args);
      }
      const value = Reflect.get(view, prop, view);
      return typeof value === "function" ? value.bind(view) : value;
    },
  });
  return proxy;
}

function readonlyMap(source, seen) {
  const target = new Map();
  let proxy;
  proxy = new Proxy(target, {
    set: readonlyQueryMutation,
    defineProperty: readonlyQueryMutation,
    deleteProperty: readonlyQueryMutation,
    setPrototypeOf: readonlyQueryMutation,
    get(map, prop) {
      if (prop === "constructor") return map.constructor;
      if (prop === "valueOf") return () => proxy;
      if (prop === "set" || prop === "delete" || prop === "clear") return readonlyQueryMutation;
      if (prop === "forEach") {
        return (callback, thisArg) => map.forEach((value, key) => callback.call(thisArg, value, key, proxy));
      }
      const value = Reflect.get(map, prop, map);
      return typeof value === "function" ? value.bind(map) : value;
    },
  });
  seen.set(source, proxy);
  for (const [key, value] of source) {
    target.set(deepFreezeTree(key, seen), deepFreezeTree(value, seen));
  }
  Object.freeze(target);
  return proxy;
}

function readonlySet(source, seen) {
  const target = new Set();
  let proxy;
  proxy = new Proxy(target, {
    set: readonlyQueryMutation,
    defineProperty: readonlyQueryMutation,
    deleteProperty: readonlyQueryMutation,
    setPrototypeOf: readonlyQueryMutation,
    get(set, prop) {
      if (prop === "constructor") return set.constructor;
      if (prop === "valueOf") return () => proxy;
      if (prop === "add" || prop === "delete" || prop === "clear") return readonlyQueryMutation;
      if (prop === "forEach") {
        return (callback, thisArg) => set.forEach((value) => callback.call(thisArg, value, value, proxy));
      }
      const value = Reflect.get(set, prop, set);
      return typeof value === "function" ? value.bind(set) : value;
    },
  });
  seen.set(source, proxy);
  for (const value of source) target.add(deepFreezeTree(value, seen));
  Object.freeze(target);
  return proxy;
}

function readonlyDate(target, seen) {
  let proxy;
  proxy = new Proxy(target, {
    set: readonlyQueryMutation,
    defineProperty: readonlyQueryMutation,
    deleteProperty: readonlyQueryMutation,
    setPrototypeOf: readonlyQueryMutation,
    get(date, prop) {
      if (prop === "constructor") return date.constructor;
      if (typeof prop === "string" && prop.startsWith("set")) return readonlyQueryMutation;
      const value = Reflect.get(date, prop, date);
      return typeof value === "function" ? value.bind(date) : value;
    },
  });
  seen.set(target, proxy);
  Object.freeze(target);
  return proxy;
}

// A query result is an immutable consistent view: consumers must never be able
// to reach back into adapter-owned analysis/cache state through the exposed
// value (#5915). Values are detached with structuredClone before publication.
// If the adapter returns a non-cloneable value (for example functions/symbols),
// fail closed instead of sharing or freezing the adapter-owned object in place.
function frozenQueryValue(value) {
  if (value == null) return value;
  if (typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") {
      throw new TypeError("analysis-query-value-unclonable");
    }
    return value;
  }

  let clone;
  try {
    clone = structuredClone(value);
  } catch {
    throw new TypeError("analysis-query-value-unclonable");
  }
  return deepFreezeTree(clone);
}

function deepFreezeTree(node, seen = new Map()) {
  if (node == null || typeof node !== "object") return node;
  if (seen.has(node)) return seen.get(node);
  if (typeof SharedArrayBuffer !== "undefined" && node instanceof SharedArrayBuffer) {
    throw new TypeError("analysis-query-value-unclonable");
  }
  if (node instanceof ArrayBuffer) return readonlyArrayBuffer(node, seen);
  if (ArrayBuffer.isView(node)) {
    const buffer = deepFreezeTree(node.buffer, seen);
    const proxy = readonlyBufferView(node, buffer);
    seen.set(node, proxy);
    return proxy;
  }
  if (node instanceof Map) return readonlyMap(node, seen);
  if (node instanceof Set) return readonlySet(node, seen);
  if (node instanceof Date) return readonlyDate(node, seen);

  seen.set(node, node);
  for (const key of Object.keys(node)) node[key] = deepFreezeTree(node[key], seen);
  return Object.freeze(node);
}

function completenessOf(result) {
  if (result?.unsupported === true) return "unsupported";
  if (result?.truncated === true) return "truncated";
  if (result?.partial === true || result?.complete === false) return "partial";

  const raw = result?.status?.completeness ?? result?.completeness;
  if (typeof raw === "string") return COMPLETENESS.has(raw) ? raw : "partial";
  if (raw && typeof raw === "object") {
    if (raw.complete === true) return "complete";
    if (raw.complete === false) return raw.reason === "unsupported" ? "unsupported" : "partial";
  }
  return "partial";
}

function preserveKnownQueryLimitContinuation(result) {
  const page = result?.page;
  const queryLimited = result?.status?.reason === "query-limit"
    || result?.status?.truncationReason === "query-limit";
  if (result?.completeness !== "partial" || !queryLimited || page?.next != null) return result;
  const offset = safeNonNegativeInteger(page?.offset);
  const returned = safeNonNegativeInteger(page?.returned);
  if (offset == null || returned == null || returned === 0) return result;
  const next = offset + returned;
  if (!Number.isSafeInteger(next) || next <= offset) return result;
  return Object.freeze({
    ...result,
    page: Object.freeze({ ...page, next }),
  });
}

function snapshotDescriptorValue(descriptors, key) {
  const descriptor = descriptors[key];
  if (descriptor == null) return undefined;
  if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    throw new TypeError("analysis-snapshot-accessor-not-allowed");
  }
  return descriptor.value;
}

function pinValidatedSnapshot(snapshot) {
  // Acquire caller-owned identity fields once, before validation. This closes
  // the same-turn validation/read seam for getters and Proxies while retaining
  // the existing snapshot schema and artifact-version normalization (#5131).
  if (!snapshot || typeof snapshot !== "object") {
    throw new TypeError("analysis-snapshot-required");
  }
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(snapshot);
  } catch {
    throw new TypeError("analysis-snapshot-descriptor-read-failed");
  }

  const pinned = {
    schemaVersion: snapshotDescriptorValue(descriptors, "schemaVersion"),
    snapshotId: snapshotDescriptorValue(descriptors, "snapshotId"),
    binaryId: snapshotDescriptorValue(descriptors, "binaryId"),
    projectRevision: snapshotDescriptorValue(descriptors, "projectRevision"),
    analysisEpoch: snapshotDescriptorValue(descriptors, "analysisEpoch"),
    artifactVersions: normalizeAnalysisArtifactVersions(
      snapshotDescriptorValue(descriptors, "artifactVersions"),
    ),
  };
  const createdAt = snapshotDescriptorValue(descriptors, "createdAt");
  if (createdAt != null) pinned.createdAt = createdAt;
  assertAnalysisSnapshot(pinned);
  return deepFreezeTree(pinned);
}

export class AnalysisQueryAPI {
  constructor(adapter) {
    if (!adapter || typeof adapter.currentIdentity !== "function") {
      throw new TypeError("analysis-query-adapter-required");
    }
    this.adapter = adapter;
  }

  async snapshot(options = {}) {
    aborted(options);
    const id = await this.adapter.currentIdentity(options);
    aborted(options);
    return createAnalysisSnapshot(id);
  }

  async #validateAndCheckStale(snapshot, options) {
    const pinnedSnapshot = pinValidatedSnapshot(snapshot);
    aborted(options);
    const current = await this.adapter.currentIdentity(options);
    aborted(options);
    if (!sameSnapshotIdentity(pinnedSnapshot, current)) {
      throw new AnalysisSnapshotStaleError("Snapshot is stale before query", {
        snapshotId: pinnedSnapshot.snapshotId,
        expectedEpoch: pinnedSnapshot.analysisEpoch,
        currentEpoch: current?.analysisEpoch,
      });
    }
    return pinnedSnapshot;
  }

  async #wrapResult(snapshot, executeFn, options) {
    const pinnedSnapshot = await this.#validateAndCheckStale(snapshot, options);
    const result = await executeFn(pinnedSnapshot);
    aborted(options);
    const currentAfter = await this.adapter.currentIdentity(options);
    aborted(options);
    if (!sameSnapshotIdentity(pinnedSnapshot, currentAfter)) {
      throw new AnalysisSnapshotStaleError("Snapshot became stale during query", {
        snapshotId: pinnedSnapshot.snapshotId,
        expectedEpoch: pinnedSnapshot.analysisEpoch,
        currentEpoch: currentAfter?.analysisEpoch,
      });
    }

    const completeness = completenessOf(result);
    const rawStatus = result?.status;
    const value = frozenQueryValue(result?.value !== undefined ? result.value : result);
    const status = Object.freeze({
      ...(typeof rawStatus === "object" && rawStatus !== null ? frozenQueryValue(rawStatus) : {}),
      completeness,
    });
    const page = frozenQueryValue(result?.page ?? null);
    const cost = frozenQueryValue(result?.cost ?? rawStatus?.cost ?? null);
    return Object.freeze({
      snapshotId: pinnedSnapshot.snapshotId,
      analysisEpoch: pinnedSnapshot.analysisEpoch,
      completeness,
      value,
      status,
      page,
      cost,
    });
  }

  async #query(method, snapshot, args, options = {}) {
    return this.#wrapResult(
      snapshot,
      (pinnedSnapshot) => typeof this.adapter[method] === "function"
        ? this.adapter[method](pinnedSnapshot, ...args, options)
        : unavailable(method),
      options,
    );
  }

  async binaryInfo(snapshot, options = {}) {
    return this.#query("binaryInfo", snapshot, [], options);
  }

  async functions(snapshot, query = {}, page = {}, options = {}) {
    return this.#query("functions", snapshot, [query, page], options);
  }

  async function(snapshot, functionId, options = {}) {
    return this.#query("functionById", snapshot, [functionId], options);
  }

  async instructions(snapshot, range, page = {}, options = {}) {
    return this.#query("instructions", snapshot, [range, page], options);
  }

  async semanticIR(snapshot, functionId, options = {}) {
    return this.#query("semanticIR", snapshot, [functionId], options);
  }

  async cfg(snapshot, functionId, options = {}) {
    return this.#query("cfg", snapshot, [functionId], options);
  }

  async callers(snapshot, functionId, page = {}, options = {}) {
    return this.#query("callers", snapshot, [functionId, page], options);
  }

  async callees(snapshot, functionId, page = {}, options = {}) {
    return this.#query("callees", snapshot, [functionId, page], options);
  }

  async xrefs(snapshot, entityId, page = {}, options = {}) {
    const result = await this.#query("xrefs", snapshot, [entityId, page], options);
    return preserveKnownQueryLimitContinuation(result);
  }

  async types(snapshot, scope, page = {}, options = {}) {
    return this.#query("types", snapshot, [scope, page], options);
  }

  async evidence(snapshot, query = {}, page = {}, options = {}) {
    return this.#query("evidence", snapshot, [query, page], options);
  }

  async decompile(snapshot, functionId, options = {}) {
    return this.#query("decompile", snapshot, [functionId], options);
  }

  async search(snapshot, query, page = {}, options = {}) {
    return this.#query("search", snapshot, [query, page], options);
  }

  async causalPath(snapshot, source, sink, options = {}) {
    return this.#query("causalPath", snapshot, [source, sink], options);
  }
}
