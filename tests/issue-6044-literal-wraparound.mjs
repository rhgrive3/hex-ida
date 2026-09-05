import test from 'node:test';
import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../js/targets/architecture/arm64/effects/index.js';

function ldr(address, pcRelTarget) {
  return liftArm64MachineEffects({
    instructionId: 'audit-ldr-wraparound',
    architectureId: 'arm64',
    mode: 'a64',
    address,
    mnemonic: 'ldr',
    pcRelTarget,
    ops: [
      { k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' },
      { k: 'imm', value: pcRelTarget },
    ],
  });
}

test('6044: cross-boundary negative displacement stays in range', () => {
  const bundle = ldr(0x10n, 0xfffffffffffffff0n);
  assert.equal(bundle?.completeness, 'exact');
});

test('6044: ordinary in-range displacement stays exact', () => {
  const bundle = ldr(0x1000n, 0x1004n);
  assert.equal(bundle?.completeness, 'exact');
});

test('6044: genuinely out-of-range displacement still fails', () => {
  const bundle = ldr(0x1000n, 0x1000n + (1n << 20n));
  assert.equal(bundle?.completeness, 'partial');
  assert.match(bundle?.unknownEffects?.reason ?? '', /out-of-range/);
});
