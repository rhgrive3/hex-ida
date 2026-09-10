import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';

function withNativeWidth(image, bits) {
  return {
    ...image,
    requires32Bit: bits === 32,
    requires64Bit: bits === 64,
  };
}

function assertManagedPointer(value, bits) {
  assert.equal(value.stackType, 'managed-pointer');
  const inner = value.pointee ?? value.referent;
  assert.equal(inner?.stackType, 'int32');
  if (bits == null) assert.equal(value.bits, undefined);
  else assert.equal(value.bits, bits);
}

function byrefReturnImage() {
  return parseCil(buildCil({
    methods: [
      // static int32& Target(); no body, called by Run.
      { name: 'Target', signature: Uint8Array.from([0x00, 0x00, 0x10, 0x08]) },
      { name: 'Run', signature: Uint8Array.from([0x00, 0x00, 0x01]), body: [0x28, 0x01, 0x00, 0x00, 0x06, 0x26, 0x2a] },
    ],
  }).bytes, { binaryId:'byref-return' });
}

function byrefArgumentAndLocalImage() {
  return parseCil(buildCil({
    methods: [{
      name: 'Run',
      // static void Run(int32&)
      signature: Uint8Array.from([0x00, 0x01, 0x01, 0x10, 0x08]),
      body: [0x02, 0x26, 0x06, 0x26, 0x2a], // ldarg.0; pop; ldloc.0; pop; ret
      fat: true,
      localVarSigTok: 0x11000001,
    }],
    standAloneSigs: [[0x07, 0x01, 0x10, 0x08]], // LOCAL_SIG: int32&
  }).bytes, { binaryId:'byref-slots' });
}

test('#7775 BYREF call return carries known native width and preserves referent identity', () => {
  const base = byrefReturnImage();
  for (const bits of [32, 64, null]) {
    const lifted = liftCilMethod(0, withNativeWidth(base, bits));
    const call = lifted.bundles.find((bundle) => bundle.mnemonic === 'call');
    assert.equal(call.callEffects[0].signatureResolved, true);
    assert.equal(call.producedValues.length, 1);
    assertManagedPointer(call.producedValues[0], bits);
  }
});

test('#7775 BYREF argument/local public values use the same native-width authority', () => {
  const base = byrefArgumentAndLocalImage();
  for (const bits of [32, 64, null]) {
    const lifted = liftCilMethod(0, withNativeWidth(base, bits));
    const ldarg = lifted.bundles.find((bundle) => bundle.mnemonic === 'ldarg.0');
    const ldloc = lifted.bundles.find((bundle) => bundle.mnemonic === 'ldloc.0');
    assertManagedPointer(ldarg.producedValues[0], bits);
    assertManagedPointer(ldloc.producedValues[0], bits);
  }
});
