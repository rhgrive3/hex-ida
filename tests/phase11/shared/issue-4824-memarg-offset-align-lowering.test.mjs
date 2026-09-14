import assert from 'node:assert/strict';

import {
  createManagedMethodId,
  createVMEffectBundle,
  createVMEffectFunction,
  createVMOperationId,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/index.js';

// #4824 — the shared VMEffects→Semantic IR lowering must not discard the
// Wasm memarg `offset`/`align` that the lifter preserved on memoryEffects:
// the effective address is base + offset (modeled as an add value
// dependency, since SemanticMemoryAccess addresses are value ids), and the
// alignment exponent must be converted to byte alignment. Unrepresentable
// offset/alignment must fail closed to partial instead of publishing a
// silently wrong complete access.

const methodId = createManagedMethodId('module-4824', 'memarg-lowering');

function bundle(bytecodeOffset, spec) {
  return createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: createVMOperationId(methodId, bytecodeOffset),
    bytecodeOffset,
    completeness: 'exact',
    ...spec,
  });
}

function fn(bundles) {
  return createVMEffectFunction({
    frontendId: 'wasm',
    methodId,
    bundles,
    aggregateCompleteness: 'exact',
  });
}

const pushZero = (bytecodeOffset) => bundle(bytecodeOffset, {
  opcode: 0x41,
  mnemonic: 'i32.const',
  producedValues: [{ bits: 32, constant: 0 }],
});

function memAccess(fnValue, operationId, kind) {
  return fnValue.semanticIr.nodes.find(
    (node) => node.kind === kind && node.sourceEffectIds.includes(operationId),
  );
}

function addFor(fnValue, operationId) {
  return fnValue.semanticIr.nodes.find(
    (node) => node.kind === 'binary' && node.operator === 'add' && node.sourceEffectIds.includes(operationId),
  );
}

function constNodeFor(fnValue, operationId) {
  return fnValue.semanticIr.nodes.find(
    (node) => node.kind === 'const' && node.sourceEffectIds.includes(operationId),
  );
}

function constantValue(fnValue, nodeId) {
  return fnValue.semanticIr.values.find(
    (value) => value.definitionNodeId === nodeId,
  );
}

{
  const loadId = createVMOperationId(methodId, 1);
  const lowered = fn([
    pushZero(0),
    bundle(1, {
      opcode: 0x28,
      mnemonic: 'i32.load',
      consumedValues: [{ id: 'addr', bits: 32 }],
      producedValues: [{ bits: 32 }],
      memoryEffects: [{ space: 'linear-memory', memoryIndex: 0, byteWidth: 4, offset: 16, align: 2, isWrite: false }],
    }),
  ]);
  const result = lowerVMEffectsToSemanticIr(lowered);
  const load = memAccess(result, loadId, 'load');
  assert.ok(load, 'i32.load must lower to a memory access');
  const add = addFor(result, loadId);
  assert.ok(add, 'a non-zero memarg offset must build an effective-address add dependency');
  assert.equal(load.memory.addressExpr.valueId, add.outputs[0],
    'the access address must be base+offset, not the raw base');
  const offsetNode = constNodeFor(result, loadId);
  assert.ok(offsetNode, 'the offset must be a constant operand');
  assert.equal(String(constantValue(result, offsetNode.id).metadata?.constant), '16',
    'the offset constant must carry the memarg offset value');
  const base = result.semanticIr.nodes.find(
    (node) => node.kind === 'const' && node.metadata?.mnemonic === 'i32.const' && node.sourceEffectIds.includes(createVMOperationId(methodId, 0)),
  );
  assert.equal(add.inputs[0], base.outputs[0], 'the add must consume the runtime base address value');
  assert.equal(load.memory.alignment, 4, 'align exponent 2 must lower to 4-byte alignment');
  assert.equal(result.semanticIr.completeness, 'complete', 'a representable offset must not degrade completeness');
}

{
  const storeId = createVMOperationId(methodId, 2);
  const lowered = fn([
    pushZero(0),
    pushZero(1),
    bundle(2, {
      opcode: 0x36,
      mnemonic: 'i32.store',
      consumedValues: [{ id: 'val', bits: 32 }, { id: 'addr', bits: 32 }],
      memoryEffects: [{ space: 'linear-memory', memoryIndex: 0, byteWidth: 4, offset: 16, align: 2, isWrite: true }],
    }),
  ]);
  const result = lowerVMEffectsToSemanticIr(lowered);
  const store = memAccess(result, storeId, 'store');
  assert.ok(store, 'i32.store must lower to a memory access');
  const add = addFor(result, storeId);
  assert.ok(add, 'stores must keep the memarg offset too');
  assert.equal(store.memory.addressExpr.valueId, add.outputs[0]);
  assert.equal(store.memory.alignment, 4);
  assert.equal(result.semanticIr.completeness, 'complete');
}

{
  const zeroId = createVMOperationId(methodId, 1);
  const lowered = fn([
    pushZero(0),
    bundle(1, {
      opcode: 0x28,
      mnemonic: 'i32.load',
      consumedValues: [{ id: 'addr', bits: 32 }],
      producedValues: [{ bits: 32 }],
      memoryEffects: [{ space: 'linear-memory', memoryIndex: 0, byteWidth: 4, offset: 0, align: 2, isWrite: false }],
    }),
  ]);
  const result = lowerVMEffectsToSemanticIr(lowered);
  const load = memAccess(result, zeroId, 'load');
  assert.equal(addFor(result, zeroId), undefined, 'offset=0 must keep the existing single-value address');
  const base = result.semanticIr.nodes.find(
    (node) => node.kind === 'const' && node.metadata?.mnemonic === 'i32.const' && node.sourceEffectIds.includes(createVMOperationId(methodId, 0)),
  );
  assert.equal(load.memory.addressExpr.valueId, base.outputs[0], 'offset=0 must address the base value directly');
  assert.equal(load.memory.alignment, 4);
  assert.equal(result.semanticIr.completeness, 'complete');
}

{
  const lowId = createVMOperationId(methodId, 10);
  const highId = createVMOperationId(methodId, 11);
  const result = lowerVMEffectsToSemanticIr(fn([
    pushZero(0),
    pushZero(1),
    bundle(10, {
      opcode: 0x28,
      mnemonic: 'i32.load',
      consumedValues: [{ id: 'addr', bits: 32 }],
      producedValues: [{ bits: 32 }],
      memoryEffects: [{ space: 'linear-memory', memoryIndex: 0, byteWidth: 4, offset: 16, align: 2, isWrite: false }],
    }),
    bundle(11, {
      opcode: 0x28,
      mnemonic: 'i32.load',
      consumedValues: [{ id: 'addr', bits: 32 }],
      producedValues: [{ bits: 32 }],
      memoryEffects: [{ space: 'linear-memory', memoryIndex: 0, byteWidth: 4, offset: 24, align: 2, isWrite: false }],
    }),
  ]));
  const low = memAccess(result, lowId, 'load');
  const high = memAccess(result, highId, 'load');
  const lowAdd = addFor(result, lowId);
  const highAdd = addFor(result, highId);
  assert.ok(lowAdd && highAdd, 'both offset loads must build effective-address adds');
  assert.notEqual(low.memory.addressExpr.valueId, high.memory.addressExpr.valueId,
    'loads at different offsets must not alias to one semantic address');
  assert.equal(String(constantValue(result, constNodeFor(result, lowId).id).metadata?.constant), '16');
  assert.equal(String(constantValue(result, constNodeFor(result, highId).id).metadata?.constant), '24');
}

{
  const badOffsetId = createVMOperationId(methodId, 1);
  const result = lowerVMEffectsToSemanticIr(fn([
    pushZero(0),
    bundle(1, {
      opcode: 0x28,
      mnemonic: 'i32.load',
      consumedValues: [{ id: 'addr', bits: 32 }],
      producedValues: [{ bits: 32 }],
      memoryEffects: [{ space: 'linear-memory', memoryIndex: 0, byteWidth: 4, offset: 1.5, align: 2, isWrite: false }],
    }),
  ]));
  const load = memAccess(result, badOffsetId, 'load');
  assert.equal(load.completeness, 'partial', 'an unrepresentable offset must fail closed to partial');
  assert.equal(result.semanticIr.completeness, 'partial');
}

{
  const badAlignId = createVMOperationId(methodId, 1);
  const result = lowerVMEffectsToSemanticIr(fn([
    pushZero(0),
    bundle(1, {
      opcode: 0x28,
      mnemonic: 'i32.load',
      consumedValues: [{ id: 'addr', bits: 32 }],
      producedValues: [{ bits: 32 }],
      memoryEffects: [{ space: 'linear-memory', memoryIndex: 0, byteWidth: 4, offset: 0, align: -1, isWrite: false }],
    }),
  ]));
  const load = memAccess(result, badAlignId, 'load');
  assert.equal(load.completeness, 'partial', 'an unrepresentable alignment must fail closed to partial');
  assert.equal(result.semanticIr.completeness, 'partial');
}


{
  const multiId = createVMOperationId(methodId, 20);
  const result = lowerVMEffectsToSemanticIr(fn([
    pushZero(0),
    bundle(20, {
      opcode: 0x28,
      mnemonic: 'i32.load',
      consumedValues: [{ id: 'addr', bits: 32 }],
      producedValues: [{ bits: 32 }],
      memoryEffects: [
        { space: 'linear-memory', memoryIndex: 0, byteWidth: 4, offset: 16, align: 2, isWrite: false },
        { space: 'linear-memory', memoryIndex: 0, byteWidth: 4, offset: 0, align: 2, isWrite: false },
        { space: 'linear-memory', memoryIndex: 0, byteWidth: 4, offset: 24, align: 2, isWrite: false },
      ],
    }),
  ]));
  const loads = result.semanticIr.nodes.filter(
    (node) => node.kind === 'load' && node.sourceEffectIds.includes(multiId),
  );
  const adds = result.semanticIr.nodes.filter(
    (node) => node.kind === 'binary'
      && node.operator === 'add'
      && node.sourceEffectIds.includes(multiId),
  );
  const base = result.semanticIr.nodes.find(
    (node) => node.kind === 'const'
      && node.metadata?.mnemonic === 'i32.const'
      && node.sourceEffectIds.includes(createVMOperationId(methodId, 0)),
  );
  assert.equal(loads.length, 3, 'one semantic memory node per memory effect');
  assert.equal(adds.length, 2, 'only non-zero offsets need address adds');
  assert.equal(loads[0].memory.addressExpr.valueId, adds[0].outputs[0],
    'the first access must use base+16');
  assert.equal(loads[1].memory.addressExpr.valueId, base.outputs[0],
    'the zero-offset tail must reset to the original base');
  assert.equal(loads[2].memory.addressExpr.valueId, adds[1].outputs[0],
    'the later non-zero tail must use base+24');
  assert.equal(loads[1].metadata.memoryEffectIndex, 1);
  assert.equal(loads[2].metadata.memoryEffectIndex, 2);
  assert.deepEqual(loads.map((node) => node.memory.alignment), [4, 4, 4]);
  assert.equal(new Set(loads.map((node) => node.memory.addressExpr.valueId)).size, 3,
    'distinct offsets must not alias to one semantic address');
  assert.equal(result.semanticIr.completeness, 'complete');
}

console.log('issue-4824 memarg offset/align lowering: ok');
