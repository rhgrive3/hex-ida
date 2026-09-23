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
  const successors = array(input.successors ?? [], 'semantic-cfg-invalid-successors')
    .map(normalizeEdge)
    .sort((a, b) => compareCanonicalText(edgeKey(a), edgeKey(b)));
  const keys = successors.map(edgeKey);
  if (new Set(keys).size !== keys.length) fail('semantic-cfg-duplicate-edge');
  return {
    id: nonEmpty(input.id, 'semantic-cfg-block-id-required'),
    successors,
    declaredPredecessors: normalizePredecessors(input.predecessors),
  };
}

const immutableCfgIndexes = new WeakMap();
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

  return deepFreeze({
    contractVersion: SEMANTIC_CFG_CONTRACT_VERSION,
    functionId: nonEmpty(input.functionId, 'semantic-cfg-function-id-required'),
    entryBlockId,
    blocks: normalizedBlocks,
  });
}

export function successorsOf(cfg, blockId) {
  const block = cfgIndex(cfg).get(String(blockId));
  return block ? block.successors.map((edge) => edge.to) : [];
}

export function predecessorsOf(cfg, blockId) {
  const block = cfgIndex(cfg).get(String(blockId));
  return block ? block.predecessors.slice() : [];
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
    const next = byId.get(id).successors.map((edge) => edge.to).slice().sort().reverse();
    for (const target of next) if (!seen.has(target)) stack.push(target);
  }
  return Object.freeze([...seen].sort());
}

export function reachableBlocks(cfg, startBlockId = cfg.entryBlockId, options = {}) {
  assertNotAborted(options);
  return reachableBlocksWithTick(cfg, startBlockId, workCounter(options));
}

function reversePostOrderWithTick(cfg, tick) {
  const byId = cfgIndex(cfg);
  const seen = new Set([cfg.entryBlockId]);
  const post = [];
  const stack = [{
    id: cfg.entryBlockId,
    next: 0,
    successors: byId.get(cfg.entryBlockId).successors.map((edge) => edge.to).slice().sort(),
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
        successors: byId.get(target).successors.map((edge) => edge.to).slice().sort(),
      });
      continue;
    }
    post.push(frame.id);
    stack.pop();
  }
  return post.reverse();
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
  const tick = workCounter(options);
  const byId = cfgIndex(cfg);
  const reachable = new Set(reachableBlocksWithTick(cfg, cfg.entryBlockId, tick));
  const rpo = reversePostOrderWithTick(cfg, tick);
  const entry = cfg.entryBlockId;

  // Immediate dominators are computed directly over the reverse postorder
  // (Cooper-Harvey-Kennedy), not by intersecting a full "all reachable blocks"
  // dominance set per block. That removes the O(blocks^2) set memory the old
  // dataflow held for every block, and the same intersection work is only ever
  // paid along dominator chains instead of over whole block sets. Full dominator
  // sets are then recovered from the idom tree, which is the definition of a
  // dominator, so the published result is unchanged.
  const order = new Map();
  for (let index = 0; index < rpo.length; index += 1) order.set(rpo[index], index);
  const idom = new Map([[entry, entry]]);
  const intersect = (a, b) => {
    while (a !== b) {
      while (order.get(a) > order.get(b)) { tick(); a = idom.get(a); }
      while (order.get(b) > order.get(a)) { tick(); b = idom.get(b); }
    }
    return a;
  };
  let changed = true;
  let rounds = 0;
  while (changed) {
    tick();
    if (++rounds > cfg.blocks.length * 2 + 4) fail('semantic-cfg-dominance-did-not-converge');
    changed = false;
    for (const id of rpo) {
      tick();
      if (id === entry) continue;
      const predecessors = byId.get(id).predecessors.filter((pred) => reachable.has(pred));
      let next = null;
      for (const pred of predecessors) {
        if (!idom.has(pred)) continue;
        next = next == null ? pred : intersect(pred, next);
      }
      if (next == null) continue;
      if (idom.get(id) !== next) { idom.set(id, next); changed = true; }
    }
  }

  // `immediateDominators` keeps its published shape: null at the entry and for
  // every unreachable block. Internally the entry dominator of itself, which is
  // how `intersect` terminates.
  // A dominator precedes its block in reverse postorder, so each block can
  // reuse its immediate dominator's already-sorted chain via binary insertion,
  // avoiding repeated ancestor traversal and O(chain log chain) full sorts.
  const doms = new Map([[entry, [entry]]]);
  for (const id of rpo) {
    if (id === entry) continue;
    const parent = idom.get(id);
    const parentChain = doms.get(parent);
    if (!parentChain) fail('semantic-cfg-invalid-dominator-chain');
    let low = 0;
    let high = parentChain.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (parentChain[mid] < id) low = mid + 1;
      else high = mid;
    }
    const chain = parentChain.slice();
    chain.splice(low, 0, id);
    doms.set(id, chain);
  }

  const idomOut = new Map();
  const dominators = {};
  for (const block of cfg.blocks) {
    const id = block.id;
    if (!reachable.has(id) || id === entry) {
      idomOut.set(id, null);
      dominators[id] = [id];
      continue;
    }
    dominators[id] = doms.get(id);
    idomOut.set(id, idom.get(id));
  }

  const frontier = new Map(cfg.blocks.map((block) => [block.id, new Set()]));
  for (const block of cfg.blocks) {
    if (!reachable.has(block.id)) continue;
    const predecessors = block.predecessors.filter((pred) => reachable.has(pred));
    if (predecessors.length < 2) continue;
    for (const pred of predecessors) {
      let runner = pred;
      let guard = cfg.blocks.length + 2;
      while (runner != null && runner !== idomOut.get(block.id) && guard-- > 0) {
        tick();
        frontier.get(runner).add(block.id);
        runner = idomOut.get(runner);
      }
      if (guard <= 0) fail('semantic-cfg-invalid-dominator-chain');
    }
  }

  const immediateDominators = {};
  const dominanceFrontier = {};
  for (const block of cfg.blocks) {
    immediateDominators[block.id] = idomOut.get(block.id);
    dominanceFrontier[block.id] = [...frontier.get(block.id)].sort();
  }
  return deepFreeze({
    reachable: [...reachable].sort(),
    reversePostOrder: rpo,
    dominators,
    immediateDominators,
    dominanceFrontier,
  });
}
