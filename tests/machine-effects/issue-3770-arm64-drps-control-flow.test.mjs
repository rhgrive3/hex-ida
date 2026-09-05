import test from 'node:test';
import assert from 'node:assert/strict';

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
