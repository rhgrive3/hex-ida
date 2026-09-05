import assert from 'node:assert/strict';
import test from 'node:test';
import { riscv64MemoryFaults } from '../js/targets/architecture/riscv64/effects/common.js';

test('6027: 8-bit LB/LBU/SB must not carry address-misaligned', () => {
  for (const [direction, width] of [['read', 8], ['write', 8]]) {
    const faults = riscv64MemoryFaults(direction, width);
    assert.equal(faults.length, 1);
    const causes = faults[0].detail.causes;
    assert.ok(!causes.includes('address-misaligned'), `${direction}/${width} must not include address-misaligned, got ${causes}`);
    assert.ok(causes.includes('access-fault'));
    assert.ok(causes.includes('page-fault'));
  }
});

test('6027: 16/32/64-bit accesses retain misaligned possibility', () => {
  for (const width of [16, 32, 64]) {
    for (const direction of ['read', 'write']) {
      const faults = riscv64MemoryFaults(direction, width);
      assert.ok(faults[0].detail.causes.includes('address-misaligned'), `${direction}/${width} must retain misaligned`);
    }
  }
});

test('6027: fault metadata preserves direction and width', () => {
  const faults = riscv64MemoryFaults('read', 8);
  assert.equal(faults[0].kind, 'memory-access-fault');
  assert.deepEqual(faults[0].condition, { kind: 'riscv64-memory-fault', direction: 'read', widthBits: 8 });
});
