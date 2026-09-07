import assert from 'node:assert/strict';
import { liftArm64eEffects } from '../../js/targets/architecture/arm64e/effects.js';

function instruction(mnemonic, address = 0x1000n) {
  return {
    mnemonic,
    address,
    instructionId: `issue-6117:${mnemonic}:${address.toString(16)}`,
    mode: 'arm64e',
  };
}

function registerReads(bundle) {
  return bundle.operations
    .filter((operation) => operation.kind === 'register-read')
    .map((operation) => operation.register.registerId);
}

function authIntrinsic(bundle) {
  return bundle.operations.find((operation) =>
    operation.kind === 'intrinsic'
    && (operation.intrinsicId === 'arm64e.pointer.sign' || operation.intrinsicId === 'arm64e.pointer.authenticate'));
}

const cases = [
  ['pacia1716', 'x15'],
  ['pacib1716', 'x15'],
  ['paciasp', 'pc'],
  ['pacibsp', 'pc'],
  ['autia1716', 'x15'],
  ['autib1716', 'x15'],
  ['autiasp', 'x16'],
  ['autibsp', 'x16'],
  ['retaa', 'x16'],
  ['retab', 'x16'],
];

for (const [mnemonic, secondModifier] of cases) {
  const bundle = liftArm64eEffects(instruction(mnemonic));
  assert.equal(bundle.completeness, 'exact-with-intrinsic', `${mnemonic}: conditional intrinsic remains exact`);
  assert.ok(registerReads(bundle).includes(secondModifier), `${mnemonic}: missing ${secondModifier} second-modifier dependency`);

  const secondRead = bundle.operations.find((operation) =>
    operation.kind === 'register-read'
    && operation.register.registerId === secondModifier
    && operation.metadata?.conditional?.kind === 'arm64e-pauth-lr-pacm-active');
  assert.ok(secondRead, `${mnemonic}: second modifier must be explicitly conditional on FEAT_PAuth_LR/PACM`);
  assert.equal(secondRead.metadata.conditional.architectureStateInput, 'PAuthState');

  const intrinsic = authIntrinsic(bundle);
  assert.ok(intrinsic, `${mnemonic}: pointer-auth intrinsic missing`);
  assert.ok(intrinsic.effectSummary.registersRead.includes(secondModifier), `${mnemonic}: intrinsic read set omits ${secondModifier}`);
  assert.ok(
    intrinsic.effectSummary.inputs.some((value) => value.kind === 'temporary' && value.temporaryId === secondRead.value.temporaryId),
    `${mnemonic}: intrinsic inputs omit the second-modifier value`,
  );
  assert.equal(intrinsic.metadata.pauthLrSecondModifier.registerId, secondModifier);
  assert.equal(intrinsic.metadata.pauthLrSecondModifier.conditional.kind, 'arm64e-pauth-lr-pacm-active');
}

for (const mnemonic of ['pacia', 'pacib', 'autia', 'autib']) {
  const opStr = mnemonic.startsWith('pac') || mnemonic.startsWith('aut') ? 'x1, x2' : '';
  const decoded = { ...instruction(mnemonic, 0x2000n), opStr };
  const bundle = liftArm64eEffects(decoded);
  assert.equal(bundle.completeness, 'exact-with-intrinsic');
  assert.equal(bundle.metadata.pauthLrSecondModifier, undefined, `${mnemonic}: ordinary register form must not gain a PAuth_LR second modifier`);
}

const paciasp = liftArm64eEffects(instruction('paciasp', 0x3000n));
const paciaspAtOtherPc = liftArm64eEffects(instruction('paciasp', 0x4000n));
assert.equal(paciasp.metadata.pauthLrSecondModifier.registerId, 'pc');
assert.equal(paciaspAtOtherPc.metadata.pauthLrSecondModifier.registerId, 'pc');
assert.ok(registerReads(paciasp).includes('pc'), 'PACIASP must expose PC as a possible architectural dependency');

console.log('issue 6117 ARM64e PAuth_LR second modifiers: PASS');
