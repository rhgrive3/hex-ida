import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeDecodedSemanticFunction, semanticAbiAdapter, partitionDecodedFunction } from '../../../js/analysis/semantic-function.js';
import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { createAnalysisSurface } from '../../../js/analysis/index.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/index.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { buildSemanticSsa, validateSemanticSsa } from '../../../js/semantics/ssa/index.js';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { classifyCallTargetProof, createSemanticCallTargetClassifier, createFunctionSummary, functionSummaryDigest, summaryIsPure } from '../../../js/analysis/summary/contract.js';
import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { RISCV_LP64_ABI } from '../../../js/targets/abi/index.js';
import { createRiscv64DecodedInstruction } from '../../../js/targets/architecture/riscv64/decoded-instruction.js';
import { buildSemanticV2CompatibilityPipeline } from '../../../js/semantics/compat/index.js';
import { buildRenderProvenance, validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { stableDigest } from '../../../js/core/identity/index.js';

const snapshotId = 'native-abi-return-snapshot';
function fixture({ returnType = 'int64', words = [0x00150513, 0x00008067], parameters = null, adapterOptions = {}, options = {}, baseAddress = 0x2000n, inputOptions = {} } = {}) {
  const architecture = architecturePluginV2('riscv64');
  const instructions = words.map((word, index) => createRiscv64DecodedInstruction({
    address:baseAddress + BigInt(index * 4), size:4, mode:'rv64imc',
    rawBytes:Uint8Array.from([word & 255, (word >>> 8) & 255, (word >>> 16) & 255, word >>> 24]),
    instructionId:`native-return-${index}`, origin:{ instructionIds:[`native-return-${index}`] },
  }));
  const blocks = partitionDecodedFunction(instructions, architecture);
  const prototype = returnType == null ? null : { returnType, ...(parameters == null ? {} : { parameters }) };
  const adapter = semanticAbiAdapter(RISCV_LP64_ABI, {
    architecture:'riscv64', platform:'linux', binaryId:'native-return-binary', sliceId:'0', snapshotId,
    functionPrototype:prototype, ...adapterOptions,
  });
  const pipeline = buildSemanticV2CompatibilityPipeline({
    architecturePlugin:architecture, decoderSemanticVersion:'native-return-decoder',
    binaryId:'native-return-binary', sliceId:'0', addressWidthBits:64, mode:'rv64imc',
    entryBlockKey:blocks[0].key, blocks, abiAdapter:adapter, functionPrototype:prototype, ...inputOptions,
  }, { snapshotId, ...options });
  const result = buildLocalFunctionSummary(pipeline.semanticIr, pipeline.cfg, pipeline.ssa, pipeline.memorySsa, { snapshotId });
  return { pipeline, adapter, result, prototype, instructions, returns:pipeline.semanticIr.nodes.filter(node => node.kind === 'return') };
}

test('declared ABI result enters native IR, SSA and the default local summary', () => {
  const { pipeline, adapter, result, returns } = fixture();
  assert.equal(returns.length, 1);
  assert.equal(returns[0].inputs.length, 1);
  const valueId = returns[0].inputs[0];
  const value = pipeline.semanticIr.values.find(item => item.id === valueId);
  const read = pipeline.semanticIr.nodes.find(node => node.id === value.definitionNodeId);
  assert.equal(read.kind, 'state-read');
  assert.equal(read.variable.physicalIdentity.registerId, 'x10', 'RV64 a0 is not the architectural RET target x1');
  assert.deepEqual(returns[0].attributes.abiReturnBinding.location, adapter.returnLocations({})[0]);
  const use = pipeline.ssa.uses.find(item => item.sourceEntityId === read.id);
  const definition = pipeline.ssa.definitions.find(item => item.valueId === use.valueId);
  assert.equal(definition.kind, 'definition');
  assert.equal(pipeline.semanticIr.nodes.find(node => node.id === definition.sourceEntityId)?.kind, 'state-write');
  assert.deepEqual(result.summary.returnValues, [valueId]);
  assert.deepEqual(result.summary.returnProvenance, [{ kind:'unknown', returnIndex:0,
    argIndex:null, offset:null, rootEntityId:null }], 'placement alone cannot invent pointer provenance');
  assert.equal(functionSummaryDigest(result.summary), functionSummaryDigest(fixture().result.summary));
});

const parameters = Array.from({ length:3 }, () => ({ type:'int64', bits:64 }));
const facts = summary => summary.returnProvenance.map(({ kind, argIndex, offset }) => ({ kind, argIndex, offset }))
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

test('native SSA follows the actual declared entry argument and offset', () => {
  for (const [words, index, offset] of [
    [[0x00150513, 0x00008067], 0, '1'],
    [[0x00058513, 0x00008067], 1, '0'],
  ]) {
    const f = fixture({ parameters, words });
    assert.deepEqual(facts(f.result.summary), [{ kind:'arg', argIndex:index, offset }]);
    assert.equal(f.result.status.completeness, 'complete');
    assert.ok(f.result.summary.semanticFacts.some(fact => fact.kind === 'abi-entry-argument' && fact.argumentIndex === index));
    assert.ok(f.result.summary.semanticFacts.some(fact => fact.kind === 'abi-return-location'));
    assert.equal(functionSummaryDigest(f.result.summary), functionSummaryDigest(fixture({ parameters, words }).result.summary));
  }
});

test('the public decoded-function driver forwards the declaration to native summary production', () => {
  const f = fixture({ parameters });
  const result = analyzeDecodedSemanticFunction({ architecture:'riscv64', platform:'linux', abiId:'lp64',
    binaryId:'native-return-binary', sliceId:'0', snapshotId, decoderSemanticVersion:'native-return-decoder',
    instructions:f.instructions, functionPrototype:f.prototype });
  const p = result.pipeline;
  const summary = buildLocalFunctionSummary(p.semanticIr, p.cfg, p.ssa, p.memorySsa, { snapshotId }).summary;
  assert.deepEqual(facts(summary), [{ kind:'arg', argIndex:0, offset:'1' }]);
});

test('register overwrite and narrowing cannot retain full-width entry provenance', () => {
  for (const settings of [
    { words:[0x00700513, 0x00008067] },
    { returnType:'int32' },
    { parameters:[{ type:'int32', bits:32 }] },
  ]) {
    const f = fixture({ parameters, ...settings });
    assert.ok(f.result.summary.returnProvenance.some(fact => fact.kind === 'unknown'));
    assert.equal(f.result.summary.returnProvenance.some(fact => fact.kind === 'arg'), false);
  }
});

test('native SSA phi retains all declared arguments and an unknown alternative', () => {
  for (const [right, unknown] of [[0x00058513, false], [0x00700513, true]]) {
    const f = fixture({ parameters, words:[0x00060663, right, 0x0080006f, 0x00050513, 0x00008067] });
    assert.ok(f.pipeline.ssa.definitions.some(def => def.kind === 'phi'));
    const actual = facts(f.result.summary);
    assert.ok(actual.some(fact => fact.kind === 'arg' && fact.argIndex === 0 && fact.offset === '0'));
    assert.equal(actual.some(fact => fact.kind === 'arg' && fact.argIndex === 1), !unknown);
    assert.equal(actual.some(fact => fact.kind === 'unknown'), unknown);
  }
});

test('loop-carried native return traversal terminates with explicit unknown', () => {
  const f = fixture({ parameters, words:[0x00000013, 0x00150513, 0xfe059ee3, 0x00008067] });
  assert.ok(f.pipeline.ssa.definitions.some(def => def.kind === 'phi'));
  assert.ok(f.result.summary.returnProvenance.some(fact => fact.kind === 'unknown'));
});

test('missing, foreign and forged older SSA definitions cannot authorize native provenance', () => {
  const f = fixture({ parameters, words:[0x00150513, 0x00700513, 0x00008067] }), p = f.pipeline;
  const stale = structuredClone(p.ssa);
  const returnedValue = p.semanticIr.values.find(value => value.id === f.returns[0].inputs[0]);
  const use = stale.uses.find(item => item.sourceEntityId === returnedValue.definitionNodeId);
  const current = stale.definitions.find(def => def.valueId === use.valueId);
  const older = stale.definitions.find(def => def.kind === 'definition'
    && def.variableKey === current.variableKey && def.valueId !== current.valueId);
  assert.ok(older); use.valueId = older.valueId;
  assert.doesNotThrow(() => validateSemanticSsa(stale, p.semanticIr, p.cfg), 'dominance alone permits an obsolete dominating write');
  for (const ssa of [null, { ...p.ssa, functionId:'foreign' }, { ...p.ssa, uses:[] }, stale]) {
    const result = buildLocalFunctionSummary(p.semanticIr, p.cfg, ssa, p.memorySsa, { snapshotId });
    assert.ok(result.summary.returnProvenance.some(fact => fact.kind === 'unknown'));
    assert.equal(result.summary.returnProvenance.some(fact => fact.kind === 'arg'), false);
    assert.equal(result.status.completeness, 'partial');
  }
});

test('ABI entry identity is checked again when the summary snapshot changes', () => {
  const f = fixture({ parameters }), p = f.pipeline;
  const summary = buildLocalFunctionSummary(p.semanticIr, p.cfg, p.ssa, p.memorySsa, { snapshotId:'other' }).summary;
  assert.equal(summary.returnProvenance.some(fact => fact.kind === 'arg'), false);
  assert.deepEqual(summary.semanticFacts, []);
});

function outerCaller(target) {
  const origin = { instructionIds:['outer-call'] }, functionId = 'outer-native-return';
  const ir = createSemanticIrFunction({ functionId, entryBlockId:'entry', origin,
    blocks:[{ id:'entry', nodeIds:['read', 'call', 'return'], origin }],
    values:[{ id:'argument', kind:'definition', definitionNodeId:'read', machineType:{ kind:'bitvector', widthBits:64 }, origin, metadata:{ argumentIndex:0 } },
      { id:'result', kind:'definition', definitionNodeId:'call', machineType:{ kind:'bitvector', widthBits:64 }, origin }],
    nodes:[{ id:'read', kind:'state-read', blockId:'entry', inputs:[], outputs:['argument'], origin,
      variable:{ key:'outer-argument', kind:'physical-state', scope:'function' } },
      { id:'call', kind:'call', blockId:'entry', inputs:['argument'], outputs:['result'], origin,
      call:{ targetEntityIds:[target], arguments:['argument'], returns:['result'], stateReads:[], stateWrites:[],
        memoryRead:{ scope:'none' }, memoryWrite:{ scope:'none' }, determinism:'deterministic',
        noreturn:false, mayThrow:false, completeness:'complete', summarySource:'test-direct-call' } },
      { id:'return', kind:'return', blockId:'entry', inputs:['result'], outputs:[], origin }] });
  const cfg = createSemanticCfg({ functionId, entryBlockId:'entry', blocks:[{ id:'entry', successors:[] }] });
  return { ir, cfg, ssa:buildSemanticSsa(ir, cfg) };
}

test('decoded return provenance improves an actual outer points-to consumer', () => {
  const f = fixture({ parameters:[parameters[0]] }), caller = outerCaller(f.pipeline.functionId);
  const summaries = new Map([[f.pipeline.functionId, f.result.summary]]);
  const result = analyzeLocalPointsTo(caller.ir, caller.cfg, caller.ssa, { snapshotId, summaries });
  const value = result.pointsTo.get('result'), argument = result.pointsTo.get('argument');
  assert.equal(value.top, false);
  assert.equal(value.targets.length, 1);
  assert.equal(value.targets[0].rootEntityId, argument.targets[0].rootEntityId);
  assert.deepEqual(value.targets[0].offsetRange, { min:1n, max:1n, exact:true });
  assert.ok(result.calleeSummaryIds.includes(`summary:${functionSummaryDigest(f.result.summary)}`));
  const unknown = fixture({ parameters:[parameters[0]], words:[0x00700513, 0x00008067] });
  const negative = analyzeLocalPointsTo(caller.ir, caller.cfg, caller.ssa, {
    snapshotId, summaries:new Map([[unknown.pipeline.functionId, unknown.result.summary]]) });
  assert.equal(negative.pointsTo.get('result').top, true);
});

test('serialized and reordered native SSA preserves the public summary digest', () => {
  const f = fixture({ parameters });
  const { semanticIr, cfg, ssa, memorySsa } = f.pipeline;
  const p = structuredClone({ semanticIr, cfg, ssa, memorySsa });
  p.ssa.definitions.reverse(); p.ssa.uses.reverse();
  const result = buildLocalFunctionSummary(p.semanticIr, p.cfg, p.ssa, p.memorySsa, { snapshotId });
  assert.equal(functionSummaryDigest(result.summary), functionSummaryDigest(f.result.summary));
  assert.deepEqual(facts(result.summary), [{ kind:'arg', argIndex:0, offset:'1' }]);
  const binding = p.semanticIr.nodes.find(node => node.kind === 'return').attributes.abiReturnBinding;
  assert.equal(Object.isFrozen(binding), false, 'summary publication cannot freeze caller-owned deserialized IR');
  assert.notEqual(result.summary.semanticFacts.find(fact => fact.kind === 'abi-return-location'), binding);
});

const callPrototype = { parameters:[{ type:'int64', bits:64 }], returnType:'int64' };
const callFixture = (settings = {}) => fixture({ parameters:[parameters[0]],
  words:[0x00150513, 0x000010ef, 0x00008067], adapterOptions:{ callPrototype }, ...settings });

function nativePair() {
  const caller = callFixture(), callee = fixture({ baseAddress:0x3004n, parameters:[parameters[0]] });
  const summaries = new Map([[callee.pipeline.functionId, callee.result.summary]]);
  return { caller, callee, summaries };
}

test('decoded immediate CALL resolves an existing same-snapshot callee without changing machine effects', () => {
  const { caller:{ pipeline:p }, callee, summaries } = nativePair();
  const call = p.semanticIr.nodes.find(node => node.kind === 'call');
  const before = structuredClone(p.semanticIr);
  const classify = createSemanticCallTargetClassifier(p.semanticIr, p.memorySsa, {
    snapshotId, summaryForTarget:target => summaries.get(target),
  });
  const proof = classify(call);
  assert.equal(proof.kind, 'direct'); assert.equal(proof.exhaustive, true);
  assert.equal(proof.exactSingletonEntityId, callee.pipeline.functionId);
  assert.equal(proof.nativeTargetFact.summaryDigest, functionSummaryDigest(callee.result.summary));
  assert.equal(classifyCallTargetProof(call.call).exhaustive, false, 'context-free target contract is unchanged');
  const result = buildLocalFunctionSummary(p.semanticIr, p.cfg, p.ssa, p.memorySsa, { snapshotId, calleeSummaries:summaries });
  assert.deepEqual(facts(result.summary), [{ kind:'arg', argIndex:0, offset:'2' }], 'caller ADDI plus callee ADDI');
  assert.equal(result.summary.directCalls[0].summaryId, callee.pipeline.functionId);
  assert.equal(result.summary.unknownCallEffects.length, 0);
  assert.ok(result.summary.semanticFacts.some(fact => fact.kind === 'native-direct-call-target'));
  assert.equal(result.status.completeness, 'complete', 'the contextual summary accounts for every native call obligation');
  assert.equal(p.semanticIr.completeness, 'partial', 'the canonical machine-level unknowns are not erased');
  assert.deepEqual(structuredClone(p.semanticIr), before);
});

test('decoded CALL result reaches the public points-to consumer with the callee digest', () => {
  const { caller:{ pipeline:p }, summaries, callee } = nativePair();
  const call = p.semanticIr.nodes.find(node => node.kind === 'call');
  const result = analyzeLocalPointsTo(p.semanticIr, p.cfg, p.ssa, { snapshotId, summaries, memorySsa:p.memorySsa });
  const returned = result.pointsTo.get(call.outputs[0]), argument = result.pointsTo.get(call.call.arguments[0]);
  assert.equal(returned.top, false);
  assert.equal(returned.targets.length, 1);
  assert.equal(returned.targets[0].rootEntityId, argument.targets[0].rootEntityId);
  assert.deepEqual(returned.targets[0].offsetRange, {
    min:argument.targets[0].offsetRange.min + 1n, max:argument.targets[0].offsetRange.max + 1n, exact:true,
  });
  assert.ok(result.calleeSummaryIds.includes(`summary:${functionSummaryDigest(callee.result.summary)}`));
});

test('native target resolution rejects absent, foreign, stale and conflicting target evidence', () => {
  const { caller:{ pipeline:p }, summaries, callee } = nativePair();
  const call = p.semanticIr.nodes.find(node => node.kind === 'call');
  const cases = [
    { memorySsa:null }, { memorySsa:{ ...p.memorySsa, snapshotId:'foreign' } },
    { memorySsa:{ ...p.memorySsa, identity:{ ...p.memorySsa.identity, semanticIrDigest:'forged' } } },
    { memorySsa:{ ...p.memorySsa, identity:{ ...p.memorySsa.identity, binaryId:'foreign' } } },
    { summaryForTarget:() => null },
    { summaryForTarget:() => createFunctionSummary({ ...callee.result.summary, functionId:'foreign' }) },
    { summaryForTarget:() => createFunctionSummary({ ...callee.result.summary,
      status:{ ...callee.result.summary.status, snapshotId:'foreign' } }) },
    { snapshotId:'foreign' },
  ];
  for (const entry of cases) {
    const classify = createSemanticCallTargetClassifier(p.semanticIr, entry.memorySsa === undefined ? p.memorySsa : entry.memorySsa,
      { snapshotId, summaryForTarget:target => summaries.get(target), ...entry });
    assert.equal(classify(call).exhaustive, false);
  }
  const changed = structuredClone(p.semanticIr), changedCall = changed.nodes.find(node => node.id === call.id);
  changedCall.call.targetEntityIds = [callee.pipeline.functionId];
  assert.equal(createSemanticCallTargetClassifier(changed, p.memorySsa, {
    snapshotId, summaryForTarget:target => summaries.get(target),
  })(changedCall).exhaustive, false, 'conflicting candidate metadata does not get an independent target upgrade');
});

test('partial callee evidence and an opaque sibling CALL retain unknown boundaries', () => {
  const { caller:{ pipeline:p }, summaries, callee } = nativePair();
  const partial = createFunctionSummary({ ...callee.result.summary,
    status:{ ...callee.result.summary.status, completeness:'partial', stopReason:'evidence-missing' } });
  const result = buildLocalFunctionSummary(p.semanticIr, p.cfg, p.ssa, p.memorySsa, {
    snapshotId, calleeSummaries:new Map([[callee.pipeline.functionId, partial]]),
  });
  assert.ok(result.summary.returnProvenance.some(fact => fact.kind === 'unknown'));
  assert.equal(result.status.completeness, 'partial');
  const mixed = callFixture({ words:[0x00150513, 0x000010ef, 0x000020ef, 0x00008067] }).pipeline;
  const composed = buildLocalFunctionSummary(mixed.semanticIr, mixed.cfg, mixed.ssa, mixed.memorySsa, {
    snapshotId, calleeSummaries:summaries,
  });
  assert.equal(composed.summary.directCalls.length, 1);
  assert.equal(composed.summary.unknownCallEffects.length, 1);
  assert.equal(composed.status.completeness, 'partial');
});

test('public decoded driver preserves snapshot binding for native CALL summary lookup', () => {
  const { caller, summaries } = nativePair();
  const result = analyzeDecodedSemanticFunction({ architecture:'riscv64', platform:'linux', abiId:'lp64',
    binaryId:'native-return-binary', sliceId:'0', snapshotId, decoderSemanticVersion:'native-return-decoder',
    instructions:caller.instructions, functionPrototype:caller.prototype, callPrototype });
  const p = result.pipeline;
  assert.equal(p.memorySsa.snapshotId, snapshotId);
  const composed = buildLocalFunctionSummary(p.semanticIr, p.cfg, p.ssa, p.memorySsa, { snapshotId, calleeSummaries:summaries });
  assert.deepEqual(facts(composed.summary), [{ kind:'arg', argIndex:0, offset:'2' }]);
});

test('native target and scalar composition survive serialization without freezing caller artifacts', () => {
  const { caller:{ pipeline:original }, summaries } = nativePair();
  const p = structuredClone({ semanticIr:original.semanticIr, cfg:original.cfg, ssa:original.ssa, memorySsa:original.memorySsa });
  const surface = createAnalysisSurface({ ir:p.semanticIr, cfg:p.cfg, ssa:p.ssa, memorySsa:p.memorySsa,
    snapshotId, options:{ calleeSummaries:summaries, summaries } });
  const result = surface.functionSummary();
  assert.deepEqual(facts(result.summary), [{ kind:'arg', argIndex:0, offset:'2' }]);
  assert.equal(result.status.completeness, 'complete');
  assert.equal(functionSummaryDigest(result.summary), functionSummaryDigest(summarizeNative(original, summaries).summary));
  assert.equal(Object.isFrozen(p.semanticIr), false);
});

const summarizeNative = (p, summaries, options = {}) => buildLocalFunctionSummary(
  p.semanticIr, p.cfg, p.ssa, p.memorySsa, { snapshotId, calleeSummaries:summaries, ...options });

test('contextual native CALL closure enables a real three-function decoded return chain', () => {
  const { caller:{ pipeline:middle }, summaries, callee } = nativePair();
  const inner = summarizeNative(middle, summaries).summary;
  assert.equal(inner.status.completeness, 'complete');
  const proof = inner.semanticFacts.find(fact => fact.kind === 'native-call-effects-discharge');
  assert.equal(proof.calls.length, 1); assert.deepEqual(proof.obligations, middle.semanticIr.unknowns);
  assert.equal(proof.calls[0].summaryDigest, functionSummaryDigest(callee.result.summary));
  const outer = callFixture({ baseAddress:0xffcn }).pipeline;
  const registry = new Map([...summaries, [middle.functionId, inner]]);
  const result = summarizeNative(outer, registry).summary;
  assert.equal(result.status.completeness, 'complete');
  assert.deepEqual(facts(result), [{ kind:'arg', argIndex:0, offset:'3' }]);
  const call = outer.semanticIr.nodes.find(node => node.kind === 'call');
  const pointsTo = analyzeLocalPointsTo(outer.semanticIr, outer.cfg, outer.ssa, {
    snapshotId, summaries:registry, memorySsa:outer.memorySsa,
  });
  assert.equal(pointsTo.pointsTo.get(call.outputs[0]).top, false);
  assert.ok(pointsTo.calleeSummaryIds.includes(`summary:${functionSummaryDigest(inner)}`));
  assert.equal(outer.memorySsa.completeness, 'partial', 'contextual summary closure is not MemorySSA reconstruction');
});

test('native contextual closure retains actual decoded stores and callee register writes', () => {
  const caller = callFixture().pipeline;
  const callee = fixture({ baseAddress:0x3004n, parameters:parameters.slice(0, 2),
    words:[0x00a5b023, 0x00900613, 0x00150513, 0x00008067] });
  assert.equal(callee.result.status.completeness, 'complete');
  assert.ok(callee.result.summary.memoryWriteRegions.length > 0);
  const result = summarizeNative(caller, new Map([[callee.pipeline.functionId, callee.result.summary]])).summary;
  assert.equal(result.status.completeness, 'complete');
  assert.equal(summaryIsPure(result), false);
  assert.ok(result.memoryWriteRegions.some(effect => effect.broad));
  for (const key of callee.result.summary.registerEffects) assert.ok(result.registerEffects.includes(key));
  for (const key of callee.result.summary.inputs) assert.ok(result.inputs.includes(key));
});

test('native call discharge does not erase unrelated lowering obligations', () => {
  const { summaries } = nativePair();
  for (const inputOptions of [
    { completeness:'partial', unknowns:[{ reason:'unmodeled-fault', categories:['faults'] }] },
    { completeness:'unknown' },
  ]) {
    const p = callFixture({ inputOptions }).pipeline;
    const result = summarizeNative(p, summaries).summary;
    assert.equal(result.status.completeness, 'partial');
    assert.equal(result.semanticFacts.some(fact => fact.kind === 'native-call-effects-discharge'), false);
    assert.ok(result.semanticFacts.some(fact => fact.kind === 'native-direct-call-target'), 'target is independently resolved');
  }
});

test('native closure rejects unresolved control, escapes and partial callee scope', () => {
  const { caller:{ pipeline:p }, callee } = nativePair();
  for (const change of [
    { mayThrow:'unknown' }, { noreturn:'unknown' }, { noreturn:true },
    { escapes:[{ rootKey:'callee-root', reason:'passed-to-unknown-call', boundary:'unknown-call', evidenceIds:[] }] },
    { status:{ ...callee.result.summary.status, completeness:'partial', stopReason:'evidence-missing' } },
  ]) {
    const candidate = createFunctionSummary({ ...callee.result.summary, ...change });
    const result = summarizeNative(p, new Map([[callee.pipeline.functionId, candidate]])).summary;
    assert.equal(result.status.completeness, 'partial');
    assert.equal(result.semanticFacts.some(fact => fact.kind === 'native-call-effects-discharge'), false);
  }
});

test('native contextual summaries retain allocation, free and known exception dimensions', () => {
  const { caller:{ pipeline:p }, callee } = nativePair();
  const candidate = createFunctionSummary({ ...callee.result.summary,
    allocations:['callee-allocation'], frees:['callee-free'], mayThrow:true });
  const result = summarizeNative(p, new Map([[callee.pipeline.functionId, candidate]])).summary;
  assert.equal(result.status.completeness, 'complete');
  assert.deepEqual(result.allocations, ['callee-allocation']); assert.deepEqual(result.frees, ['callee-free']);
  assert.equal(result.mayThrow, true); assert.equal(summaryIsPure(result), false);
});

test('native discharge binds the exact SSA dependency and copies its evidence', () => {
  const { caller:{ pipeline:p }, summaries } = nativePair();
  const staleMemory = { ...p.memorySsa, identity:{ ...p.memorySsa.identity, scalarSsaDigest:'stale' } };
  const stale = buildLocalFunctionSummary(p.semanticIr, p.cfg, p.ssa, staleMemory, { snapshotId, calleeSummaries:summaries }).summary;
  assert.equal(stale.status.completeness, 'partial');
  assert.ok(stale.semanticFacts.some(fact => fact.kind === 'native-direct-call-target'));
  assert.equal(stale.semanticFacts.some(fact => fact.kind === 'native-call-effects-discharge'), false);
  const plain = structuredClone({ semanticIr:p.semanticIr, cfg:p.cfg, ssa:p.ssa, memorySsa:p.memorySsa });
  const result = summarizeNative(plain, summaries).summary;
  const proof = result.semanticFacts.find(fact => fact.kind === 'native-call-effects-discharge');
  assert.deepEqual(proof.obligations, plain.semanticIr.unknowns);
  assert.notEqual(proof.obligations[0], plain.semanticIr.unknowns[0]);
  assert.equal(Object.isFrozen(plain.semanticIr.unknowns[0]), false);
  assert.equal(Object.isFrozen(proof.obligations[0]), true);
});

test('native discharge requires exact obligation coverage and no other partial node', () => {
  const { caller:{ pipeline:p }, summaries } = nativePair();
  assert.throws(() => createSemanticIrFunction({ ...p.semanticIr, unknowns:[] }),
    /semantic-ir-function-unknowns-required/, 'the canonical producer already rejects missing partial-scope reasons');
  for (const mutate of [
    ir => { ir.unknowns[0].categories = ['memory']; },
    ir => { const node = ir.nodes.find(item => item.kind === 'binary');
      node.completeness = 'partial'; node.unknown = { reason:'unmodeled-value', categories:['other'] }; },
    ir => { ir.nodes.find(item => item.kind === 'call').unknown.reason = 'different-obligation'; },
  ]) {
    const raw = structuredClone(p.semanticIr); mutate(raw);
    const ir = createSemanticIrFunction(raw), ssa = buildSemanticSsa(ir, p.cfg);
    const digest = stableDigest(ir), memorySsa = { ...p.memorySsa,
      identity:{ ...p.memorySsa.identity, semanticIrDigest:digest, scalarSsaDigest:stableDigest(ssa) },
      canonicalIrIdentity:{ ...p.memorySsa.canonicalIrIdentity, semanticIrDigest:digest } };
    // Bind the transformed IR/SSA identities so the scope-coverage checks,
    // rather than an unrelated stale-digest rejection, must retain partial.
    const result = buildLocalFunctionSummary(ir, p.cfg, ssa, memorySsa, { snapshotId, calleeSummaries:summaries }).summary;
    assert.ok(result.semanticFacts.some(fact => fact.kind === 'native-direct-call-target'));
    assert.equal(result.status.completeness, 'partial');
    assert.equal(result.semanticFacts.some(fact => fact.kind === 'native-call-effects-discharge'), false);
  }
});

test('unknown decoded leaf returns stay unknown through complete contextual wrappers', () => {
  const { caller:{ pipeline:middle }, summaries:knownSummaries } = nativePair();
  const known = summarizeNative(middle, knownSummaries).summary;
  const leaf = fixture({ baseAddress:0x3004n, parameters:[parameters[0]], words:[0x00700513, 0x00008067] });
  const changed = summarizeNative(middle, new Map([[leaf.pipeline.functionId, leaf.result.summary]])).summary;
  assert.equal(changed.status.completeness, 'complete', 'effect scope is complete, not return precision');
  assert.ok(changed.returnProvenance.every(fact => fact.kind === 'unknown'));
  assert.notEqual(functionSummaryDigest(changed), functionSummaryDigest(known));
  const outer = callFixture({ baseAddress:0xffcn }).pipeline;
  const summaries = new Map([[middle.functionId, changed]]);
  const result = summarizeNative(outer, summaries).summary;
  assert.ok(result.returnProvenance.every(fact => fact.kind === 'unknown'));
  const pointsTo = analyzeLocalPointsTo(outer.semanticIr, outer.cfg, outer.ssa, { snapshotId, summaries, memorySsa:outer.memorySsa });
  const call = outer.semanticIr.nodes.find(node => node.kind === 'call');
  assert.equal(pointsTo.pointsTo.get(call.outputs[0]).top, true);
});

test('native target classification independently checks control, constant, origin and identity claims', () => {
  const { caller:{ pipeline:p }, summaries } = nativePair();
  for (const mutate of [
    node => { node.attributes.machineControlEffect.target.kind = 'register'; },
    node => { node.call.controlEffects[0].target.value = '0x4000'; },
    (node, ir) => { ir.values.find(value => value.id === node.call.targetValueIds[0]).metadata.constant.value = '0x4000'; },
    node => { node.origin.instructionIds = ['different-instruction']; },
    node => { node.call.targetEntityId = {}; },
    node => { node.call.summarySource = 'untrusted'; },
  ]) {
    const ir = structuredClone(p.semanticIr), node = ir.nodes.find(item => item.kind === 'call');
    mutate(node, ir);
    // Refresh only the container digest, so rejection must come from an
    // independent target cross-check rather than the stale-digest guard.
    const digest = stableDigest(ir), memorySsa = { ...p.memorySsa,
      identity:{ ...p.memorySsa.identity, semanticIrDigest:digest },
      canonicalIrIdentity:{ ...p.memorySsa.canonicalIrIdentity, semanticIrDigest:digest } };
    assert.equal(createSemanticCallTargetClassifier(ir, memorySsa, {
      snapshotId, summaryForTarget:target => summaries.get(target),
    })(node).exhaustive, false);
  }
  const indirect = callFixture({ words:[0x00150513, 0x000580e7, 0x00008067] }).pipeline;
  const node = indirect.semanticIr.nodes.find(item => item.kind === 'call');
  assert.equal(createSemanticCallTargetClassifier(indirect.semanticIr, indirect.memorySsa, {
    snapshotId, summaryForTarget:target => summaries.get(target),
  })(node).exhaustive, false, 'an actual register-indirect CALL is not an immediate target');
});

test('typed native CALL binds actual arguments and a fresh normal-return value before SSA', () => {
  const { pipeline:p, returns, result } = callFixture();
  const call = p.semanticIr.nodes.find(node => node.kind === 'call');
  assert.equal(call.call.arguments.length, 1);
  assert.equal(call.outputs.length, 1);
  assert.deepEqual(call.call.returns, call.outputs);
  const argument = p.semanticIr.values.find(value => value.id === call.call.arguments[0]);
  const read = p.semanticIr.nodes.find(node => node.id === argument.definitionNodeId);
  assert.equal(read.kind, 'state-read');
  assert.equal(read.variable.physicalIdentity.registerId, 'x10');
  const argumentUse = p.ssa.uses.find(use => use.sourceEntityId === read.id);
  const argumentDefinition = p.ssa.definitions.find(def => def.valueId === argumentUse.valueId);
  assert.equal(argumentDefinition.kind, 'definition', 'argument is the preceding ADDI, not entry a0');
  assert.ok(p.ssa.definitions.some(def => def.kind === 'unknown' && def.proof.broadUnknown));
  const returned = p.semanticIr.values.find(value => value.id === returns[0].inputs[0]);
  const returnedUse = p.ssa.uses.find(use => use.sourceEntityId === returned.definitionNodeId);
  const resultWrite = p.ssa.definitions.find(def => def.valueId === returnedUse.valueId);
  assert.equal(resultWrite.proof.sourceSemanticValueId, call.outputs[0]);
  assert.equal(result.summary.returnValues.length, 1);
  assert.ok(result.summary.returnProvenance.every(fact => fact.kind === 'unknown'));
  assert.ok(result.summary.semanticFacts.some(fact => fact.kind === 'abi-call-values' && fact.callNodeId === call.id));
});

test('typed CALL value binding never resolves its callee identity or unknown effects', () => {
  const typed = callFixture(), opaque = callFixture({ adapterOptions:{} });
  const call = typed.pipeline.semanticIr.nodes.find(node => node.kind === 'call');
  const old = opaque.pipeline.semanticIr.nodes.find(node => node.kind === 'call');
  assert.deepEqual(typed.pipeline.machineEffects, opaque.pipeline.machineEffects);
  for (const field of ['targetEntityIds', 'targetValueIds', 'stateReads', 'stateWrites', 'memoryRead', 'memoryWrite',
    'controlEffects', 'determinism', 'noreturn', 'mayThrow', 'completeness', 'unknownEffects', 'summarySource']) {
    assert.deepEqual(call.call[field], old.call[field], field);
  }
  assert.deepEqual(call.call.targetEntityIds, []);
  assert.equal(classifyCallTargetProof(call.call).exhaustive, false, 'a direct address is not a callee summary identity');
  assert.equal(typed.result.status.completeness, 'partial');
  assert.equal(summaryIsPure(typed.result.summary), false);
  assert.equal(typed.result.summary.unknownCallEffects.length, 1);
  assert.ok(typed.result.summary.memoryWriteRegions.some(effect => effect.broad));
});

test('opaque, stale and partial-register CALL declarations do not mint native results', () => {
  for (const adapterOptions of [{}, { callPrototype, snapshotId:'stale' },
    { callPrototype:{ ...callPrototype, returnType:'int32' } },
    { callPrototype:{ parameters:[{ type:'int32', bits:32 }], returnType:'int64' } },
    { callPrototype, callerCalleeConflict:true }]) {
    const { pipeline, returns } = callFixture({ adapterOptions });
    const call = pipeline.semanticIr.nodes.find(node => node.kind === 'call');
    assert.deepEqual(call.outputs, []);
    assert.deepEqual(call.call.arguments, []);
    assert.deepEqual(returns[0].inputs, []);
  }
});

test('a later opaque call clobbers a typed native result and keeps the return frontier closed', () => {
  const f = callFixture({ words:[0x000010ef, 0x000020ef, 0x00008067],
    adapterOptions:{ callPrototypeFor:(_target, call) =>
      BigInt(call?.controlEffects?.[0]?.target?.value ?? 0) === 0x3000n ? callPrototype : null } });
  const calls = f.pipeline.semanticIr.nodes.filter(node => node.kind === 'call');
  assert.equal(calls.filter(node => node.outputs.length === 1).length, 1);
  assert.equal(calls.filter(node => node.outputs.length === 0).length, 1);
  assert.deepEqual(f.returns[0].inputs, []);
  assert.equal(f.result.status.completeness, 'partial');
});

test('typed native CALL observations are deterministic and preserve source navigation', () => {
  const first = callFixture(), second = callFixture();
  assert.deepEqual(first.pipeline.semanticIr, second.pipeline.semanticIr);
  assert.deepEqual(first.pipeline.ssa, second.pipeline.ssa);
  const call = first.pipeline.semanticIr.nodes.find(node => node.kind === 'call');
  const binding = call.attributes.abiCallBinding;
  assert.equal(binding.callNodeId, call.id);
  assert.equal(binding.functionId, first.pipeline.functionId);
  assert.deepEqual(binding.argumentValueIds, call.call.arguments);
  assert.equal(binding.returnValueId, call.outputs[0]);
  const transform = call.origin.transforms.find(item => item.passId === 'semantic-abi-call-binding');
  assert.ok(transform.producedEntityIds.includes(call.outputs[0]));
  assert.ok(call.origin.instructionIds.length > 0);
  const map = buildRenderProvenance({ result:{ ir:first.pipeline.legacyV1, lines:[] }, snapshotId });
  assert.deepEqual(validateRenderProvenance(map).reasons, []);
});

test('the default decoded CALL driver publishes native values without resolving unknown callee effects', () => {
  const f = callFixture();
  const result = analyzeDecodedSemanticFunction({ architecture:'riscv64', platform:'linux', abiId:'lp64',
    binaryId:'native-return-binary', sliceId:'0', snapshotId, decoderSemanticVersion:'native-return-decoder',
    instructions:f.instructions, functionPrototype:f.prototype, callPrototype });
  const p = result.pipeline, call = p.semanticIr.nodes.find(node => node.kind === 'call');
  assert.equal(call.outputs.length, 1);
  assert.equal(call.call.arguments.length, 1);
  assert.ok(result.decompiler);
  const summary = buildLocalFunctionSummary(p.semanticIr, p.cfg, p.ssa, p.memorySsa, { snapshotId }).summary;
  assert.equal(summary.returnValues.length, 1);
  assert.equal(summary.status.completeness, 'partial');
  assert.equal(summaryIsPure(summary), false);
});

test('native CALL expansion charges canonical graph budgets before publication', () => {
  const original = callFixture({ adapterOptions:{} }).pipeline.semanticIr;
  for (const [key, maximum] of [['maxNodes', original.nodes.length], ['maxValues', original.values.length]]) {
    assert.throws(() => callFixture({ options:{ semanticIrOptions:{ budget:{ [key]:maximum } } } }),
      new RegExp(`semantic-ir-budget-exceeded-${key}`));
  }
});

test('narrow integer result observes the physical register before explicit truncation', () => {
  const { pipeline, returns, result } = fixture({ returnType:'int32' });
  const resultValue = pipeline.semanticIr.values.find(value => value.id === returns[0].inputs[0]);
  assert.equal(resultValue.machineType.widthBits, 32);
  const trunc = pipeline.semanticIr.nodes.find(node => node.id === resultValue.definitionNodeId);
  assert.equal(trunc.kind, 'trunc');
  const physical = pipeline.semanticIr.values.find(value => value.id === trunc.inputs[0]);
  assert.equal(physical.machineType.widthBits, 64);
  assert.equal(result.summary.returnValues.length, 1);
});

test('absent or void declarations do not turn the return address into a value', () => {
  for (const returnType of [null, 'void']) {
    const { returns, result } = fixture({ returnType });
    assert.deepEqual(returns[0].inputs, []);
    assert.deepEqual(result.summary.returnValues, []);
  }
});

test('stale ABI bindings withhold native return values', () => {
  for (const adapterOptions of [{ binaryId:'other' }, { sliceId:'other' }, { functionId:'other' }, { snapshotId:'other' }]) {
    const { returns, result } = fixture({ adapterOptions });
    assert.deepEqual(returns[0].inputs, []);
    assert.deepEqual(result.summary.returnValues, []);
  }
});

test('unknown native control and opaque calls cannot gain a return binding', () => {
  for (const words of [[0x00050067, 0x00008067], [0x000010ef, 0x00008067]]) {
    const { returns, result } = fixture({ words });
    assert.ok(returns.length > 0);
    assert.ok(returns.every(node => node.inputs.length === 0));
    assert.notEqual(result.summary.status.completeness, 'complete');
  }
});

test('pre-aborted native return analysis publishes no artifacts', () => {
  const controller = new AbortController(); controller.abort();
  assert.throws(() => fixture({ options:{ signal:controller.signal } }), { name:'AbortError' });
});

test('ABI value observations preserve the decoded machine effects and carry deterministic origin', () => {
  const typed = fixture(), untyped = fixture({ returnType:null });
  assert.deepEqual(typed.pipeline.machineEffects, untyped.pipeline.machineEffects);
  const transform = typed.returns[0].origin.transforms.find(item => item.passId === 'semantic-abi-return-binding');
  assert.ok(transform);
  assert.deepEqual(transform.consumedEntityIds, [untyped.returns[0].id]);
  assert.equal(transform.proofKind, 'canonical-abi-location');
  assert.deepEqual(typed.pipeline.semanticIr, fixture().pipeline.semanticIr);
  assert.deepEqual(typed.pipeline.ssa, fixture().pipeline.ssa);
});

test('each decoded return exit has its own canonical reaching definition', () => {
  const { pipeline, returns, result } = fixture({ words:[0x00050663, 0x00150513, 0x00008067, 0x00250513, 0x00008067] });
  assert.equal(returns.length, 2);
  assert.equal(result.summary.returnValues.length, 2);
  const writes = new Set();
  for (const node of returns) {
    assert.equal(node.inputs.length, 1);
    const readId = pipeline.semanticIr.values.find(value => value.id === node.inputs[0]).definitionNodeId;
    const use = pipeline.ssa.uses.find(item => item.sourceEntityId === readId);
    const definition = pipeline.ssa.definitions.find(item => item.valueId === use.valueId);
    assert.equal(definition.kind, 'definition');
    writes.add(definition.sourceEntityId);
  }
  assert.equal(writes.size, 2, 'one exit must not borrow the other exit\'s assignment');
});
