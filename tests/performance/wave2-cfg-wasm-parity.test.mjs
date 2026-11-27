import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeGraph } from '../../js/controlflow.js';
import {
  getFallbackCount,
  getWasmCallCount,
  resetAllTelemetry,
} from '../../js/core/wasm-telemetry.js';

function sortedNumArray(iter) {
  return Array.from(iter).sort((a, b) => a - b);
}

function assertGraphParity(wasmRes, jsRes, label) {
  assert.deepEqual(sortedNumArray(wasmRes.reachable), sortedNumArray(jsRes.reachable), `${label}: reachable`);
  assert.deepEqual(wasmRes.immediateDominators, jsRes.immediateDominators, `${label}: idom`);
  assert.deepEqual(wasmRes.immediatePostDominators, jsRes.immediatePostDominators, `${label}: ipdom`);
  assert.deepEqual(
    sortedNumArray(wasmRes.nonTerminatingReachable),
    sortedNumArray(jsRes.nonTerminatingReachable),
    `${label}: nonTerminatingReachable`,
  );
  assert.deepEqual(wasmRes.componentOf, jsRes.componentOf, `${label}: componentOf`);
  assert.deepEqual(wasmRes.backEdges, jsRes.backEdges, `${label}: backEdges`);
  assert.equal(wasmRes.loopAnalysis.complete, jsRes.loopAnalysis.complete, `${label}: loopAnalysis.complete`);
  assert.equal(wasmRes.loopAnalysis.stopReason, jsRes.loopAnalysis.stopReason, `${label}: loopAnalysis.stopReason`);
  assert.equal(wasmRes.loops.length, jsRes.loops.length, `${label}: loops.length`);

  for (let i = 0; i < jsRes.loops.length; i += 1) {
    const wl = wasmRes.loops[i];
    const jl = jsRes.loops[i];
    assert.equal(wl.header, jl.header, `${label}: loop[${i}].header`);
    assert.deepEqual(sortedNumArray(wl.latches), sortedNumArray(jl.latches), `${label}: loop[${i}].latches`);
    assert.deepEqual(sortedNumArray(wl.nodes), sortedNumArray(jl.nodes), `${label}: loop[${i}].nodes`);
    assert.deepEqual(sortedNumArray(wl.exits), sortedNumArray(jl.exits), `${label}: loop[${i}].exits`);
  }

  for (let i = 0; i < jsRes.dominators.length; i += 1) {
    assert.deepEqual(sortedNumArray(wasmRes.dominators[i]), sortedNumArray(jsRes.dominators[i]), `${label}: dom[${i}]`);
    assert.deepEqual(sortedNumArray(wasmRes.postDominators[i]), sortedNumArray(jsRes.postDominators[i]), `${label}: pdom[${i}]`);
  }
}

test('Wave 2 CFG/dominator/loop WASM matches JS 100% across golden fixtures and complex graphs', () => {
  const golden = JSON.parse(fs.readFileSync('fixtures/golden/cfg-outputs.json', 'utf8'));
  assert.ok(golden.length > 0, 'cfg-outputs.json must be non-empty');

  const extraGraphs = [
    { name: 'diamond', succs: [[1, 2], [3], [3], []], entry: 0, term: null },
    { name: 'nested-loop', succs: [[1], [2, 5], [3, 4], [2], [1], []], entry: 0, term: null },
    { name: 'infinite-sink', succs: [[1, 2], [1], []], entry: 0, term: null },
    { name: 'unreachable-cycle', succs: [[1], [], [3], [2]], entry: 0, term: null },
    { name: 'terminating-node', succs: [[1], [1]], entry: 0, term: [1] },
  ];

  // Verify JS rollback mode via globalThis.__HEX_ENGINE_MODE__ === 'js'
  resetAllTelemetry();
  const prevMode = globalThis.__HEX_ENGINE_MODE__;
  try {
    globalThis.__HEX_ENGINE_MODE__ = 'js';
    const jsOnly = analyzeGraph(extraGraphs[1].succs, 0);
    assert.equal(getWasmCallCount('cfg'), 0);
    assert.equal(getWasmCallCount('loops'), 0);
    assert.ok(getFallbackCount('cfg:wasm_disabled') >= 1);
    assert.equal(jsOnly.loops.length, 2);
  } finally {
    globalThis.__HEX_ENGINE_MODE__ = prevMode;
  }

  // Run parity checks on all golden CFG fixtures
  resetAllTelemetry();
  let wasmRan = false;
  for (const g of golden) {
    const label = `${g.binary}:${g.func}`;
    globalThis.__HEX_ENGINE_MODE__ = 'js';
    const jsRes = analyzeGraph(g.succs, g.entry);

    globalThis.__HEX_ENGINE_MODE__ = undefined;
    const wasmRes = analyzeGraph(g.succs, g.entry);
    if (getWasmCallCount('cfg') > 0) wasmRan = true;

    assertGraphParity(wasmRes, jsRes, label);
    assert.deepEqual(wasmRes.immediateDominators, g.idom, `${label}: golden idom`);
    assert.deepEqual(wasmRes.immediatePostDominators, g.ipdom, `${label}: golden ipdom`);
    assert.deepEqual(sortedNumArray(wasmRes.reachable), sortedNumArray(g.reachable), `${label}: golden reachable`);
    assert.deepEqual(
      wasmRes.backEdges.map((e) => [e.from, e.to]),
      g.backEdges,
      `${label}: golden backEdges`,
    );
  }

  for (const ex of extraGraphs) {
    globalThis.__HEX_ENGINE_MODE__ = 'js';
    const jsRes = analyzeGraph(ex.succs, ex.entry, ex.term);

    globalThis.__HEX_ENGINE_MODE__ = undefined;
    const wasmRes = analyzeGraph(ex.succs, ex.entry, ex.term);
    assertGraphParity(wasmRes, jsRes, ex.name);
  }

  globalThis.__HEX_ENGINE_MODE__ = prevMode;
  if (fs.existsSync('js/core/hex-engine-wasm.js')) {
    assert.ok(wasmRan && getWasmCallCount('cfg') >= golden.length, 'WASM cfg telemetry must fire when hex-engine-wasm.js is built');
    assert.ok(getWasmCallCount('loops') >= golden.length, 'WASM loops telemetry must fire when hex-engine-wasm.js is built');
  }
});
