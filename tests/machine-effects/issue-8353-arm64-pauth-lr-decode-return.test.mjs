import assert from 'node:assert/strict';
import { categoryOf, isBranch, isReturn } from '../../js/arm64.js';
import { liftArm64eEffects, arm64ePointerAuthenticationMnemonics } from '../../js/targets/architecture/arm64e/effects.js';
import { ARM64E_ARCHITECTURE } from '../../js/targets/architecture/index.js';

function registerReads(bundle) {
  return bundle.operations
    .filter((operation) => operation.kind === 'register-read')
    .map((operation) => operation.register.registerId);
}

const sign = liftArm64eEffects({
  mnemonic:'paciasppc', address:0x1000n, instructionId:'issue-8353:paciasppc', mode:'arm64e', opStr:'',
});
assert.equal(sign.completeness, 'exact-with-intrinsic');
assert.equal(sign.controlEffect.kind, 'fallthrough');
for (const id of ['x30', 'sp', 'pc', 'APIAKey', 'PAuthState']) {
  assert.ok(registerReads(sign).includes(id), `PACIASPPC must read ${id}`);
}
assert.ok(sign.operations.some((operation) => operation.kind === 'register-write' && operation.register.registerId === 'x30'));
assert.equal(sign.metadata.implicitBti, true);
assert.equal(sign.metadata.pauthLrSecondModifier.unconditional, true);

const ret = liftArm64eEffects({
  mnemonic:'retaasppc', address:0x1018n, instructionId:'issue-8353:retaasppc', mode:'arm64e',
  opStr:'0x1000', pauthLrPcOffsetBytes:24n,
});
assert.equal(ret.completeness, 'exact-with-intrinsic');
assert.equal(ret.controlEffect.kind, 'return');
for (const id of ['x30', 'sp', 'pc', 'APIAKey', 'PAuthState']) {
  assert.ok(registerReads(ret).includes(id), `RETAASPPC must read ${id}`);
}
assert.equal(ret.metadata.pauthLrSecondModifier.kind, 'pc-minus-offset');
assert.equal(ret.metadata.pauthLrSecondModifier.encodedOffsetBytes, '24');
assert.equal(ret.operations.some((operation) => operation.kind === 'register-write' && operation.register.registerId === 'x30'), false,
  'enhanced authenticated return must not write the authenticated target back to LR');
const auth = ret.operations.find((operation) => operation.kind === 'intrinsic' && operation.intrinsicId === 'arm64e.pointer.authenticate');
assert.ok(auth);
assert.equal(auth.metadata.authThenBranch, true);

const retReg = liftArm64eEffects({
  mnemonic:'retaasppcr', address:0x2000n, instructionId:'issue-8353:retaasppcr', mode:'arm64e', opStr:'x28',
});
assert.equal(retReg.controlEffect.kind, 'return');
assert.ok(registerReads(retReg).includes('x28'));
assert.equal(retReg.metadata.pauthLrSecondModifier.registerId, 'x28');

for (const mnemonic of ['paciasppc', 'pacibsppc', 'retaasppc', 'retabsppc', 'retaasppcr', 'retabsppcr']) {
  assert.ok(arm64ePointerAuthenticationMnemonics().includes(mnemonic));
}
for (const mnemonic of ['retaasppc', 'retabsppc', 'retaasppcr', 'retabsppcr']) {
  assert.equal(isReturn(mnemonic), true);
  assert.equal(isBranch(mnemonic), true);
  assert.equal(categoryOf(mnemonic), 'flow');
  assert.equal(ARM64E_ARCHITECTURE.classifyControlFlow({ mnemonic }), 'return');
}
assert.equal(categoryOf('paciaspppc'), '', 'near-miss spelling must not be classified as the feature instruction');
assert.equal(categoryOf('paciasppc'), 'system');

console.log('issue 8353 ARM64 FEAT_PAuth_LR decode/control/effects: PASS');
