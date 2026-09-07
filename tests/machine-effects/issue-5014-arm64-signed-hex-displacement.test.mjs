import assert from 'node:assert/strict';
import {
  Arm64AddressingError,
  buildArm64EffectiveAddress,
} from '../../js/targets/architecture/arm64/effects/addressing.js';

function address(mnemonic, mem, options = {}) {
  return buildArm64EffectiveAddress({
    mnemonic,
    ops: [{ k:'mem', base:'x0', ...mem }],
  }, { accessWidthBits:64, ...options });
}

function assertAddressError(fn, code) {
  assert.throws(fn, (error) => error instanceof Arm64AddressingError && error.code === code);
}

{
  const hex = address('ldur', { mode:'offset', disp:'-0x10' });
  const decimal = address('ldur', { mode:'offset', disp:'-16' });
  const bigint = address('ldur', { mode:'offset', disp:-16n });
  assert.equal(hex.metadata.addressDisplacement, '-16');
  assert.deepEqual(hex.addressExpr, decimal.addressExpr);
  assert.deepEqual(hex.addressExpr, bigint.addressExpr);
}

{
  const pre = address('ldr', { mode:'pre', disp:'-0x10' });
  assert.equal(pre.metadata.addressDisplacement, '-16');
  assert.equal(pre.metadata.writebackDisplacement, '-16');
  assert.equal(pre.writebackOperations.length, 2);

  const post = address('ldr', { mode:'post', disp:'-0x10' });
  assert.equal(post.metadata.addressDisplacement, '0');
  assert.equal(post.metadata.writebackDisplacement, '-16');
  assert.equal(post.addressExpr.kind, 'temporary');
}

{
  const positive = address('ldur', { mode:'offset', disp:'0x10' });
  assert.equal(positive.metadata.addressDisplacement, '16');
}

for (const value of ['--0x10', '0x', '0xGG', true, [16], Number.MAX_SAFE_INTEGER + 1]) {
  assertAddressError(
    () => address('ldur', { mode:'offset', disp:value }),
    'arm64-invalid-address-displacement',
  );
}

{
  const lowerBoundary = address('prfum', { mode:'offset', disp:'-0x100' });
  assert.equal(lowerBoundary.metadata.addressDisplacement, '-256');
  assertAddressError(
    () => address('prfum', { mode:'offset', disp:'-0x101' }),
    'arm64-prfum-immediate-out-of-range',
  );
}
