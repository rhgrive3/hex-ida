// Interprocedural Dirty-Cone calculator (§9.2).
// Computes the minimal set of functions invalidated by a function signature,
// struct layout, or global variable edit using bounded forward/reverse BFS
// over Callgraph + Data-Xref bipartite graph.
// Pure architecture-neutral core (INV-005).

export const DEFAULT_DIRTY_CONE_OPTIONS = Object.freeze({
  maxUpstreamDepth: 4,
  maxDownstreamDepth: 3,
  maxNodes: 256,
  syncBudget: 32,
  stopAtPolymorphic: true,
});

function addToSetMap(map, key, val) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(val);
}

function removeFromSetMap(map, key, val) {
  const set = map.get(key);
  if (!set) return;
  set.delete(val);
  if (set.size === 0) map.delete(key);
}

export class DirtyConeIndex {
  constructor() {
    /** @type {Map<string|number, Set<string|number>>} caller -> callees */
    this.calleesOf = new Map();
    /** @type {Map<string|number, Set<string|number>>} callee -> callers */
    this.callersOf = new Map();
    /** @type {Map<string|number, Set<string|number>>} structId -> referencing funcIds */
    this.structRefs = new Map();
    /** @type {Map<string|number, Set<string|number>>} globalVaKey -> referencing funcIds */
    this.globalRefs = new Map();
    /** @type {Set<string|number>} functions blocked by POLYMORPHIC barrier */
    this.polymorphicFuncs = new Set();
    /** @type {Map<string|number, number>} funcId -> user pin_mask */
    this.pinMasks = new Map();
  }

  addCallEdge(callerId, calleeId) {
    if (callerId === undefined || calleeId === undefined) return;
    addToSetMap(this.calleesOf, callerId, calleeId);
    addToSetMap(this.callersOf, calleeId, callerId);
  }

  removeCallEdge(callerId, calleeId) {
    removeFromSetMap(this.calleesOf, callerId, calleeId);
    removeFromSetMap(this.callersOf, calleeId, callerId);
  }

  addStructRef(structId, funcId) {
    addToSetMap(this.structRefs, structId, funcId);
  }

  removeStructRef(structId, funcId) {
    removeFromSetMap(this.structRefs, structId, funcId);
  }

  addGlobalRef(globalVa, funcId) {
    addToSetMap(this.globalRefs, String(globalVa), funcId);
  }

  removeGlobalRef(globalVa, funcId) {
    removeFromSetMap(this.globalRefs, String(globalVa), funcId);
  }

  setPolymorphic(funcId, isPoly = true) {
    if (isPoly) this.polymorphicFuncs.add(funcId);
    else this.polymorphicFuncs.delete(funcId);
  }

  setPinMask(funcId, mask) {
    if (!mask) this.pinMasks.delete(funcId);
    else this.pinMasks.set(funcId, mask >>> 0);
  }

  /**
   * Local invalidation when a function boundary (`P`) or manual segment changes.
   * Removes call edges touching any function whose address lies in [startVa, endVa).
   */
  invalidateAddressRange(startVa, endVa, funcRanges) {
    const start = BigInt(startVa);
    const end = BigInt(endVa);
    const affected = [];
    for (const fn of funcRanges || []) {
      const fStart = BigInt(fn.startVa ?? fn.start_va ?? 0);
      const fEnd = BigInt(fn.endVa ?? fn.end_va ?? fStart);
      if (fStart < end && fEnd > start) {
        affected.push(fn.funcId ?? fn.id ?? fStart);
      }
    }
    return affected;
  }

  _resolveSeedFuncs(seed) {
    const out = [];
    if (!seed) return out;
    if (typeof seed === 'string' || typeof seed === 'number' || typeof seed === 'bigint') {
      return [seed];
    }
    if (seed.kind === 'func' && seed.funcId !== undefined) {
      return [seed.funcId];
    }
    if (seed.kind === 'struct' && seed.structId !== undefined) {
      return [...(this.structRefs.get(seed.structId) || [])];
    }
    if (seed.kind === 'global' && seed.va !== undefined) {
      return [...(this.globalRefs.get(String(seed.va)) || [])];
    }
    if (seed.kind === 'multi' && Array.isArray(seed.seeds)) {
      for (const s of seed.seeds) {
        out.push(...this._resolveSeedFuncs(s));
      }
      return out;
    }
    if (Array.isArray(seed)) {
      for (const s of seed) out.push(...this._resolveSeedFuncs(s));
      return out;
    }
    return out;
  }

  /**
   * Compute minimal dirty cone via bounded reverse (upstream callers) + forward (downstream callees) BFS.
   * Respects depth bounds, total node budget, sync/async wave split, and POLYMORPHIC barriers.
   */
  computeDirtyCone(seed, options = {}) {
    const maxUpstreamDepth =
      options.maxUpstreamDepth ?? DEFAULT_DIRTY_CONE_OPTIONS.maxUpstreamDepth;
    const maxDownstreamDepth =
      options.maxDownstreamDepth ?? DEFAULT_DIRTY_CONE_OPTIONS.maxDownstreamDepth;
    const maxNodes = options.maxNodes ?? options.budget ?? DEFAULT_DIRTY_CONE_OPTIONS.maxNodes;
    const syncBudget = options.syncBudget ?? DEFAULT_DIRTY_CONE_OPTIONS.syncBudget;
    const stopAtPolymorphic =
      options.stopAtPolymorphic ?? DEFAULT_DIRTY_CONE_OPTIONS.stopAtPolymorphic;
    const direction = options.direction || 'both'; // 'both' | 'upstream' | 'downstream'

    const seedFuncs = this._resolveSeedFuncs(seed);
    const visited = new Map(); // funcId -> { depth, dir: 'seed'|'upstream'|'downstream' }
    const ordered = [];
    const blockedByPolymorphic = [];
    let truncated = false;

    const upQueue = [];
    const downQueue = [];

    for (const f of seedFuncs) {
      if (visited.has(f)) continue;
      if (ordered.length >= maxNodes) {
        truncated = true;
        break;
      }
      visited.set(f, { depth: 0, dir: 'seed' });
      ordered.push(f);
      if (direction === 'both' || direction === 'upstream') upQueue.push({ id: f, depth: 0 });
      if (direction === 'both' || direction === 'downstream') downQueue.push({ id: f, depth: 0 });
    }

    // Interleaved BFS by hop distance so 1-hop callers & callees land in syncWave first
    let upHead = 0;
    let downHead = 0;

    const expandNeighbors = (nodeId, depth, maxDepth, adjMap, dir, queue) => {
      if (depth >= maxDepth) return;
      const neighbors = adjMap.get(nodeId);
      if (!neighbors) return;
      for (const nxt of neighbors) {
        if (visited.has(nxt)) continue;
        if (stopAtPolymorphic && this.polymorphicFuncs.has(nxt)) {
          blockedByPolymorphic.push(nxt);
          continue;
        }
        if (ordered.length >= maxNodes) {
          truncated = true;
          return;
        }
        visited.set(nxt, { depth: depth + 1, dir });
        ordered.push(nxt);
        queue.push({ id: nxt, depth: depth + 1 });
      }
    };

    while ((upHead < upQueue.length || downHead < downQueue.length) && !truncated) {
      if (upHead < upQueue.length) {
        const cur = upQueue[upHead++];
        expandNeighbors(cur.id, cur.depth, maxUpstreamDepth, this.callersOf, 'upstream', upQueue);
      }
      if (!truncated && downHead < downQueue.length) {
        const cur = downQueue[downHead++];
        expandNeighbors(
          cur.id,
          cur.depth,
          maxDownstreamDepth,
          this.calleesOf,
          'downstream',
          downQueue
        );
      }
    }

    const syncWave = ordered.slice(0, syncBudget);
    const asyncWave = ordered.slice(syncBudget);
    const distances = new Map();
    for (const [id, meta] of visited.entries()) {
      distances.set(id, meta.depth);
    }

    return {
      ordered,
      syncWave,
      asyncWave,
      distances,
      meta: visited,
      truncated,
      blockedByPolymorphic,
      totalCount: ordered.length,
    };
  }
}

export function calculateDirtyCone(index, seed, options = {}) {
  return index.computeDirtyCone(seed, options);
}
