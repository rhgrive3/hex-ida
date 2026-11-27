/**
 * Call-Graph metrics engine: non-recursive Tarjan SCC, role classification
 * (Recursive SCC / Dispatcher / Utility Hub / Leaf Compute / Normal), and
 * importance scoring (0..1000) with WASM acceleration and exact-parity JS fallback.
 */
import { getHexEngineExports, isWasmBulkMemorySupported } from '../core/hex-engine-wasm.js';
import { getEngineMode, recordWasmCall, recordFallback } from '../core/hex-engine-bridge.js';

const SCRATCH_BUDGET_BYTES = 2_200_000;

export const CALLGRAPH_ROLE = Object.freeze({
  NORMAL: 0,
  LEAF_COMPUTE: 1,
  DISPATCHER: 2,
  UTILITY_HUB: 3,
  RECURSIVE_SCC: 4,
});

function align8(n) {
  return Math.ceil(n / 8) * 8;
}

function getWasmExports(opts) {
  const modeOpts = opts && opts.engine != null && opts._engine == null
    ? { ...opts, _engine: opts.engine }
    : opts;
  if (getEngineMode(modeOpts) === 'js') {
    recordFallback('callgraph:wasm_disabled');
    return null;
  }
  if (!isWasmBulkMemorySupported()) {
    recordFallback('callgraph:no_bulk_memory');
    return null;
  }
  try {
    const ex = (opts && (opts.wasmExports || opts._wasmExports)) || getHexEngineExports(modeOpts);
    const hasScratchApi = Boolean(
      ex
      && typeof ex.hex_engine_scratch_reset === 'function'
      && typeof ex.hex_engine_scratch_alloc === 'function'
    );
    const hasHeapBase = Boolean(ex && ex.__heap_base != null);
    if (
      !ex
      || !ex.memory
      || typeof ex.hex_callgraph_scratch_bytes !== 'function'
      || typeof ex.hex_analyze_callgraph !== 'function'
      || (!hasScratchApi && !hasHeapBase)
    ) {
      recordFallback('callgraph:exports_missing');
      return null;
    }
    return ex;
  } catch {
    recordFallback('callgraph:init_error');
    return null;
  }
}

function createScratchAllocator(ex) {
  if (typeof ex.hex_engine_scratch_reset === 'function' && typeof ex.hex_engine_scratch_alloc === 'function') {
    return {
      reset() {
        ex.hex_engine_scratch_reset();
      },
      alloc(bytes) {
        if (bytes <= 0) return 0;
        return ex.hex_engine_scratch_alloc(bytes) >>> 0;
      },
    };
  }
  const rawBase = typeof ex.__heap_base === 'object' && ex.__heap_base !== null
    ? Number(ex.__heap_base.value)
    : Number(ex.__heap_base);
  const base = align8(rawBase >>> 0);
  let cursor = base;
  return {
    reset() {
      cursor = base;
    },
    alloc(bytes) {
      if (bytes <= 0) return 0;
      const aligned = align8(cursor);
      const next = aligned + bytes;
      if (next > ex.memory.buffer.byteLength) return 0;
      cursor = next;
      return aligned >>> 0;
    },
  };
}

function analyzeActiveJs(numNodes, edgeSrc, edgeDst, numEdges) {
  const outScc = new Uint32Array(numNodes);
  const outRole = new Uint8Array(numNodes);
  const outScore = new Uint32Array(numNodes);

  const outDeg = new Uint32Array(numNodes);
  const inDeg = new Uint32Array(numNodes);
  const selfLoop = new Uint8Array(numNodes);

  for (let i = 0; i < numEdges; i++) {
    const u = edgeSrc[i];
    const v = edgeDst[i];
    if (u >= numNodes || v >= numNodes) continue;
    outDeg[u] += 1;
    inDeg[v] += 1;
    if (u === v) selfLoop[u] = 1;
  }

  const rowPtr = new Uint32Array(numNodes + 1);
  const cursor = new Uint32Array(numNodes);
  for (let i = 0; i < numNodes; i++) {
    rowPtr[i + 1] = rowPtr[i] + outDeg[i];
    cursor[i] = rowPtr[i];
  }

  const colIdx = new Uint32Array(rowPtr[numNodes]);
  for (let i = 0; i < numEdges; i++) {
    const u = edgeSrc[i];
    const v = edgeDst[i];
    if (u >= numNodes || v >= numNodes) continue;
    colIdx[cursor[u]++] = v;
  }

  // Fully non-recursive Tarjan SCC
  const disc = new Uint32Array(numNodes);
  const low = new Uint32Array(numNodes);
  const onStack = new Uint8Array(numNodes);
  const tarjanStack = new Uint32Array(numNodes);
  const dfsNode = new Uint32Array(numNodes);
  const dfsEdge = new Uint32Array(numNodes);
  const sccSize = new Uint32Array(numNodes);

  let nextIndex = 1;
  let tarjanTop = 0;

  for (let start = 0; start < numNodes; start++) {
    if (disc[start] !== 0) continue;

    disc[start] = nextIndex;
    low[start] = nextIndex;
    nextIndex += 1;
    tarjanStack[tarjanTop++] = start;
    onStack[start] = 1;

    let dfsTop = 0;
    dfsNode[dfsTop] = start;
    dfsEdge[dfsTop] = rowPtr[start];
    dfsTop = 1;

    while (dfsTop > 0) {
      const frame = dfsTop - 1;
      const v = dfsNode[frame];
      const ei = dfsEdge[frame];
      if (ei < rowPtr[v + 1]) {
        dfsEdge[frame] = ei + 1;
        const w = colIdx[ei];
        if (disc[w] === 0) {
          disc[w] = nextIndex;
          low[w] = nextIndex;
          nextIndex += 1;
          tarjanStack[tarjanTop++] = w;
          onStack[w] = 1;
          dfsNode[dfsTop] = w;
          dfsEdge[dfsTop] = rowPtr[w];
          dfsTop += 1;
        } else if (onStack[w] !== 0) {
          if (disc[w] < low[v]) low[v] = disc[w];
        }
      } else {
        dfsTop -= 1;
        if (low[v] === disc[v]) {
          let sccStart = tarjanTop;
          let minId = v;
          while (sccStart > 0) {
            sccStart -= 1;
            const w = tarjanStack[sccStart];
            if (w < minId) minId = w;
            onStack[w] = 0;
            if (w === v) break;
          }
          const count = tarjanTop - sccStart;
          for (let k = sccStart; k < tarjanTop; k++) {
            outScc[tarjanStack[k]] = minId;
          }
          sccSize[minId] = count;
          tarjanTop = sccStart;
        }
        if (dfsTop > 0) {
          const parent = dfsNode[dfsTop - 1];
          if (low[v] < low[parent]) low[parent] = low[v];
        }
      }
    }
  }

  const twoHopIn = new Uint32Array(numNodes);
  for (let i = 0; i < numEdges; i++) {
    const u = edgeSrc[i];
    const v = edgeDst[i];
    if (u >= numNodes || v >= numNodes) continue;
    const add = inDeg[u] < 500 ? inDeg[u] : 500;
    const sum = twoHopIn[v] + add;
    twoHopIn[v] = sum < 500 ? sum : 500;
  }

  for (let v = 0; v < numNodes; v++) {
    const ind = inDeg[v];
    const outd = outDeg[v];
    let role = CALLGRAPH_ROLE.NORMAL;
    if (sccSize[outScc[v]] >= 2 || selfLoop[v] !== 0) {
      role = CALLGRAPH_ROLE.RECURSIVE_SCC;
    } else if (outd >= 8 && outd >= ind * 2) {
      role = CALLGRAPH_ROLE.DISPATCHER;
    } else if (ind >= 10 && outd <= 3) {
      role = CALLGRAPH_ROLE.UTILITY_HUB;
    } else if (outd === 0 && ind >= 1) {
      role = CALLGRAPH_ROLE.LEAF_COMPUTE;
    }
    outRole[v] = role;

    const inTerm = ind >= 84 ? 1000 : ind * 12;
    const outTerm = outd >= 125 ? 1000 : outd * 8;
    const twoHopTerm = twoHopIn[v] * 2;
    const recBonus = role === CALLGRAPH_ROLE.RECURSIVE_SCC ? 80 : 0;
    const total = inTerm + outTerm + twoHopTerm + recBonus;
    outScore[v] = total < 1000 ? total : 1000;
  }

  return { scc: outScc, role: outRole, score: outScore };
}

export function analyzeCallGraphMetrics(numNodes, edgeSrc, edgeDst, opts = {}) {
  const n = Number.isInteger(numNodes) && numNodes > 0 ? (numNodes >>> 0) : 0;
  const finalScc = new Uint32Array(n);
  const finalRole = new Uint8Array(n);
  const finalScore = new Uint32Array(n);
  for (let i = 0; i < n; i++) finalScc[i] = i;

  if (n === 0) {
    return { scc: finalScc, role: finalRole, score: finalScore, engine: 'js', truncated: false };
  }

  const rawE = edgeSrc && edgeDst
    ? Math.min(edgeSrc.length >>> 0, edgeDst.length >>> 0)
    : 0;

  // Common pre-processing: compress active nodes (appearing in valid edges) in ascending original ID order.
  const used = new Uint8Array(n);
  let activeE = 0;
  for (let i = 0; i < rawE; i++) {
    const u = edgeSrc[i];
    const v = edgeDst[i];
    if ((u >>> 0) === u && u < n && (v >>> 0) === v && v < n) {
      used[u] = 1;
      used[v] = 1;
      activeE += 1;
    }
  }

  let activeN = 0;
  for (let i = 0; i < n; i++) {
    if (used[i]) activeN += 1;
  }

  if (activeN === 0) {
    return { scc: finalScc, role: finalRole, score: finalScore, engine: 'js', truncated: false };
  }

  const origId = new Uint32Array(activeN);
  const compactId = new Uint32Array(n);
  let idx = 0;
  for (let i = 0; i < n; i++) {
    if (used[i]) {
      origId[idx] = i;
      compactId[i] = idx;
      idx += 1;
    }
  }

  const compSrc = new Uint32Array(activeE);
  const compDst = new Uint32Array(activeE);
  let eIdx = 0;
  for (let i = 0; i < rawE; i++) {
    const u = edgeSrc[i];
    const v = edgeDst[i];
    if ((u >>> 0) === u && u < n && (v >>> 0) === v && v < n) {
      compSrc[eIdx] = compactId[u];
      compDst[eIdx] = compactId[v];
      eIdx += 1;
    }
  }

  let activeScc = null;
  let activeRole = null;
  let activeScore = null;
  let engine = 'js';

  const ex = getWasmExports(opts);
  if (ex) {
    try {
      const ioBytes = align8(4 * activeE) * 2 + align8(4 * activeN) * 2 + align8(activeN);
      const needScratch = ex.hex_callgraph_scratch_bytes(activeN, activeE) >>> 0;
      if (needScratch === 0 || needScratch + ioBytes > SCRATCH_BUDGET_BYTES) {
        recordFallback('callgraph:exceeds_scratch');
      } else {
        const scratch = createScratchAllocator(ex);
        try {
        scratch.reset();
        const srcPtr = activeE > 0 ? scratch.alloc(activeE * 4) : 0;
        const dstPtr = activeE > 0 ? scratch.alloc(activeE * 4) : 0;
        const scratchPtr = scratch.alloc(needScratch);
        const outSccPtr = scratch.alloc(activeN * 4);
        const outRolePtr = scratch.alloc(activeN);
        const outScorePtr = scratch.alloc(activeN * 4);

        if ((activeE > 0 && (!srcPtr || !dstPtr)) || !scratchPtr || !outSccPtr || !outRolePtr || !outScorePtr) {
          recordFallback('callgraph:oom');
        } else {
          if (activeE > 0) {
            new Uint32Array(ex.memory.buffer, srcPtr, activeE).set(compSrc);
            new Uint32Array(ex.memory.buffer, dstPtr, activeE).set(compDst);
          }
          const rc = ex.hex_analyze_callgraph(
            activeN,
            srcPtr,
            dstPtr,
            activeE,
            scratchPtr,
            needScratch,
            outSccPtr,
            outRolePtr,
            outScorePtr
          ) >>> 0;
          if (rc !== activeN) {
            recordFallback('callgraph:wasm_failed');
          } else {
            activeScc = new Uint32Array(ex.memory.buffer, outSccPtr, activeN).slice();
            activeRole = new Uint8Array(ex.memory.buffer, outRolePtr, activeN).slice();
            activeScore = new Uint32Array(ex.memory.buffer, outScorePtr, activeN).slice();
            engine = 'wasm';
            recordWasmCall('callgraph');
          }
        }
        } finally {
          scratch.reset();
        }
      }
    } catch {
      recordFallback('callgraph:wasm_exception');
    }
  }

  if (engine !== 'wasm') {
    const jsRes = analyzeActiveJs(activeN, compSrc, compDst, activeE);
    activeScc = jsRes.scc;
    activeRole = jsRes.role;
    activeScore = jsRes.score;
  }

  // Common post-processing: expand compressed results back to original node IDs.
  for (let a = 0; a < activeN; a++) {
    const orig = origId[a];
    finalScc[orig] = origId[activeScc[a]];
    finalRole[orig] = activeRole[a];
    finalScore[orig] = activeScore[a];
  }

  return {
    scc: finalScc,
    role: finalRole,
    score: finalScore,
    engine,
    truncated: false,
  };
}
