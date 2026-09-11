import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry, provenanceFromSourceMap } from '../../../tools/validation/phase8/decompile-corpus.mjs';
import { loadFrozenProvenance } from '../../../tools/validation/phase8/metrics.mjs';
import * as facade from '../../../js/ir-core.js';
import * as projector from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { readLineExpressionHistory } from '../../../js/decompiler/phase8/projection.js';
import { PROJECTION_LIMITS } from '../../../js/core/identity/live-data.js';

test('C4-03 native aggregate loop binds every rendered entity within the unchanged default budget', () => {
  const corpus = loadCorpus();
  const index = corpus.functions.findIndex(entry => entry.id === 'quality.aggregate_array_stride.O1');
  assert.ok(index >= 0);
  const outcome = decompileEntry(corpus.functions[index], {
    index, decompilerTimeBudgetMs:20000, toolchain:corpus.toolchain ?? null,
  });
  assert.equal(outcome.failure ?? null, null);
  assert.ok(outcome.result?.ir);
  assert.deepEqual(outcome.result.expressionHistoryBinding.reasons, []);
  assert.equal(outcome.result.expressionHistoryBinding.completeness, 'complete');
  assert.equal(outcome.result.renderProvenance.completeness, 'complete');
  assert.deepEqual(outcome.result.renderProvenance.reasons, []);
  assert.equal(outcome.result.renderProvenance.counts.provenanceLoss, 0);
});

test('C4-03 native RISC-V state histories retain control handoff within the unchanged default ledger cap', () => {
  const corpus = loadCorpus(), id = 'riscv64.quality.sccp_dead_branch.O0';
  const index = corpus.functions.findIndex(entry => entry.id === id);
  assert.ok(index >= 0);
  const reference = loadFrozenProvenance().observations.find(entry => entry.id === id);
  const { result, failure } = decompileEntry(corpus.functions[index], {
    index, decompilerTimeBudgetMs:20000, toolchain:corpus.toolchain ?? null,
  });
  assert.equal(failure ?? null, null);
  assert.equal(result.expressionHistoryBinding.completeness, 'complete');
  assert.equal(result.phase8Projection.history.completeness, 'complete');
  assert.equal(result.renderProvenance.completeness, 'complete');
  assert.deepEqual(result.renderProvenance.reasons, []);
  assert.equal(result.renderProvenance.budget.maxTransformRecords, 1024);
  assert.ok(result.renderProvenance.counts.transformRecords <= 1024);
  assert.equal(result.renderProvenance.counts.ledgerTruncated, 0);
  const actual = provenanceFromSourceMap(result.sourceMap);
  assert.deepEqual(reference.sourceAddresses.filter(address => !actual.sourceAddresses.includes(address)), []);
});

test('C4-03 native x86 construction reuses observed inputs without losing live consumer checks', () => {
  const corpus = loadCorpus(), id = 'x86_64.quality.gvn_load_reuse.O0';
  const index = corpus.functions.findIndex(entry => entry.id === id);
  assert.ok(index >= 0);
  const reference = loadFrozenProvenance().observations.find(entry => entry.id === id);
  const { result, failure } = decompileEntry(corpus.functions[index], {
    index, decompilerTimeBudgetMs:20000, toolchain:corpus.toolchain ?? null,
  });
  assert.equal(failure ?? null, null);
  assert.equal(PROJECTION_LIMITS.edges, 100000);
  assert.equal(result.expressionHistoryBinding.completeness, 'complete');
  assert.deepEqual(result.expressionHistoryBinding.reasons, []);
  assert.equal(result.renderProvenance.completeness, 'complete');
  assert.equal(result.renderProvenance.budget.maxTransformRecords, 1024);
  const actual = provenanceFromSourceMap(result.sourceMap);
  assert.deepEqual(reference.sourceAddresses.filter(address => !actual.sourceAddresses.includes(address)), []);
  const lines = result.lines.filter(line => readLineExpressionHistory(line, result.ir)?.length);
  assert.ok(lines.length > 1);
  assert.equal(readLineExpressionHistory({ ...lines[0] }, result.ir), null);
  result.ir.instructions = [...result.ir.instructions];
  assert.ok(lines.every(line => readLineExpressionHistory(line, result.ir) === null),
    'shared construction inputs retain exact mutable root identity after publication');
});

for (const optimization of ['O1','O2']) for (const phase8Optimize of [false,true]) {
  test(`C4-03 native x86 call barrier retains consumed state origins (${optimization}, optimize=${phase8Optimize})`, () => {
    const corpus = loadCorpus(), id = `x86_64.quality.gvn_call_barrier.${optimization}`;
    const index = corpus.functions.findIndex(entry => entry.id === id);
    assert.ok(index >= 0);
    const reference = loadFrozenProvenance().observations.find(entry => entry.id === id);
    const outcome = decompileEntry(corpus.functions[index], {
      index, phase8Optimize, decompilerTimeBudgetMs:20000, toolchain:corpus.toolchain ?? null,
    });
    assert.equal(outcome.failure ?? null, null);
    const actual = provenanceFromSourceMap(outcome.result.sourceMap);
    assert.deepEqual(reference.sourceAddresses.filter(address => !actual.sourceAddresses.includes(address)), []);
  });
}

for (const name of ['aggregate_struct_fields','dce_observable_store','dce_volatile_read','sccp_narrow_extend','sccp_wraparound']) {
  test(`C4-03 native memory history survives the actual facade writes (${name})`, () => {
    const corpus = loadCorpus(), id = `quality.${name}.O0`;
    const index = corpus.functions.findIndex(entry => entry.id === id);
    assert.ok(index >= 0);
    const reference = loadFrozenProvenance().observations.find(entry => entry.id === id);
    const { result, failure } = decompileEntry(corpus.functions[index], {
      index, decompilerTimeBudgetMs:20000, toolchain:corpus.toolchain ?? null,
    });
    assert.equal(failure ?? null, null);
    assert.equal(result.expressionHistoryBinding.completeness, 'complete');
    assert.equal(result.renderProvenance.completeness, 'complete');
    assert.deepEqual(result.renderProvenance.reasons, []);
    const records = result.rewriteProof.filter(record => record.rule === 'project-stack-load-to-operand');
    assert.ok(records.length);
    assert.equal(new Set(records.map(record => record.originHistory)).size, records.length,
      'inherited memory selections remain one producer, not a transform per downstream consumer');
    const actual = provenanceFromSourceMap(result.sourceMap);
    assert.deepEqual(reference.sourceAddresses.filter(address => !actual.sourceAddresses.includes(address)), []);

    const { ir } = result;
    const source = ir.instructions.find(inst => facade.readFacadeProjectedMemoryOperandTransition(ir, inst));
    assert.ok(source, 'the real facade handed off an existing memory producer');
    const producer = facade.readFacadeProjectedMemoryOperandTransition(ir, source);
    const predecessor = projector.projectedMemoryOperandTransitionCandidate(ir, source);
    assert.ok(predecessor);
    assert.notEqual(producer, predecessor);
    assert.equal(producer.proof, predecessor.proof, 'retain the canonical memory proof, do not issue a new one');
    assert.equal(producer.memory, predecessor.memory);
    assert.equal(producer.store, predecessor.store);
    assert.equal(producer.input, predecessor.input);
    assert.equal(projector.readProjectedMemoryOperandTransition(ir, source), null,
      'do not silently reseal the original observer after facade writes');
    assert.equal(facade.readFacadeProjectedMemoryOperandTransition({ ...ir }, source), null);
    assert.equal(facade.readFacadeProjectedMemoryOperandTransition(ir, { ...source }), null);
    source.extra = { ...source.extra };
    assert.equal(producer.isCurrent(), false);
    assert.equal(facade.readFacadeProjectedMemoryOperandTransition(ir, source), null,
      'a later caller-owned metadata write cannot refresh the private facade handoff');
  });
}
