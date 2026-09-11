import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeDecodedSemanticFunction, semanticAbiAdapter, partitionDecodedFunction } from '../../../js/analysis/semantic-function.js';
import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/index.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { buildSemanticSsa, validateSemanticSsa } from '../../../js/semantics/ssa/index.js';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { classifyCallTargetProof, functionSummaryDigest, summaryIsPure } from '../../../js/analysis/summary/contract.js';
import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { RISCV_LP64_ABI } from '../../../js/targets/abi/index.js';
import { createRiscv64DecodedInstruction } from '../../../js/targets/architecture/riscv64/decoded-instruction.js';
import { buildSemanticV2CompatibilityPipeline } from '../../../js/semantics/compat/index.js';
import { buildRenderProvenance, validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';

const snapshotId = 'native-abi-return-snapshot';
function fixture({ returnType = 'int64', words = [0x00150513, 0x00008067], parameters = null, adapterOptions = {}, options = {} } = {}) {
  const architecture = architecturePluginV2('riscv64');
  const instructions = words.map((word, index) => createRiscv64DecodedInstruction({
    address:0x2000n + BigInt(index * 4), size:4, mode:'rv64imc',
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
    entryBlockKey:blocks[0].key, blocks, abiAdapter:adapter, functionPrototype:prototype,
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
