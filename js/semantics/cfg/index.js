import { deepFreeze, jsonSafe, stableStringify } from '../../core/identity/index.js';

export const SEMANTIC_CFG_CONTRACT_VERSION = '2.0.0';
export const SEMANTIC_CFG_EDGE_KINDS = Object.freeze([
  'fallthrough',
  'branch',
  'conditional-true',
  'conditional-false',
  'switch-case',
  // The implicit CIL `switch` default path and wasm `br_table` default label
  // are real execution paths; without this kind the canonical CFG contract
  // cannot represent them and the managed bridge cannot publish them (#7239).
  'switch-default',
  // CIL `leave`/`leave.s` exits a protected region (or acts as a plain branch
  // outside EH) by transferring to its target with an emptied evaluation
  // stack; the canonical CFG must carry that edge as its own kind (#7277).
  'leave',
  'call',
  'tail-call',
  'return',
  'exception',
  'indirect-candidate',
  'unknown',
]);
export const SEMANTIC_CFG_DEFAULT_BUDGET = Object.freeze({
  maxBlocks: 16384,
  maxEdges: 131072,
  maxWorkItems: 4194304,
});

const EDGE_SET = new Set(SEMANTIC_CFG_EDGE_KINDS);

function fail(code) { throw new TypeError(code); }
function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}
function nonEmpty(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}
function positiveInteger(value, code) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}
function array(value, code) {
  if (!Array.isArray(value)) fail(code);
  return value;
}
function assertAllowedKeys(input, allowed, code) {
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`${code}:${key}`);
}
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('semantic-cfg-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
function limit(options, key) {
  if (options?.budget?.[key] == null) return SEMANTIC_CFG_DEFAULT_BUDGET[key];
  return positiveInteger(options.budget[key], `semantic-cfg-invalid-budget-${key}`);
}
function workCounter(options) {
  let used = 0;
  const maximum = limit(options, 'maxWorkItems');
  return () => {
    assertNotAborted(options);
    if (++used > maximum) fail('semantic-cfg-budget-exceeded-maxWorkItems');
  };
}

function normalizeEdge(input) {
  input = object(input, 'semantic-cfg-invalid-edge');
  assertAllowedKeys(input, new Set(['to', 'kind', 'metadata']), 'semantic-cfg-unexpected-edge-field');
  const to = nonEmpty(input.to, 'semantic-cfg-edge-target-required');
  const kind = nonEmpty(input.kind, 'semantic-cfg-edge-kind-required');
  if (!EDGE_SET.has(kind)) fail('semantic-cfg-invalid-edge-kind');
  const out = { to, kind };
  if (input.metadata != null) out.metadata = jsonSafe(input.metadata);
  return out;
}

function edgeKey(edge) {
  return `${edge.to}\u0000${edge.kind}\u0000${stableStringify(edge.metadata ?? null)}`;
}

// Canonical CFG ordering must be a fixed total order, not a collation: block
// ids and edge keys freeze into the published graph, so a locale-dependent
// comparator would make the same input serialize differently per host (#5763).
function compareCanonicalText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizePredecessors(input) {
  if (input == null) return null;
  const values = array(input, 'semantic-cfg-invalid-predecessors').map((value) => {
    if (typeof value === 'string') return nonEmpty(value, 'semantic-cfg-invalid-predecessor');
    const item = object(value, 'semantic-cfg-invalid-predecessor');
    assertAllowedKeys(item, new Set(['from', 'id']), 'semantic-cfg-unexpected-predecessor-field');
    return nonEmpty(item.from ?? item.id, 'semantic-cfg-invalid-predecessor');
  });
  if (new Set(values).size !== values.length) fail('semantic-cfg-duplicate-predecessor');
  return values.sort();
}

function normalizeBlock(input) {
  input = object(input, 'semantic-cfg-invalid-block');
  assertAllowedKeys(input, new Set(['id', 'successors', 'predecessors']), 'semantic-cfg-unexpected-block-field');
  const keyed = array(input.successors ?? [], 'semantic-cfg-invalid-successors')
    .map((raw) => {
      const edge = normalizeEdge(raw);
      return { edge, key: edgeKey(edge) };
    })
    .sort((a, b) => compareCanonicalText(a.key, b.key));
  for (let i = 1; i < keyed.length; i += 1) {
    if (keyed[i].key === keyed[i - 1].key) fail('semantic-cfg-duplicate-edge');
  }
  const successors = keyed.map((item) => item.edge);
  return {
    id: nonEmpty(input.id, 'semantic-cfg-block-id-required'),
    successors,
    declaredPredecessors: normalizePredecessors(input.predecessors),
  };
}

const immutableCfgIndexes = new WeakMap();
const canonicalSemanticCfgs = new WeakSet();
const canonicalDominanceCache = new WeakMap();
const canonicalDominanceResults = new WeakSet();
const dominanceTreeIndexCache = new WeakMap();

export function isCanonicalSemanticCfg(cfg) {
  return Boolean(cfg && typeof cfg === 'object' && canonicalSemanticCfgs.has(cfg));
}
function cfgIndex(cfg) {
  // Canonical CFGs are deeply frozen. Reuse their block index across point
  // queries and dominance helpers, but preserve live reads for mutable
  // caller-supplied graphs.
  if (cfg && typeof cfg === 'object') {
    const cached = immutableCfgIndexes.get(cfg);
    if (cached) return cached;
  }
  if (cfg && typeof cfg === 'object' && Object.isFrozen(cfg)
      && Array.isArray(cfg.blocks) && Object.isFrozen(cfg.blocks)) {
    const index = new Map();
    let cacheable = true;
    for (const block of cfg.blocks) {
      if (!block || typeof block !== 'object' || !Object.isFrozen(block)) cacheable = false;
      index.set(block?.id, block);
    }
    if (cacheable) immutableCfgIndexes.set(cfg, index);
    return index;
  }
  return new Map(cfg.blocks.map((block) => [block.id, block]));
}

export function createSemanticCfg(input, options = {}) {
  assertNotAborted(options);
  if (input && typeof input === 'object' && canonicalSemanticCfgs.has(input) && options?.budget == null) {
    return input;
  }
  input = object(input, 'semantic-cfg-invalid-graph');
  assertAllowedKeys(input, new Set(['contractVersion', 'functionId', 'entryBlockId', 'blocks']), 'semantic-cfg-unexpected-graph-field');
  if (input.contractVersion != null
    && (typeof input.contractVersion !== 'string'
      || input.contractVersion !== SEMANTIC_CFG_CONTRACT_VERSION)) {
    fail('semantic-cfg-contract-version-mismatch');
  }

  const rawBlocks = array(input.blocks, 'semantic-cfg-blocks-required');
  if (rawBlocks.length > limit(options, 'maxBlocks')) fail('semantic-cfg-budget-exceeded-maxBlocks');
  const blocks = rawBlocks.map(normalizeBlock).sort((a, b) => compareCanonicalText(a.id, b.id));
  const blockById = new Map();
  for (const block of blocks) {
    assertNotAborted(options);
    if (blockById.has(block.id)) fail('semantic-cfg-duplicate-block-id');
    blockById.set(block.id, block);
  }

  const entryBlockId = nonEmpty(input.entryBlockId, 'semantic-cfg-entry-block-required');
  if (!blockById.has(entryBlockId)) fail('semantic-cfg-invalid-entry-block');
  let edgeCount = 0;
  const predecessorSets = new Map(blocks.map((block) => [block.id, new Set()]));
  for (const block of blocks) {
    for (const edge of block.successors) {
      if (++edgeCount > limit(options, 'maxEdges')) fail('semantic-cfg-budget-exceeded-maxEdges');
      if (!blockById.has(edge.to)) fail('semantic-cfg-invalid-successor');
      predecessorSets.get(edge.to).add(block.id);
    }
  }

  const normalizedBlocks = blocks.map((block) => {
    const predecessors = [...predecessorSets.get(block.id)].sort();
    if (block.declaredPredecessors != null
      && stableStringify(block.declaredPredecessors) !== stableStringify(predecessors)) {
      fail('semantic-cfg-predecessor-mismatch');
    }
    return deepFreeze({ id: block.id, predecessors, successors: block.successors });
  });

  const published = deepFreeze({
    contractVersion: SEMANTIC_CFG_CONTRACT_VERSION,
    functionId: nonEmpty(input.functionId, 'semantic-cfg-function-id-required'),
    entryBlockId,
    blocks: normalizedBlocks,
  });
  canonicalSemanticCfgs.add(published);
  return published;
}

export function successorsOf(cfg, blockId) {
  const block = cfgIndex(cfg).get(String(blockId));
  return block ? block.successors.map((edge) => edge.to) : [];
}

export function predecessorsOf(cfg, blockId) {
  const block = cfgIndex(cfg).get(String(blockId));
  return block ? block.predecessors.slice() : [];
}

function sortedSuccessorTargets(block) {
  const succs = block.successors;
  const len = succs.length;
  if (len === 0) return [];
  if (len === 1) return [succs[0].to];
  const targets = new Array(len);
  let needsSort = false;
  let prev = succs[0].to;
  targets[0] = prev;
  for (let i = 1; i < len; i += 1) {
    const cur = succs[i].to;
    targets[i] = cur;
    if (cur < prev) needsSort = true;
    prev = cur;
  }
  if (needsSort) targets.sort();
  return targets;
}

function reachableBlocksWithTick(cfg, startBlockId, tick) {
  const byId = cfgIndex(cfg);
  const start = String(startBlockId);
  if (!byId.has(start)) fail('semantic-cfg-invalid-reachability-start');
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    tick();
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const next = sortedSuccessorTargets(byId.get(id)).reverse();
    for (let i = 0; i < next.length; i += 1) {
      const target = next[i];
      if (!seen.has(target)) stack.push(target);
    }
  }
  return Object.freeze([...seen].sort());
}

export function reachableBlocks(cfg, startBlockId = cfg.entryBlockId, options = {}) {
  assertNotAborted(options);
  return reachableBlocksWithTick(cfg, startBlockId, workCounter(options));
}

function reachabilityAndReversePostOrderWithTick(cfg, tick) {
  const byId = cfgIndex(cfg);
  const entry = String(cfg.entryBlockId);
  if (!byId.has(entry)) fail('semantic-cfg-invalid-reachability-start');
  const seen = new Set([entry]);
  const post = [];
  const stack = [{
    id: entry,
    next: 0,
    successors: sortedSuccessorTargets(byId.get(entry)),
  }];
  while (stack.length) {
    tick();
    const frame = stack[stack.length - 1];
    if (frame.next < frame.successors.length) {
      const target = frame.successors[frame.next++];
      if (seen.has(target)) continue;
      seen.add(target);
      stack.push({
        id: target,
        next: 0,
        successors: sortedSuccessorTargets(byId.get(target)),
      });
      continue;
    }
    post.push(frame.id);
    stack.pop();
  }
  return { reachable: seen, rpo: post.reverse() };
}

function reversePostOrderWithTick(cfg, tick) {
  return reachabilityAndReversePostOrderWithTick(cfg, tick).rpo;
}

function reversePostOrder(cfg, options = {}) {
  assertNotAborted(options);
  return reversePostOrderWithTick(cfg, workCounter(options));
}

export function deterministicTraversal(cfg, options = {}) {
  const rpo = reversePostOrder(cfg, options);
  const seen = new Set(rpo);
  const unreachable = cfg.blocks.map((block) => block.id).filter((id) => !seen.has(id)).sort();
  return Object.freeze(options.includeUnreachable === false ? rpo : [...rpo, ...unreachable]);
}

export function analyzeSemanticDominance(cfg, options = {}) {
  assertNotAborted(options);
  const maxWork = limit(options, 'maxWorkItems');
  const cacheable = Boolean(cfg && typeof cfg === 'object' && canonicalSemanticCfgs.has(cfg));
  if (cacheable) {
    const cached = canonicalDominanceCache.get(cfg);
    if (cached !== undefined) {
      if (cached.workUsed > maxWork) fail('semantic-cfg-budget-exceeded-maxWorkItems');
      return cached.result;
    }
  }
  let workUsed = 0;
  const tick = () => {
    assertNotAborted(options);
    if (++workUsed > maxWork) fail('semantic-cfg-budget-exceeded-maxWorkItems');
  };
  const byId = cfgIndex(cfg);
  const { reachable, rpo } = reachabilityAndReversePostOrderWithTick(cfg, tick);
  const entry = cfg.entryBlockId;

  // Immediate dominators are computed directly over the reverse postorder
  // (Cooper-Harvey-Kennedy), not by intersecting a full "all reachable blocks"
  // dominance set per block. That removes the O(blocks^2) set memory the old
  // dataflow held for every block, and the same intersection work is only ever
  // paid along dominator chains instead of over whole block sets. Full dominator
  // sets are then recovered from the idom tree, which is the definition of a
  // dominator, so the published result is unchanged.
  const rpoCount = rpo.length;
  const order = new Map();
  for (let index = 0; index < rpoCount; index += 1) {
    tick();
    order.set(rpo[index], index);
  }
  const reachablePredIndices = new Array(rpoCount);
  for (let index = 0; index < rpoCount; index += 1) {
    const preds = byId.get(rpo[index]).predecessors;
    const list = [];
    for (let p = 0; p < preds.length; p += 1) {
      const pIdx = order.get(preds[p]);
      if (pIdx !== undefined) list.push(pIdx);
    }
    reachablePredIndices[index] = list;
  }
  const idomIdx = new Int32Array(rpoCount).fill(-1);
  idomIdx[0] = 0;
  const intersect = (a, b) => {
    while (a !== b) {
      while (a > b) { tick(); a = idomIdx[a]; }
      while (b > a) { tick(); b = idomIdx[b]; }
    }
    return a;
  };
  let changed = true;
  let rounds = 0;
  while (changed) {
    tick();
    if (++rounds > cfg.blocks.length * 2 + 4) fail('semantic-cfg-dominance-did-not-converge');
    changed = false;
    for (let i = 0; i < rpoCount; i += 1) {
      tick();
      if (i === 0) continue;
      const predecessors = reachablePredIndices[i];
      let next = -1;
      for (let p = 0; p < predecessors.length; p += 1) {
        const pred = predecessors[p];
        if (idomIdx[pred] === -1) continue;
        next = next === -1 ? pred : intersect(pred, next);
      }
      if (next === -1) continue;
      if (idomIdx[i] !== next) { idomIdx[i] = next; changed = true; }
    }
  }

  // `immediateDominators` keeps its published shape: null at the entry and for
  // every unreachable block. Internally the entry dominator of itself, which is
  // how `intersect` terminates.
  // A dominator precedes its block in reverse postorder, so each block can
  // reuse its immediate dominator's already-sorted chain via binary insertion,
  // avoiding repeated ancestor traversal and O(chain log chain) full sorts.
  const domChains = new Array(rpoCount);
  domChains[0] = [entry];
  for (let i = 1; i < rpoCount; i += 1) {
    const id = rpo[i];
    const parentIdx = idomIdx[i];
    const parentChain = parentIdx >= 0 ? domChains[parentIdx] : null;
    if (!parentChain) fail('semantic-cfg-invalid-dominator-chain');
    let low = 0;
    let high = parentChain.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (parentChain[mid] < id) low = mid + 1;
      else high = mid;
    }
    const len = parentChain.length;
    const chain = new Array(len + 1);
    for (let k = 0; k < low; k += 1) chain[k] = parentChain[k];
    chain[low] = id;
    for (let k = low; k < len; k += 1) chain[k + 1] = parentChain[k];
    domChains[i] = chain;
  }
  idomIdx[0] = -1;

  const dominators = {};
  const immediateDominators = {};
  for (const block of cfg.blocks) {
    const id = block.id;
    const rIdx = order.get(id);
    if (rIdx === undefined || rIdx === 0) {
      immediateDominators[id] = null;
      dominators[id] = [id];
      continue;
    }
    dominators[id] = domChains[rIdx];
    immediateDominators[id] = rpo[idomIdx[rIdx]];
  }

  const frontierSets = Array.from({ length: rpoCount }, () => new Set());
  for (const block of cfg.blocks) {
    const bIdx = order.get(block.id);
    if (bIdx === undefined) continue;
    const predecessors = reachablePredIndices[bIdx];
    if (predecessors.length === 0 || (predecessors.length < 2 && bIdx !== 0)) continue;
    const targetIdom = idomIdx[bIdx];
    for (let p = 0; p < predecessors.length; p += 1) {
      let runner = predecessors[p];
      let guard = cfg.blocks.length + 2;
      while (runner !== -1 && runner !== targetIdom && guard-- > 0) {
        tick();
        frontierSets[runner].add(block.id);
        runner = idomIdx[runner];
      }
      if (guard <= 0) fail('semantic-cfg-invalid-dominator-chain');
    }
  }

  const dominanceFrontier = {};
  for (const block of cfg.blocks) {
    const bIdx = order.get(block.id);
    dominanceFrontier[block.id] = bIdx === undefined ? [] : [...frontierSets[bIdx]].sort();
  }
  const result = deepFreeze({
    reachable: [...reachable].sort(),
    reversePostOrder: rpo,
    dominators,
    immediateDominators,
    dominanceFrontier,
  });
  canonicalDominanceResults.add(result);
  if (cacheable) canonicalDominanceCache.set(cfg, { result, workUsed });
  return result;
}

export function withCanonicalDominanceFrontier(dominance, dominanceFrontier) {
  const derived = deepFreeze({ ...dominance, dominanceFrontier });
  if (canonicalDominanceResults.has(dominance)) {
    canonicalDominanceResults.add(derived);
    const existing = dominanceTreeIndexCache.get(dominance);
    if (existing) dominanceTreeIndexCache.set(derived, existing);
  }
  return derived;
}

function getCanonicalDominanceTreeIndex(dominance) {
  if (!dominance || typeof dominance !== 'object' || !canonicalDominanceResults.has(dominance)) {
    return null;
  }
  let cached = dominanceTreeIndexCache.get(dominance);
  if (cached) return cached;
  const immediateDominators = dominance.immediateDominators;
  const blockIds = Object.keys(immediateDominators);
  const n = blockIds.length;
  const blockIndexById = new Map();
  for (let i = 0; i < n; i += 1) blockIndexById.set(blockIds[i], i);
  const firstChild = new Int32Array(n).fill(-1);
  const nextSibling = new Int32Array(n).fill(-1);
  const roots = [];
  for (let i = 0; i < n; i += 1) {
    const idom = immediateDominators[blockIds[i]];
    if (idom == null) {
      roots.push(i);
    } else {
      const parentIdx = blockIndexById.get(idom);
      if (parentIdx === undefined) {
        roots.push(i);
      } else {
        nextSibling[i] = firstChild[parentIdx];
        firstChild[parentIdx] = i;
      }
    }
  }
  const tin = new Int32Array(n);
  const tout = new Int32Array(n);
  const stackNode = new Int32Array(n);
  const stackChild = new Int32Array(n);
  let clock = 0;
  for (let r = 0; r < roots.length; r += 1) {
    const root = roots[r];
    tin[root] = ++clock;
    stackNode[0] = root;
    stackChild[0] = firstChild[root];
    let top = 1;
    while (top > 0) {
      const cur = stackNode[top - 1];
      const child = stackChild[top - 1];
      if (child !== -1) {
        stackChild[top - 1] = nextSibling[child];
        tin[child] = ++clock;
        stackNode[top] = child;
        stackChild[top] = firstChild[child];
        top += 1;
      } else {
        tout[cur] = ++clock;
        top -= 1;
      }
    }
  }
  cached = { blockIndexById, tin, tout };
  dominanceTreeIndexCache.set(dominance, cached);
  return cached;
}

export function dominatesBlock(dominance, ancestorId, descendantId) {
  if (!dominance || typeof dominance !== 'object' || ancestorId == null || descendantId == null) {
    return false;
  }
  const index = getCanonicalDominanceTreeIndex(dominance);
  if (index) {
    const aIdx = index.blockIndexById.get(ancestorId);
    const dIdx = index.blockIndexById.get(descendantId);
    if (aIdx === undefined || dIdx === undefined) return false;
    if (aIdx === dIdx) return true;
    return index.tin[aIdx] <= index.tin[dIdx] && index.tin[dIdx] < index.tout[aIdx];
  }
  const doms = dominance.dominators?.[descendantId];
  return Array.isArray(doms) ? doms.includes(ancestorId) : false;
}
