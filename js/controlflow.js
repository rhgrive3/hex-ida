/*
 * Graph-theoretic control-flow analysis shared by the semantic model,
 * CFG viewer and decompiler.  Address order is deliberately irrelevant:
 * optimized binaries routinely place cleanup/cold blocks before their callers.
 */
import { recordFallback, recordWasmCall } from './core/wasm-telemetry.js';

import * as hexEngineModule from './core/hex-engine-wasm.js';

function normalizeEngineFlag(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isJsEngineForced(options = null) {
  if (options && typeof options === 'object') {
    if (options._forceJs === true || normalizeEngineFlag(options._engine) === 'js') {
      return true;
    }
  }
  if (typeof globalThis === 'object' && globalThis !== null) {
    if (
      normalizeEngineFlag(globalThis.HEX_ENGINE) === 'js'
      || normalizeEngineFlag(globalThis.__HEX_ENGINE_MODE__) === 'js'
    ) {
      return true;
    }
  }
  if (typeof process === 'object' && process !== null && process.env) {
    if (normalizeEngineFlag(process.env.HEX_ENGINE) === 'js') {
      return true;
    }
  }
  return false;
}

/* Natural-loop materialization is the only part of this analysis whose output is
 * superlinear in its input: a Θ(N)-edge graph whose loops nest Θ(N) deep has
 * Θ(N²) legal loop-membership rows (#8887).  Dominance and post-dominance are
 * compact views over immediate-dominator indexing, and the SCC/back-edge scans are
 * linear, so the resource fence belongs exactly where the retained state is
 * created and must be charged while it is being created.  Callers cannot opt out:
 * a missing budget uses the default, and an over-ceiling budget is rejected rather
 * than honoured, so no direct caller can re-open the unbounded path. */
export const CONTROLFLOW_ANALYSIS_DEFAULT_BUDGET = Object.freeze({
  maxNodes: 65536,
  maxEdges: 262144,
  maxLoopMemberships: 1048576,
  maxLoopWalkSteps: 4194304,
});

export const CONTROLFLOW_ANALYSIS_MAXIMUM_BUDGET = Object.freeze({
  maxNodes: 262144,
  maxEdges: 4194304,
  maxLoopMemberships: 8388608,
  maxLoopWalkSteps: 33554432,
});

export const LOOP_ANALYSIS_SCHEMA = 'controlflow-loop-analysis/v1';

function budgetInteger(value, key) {
  const fallback = CONTROLFLOW_ANALYSIS_DEFAULT_BUDGET[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > CONTROLFLOW_ANALYSIS_MAXIMUM_BUDGET[key]) {
    throw new TypeError(`controlflow-invalid-budget:${key}`);
  }
  return value;
}

function analysisBudget(options) {
  if (options === undefined || options === null) return { ...CONTROLFLOW_ANALYSIS_DEFAULT_BUDGET };
  if (typeof options !== 'object' || Array.isArray(options)) throw new TypeError('controlflow-analysis-options-invalid');
  const requested = options.budget;
  if (requested !== undefined && requested !== null
    && (typeof requested !== 'object' || Array.isArray(requested))) {
    throw new TypeError('controlflow-invalid-budget-shape');
  }
  for (const key of Object.keys(requested || {})) {
    if (!Object.hasOwn(CONTROLFLOW_ANALYSIS_DEFAULT_BUDGET, key)) throw new TypeError(`controlflow-invalid-budget:${key}`);
  }
  return {
    maxNodes: budgetInteger(requested?.maxNodes, 'maxNodes'),
    maxEdges: budgetInteger(requested?.maxEdges, 'maxEdges'),
    maxLoopMemberships: budgetInteger(requested?.maxLoopMemberships, 'maxLoopMemberships'),
    maxLoopWalkSteps: budgetInteger(requested?.maxLoopWalkSteps, 'maxLoopWalkSteps'),
  };
}

function validNodeIndex(value, length) {
  return Number.isInteger(value) && value >= 0 && value < length;
}

function normalizedSuccessors(successors, maxInputEdges = Number.POSITIVE_INFINITY) {
  const n = successors.length;
  const out = new Array(n);
  let inputEdges = 0;
  let edges = 0;
  for (let i = 0; i < n; i++) {
    const xs = successors[i] || [];
    // Count the untrusted row before filtering/deduplicating it.  Otherwise a
    // huge duplicate/invalid successor vector could burn unbounded normalization
    // work while the canonical edge count stays tiny.
    const rowLength = Number.isSafeInteger(xs.length) && xs.length >= 0 ? xs.length : 0;
    if (rowLength > maxInputEdges - inputEdges) throw new RangeError('controlflow-graph-edge-budget');
    inputEdges += rowLength;
    const row = Array.from(new Set(xs.filter((x) => validNodeIndex(x, n))));
    out[i] = row;
    edges += row.length;
  }
  return { successors: out, edges, inputEdges };
}

function normalizedTerminatingNodes(terminating, length) {
  if (terminating == null) return new Set();
  if (typeof terminating[Symbol.iterator] !== 'function') throw new TypeError('controlflow-terminating-nodes-invalid');
  const out = new Set();
  for (const i of terminating) if (validNodeIndex(i, length)) out.add(i);
  return out;
}

function predecessorsOf(succ) {
  const pred = succ.map(() => []);
  for (let i = 0; i < succ.length; i++) for (const j of succ[i]) pred[j].push(i);
  return pred;
}

function maskFromReachable(reachable, length) {
  const mask = new Uint8Array(length);
  for (const i of reachable) if (i >= 0 && i < length) mask[i] = 1;
  return mask;
}

function reachableFrom(succ, entry) {
  const out = new Set();
  if (!validNodeIndex(entry, succ.length)) return out;
  const seen = new Uint8Array(succ.length);
  const stack = [entry];
  while (stack.length) {
    const i = stack.pop();
    if (seen[i]) continue;
    seen[i] = 1;
    out.add(i);
    const xs = succ[i];
    for (let k = 0; k < xs.length; k++) {
      const j = xs[k];
      if (!seen[j]) stack.push(j);
    }
  }
  return out;
}

function reversePostOrder(succ, entry, allowedMask = null) {
  const n = succ.length;
  if (!validNodeIndex(entry, n) || (allowedMask && !allowedMask[entry])) return [];
  const seen = new Uint8Array(n);
  seen[entry] = 1;
  const post = [];
  const stack = [{ node: entry, next: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const xs = succ[frame.node] || [];
    if (frame.next < xs.length) {
      const next = xs[frame.next++];
      if ((allowedMask && !allowedMask[next]) || seen[next]) continue;
      seen[next] = 1;
      stack.push({ node: next, next: 0 });
      continue;
    }
    post.push(frame.node);
    stack.pop();
  }
  post.reverse();
  return post;
}

/* Cooper-Harvey-Kennedy immediate dominators: O(N) memory, no Set-per-node. */
function immediateDominatorsOf(succ, pred, reachableMask, entry) {
  const n = succ.length;
  const idom = new Array(n).fill(-1);
  const rpo = reversePostOrder(succ, entry, reachableMask);
  if (!rpo.length) return { idom, rpo };
  const rank = new Int32Array(n).fill(-1);
  for (let i = 0; i < rpo.length; i++) rank[rpo[i]] = i;
  idom[entry] = entry;
  const intersect = (a, b) => {
    let guard = n * 2 + 4;
    while (a !== b && guard-- > 0) {
      while (rank[a] > rank[b]) a = idom[a];
      while (rank[b] > rank[a]) b = idom[b];
      if (a < 0 || b < 0) return -1;
    }
    return a === b ? a : -1;
  };
  let changed = true;
  for (let round = 0; changed && round < n * 2 + 4; round++) {
    changed = false;
    for (let ri = 1; ri < rpo.length; ri++) {
      const node = rpo[ri];
      const ps = pred[node];
      if (!ps || ps.length === 0) continue;
      let next = -1;
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        if (!reachableMask[p] || idom[p] < 0) continue;
        next = next < 0 ? p : intersect(next, p);
        if (next < 0) break;
      }
      if (next >= 0 && idom[node] !== next) { idom[node] = next; changed = true; }
    }
  }
  idom[entry] = -1;
  return { idom, rpo };
}

function dominanceIndex(idom, reachable) {
  const children = idom.map(() => []);
  const roots = [];
  for (let i = 0; i < idom.length; i++) {
    if (!reachable.has(i)) continue;
    if (idom[i] >= 0) children[idom[i]].push(i); else roots.push(i);
  }
  const tin = new Array(idom.length).fill(-1);
  const tout = new Array(idom.length).fill(-1);
  const depth = new Array(idom.length).fill(0);
  let clock = 0;
  for (const root of roots) {
    const stack = [{ node: root, exit: false }];
    while (stack.length) {
      const frame = stack.pop();
      if (frame.exit) { tout[frame.node] = clock++; continue; }
      tin[frame.node] = clock++;
      stack.push({ node: frame.node, exit: true });
      const kids = children[frame.node];
      for (let i = kids.length - 1; i >= 0; i--) {
        depth[kids[i]] = depth[frame.node] + 1;
        stack.push({ node: kids[i], exit: false });
      }
    }
  }
  return { tin, tout, depth };
}

const issuedDominanceViews = new WeakSet();
class DominanceView {
  constructor(node, idom, reachable, index, excluded = -1) {
    this.node = node; this.idom = idom; this.reachable = reachable; this.index = index; this.excluded = excluded;
    issuedDominanceViews.add(this);
  }
  has(candidate) {
    if (!Number.isInteger(candidate) || candidate < 0 || candidate >= this.idom.length) return false;
    if (!this.reachable.has(this.node)) return candidate === this.node;
    if (!this.reachable.has(candidate) || candidate === this.excluded) return false;
    const { tin, tout } = this.index;
    return tin[candidate] >= 0 && tin[candidate] <= tin[this.node] && tout[this.node] <= tout[candidate];
  }
  get size() {
    if (!this.reachable.has(this.node)) return 1;
    return Math.max(1, this.index.depth[this.node] + 1 - (this.excluded >= 0 ? 1 : 0));
  }
  *[Symbol.iterator]() {
    if (!this.reachable.has(this.node)) { yield this.node; return; }
    let cur = this.node, guard = this.idom.length + 2;
    while (cur >= 0 && guard-- > 0) {
      if (cur !== this.excluded) yield cur;
      cur = this.idom[cur];
    }
  }
}

const dominanceViewMethods = Object.getOwnPropertyDescriptors(DominanceView.prototype);
// Observation only: expose the backing data of this producer's actual view,
// without iterating/recomputing dominance or accepting a shape-compatible has().
export function readDominanceViewInputs(view) {
  if (!issuedDominanceViews.has(view) || Object.getPrototypeOf(view) !== DominanceView.prototype) return null;
  for (const key of Reflect.ownKeys(dominanceViewMethods)) {
    const expected = dominanceViewMethods[key], current = Object.getOwnPropertyDescriptor(DominanceView.prototype, key);
    if (!current || current.value !== expected.value || current.get !== expected.get || current.set !== expected.set) return null;
  }
  const keys = ['node', 'idom', 'reachable', 'index', 'excluded'];
  if (Reflect.ownKeys(view).length !== keys.length) return null;
  const inputs = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(view, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
    inputs[key] = descriptor.value;
  }
  return inputs;
}

function dominanceViews(idom, reachable, excluded = -1) {
  const index = dominanceIndex(idom, reachable);
  return idom.map((_, node) => new DominanceView(node, idom, reachable, index, excluded));
}

/* Iterative Kosaraju SCC. Avoids JS call-stack overflow on giant functions. */
function strongComponents(succ, pred, reachable, reachableMask) {
  const n = succ.length;
  const seen = new Uint8Array(n);
  const finish = [];
  for (const root of reachable) {
    if (seen[root]) continue;
    seen[root] = 1;
    const stack = [{ node: root, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const xs = succ[frame.node] || [];
      if (frame.next < xs.length) {
        const next = xs[frame.next++];
        if (!reachableMask[next] || seen[next]) continue;
        seen[next] = 1; stack.push({ node: next, next: 0 });
      } else { finish.push(frame.node); stack.pop(); }
    }
  }
  const components = [];
  const componentOf = new Array(n).fill(-1);
  const assigned = new Uint8Array(n);
  for (let fi = finish.length - 1; fi >= 0; fi--) {
    const root = finish[fi];
    if (assigned[root]) continue;
    const comp = [];
    const stack = [root]; assigned[root] = 1;
    while (stack.length) {
      const node = stack.pop(); comp.push(node); componentOf[node] = components.length;
      const ps = pred[node];
      if (!ps) continue;
      for (let k = 0; k < ps.length; k++) {
        const next = ps[k];
        if (!reachableMask[next] || assigned[next]) continue;
        assigned[next] = 1; stack.push(next);
      }
    }
    components.push(comp);
  }
  return { components, componentOf };
}

function postDominatorsOf(succ, pred, reachable, reachableMask, components, componentOf, terminating) {
  const n = succ.length;
  const EXIT = n;

  const compHasOut = new Uint8Array(components.length);
  const compHasExit = new Uint8Array(components.length);
  for (const i of reachable) {
    const ci = componentOf[i];
    const xs = succ[i];
    let hasInternal = false;
    for (let k = 0; k < xs.length; k++) {
      const j = xs[k];
      if (!reachableMask[j]) continue;
      hasInternal = true;
      if (ci !== componentOf[j]) compHasOut[ci] = 1;
    }
    if (!hasInternal || terminating.has(i)) compHasExit[ci] = 1;
  }
  const nonTerminatingSinkMask = new Uint8Array(n);
  const badMask = new Uint8Array(n);
  const bad = new Set();
  const stack = [];
  for (let c = 0; c < components.length; c++) {
    if (compHasOut[c] || compHasExit[c]) continue;
    const comp = components[c];
    for (let k = 0; k < comp.length; k++) {
      const i = comp[k];
      if (!reachableMask[i]) continue;
      nonTerminatingSinkMask[i] = 1;
      if (!badMask[i]) {
        badMask[i] = 1;
        bad.add(i);
        stack.push(i);
      }
    }
  }
  while (stack.length) {
    const i = stack.pop();
    const ps = pred[i];
    for (let k = 0; k < ps.length; k++) {
      const p = ps[k];
      if (!reachableMask[p] || badMask[p]) continue;
      badMask[p] = 1;
      bad.add(p);
      stack.push(p);
    }
  }

  // Keep predecessors that can reach both a normal exit and a closed
  // non-terminating SCC in the post-dominator problem.  Every node in such a
  // bottom SCC receives a conservative synthetic edge to EXIT while its real
  // cycle edges remain intact.  This represents every finite prefix of an
  // infinite execution: it preserves common prefixes before the divergence,
  // but cannot invent another SCC member as a mandatory post-dominator.
  const reverse = Array.from({ length: n + 1 }, () => []);
  for (const i of reachable) {
    const xs = succ[i];
    let hasInternal = false;
    for (let k = 0; k < xs.length; k++) {
      const j = xs[k];
      if (!reachableMask[j]) continue;
      hasInternal = true;
      reverse[j].push(i);
    }
    if (!hasInternal || nonTerminatingSinkMask[i] || terminating.has(i)) reverse[EXIT].push(i);
  }
  const reversePred = predecessorsOf(reverse);
  const reverseReachable = reachableFrom(reverse, EXIT);
  const reverseReachableMask = maskFromReachable(reverseReachable, n + 1);
  const { idom: reverseIdom } = immediateDominatorsOf(reverse, reversePred, reverseReachableMask, EXIT);
  const views = dominanceViews(reverseIdom, reverseReachable, EXIT);
  const ipdom = new Array(n).fill(null);
  for (const i of reachable) {
    const d = reverseIdom[i];
    ipdom[i] = d >= 0 && d !== EXIT ? d : null;
  }
  return {
    postDominators: views.slice(0, n),
    immediatePostDominators: ipdom,
    nonTerminatingReachable: bad,
  };
}

function tryAnalyzeGraphWasm(succ, predecessors, edgeCount, canonicalEntry, terminatingNodes, limits, options = null) {
  if (isJsEngineForced(options)) {
    recordFallback('cfg:wasm_disabled');
    return null;
  }
  const ex = hexEngineModule?.getHexEngineExports?.() ?? null;
  if (!ex || typeof ex.cfg_reset !== 'function' || typeof ex.cfg_alloc !== 'function'
    || typeof ex.cfg_analyze !== 'function' || typeof ex.cfg_get_result_ptr !== 'function'
    || typeof ex.hex_loop_reset !== 'function' || typeof ex.hex_loop_alloc !== 'function'
    || typeof ex.hex_loop_analyze !== 'function' || typeof ex.hex_loop_get_ptr !== 'function') {
    recordFallback('cfg:wasm_unavailable');
    return null;
  }

  const n = succ.length;
  const hasTerminating = terminatingNodes.size > 0;
  try {
    // 1. Run CFG + dominator + SCC + post-dominator engine in WASM
    ex.cfg_reset();
    const offPtr = ex.cfg_alloc((n + 1) * 4);
    const dstPtr = edgeCount > 0 ? ex.cfg_alloc(edgeCount * 4) : 0;
    const termPtr = hasTerminating ? ex.cfg_alloc(n) : 0;
    if (!offPtr || (edgeCount > 0 && !dstPtr) || (hasTerminating && !termPtr)) {
      recordFallback('cfg:wasm_error');
      return null;
    }

    {
      const buf = ex.memory.buffer;
      const offView = new Uint32Array(buf, offPtr, n + 1);
      const dstView = edgeCount > 0 ? new Int32Array(buf, dstPtr, edgeCount) : null;
      let cursor = 0;
      for (let i = 0; i < n; i++) {
        offView[i] = cursor;
        const row = succ[i];
        for (let k = 0; k < row.length; k++) {
          dstView[cursor++] = row[k];
        }
      }
      offView[n] = cursor;
      if (hasTerminating) {
        const termView = new Uint8Array(buf, termPtr, n);
        termView.fill(0);
        for (const t of terminatingNodes) termView[t] = 1;
      }
    }

    const cfgRc = ex.cfg_analyze(n, offPtr, dstPtr, canonicalEntry, termPtr);
    if (cfgRc !== 0) {
      recordFallback('cfg:wasm_error');
      return null;
    }

    // Re-acquire memory.buffer after WASM call (ABI.md 3.2)
    const cfgBuf = ex.memory.buffer;
    const reachOrderPtr = ex.cfg_get_result_ptr(13);
    const reachCount = ex.cfg_get_result_ptr(14);
    const idomPtr = ex.cfg_get_result_ptr(1);
    const domTinPtr = ex.cfg_get_result_ptr(2);
    const domToutPtr = ex.cfg_get_result_ptr(3);
    const domDepthPtr = ex.cfg_get_result_ptr(4);
    const compOfPtr = ex.cfg_get_result_ptr(5);
    const numComps = ex.cfg_get_result_ptr(6);
    const pdomIdomPtr = ex.cfg_get_result_ptr(7);
    const pdomTinPtr = ex.cfg_get_result_ptr(8);
    const pdomToutPtr = ex.cfg_get_result_ptr(9);
    const pdomDepthPtr = ex.cfg_get_result_ptr(10);
    const pdomReachMaskPtr = ex.cfg_get_result_ptr(11);
    const nonTermMaskPtr = ex.cfg_get_result_ptr(12);

    const reachable = new Set();
    if (reachCount > 0 && reachOrderPtr) {
      const reachOrder = new Int32Array(cfgBuf, reachOrderPtr, reachCount);
      for (let i = 0; i < reachCount; i++) reachable.add(reachOrder[i]);
    }

    const immediateDominators = new Array(n).fill(-1);
    const domTin = new Array(n).fill(-1);
    const domTout = new Array(n).fill(-1);
    const domDepth = new Array(n).fill(0);
    const componentOf = new Array(n).fill(-1);
    const components = Array.from({ length: numComps }, () => []);
    if (n > 0) {
      const idomView = new Int32Array(cfgBuf, idomPtr, n);
      const tinView = new Int32Array(cfgBuf, domTinPtr, n);
      const toutView = new Int32Array(cfgBuf, domToutPtr, n);
      const depthView = new Int32Array(cfgBuf, domDepthPtr, n);
      const compView = new Int32Array(cfgBuf, compOfPtr, n);
      for (let i = 0; i < n; i++) {
        immediateDominators[i] = idomView[i];
        domTin[i] = tinView[i];
        domTout[i] = toutView[i];
        domDepth[i] = depthView[i];
        const ci = compView[i];
        componentOf[i] = ci;
        if (ci >= 0 && ci < numComps) components[ci].push(i);
      }
    }
    const domIndex = { tin: domTin, tout: domTout, depth: domDepth };
    const dominators = immediateDominators.map((_, node) => new DominanceView(node, immediateDominators, reachable, domIndex, -1));

    const EXIT = n;
    const np1 = n + 1;
    const pdomIdom = new Array(np1).fill(-1);
    const pdomTin = new Array(np1).fill(-1);
    const pdomTout = new Array(np1).fill(-1);
    const pdomDepth = new Array(np1).fill(0);
    const pdomReachable = new Set();
    const nonTerminatingReachable = new Set();
    if (pdomIdomPtr) {
      const pIdomView = new Int32Array(cfgBuf, pdomIdomPtr, np1);
      const pTinView = new Int32Array(cfgBuf, pdomTinPtr, np1);
      const pToutView = new Int32Array(cfgBuf, pdomToutPtr, np1);
      const pDepthView = new Int32Array(cfgBuf, pdomDepthPtr, np1);
      const pReachView = new Uint8Array(cfgBuf, pdomReachMaskPtr, np1);
      for (let i = 0; i < np1; i++) {
        pdomIdom[i] = pIdomView[i];
        pdomTin[i] = pTinView[i];
        pdomTout[i] = pToutView[i];
        pdomDepth[i] = pDepthView[i];
        if (pReachView[i]) pdomReachable.add(i);
      }
    }
    if (n > 0 && nonTermMaskPtr) {
      const ntView = new Uint8Array(cfgBuf, nonTermMaskPtr, n);
      for (let i = 0; i < n; i++) {
        if (ntView[i]) nonTerminatingReachable.add(i);
      }
    }
    const pdomIndex = { tin: pdomTin, tout: pdomTout, depth: pdomDepth };
    const postDominators = new Array(n);
    const immediatePostDominators = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      postDominators[i] = new DominanceView(i, pdomIdom, pdomReachable, pdomIndex, EXIT);
      if (reachable.has(i)) {
        const d = pdomIdom[i];
        immediatePostDominators[i] = d >= 0 && d !== EXIT ? d : null;
      }
    }

    // 2. Run natural-loop analyzer in WASM
    ex.hex_loop_reset();
    const lOffPtr = ex.hex_loop_alloc((n + 1) * 4);
    const lDstPtr = edgeCount > 0 ? ex.hex_loop_alloc(edgeCount * 4) : 0;
    const lTermPtr = hasTerminating ? ex.hex_loop_alloc(n) : 0;
    if (!lOffPtr || (edgeCount > 0 && !lDstPtr) || (hasTerminating && !lTermPtr)) {
      recordFallback('cfg:wasm_error');
      return null;
    }

    {
      const buf = ex.memory.buffer;
      const offView = new Uint32Array(buf, lOffPtr, n + 1);
      const dstView = edgeCount > 0 ? new Int32Array(buf, lDstPtr, edgeCount) : null;
      let cursor = 0;
      for (let i = 0; i < n; i++) {
        offView[i] = cursor;
        const row = succ[i];
        for (let k = 0; k < row.length; k++) {
          dstView[cursor++] = row[k];
        }
      }
      offView[n] = cursor;
      if (hasTerminating) {
        const termView = new Uint8Array(buf, lTermPtr, n);
        termView.fill(0);
        for (const t of terminatingNodes) termView[t] = 1;
      }
    }

    const loopRc = ex.hex_loop_analyze(
      n,
      lOffPtr,
      lDstPtr,
      canonicalEntry,
      lTermPtr,
      limits.maxLoopMemberships,
      limits.maxLoopWalkSteps,
    );
    if (loopRc !== 0) {
      recordFallback('cfg:wasm_error');
      return null;
    }

    const loopBuf = ex.memory.buffer;
    const numBackEdges = ex.hex_loop_get_ptr(0);
    const beFromPtr = ex.hex_loop_get_ptr(1);
    const beToPtr = ex.hex_loop_get_ptr(2);
    const numLoops = ex.hex_loop_get_ptr(3);
    const headerPtr = ex.hex_loop_get_ptr(4);
    const latchOffPtr = ex.hex_loop_get_ptr(7);
    const latchNodesPtr = ex.hex_loop_get_ptr(8);
    const bodyOffPtr = ex.hex_loop_get_ptr(9);
    const bodyNodesPtr = ex.hex_loop_get_ptr(10);
    const exitOffPtr = ex.hex_loop_get_ptr(11);
    const exitNodesPtr = ex.hex_loop_get_ptr(12);
    const completeFlag = ex.hex_loop_get_ptr(16) !== 0;
    const stopCode = ex.hex_loop_get_ptr(17);
    const retainedMemberships = ex.hex_loop_get_ptr(18);
    const walkSteps = ex.hex_loop_get_ptr(19);

    const backEdges = new Array(numBackEdges);
    if (numBackEdges > 0) {
      const fromView = new Int32Array(loopBuf, beFromPtr, numBackEdges);
      const toView = new Int32Array(loopBuf, beToPtr, numBackEdges);
      for (let i = 0; i < numBackEdges; i++) {
        backEdges[i] = { from: fromView[i], to: toView[i] };
      }
    }

    const loopByHeader = new Map();
    const loops = [];
    if (completeFlag && numLoops > 0) {
      const headers = new Int32Array(loopBuf, headerPtr, numLoops);
      const latchOff = new Uint32Array(loopBuf, latchOffPtr, numLoops + 1);
      const bodyOff = new Uint32Array(loopBuf, bodyOffPtr, numLoops + 1);
      const exitOff = new Uint32Array(loopBuf, exitOffPtr, numLoops + 1);
      const totalLatches = latchOff[numLoops];
      const totalBody = bodyOff[numLoops];
      const totalExits = exitOff[numLoops];
      const latchNodes = totalLatches > 0 ? new Int32Array(loopBuf, latchNodesPtr, totalLatches) : null;
      const bodyNodes = totalBody > 0 ? new Int32Array(loopBuf, bodyNodesPtr, totalBody) : null;
      const exitNodes = totalExits > 0 ? new Int32Array(loopBuf, exitNodesPtr, totalExits) : null;

      for (let i = 0; i < numLoops; i++) {
        const header = headers[i];
        const latches = new Set();
        for (let k = latchOff[i]; k < latchOff[i + 1]; k++) latches.add(latchNodes[k]);
        const nodes = new Set();
        for (let k = bodyOff[i]; k < bodyOff[i + 1]; k++) nodes.add(bodyNodes[k]);
        const exits = new Set();
        for (let k = exitOff[i]; k < exitOff[i + 1]; k++) exits.add(exitNodes[k]);
        const loop = { header, latches, nodes, exits };
        loopByHeader.set(header, loop);
        loops.push(loop);
      }
    }

    const loopStopReason = stopCode === 1
      ? 'loop-walk-budget'
      : stopCode === 2
        ? 'loop-membership-budget'
        : null;

    recordWasmCall('cfg');
    recordWasmCall('loops');

    return {
      successors: succ,
      predecessors,
      reachable,
      dominators,
      immediateDominators,
      components,
      componentOf,
      backEdges,
      loops,
      loopByHeader,
      loopAnalysis: Object.freeze({
        schema: LOOP_ANALYSIS_SCHEMA,
        complete: completeFlag,
        stopReason: loopStopReason,
        loops: loops.length,
        retainedMemberships,
        walkSteps,
        nodes: n,
        edges: edgeCount,
        budget: Object.freeze({ ...limits }),
      }),
      postDominators,
      immediatePostDominators,
      nonTerminatingReachable,
    };
  } catch {
    recordFallback('cfg:wasm_error');
    return null;
  }
}

/**
 * @param {number[][]} successors internal CFG successor indices
 * @param {number} entry entry node index
 * @param {Iterable<number>} [terminating] nodes with a flow edge leaves the
 *   analyzed region, so the node terminates without reaching an internal sink
 * @param {{budget?: {maxNodes?: number, maxEdges?: number, maxLoopMemberships?: number, maxLoopWalkSteps?: number}}} [options]
 *   resource contract for this analysis. Omitting it uses
 *   `CONTROLFLOW_ANALYSIS_DEFAULT_BUDGET`; every key has a hard ceiling, so a
 *   caller cannot request an unbounded analysis. Node/edge admission is checked
 *   before predecessor/dominator/SCC work and rejects over-budget graphs. Loop
 *   materialization has its own work/resident fence: on exhaustion the returned
 *   graph keeps its exact already-admitted graph facts and publishes
 *   `loopAnalysis.complete === false` with no loop claims at all, which is never
 *   a silently partial loop set.
 */
export function analyzeGraph(successors, entry = 0, terminating = null, options = null) {
  const limits = analysisBudget(options);
  const input = successors || [];
  if (!Array.isArray(input)) throw new TypeError('controlflow-successors-invalid');
  const nodeCount = input.length;
  if (nodeCount > limits.maxNodes) throw new RangeError('controlflow-graph-node-budget');
  const normalized = normalizedSuccessors(input, limits.maxEdges);
  const succ = normalized.successors;
  const edgeCount = normalized.edges;
  const terminatingNodes = normalizedTerminatingNodes(terminating, succ.length);
  const canonicalEntry = validNodeIndex(entry, succ.length) ? entry : -1;
  const predecessors = predecessorsOf(succ);

  const wasmResult = tryAnalyzeGraphWasm(succ, predecessors, edgeCount, canonicalEntry, terminatingNodes, limits, options);
  if (wasmResult !== null) return wasmResult;

  const reachable = reachableFrom(succ, canonicalEntry);
  const reachableMask = maskFromReachable(reachable, succ.length);
  const { idom: immediateDominators } = immediateDominatorsOf(succ, predecessors, reachableMask, canonicalEntry);
  const dominators = dominanceViews(immediateDominators, reachable);
  const { components, componentOf } = strongComponents(succ, predecessors, reachable, reachableMask);
  const backEdges = [];

  // A natural back-edge is not "an edge to a smaller address".  The target
  // must dominate the source and both ends must be in the same SCC.
  for (const from of reachable) {
    for (const to of succ[from]) {
      if (!reachable.has(to)) continue;
      if (componentOf[from] < 0 || componentOf[from] !== componentOf[to]) continue;
      if (!dominators[from].has(to)) continue;
      backEdges.push({ from, to });
    }
  }

  let loopStopReason = null;

  let retainedMemberships = 0;
  let walkSteps = 0;
  const loopByHeader = new Map();

  for (const edge of backEdges) {
    const header = edge.to, latch = edge.from;
    let loop = loopByHeader.get(header);
    if (!loop) {
      loop = { header, latches: new Set(), nodes: new Set([header]), exits: new Set() };
      loopByHeader.set(header, loop);
    }
    loop.latches.add(latch);
    const members = new Set([header, latch]);
    const stack = latch === header ? [] : [latch];
    let walkExhausted = false;
    while (stack.length) {
      const x = stack.pop();
      walkSteps += 1;
      if (walkSteps > limits.maxLoopWalkSteps) { walkExhausted = true; break; }
      for (const p of predecessors[x]) {
        if (!reachable.has(p) || members.has(p)) continue;
        // Side-entry nodes make the region irreducible; do not absorb them.
        if (!dominators[p].has(header)) continue;
        if (componentOf[p] !== componentOf[header]) continue;
        members.add(p);
        if (p !== header) stack.push(p);
      }
    }
    if (walkExhausted) { loopStopReason = 'loop-walk-budget'; break; }
    const before = loop.nodes.size;
    for (const x of members) loop.nodes.add(x);
    retainedMemberships += loop.nodes.size - before;
    if (retainedMemberships > limits.maxLoopMemberships) { loopStopReason = 'loop-membership-budget'; break; }
  }
  if (loopStopReason === null) {
    for (const loop of loopByHeader.values()) {
      for (const x of loop.nodes) {
        for (const y of succ[x]) {
          walkSteps += 1;
          if (walkSteps > limits.maxLoopWalkSteps) { loopStopReason = 'loop-walk-budget'; break; }
          if (!loop.nodes.has(y)) loop.exits.add(y);
        }
        if (loopStopReason !== null) break;
      }
      if (loopStopReason !== null) break;
    }
  }
  const loopAnalysisComplete = loopStopReason === null;
  if (!loopAnalysisComplete) {
    // An abandoned materialization must not leave a prefix of exact loops that
    // downstream induction/structuring logic could read as the whole answer.
    loopByHeader.clear();
    retainedMemberships = 0;
  } else {
    retainedMemberships = 0;
    for (const loop of loopByHeader.values()) retainedMemberships += loop.nodes.size;
  }
  const loops = Array.from(loopByHeader.values());

  const post = postDominatorsOf(succ, predecessors, reachable, reachableMask, components, componentOf, terminatingNodes);
  return {
    successors: succ,
    predecessors,
    reachable,
    dominators,
    immediateDominators,
    components,
    componentOf,
    backEdges,
    loops,
    loopByHeader,
    loopAnalysis: Object.freeze({
      schema: LOOP_ANALYSIS_SCHEMA,
      complete: loopAnalysisComplete,
      stopReason: loopStopReason,
      loops: loops.length,
      retainedMemberships,
      walkSteps,
      nodes: nodeCount,
      edges: edgeCount,
      budget: Object.freeze({ ...limits }),
    }),
    postDominators: post.postDominators,
    immediatePostDominators: post.immediatePostDominators,
    nonTerminatingReachable: post.nonTerminatingReachable,
  };
}
