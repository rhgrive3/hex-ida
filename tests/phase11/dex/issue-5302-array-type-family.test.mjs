import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { decompileManagedMethod, lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { buildMemorySsa } from '../../../js/semantics/memoryssa/build.js';
import { dexMethod } from '../fixtures/medium-dex.mjs';

const variants = [
  ['I', 4, null], ['J', 8, null], ['Ljava/lang/Object;', 4, null],
  ['Z', 1, 'zero'], ['B', 1, 'sign'], ['C', 2, 'zero'], ['S', 2, 'sign'],
];
const first = (words, options = {}) => liftDexMethod(0, dexMethod(words, options)).bundles[0];
const accessWords = (opcode) => [opcode | (3 << 8), 0x0201, 0x000e]; // v3, v1[array], v2[index]

function memoryNode(lowered) {
  return lowered.semanticIr.nodes.find((node) => node.kind === 'load' || node.kind === 'store');
}

function reasons(bundle) {
  return (bundle.unknownEffects ?? []).map((effect) => effect.reason);
}

test('#5302 aget/aput variants publish array base/index/value bindings and storage widths', () => {
  for (let variant = 0; variant < variants.length; variant++) {
    const [descriptor, byteWidth, extension] = variants[variant];
    for (const isWrite of [false, true]) {
      const opcode = (isWrite ? 0x4b : 0x44) + variant;
      const fn = liftDexMethod(0, dexMethod(accessWords(opcode), { registers:8 }));
      const bundle = fn.bundles[0], memory = bundle.memoryEffects[0];
      assert.equal(bundle.completeness, 'exact', `opcode 0x${opcode.toString(16)}`);
      assert.equal(memory.space, 'array-element');
      assert.equal(memory.isWrite, isWrite);
      assert.equal(memory.byteWidth, byteWidth);
      assert.equal(memory.descriptor, descriptor);
      assert.equal(memory.addressReadIndex, 0);
      assert.equal(memory.indexReadIndex, 1);
      assert.equal(memory.valueReadIndex, isWrite ? 2 : null);
      assert.equal(memory.extension, extension);
      assert.equal(bundle.locationReads[0].index, 1);
      assert.equal(bundle.locationReads[1].index, 2);
      if (isWrite) assert.equal(bundle.locationReads[2].index, 3);
      else assert.equal(bundle.locationWrites[0].index, 3);
      if (descriptor === 'Ljava/lang/Object;') {
        assert.equal((isWrite ? bundle.locationReads[2] : bundle.locationWrites[0]).type.kind, 'address');
      }
    }
  }
});

test('#5302 array accesses survive Semantic IR, decompiler, and MemorySSA with indexed addresses', () => {
  for (const opcode of [0x48, 0x4f]) { // aget-byte / aput-byte
    const fn = liftDexMethod(0, dexMethod(accessWords(opcode), { registers:8 }));
    const lowered = lowerVMEffectsToSemanticIr(fn);
    const memory = memoryNode(lowered);
    assert.ok(memory);
    assert.equal(memory.memory.addressSpace, 'array-element');
    assert.equal(memory.memory.widthBits, 8);
    const address = lowered.semanticIr.nodes.find((node) => node.operator === 'managed.dex.array-element-address');
    assert.equal(address?.inputs.length, 2);
    if (opcode === 0x48) assert.ok(lowered.semanticIr.nodes.some((node) => node.kind === 'sext'));
    else assert.ok(lowered.semanticIr.nodes.some((node) => node.kind === 'trunc'));
    const memorySsa = buildMemorySsa(lowered.semanticIr, lowered.cfg);
    assert.ok(memorySsa.accessMetadata.some((access) => access.sourceEntityId === memory.id));
    assert.doesNotThrow(() => decompileManagedMethod(lowered));
  }
});

test('#5302 array-length/new-array and filled-new-array expose concrete typed register/result flow', () => {
  const length = first([0x1021, 0x000e]);
  assert.equal(length.mnemonic, 'array-length');
  assert.equal(length.completeness, 'exact');
  assert.equal(length.locationReads[0].index, 1);
  assert.equal(length.locationWrites[0].index, 0);

  const allocated = first([0x1023, 1, 0x000e], { types:['LTest;', '[I'] });
  assert.equal(allocated.mnemonic, 'new-array');
  assert.equal(allocated.locationReads[0].index, 1);
  assert.equal(allocated.locationWrites[0].index, 0);
  assert.equal(allocated.producedValues[0].arrayType, '[I');
  assert.equal(allocated.completeness, 'partial');
  assert.ok(reasons(allocated).includes('dex-array-allocation-identity-unrepresented'));

  for (const [words, expected] of [
    [[0x2024, 1, 0x0021, 0x030c, 0x000e], [1, 2]],
    [[0x0225, 1, 1, 0x030c, 0x000e], [1, 2]],
  ]) {
    const fn = liftDexMethod(0, dexMethod(words, { types:['LTest;', '[I'], registers:8 }));
    assert.match(fn.bundles[0].mnemonic, /^filled-new-array/);
    assert.deepEqual(fn.bundles[0].locationReads.map((read) => read.index), expected);
    assert.equal(fn.bundles[0].locationWrites[0].name, 'result');
    assert.equal(fn.bundles[1].mnemonic, 'move-result-object');
    assert.equal(fn.bundles[1].locationReads[0].name, 'result');
    assert.equal(fn.bundles[1].locationWrites[0].index, 3);
  }
});

test('#5302 check-cast/instance-of preserve target type evidence and typed state flow', () => {
  const types = ['LTest;', 'Ljava/lang/String;'];
  const cast = first([0x011f, 1, 0x000e], { types });
  assert.equal(cast.mnemonic, 'check-cast');
  assert.equal(cast.completeness, 'exact');
  assert.equal(cast.locationReads[0].index, 1);
  assert.equal(cast.locationWrites[0].index, 1);
  assert.equal(cast.locationWrites[0].type.kind, 'address');
  assert.equal(cast.metadata.typeCast.targetType, 'Ljava/lang/String;');
  assert.ok(cast.possibleExceptions.some((entry) => entry.exceptionType === 'java/lang/ClassCastException'));

  const instanceOf = first([0x1020, 1, 0x000e], { types });
  assert.equal(instanceOf.mnemonic, 'instance-of');
  assert.equal(instanceOf.completeness, 'exact');
  assert.equal(instanceOf.locationReads[0].index, 1);
  assert.equal(instanceOf.locationWrites[0].index, 0);
  assert.equal(instanceOf.metadata.typeTest.targetType, 'Ljava/lang/String;');
  assert.doesNotThrow(() => lowerVMEffectsToSemanticIr(liftDexMethod(0, dexMethod([0x1020, 1, 0x000e], { types }))));
});

test('#5302 fill-array-data validates payload boundary/width before publishing bulk array memory', () => {
  const validWords = [
    0x0026, 4, 0, 0x000e,
    0x0300, 4, 2, 0,
    0x1122, 0x3344, 0x5566, 0x7788,
  ];
  const valid = first(validWords);
  assert.equal(valid.mnemonic, 'fill-array-data');
  assert.equal(valid.memoryEffects.length, 1);
  assert.equal(valid.memoryEffects[0].space, 'array-element');
  assert.equal(valid.memoryEffects[0].byteWidth, 4);
  assert.equal(valid.memoryEffects[0].elementCount, 2);
  assert.equal(valid.memoryEffects[0].payloadByteLength, 8);
  assert.equal(valid.completeness, 'partial');
  assert.ok(reasons(valid).includes('dex-fill-array-data-array-type-unresolved'));
  assert.doesNotThrow(() => lowerVMEffectsToSemanticIr(liftDexMethod(0, dexMethod(validWords))));

  const invalidWidth = first([
    0x0026, 4, 0, 0x000e,
    0x0300, 3, 1, 0,
    0x2211, 0x0033,
  ]);
  assert.notEqual(invalidWidth.completeness, 'exact');
  assert.deepEqual(invalidWidth.memoryEffects, []);
  assert.ok(reasons(invalidWidth).includes('dex-fill-array-data-element-width-invalid'));

  const misaligned = first([0x0026, 3, 0, 0x000e]);
  assert.notEqual(misaligned.completeness, 'exact');
  assert.deepEqual(misaligned.memoryEffects, []);
  assert.ok(reasons(misaligned).includes('dex-fill-array-data-payload-misaligned'));
});

test('#5302 monitor-enter/exit are explicit synchronization effects', () => {
  for (const [opcode, kind] of [[0x1d, 'monitor-enter'], [0x1e, 'monitor-exit']]) {
    const bundle = first([opcode | (1 << 8), 0x000e]);
    assert.equal(bundle.mnemonic, kind);
    assert.equal(bundle.completeness, 'exact');
    assert.equal(bundle.locationReads[0].index, 1);
    assert.deepEqual(bundle.controlEffects[0], { kind, receiverReadIndex:0 });
  }
});

test('#5302 existing new-instance and throw semantics remain intact', () => {
  const allocated = first([0x0022, 0, 0x000e]);
  assert.equal(allocated.mnemonic, 'new-instance');
  assert.equal(allocated.locationWrites[0].index, 0);
  assert.equal(allocated.completeness, 'partial');
  const thrown = first([0x0027, 0x000e]);
  assert.equal(thrown.mnemonic, 'throw');
  assert.equal(thrown.controlEffects[0]?.kind, 'throw');
});
