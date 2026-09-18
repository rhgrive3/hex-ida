import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../js/targets/architecture/arm64/effects/index.js';
import { liftArm64eEffects } from '../js/targets/architecture/arm64e/index.js';

const LAST_WORD_ADDR = 0xfffffffffffffffcn; // 2^64 - 4n

// Helper to check no bitvector value or absolute-address value exceeds its declared width
function assertWidthInvariants(bundle) {
  if (bundle.controlEffect?.fallthrough?.kind === 'absolute-address') {
    const val = BigInt(bundle.controlEffect.fallthrough.value);
    const width = bundle.controlEffect.fallthrough.widthBits || 64;
    assert.ok(val >= 0n && val < (1n << BigInt(width)), `fallthrough ${val} out of width ${width}`);
  }
  if (bundle.controlEffect?.target?.kind === 'absolute-address') {
    const val = BigInt(bundle.controlEffect.target.value);
    const width = bundle.controlEffect.target.widthBits || 64;
    assert.ok(val >= 0n && val < (1n << BigInt(width)), `target ${val} out of width ${width}`);
  }
  for (const op of bundle.operations || []) {
    if (op.value?.kind === 'bitvector') {
      const val = BigInt(op.value.value);
      const width = op.value.widthBits;
      assert.ok(val >= 0n && val < (1n << BigInt(width)), `op value ${val} out of width ${width}`);
    }
  }
}

// 1. BL @ 0xfffffffffffffffcn
{
  const instruction = {
    instructionId: 'repro:bl',
    mode: 'a64',
    mnemonic: 'bl',
    address: LAST_WORD_ADDR,
    callTarget: 0x0n,
    ops: [{ k: 'imm', value: 0x0n }],
    // BL encoding to 0x0: target 0, PC 0xfffffffffffffffcn => displacement +4 => imm26 = 1
    rawBytes: [0x01, 0x00, 0x00, 0x94],
    origin: { instructionIds: ['repro:bl'] },
  };
  const bundle = liftArm64MachineEffects(instruction);
  assertWidthInvariants(bundle);
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.controlEffect?.kind, 'call');
  assert.equal(bundle.controlEffect?.target?.value, '0');
  assert.equal(bundle.controlEffect?.fallthrough?.value, '0');
  const x30Write = bundle.operations.find((op) => op.kind === 'register-write' && op.register?.registerId === 'x30');
  assert.ok(x30Write, 'x30 must be written');
  assert.equal(x30Write.value?.value, '0');
}

// 2. BLR @ 0xfffffffffffffffcn
{
  const instruction = {
    instructionId: 'repro:blr',
    mode: 'a64',
    mnemonic: 'blr',
    address: LAST_WORD_ADDR,
    ops: [{ k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' }],
    origin: { instructionIds: ['repro:blr'] },
  };
  const bundle = liftArm64MachineEffects(instruction);
  assertWidthInvariants(bundle);
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.controlEffect?.kind, 'call');
  assert.equal(bundle.controlEffect?.fallthrough?.value, '0');
  const x30Write = bundle.operations.find((op) => op.kind === 'register-write' && op.register?.registerId === 'x30');
  assert.ok(x30Write, 'x30 must be written');
  assert.equal(x30Write.value?.value, '0');
}

// 3. Conditional branches @ 0xfffffffffffffffcn
for (const condInst of [
  { mnemonic: 'b.eq', address: LAST_WORD_ADDR, branchTarget: 0x0n, ops: [{ k: 'imm', value: 0x0n }], rawBytes: [0x20, 0x00, 0x00, 0x54] },
  { mnemonic: 'cbz', address: LAST_WORD_ADDR, branchTarget: 0x0n, ops: [{ k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' }, { k: 'imm', value: 0x0n }], rawBytes: [0x20, 0x00, 0x00, 0xb4] },
  { mnemonic: 'tbz', address: LAST_WORD_ADDR, branchTarget: 0x0n, ops: [{ k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' }, { k: 'imm', value: 0n }, { k: 'imm', value: 0x0n }], rawBytes: [0x20, 0x00, 0x00, 0x36] },
]) {
  const bundle = liftArm64MachineEffects({
    instructionId: `repro:${condInst.mnemonic}`,
    mode: 'a64',
    ...condInst,
    origin: { instructionIds: [`repro:${condInst.mnemonic}`] },
  });
  assertWidthInvariants(bundle);
  assert.equal(bundle.controlEffect?.fallthrough?.value, '0', `${condInst.mnemonic} fallthrough must wrap to 0`);
}

// 4. ARM64e BLRAA / BLRAB / BLRAAZ / BLRABZ @ 0xfffffffffffffffcn
for (const mnemonic of ['blraa', 'blrab', 'blraaz', 'blrabz']) {
  const opStr = mnemonic.endsWith('z') ? 'x6' : 'x6, x7';
  const bundle = liftArm64eEffects({
    mnemonic,
    opStr,
    address: LAST_WORD_ADDR,
    instructionId: `repro:${mnemonic}`,
  });
  assertWidthInvariants(bundle);
  const x30Write = bundle.operations.find((op) => op.kind === 'register-write' && op.register?.registerId === 'x30');
  assert.ok(x30Write, `${mnemonic} must write x30`);
  assert.equal(x30Write.value?.value, '0', `${mnemonic} x30 link address must wrap to 0`);
}

console.log('issue-8600-arm64-pc-wrap: PASS');
