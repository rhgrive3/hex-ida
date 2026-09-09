/**
 * Type graph strongly connected component (SCC) condensation.
 *
 * Implements an iterative, stack-safe Tarjan algorithm to group mutually recursive
 * and self-referential type entities into canonical components in reverse topological
 * order (bottom-up), ensuring deterministic and bounded fixed-point solving.
 */

export const TYPE_SCC_DEFAULT_LIMITS = Object.freeze({
  maxComponents: 4096,
  maxNodes: 10000,
  maxEdges: 50000,
});

/**
 * Condenses the type dependency graph into strongly connected components.
 *
 * @param {Iterable<string>} entityIds
 * @param {(entityId: string) => Iterable<string>} dependenciesOf
 * @param {object} options
 * @returns {{
 *   components: string[][],
 *   recursiveComponents: string[][],
 *   isRecursiveMap: Map<string, boolean>,
 *   sccMembersMap: Map<string, string[]>,
 *   truncated: boolean,
 *   cancelled: boolean
 * }}
 */
function positiveLimit(value, fallback, code) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(code);
  }
  return value;
}

export function condenseTypeGraph(entityIds, dependenciesOf, {
  maxComponents: rawMaxComponents,
  maxNodes: rawMaxNodes,
  maxEdges: rawMaxEdges,
  signal = null,
} = {}) {
  const maxComponents = positiveLimit(rawMaxComponents, TYPE_SCC_DEFAULT_LIMITS.maxComponents, 'type-scc-invalid-component-limit');
  const maxNodes = positiveLimit(rawMaxNodes, TYPE_SCC_DEFAULT_LIMITS.maxNodes, 'type-scc-invalid-node-limit');
  const maxEdges = positiveLimit(rawMaxEdges, TYPE_SCC_DEFAULT_LIMITS.maxEdges, 'type-scc-invalid-edge-limit');
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  const selfEdges = new Set();
  let counter = 0;
  let truncated = false;
  let enumeratedEdges = 0;

  const cancelledResult = () => ({
    components,
    recursiveComponents: [],
    isRecursiveMap: new Map(),
    sccMembersMap: new Map(),
    truncated: true,
    cancelled: true,
  });

  const roots = [...new Set(entityIds)].sort();

  for (const root of roots) {
    if (signal?.aborted) return cancelledResult();
    if (index.has(root)) continue;
    if (index.size >= maxNodes) {
      truncated = true;
      break;
    }

    const work = [{ node: root, successors: null, state: 0 }];
    while (work.length > 0) {
      if (signal?.aborted) return cancelledResult();

      const frame = work[work.length - 1];
      if (frame.successors == null) {
        index.set(frame.node, counter);
        low.set(frame.node, counter);
        counter += 1;
        stack.push(frame.node);
        onStack.add(frame.node);

        // Bounded materialization (#5271): raw dependency discovery consumes
        // one global edge-work budget across the whole graph. Duplicate items
        // still cost work, and cancellation is observed between yielded items.
        let overBudget = false;
        let succs = [];
        try {
          const seen = new Set();
          for (const item of dependenciesOf(frame.node) ?? []) {
            if (signal?.aborted) return cancelledResult();
            enumeratedEdges += 1;
            if (enumeratedEdges > maxEdges) { overBudget = true; break; }
            seen.add(item);
          }
          if (seen.has(frame.node)) selfEdges.add(frame.node);
          succs = [...seen].sort();
        } catch {
          truncated = true;
          succs = [];
        }
        frame.successors = succs;
        if (overBudget) {
          truncated = true;
          break;
        }
      }

      if (frame.state < frame.successors.length) {
        const next = frame.successors[frame.state];
        frame.state += 1;

        if (!index.has(next)) {
          if (index.size >= maxNodes) {
            truncated = true;
            break;
          }
          work.push({ node: next, successors: null, state: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(next)));
        }
        continue;
      }

      if (low.get(frame.node) === index.get(frame.node)) {
        const component = [];
        for (;;) {
          const member = stack.pop();
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        component.sort();
        if (components.length >= maxComponents) {
          truncated = true;
          break;
        }
        components.push(component);
      }

      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1];
        low.set(parent.node, Math.min(low.get(parent.node), low.get(frame.node)));
      }
    }

    if (truncated) break;
  }

  const recursiveComponents = [];
  const isRecursiveMap = new Map();
  const sccMembersMap = new Map();

  for (const component of components) {
    const isMulti = component.length > 1;
    const hasSelfEdge = !isMulti && component.length === 1 && selfEdges.has(component[0]);

    const isRecursive = isMulti || hasSelfEdge;
    if (isRecursive) recursiveComponents.push(component);

    for (const member of component) {
      isRecursiveMap.set(member, isRecursive);
      sccMembersMap.set(member, component);
    }
  }

  return {
    components,
    recursiveComponents,
    isRecursiveMap,
    sccMembersMap,
    truncated,
    cancelled: false,
  };
}
