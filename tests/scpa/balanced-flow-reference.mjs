// Test-only, finite reference semantics over small abstract navigation graphs.
// This exhaustive DFS deliberately imports no production query implementation.
// Each kind is one independent fact: an edge may preserve that fact, never turn
// it into another kind. Untagged edges are neutral. Reaching a callee-local sink
// is permitted with an open stack; returning requires the exact top callsite.
const FACT_KINDS = Object.freeze(['data', 'address', 'control', 'memory', 'exception', 'capture', 'return']);
const MAX_NODES = 64;
const MAX_EDGES = 256;
const MAX_DEPTH = 16;
const MAX_STATES = 50000;

function requireId(value, label) {
  if (typeof value !== 'string' || !value.length) throw new TypeError(`${label} must be a nonempty string`);
  return value;
}

function requireBound(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_DEPTH) {
    throw new RangeError(`${label} must be an integer in [0, ${MAX_DEPTH}]`);
  }
  return value;
}

function requireFacts(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > FACT_KINDS.length ||
      Array.from(value).some(kind => !FACT_KINDS.includes(kind)) || new Set(value).size !== value.length) {
    throw new TypeError(`${label} must contain distinct known flow kinds`);
  }
  return [...value];
}

/**
 * Enumerate every first-sink path within the supplied edge and call bounds.
 *
 * Nodes are nonempty ID strings or {id}; edges are {id, from, to, kind}, with
 * optional flowKinds and boundary: {direction: 'enter'|'return', callSite}.
 * source/target are traversal endpoints even when direction is 'backward'.
 * maxDepth counts traversed edges; maxCallDepth counts unmatched enters (or
 * unmatched returns in backward traversal). A zero-edge path is valid.
 * Explicit flowKinds:null selects mixed navigation, with flowKind:null on
 * paths; arrays continue to enumerate independent homogeneous facts.
 *
 * Results are descriptive graph evidence, never executable-feasibility proof.
 * A fixture that exceeds the independent enumeration budget throws, rather
 * than returning partial evidence that a test could mistake for no path.
 */
export function enumerateBalancedFlowPaths({
  nodes,
  edges,
  source,
  target,
  direction = 'forward',
  maxDepth = 8,
  maxCallDepth = 8,
  flowKinds = FACT_KINDS,
} = {}) {
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > MAX_NODES) {
    throw new RangeError(`nodes must contain 1 to ${MAX_NODES} entries`);
  }
  if (!Array.isArray(edges) || edges.length > MAX_EDGES) {
    throw new RangeError(`edges must contain at most ${MAX_EDGES} entries`);
  }
  if (direction !== 'forward' && direction !== 'backward') throw new TypeError('unknown direction');
  requireBound(maxDepth, 'maxDepth');
  requireBound(maxCallDepth, 'maxCallDepth');
  const facts = flowKinds === null ? [null] : requireFacts(flowKinds, 'flowKinds');
  const nodeIds = Array.from(nodes, (node, i) => requireId(typeof node === 'string' ? node : node?.id, `nodes[${i}].id`));
  const knownNodes = new Set(nodeIds);
  if (knownNodes.size !== nodeIds.length) throw new TypeError('duplicate node ID');
  if (!knownNodes.has(requireId(source, 'source')) || !knownNodes.has(requireId(target, 'target'))) {
    throw new TypeError('source and target must belong to the graph');
  }
  const edgeIds = new Set();
  const graph = Array.from(edges, (edge, i) => {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) throw new TypeError(`edges[${i}] must be an object`);
    const id = requireId(edge.id, `edges[${i}].id`);
    const from = requireId(edge.from, `edges[${i}].from`);
    const to = requireId(edge.to, `edges[${i}].to`);
    requireId(edge.kind, `edges[${i}].kind`);
    if (edgeIds.has(id)) throw new TypeError('duplicate edge ID');
    edgeIds.add(id);
    if (!knownNodes.has(from) || !knownNodes.has(to)) throw new TypeError(`edge ${id} references an unknown node`);
    const tags = edge.flowKinds === undefined ? null : requireFacts(edge.flowKinds, `edge ${id} flowKinds`);
    let boundary = null;
    if (edge.boundary !== undefined) {
      const supplied = edge.boundary;
      if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) ||
          (supplied.direction !== 'enter' && supplied.direction !== 'return')) {
        throw new TypeError(`edge ${id} has an invalid boundary`);
      }
      boundary = {direction: supplied.direction, callSite: requireId(supplied.callSite, `edge ${id} callSite`)};
    }
    return {id, from, to, tags, boundary};
  });

  const paths = [];
  const cuts = [];
  let enumeratedStates = 0;
  // No global visited set or fact merging: different paths and call stacks are
  // independently enumerated, including cycles up to the explicit edge bound.
  for (const flowKind of facts) {
    const pending = [{nodeId: source, nodeIds: [source], edgeIds: [], callStack: []}];
    while (pending.length) {
      const path = pending.pop();
      if (++enumeratedStates > MAX_STATES) throw new RangeError('reference enumeration state budget exceeded');
      if (path.nodeId === target) {
        paths.push({nodeIds: path.nodeIds, edgeIds: path.edgeIds, flowKind, callStack: path.callStack});
        continue;
      }
      // Reversed insertion preserves input edge order in the DFS output.
      for (let i = graph.length - 1; i >= 0; i--) {
        const edge = graph[i];
        const adjacent = direction === 'forward' ? edge.from : edge.to;
        if (adjacent !== path.nodeId || (flowKind !== null && edge.tags && !edge.tags.includes(flowKind))) continue;
        const cut = reason => {
          if (paths.length + cuts.length >= MAX_STATES) throw new RangeError('reference enumeration evidence budget exceeded');
          cuts.push({reason, nodeId: path.nodeId, edgeId: edge.id, flowKind});
        };
        if (path.edgeIds.length === maxDepth) {
          cut('max-depth');
          continue;
        }
        const callStack = [...path.callStack];
        if (edge.boundary) {
          const push = direction === 'forward' ? edge.boundary.direction === 'enter' : edge.boundary.direction === 'return';
          if (push) {
            if (callStack.length === maxCallDepth) {
              cut('max-call-depth');
              continue;
            }
            callStack.push(edge.boundary.callSite);
          } else {
            if (callStack.length === 0 || callStack[callStack.length - 1] !== edge.boundary.callSite) {
              cut('unmatched-return');
              continue;
            }
            callStack.pop();
          }
        }
        const nodeId = direction === 'forward' ? edge.to : edge.from;
        pending.push({nodeId, nodeIds: [...path.nodeIds, nodeId], edgeIds: [...path.edgeIds, edge.id], callStack});
        // Include pending states so high fanout cannot allocate an unbounded
        // worklist before the next popped state checks the traversal budget.
        if (enumeratedStates + pending.length > MAX_STATES) throw new RangeError('reference enumeration state budget exceeded');
      }
    }
  }
  return {paths, cuts, reached: paths.length > 0};
}
