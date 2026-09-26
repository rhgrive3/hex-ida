// The mandatory semantic-facts fallback runs many store/branch/return facts
// against the same sealed compat histories. Without a validation batch every
// fact re-walks the unchanged observed graph, which is the tail cost FAST pays
// when the optional pass budget is exhausted. `semanticFacts()` now reuses
// exact "still current" answers inside one synchronous section and rechecks
// every reused answer in `settle()` before returning.
//
// This test pins the two properties that make that change safe:
//   1. the returned facts are the unbatched facts (settle() === 0 records no
//      stale answer, and a repeated decompile is deep-equal), and
//   2. reuse is real measured in deterministic work units (live-graph reads),
//      not wall-clock.
import test from 'node:test';
import assert from 'node:assert/strict';

import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline-core.js';
import { createProjectionIrObserver, createValidationBatch } from '../../../js/core/identity/live-data.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

function buildFactsFixture() {
  const f = fixture('semantic_facts_batch_test'); f.block(0);
  const x0 = f.opaque(64); x0.index = 0; x0.reg = 'x0';
  const x1 = f.opaque(64); x1.index = 1; x1.reg = 'x1';
  const x2 = f.opaque(64); x2.index = 2; x2.reg = 'x2';
  const sum = f.binary('add', x1, x2, 64);
  f.store(sum, { locKey: 'state.a', addrBase: x0, disp: 0 });
  f.store(f.binary('add', sum, x1, 64), { locKey: 'state.b', addrBase: x0, disp: 8 });
  f.store(sum, { locKey: 'state.a', addrBase: x0, disp: 0 });
  f.ret();
  const ir = f.build();
  ir.instructions = ir.blocks.flatMap(block => [...block.phis, ...block.insts]);
  ir.instructions.forEach((inst, index) => {
    inst.id = `inst_${index}`;
    inst.address = 0x2000n + BigInt(index * 4);
  });
  const ret = ir.instructions.at(-1);
  ret.args = [{ value: sum }];
  return { ir, ret };
}

function enhance({ ir, ret }) {
  return enhanceSemanticDecompilation({
    semantic: true,
    ir,
    types: null,
    lines: [{ kind: 'stmt', indent: 0, text: 'return pending;', row: ret.row, addr: ret.address }],
    metrics: {},
    ctx: {},
  }, null, { decompilerTimeBudgetMs: 1000, returnType: 'uint64_t' });
}

test('semantic facts are deep-equal across runs and reuse every answer exactly', () => {
  // Same fixture object both times: value ids are only stable within one IR,
  // so cross-run equality has to compare the same graph, not two rebuilds.
  const graph = buildFactsFixture();
  const first = enhance(graph);
  const second = enhance(graph);

  assert.ok(first.semanticFacts, 'semanticFacts must be present');
  assert.ok(first.semanticFacts.stores.length >= 3, 'fixture must produce multiple store facts');
  assert.ok(first.semanticFacts.outputs.some(row => row.name === 'return'), 'return fact must be recorded');
  // Deep-equal across independent runs: the batched pass is deterministic.
  assert.deepEqual(second.semanticFacts, first.semanticFacts);
  // settle() === 0 is recorded implicitly: no stale reason means every reused
  // answer still equalled a fresh live walk when the section returned.
  assert.ok(
    !first.expressionHistoryBinding.reasons.includes('semantic-facts-validation-stale'),
    `reused validation answers went stale: ${JSON.stringify(first.expressionHistoryBinding.reasons)}`,
  );
});

// Deterministic work-unit counter: the live observation walk reads each
// recorded entry through Object.getOwnPropertyDescriptor, so counting those
// reads counts real graph walks without any wall-clock dependence.
function countGraphReads(run) {
  const original = Object.getOwnPropertyDescriptor;
  let reads = 0;
  Object.getOwnPropertyDescriptor = function countedDescriptor(owner, key) {
    reads += 1;
    return original(owner, key);
  };
  try {
    // Snapshot the counter AFTER run(): an object literal would read `reads`
    // before its later `value: run()` entry executed.
    const value = run();
    return { reads, value };
  } finally {
    Object.getOwnPropertyDescriptor = original;
  }
}

test('validation batch returns the unbatched answers while walking the graph fewer times', () => {
  const source = { a: 1, b: { c: 2, d: [3, 4, 5] }, e: 'live' };
  const observation = createProjectionIrObserver().captureCertifiedData([source]);

  const calls = 256;
  const unbatched = countGraphReads(() => {
    const answers = [];
    for (let index = 0; index < calls; index += 1) answers.push(observation.matches());
    return answers;
  });

  let stale = null;
  const batched = countGraphReads(() => {
    const answers = [];
    const batch = createValidationBatch();
    batch.run(() => { for (let index = 0; index < calls; index += 1) answers.push(observation.matches()); });
    stale = batch.settle();
    return answers;
  });

  // Same answers with and without the batch, and the batch provably reused
  // only answers that were still current.
  assert.equal(stale, 0, 'all reused answers must still be current at settle()');
  assert.deepEqual(batched.value, unbatched.value);
  assert.equal(unbatched.value.length, calls);
  // Reuse, not merely equal output: one walk per distinct observation plus one
  // settle recheck, against one walk per call unbatched.
  assert.ok(batched.reads < unbatched.reads,
    `batched ${batched.reads} reads vs unbatched ${unbatched.reads} reads`);
  assert.ok(batched.reads * 4 <= unbatched.reads,
    `expected at least 4x fewer live-graph reads, got ${batched.reads} vs ${unbatched.reads}`);
});

test('a mid-section mutation is detected and reported as stale, never shipped', () => {
  const source = { value: 1 };
  const observation = createProjectionIrObserver().captureCertifiedData([source]);
  const batch = createValidationBatch();
  let answer = null;
  batch.run(() => { answer = observation.matches(); });
  assert.equal(answer, true);
  source.value = 2;
  assert.equal(batch.settle(), 1, 'settle() must report the mutated observation');
});
