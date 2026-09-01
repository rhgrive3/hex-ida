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
export function condenseTypeGraph(entityIds, dependenciesOf, {
  maxComponents = TYPE_SCC_DEFAULT_LIMITS.maxComponents,
  maxNodes = TYPE_SCC_DEFAULT_LIMITS.maxNodes,
  maxEdges = TYPE_SCC_DEFAULT_LIMITS.maxEdges,
  signal = null,
} = {}) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;
  let truncated = false;
  let traversedEdges = 0;

  const roots = [...new Set(entityIds)].sort();

  for (const root of roots) {
    if (signal?.aborted) {
      return {
        components,
        recursiveComponents: [],
        isRecursiveMap: new Map(),
        sccMembersMap: new Map(),
        truncated: true,
        cancelled: true,
      };
    }
    if (index.has(root)) continue;
    if (index.size >= maxNodes) {
      truncated = true;
      break;
    }

    const work = [{ node: root, successors: null, state: 0 }];
    while (work.length > 0) {
      if (signal?.aborted) {
        return {
          components,
          recursiveComponents: [],
          isRecursiveMap: new Map(),
          sccMembersMap: new Map(),
          truncated: true,
          cancelled: true,
        };
      }

      const frame = work[work.length - 1];
      if (frame.successors == null) {
        index.set(frame.node, counter);
        low.set(frame.node, counter);
        counter += 1;
        stack.push(frame.node);
        onStack.add(frame.node);

        let succs = [];
        try {
          succs = [...new Set(dependenciesOf(frame.node) ?? [])].sort();
        } catch {
          succs = [];
        }
        frame.successors = succs;
      }

      if (frame.state < frame.successors.length) {
        traversedEdges += 1;
        if (traversedEdges > maxEdges) {
          truncated = true;
          break;
        }

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
        components.push(component);
        if (components.length > maxComponents) {
          truncated = true;
          break;
        }
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
    let hasSelfEdge = false;
    if (!isMulti && component.length === 1) {
      const node = component[0];
      let succs = [];
      try {
        succs = [...dependenciesOf(node) ?? []];
      } catch {
        succs = [];
      }
      hasSelfEdge = succs.includes(node);
    }

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
