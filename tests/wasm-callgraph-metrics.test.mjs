import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  CALLGRAPH_ROLE,
  analyzeCallGraphMetrics,
} from '../js/analysis/wasm-callgraph-metrics.js';
import {
  getFallbackCount,
  getWasmCallCount,
  resetAllTelemetry,
} from '../js/core/hex-engine-bridge.js';
import { getHexEngineExports } from '../js/core/hex-engine-wasm.js';

function loadStandaloneWasmExports() {
  const wasmPath = process.env.HEX_TEST_STANDALONE_WASM;
  if (!wasmPath) return null;
  const bytes = fs.readFileSync(wasmPath);
  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod);
  assert.equal(imports.length, 0, `standalone WASM must have 0 imports, got: ${JSON.stringify(imports)}`);
  const inst = new WebAssembly.Instance(mod, {});
  return inst.exports;
}

const STANDALONE_EXPORTS = loadStandaloneWasmExports();

function wasmOpts(extra = null) {
  const base = STANDALONE_EXPORTS ? { wasmExports: STANDALONE_EXPORTS } : {};
  return extra ? { ...base, ...extra } : base;
}

function activeWasmExports() {
  return STANDALONE_EXPORTS || getHexEngineExports();
}

function buildLargeGraph(N = 45000) {
  const src = new Uint32Array(N);
  const dst = new Uint32Array(N);
  for (let i = 0; i < N - 1; i++) {
    src[i] = i;
    dst[i] = i + 1;
  }
  // Close a small 3-node cycle at the end (N-1 -> N-3)
  src[N - 1] = N - 1;
  dst[N - 1] = N - 3;
  return { N, src, dst };
}

function assertWasmMatchesJs(numNodes, edgeSrc, edgeDst, label = '') {
  const wasmRes = analyzeCallGraphMetrics(numNodes, edgeSrc, edgeDst, wasmOpts());
  const jsRes = analyzeCallGraphMetrics(numNodes, edgeSrc, edgeDst, { engine: 'js' });
  assert.equal(wasmRes.engine, 'wasm', `${label}: expected wasm engine`);
  assert.equal(jsRes.engine, 'js', `${label}: expected js engine`);
  assert.equal(wasmRes.truncated, false);
  assert.equal(jsRes.truncated, false);
  assert.deepEqual(wasmRes.scc, jsRes.scc, `${label}: scc mismatch`);
  assert.deepEqual(wasmRes.role, jsRes.role, `${label}: role mismatch`);
  assert.deepEqual(wasmRes.score, jsRes.score, `${label}: score mismatch`);
  return wasmRes;
}

test('standalone WASM module has zero imports and validates ABI scratch/overflow contracts', () => {
  if (!STANDALONE_EXPORTS) return;
  assert.equal(typeof STANDALONE_EXPORTS.hex_callgraph_scratch_bytes, 'function');
  assert.equal(typeof STANDALONE_EXPORTS.hex_analyze_callgraph, 'function');

  // N == 0 returns 0
  assert.equal(STANDALONE_EXPORTS.hex_callgraph_scratch_bytes(0, 0) >>> 0, 0);
  assert.equal(STANDALONE_EXPORTS.hex_callgraph_scratch_bytes(0, 100) >>> 0, 0);

  // Exact formula check: align8(4*(N+1)) + align8(4*E) + 10*align8(4*N) + 2*align8(N)
  const align8 = (x) => Math.ceil(x / 8) * 8;
  for (const [n, e] of [[1, 0], [1, 1], [7, 13], [100, 250], [1000, 999]]) {
    const expected = align8(4 * (n + 1)) + align8(4 * e) + 10 * align8(4 * n) + 2 * align8(n);
    assert.equal(STANDALONE_EXPORTS.hex_callgraph_scratch_bytes(n, e) >>> 0, expected);
  }

  // 32-bit overflow detection returns 0
  assert.equal(STANDALONE_EXPORTS.hex_callgraph_scratch_bytes(0xffffffff, 0) >>> 0, 0);
  assert.equal(STANDALONE_EXPORTS.hex_callgraph_scratch_bytes(0x10000000, 0) >>> 0, 0);
  assert.equal(STANDALONE_EXPORTS.hex_callgraph_scratch_bytes(10, 0x40000000) >>> 0, 0);

  // Insufficient scratch_bytes returns 0
  const base = Number(STANDALONE_EXPORTS.__heap_base.value ?? STANDALONE_EXPORTS.__heap_base);
  const needZeroEdges = STANDALONE_EXPORTS.hex_callgraph_scratch_bytes(4, 0) >>> 0;
  assert.equal(
    STANDALONE_EXPORTS.hex_analyze_callgraph(4, 0, 0, 0, base, needZeroEdges - 1, base + 4096, base + 4128, base + 4160) >>> 0,
    0
  );
  // Null output pointers return 0
  assert.equal(
    STANDALONE_EXPORTS.hex_analyze_callgraph(4, 0, 0, 0, base, needZeroEdges, 0, base + 4128, base + 4160) >>> 0,
    0
  );
  // Non-zero edges with null edge pointers return 0
  const needTwoEdges = STANDALONE_EXPORTS.hex_callgraph_scratch_bytes(4, 2) >>> 0;
  assert.equal(
    STANDALONE_EXPORTS.hex_analyze_callgraph(4, 0, 0, 2, base, needTwoEdges, base + 4096, base + 4128, base + 4160) >>> 0,
    0
  );
});

test('mutual recursion SCC + self-loop classification, min-ID SCC representative, and score bonus', () => {
  // Nodes 0..6:
  // Mutual recursion cycle: 5 -> 2 -> 6 -> 5 (SCC min_id = 2, size = 3)
  // Self-loop: 4 -> 4 (SCC min_id = 4, size = 1, self_loop = 1)
  // Caller 1 -> 5, 1 -> 4; Leaf 6 -> 3
  const src = new Uint32Array([5, 2, 6, 4, 1, 1, 6]);
  const dst = new Uint32Array([2, 6, 5, 4, 5, 4, 3]);
  const res = assertWasmMatchesJs(7, src, dst, 'mutual-scc-self-loop');

  // Isolated node 0
  assert.equal(res.scc[0], 0);
  assert.equal(res.role[0], CALLGRAPH_ROLE.NORMAL);
  assert.equal(res.score[0], 0);

  // Mutual recursion SCC {2, 5, 6} -> min ID 2, role RECURSIVE_SCC (4)
  assert.equal(res.scc[2], 2);
  assert.equal(res.scc[5], 2);
  assert.equal(res.scc[6], 2);
  assert.equal(res.role[2], CALLGRAPH_ROLE.RECURSIVE_SCC);
  assert.equal(res.role[5], CALLGRAPH_ROLE.RECURSIVE_SCC);
  assert.equal(res.role[6], CALLGRAPH_ROLE.RECURSIVE_SCC);

  // Self-loop node 4 -> scc 4, role RECURSIVE_SCC (4)
  assert.equal(res.scc[4], 4);
  assert.equal(res.role[4], CALLGRAPH_ROLE.RECURSIVE_SCC);
  // Node 4: in_deg = 2 (from 1 and 4), out_deg = 1 (to 4), two_hop_in = in_deg[1](0) + in_deg[4](2) = 2
  // score = 2*12 + 1*8 + 2*2 + 80 = 24 + 8 + 4 + 80 = 116
  assert.equal(res.score[4], 116);

  // Leaf node 3: in_deg = 1 (from 6), out_deg = 0, two_hop_in = in_deg[6](1) = 1
  // score = 1*12 + 0 + 1*2 + 0 = 14
  assert.equal(res.scc[3], 3);
  assert.equal(res.role[3], CALLGRAPH_ROLE.LEAF_COMPUTE);
  assert.equal(res.score[3], 14);
});

test('all roles (Dispatcher, UtilityHub, LeafCompute, Normal, RecursiveSCC) and priority rules', () => {
  // Layout (30 nodes):
  // - Node 0: Dispatcher (out_deg = 8 to nodes 1..8, in_deg = 4 from 20..23 -> out_deg >= 8 && out_deg >= 2*in_deg)
  // - Node 9: UtilityHub (in_deg = 10 from 10..19, out_deg = 3 to 1,2,3 -> in_deg >= 10 && out_deg <= 3)
  // - Node 1..8: LeafCompute (out_deg = 0, in_deg >= 1)
  // - Node 24: Normal (in_deg = 5 from 10..14, out_deg = 8 to 1..8 -> 8 < 10 so NOT dispatcher, out_deg > 3 so NOT hub)
  // - Node 25: RecursiveSCC beats Dispatcher (out_deg = 9 including self-loop 25->25, in_deg = 1)
  const edges = [];
  // Dispatcher 0: 8 callees (1..8), 4 callers (20..23)
  for (let dst = 1; dst <= 8; dst++) edges.push([0, dst]);
  for (let src = 20; src <= 23; src++) edges.push([src, 0]);

  // UtilityHub 9: 10 callers (10..19), 3 callees (1..3)
  for (let src = 10; src <= 19; src++) edges.push([src, 9]);
  for (let dst = 1; dst <= 3; dst++) edges.push([9, dst]);

  // Normal 24: 5 callers (10..14), 8 callees (1..8) -> fails dispatcher (8 < 5*2), fails hub (out=8 > 3)
  for (let src = 10; src <= 14; src++) edges.push([src, 24]);
  for (let dst = 1; dst <= 8; dst++) edges.push([24, dst]);

  // RecursiveSCC priority over Dispatcher on node 25: 8 callees (1..8) + self-loop (25->25)
  for (let dst = 1; dst <= 8; dst++) edges.push([25, dst]);
  edges.push([25, 25]);

  const edgeSrc = Uint32Array.from(edges.map((e) => e[0]));
  const edgeDst = Uint32Array.from(edges.map((e) => e[1]));
  const res = assertWasmMatchesJs(30, edgeSrc, edgeDst, 'all-roles');

  assert.equal(res.role[0], CALLGRAPH_ROLE.DISPATCHER);
  assert.equal(res.role[9], CALLGRAPH_ROLE.UTILITY_HUB);
  for (let leaf = 1; leaf <= 8; leaf++) {
    assert.equal(res.role[leaf], CALLGRAPH_ROLE.LEAF_COMPUTE, `node ${leaf} should be LEAF_COMPUTE`);
  }
  assert.equal(res.role[24], CALLGRAPH_ROLE.NORMAL);
  assert.equal(res.role[25], CALLGRAPH_ROLE.RECURSIVE_SCC);
  // Isolated node 29
  assert.equal(res.role[29], CALLGRAPH_ROLE.NORMAL);
  assert.equal(res.score[29], 0);
  assert.equal(res.scc[29], 29);
});

test('out-of-range edges, duplicate edges, and isolated nodes are handled identically in WASM and JS', () => {
  // 12 nodes; isolated: 0, 1, 4, 6, 8, 10, 11
  // Active: 2, 3, 5, 7, 9
  // Duplicate edges: 10 edges from 2 -> 9 so node 9 has in_deg=10, out_deg=0 -> UTILITY_HUB (3 > 1)
  // Out-of-range edges: (-1, 2), (2, 12), (999, 5), (3, 100)
  // Cycle: 7 -> 5 -> 7 (SCC min = 5)
  const srcList = [-1, 2, 999, 3, 7, 5, 3];
  const dstList = [2, 12, 5, 100, 5, 7, 5];
  for (let k = 0; k < 10; k++) {
    srcList.push(2);
    dstList.push(9);
  }
  const res = assertWasmMatchesJs(12, srcList, dstList, 'oob-dup-isolated');

  // Isolated nodes preserve scc=nodeId, role=0, score=0
  for (const iso of [0, 1, 4, 6, 8, 10, 11]) {
    assert.equal(res.scc[iso], iso);
    assert.equal(res.role[iso], CALLGRAPH_ROLE.NORMAL);
    assert.equal(res.score[iso], 0);
  }

  // Node 2: out_deg = 10 (all duplicates counted), in_deg = 0 -> DISPATCHER
  assert.equal(res.role[2], CALLGRAPH_ROLE.DISPATCHER);
  // Node 9: in_deg = 10, out_deg = 0 -> UTILITY_HUB (priority 3 > LEAF_COMPUTE 1)
  assert.equal(res.role[9], CALLGRAPH_ROLE.UTILITY_HUB);
  // Cycle {5, 7} -> original min ID = 5
  assert.equal(res.scc[5], 5);
  assert.equal(res.scc[7], 5);
  assert.equal(res.role[5], CALLGRAPH_ROLE.RECURSIVE_SCC);
  assert.equal(res.role[7], CALLGRAPH_ROLE.RECURSIVE_SCC);
  // Node 3: in_deg = 0, out_deg = 1 -> NORMAL
  assert.equal(res.role[3], CALLGRAPH_ROLE.NORMAL);
});

test('deep linear chain (1000 nodes) executes non-recursively in WASM and matches JS', () => {
  const N = 1000;
  const src = new Uint32Array(N - 1);
  const dst = new Uint32Array(N - 1);
  for (let i = 0; i < N - 1; i++) {
    src[i] = i;
    dst[i] = i + 1;
  }

  const res = assertWasmMatchesJs(N, src, dst, 'deep-chain-1000');

  for (let i = 0; i < N; i++) {
    assert.equal(res.scc[i], i);
  }
  assert.equal(res.role[0], CALLGRAPH_ROLE.NORMAL);
  assert.equal(res.score[0], 8); // in=0, out=1, two_hop=0
  assert.equal(res.role[1], CALLGRAPH_ROLE.NORMAL);
  assert.equal(res.score[1], 20); // in=1(12), out=1(8), two_hop=in[0](0)
  assert.equal(res.role[500], CALLGRAPH_ROLE.NORMAL);
  assert.equal(res.score[500], 22); // in=1(12), out=1(8), two_hop=1(2)
  assert.equal(res.role[N - 1], CALLGRAPH_ROLE.LEAF_COMPUTE);
  assert.equal(res.score[N - 1], 14); // in=1(12), out=0, two_hop=1(2)
});

test('large graph (N=45000, E=45000) runs in WASM via dynamic memory.grow, matches JS, and reuses extBase region', () => {
  const { N, src, dst } = buildLargeGraph(45000);
  const ex = activeWasmExports();
  assert.ok(ex && ex.memory, 'expected active WASM exports with linear memory');

  resetAllTelemetry();
  const firstRes = analyzeCallGraphMetrics(N, src, dst, wasmOpts());
  const bytesAfterFirst = ex.memory.buffer.byteLength;
  const jsRes = analyzeCallGraphMetrics(N, src, dst, { engine: 'js' });

  assert.equal(firstRes.engine, 'wasm');
  assert.equal(firstRes.truncated, false);
  assert.ok(getWasmCallCount('callgraph') >= 1);
  assert.deepEqual(firstRes.scc, jsRes.scc);
  assert.deepEqual(firstRes.role, jsRes.role);
  assert.deepEqual(firstRes.score, jsRes.score);
  assert.equal(firstRes.role[N - 1], CALLGRAPH_ROLE.RECURSIVE_SCC);
  assert.equal(firstRes.scc[N - 1], N - 3);

  // Second call on the same graph reuses extBase without growing linear memory again.
  const secondRes = analyzeCallGraphMetrics(N, src, dst, wasmOpts());
  const bytesAfterSecond = ex.memory.buffer.byteLength;

  assert.equal(secondRes.engine, 'wasm');
  assert.equal(bytesAfterSecond, bytesAfterFirst, 'expected extBase region reuse without additional memory.grow');
  assert.deepEqual(secondRes.scc, jsRes.scc);
  assert.deepEqual(secondRes.role, jsRes.role);
  assert.deepEqual(secondRes.score, jsRes.score);
});

test('exceeding opts.maxWasmBytes falls back to JS with callgraph:exceeds_max_wasm_bytes telemetry', () => {
  const { N, src, dst } = buildLargeGraph(45000);

  resetAllTelemetry();
  const autoRes = analyzeCallGraphMetrics(N, src, dst, wasmOpts({ maxWasmBytes: 2_300_000 }));
  const jsRes = analyzeCallGraphMetrics(N, src, dst, { engine: 'js' });

  assert.equal(autoRes.engine, 'js');
  assert.equal(autoRes.truncated, false);
  assert.ok(
    getFallbackCount('callgraph:exceeds_max_wasm_bytes') >= 1,
    'expected callgraph:exceeds_max_wasm_bytes fallback telemetry'
  );
  assert.deepEqual(autoRes.scc, jsRes.scc);
  assert.deepEqual(autoRes.role, jsRes.role);
  assert.deepEqual(autoRes.score, jsRes.score);
});

test('memory.grow throwing RangeError falls back to JS with callgraph:grow_failed telemetry', () => {
  const { N, src, dst } = buildLargeGraph(45000);
  const realExports = activeWasmExports();
  assert.ok(realExports, 'expected active WASM exports');

  const failingMemory = {
    buffer: new ArrayBuffer(65536),
    grow() {
      throw new RangeError('WebAssembly.Memory.grow(): Unable to grow instance memory');
    },
  };
  const mockExports = {
    ...realExports,
    memory: failingMemory,
  };

  resetAllTelemetry();
  const autoRes = analyzeCallGraphMetrics(N, src, dst, { wasmExports: mockExports });
  const jsRes = analyzeCallGraphMetrics(N, src, dst, { engine: 'js' });

  assert.equal(autoRes.engine, 'js');
  assert.equal(autoRes.truncated, false);
  assert.ok(
    getFallbackCount('callgraph:grow_failed') >= 1,
    'expected callgraph:grow_failed fallback telemetry'
  );
  assert.deepEqual(autoRes.scc, jsRes.scc);
  assert.deepEqual(autoRes.role, jsRes.role);
  assert.deepEqual(autoRes.score, jsRes.score);
});

test('deterministic pseudo-random graph verifies engine === wasm and exact WASM === JS parity', () => {
  const N = 250;
  const E = 1200;
  const src = new Uint32Array(E);
  const dst = new Uint32Array(E);
  let x = 0x9e3779b9;
  const next = () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x;
  };
  for (let i = 0; i < E; i++) {
    // Mix valid nodes, occasional out-of-range edges, self-loops, and duplicates
    src[i] = next() % (N + 15);
    dst[i] = next() % (N + 15);
  }

  resetAllTelemetry();
  const res = assertWasmMatchesJs(N, src, dst, 'prng-250x1200');
  assert.equal(res.engine, 'wasm');
  assert.ok(getWasmCallCount('callgraph') >= 1);
  // All scores bounded within 0..1000 and roles within 0..4
  for (let i = 0; i < N; i++) {
    assert.ok(res.score[i] <= 1000);
    assert.ok(res.role[i] <= 4);
    assert.ok(res.scc[i] < N);
  }
});
