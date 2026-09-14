import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDex } from '../fixtures/medium-dex.mjs';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { lowerVMEffectsToSemanticIr as lowerLegacy } from '../../../js/managed/shared/bridge.js';
import {
  decompileManagedMethod,
  lowerVMEffectsToSemanticIr as lowerV2,
} from '../../../js/managed/shared/bridge-v2.js';
import { createVMEffectFunction } from '../../../js/managed/shared/vm-effects.js';

function fixture(words) {
  return buildDex({
    fields: [],
    classNames: ['LTest;', 'LFoo;'],
    methods: [{
      classType: 'LTest;', name: 'alloc', returnType: 'V', params: [],
      flags: 9, registers: 4, ins: 0, outs: 0, words,
    }],
  });
}

async function liftedNewInstance() {
  const seed = fixture([0x0022, 0, 0x000e]);
  const typeIdx = seed.layout.typesList.indexOf('LFoo;');
  assert.ok(typeIdx >= 0);
  const frontend = new DexFrontend();
  const image = await frontend.open(fixture([0x0022, typeIdx, 0x000e]).bytes, { binaryId: 'dex-7999-new-instance' });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const method = methods.find((entry) => entry.name === 'alloc');
  assert.ok(method);
  const decoded = await frontend.decodeMethod(method, { image });
  const validated = await frontend.validateMethod(decoded);
  return frontend.liftMethod(decoded, validated);
}

function assertFailClosedAllocation(lowered, label) {
  const node = lowered.semanticIr.nodes.find((entry) => entry.metadata?.mnemonic === 'new-instance');
  assert.ok(node, `${label}: new-instance node present`);
  assert.notEqual(node.kind, 'compare', `${label}: allocation is never fabricated as compare`);
  assert.equal(node.completeness, 'partial', `${label}: unmodelled allocation may not publish complete semantics`);
  assert.equal(node.unknown?.reason, 'dex-new-instance-allocation-unrepresented');
  assert.ok(node.unknown?.categories.includes('heap'));
  assert.equal(node.metadata?.opcode, 0x22, `${label}: exact DEX operation provenance retained`);
  assert.equal(node.outputs.length, 1, `${label}: allocation output retained`);
  const output = lowered.semanticIr.values.find((value) => value.id === node.outputs[0]);
  assert.ok(output, `${label}: allocation output value present`);
  assert.equal(output.machineType.kind, 'address');
  assert.equal(output.machineType.addressSpace, 'managed-heap');
  assert.equal(output.machineType.widthBits, 32);
  assert.equal(lowered.semanticIr.completeness, 'partial', `${label}: function authority fails closed`);
  assert.ok(lowered.semanticIr.unknowns.some((entry) => entry.reason === 'dex-new-instance-allocation-unrepresented'));
}

function comparisonControl() {
  return createVMEffectFunction({
    frontendId: 'dex', methodId: 'dex:cmp-control',
    bundles: [{
      frontendId: 'dex', methodId: 'dex:cmp-control', operationId: 'dex:cmp-control:0',
      bytecodeOffset: 0, opcode: 0x31, mnemonic: 'cmp-long',
      consumedValues: [
        { bits: 64, type: { kind: 'bitvector', widthBits: 64 } },
        { bits: 64, type: { kind: 'bitvector', widthBits: 64 } },
      ],
      producedValues: [{ bits: 32, type: { kind: 'bitvector', widthBits: 32 } }],
      locationReads: [], locationWrites: [], memoryEffects: [], callEffects: [], controlEffects: [],
      possibleExceptions: [], completeness: 'exact', unknownEffects: [],
    }],
  });
}

test('#7999 new-instance is frontend-authoritatively fail-closed until allocation semantics are represented', async () => {
  const lifted = await liftedNewInstance();
  const bundle = lifted.bundles.find((entry) => entry.mnemonic === 'new-instance');
  assert.ok(bundle);
  assert.equal(bundle.opcode, 0x22);
  assert.equal(bundle.completeness, 'partial');
  assert.equal(bundle.unknownEffects?.[0]?.reason, 'dex-new-instance-allocation-unrepresented');
  assert.equal(bundle.unknownEffects?.[0]?.category, 'heap');
  assert.deepEqual(bundle.unknownEffects?.[0]?.categories, ['heap']);
  assert.equal(bundle.producedValues?.[0]?.classType, 'LFoo;');
  assert.equal(bundle.producedValues?.[0]?.type?.kind, 'address');
  assert.equal(bundle.producedValues?.[0]?.type?.addressSpace, 'managed-heap');

  assertFailClosedAllocation(lowerLegacy(lifted), 'legacy bridge');
  assertFailClosedAllocation(lowerV2(lifted), 'v2 bridge');
  const decompiled = decompileManagedMethod(lifted);
  assert.equal(decompiled.lines.some((line) => line.includes('!=')), false);
});

test('#7999 genuine DEX comparison remains a complete compare', () => {
  const fn = comparisonControl();
  for (const [label, lower] of [['legacy bridge', lowerLegacy], ['v2 bridge', lowerV2]]) {
    const lowered = lower(fn);
    const node = lowered.semanticIr.nodes.find((entry) => entry.metadata?.mnemonic === 'cmp-long');
    assert.ok(node, `${label}: cmp-long present`);
    assert.equal(node.kind, 'compare');
    assert.equal(node.completeness, 'complete');
    assert.equal(lowered.semanticIr.completeness, 'complete');
  }
});
