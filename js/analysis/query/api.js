import { stableDigest } from "../../core/identity/index.js";
import {
  assertAnalysisSnapshot,
  createAnalysisSnapshot,
  AnalysisSnapshotStaleError,
  normalizeAnalysisArtifactVersions,
} from "./snapshot.js";

const COMPLETENESS = new Set(["complete", "partial", "truncated", "unsupported"]);

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
  const currentEpoch = safeNonNegativeInteger(current?.analysisEpoch);
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

// A query result is an immutable consistent view: consumers must never be able
// to reach back into adapter-owned analysis/cache state through the exposed
// value (#5915). The value is detached with a structured clone (typed arrays,
// Maps and Sets included) and the plain-data tree is then deep-frozen. When the
// value cannot be cloned (functions/symbols inside), the original tree is
// deep-frozen in place instead — consumer mutation stays blocked even though
// the adapter then shares the frozen state.
function frozenQueryValue(value) {
  if (value == null || typeof value !== "object") return value;
  let clone;
  try {
    clone = structuredClone(value);
  } catch {
    deepFreezeTree(value);
    return value;
  }
  deepFreezeTree(clone);
  return clone;
}

function deepFreezeTree(node) {
  if (node == null || typeof node !== "object" || Object.isFrozen(node)) return;
  // Buffer views cannot be frozen, and keyed collections freeze only their
  // facade — both are safe because the structured clone already detached them
  // from adapter state (#5915).
  if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer || node instanceof Map || node instanceof Set) return;
  Object.freeze(node);
  if (Array.isArray(node)) {
    for (const item of node) deepFreezeTree(item);
    return;
  }
  for (const key of Object.keys(node)) deepFreezeTree(node[key]);
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
    assertAnalysisSnapshot(snapshot);
    aborted(options);
    const current = await this.adapter.currentIdentity(options);
    aborted(options);
    if (!sameSnapshotIdentity(snapshot, current)) {
      throw new AnalysisSnapshotStaleError("Snapshot is stale before query", {
        snapshotId: snapshot.snapshotId,
        expectedEpoch: snapshot.analysisEpoch,
        currentEpoch: current?.analysisEpoch,
      });
    }
  }

  async #wrapResult(snapshot, executeFn, options) {
    await this.#validateAndCheckStale(snapshot, options);
    const result = await executeFn();
    aborted(options);
    const currentAfter = await this.adapter.currentIdentity(options);
    aborted(options);
    if (!sameSnapshotIdentity(snapshot, currentAfter)) {
      throw new AnalysisSnapshotStaleError("Snapshot became stale during query", {
        snapshotId: snapshot.snapshotId,
        expectedEpoch: snapshot.analysisEpoch,
        currentEpoch: currentAfter?.analysisEpoch,
      });
    }

    const completeness = completenessOf(result);
    const value = frozenQueryValue(result?.value !== undefined ? result.value : result);
    const status = Object.freeze({
      ...(typeof result?.status === "object" && result.status !== null ? frozenQueryValue(result.status) : {}),
      completeness,
    });
    return Object.freeze({
      snapshotId: snapshot.snapshotId,
      analysisEpoch: snapshot.analysisEpoch,
      completeness,
      value,
      status,
      page: result?.page ?? null,
      cost: result?.cost ?? status.cost ?? null,
    });
  }

  async #query(method, snapshot, args, options = {}) {
    return this.#wrapResult(
      snapshot,
      () => typeof this.adapter[method] === "function"
        ? this.adapter[method](snapshot, ...args, options)
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
