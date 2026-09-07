import assert from 'node:assert/strict';
import { ARM64E_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { liftArm64eEffects } from '../../js/targets/architecture/arm64e/effects.js';

let sequence = 0;
function decoded(mnemonic, ops) {
  sequence += 1;
  const instructionId = `arm64e-register-identity-${sequence}`;
  return {
    instructionId,
    mnemonic,
    ops,
    mode:'arm64e',
    address:0x12000n + BigInt(sequence * 4),
    origin:{ instructionIds:[instructionId] },
  };
}
function lift(mnemonic, ops) {
  return ARM64E_ARCHITECTURE.liftExact(decoded(mnemonic, ops));
}
function liftDirect(mnemonic, ops) {
  return liftArm64eEffects(decoded(mnemonic, ops));
}

function gp(num, text = `x${num}`) {
  return { k:'reg', cls:'gp', num, bits:64, text };
}

function sp(text = 'sp') {
  return { k:'reg', cls:'sp', num:31, bits:64, text };
}

function zr(text = 'xzr') {
  return { k:'reg', cls:'zr', num:31, bits:64, text };
}

function assertAccepted(mnemonic, ops) {
  const bundle = lift(mnemonic, ops);
  assert.ok(bundle, `${mnemonic}: legal structured identity must lift`);
  assert.notEqual(bundle.metadata?.failClosed, true, `${mnemonic}: legal structured identity is not fail-closed`);
  assert.ok(bundle.operations.length > 0, `${mnemonic}: legal structured identity keeps semantic operations`);
}

function assertIdentityContradictionFailClosed(mnemonic, ops) {
  const bundle = lift(mnemonic, ops);
  assert.ok(bundle, `${mnemonic}: identity contradiction must produce a bundle`);
  assert.equal(bundle.completeness, 'partial', `${mnemonic}: identity contradiction is partial`);
  assert.equal(bundle.metadata?.failClosed, true, `${mnemonic}: identity contradiction is fail-closed`);
  assert.equal(bundle.metadata?.encodingValidation, 'operand-register-class', `${mnemonic}: contradiction is rejected by finite operand validation`);
  assert.equal(bundle.operations.length, 0, `${mnemonic}: contradiction produces no definite operations`);
  assert.match(bundle.unknownEffects?.reason || '', /^arm64e-.*-operand-register-class-invalid$/, `${mnemonic}: contradiction has explicit validation reason`);
}

function assertDirectWidthFailClosed(mnemonic, ops) {
  const bundle = liftDirect(mnemonic, ops);
  assert.ok(bundle, `${mnemonic}: direct ARM64e owner remains explicit`);
  assert.equal(bundle.completeness, 'partial', `${mnemonic}: direct malformed width is partial`);
  assert.ok(bundle.operations.length > 0, `${mnemonic}: direct owner reports unknown evidence`);
  assert.ok(bundle.operations.every((operation) => operation.kind === 'unknown'), `${mnemonic}: direct malformed width emits no definite operation`);
}

// Canonical structured identity and presentation aliases that denote the same
// physical register must preserve the existing exact semantics.
assertAccepted('pacia', [gp(0), gp(1)]);
assertAccepted('pacia', [gp(29, 'fp'), gp(30, 'lr')]);
assertAccepted('pacia', [gp(0), sp()]);
assertAccepted('pacia', [zr(), sp()]);
assertAccepted('pacga', [gp(0), zr(), sp()]);
assertAccepted('braa', [gp(16), sp()]);
assertAccepted('blraa', [gp(16), gp(17)]);
// Preserve compatibility with canonical structured records that omit the
// encoded register number for semantic SP/XZR but otherwise agree.
assertAccepted('pacia', [gp(0), { k:'reg', cls:'sp', bits:64, text:'sp' }]);
assertAccepted('pacia', [{ k:'reg', cls:'zr', bits:64, text:'xzr' }, sp()]);

// The finite validator must not validate one canonical register identity and
// then let effects consume a conflicting presentation/raw identity.
assertIdentityContradictionFailClosed('pacia', [gp(0, 'x1'), gp(2)]);
assertIdentityContradictionFailClosed('pacia', [gp(0), sp('x5')]);
assertIdentityContradictionFailClosed('pacia', [zr('x7'), sp()]);
assertIdentityContradictionFailClosed('pacga', [gp(0), gp(1, 'x2'), sp()]);
assertIdentityContradictionFailClosed('pacga', [gp(0), zr('x3'), sp()]);
assertIdentityContradictionFailClosed('braa', [gp(16, 'x17'), sp()]);
assertIdentityContradictionFailClosed('blraa', [gp(16), sp('x17')]);

// Invalid canonical register fields must not fall through to a presentation
// string that happens to name an encodable register.
assertIdentityContradictionFailClosed('pacia', [
  { k:'reg', cls:'gp', num:31, bits:64, text:'x0' },
  gp(2),
]);
assertIdentityContradictionFailClosed('pacia', [
  { k:'reg', cls:'gp', num:99, bits:64, text:'x0' },
  gp(2),
]);
assertIdentityContradictionFailClosed('pacia', [
  { k:'reg', cls:'unknown', num:0, bits:64, text:'x0' },
  gp(2),
]);
// If the encoding field is explicitly present for semantic SP/XZR it must be
// register 31; otherwise the structured record contradicts the A64 domain.
assertIdentityContradictionFailClosed('pacia', [
  gp(0),
  { k:'reg', cls:'sp', num:0, bits:64, text:'sp' },
]);
assertIdentityContradictionFailClosed('pacia', [
  { k:'reg', cls:'zr', num:0, bits:64, text:'xzr' },
  sp(),
]);

// Explicit canonical widths are typed decoder evidence. Never coerce malformed
// structured values into the A64 X-register width accepted by the finite gate.
for (const bits of ['64', [64], true, false, {}, 64.5, NaN, Infinity, -Infinity, 32, 128]) {
  const paciaOps = [{ ...gp(0), bits }, gp(2)];
  const braaOps = [{ ...gp(16), bits }, sp()];
  assertIdentityContradictionFailClosed('pacia', paciaOps);
  assertIdentityContradictionFailClosed('braa', braaOps);
  assertDirectWidthFailClosed('pacia', paciaOps);
  assertDirectWidthFailClosed('braa', braaOps);
}
const valueOfWidthOps = [{ ...gp(0), bits:{ valueOf(){ return 64; } } }, gp(2)];
assertIdentityContradictionFailClosed('pacia', valueOfWidthOps);
assertDirectWidthFailClosed('pacia', valueOfWidthOps);
const redundantWidthOps = [gp(0), { ...gp(1), widthBits:'64' }, sp()];
assertIdentityContradictionFailClosed('pacga', redundantWidthOps);
assertDirectWidthFailClosed('pacga', redundantWidthOps);

// effects.js prefers registerId/register/reg/name over text. Pin that exact
// selection order too so a higher-priority conflicting identity cannot bypass
// canonical validation merely because text happens to agree.
assertIdentityContradictionFailClosed('pacia', [
  { ...gp(0), registerId:'x1' },
  gp(2),
]);
assertIdentityContradictionFailClosed('braa', [
  gp(16),
  { ...sp(), register:'x18' },
]);

console.log('arm64e-pauth-register-identity: PASS');
