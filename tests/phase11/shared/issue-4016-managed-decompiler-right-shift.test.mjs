import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createManagedMethodId,
  createVMEffectBundle,
  createVMEffectFunction,
  createVMOperationId,
  decompileManagedMethod,
} from '../../../js/managed/index.js';
import { evalBinary } from '../../../js/decompiler/truth/integer.js';

function decompileShift({ frontendId, mnemonic, bits, lhs }) {
  const methodId = createManagedMethodId(`issue-4016-${frontendId}-${mnemonic}-${bits}`, 'shift');
  const bundle = (offset, input) => createVMEffectBundle({
    frontendId,
    methodId,
    operationId: createVMOperationId(methodId, offset),
    bytecodeOffset: offset,
    completeness: 'exact',
    ...input,
  });
  const bundles = frontendId === 'dex'
    ? [
      bundle(0, {
        mnemonic,
        locationReads: [
          { kind: 'register', index: 1, bits },
          { kind: 'register', index: 2, bits },
        ],
        locationWrites: [{ kind: 'register', index: 0, bits }],
        producedValues: [{ bits }],
      }),
      bundle(2, { mnemonic: 'return-void', controlEffects: [{ kind: 'return' }] }),
    ]
    : [
      bundle(0, { mnemonic: `${frontendId}.const.lhs`, producedValues: [{ bits, constant: lhs }] }),
      bundle(1, { mnemonic: `${frontendId}.const.rhs`, producedValues: [{ bits, constant: 1 }] }),
      bundle(2, {
        mnemonic,
        consumedValues: [{ id: 'rhs', bits }, { id: 'lhs', bits }],
        producedValues: [{ bits }],
      }),
      bundle(3, {
        mnemonic: 'return',
        consumedValues: [{ id: 'result', bits }],
        controlEffects: [{ kind: 'return' }],
      }),
    ];
  const fn = createVMEffectFunction({
    frontendId,
    methodId,
    bundles,
    aggregateCompleteness: 'exact',
    resolutionCompleteness: 'complete',
  });
  return decompileManagedMethod(fn);
}

function assertLogical(frontendId, mnemonic, bits) {
  const lhs = bits === 64 ? 0x8000000000000000n : 0x80000000;
  const out = decompileShift({ frontendId, mnemonic, bits, lhs });
  if (frontendId === 'dex') {
    assert.match(out.pseudocode, new RegExp(`\\(uint${bits}_t\\).*>>`), `${frontendId} ${mnemonic} must render an unsigned logical shift`);
    assert.doesNotMatch(out.pseudocode, new RegExp(`\\(int${bits}_t\\).*>>`), `${frontendId} ${mnemonic} must not render arithmetic shift semantics`);
  } else {
    const expected = bits === 64 ? '0x8000000000000000 >> 1' : '0x80000000 >> 1';
    const signed = bits === 64 ? '-9223372036854775808 >> 1' : '-2147483648 >> 1';
    assert.ok(out.pseudocode.includes(expected), `${frontendId} ${mnemonic} must render an unsigned logical shift`);
    assert.ok(!out.pseudocode.includes(signed), `${frontendId} ${mnemonic} must not render arithmetic shift semantics`);
  }
}

function assertArithmetic(frontendId, mnemonic, bits) {
  const lhs = bits === 64 ? 0x8000000000000000n : 0x80000000;
  const out = decompileShift({ frontendId, mnemonic, bits, lhs });
  if (frontendId === 'dex') {
    assert.match(out.pseudocode, new RegExp(`\\(int${bits}_t\\).*>>`), `${frontendId} ${mnemonic} must render a signed arithmetic shift`);
    assert.doesNotMatch(out.pseudocode, new RegExp(`\\(uint${bits}_t\\).*>>`), `${frontendId} ${mnemonic} must not render logical shift semantics`);
  } else {
    const expected = bits === 64 ? '-9223372036854775808 >> 1' : '-2147483648 >> 1';
    const logical = bits === 64 ? '0x8000000000000000 >> 1' : '0x80000000 >> 1';
    assert.ok(out.pseudocode.includes(expected), `${frontendId} ${mnemonic} must render a signed arithmetic shift`);
    assert.ok(!out.pseudocode.includes(logical), `${frontendId} ${mnemonic} must not render logical shift semantics`);
  }
}

test('WASM shr_u/shr_s preserve signedness for i32/i64', () => {
  for (const bits of [32, 64]) {
    assertLogical('wasm', `i${bits}.shr_u`, bits);
    assertArithmetic('wasm', `i${bits}.shr_s`, bits);
  }
});

test('JVM iushr/lushr stay logical while ishr/lshr stay arithmetic', () => {
  assertLogical('jvm', 'iushr', 32);
  assertLogical('jvm', 'lushr', 64);
  assertArithmetic('jvm', 'ishr', 32);
  // Java's `lshr` mnemonic is arithmetic despite colliding with the canonical
  // AST spelling used for logical right shift.
  assertArithmetic('jvm', 'lshr', 64);
});

test('DEX ushr/shr int and long spellings preserve signedness', () => {
  assertLogical('dex', 'ushr-int', 32);
  assertLogical('dex', 'ushr-long', 64);
  assertArithmetic('dex', 'shr-int', 32);
  assertArithmetic('dex', 'shr-long', 64);
});

test('CIL shr.un is logical and shr remains arithmetic', () => {
  assertLogical('cil', 'shr.un', 32);
  assertArithmetic('cil', 'shr', 32);
});


test('unknown shift-like spellings fail closed instead of defaulting to arithmetic shift', () => {
  const out = decompileShift({
    frontendId: 'wasm',
    mnemonic: 'i32.shr_future',
    bits: 32,
    lhs: 0x80000000,
  });
  assert.match(out.pseudocode, /i32_shr_future\(/);
  assert.doesNotMatch(out.pseudocode, />>/);
});

test('concrete high-bit right-shift semantics stay distinct', () => {
  assert.equal(evalBinary('lshr', 0x80000000n, 1n, 32), 0x40000000n);
  assert.equal(evalBinary('ashr', 0x80000000n, 1n, 32), 0xc0000000n);
  assert.equal(evalBinary('lshr', 0x8000000000000000n, 1n, 64), 0x4000000000000000n);
  assert.equal(evalBinary('ashr', 0x8000000000000000n, 1n, 64), 0xc000000000000000n);
});
