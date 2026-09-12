import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOperands } from '../../js/arm64.js';
import { ARM64E_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { validateArm64ePacDenominator } from '../../tools/validation/machine-effects/arm64e-pac-denominator.mjs';

// #7319 accidentally removed #7317's zero-modifier definitions while adding
// authenticated loads. A reconciled provider must retain both contributions.
test('the reconciled ARM64e provider retains zero-modifier aliases AND authenticated loads', () => {
  for (const [mnemonic, opStr, memoryRead] of [
    ['paciaz', '', false], ['pacibz', '', false],
    ['autiaz', '', false], ['autibz', '', false],
    ['ldraa', 'x0, [x1]', true], ['ldrab', 'x0, [x1]', true],
  ]) {
    const instructionId = `reconciled-arm64e:${mnemonic}`;
    const bundle = ARM64E_ARCHITECTURE.liftExact({
      instructionId, mnemonic, opStr, ops: parseOperands(opStr), mode: 'arm64e',
      address: 0x1000n, origin: { instructionIds: [instructionId] },
    }, {});
    assert.equal(bundle?.completeness, 'exact-with-intrinsic', mnemonic);
    assert.equal(bundle.operations.some(operation => operation.kind === 'memory-read'), memoryRead, mnemonic);
    const key = mnemonic.includes('ib') || mnemonic === 'ldrab' ? 'APIBKey' : 'APIAKey';
    assert.ok(bundle.operations.some(operation => operation.kind === 'register-read'
      && operation.register.registerId === key), `${mnemonic}: retains the correct key state`);
  }
});

test('the reconciled ARM64e provider still covers the full frozen PAuth denominator', () => {
  assert.equal(validateArm64ePacDenominator().valid, true);
});
