import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry, provenanceFromSourceMap } from '../../../tools/validation/phase8/decompile-corpus.mjs';
import { loadFrozenProvenance } from '../../../tools/validation/phase8/metrics.mjs';
import * as facade from '../../../js/ir-core.js';
import * as projector from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { readLineExpressionHistory } from '../../../js/decompiler/phase8/projection.js';
import * as renderHistory from '../../../js/decompiler/phase8/render-provenance.js';
import { PROJECTION_LIMITS } from '../../../js/core/identity/live-data.js';
import { createOriginSet } from '../../../js/core/identity/origin.js';
import { createCapstoneX86Session } from '../../phase5/helpers/capstone-session.mjs';
import { createX86DecodedInstruction, X86_DECODER_SEMANTIC_VERSION } from '../../../js/targets/architecture/x86_64/decoded-instruction.js';
import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { resolveABIPlugin } from '../../../js/targets/abi/index.js';
import { partitionDecodedFunction, semanticAbiAdapter, decompilerSnapshot } from '../../../js/analysis/semantic-function.js';
import { buildSemanticV2CompatibilityPipeline } from '../../../js/semantics/compat/index.js';
import { compatOperationEventCandidate } from '../../../js/decompiler/pipeline-core.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/app-adapter.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { readSwitchLineHistory } from '../../../js/decompiler/switch.js';
import { readSemanticStoreLineHistory, readSemanticStatementLineHistory,
  readSemanticControlLineHistory } from '../../../js/decompiler/semantic-core.js';

for (const id of ['quality.aggregate_array_stride.O2','quality.loop_nested.O2',
  'x86_64.quality.aggregate_array_stride.O2','x86_64.quality.loop_nested.O2']) {
  test(`C4-03 native remaining producer-event consumers retain every distinct mapping (${id})`, async () => {
    const corpus = loadCorpus(), index = corpus.functions.findIndex(entry => entry.id === id);
    assert.ok(index >= 0);
    const { result, failure } = decompileEntry(corpus.functions[index], {
      index, decompilerTimeBudgetMs:20000, toolchain:corpus.toolchain ?? null,
    });
    assert.equal(failure ?? null,null);
    const map = result.renderProvenance;
    assert.equal(result.expressionHistoryBinding.completeness,'complete');
    assert.equal(result.phase8Projection.history.completeness,'complete');
    assert.equal(map.completeness,'complete',JSON.stringify(map.reasons));
    assert.equal(renderHistory.validateRenderProvenance(map).state,'complete');
    assert.equal(map.budget.maxTransformRecords,2048);
    assert.equal(map.budget.maxConsumerWitnesses,4096);
    assert.equal(map.counts.ledgerTruncated,0);
    assert.equal(map.counts.provenanceLoss,0);
    const witnesses = renderHistory.renderExpressionWitnesses(map);
    assert.equal(witnesses.length,result.rewriteProof.length);
    assert.deepEqual(witnesses.map(record => [record.rule,record.before,record.after,record.valueId]),
      result.rewriteProof.map(record => [record.rule,record.before,record.after,record.valueId ?? null]));
    const refsOf = origin => ['rows','addresses','ir','ssaDefs','ssaUses'].flatMap((key,index) =>
      (origin[key] || []).map(value => `${['row','addr','ir','ssa:def','ssa:use'][index]}:${value}`));
    for (const witness of witnesses) {
      const original = result.rewriteProof[witness.sourceRecordIndex];
      for (const ref of refsOf(original.originHistory.before)) assert.ok(witness.originHistory.consumedRefs.includes(ref));
      for (const ref of refsOf(original.originHistory.after)) assert.ok(witness.originHistory.producedRefs.includes(ref));
    }
    const bindings = new Map(Object.values(map.entities).map(entity => {
      const line = result.lines[entity.lineIndex], ir = result.ir;
      return [entity.entityKey, new Set(readLineExpressionHistory(line,ir)
        || readSwitchLineHistory(line,ir)?.records || readSemanticStoreLineHistory(line,ir)?.records
        || readSemanticStatementLineHistory(line,ir)?.records || readSemanticControlLineHistory(line,ir)?.records || [])];
    }));
    const groups = map.ledger.filter(record => record.kind === 'state-consumer-group');
    assert.ok(groups.length);
    for (const group of groups) {
      const index = map.ledger.indexOf(group), events = new Set();
      assert.ok(Object.isFrozen(group.consumerWitnesses));
      assert.ok(Object.values(group.origin).every(values => values.length === 0),'group headers do not union consumer sources');
      for (const witness of group.consumerWitnesses) {
        const original = result.rewriteProof[witness.sourceRecordIndex];
        events.add(compatOperationEventCandidate(original,result.ir));
        for (const [entity, records] of bindings) assert.equal(witness.producedRefs.includes(entity),records.has(original));
        for (const ref of [...witness.originHistory.consumedRefs,...witness.originHistory.producedRefs]) {
          assert.ok(map.transformReverse[ref].includes(index));
        }
      }
      assert.equal(events.size,1);
      assert.equal([...events][0].stage,'public-state-normalization');
    }
    const reference = loadFrozenProvenance().observations.find(entry => entry.id === id);
    const actual = provenanceFromSourceMap(result.sourceMap);
    assert.deepEqual(reference.sourceAddresses.filter(address => !actual.sourceAddresses.includes(address)),[]);
    let epoch = 1;
    const api = new AnalysisQueryAPI({
      ...createAppAnalysisQueryAdapter({ analyzeFunction:async () => ({ decompiler:decompilerSnapshot(result) }) }),
      currentIdentity:async () => ({ binaryId:id,projectRevision:1,analysisEpoch:epoch,artifactVersions:{} }),
    });
    const query = await api.decompile(await api.snapshot(),'function');
    const navigation = createDecompilerNavigation(query,{ currentSnapshot:() => api.snapshot() });
    assert.equal(navigation.available,true,navigation.reason);
    const group = groups.find(record => record.producedRefs.length);
    assert.ok(group);
    for (const entityKey of group.producedRefs) {
      const selected = await navigation.selectLine(map.entities[entityKey].lineIndex);
      assert.equal(selected.state,'ready');
      const members = selected.transforms.filter(record => group.consumerWitnesses.some(member => member.sourceRecordIndex === record.sourceRecordIndex));
      assert.deepEqual(members.map(record => record.sourceRecordIndex).sort((a,b)=>a-b),
        group.consumerWitnesses.filter(record => record.producedRefs.includes(entityKey)).map(record=>record.sourceRecordIndex).sort((a,b)=>a-b));
    }
    const ref = group.consumerWitnesses[0].originHistory.consumedRefs.find(ref=>ref.startsWith('ir:'));
    assert.ok(ref);
    assert.equal((await navigation.selectOrigin('ir',ref.slice(3))).state,'ready');
    epoch++;
    assert.equal((await navigation.selectLine(0)).state,'unavailable');
    if (id === 'x86_64.quality.loop_nested.O2') {
      const limited = renderHistory.buildRenderProvenance({ result,snapshotId:map.snapshotId,budget:{ maxTransformRecords:1024 } });
      assert.equal(limited.completeness,'incomplete');
      assert.ok(limited.ledger.length <= 1024 && limited.counts.ledgerTruncated > 0);
    }
    if (id !== 'quality.aggregate_array_stride.O2') return;
    const limited = renderHistory.buildRenderProvenance({ result,snapshotId:map.snapshotId,budget:{ maxConsumerWitnesses:1 } });
    assert.equal(limited.completeness,'incomplete');
    assert.equal(limited.counts.expressionConsumerWitnesses,1);
    const groupIndex = map.ledger.indexOf(group);
    for (const mutate of [
      record => { record.consumerWitnesses = []; },
      record => { record.kind = 'external-description'; },
      record => { record.publicNormalization = null; },
      record => { record.consumerWitnesses[0].consumerWitnesses = []; },
      record => { delete record.consumerWitnesses[0].originHistory; },
      record => { record.consumerWitnesses[0].before = 'other'; },
      record => { record.consumerWitnesses[0].producedRefs = ['L99999:stmt']; },
      record => { record.consumerWitnesses[0].sourceRecordIndex = record.consumerWitnesses[1].sourceRecordIndex; },
    ]) {
      const changed = { ...map,ledger:[...map.ledger] };
      changed.ledger[groupIndex] = structuredClone(group); mutate(changed.ledger[groupIndex]);
      assert.equal(renderHistory.validateRenderProvenance(changed).state,'incomplete');
    }
    for (const key of ['groupedExpressionWitnesses','sourceRecordWitnesses','expressionConsumerWitnesses']) {
      const changed = { ...map,counts:{ ...map.counts,[key]:map.counts[key] - 1 } };
      assert.equal(renderHistory.validateRenderProvenance(changed).state,'incomplete');
    }
    const copied = renderHistory.buildRenderProvenance({ result:{ ...result,
      rewriteProof:result.rewriteProof.map(record=>({ ...record })) },snapshotId:map.snapshotId });
    assert.ok(!copied.ledger.some(record=>record.kind==='state-consumer-group'));
    for (const mutate of [() => {},record => { record.kind = 'external-description'; }]) {
      const copied = structuredClone(group); mutate(copied);
      const unissued = renderHistory.buildRenderProvenance({ result:{ lines:result.lines,
        phase8Projection:{ transforms:[copied] } },snapshotId:map.snapshotId });
      assert.deepEqual(unissued.ledger,[]);
      assert.ok(unissued.reasons.includes('unissued-state-consumer-group'));
    }
  });
}

test('C4-03 native x86 counted loop retains certified descriptions and its complete dense origin set', () => {
  const corpus = loadCorpus(), id = 'x86_64.quality.loop_counted_sum.O2';
  const index = corpus.functions.findIndex(entry => entry.id === id);
  assert.ok(index >= 0);
  const { result, failure } = decompileEntry(corpus.functions[index], {
    index, decompilerTimeBudgetMs:20000, toolchain:corpus.toolchain ?? null,
  });
  assert.equal(failure ?? null, null);
  assert.equal(PROJECTION_LIMITS.nodes, 10000);
  assert.equal(PROJECTION_LIMITS.edges, 100000);
  assert.equal(result.expressionHistoryBinding.completeness, 'complete');
  assert.equal(result.phase8Projection.history.completeness, 'complete');
  const map = result.renderProvenance;
  assert.equal(map.completeness, 'complete');
  assert.deepEqual(map.reasons, []);
  assert.equal(renderHistory.validateRenderProvenance(map).state, 'complete');
  assert.equal(map.budget.maxTransformRecords, 2048);
  assert.equal(map.budget.maxOriginsPerEntity, 1024);
  assert.equal(map.counts.ledgerTruncated, 0);
  assert.equal(map.counts.provenanceLoss, 0);
  const dense = Object.values(map.entities).find(entity => Object.values(entity.origins).reduce((n, values) => n + values.length, 0) === 525);
  assert.ok(dense, 'retain every actually observed origin, not a truncated 512-entry subset');
  for (const [kind, values] of Object.entries({ row:dense.origins.rows, addr:dense.origins.addresses,
    ir:dense.origins.ir, ssa:dense.origins.ssaRefs })) {
    for (const value of values) assert.ok(map.reverse[`${kind}:${value}`].includes(dense.entityKey));
  }
  const bounded = renderHistory.buildRenderProvenance({ result, snapshotId:map.snapshotId,
    budget:{ maxOriginsPerEntity:512 } });
  assert.equal(bounded.completeness, 'incomplete');
  assert.ok(bounded.reasons.includes('truncated'));
  assert.equal(Object.values(bounded.entities[dense.entityKey].origins).reduce((n, values) => n + values.length, 0), 512);
  const reference = loadFrozenProvenance().observations.find(entry => entry.id === id);
  const actual = provenanceFromSourceMap(result.sourceMap);
  assert.deepEqual(reference.sourceAddresses.filter(address => !actual.sourceAddresses.includes(address)), []);
  const line = result.lines[dense.lineIndex];
  assert.ok(readLineExpressionHistory(line, result.ir)?.length);
  assert.equal(readLineExpressionHistory({ ...line }, result.ir), null);
  const input = result.ir.values.find(value => dense.origins.ssaRefs.includes(`def:${value.id}`)
    && value.machineType && Object.isFrozen(value.machineType));
  assert.ok(input);
  input.machineType = Object.freeze({ ...input.machineType });
  assert.equal(readLineExpressionHistory(line, result.ir), null, 'equal immutable descriptions cannot refresh the original input binding');
});

test('C4-03 native counted loop preserves all normalization witnesses within the bounded default ledger', () => {
  const corpus = loadCorpus(), id = 'quality.loop_counted_sum.O2';
  const index = corpus.functions.findIndex(entry => entry.id === id);
  assert.ok(index >= 0);
  const { result, failure } = decompileEntry(corpus.functions[index], {
    index, decompilerTimeBudgetMs:20000, toolchain:corpus.toolchain ?? null,
  });
  assert.equal(failure ?? null, null);
  const map = result.renderProvenance;
  assert.equal(result.expressionHistoryBinding.completeness, 'complete');
  assert.equal(map.completeness, 'complete');
  assert.deepEqual(map.reasons, []);
  assert.equal(renderHistory.validateRenderProvenance(map).state, 'complete');
  assert.equal(map.budget.maxTransformRecords, 2048);
  assert.equal(map.counts.ledgerTruncated, 0);
  assert.equal(map.counts.provenanceLoss, 0);
  // Current main projects non-constant address arithmetic as a canonical
  // `bin:add` node so SCCP cannot discard the index operand.  The pre-main
  // MOV projection emitted three additional selection witnesses; the current
  // representation intentionally has the corresponding 935/1188/925 totals.
  assert.equal(map.ledger.length + map.counts.groupedExpressionWitnesses, 935);
  assert.equal(map.counts.sourceRecordWitnesses, 1188);
  assert.equal(map.counts.attachedPublicStateNormalizations, 253);
  const expressions = renderHistory.renderExpressionWitnesses(map);
  assert.equal(result.rewriteProof.length, 925);
  assert.equal(expressions.length, result.rewriteProof.length, 'no expression consumer mapping is coalesced');
  assert.deepEqual(expressions.map(record => [record.rule, record.before, record.after, record.valueId]),
    result.rewriteProof.map(record => [record.rule, record.before, record.after, record.valueId ?? null]));
  const witnesses = renderHistory.renderPublicStateNormalizations(map);
  assert.equal(witnesses.length, 261);
  const history = facade.readFacadeStateNormalization(result.ir) || projector.readProjectedStateNormalization(result.ir);
  assert.ok(history);
  assert.deepEqual(witnesses.map(record => record.publicStateTransition.ordinal).sort((a,b) => a-b),
    history.events.map(event => event.ordinal).sort((a,b) => a-b));
  for (const witness of witnesses) {
    assert.deepEqual(witness.producedRefs, []);
    assert.deepEqual(witness.removedRefs, []);
    const owner = map.ledger.findIndex(record => renderHistory.renderRecordWitnesses(record)
      .some(member => member === witness || member.publicNormalization === witness));
    assert.ok(owner >= 0);
    for (const ref of witness.publicStateTransition.consumedRefs) assert.ok(map.transformReverse[ref].includes(owner));
  }
  const reference = loadFrozenProvenance().observations.find(entry => entry.id === id);
  const actual = provenanceFromSourceMap(result.sourceMap);
  assert.deepEqual(reference.sourceAddresses.filter(address => !actual.sourceAddresses.includes(address)), []);
  const lines = result.lines.filter(line => readLineExpressionHistory(line, result.ir)?.length);
  assert.ok(lines.length > 1);
  result.ir.values = [...result.ir.values];
  assert.ok(lines.every(line => readLineExpressionHistory(line, result.ir) === null));
  const stale = renderHistory.buildRenderProvenance({ result });
  assert.equal(stale.completeness, 'incomplete');
  assert.equal(renderHistory.renderPublicStateNormalizations(stale).length, 0);
});

test('C4-03 native early-exit loop binds immutable origin envelopes and all actual state histories', () => {
  const corpus = loadCorpus(), id = 'riscv64.quality.loop_early_exit.O0';
  const index = corpus.functions.findIndex(entry => entry.id === id);
  assert.ok(index >= 0);
  const { result, failure } = decompileEntry(corpus.functions[index], {
    index, decompilerTimeBudgetMs:20000, toolchain:corpus.toolchain ?? null,
  });
  assert.equal(failure ?? null, null);
  assert.equal(PROJECTION_LIMITS.nodes, 10000);
  assert.equal(PROJECTION_LIMITS.edges, 100000);
  assert.equal(PROJECTION_LIMITS.depth, 96);
  assert.equal(result.expressionHistoryBinding.completeness, 'complete');
  assert.deepEqual(result.expressionHistoryBinding.reasons, []);
  assert.equal(result.phase8Projection.history.completeness, 'complete');
  assert.equal(result.renderProvenance.completeness, 'complete');
  assert.deepEqual(result.renderProvenance.reasons, []);
  assert.equal(result.renderProvenance.counts.ledgerTruncated, 0);
  const states = result.rewriteProof.filter(record => record.rule === 'compact-public-state');
  assert.ok(states.length > 300, 'the actual previously missing producer operations are retained');
  assert.equal(new Set(states).size, states.length);
  const reference = loadFrozenProvenance().observations.find(entry => entry.id === id);
  const actual = provenanceFromSourceMap(result.sourceMap);
  assert.deepEqual(reference.sourceAddresses.filter(address => !actual.sourceAddresses.includes(address)), []);
  const lines = result.lines.filter(line => readLineExpressionHistory(line, result.ir)?.length);
  assert.ok(lines.length > 1);
  const source = result.ir.instructions.find(instruction => instruction.origin);
  assert.ok(source);
  const before = source.origin;
  source.origin = createOriginSet({ ...before });
  assert.notEqual(source.origin, before);
  assert.ok(lines.every(line => readLineExpressionHistory(line, result.ir) === null),
    'equal canonical data cannot replace the envelope used by the observed producer');
});

test('C4-03 native switch retains pre-memory constant reads through actual state aliases before display projection', async () => {
  const corpus = loadCorpus(), id = 'x86_64.quality.structure_switch.O0';
  const index = corpus.functions.findIndex(entry => entry.id === id);
  assert.ok(index >= 0);
  const entry = corpus.functions[index];
  assert.equal(entry.representation, 'machine-bytes');
  const bytes = Uint8Array.from(Buffer.from(entry.bytes, 'hex'));
  const session = await createCapstoneX86Session();
  try {
    const decoded = session.decode(bytes, 0x100000n + BigInt(index) * 0x10000n);
    assert.equal(decoded.reduce((sum, inst) => sum + Number(inst.length ?? inst.size), 0), bytes.length);
    const instructions = decoded.map((inst, i) => createX86DecodedInstruction({
      ...inst, instructionId:`phase8:${id}:${i}`,
    }));
    const architecturePlugin = architecturePluginV2('x86_64');
    const abiAdapter = semanticAbiAdapter(resolveABIPlugin({ architecture:'x86_64', platform:'linux' }));
    const blocks = partitionDecodedFunction(instructions, architecturePlugin);
    const { legacyV1:ir } = buildSemanticV2CompatibilityPipeline({
      architecturePlugin, abiAdapter, blocks, entryBlockKey:blocks[0].key,
      decoderSemanticVersion:X86_DECODER_SEMANTIC_VERSION,
      binaryId:`phase8-corpus:${id}`, sliceId:`x86_64:${entry.optimization}`,
      addressWidthBits:64, mode:'long-64',
      machineEffectsContext:{ dataEndianness:'little', instructionEndianness:'little' },
    }, { abiAdapter });
    const sources = ir.instructions.filter(source => projector.projectedConstantTransitionExpected(ir, source));
    assert.equal(sources.length, 4, 'all actual constant producers, including the two formerly lost reads');
    const records = sources.map(source => projector.readProjectedConstantTransitions(ir, source));
    assert.ok(records.every(Boolean));
    const aliased = records.flatMap(record => record.events.flatMap(event => event.inputs
      .filter(input => input.argument.value !== input.value).map(input => ({ record, event, input }))));
    assert.equal(aliased.length, 2);
    for (const { record, event, input } of aliased) {
      assert.equal(event.stage, 'pre-memory-scalar-constants');
      assert.ok(event.beforeInputs.includes(input.value));
      const state = projector.readProjectedStateTransitions(ir, input.argument);
      assert.ok(state?.events.some(write => write.kind === 'resolve-state-alias'
        && write.source === event.source && write.before === input.value && write.after === input.argument.value));
      assert.equal(record.isCurrent(), true);
      assert.equal(projector.readProjectedConstantTransitions({ ...ir }, record.source), null);
    }
    aliased[0].input.value.const = null;
    assert.equal(aliased[0].record.isCurrent(), false);
    assert.equal(projector.readProjectedConstantTransitions(ir, aliased[0].record.source), null);
  } finally { session.close(); }
});

for (const id of ['riscv64.quality.aggregate_array_stride.O0', 'riscv64.quality.loop_counted_sum.O0',
  'x86_64.quality.loop_counted_sum.O0']) {
  test(`C4-03 native canonical list storage retains full distinct state histories (${id})`, () => {
    const corpus = loadCorpus(), index = corpus.functions.findIndex(entry => entry.id === id);
    assert.ok(index >= 0);
    const { result, failure } = decompileEntry(corpus.functions[index], {
      index, decompilerTimeBudgetMs:20000, toolchain:corpus.toolchain ?? null,
    });
    assert.equal(failure ?? null, null);
    assert.equal(PROJECTION_LIMITS.nodes, 10000);
    assert.equal(PROJECTION_LIMITS.edges, 100000);
    assert.equal(PROJECTION_LIMITS.depth, 96);
    assert.equal(result.expressionHistoryBinding.completeness, 'complete');
    assert.deepEqual(result.expressionHistoryBinding.reasons, []);
    assert.equal(result.phase8Projection.history.completeness, 'complete');
    assert.equal(result.renderProvenance.completeness, 'complete');
    assert.deepEqual(result.renderProvenance.reasons, []);
    assert.equal(result.renderProvenance.budget.maxTransformRecords, 2048);
    assert.equal(result.renderProvenance.counts.ledgerTruncated, 0);
    const states = result.rewriteProof.filter(record => record.rule === 'compact-public-state');
    assert.ok(states.length > 0);
    assert.equal(new Set(states).size, states.length, 'actual state operations remain distinct');
    const reference = loadFrozenProvenance().observations.find(entry => entry.id === id);
    const actual = provenanceFromSourceMap(result.sourceMap);
    assert.deepEqual(reference.sourceAddresses.filter(address => !actual.sourceAddresses.includes(address)), []);
    const lines = result.lines.filter(line => readLineExpressionHistory(line, result.ir)?.length);
    assert.ok(lines.length > 1);
    assert.equal(readLineExpressionHistory({ ...lines[0] }, result.ir), null);
    assert.equal(readLineExpressionHistory(lines[0], { ...result.ir }), null);
    result.ir.values = [...result.ir.values];
    assert.ok(lines.every(line => readLineExpressionHistory(line, result.ir) === null));
  });
}

test('C4-03 native nested loop retains initial expression, statement and control graph histories', () => {
  const corpus = loadCorpus(), id = 'quality.loop_nested.O1';
  const index = corpus.functions.findIndex(entry => entry.id === id);
  assert.ok(index >= 0);
  const { result, failure } = decompileEntry(corpus.functions[index], {
    index, decompilerTimeBudgetMs:20000, toolchain:corpus.toolchain ?? null,
  });
  assert.equal(failure ?? null, null);
  assert.equal(PROJECTION_LIMITS.nodes, 10000);
  assert.equal(PROJECTION_LIMITS.edges, 100000);
  assert.equal(PROJECTION_LIMITS.depth, 96);
  assert.equal(result.expressionHistoryBinding.completeness, 'complete');
  assert.deepEqual(result.expressionHistoryBinding.reasons, []);
  assert.equal(result.phase8Projection.history.completeness, 'complete');
  assert.equal(result.renderProvenance.completeness, 'complete');
  assert.deepEqual(result.renderProvenance.reasons, []);
  assert.equal(result.renderProvenance.budget.maxTransformRecords, 2048);
  assert.equal(result.renderProvenance.counts.ledgerTruncated, 0);
  assert.ok(result.rewriteProof.length > 400, 'retain the actual native history');
  const reference = loadFrozenProvenance().observations.find(entry => entry.id === id);
  const actual = provenanceFromSourceMap(result.sourceMap);
  assert.deepEqual(reference.sourceAddresses.filter(address => !actual.sourceAddresses.includes(address)), []);
  const lines = result.lines.filter(line => readLineExpressionHistory(line, result.ir)?.length);
  assert.ok(lines.length > 1);
  assert.equal(readLineExpressionHistory({ ...lines[0] }, result.ir), null);
  assert.equal(readLineExpressionHistory(lines[0], { ...result.ir }), null);
  result.ir.instructions = [...result.ir.instructions];
  assert.ok(lines.every(line => readLineExpressionHistory(line, result.ir) === null));
});

test('C4-03 native producer graph retains full history through immutable precondition storage', () => {
  const corpus = loadCorpus(), id = 'quality.gvn_repeated_expression.O0';
  const index = corpus.functions.findIndex(entry => entry.id === id);
  assert.ok(index >= 0);
  const { result, failure } = decompileEntry(corpus.functions[index], {
    index, decompilerTimeBudgetMs:20000, toolchain:corpus.toolchain ?? null,
  });
  assert.equal(failure ?? null, null);
  assert.equal(PROJECTION_LIMITS.nodes, 10000);
  assert.equal(PROJECTION_LIMITS.edges, 100000);
  assert.equal(PROJECTION_LIMITS.depth, 96);
  assert.equal(result.expressionHistoryBinding.completeness, 'complete');
  assert.equal(result.phase8Projection.history.completeness, 'complete');
  assert.equal(result.renderProvenance.completeness, 'complete');
  assert.deepEqual(result.renderProvenance.reasons, []);
  assert.equal(result.renderProvenance.budget.maxTransformRecords, 2048);
  assert.equal(result.renderProvenance.counts.ledgerTruncated, 0);
  const states = result.rewriteProof.filter(record => record.rule === 'compact-public-state');
  assert.ok(states.length > 200, 'the formerly unavailable real producer history is present');
  assert.equal(new Set(states).size, states.length, 'distinct state operations are not merged by equal payload');
  const reference = loadFrozenProvenance().observations.find(entry => entry.id === id);
  const actual = provenanceFromSourceMap(result.sourceMap);
  assert.deepEqual(reference.sourceAddresses.filter(address => !actual.sourceAddresses.includes(address)), []);
  const producer = facade.facadeStateTransitionCandidates(result.ir);
  assert.ok(producer?.isCurrent());
  assert.equal(facade.facadeStateTransitionCandidates({ ...result.ir }), null);
  const lines = result.lines.filter(line => readLineExpressionHistory(line, result.ir)?.length);
  assert.ok(lines.length > 1);
  assert.equal(readLineExpressionHistory({ ...lines[0] }, result.ir), null);
  result.ir.values = [...result.ir.values];
  assert.equal(producer.isCurrent(), false);
  assert.ok(lines.every(line => readLineExpressionHistory(line, result.ir) === null));
});

test('C4-03 native aggregate loop binds every rendered entity within the bounded default budget', () => {
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

test('C4-03 native RISC-V state histories retain control handoff within the bounded default ledger', () => {
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
  assert.equal(result.renderProvenance.budget.maxTransformRecords, 2048);
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
  assert.equal(result.renderProvenance.budget.maxTransformRecords, 2048);
  const actual = provenanceFromSourceMap(result.sourceMap);
  assert.deepEqual(reference.sourceAddresses.filter(address => !actual.sourceAddresses.includes(address)), []);
  const lines = result.lines.filter(line => readLineExpressionHistory(line, result.ir)?.length);
  assert.ok(lines.length > 1);
  assert.equal(readLineExpressionHistory({ ...lines[0] }, result.ir), null);
  result.ir.instructions = [...result.ir.instructions];
  assert.ok(lines.every(line => readLineExpressionHistory(line, result.ir) === null),
    'shared construction inputs retain exact mutable root identity after publication');
});

for (const optimization of ['O1', 'O2']) test(`C4-03 native cyclic construction retains complete history in bounded snapshot storage (${optimization})`, () => {
  const corpus = loadCorpus(), id = `quality.loop_decrement_step.${optimization}`;
  const index = corpus.functions.findIndex(entry => entry.id === id);
  assert.ok(index >= 0);
  const { result, failure } = decompileEntry(corpus.functions[index], {
    index, decompilerTimeBudgetMs:20000, toolchain:corpus.toolchain ?? null,
  });
  assert.equal(failure ?? null, null);
  assert.equal(PROJECTION_LIMITS.depth, 96);
  assert.equal(PROJECTION_LIMITS.nodes, 10000);
  assert.equal(PROJECTION_LIMITS.edges, 100000);
  assert.ok(!result.expressionHistoryBinding.reasons.includes('compat-state-construction-observation-unavailable'));
  assert.ok(!result.expressionHistoryBinding.reasons.includes('compat-constant-selection-observation-unavailable'));
  assert.equal(result.semanticStatementRenderHistory.completeness, 'complete');
  assert.equal(result.expressionHistoryBinding.completeness, 'complete');
  assert.equal(result.phase8Projection.history.completeness, 'complete');
  assert.equal(result.renderProvenance.completeness, 'complete');
  assert.deepEqual(result.renderProvenance.reasons, []);
  const selections = result.rewriteProof.filter(record => record.rule === 'select-mov-operand');
  assert.ok(selections.length > 50, 'actual native selections, not an empty-history success');
  assert.equal(new Set(selections.map(record => record.originHistory)).size, selections.length,
    'inherited selections are the same issued operation, not a cloned downstream transform');
  assert.equal(result.renderProvenance.budget.maxTransformRecords, 2048);
  assert.equal(result.renderProvenance.counts.ledgerTruncated, 0);
  const reference = loadFrozenProvenance().observations.find(entry => entry.id === id);
  const actual = provenanceFromSourceMap(result.sourceMap);
  assert.deepEqual(reference.sourceAddresses.filter(address => !actual.sourceAddresses.includes(address)), []);
  const lines = result.lines.filter(line => readLineExpressionHistory(line, result.ir)?.length);
  assert.ok(lines.length > 1);
  assert.equal(readLineExpressionHistory({ ...lines[0] }, result.ir), null);
  result.ir.values = [...result.ir.values];
  assert.ok(lines.every(line => readLineExpressionHistory(line, result.ir) === null));
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
