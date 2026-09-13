// Regression for #3964: the CIL `0xFE` prefix table must decode by ECMA-335
// opcode identity, consume each prefix's own operand bytes, and never promote
// a semantic modifier to an exact standalone operation. The buggy head treated
// FE16 as `volatile`/`prefix_16` without consuming the 4-byte `constrained.`
// type token and FE12 without consuming the `unaligned.` alignment immediate,
// so the operand bytes were re-decoded as fake `ret`/`nop`/`break` instructions.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liftCilMethod } from '../js/managed/cil/lifter-core.js';

function cilImage(bytecode) {
  return {
    moduleId: 'managed-mod:managed-image:bin:test-3964',
    vmSpecEdition: 'ecma-335',
    methodBodies: [{
      bytecode,
      codeOffset: 0,
      headerOffset: 0,
      exceptionClauses: [],
    }],
  };
}

function decode(bytes) {
  return liftCilMethod(0, cilImage(Uint8Array.from(bytes))).bundles;
}

function byteEnd(bundle) {
  return Number(bundle.origin.byteRanges[0].end);
}

function hasMnemonic(bundles, mnemonic) {
  return bundles.some((b) => b.mnemonic === mnemonic);
}

test('#3964 FE16 decodes as constrained. and consumes its 4-byte type token', () => {
  // FE 16 2A 00 00 00 -> constrained. <token 0x0000002a>
  const bundles = decode([0xfe, 0x16, 0x2a, 0x00, 0x00, 0x00]);
  assert.equal(bundles.length, 1, 'token bytes must not become extra instructions');
  const prefix = bundles[0];
  assert.equal(prefix.opcode, 0xfe16);
  assert.equal(prefix.mnemonic, 'constrained.');
  assert.equal(byteEnd(prefix), 6, 'the whole prefix + token must be one span');
  // fail-closed: an unattached modifier is never promoted to exact.
  assert.equal(prefix.completeness, 'partial');
  assert.ok(prefix.unknownEffects?.length >= 1);
});

test('#3964 constrained. token bytes never lift as a fake ret/nop stream', () => {
  // FE 16 2A 00 00 00 6F 00 00 00 00 -> constrained. then a real callvirt.
  const bundles = decode([0xfe, 0x16, 0x2a, 0x00, 0x00, 0x00, 0x6f, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(hasMnemonic(bundles, 'ret'), false, 'token byte 0x2a must not decode as ret');
  assert.equal(hasMnemonic(bundles, 'nop'), false, 'token zero bytes must not decode as nop');
  const callvirt = bundles.find((b) => b.mnemonic === 'callvirt');
  assert.ok(callvirt, 'the real callvirt after the prefix must still be reached');
  assert.equal(callvirt.bytecodeOffset, 6, 'callvirt must start right after the consumed token');
});

test('#3964 FE12 decodes as unaligned. and consumes its 1-byte alignment', () => {
  // FE 12 01 -> unaligned. 1
  const bundles = decode([0xfe, 0x12, 0x01]);
  assert.equal(bundles.length, 1, 'alignment byte must not become a break instruction');
  const prefix = bundles[0];
  assert.equal(prefix.opcode, 0xfe12);
  assert.equal(prefix.mnemonic, 'unaligned.');
  assert.equal(byteEnd(prefix), 3);
  assert.equal(prefix.completeness, 'partial');
});

test('#3964 unaligned. with an invalid alignment stays partial, never exact', () => {
  // ECMA-335 only permits alignment 1/2/4 for unaligned.; 3 is malformed.
  const bundles = decode([0xfe, 0x12, 0x03]);
  assert.equal(bundles.length, 1);
  const prefix = bundles[0];
  assert.equal(prefix.mnemonic, 'unaligned.');
  assert.equal(prefix.completeness, 'partial');
  assert.ok(prefix.unknownEffects?.length >= 1);
});

test('#3964 FE13 is recognized as volatile. (was falling to default partial)', () => {
  const bundles = decode([0xfe, 0x13]);
  const prefix = bundles[0];
  assert.equal(prefix.opcode, 0xfe13);
  assert.equal(prefix.mnemonic, 'volatile.');
  assert.equal(prefix.completeness, 'partial');
});

test('#3964 tail. and readonly. remain recognized and are not exact standalone ops', () => {
  const tail = decode([0xfe, 0x14])[0];
  assert.equal(tail.mnemonic, 'tail.');
  assert.equal(tail.completeness, 'partial');
  const readonly = decode([0xfe, 0x1e])[0];
  assert.equal(readonly.mnemonic, 'readonly.');
  assert.equal(readonly.completeness, 'partial');
});
