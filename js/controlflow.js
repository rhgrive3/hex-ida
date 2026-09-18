/*
 * Graph-theoretic control-flow analysis shared by the semantic model,
 * CFG viewer and decompiler.  Address order is deliberately irrelevant:
 * optimized binaries routinely place cleanup/cold blocks before their callers.
 */

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

function reachableFrom(succ, entry) {
  const out = new Set();
  if (!validNodeIndex(entry, succ.length)) return out;
  const stack = [entry];
  while (stack.length) {
    const i = stack.pop();
    if (out.has(i)) continue;
    out.add(i);
    for (const j of succ[i]) if (!out.has(j)) stack.push(j);
  }
  return out;
}

function reversePostOrder(succ, entry, allowed = null) {
  if (!validNodeIndex(entry, succ.length) || (allowed && !allowed.has(entry))) return [];
  const seen = new Set([entry]);
  const post = [];
  const stack = [{ node: entry, next: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const xs = succ[frame.node] || [];
    if (frame.next < xs.length) {
      const next = xs[frame.next++];
      if ((allowed && !allowed.has(next)) || seen.has(next)) continue;
      seen.add(next);
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
function immediateDominatorsOf(succ, pred, reachable, entry) {
  const idom = new Array(succ.length).fill(-1);
  const rpo = reversePostOrder(succ, entry, reachable);
  if (!rpo.length) return { idom, rpo };
  const rank = new Array(succ.length).fill(-1);
  rpo.forEach((node, i) => { rank[node] = i; });
  idom[entry] = entry;
  const intersect = (a, b) => {
    let guard = succ.length * 2 + 4;
    while (a !== b && guard-- > 0) {
      while (rank[a] > rank[b]) a = idom[a];
      while (rank[b] > rank[a]) b = idom[b];
      if (a < 0 || b < 0) return -1;
    }
    return a === b ? a : -1;
  };
  let changed = true;
  for (let round = 0; changed && round < succ.length * 2 + 4; round++) {
    changed = false;
    for (let ri = 1; ri < rpo.length; ri++) {
      const node = rpo[ri];
      const ps = (pred[node] || []).filter((p) => reachable.has(p) && idom[p] >= 0);
      if (!ps.length) continue;
      let next = ps[0];
      for (let i = 1; i < ps.length && next >= 0; i++) next = intersect(next, ps[i]);
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
function strongComponents(succ, pred, reachable) {
  const seen = new Set();
  const finish = [];
  for (const root of reachable) {
    if (seen.has(root)) continue;
    seen.add(root);
    const stack = [{ node: root, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const xs = succ[frame.node] || [];
      if (frame.next < xs.length) {
        const next = xs[frame.next++];
        if (!reachable.has(next) || seen.has(next)) continue;
        seen.add(next); stack.push({ node: next, next: 0 });
      } else { finish.push(frame.node); stack.pop(); }
    }
  }
  const components = [];
  const componentOf = new Array(succ.length).fill(-1);
  const assigned = new Set();
  for (let fi = finish.length - 1; fi >= 0; fi--) {
    const root = finish[fi];
    if (assigned.has(root)) continue;
    const comp = [];
    const stack = [root]; assigned.add(root);
    while (stack.length) {
      const node = stack.pop(); comp.push(node); componentOf[node] = components.length;
      for (const next of pred[node] || []) {
        if (!reachable.has(next) || assigned.has(next)) continue;
        assigned.add(next); stack.push(next);
      }
    }
    components.push(comp);
  }
  return { components, componentOf };
}

function postDominatorsOf(succ, pred, reachable, components, componentOf, terminating) {
  const n = succ.length;
  const EXIT = n;
  const internal = (i) => succ[i].filter((j) => reachable.has(j));

  const compOut = components.map(() => new Set());
  const compHasExit = components.map(() => false);
  for (const i of reachable) {
    const ci = componentOf[i];
    const xs = internal(i);
    if (!xs.length || terminating.has(i)) compHasExit[ci] = true;
    for (const j of xs) {
      const cj = componentOf[j];
      if (ci !== cj) compOut[ci].add(cj);
    }
  }
  const nonTerminatingSinks = new Set();
  const bad = new Set();
  const stack = [];
  for (let c = 0; c < components.length; c++) {
    if (compOut[c].size || compHasExit[c]) continue;
    for (const i of components[c]) if (reachable.has(i)) {
      nonTerminatingSinks.add(i);
      bad.add(i);
      stack.push(i);
    }
  }
  while (stack.length) {
    const i = stack.pop();
    for (const p of pred[i]) {
      if (!reachable.has(p) || bad.has(p)) continue;
      bad.add(p); stack.push(p);
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
    const xs = internal(i);
    if (!xs.length || nonTerminatingSinks.has(i) || terminating.has(i)) reverse[EXIT].push(i);
    for (const j of xs) reverse[j].push(i);
  }
  const reversePred = predecessorsOf(reverse);
  const reverseReachable = reachableFrom(reverse, EXIT);
  const { idom: reverseIdom } = immediateDominatorsOf(reverse, reversePred, reverseReachable, EXIT);
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
  const reachable = reachableFrom(succ, canonicalEntry);
  const { idom: immediateDominators } = immediateDominatorsOf(succ, predecessors, reachable, canonicalEntry);
  const dominators = dominanceViews(immediateDominators, reachable);
  const { components, componentOf } = strongComponents(succ, predecessors, reachable);
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

  const post = postDominatorsOf(succ, predecessors, reachable, components, componentOf, terminatingNodes);
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
