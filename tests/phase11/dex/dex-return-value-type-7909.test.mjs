import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDex, dexMethod } from '../fixtures/medium-dex.mjs';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

async function decodeBuilt(returnType, words, { strings = [] } = {}) {
  const { bytes } = buildDex({
    strings,
    methods: [{
      classType: 'LTest;', name: 'f', returnType, params: [], flags: 0x0009,
      registers: 2, ins: 0, words,
    }],
  });
  const frontend = new DexFrontend();
  const image = await frontend.open(bytes);
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  const validation = await frontend.validateMethod(decoded, { image });
  return { decoded, validation, lowered: lowerVMEffectsToSemanticIr(decoded) };
}

function returnedValue(lowered) {
  const node = lowered.semanticIr.nodes.find((item) => item.kind === 'return');
  assert.ok(node, 'expected canonical return node');
  assert.equal(node.inputs.length, 1);
  return lowered.semanticIr.values.find((value) => value.id === node.inputs[0]);
}

function assertType(actual, expected) {
  assert.deepEqual(actual, expected);
}

test('#7909: return-object preserves managed-reference type through the production frontend and bridge', async () => {
  const seed = buildDex({
    strings: ['hello'],
    methods: [{ classType:'LTest;', name:'f', returnType:'Ljava/lang/String;', params:[], flags:9, registers:1, ins:0, words:[0x000e] }],
  });
  const stringIdx = seed.layout.stringsList.indexOf('hello');
  const { decoded, validation, lowered } = await decodeBuilt('Ljava/lang/String;', [0x001a, stringIdx, 0x0011], { strings:['hello'] });
  const expected = { kind:'address', widthBits:32, addressSpace:'managed-heap' };
  const write = decoded.bundles.find((bundle) => bundle.mnemonic === 'const-string');
  const ret = decoded.bundles.find((bundle) => bundle.mnemonic === 'return-object');
  assertType(write.locationWrites[0].type, expected);
  assertType(ret.locationReads[0].type, expected);
  assertType(returnedValue(lowered).machineType, expected);
  assert.equal(ret.completeness, 'exact');
  assert.equal(validation.completeness.semanticEffect, 'complete');
  assert.equal(lowered.semanticIr.completeness, 'complete');
});

test('#7909: object and array return descriptors preserve managed-reference machine type', async () => {
  const expected = { kind:'address', widthBits:32, addressSpace:'managed-heap' };
  for (const descriptor of ['Ljava/lang/Object;', '[I', '[Ljava/lang/Object;']) {
    const { decoded, lowered } = await decodeBuilt(descriptor, [0x0011]);
    const ret = decoded.bundles[0];
    assertType(ret.locationReads[0].type, expected);
    assertType(returnedValue(lowered).machineType, expected);
  }
});

test('#7909: single and wide return families preserve primitive descriptor machine types', async () => {
  const cases = [
    ['I', 0x000f, { kind:'bitvector', widthBits:32 }],
    ['F', 0x000f, { kind:'float', widthBits:32, format:'binary32' }],
    ['J', 0x0010, { kind:'bitvector', widthBits:64 }],
    ['D', 0x0010, { kind:'float', widthBits:64, format:'binary64' }],
  ];
  for (const [descriptor, opcode, expected] of cases) {
    const { decoded, lowered } = await decodeBuilt(descriptor, [opcode]);
    assertType(decoded.bundles[0].locationReads[0].type, expected);
    assertType(returnedValue(lowered).machineType, expected);
  }
});

test('#7909: return opcode/category mismatch cannot remain an exact semantic return', async () => {
  const { decoded, validation, lowered } = await decodeBuilt('I', [0x0011]);
  assert.notEqual(decoded.bundles[0].completeness, 'exact');
  assert.ok(decoded.bundles[0].unknownEffects.some((effect) => effect.reason === 'dex-return-category-mismatch'));
  assert.equal(validation.completeness.semanticEffect, 'partial');
  assert.notEqual(lowered.semanticIr.completeness, 'complete');
});

test('#7909: unresolved return descriptor fails closed instead of fabricating a bitvector return', () => {
  const image = dexMethod([0x000f], {
    registers:1,
    methods:[{ name:'m', classType:'LTest;', proto:{ params:[], returnType:'Q' } }],
  });
  const fx = liftDexMethod(0, image);
  assert.notEqual(fx.bundles[0].completeness, 'exact');
  assert.equal(fx.bundles[0].locationReads.length, 0);
  assert.ok(fx.bundles[0].unknownEffects.some((effect) => effect.reason === 'dex-return-type-unresolved'));
  assert.notEqual(lowerVMEffectsToSemanticIr(fx).semanticIr.completeness, 'complete');
});
