// Intra-procedural backward & forward value slicing over SSA IR (§13.1 / §8.2).
// INV-005: ZERO imports from js/targets/architecture/, js/targets/abi/, or compat/*.

export const MAX_INTRA_SSA_NODES = 512;

export const SLICE_DIRECTION = Object.freeze({
  BACKWARD: 'backward',
  FORWARD: 'forward',
});

/**
 * Normalize SSA graph from either structured `{ definitions, uses, instructions }`
 * or simple `{ nodes: [{ id, op, dst, srcs, insnVa, blockId, role, fieldOff, accessWidth }] }`.
 */
function buildDefUseMaps(ssa) {
  const defByValue = new Map();
  const usesByValue = new Map();
  const nodeById = new Map();

  const rawNodes = Array.isArray(ssa?.nodes)
    ? ssa.nodes
    : Array.isArray(ssa?.instructions)
      ? ssa.instructions
      : [];

  for (let i = 0; i < rawNodes.length; i++) {
    const n = rawNodes[i];
    const id = n.id ?? `n${i}`;
    nodeById.set(id, n);
    if (n.dst !== undefined && n.dst !== null) {
      defByValue.set(String(n.dst), id);
    }
    const srcs = Array.isArray(n.srcs) ? n.srcs : Array.isArray(n.inputs) ? n.inputs : [];
    for (const s of srcs) {
      if (s === undefined || s === null) continue;
      const key = String(s);
      if (!usesByValue.has(key)) usesByValue.set(key, []);
      usesByValue.get(key).push(id);
    }
  }

  // Also index explicit phi nodes if provided separately
  if (Array.isArray(ssa?.phis)) {
    for (let i = 0; i < ssa.phis.length; i++) {
      const phi = ssa.phis[i];
      const id = phi.id ?? `phi${i}`;
      const srcs = Array.isArray(phi.incoming)
        ? phi.incoming.map((inc) => (typeof inc === 'object' ? inc.value : inc))
        : (phi.srcs || []);
      const norm = { ...phi, id, op: 'phi', srcs };
      nodeById.set(id, norm);
      if (phi.dst !== undefined && phi.dst !== null) {
        defByValue.set(String(phi.dst), id);
      }
      for (const s of srcs) {
        if (s === undefined || s === null) continue;
        const key = String(s);
        if (!usesByValue.has(key)) usesByValue.set(key, []);
        usesByValue.get(key).push(id);
      }
    }
  }

  return { defByValue, usesByValue, nodeById };
}

/**
 * Compute an intra-procedural backward or forward SSA value slice with hard node budget.
 */
export function computeIntraSsaSlice(ssa, seedValue, opts = {}) {
  const direction = opts.direction === SLICE_DIRECTION.FORWARD
    ? SLICE_DIRECTION.FORWARD
    : SLICE_DIRECTION.BACKWARD;
  const maxNodes = Math.max(1, Math.min(MAX_INTRA_SSA_NODES, opts.maxNodes ?? MAX_INTRA_SSA_NODES));

  const { defByValue, usesByValue, nodeById } = buildDefUseMaps(ssa);
  const visitedValues = new Set();
  const visitedNodeIds = new Set();
  const sliceNodes = [];
  const edges = [];
  const boundaryInputs = new Set();
  const boundaryOutputs = new Set();
  let truncated = false;

  const seedKey = String(seedValue);
  const queue = [seedKey];
  visitedValues.add(seedKey);

  while (queue.length > 0) {
    if (visitedNodeIds.size >= maxNodes) {
      truncated = true;
      break;
    }
    const valKey = queue.shift();

    if (direction === SLICE_DIRECTION.BACKWARD) {
      const defNodeId = defByValue.get(valKey);
      if (!defNodeId) {
        boundaryInputs.add(valKey);
        continue;
      }
      const node = nodeById.get(defNodeId);
      if (!node) continue;

      if (!visitedNodeIds.has(defNodeId)) {
        visitedNodeIds.add(defNodeId);
        sliceNodes.push({
          id: defNodeId,
          op: node.op ?? 'unknown',
          dst: node.dst ?? null,
          srcs: node.srcs ?? node.inputs ?? [],
          insnVa: node.insnVa ?? null,
          blockId: node.blockId ?? null,
          role: node.role ?? 0,
          fieldOff: node.fieldOff ?? 0,
          accessWidth: node.accessWidth ?? 0,
        });
      }

      // Over-taint cutoff: non-address-taken stack slot or opaque barrier stops backward propagation
      if (node.nonAddressTakenStackSlot === true && opts.blockNonEscapingStack !== false) {
        continue;
      }

      const srcs = Array.isArray(node.srcs) ? node.srcs : Array.isArray(node.inputs) ? node.inputs : [];
      for (const s of srcs) {
        if (s === undefined || s === null) continue;
        const srcKey = String(s);
        edges.push({
          from: srcKey,
          to: valKey,
          nodeId: defNodeId,
          insnVa: node.insnVa ?? null,
          role: node.role ?? 0,
          fieldOff: node.fieldOff ?? 0,
          accessWidth: node.accessWidth ?? 0,
        });
        if (!visitedValues.has(srcKey)) {
          visitedValues.add(srcKey);
          queue.push(srcKey);
        }
      }
    } else {
      // FORWARD slice
      const consumerIds = usesByValue.get(valKey) || [];
      if (consumerIds.length === 0) {
        boundaryOutputs.add(valKey);
        continue;
      }
      for (const cid of consumerIds) {
        if (visitedNodeIds.size >= maxNodes) {
          truncated = true;
          break;
        }
        const node = nodeById.get(cid);
        if (!node) continue;

        if (!visitedNodeIds.has(cid)) {
          visitedNodeIds.add(cid);
          sliceNodes.push({
            id: cid,
            op: node.op ?? 'unknown',
            dst: node.dst ?? null,
            srcs: node.srcs ?? node.inputs ?? [],
            insnVa: node.insnVa ?? null,
            blockId: node.blockId ?? null,
            role: node.role ?? 0,
            fieldOff: node.fieldOff ?? 0,
            accessWidth: node.accessWidth ?? 0,
          });
        }

        const dstKey = node.dst !== undefined && node.dst !== null ? String(node.dst) : null;
        edges.push({
          from: valKey,
          to: dstKey ?? cid,
          nodeId: cid,
          insnVa: node.insnVa ?? null,
          role: node.role ?? 0,
          fieldOff: node.fieldOff ?? 0,
          accessWidth: node.accessWidth ?? 0,
        });

        if (dstKey && !visitedValues.has(dstKey)) {
          visitedValues.add(dstKey);
          queue.push(dstKey);
        }
        if (node.op === 'ret' || node.op === 'call_arg') {
          boundaryOutputs.add(dstKey ?? valKey);
        }
      }
    }
  }

  return {
    direction,
    seedValue: seedKey,
    nodes: sliceNodes,
    edges,
    visitedValues: [...visitedValues],
    boundaryInputs: [...boundaryInputs],
    boundaryOutputs: [...boundaryOutputs],
    truncated,
  };
}
