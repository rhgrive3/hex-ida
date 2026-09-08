import assert from 'node:assert/strict';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';

function image(words) {
  const codeOff = 32;
  const rawBytes = new Uint8Array(codeOff + 16 + words.length * 2);
  const view = new DataView(rawBytes.buffer);
  view.setUint16(codeOff, 4, true);
  view.setUint16(codeOff + 2, 0, true);
  view.setUint16(codeOff + 4, 0, true);
  view.setUint16(codeOff + 6, 0, true);
  view.setUint32(codeOff + 8, 0, true);
  view.setUint32(codeOff + 12, words.length, true);
  words.forEach((word, index) => view.setUint16(codeOff + 16 + index * 2, word, true));
  return {
    moduleId: 'dex-3945',
    vmSpecEdition: 'dex-test',
    rawBytes,
    strings: [], types: [], fields: [],
    methods: [{ name: 'm', classType: 'LTest;' }],
    classes: [{
      directMethods: [{ methodIdx: 0, codeOff, accessFlags: 0x8 }],
      virtualMethods: [],
    }],
  };
}

function onlyBundle(words) {
  const lifted = liftDexMethod(0, image(words));
  assert.equal(lifted.bundles.length, 1);
  return { lifted, bundle: lifted.bundles[0] };
}

{
  const { lifted, bundle } = onlyBundle([0x0015, 0x000e]);
  assert.equal(bundle.mnemonic, 'dex_op_0x15');
  assert.equal(bundle.completeness, 'partial');
  assert.equal(bundle.controlEffects.length, 0);
  assert.equal(bundle.origin.byteRanges[0].end - bundle.origin.byteRanges[0].start, 4);
  assert.equal(lifted.aggregateCompleteness, 'partial');
}

for (const { words, width } of [
  { words: [0x0015, 0x000e, 0x000e], width: 2 },
  { words: [0x0017, 0x000e, 0, 0x000e], width: 3 },
  { words: [0x0018, 0x000e, 0, 0, 0, 0x000e], width: 5 },
  { words: [0x00fa, 0, 0x000e, 0, 0x000e], width: 4 },
]) {
  const lifted = liftDexMethod(0, image(words));
  assert.equal(lifted.bundles.length, 2);
  assert.equal(lifted.bundles[0].completeness, 'partial');
  assert.equal(lifted.bundles[0].controlEffects.length, 0);
  assert.equal(lifted.bundles[0].origin.byteRanges[0].end - lifted.bundles[0].origin.byteRanges[0].start, width * 2);
  assert.equal(lifted.bundles[1].bytecodeOffset, width * 2);
  assert.equal(lifted.bundles[1].mnemonic, 'return-void');
}

{
  const { bundle } = onlyBundle([0x0018, 0x000e]);
  assert.equal(bundle.completeness, 'partial');
  assert.equal(bundle.unknownEffects[0].reason, 'dex-truncated-instruction');
  assert.equal(bundle.controlEffects.length, 0);
  assert.equal(bundle.origin.byteRanges[0].end - bundle.origin.byteRanges[0].start, 4);
}

for (const { words, mnemonic, bytes } of [
  { words: [0x0100, 1, 0, 0, 0x000e, 0, 0x000e], mnemonic: 'packed-switch-payload', bytes: 12 },
  { words: [0x0200, 1, 0, 0, 0, 0x000e, 0x000e], mnemonic: 'sparse-switch-payload', bytes: 12 },
  { words: [0x0300, 1, 3, 0, 0x2a0e, 0, 0x000e], mnemonic: 'fill-array-data-payload', bytes: 12 },
]) {
  const lifted = liftDexMethod(0, image(words));
  assert.equal(lifted.bundles.length, 2);
  const bundle = lifted.bundles[0];
  assert.equal(bundle.mnemonic, mnemonic);
  assert.equal(bundle.completeness, 'partial');
  assert.equal(bundle.controlEffects.length, 0);
  assert.equal(bundle.origin.byteRanges[0].end - bundle.origin.byteRanges[0].start, bytes);
  assert.equal(lifted.bundles[1].bytecodeOffset, bytes);
  assert.equal(lifted.bundles[1].mnemonic, 'return-void');
  assert.equal(lifted.aggregateCompleteness, 'partial');
}

{
  const { bundle } = onlyBundle([0x0100]);
  assert.equal(bundle.completeness, 'partial');
  assert.equal(bundle.unknownEffects[0].reason, 'dex-truncated-payload-header');
  assert.equal(bundle.origin.byteRanges[0].end - bundle.origin.byteRanges[0].start, 2);
}

{
  const { bundle } = onlyBundle([0x0400, 0x000e]);
  assert.equal(bundle.completeness, 'partial');
  assert.equal(bundle.unknownEffects[0].reason, 'dex-unknown-payload-signature');
  assert.equal(bundle.controlEffects.length, 0);
  assert.equal(bundle.origin.byteRanges[0].end - bundle.origin.byteRanges[0].start, 4);
}

{
  const lifted = liftDexMethod(0, image([0x1012, 0x000e]));
  assert.equal(lifted.bundles.length, 2);
  assert.equal(lifted.bundles[0].mnemonic, 'const/4');
  assert.equal(lifted.bundles[0].producedValues[0].constant, 1);
  assert.equal(lifted.bundles[1].mnemonic, 'return-void');
  assert.equal(lifted.aggregateCompleteness, 'exact');
}

{
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => liftDexMethod(0, image([0x0015, 0x000e]), { signal: controller.signal }),
    (error) => error?.name === 'AbortError' && error?.message === 'vm-effects-cancelled',
  );
  assert.throws(
    () => liftDexMethod(0, image([0x0015, 0x000e]), { budget: { maxOperations: 0 } }),
    /vm-effect-resource-limit-operations/,
  );
}

console.log('[phase11] DEX instruction-boundary regression #3945 passed');
