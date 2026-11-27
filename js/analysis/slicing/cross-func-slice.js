// Cross-function forward & backward value slicing engine (§13.1).
// INV-005: ZERO direct imports from js/targets/architecture/ or js/targets/abi/.

import { computeIntraSsaSlice, SLICE_DIRECTION, MAX_INTRA_SSA_NODES } from '../../semantics/ssa/value-slice.js';

export const CROSS_SLICE_HARD_BUDGET = Object.freeze({
  maxDepth: 8,
  maxVisitedNodes: 256,
  maxEdges: 512,
  maxBranchFactor: 8,
  maxIntraSsaNodes: MAX_INTRA_SSA_NODES,
  timeoutMs: 50,
});

function clampBudget(userBudget = {}) {
  return {
    maxDepth: Math.max(1, Math.min(CROSS_SLICE_HARD_BUDGET.maxDepth, userBudget.maxDepth ?? CROSS_SLICE_HARD_BUDGET.maxDepth)),
    maxVisitedNodes: Math.max(1, Math.min(CROSS_SLICE_HARD_BUDGET.maxVisitedNodes, userBudget.maxVisitedNodes ?? CROSS_SLICE_HARD_BUDGET.maxVisitedNodes)),
    maxEdges: Math.max(1, Math.min(CROSS_SLICE_HARD_BUDGET.maxEdges, userBudget.maxEdges ?? CROSS_SLICE_HARD_BUDGET.maxEdges)),
    maxBranchFactor: Math.max(1, Math.min(CROSS_SLICE_HARD_BUDGET.maxBranchFactor, userBudget.maxBranchFactor ?? CROSS_SLICE_HARD_BUDGET.maxBranchFactor)),
    maxIntraSsaNodes: Math.max(1, Math.min(CROSS_SLICE_HARD_BUDGET.maxIntraSsaNodes, userBudget.maxIntraSsaNodes ?? CROSS_SLICE_HARD_BUDGET.maxIntraSsaNodes)),
    timeoutMs: Math.max(1, Math.min(CROSS_SLICE_HARD_BUDGET.timeoutMs, userBudget.timeoutMs ?? CROSS_SLICE_HARD_BUDGET.timeoutMs)),
  };
}

export function toFuncKey(va) {
  if (typeof va === 'bigint') return `0x${va.toString(16)}`;
  if (typeof va === 'number' && Number.isFinite(va)) return `0x${BigInt(Math.trunc(va)).toString(16)}`;
  if (typeof va === 'string') {
    const trimmed = va.trim();
    if (/^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(trimmed)) {
      return `0x${BigInt(trimmed).toString(16)}`;
    }
    return trimmed.toLowerCase();
  }
  return String(va);
}

export function runCrossFuncSlice(program, seed, opts = {}) {
  const direction = opts.direction === SLICE_DIRECTION.FORWARD
    ? SLICE_DIRECTION.FORWARD
    : SLICE_DIRECTION.BACKWARD;
  const budget = clampBudget(opts.budget);
  const startTime = Date.now();
  const signal = opts.signal || null;
  const intraAdapter = opts.intraSliceAdapter || null;

  const visited = new Set();
  const nodes = [];
  const edges = [];
  const skippedReasons = [];
  let stopReason = 'complete';

  const startFuncKey = toFuncKey(seed.funcVa);
  const startKey = `${startFuncKey}::${seed.port}`;
  visited.add(startKey);

  const queue = [{
    funcVa: seed.funcVa,
    funcKey: startFuncKey,
    port: String(seed.port),
    depth: 0,
  }];

  function pushEdge(edge) {
    if (edges.length >= budget.maxEdges) {
      stopReason = 'edge_budget';
      return false;
    }
    edges.push(edge);
    if (edges.length >= budget.maxEdges) {
      stopReason = 'edge_budget';
    }
    return true;
  }

  while (queue.length > 0) {
    if (signal?.aborted) {
      stopReason = 'aborted';
      break;
    }
    if (Date.now() - startTime > budget.timeoutMs) {
      stopReason = 'timeout';
      break;
    }
    if (nodes.length >= budget.maxVisitedNodes) {
      stopReason = 'node_budget';
      break;
    }
    if (edges.length >= budget.maxEdges) {
      stopReason = 'edge_budget';
      break;
    }

    const cur = queue.shift();
    const fn = typeof program?.getFunction === 'function'
      ? program.getFunction(cur.funcVa)
      : program?.functions?.[cur.funcKey] ?? program?.functions?.[cur.funcVa] ?? null;

    const nodeRecord = {
      id: `${cur.funcKey}::${cur.port}`,
      funcVa: cur.funcKey,
      port: cur.port,
      depth: cur.depth,
      intraEdges: [],
      shortcutUsed: false,
    };

    if (!fn) {
      nodes.push(nodeRecord);
      continue;
    }

    if (cur.port.startsWith('stack_local:') && fn.nonAddressTakenSlots?.has?.(cur.port)) {
      skippedReasons.push({ funcVa: cur.funcKey, port: cur.port, reason: 'non_address_taken_stack_slot' });
      nodes.push(nodeRecord);
      continue;
    }

    let nextPorts = [];
    const summary = fn.summary || {};

    if (direction === SLICE_DIRECTION.FORWARD && summary.regPassMap && summary.regPassMap[cur.port]) {
      nodeRecord.shortcutUsed = true;
      nextPorts = [summary.regPassMap[cur.port]];
    } else if (direction === SLICE_DIRECTION.BACKWARD && cur.port === 'ret' && ((summary.retUsedMask ?? 0) & 0x02)) {
      nodeRecord.shortcutUsed = true;
      nextPorts = [summary.directRetSource || 'arg0'];
    } else if (fn.ssa) {
      const intra = computeIntraSsaSlice(fn.ssa, cur.port, {
        direction,
        maxNodes: budget.maxIntraSsaNodes,
      });
      nodeRecord.intraEdges = intra.edges;
      nextPorts = direction === SLICE_DIRECTION.BACKWARD
        ? intra.boundaryInputs
        : intra.boundaryOutputs;
    } else if (fn.codeBytes && intraAdapter && typeof intraAdapter.sliceIntra === 'function') {
      const intra = intraAdapter.sliceIntra(fn.codeBytes, fn.va ?? cur.funcVa, cur.port, direction, budget.maxIntraSsaNodes);
      nodeRecord.intraEdges = intra.edges || [];
      nextPorts = intra.boundaryPorts || [];
    } else if (fn.codeBytes && !intraAdapter) {
      skippedReasons.push({ funcVa: cur.funcKey, port: cur.port, reason: 'unsupported_architecture_no_adapter' });
    }

    nodes.push(nodeRecord);

    if (cur.depth >= budget.maxDepth) {
      continue;
    }

    if (direction === SLICE_DIRECTION.BACKWARD) {
      const callers = Array.isArray(fn.callers) ? fn.callers : [];
      let branched = 0;
      for (const caller of callers) {
        if (branched >= budget.maxBranchFactor || stopReason === 'edge_budget') break;
        if (caller.polymorphic) {
          skippedReasons.push({ funcVa: cur.funcKey, target: toFuncKey(caller.callerVa), reason: 'polymorphic_blocked' });
          continue;
        }
        for (const p of nextPorts) {
          if (branched >= budget.maxBranchFactor || stopReason === 'edge_budget') break;
          const callerPort = caller.argMap?.[p] ?? (p.startsWith('arg') || /^x[0-7]$/.test(p) ? p : null);
          if (!callerPort) continue;
          const nextFuncKey = toFuncKey(caller.callerVa);
          const nextKey = `${nextFuncKey}::${callerPort}`;
          if (!pushEdge({
            from: nextKey,
            to: `${cur.funcKey}::${p}`,
            kind: 'call_arg',
            callsiteVa: caller.callsiteVa ?? null,
          })) break;
          if (!visited.has(nextKey)) {
            visited.add(nextKey);
            queue.push({ funcVa: caller.callerVa, funcKey: nextFuncKey, port: callerPort, depth: cur.depth + 1 });
            branched++;
          }
        }
      }

      const callees = Array.isArray(fn.callees) ? fn.callees : [];
      for (const callee of callees) {
        if (branched >= budget.maxBranchFactor || stopReason === 'edge_budget') break;
        if (callee.polymorphic) {
          skippedReasons.push({ funcVa: cur.funcKey, target: toFuncKey(callee.calleeVa), reason: 'polymorphic_blocked' });
          continue;
        }
        if (callee.retDst && nextPorts.includes(String(callee.retDst))) {
          const nextFuncKey = toFuncKey(callee.calleeVa);
          const nextKey = `${nextFuncKey}::ret`;
          if (!pushEdge({
            from: nextKey,
            to: `${cur.funcKey}::${callee.retDst}`,
            kind: 'call_ret',
            callsiteVa: callee.callsiteVa ?? null,
          })) break;
          if (!visited.has(nextKey)) {
            visited.add(nextKey);
            queue.push({ funcVa: callee.calleeVa, funcKey: nextFuncKey, port: 'ret', depth: cur.depth + 1 });
            branched++;
          }
        }
      }
    } else {
      const callees = Array.isArray(fn.callees) ? fn.callees : [];
      let branched = 0;
      for (const callee of callees) {
        if (branched >= budget.maxBranchFactor || stopReason === 'edge_budget') break;
        if (callee.polymorphic) {
          skippedReasons.push({ funcVa: cur.funcKey, target: toFuncKey(callee.calleeVa), reason: 'polymorphic_blocked' });
          continue;
        }
        for (const p of nextPorts) {
          if (branched >= budget.maxBranchFactor || stopReason === 'edge_budget') break;
          const calleePort = callee.argMap?.[p] ?? null;
          if (!calleePort) continue;
          const nextFuncKey = toFuncKey(callee.calleeVa);
          const nextKey = `${nextFuncKey}::${calleePort}`;
          if (!pushEdge({
            from: `${cur.funcKey}::${p}`,
            to: nextKey,
            kind: 'call_arg',
            callsiteVa: callee.callsiteVa ?? null,
          })) break;
          if (!visited.has(nextKey)) {
            visited.add(nextKey);
            queue.push({ funcVa: callee.calleeVa, funcKey: nextFuncKey, port: calleePort, depth: cur.depth + 1 });
            branched++;
          }
        }
      }

      if (nextPorts.includes('ret') || cur.port === 'ret') {
        const callers = Array.isArray(fn.callers) ? fn.callers : [];
        for (const caller of callers) {
          if (branched >= budget.maxBranchFactor || stopReason === 'edge_budget') break;
          if (caller.polymorphic) {
            skippedReasons.push({ funcVa: cur.funcKey, target: toFuncKey(caller.callerVa), reason: 'polymorphic_blocked' });
            continue;
          }
          if (!caller.retDst) continue;
          const nextFuncKey = toFuncKey(caller.callerVa);
          const nextKey = `${nextFuncKey}::${caller.retDst}`;
          if (!pushEdge({
            from: `${cur.funcKey}::ret`,
            to: nextKey,
            kind: 'call_ret',
            callsiteVa: caller.callsiteVa ?? null,
          })) break;
          if (!visited.has(nextKey)) {
            visited.add(nextKey);
            queue.push({ funcVa: caller.callerVa, funcKey: nextFuncKey, port: String(caller.retDst), depth: cur.depth + 1 });
            branched++;
          }
        }
      }
    }
  }

  return {
    direction,
    seed: { funcVa: startFuncKey, port: String(seed.port) },
    nodes,
    edges,
    skippedReasons,
    stopReason,
    budget,
    elapsedMs: Date.now() - startTime,
  };
}
