import test from 'node:test';
import assert from 'node:assert/strict';

import { partitionDecodedFunction } from '../../js/analysis/semantic-function.js';
import {
  ARM64_ARCHITECTURE,
  ARM64E_ARCHITECTURE,
} from '../../js/targets/architecture/index.js';

for (const [name, architecture] of [
  ['arm64', ARM64_ARCHITECTURE],
  ['arm64e', ARM64E_ARCHITECTURE],
]) {
  test(`3770: ${name} treats DRPS as non-fallthrough unknown control`, () => {
    assert.equal(architecture.classifyControlFlow({ mnemonic:'drps' }), 'unknown');
    assert.equal(architecture.classifyControlFlow({ mnemonic:'DRPS' }), 'unknown');
  });

  test(`3770: ${name} shared CFG emits no normal DRPS-to-MOV successor`, () => {
    const blocks = partitionDecodedFunction([
      { address:0x1000n, length:4n, mnemonic:'drps' },
      { address:0x1004n, length:4n, mnemonic:'mov' },
      { address:0x1008n, length:4n, mnemonic:'ret' },
    ], architecture);
    const drps = blocks.find((block) => block.startAddress === 0x1000n);
    const after = blocks.find((block) => block.startAddress === 0x1004n);

    assert.ok(drps, 'DRPS must start its decoded block');
    assert.ok(after, 'the instruction after DRPS must start a distinct block');
    assert.deepEqual(
      drps.instructions.map(({ decoded }) => decoded.mnemonic),
      ['drps'],
      'DRPS must terminate its block instead of absorbing the next instruction',
    );
    assert.deepEqual(drps.successors, [], 'DRPS must not have a normal CFG successor');
    assert.equal(
      drps.successors.some((edge) => edge.to === after.key),
      false,
      'DRPS must not create a fallthrough edge to MOV',
    );
  });
}

test('3770: existing exceptional/system control classifications are preserved', () => {
  for (const mnemonic of ['eret','eretaa','eretab','brk','hlt','svc','hvc','smc']) {
    assert.equal(
      ARM64_ARCHITECTURE.classifyControlFlow({ mnemonic }),
      'unknown',
      `${mnemonic} must remain non-fallthrough`,
    );
  }
});

test('3770: ordinary ARM64 instructions still fall through', () => {
  assert.equal(ARM64_ARCHITECTURE.classifyControlFlow({ mnemonic:'mov' }), 'fallthrough');
});
