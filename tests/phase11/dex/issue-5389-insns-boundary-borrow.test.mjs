import test from 'node:test';
import assert from 'node:assert/strict';

import { liftDexMethod } from '../../../js/managed/dex/lifter.js';

// Builds a minimal DEX image. `insnsWords` is the DECLARED insns_size stream;
// `streamWords` (default: same) are the words physically present in the file,
// so a longer stream simulates padding/foreign data beyond the declared end.
function image(insnsWords, streamWords) {
  const words = streamWords ?? insnsWords;
  const codeOff = 32;
  const rawBytes = new Uint8Array(codeOff + 16 + words.length * 2);
  const view = new DataView(rawBytes.buffer);
  view.setUint16(codeOff, 4, true);         // registers_size
  view.setUint16(codeOff + 2, 0, true);     // ins_size
  view.setUint16(codeOff + 4, 0, true);     // outs_size
  view.setUint16(codeOff + 6, 0, true);     // tries_size
  view.setUint32(codeOff + 8, 0, true);     // debug/info
  view.setUint32(codeOff + 12, insnsWords.length, true); // insns_size (declared)
  words.forEach((word, index) => view.setUint16(codeOff + 16 + index * 2, word, true));
  return {
    moduleId: 'dex-5389', vmSpecEdition: 'dex-test', rawBytes,
    strings: ['hello'], types: [], fields: [{ owner: 'LTest;', name: 'f', descriptor: 'I' }],
    methods: [{ name: 'm', classType: 'LTest;' }],
    classes: [{ directMethods: [{ methodIdx: 0, codeOff, accessFlags: 0x8 }], virtualMethods: [] }],
  };
}

test('#5389 a truncated const-string cannot borrow its operand from beyond insns_size', () => {
  // const-string v0, string@0 (2 code units) declared with insns_size = 1.
  // The string index word 0x0000 lies beyond the declared stream.
  const lifted = liftDexMethod(0, image([0x001a], [0x001a, 0x0000]));
  const bundle = lifted.bundles[0];

  assert.equal(bundle.completeness, 'partial',
    'the truncated instruction must stay partial');
  assert.ok(bundle.unknownEffects.some((u) => u?.reason === 'dex-truncated-instruction'),
    'the base boundary finding must survive the rebuild pass');
  assert.deepEqual([...(bundle.producedValues ?? [])], [],
    'no string reference may be fabricated from foreign bytes');
  assert.equal(lifted.aggregateCompleteness, 'partial');
});

test('#5389 a truncated invoke is not re-decoded into exact call effects', () => {
  // invoke-virtual (3 code units) declared with insns_size = 2.
  const lifted = liftDexMethod(0, image([0x6e10, 0x0002], [0x6e10, 0x0002, 0x0002]));
  const bundle = lifted.bundles[0];

  assert.equal(bundle.completeness, 'partial');
  assert.ok(bundle.unknownEffects.some((u) => String(u?.reason).startsWith('dex-')),
    'the bundle must carry a dex boundary finding');
  assert.deepEqual([...(bundle.locationReads ?? [])], [],
    'no register reads may be fabricated from beyond the stream');
});

test('#5389 in-frame instructions are still enhanced to exact effects', () => {
  // const-string v0, string@0 with a complete 2-unit stream.
  const lifted = liftDexMethod(0, image([0x001a, 0x0000]));
  const bundle = lifted.bundles[0];
  assert.equal(bundle.mnemonic, 'const-string');
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.producedValues[0]?.stringRef, 'hello');
  assert.equal(lifted.aggregateCompleteness, 'exact');
});
