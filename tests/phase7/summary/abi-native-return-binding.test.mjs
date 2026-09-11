import assert from 'node:assert/strict';
import test from 'node:test';
import { semanticAbiAdapter, partitionDecodedFunction } from '../../../js/analysis/semantic-function.js';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { functionSummaryDigest } from '../../../js/analysis/summary/contract.js';
import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { RISCV_LP64_ABI } from '../../../js/targets/abi/index.js';
import { createRiscv64DecodedInstruction } from '../../../js/targets/architecture/riscv64/decoded-instruction.js';
import { buildSemanticV2CompatibilityPipeline } from '../../../js/semantics/compat/index.js';

const snapshotId = 'native-abi-return-snapshot';
function fixture({ returnType = 'int64', words = [0x00150513, 0x00008067], adapterOptions = {}, options = {} } = {}) {
  const architecture = architecturePluginV2('riscv64');
  const instructions = words.map((word, index) => createRiscv64DecodedInstruction({
    address:0x2000n + BigInt(index * 4), size:4, mode:'rv64imc',
    rawBytes:Uint8Array.from([word & 255, (word >>> 8) & 255, (word >>> 16) & 255, word >>> 24]),
    instructionId:`native-return-${index}`, origin:{ instructionIds:[`native-return-${index}`] },
  }));
  const blocks = partitionDecodedFunction(instructions, architecture);
  const adapter = semanticAbiAdapter(RISCV_LP64_ABI, {
    architecture:'riscv64', platform:'linux', binaryId:'native-return-binary', sliceId:'0', snapshotId,
    functionPrototype:returnType == null ? null : { returnType }, ...adapterOptions,
  });
  const pipeline = buildSemanticV2CompatibilityPipeline({
    architecturePlugin:architecture, decoderSemanticVersion:'native-return-decoder',
    binaryId:'native-return-binary', sliceId:'0', addressWidthBits:64, mode:'rv64imc',
    entryBlockKey:blocks[0].key, blocks, abiAdapter:adapter,
  }, { snapshotId, ...options });
  const result = buildLocalFunctionSummary(pipeline.semanticIr, pipeline.cfg, pipeline.ssa, pipeline.memorySsa, { snapshotId });
  return { pipeline, adapter, result, returns:pipeline.semanticIr.nodes.filter(node => node.kind === 'return') };
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
