// Regression for #5096: the CIL FE-prefix table misdefined constrained./
// volatile./unaligned. and fabricated exact bundles from their operands.
// ECMA-335 §II.25.5: FE 12 unaligned. takes a 1-byte alignment operand
// (1/2/4 only), FE 13 volatile., FE 14 tail., FE 16 constrained. takes a
// 4-byte type token, FE 1E readonly.. Prefixes bind to the following
// instruction and must never surface as standalone exact operations.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liftCilMethod } from '../js/managed/cil/lifter-core.js';

function cilImage(bytecode) {
  return {
    moduleId: 'managed-mod:managed-image:bin:test-5096',
    vmSpecEdition: 'cli',
    methodBodies: [{
      bytecode,
      codeOffset: 0,
      headerOffset: 100,
      maxStack: 8,
      isTiny: false,
      exceptionClauses: [],
    }],
  };
}

function lift(bytecode) {
  return liftCilMethod(0, cilImage(Uint8Array.from(bytecode)));
}

function summary(fn) {
  return fn.bundles.map((b) => ({
    off: b.bytecodeOffset,
    opcode: b.opcode,
    mnemonic: b.mnemonic,
    completeness: b.completeness,
  }));
}

test('#5096 constrained. consumes its 4-byte type token as one prefix bundle', () => {
  // 00: FE 16 01 00 00 02  constrained. 0x02000001
  // 06: 6F 01 00 00 0A     callvirt 0x0A000001
  // 0B: 2A                 ret
  const fx = lift([0xfe, 0x16, 0x01, 0x00, 0x00, 0x02, 0x6f, 0x01, 0x00, 0x00, 0x0a, 0x2a]);
  const offsets = fx.bundles.map((b) => b.bytecodeOffset);
  assert.deepEqual(offsets, [6, 11], `false bundles from the token bytes: ${JSON.stringify(summary(fx))}`);
  assert.ok(!fx.bundles.some((b) => b.opcode === 0xfe16), 'constrained. stays a standalone exact bundle');
  const callvirt = fx.bundles[0];
  assert.equal(callvirt.mnemonic, 'callvirt');
  assert.equal(callvirt.metadata.constrained.bytecodeOffset, 0);
  assert.equal(callvirt.metadata.constrained.typeToken, 0x02000001);
  assert.equal(callvirt.metadata.constrained.provenance.start, 0);
  assert.equal(callvirt.metadata.constrained.provenance.end, 6);
});

test('#5096 unaligned. consumes its alignment operand instead of faking ldarg.2', () => {
  // 00: FE 12 04  unaligned. 4
  // 03: 2A        ret
  const fx = lift([0xfe, 0x12, 0x04, 0x2a]);
  assert.deepEqual(summary(fx).map((b) => [b.off, b.mnemonic]), [[3, 'ret']]);
  const ret = fx.bundles[0];
  assert.equal(ret.metadata.unaligned.alignment, 4);
  assert.equal(ret.metadata.unaligned.bytecodeOffset, 0);
});

test('#5096 FE13 is the real volatile. and binds to the following store', () => {
  // 00: FE 13         volatile.
  // 02: 80 01 00 00 0A  stsfld 0x0A000001
  // 07: 2A              ret
  const fx = lift([0xfe, 0x13, 0x80, 0x01, 0x00, 0x00, 0x0a, 0x2a]);
  const store = fx.bundles.find((b) => b.mnemonic === 'stsfld');
  assert.ok(store, `volatile. operand bytes desynced the stream: ${JSON.stringify(summary(fx))}`);
  assert.equal(store.metadata.volatile.bytecodeOffset, 0);
  assert.deepEqual(store.memoryEffects[0], {
    space: 'static-field',
    token: 0x0a000001,
    isWrite: true,
    volatile: true,
  });
});

test('#5096 tail. and readonly. keep their prefix semantics, never standalone bundles', () => {
  // 00: FE 14        tail.
  // 02: 28 01 00 00 0A  call 0x0A000001
  // 07: 2A              ret
  const tailFx = lift([0xfe, 0x14, 0x28, 0x01, 0x00, 0x00, 0x0a, 0x2a]);
  assert.ok(!tailFx.bundles.some((b) => b.opcode === 0xfe14), 'tail. surfaced standalone');
  const call = tailFx.bundles.find((b) => b.mnemonic === 'call');
  assert.equal(call.metadata.tail.bytecodeOffset, 0);
  assert.equal(call.callEffects[0].tailCall, true);

  // 00: FE 1E        readonly.
  // 02: 7E 01 00 00 0A  ldsfld 0x0A000001
  // 07: 2A              ret
  const roFx = lift([0xfe, 0x1e, 0x7e, 0x01, 0x00, 0x00, 0x0a, 0x2a]);
  assert.ok(!roFx.bundles.some((b) => b.opcode === 0xfe1e), 'readonly. surfaced standalone');
  const load = roFx.bundles.find((b) => b.mnemonic === 'ldsfld');
  assert.equal(load.metadata.readonly.bytecodeOffset, 0);
  assert.equal(load.memoryEffects[0].readonly, true);
});

test('#5096 unaligned. rejects alignment values outside the CLI contract', () => {
  for (const alignment of [0, 3, 5, 8, 255]) {
    assert.throws(
      () => lift([0xfe, 0x12, alignment, 0x2a]),
      (error) => error instanceof TypeError && error.message === 'cil-invalid-unaligned-alignment',
      `alignment ${alignment} must fail closed`,
    );
  }
});

test('#5096 truncated unaligned./constrained. operands fail closed instead of exact fakes', () => {
  assert.throws(
    () => lift([0xfe, 0x12]),
    (error) => error instanceof TypeError && error.message === 'cil-truncated-operand',
  );
  assert.throws(
    () => lift([0xfe, 0x16, 0x01, 0x00, 0x00]),
    (error) => error instanceof TypeError && error.message === 'cil-truncated-operand',
  );
});

test('#5096 prefix chains keep every prefix byte/provenance and bind to the call effect', () => {
  // 00: FE 14           tail.
  // 02: FE 16 01 00 00 02  constrained. 0x02000001
  // 08: 6F 01 00 00 0A     callvirt 0x0A000001
  // 0D: 2A                 ret
  const fx = lift([0xfe, 0x14, 0xfe, 0x16, 0x01, 0x00, 0x00, 0x02, 0x6f, 0x01, 0x00, 0x00, 0x0a, 0x2a]);
  assert.deepEqual(fx.bundles.map((b) => b.bytecodeOffset), [8, 13],
    `chain desynced the stream: ${JSON.stringify(summary(fx))}`);
  const callvirt = fx.bundles[0];
  assert.equal(callvirt.mnemonic, 'callvirt');
  assert.equal(callvirt.metadata.tail.bytecodeOffset, 0);
  assert.equal(callvirt.metadata.constrained.bytecodeOffset, 2);
  assert.equal(callvirt.metadata.constrained.typeToken, 0x02000001);
  assert.deepEqual(
    callvirt.origin.byteRanges.map((r) => [r.start, r.end]).flat(),
    ['0', '13'],
    'prefix chain bytes must be inside the bundle provenance',
  );
  assert.equal(callvirt.callEffects[0].tailCall, true);
  assert.equal(callvirt.callEffects[0].constrainedTypeToken, 0x02000001);
});

test('#5096 modifier-prefixed bundles never aggregate to exact completeness', () => {
  const fx = lift([0xfe, 0x16, 0x01, 0x00, 0x00, 0x02, 0x6f, 0x01, 0x00, 0x00, 0x0a, 0x2a]);
  for (const bundle of fx.bundles) {
    if (bundle.metadata.constrained || bundle.metadata.tail || bundle.metadata.volatile
      || bundle.metadata.readonly || bundle.metadata.unaligned) {
      assert.equal(bundle.completeness, 'partial',
        `prefix-modified bundle promoted to ${bundle.completeness}`);
      assert.ok(bundle.unknownEffects.some((e) => e.reason?.startsWith('cil-prefix-modifier-unmodeled')));
    }
  }
});

test('#5096 a dangling modifier prefix fails closed and keeps the FE byte consumed', () => {
  assert.throws(
    () => lift([0xfe, 0x13]),
    (error) => error instanceof TypeError && error.message === 'cil-prefix-without-instruction',
  );
});
