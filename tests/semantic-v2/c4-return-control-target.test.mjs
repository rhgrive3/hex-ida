import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOperands } from '../../js/arm64.js';
import { semanticAbiAdapter } from '../../js/analysis/semantic-function.js';
import {
  ARM64_ARCHITECTURE,
  X86_64_ARCHITECTURE,
} from '../../js/targets/architecture/index.js';
import { AAPCS64_ABI } from '../../js/targets/abi/index.js';
import {
  createMachineEffectBundle,
  createTemporaryValue,
} from '../../js/semantics/effects/index.js';
import {
  buildSemanticV2CompatibilityPipeline,
} from '../../js/semantics/compat/index.js';
import {
  createSemanticIrFunction,
  lowerMachineEffectBundleToSemanticIr,
} from '../../js/semantics/ir/index.js';
import { SEMANTIC_RETURN_CONTROL_TARGET_SCHEMA } from '../../js/semantics/ir/nodes.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/index.js';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { canonicalAnalysisIdentity } from '../../js/decompiler/phase8/analysis-identity.js';

const ARM64_RET_WORD = 0xd65f03c0;
const ARM64_RET_BYTES = Uint8Array.of(0xc0, 0x03, 0x5f, 0xd6);
const ARM64_BINARY = 'c4-return-target-arm64';
const ARM64_SLICE = 'c4-return-target-slice';
const ORIGIN_ID = 'c4-return-control-target-test';
const origin = Object.freeze({ instructionIds: [ORIGIN_ID] });

function pipelineFor({ architecturePlugin, binaryId, sliceId, decoderSemanticVersion, startAddress, decoded, decodeds, ...input }, options = {}) {
  const instructionInputs = decodeds ?? [decoded];
  return buildSemanticV2CompatibilityPipeline({
    architecturePlugin,
    decoderSemanticVersion,
    binaryId,
    sliceId,
    addressWidthBits: 64,
    entryBlockKey: 'entry',
    blocks: [{
      key: 'entry',
      startAddress,
      instructions: instructionInputs.map((instruction) => ({ decoded: instruction })),
      successors: [],
    }],
    ...input,
  }, options);
}

function returnNode(result) {
  const node = result.semanticIr.nodes.find((candidate) => candidate.kind === 'return');
  assert.ok(node, 'pipeline must contain a return node');
  return node;
}

function returnInstruction(result, node) {
  const instruction = result.legacyV1.instructions.find((candidate) => candidate.semanticNodeId === node.id);
  assert.ok(instruction, 'legacy projection must contain the semantic return');
  return instruction;
}

function assertResolvedTarget(result, { registerId = null, producerKind = null, abiInputCount = 0 } = {}) {
  const node = returnNode(result);
  const target = node.metadata?.returnControlTarget;
  assert.deepEqual(Object.keys(target ?? {}).sort(), ['schema', 'state', 'valueId']);
  assert.equal(target.schema, SEMANTIC_RETURN_CONTROL_TARGET_SCHEMA);
  assert.equal(target.state, 'resolved');
  assert.equal(typeof target.valueId, 'string');
  assert.equal(node.inputs.length, abiInputCount, 'architectural target is separate from ABI return inputs');

  const producer = result.semanticIr.nodes.find((candidate) => candidate.outputs.includes(target.valueId));
  assert.ok(producer, 'return target ValueId must have a canonical producer');
  if (producerKind != null) assert.equal(producer.kind, producerKind);
  if (registerId != null) {
    assert.equal(producer.variable?.physicalIdentity?.kind, 'register');
    assert.equal(producer.variable.physicalIdentity.registerId, registerId);
  }

  const use = result.ssa.uses.find((candidate) => candidate.sourceEntityId === node.id
    && candidate.proof?.kind === 'semantic-value-use'
    && candidate.proof.sourceSemanticValueId === target.valueId
    && candidate.proof.roles?.includes('return-target'));
  assert.ok(use, 'SSA must expose a distinct return-target scalar use');
  const definition = result.ssa.definitions.find((candidate) => candidate.valueId === use.valueId);
  assert.ok(definition, 'return-target SSA use must resolve to a definition');
  assert.equal(definition.proof?.sourceSemanticValueId, target.valueId);

  const instruction = returnInstruction(result, node);
  assert.equal(instruction.args.length, abiInputCount, 'legacy args remain ABI-only');
  assert.equal(instruction.returnValueIds.length, abiInputCount, 'legacy returnValueIds remain ABI-only');
  assert.equal(instruction.extra.returnControlTargetValueId, target.valueId);
  assert.equal(instruction.returnTargetValue?.semanticValueId, target.valueId);
  assert.ok(instruction.returnTargetValue?.def, 'legacy target survives finalizer alias compaction');
  assert.ok(instruction.returnTargetValue.uses.includes(instruction), 'legacy target use is rebuilt after finalization');
  return { node, target, producer, instruction };
}

function arm64RetDecoded(register = 'x30') {
  const registerNumber = Number(register.slice(1));
  const instructionCode = (0xd65f0000 | (registerNumber << 5)) >>> 0;
  return {
    address: 0x4000n,
    size: 4,
    length: 4,
    mnemonic: 'ret',
    opStr: register,
    operands: register,
    ops: parseOperands(register),
    mode: 'a64',
    instructionCode,
    rawBytes: Uint8Array.of(
      instructionCode & 0xff,
      (instructionCode >>> 8) & 0xff,
      (instructionCode >>> 16) & 0xff,
      (instructionCode >>> 24) & 0xff,
    ),
  };
}

function arm64LoadX30Decoded() {
  const instructionCode = 0xf94003fe;
  return {
    address: 0x4000n,
    size: 4,
    length: 4,
    mnemonic: 'ldr',
    opStr: 'x30, [sp]',
    operands: 'x30, [sp]',
    ops: parseOperands('x30, [sp]'),
    mode: 'a64',
    instructionCode,
    rawBytes: Uint8Array.of(
      instructionCode & 0xff,
      (instructionCode >>> 8) & 0xff,
      (instructionCode >>> 16) & 0xff,
      (instructionCode >>> 24) & 0xff,
    ),
  };
}

function x86RetDecoded() {
  // This is the canonical Capstone structured record for bytes C3 (RET near).
  // It is kept inline so the test does not create an OS-temporary decoder copy.
  return createX86DecodedInstruction({
    architecture: 'x86_64',
    address: 0x5000n,
    size: 1,
    length: 1,
    mnemonic: 'ret',
    opStr: '',
    rawBytes: Uint8Array.of(0xc3),
    mode: 'long-64',
    instructionCode: 0xc3,
    instructionFamily: 'ret',
    decoderSemanticVersion: 'capstone-5-x86-structured-v2',
    detailAvailable: true,
    detailStatus: 'complete',
    detail: {
      operandCount: 0,
      operands: [],
      addressSizeBits: 64,
      prefixes: { legacy: [], rex: null, vector: null },
      implicitReads: ['rsp'],
      implicitWrites: ['rsp'],
    },
  });
}

test('C4 ARM64 RET x30 keeps a typed target through canonical pipeline and legacy finalizer', () => {
  const decoded = arm64RetDecoded();
  assert.equal(decoded.instructionCode, ARM64_RET_WORD);
  assert.deepEqual([...decoded.rawBytes], [...ARM64_RET_BYTES]);
  const result = pipelineFor({
    architecturePlugin: ARM64_ARCHITECTURE,
    decoderSemanticVersion: 'c4-arm64-ret-decoder',
    binaryId: ARM64_BINARY,
    sliceId: ARM64_SLICE,
    startAddress: 0x4000n,
    decoded,
  });
  assert.equal(result.machineEffects.length, 1);
  assert.equal(result.machineEffects[0].controlEffect.kind, 'return');
  assert.equal(result.machineEffects[0].controlEffect.target.kind, 'temporary');
  assert.deepEqual(result.machineEffects[0].possibleFaults.map((fault) => fault.kind), ['pc-alignment-fault']);
  assertResolvedTarget(result, { registerId: 'x30', producerKind: 'state-read' });
});

test('C4 canonical analysis identity is valid and changes when the return target operand changes', () => {
  const make = (register) => pipelineFor({
    architecturePlugin: ARM64_ARCHITECTURE,
    decoderSemanticVersion: 'c4-arm64-identity-decoder',
    binaryId: ARM64_BINARY,
    sliceId: ARM64_SLICE,
    startAddress: 0x4000n,
    decoded: arm64RetDecoded(register),
  });
  const x30 = canonicalAnalysisIdentity({ ir: make('x30').legacyV1 });
  const x0 = canonicalAnalysisIdentity({ ir: make('x0').legacyV1 });
  assert.equal(x30.valid, true);
  assert.equal(x0.valid, true);
  assert.notEqual(x30.identity.semanticIrId, x0.identity.semanticIrId,
    'identity must include the projected return-target operand');
  assert.notEqual(x30.identity.ssaId, x0.identity.ssaId,
    'SSA identity must change with the return-target producer');
});

test('C4 x86 RET stack target is a separate typed use and retains machine faults', () => {
  const result = pipelineFor({
    architecturePlugin: X86_64_ARCHITECTURE,
    decoderSemanticVersion: 'capstone-5-x86-structured-v2',
    binaryId: 'c4-return-target-x86',
    sliceId: ARM64_SLICE,
    startAddress: 0x5000n,
    decoded: x86RetDecoded(),
  });
  assert.equal(result.machineEffects.length, 1);
  assert.equal(result.machineEffects[0].controlEffect.kind, 'return');
  assert.deepEqual(
    result.machineEffects[0].possibleFaults.map((fault) => fault.kind).sort(),
    ['control-transfer-fault', 'memory-access-fault'],
  );
  const { producer } = assertResolvedTarget(result, { producerKind: 'load' });
  assert.equal(producer.memory.widthBits, 64);
  assert.equal(producer.memory.endian, 'little');
});

test('C4 ABI return inputs coexist with an independent ARM64 return target', () => {
  const functionPrototype = { returnType: 'int32' };
  const abiAdapter = semanticAbiAdapter(AAPCS64_ABI, {
    architecture: 'arm64',
    platform: 'linux',
    binaryId: ARM64_BINARY,
    sliceId: ARM64_SLICE,
    functionPrototype,
  });
  const result = pipelineFor({
    architecturePlugin: ARM64_ARCHITECTURE,
    decoderSemanticVersion: 'c4-arm64-ret-abi-decoder',
    binaryId: ARM64_BINARY,
    sliceId: ARM64_SLICE,
    startAddress: 0x4000n,
    functionPrototype,
    abiAdapter,
    decoded: arm64RetDecoded(),
  });
  const { node, target, instruction } = assertResolvedTarget(result, {
    registerId: 'x30',
    producerKind: 'state-read',
    abiInputCount: 1,
  });
  assert.equal(node.inputs.length, 1, 'declared scalar return contributes one ABI value');
  const abiValue = result.semanticIr.values.find((value) => value.id === node.inputs[0]);
  assert.equal(abiValue?.machineType.kind, 'bitvector');
  assert.equal(abiValue?.machineType.widthBits, 64);
  const abiProducer = result.semanticIr.nodes.find((candidate) => candidate.outputs.includes(node.inputs[0]));
  assert.equal(abiProducer?.kind, 'state-read');
  assert.equal(abiProducer?.variable?.physicalIdentity?.registerId, 'x0');
  assert.notEqual(node.inputs[0], target.valueId, 'ABI input and architectural target must have distinct ValueIds');
  assert.equal(instruction.args.length, 1);
  assert.equal(instruction.args[0]?.value?.semanticValueId, node.inputs[0]);
  assert.equal(instruction.returnValueIds.length, 1);
  assert.equal(instruction.returnValueIds[0], node.inputs[0]);
  assert.equal(instruction.extra.returnControlTargetValueId, target.valueId);
  assert.equal(instruction.returnTargetValue?.reg, 'x30');
  assert.ok(instruction.returnTargetValue.uses.includes(instruction));
});

test('C4 legacy finalizer applies a real ARM64 x30 state alias without losing the original semantic target ID', () => {
  const result = pipelineFor({
    architecturePlugin: ARM64_ARCHITECTURE,
    decoderSemanticVersion: 'c4-arm64-alias-decoder',
    binaryId: 'c4-return-target-alias',
    sliceId: ARM64_SLICE,
    startAddress: 0x4000n,
    decodeds: [arm64LoadX30Decoded(), arm64RetDecoded()],
  });
  const node = returnNode(result);
  const originalTargetId = node.metadata?.returnControlTarget?.valueId;
  assert.equal(typeof originalTargetId, 'string');
  const targetUse = result.ssa.uses.find((candidate) => candidate.sourceEntityId === node.id
    && candidate.proof?.kind === 'semantic-value-use'
    && candidate.proof.sourceSemanticValueId === originalTargetId
    && candidate.proof.roles?.includes('return-target'));
  assert.ok(targetUse, 'SSA target use must retain the pre-projection semantic ValueId');

  const instruction = returnInstruction(result, node);
  assert.equal(instruction.extra.returnControlTargetValueId, originalTargetId,
    'compatibility metadata must preserve the original semantic target reference');
  assert.deepEqual(instruction.args, [], 'state-target aliasing must not become an ABI return argument');
  assert.deepEqual(instruction.returnValueIds, [], 'state-target aliasing must not become an ABI return value');
  const finalTarget = instruction.returnTargetValue;
  assert.ok(finalTarget, 'finalized RET must retain a target value object');
  assert.ok(finalTarget.uses.includes(instruction), 'finalized target must be present in RET def-use');

  const stateWrite = result.legacyV1.instructions.find((candidate) =>
    candidate.extra?.stateWrite?.physicalIdentity?.registerId === 'x30');
  assert.ok(stateWrite, 'canonical LDR x30 state write must be projected');
  const aliasSource = result.legacyV1.values.find((value) =>
    value.id === stateWrite.extra.compatPublicStateSourceValueId);
  assert.ok(aliasSource, 'state-write alias must identify its canonical source value');
  assert.equal(aliasSource.reg, 'x30');
  assert.equal(aliasSource.compatDerived, 'exact-state-write-source');
  assert.ok(
    finalTarget === aliasSource
      || finalTarget.def?.args?.some((argument) => argument?.value === aliasSource)
      || finalTarget.semanticValueId === originalTargetId,
    'RET target must follow the chosen state alias while retaining a typed target object',
  );
});

test('C4 an absent target keeps the prior ABI-only return shape', () => {
  const id = 'c4-return-target-absent';
  const bundle = createMachineEffectBundle({
    instructionId: id,
    architectureId: 'arm64',
    mode: 'a64',
    operations: [],
    controlEffect: { kind: 'return' },
    possibleFaults: [],
    origin: { instructionIds: [id] },
    completeness: 'exact',
  });
  const ir = lowerMachineEffectBundleToSemanticIr(bundle, {
    functionId: 'c4-return-target-absent-function',
    blockId: 'entry',
    entryBlockId: 'entry',
    addressWidthBits: 64,
  });
  const node = returnNode({ semanticIr: ir });
  assert.equal(node.metadata, undefined);
  const projected = projectSemanticIrV2ToLegacyV1(ir);
  const instruction = projected.instructions.find((candidate) => candidate.semanticNodeId === node.id);
  assert.ok(instruction);
  assert.deepEqual(instruction.args, []);
  assert.deepEqual(instruction.returnValueIds, []);
  assert.equal(Object.hasOwn(instruction.extra, 'returnControlTargetValueId'), false);
  assert.equal(Object.hasOwn(instruction, 'returnTargetValue'), false);
});

test('C4 an unbound explicit target is unavailable and keeps partial/fault evidence', () => {
  const id = 'c4-return-target-unbound';
  const target = createTemporaryValue('missing-return-target', { kind: 'bitvector', widthBits: 64 });
  const bundle = createMachineEffectBundle({
    instructionId: id,
    architectureId: 'arm64',
    mode: 'a64',
    operations: [],
    controlEffect: { kind: 'return', target },
    possibleFaults: [{ kind: 'pc-alignment-fault', condition: { kind: 'target-misaligned', alignmentBytes: 4 } }],
    origin: { instructionIds: [id] },
    completeness: 'partial',
    unknownEffects: { categories: ['control'], reason: 'target-unavailable' },
  });
  const ir = lowerMachineEffectBundleToSemanticIr(bundle, {
    functionId: 'c4-return-target-unbound-function',
    blockId: 'entry',
    entryBlockId: 'entry',
    addressWidthBits: 64,
  });
  assert.equal(ir.completeness, 'partial');
  const node = returnNode({ semanticIr: ir });
  assert.equal(node.completeness, 'partial');
  assert.deepEqual(node.metadata?.returnControlTarget, {
    schema: SEMANTIC_RETURN_CONTROL_TARGET_SCHEMA,
    state: 'unavailable',
    reason: 'return-control-target-not-representable',
  });
  assert.equal(node.unknown?.reason, 'return-control-target-not-representable');
  assert.deepEqual(node.attributes.machineControlEffect.target, target);
  assert.deepEqual(node.attributes.machineEffects.possibleFaults, bundle.possibleFaults);
  assert.ok(ir.unknowns.some((unknown) => unknown.reason === 'return-control-target-not-representable'));

  const projected = projectSemanticIrV2ToLegacyV1(ir);
  const instruction = projected.instructions.find((candidate) => candidate.semanticNodeId === node.id);
  assert.ok(instruction);
  assert.equal(instruction.extra.returnControlTarget.state, 'unavailable');
  assert.equal(Object.hasOwn(instruction.extra, 'returnControlTargetValueId'), false);
  assert.equal(Object.hasOwn(instruction, 'returnTargetValue'), false);
});

const CONTRACT_ORIGIN = Object.freeze({ instructionIds: ['c4-contract-origin'] });

function contractFunction({
  nodeKind = 'return',
  values = [{ id: 'target', kind: 'entry', machineType: { kind: 'bitvector', widthBits: 64 }, origin: CONTRACT_ORIGIN }],
  metadata,
  nodeCompleteness = 'complete',
  nodeUnknown,
  functionCompleteness = 'complete',
  unknowns = [],
} = {}) {
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'c4-return-control-target-contract',
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: ['node'], origin: CONTRACT_ORIGIN }],
    values,
    nodes: [{
      id: 'node',
      kind: nodeKind,
      blockId: 'entry',
      inputs: [],
      outputs: [],
      ...(metadata == null ? {} : { metadata }),
      ...(nodeCompleteness === 'complete' ? {} : { completeness: nodeCompleteness }),
      ...(nodeUnknown == null ? {} : { unknown: nodeUnknown }),
      origin: CONTRACT_ORIGIN,
    }],
    completeness: functionCompleteness,
    unknowns,
    origin: CONTRACT_ORIGIN,
  };
}

const resolvedTarget = (overrides = {}) => ({
  schema: SEMANTIC_RETURN_CONTROL_TARGET_SCHEMA,
  state: 'resolved',
  valueId: 'target',
  ...overrides,
});

test('C4 return target metadata is strict, typed, and counted in raw reference budgets', () => {
  const valid = createSemanticIrFunction(contractFunction({ metadata: { returnControlTarget: resolvedTarget() } }));
  assert.deepEqual(valid.nodes[0].metadata.returnControlTarget, resolvedTarget());

  assert.doesNotThrow(() => createSemanticIrFunction(contractFunction(), { budget: { maxReferences: 1 } }));
  assert.throws(
    () => createSemanticIrFunction(contractFunction({ metadata: { returnControlTarget: resolvedTarget() } }), { budget: { maxReferences: 1 } }),
    /semantic-ir-budget-exceeded-maxReferences/,
  );

  assert.throws(
    () => createSemanticIrFunction(contractFunction({ nodeKind: 'const', metadata: { returnControlTarget: resolvedTarget() } })),
    /semantic-ir-return-control-target-not-allowed/,
  );
  assert.throws(
    () => createSemanticIrFunction(contractFunction({ metadata: { returnControlTarget: resolvedTarget({ schema: 'semantic-return-control-target/v0' }) } })),
    /semantic-ir-return-control-target-schema-mismatch/,
  );
  assert.throws(
    () => createSemanticIrFunction(contractFunction({ metadata: { returnControlTarget: resolvedTarget({ valueId: 42 }) } })),
    /semantic-ir-invalid-return-control-target-value-id/,
  );
  assert.throws(
    () => createSemanticIrFunction(contractFunction({ metadata: { returnControlTarget: { ...resolvedTarget(), extra: true } } })),
    /semantic-ir-unexpected-return-control-target-field/,
  );
  assert.throws(
    () => createSemanticIrFunction(contractFunction({ metadata: { returnControlTarget: { ...resolvedTarget(), state: 'resolved-without-proof' } } })),
    /semantic-ir-invalid-return-control-target-state/,
  );
});

test('C4 resolved targets reject dangling values, disallowed scalar types, and hidden unavailable state', () => {
  assert.throws(
    () => createSemanticIrFunction(contractFunction({ values: [], metadata: { returnControlTarget: resolvedTarget() } })),
    /semantic-ir-dangling-return-control-target-value-id/,
  );
  assert.throws(
    () => createSemanticIrFunction(contractFunction({
      values: [{ id: 'target', kind: 'entry', machineType: { kind: 'predicate', widthBits: 1 }, origin: CONTRACT_ORIGIN }],
      metadata: { returnControlTarget: resolvedTarget() },
    })),
    /semantic-ir-invalid-return-control-target-machine-type/,
  );
  assert.throws(
    () => createSemanticIrFunction(contractFunction({
      metadata: {
        returnControlTarget: {
          schema: SEMANTIC_RETURN_CONTROL_TARGET_SCHEMA,
          state: 'unavailable',
          reason: 'not-representable',
        },
      },
    })),
    /semantic-ir-return-control-target-unknown-hidden/,
  );

  const partial = createSemanticIrFunction(contractFunction({
    metadata: {
      returnControlTarget: {
        schema: SEMANTIC_RETURN_CONTROL_TARGET_SCHEMA,
        state: 'unavailable',
        reason: 'not-representable',
      },
    },
    nodeCompleteness: 'partial',
    nodeUnknown: { reason: 'not-representable', categories: ['control'] },
    functionCompleteness: 'partial',
    unknowns: [{ reason: 'not-representable', categories: ['control'] }],
  }));
  assert.equal(partial.nodes[0].metadata.returnControlTarget.state, 'unavailable');
  assert.equal(partial.nodes[0].completeness, 'partial');
});

console.log('C4 return-control-target contract/pipeline tests: PASS');
