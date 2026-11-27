/**
 * Unified facade for the 8 C++20/WASM static structural analysis engines.
 * Provides direct exports for every engine plus `runWasmStructuralAnalysis`
 * for whole-binary / call-graph structural scans.
 */
import { scanArm64RmwFields } from './wasm-rmw-scanner.js';
import { scanVtables, mergeVtableRuns } from './wasm-vtable-scanner.js';
import {
  fingerprintArm64Func,
  simhashHamming64,
  matchFingerprints,
} from './wasm-func-fingerprint.js';
import { scanArm64JumpTables } from './wasm-jumptable-scanner.js';
import { inferArm64Abi, ABI_RET_KIND } from './wasm-abi-scanner.js';
import { scanConstTables } from './wasm-const-table-scanner.js';
import { analyzeCallGraphMetrics, CALLGRAPH_ROLE } from './wasm-callgraph-metrics.js';
import { classifyArm64Behavior, BEHAVIOR_CATEGORY } from './wasm-behavior-classifier.js';

export {
  scanArm64RmwFields,
  scanVtables,
  mergeVtableRuns,
  fingerprintArm64Func,
  simhashHamming64,
  matchFingerprints,
  scanArm64JumpTables,
  inferArm64Abi,
  ABI_RET_KIND,
  scanConstTables,
  analyzeCallGraphMetrics,
  CALLGRAPH_ROLE,
  classifyArm64Behavior,
  BEHAVIOR_CATEGORY,
};

function toBigIntOrNull(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    return Number.isSafeInteger(v) ? BigInt(v) : null;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    try { return BigInt(s); } catch { return null; }
  }
  return null;
}

function extractCallGraphFromProgram(program, symbols) {
  if (!program || typeof program.calleesOf !== 'function') return null;
  const limit = 65536;
  const funcAddrs = [];

  if (symbols && symbols.funcs && typeof symbols.funcs.length === 'number') {
    // Production SymbolIndex stores sorted function addresses in BigUint64Array `symbols.funcs`.
    const n = Math.min(symbols.funcs.length, limit);
    for (let i = 0; i < n; i++) {
      const a = toBigIntOrNull(symbols.funcs[i]);
      if (a != null) funcAddrs.push(a);
    }
  } else if (symbols && typeof symbols.functionList === 'function') {
    const list = symbols.functionList(null, limit) || [];
    for (let i = 0; i < list.length && funcAddrs.length < limit; i++) {
      const f = list[i];
      const a = toBigIntOrNull(typeof f === 'bigint' || typeof f === 'number' ? f : (f?.addr ?? f?.address ?? f?.start));
      if (a != null) funcAddrs.push(a);
    }
  } else if (symbols && typeof symbols.functions === 'function') {
    for (const f of symbols.functions()) {
      if (funcAddrs.length >= limit) break;
      const a = toBigIntOrNull(typeof f === 'bigint' || typeof f === 'number' ? f : (f?.addr ?? f?.address ?? f?.start));
      if (a != null) funcAddrs.push(a);
    }
  } else if (Array.isArray(symbols?.functions)) {
    for (let i = 0; i < symbols.functions.length && funcAddrs.length < limit; i++) {
      const f = symbols.functions[i];
      const a = toBigIntOrNull(typeof f === 'bigint' || typeof f === 'number' ? f : (f?.addr ?? f?.address ?? f?.start));
      if (a != null) funcAddrs.push(a);
    }
  } else if (Array.isArray(program.functions)) {
    for (let i = 0; i < program.functions.length && funcAddrs.length < limit; i++) {
      const f = program.functions[i];
      const a = toBigIntOrNull(typeof f === 'bigint' || typeof f === 'number' ? f : (f?.addr ?? f?.address ?? f?.start));
      if (a != null) funcAddrs.push(a);
    }
  }
  if (!funcAddrs.length) return null;

  // Deduplicate and sort ascending so adjacent function starts bound unknown ends accurately.
  const uniqueSet = new Set(funcAddrs);
  const nodes = Array.from(uniqueSet);
  nodes.sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0)));
  const addrToIdx = new Map();
  for (let i = 0; i < nodes.length; i++) addrToIdx.set(nodes[i], i);

  const srcList = [];
  const dstList = [];
  for (let u = 0; u < nodes.length; u++) {
    const range = typeof program.functionRange === 'function' ? program.functionRange(nodes[u]) : null;
    let end = toBigIntOrNull(range?.end);
    const regStart = toBigIntOrNull(range?.region?.vmAddr);
    const regSize = toBigIntOrNull(range?.region?.size);
    const regEnd = regStart != null && regSize != null && regSize > 0n ? regStart + regSize : null;
    if (end == null || end <= nodes[u]) {
      const nextStart = u + 1 < nodes.length ? nodes[u + 1] : null;
      if (nextStart != null && (regEnd == null || nextStart <= regEnd)) {
        end = nextStart;
      } else if (regEnd != null && regEnd > nodes[u]) {
        end = regEnd;
      }
    }
    // ProgramIndex.calleesOf(start, end) scans to EOF if end == null; skip when end is unknown.
    if (end == null || end <= nodes[u]) continue;
    const callees = program.calleesOf(nodes[u], end);
    if (!callees || !callees.length) continue;
    for (let j = 0; j < callees.length; j++) {
      const raw = callees[j];
      const ca = toBigIntOrNull(typeof raw === 'bigint' || typeof raw === 'number' ? raw : (raw?.addr ?? raw?.target ?? raw?.to));
      if (ca == null) continue;
      const v = addrToIdx.get(ca);
      if (v !== undefined) {
        srcList.push(u);
        dstList.push(v);
      }
    }
  }
  return {
    numNodes: nodes.length,
    nodes,
    edgeSrc: Uint32Array.from(srcList),
    edgeDst: Uint32Array.from(dstList),
  };
}

/**
 * Run whole-binary / call-graph WASM structural analysis on whatever inputs are
 * available (`codeBytes`, `dataBytes`, `program`/`symbols`, or explicit `callgraph`).
 *
 * @param {object} [opts]
 * @returns {object}
 */
export function runWasmStructuralAnalysis(opts = {}) {
  const o = opts || {};
  const arch = o.arch || 'arm64';
  const engineOpt = o.engine ? { engine: o.engine } : {};
  const wasmOpt = o.wasmExports ? { wasmExports: o.wasmExports } : {};
  const common = { ...engineOpt, ...wasmOpt };

  const out = {
    rmw: null,
    vtables: null,
    jumpTables: null,
    constTables: null,
    callgraph: null,
  };

  if (o.codeBytes instanceof Uint8Array && o.codeBytes.length >= 4) {
    out.rmw = scanArm64RmwFields(o.codeBytes, { ...common, arch, maxOut: o.rmwMaxOut });
    const textVa = toBigIntOrNull(o.textVa) ?? toBigIntOrNull(o.baseVa) ?? 0n;
    out.jumpTables = scanArm64JumpTables(o.codeBytes, {
      ...common,
      arch,
      textVa,
      maxOut: o.jumpTableMaxOut,
    });
  }

  if (o.dataBytes instanceof Uint8Array && o.dataBytes.length >= 16) {
    const textLo = toBigIntOrNull(o.textLo);
    const textHi = toBigIntOrNull(o.textHi);
    if (textLo != null && textHi != null && textHi > textLo) {
      out.vtables = scanVtables(o.dataBytes, {
        ...common,
        textLo,
        textHi,
        ptrSize: o.ptrSize ?? 8,
        stripPac: o.stripPac !== false,
        maxOut: o.vtableMaxOut,
      });
    }
    out.constTables = scanConstTables(o.dataBytes, {
      ...common,
      maxOut: o.constTableMaxOut,
    });
  }

  if (o.callgraph && typeof o.callgraph.numNodes === 'number' && o.callgraph.edgeSrc && o.callgraph.edgeDst) {
    out.callgraph = analyzeCallGraphMetrics(
      o.callgraph.numNodes,
      o.callgraph.edgeSrc,
      o.callgraph.edgeDst,
      common,
    );
  } else if (o.program) {
    const cg = extractCallGraphFromProgram(o.program, o.symbols);
    if (cg && cg.numNodes > 0) {
      const metrics = analyzeCallGraphMetrics(cg.numNodes, cg.edgeSrc, cg.edgeDst, common);
      let recursiveCount = 0;
      let dispatcherCount = 0;
      let utilityHubCount = 0;
      let leafCount = 0;
      for (let i = 0; i < metrics.role.length; i++) {
        const r = metrics.role[i];
        if (r === CALLGRAPH_ROLE.RECURSIVE_SCC) recursiveCount++;
        else if (r === CALLGRAPH_ROLE.DISPATCHER) dispatcherCount++;
        else if (r === CALLGRAPH_ROLE.UTILITY_HUB) utilityHubCount++;
        else if (r === CALLGRAPH_ROLE.LEAF_COMPUTE) leafCount++;
      }
      out.callgraph = {
        ...metrics,
        numNodes: cg.numNodes,
        numEdges: cg.edgeSrc.length,
        nodes: cg.nodes,
        summary: {
          recursiveCount,
          dispatcherCount,
          utilityHubCount,
          leafCount,
        },
      };
    }
  }

  return out;
}
