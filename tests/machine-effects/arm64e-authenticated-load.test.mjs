import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { createCapstoneArm64Session } from './helpers/arm64-capstone-session.mjs';
import { isArm64eAuthenticatedLoadInstruction } from '../../js/targets/architecture/arm64e/effects-memory.js';
import { extendArm64WithArm64eEffects, liftArm64eEffects } from '../../js/targets/architecture/arm64e/index.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

// Composed extension/base chain, mirroring the production arm64e wiring.
const liftArm64eMachineEffects = extendArm64WithArm64eEffects(liftArm64MachineEffects);

let sequence = 0;
function lift(mnemonic, opStr, lifter = liftArm64eMachineEffects) {
  sequence += 1;
  const instructionId = `arm64e-auth-load-${sequence}`;
  return lifter({
    instructionId,
    mnemonic,
    opStr,
    ops: parseOperands(opStr),
    mode: 'arm64e',
    address: 0x740000n + BigInt(sequence * 4),
    origin: { instructionIds: [instructionId] },
  });
}

function intrinsicOf(bundle) {
  return bundle.operations.find((operation) => operation.kind === 'intrinsic');
}
function writesOf(bundle) {
  return bundle.operations.filter((operation) => operation.kind === 'register-write').map((operation) => operation.register.registerId);
}
function readsOf(bundle) {
  return bundle.operations.filter((operation) => operation.kind === 'register-read').map((operation) => operation.register.registerId);
}

// #6148: LDRAA/LDRAB were missing from every effects inventory and fell out
// of liftExact as null. They are FEAT_PAuth authenticated loads owned by the
// ARM64e extension: zero-modifier authentication of the base (Key A/B), a
// signed unscaled imm9 offset, a 64-bit load, auth/data-abort faults, and a
// pre-index-only writeback of the authenticated address.
assert.ok(isArm64eAuthenticatedLoadInstruction({ mnemonic: 'ldraa' }));
assert.ok(isArm64eAuthenticatedLoadInstruction({ mnemonic: 'ldrab' }));

for (const [mnemonic, keyId] of [['ldraa', 'APIAKey'], ['ldrab', 'APIBKey']]) {
  const bundle = lift(mnemonic, 'x0, [x1]');
  assert.equal(bundle.completeness, 'exact-with-intrinsic', `${mnemonic}: ${bundle.unknownEffects?.reason}`);
  assert.ok(readsOf(bundle).includes('x1'), `${mnemonic}: base register read required`);
  assert.ok(readsOf(bundle).includes(keyId), `${mnemonic}: key read required`);
  assert.ok(readsOf(bundle).includes('PAuthState'), `${mnemonic}: PAuth state read required`);
  const intrinsic = intrinsicOf(bundle);
  assert.equal(intrinsic?.intrinsicId, 'arm64e.pointer.authenticate', `${mnemonic}: authenticate intrinsic required`);
  assert.deepEqual(intrinsic.metadata.modifier, { kind: 'constant-zero' });
  assert.equal(intrinsic.metadata.keyIdentity, keyId);
  const memoryRead = bundle.operations.find((operation) => operation.kind === 'memory-read');
  assert.ok(memoryRead, `${mnemonic}: 64-bit memory read required`);
  assert.equal(memoryRead.access.widthBits, 64);
  assert.deepEqual(writesOf(bundle), ['x0'], `${mnemonic}: destination write only`);
  assert.ok(bundle.possibleFaults.some((fault) => fault.kind === 'pointer-authentication-fault'), `${mnemonic}: auth fault evidence required`);
  assert.ok(bundle.possibleFaults.some((fault) => fault.kind === 'data-abort'), `${mnemonic}: data abort evidence required`);
  assert.equal(bundle.metadata.writeback, null, `${mnemonic}: offset form must not write back`);
}

// Key separation.
assert.equal(intrinsicOf(lift('ldrab', 'x0, [x1]')).metadata.keyIdentity, 'APIBKey');

// Pre-index writes back the authenticated address to the base.
{
  const bundle = lift('ldraa', 'x2, [x3, #8]!');
  assert.equal(bundle.completeness, 'exact-with-intrinsic');
  assert.deepEqual(writesOf(bundle), ['x2', 'x3']);
  assert.deepEqual(bundle.metadata.writeback, { mode: 'pre', baseRegister: 'x3' });
  const writeback = bundle.operations.filter((operation) => operation.kind === 'register-write').at(-1);
  assert.equal(writeback.value.kind, 'temporary');
  const addressOperation = bundle.operations.find((operation) => operation.kind === 'value');
  assert.equal(writeback.value.temporaryId, addressOperation.outputs[0].temporaryId, 'writeback must be the authenticated data address');
}

// Negative imm9 boundary stays encodable.
{
  const bundle = lift('ldraa', 'x4, [x5, #-256]!');
  assert.equal(bundle.completeness, 'exact-with-intrinsic', bundle.unknownEffects?.reason);
}

// XZR destination keeps the load and the authentication, discards the write.
{
  const bundle = lift('ldraa', 'xzr, [x1]');
  assert.equal(bundle.completeness, 'exact-with-intrinsic');
  assert.deepEqual(writesOf(bundle), []);
  assert.ok(bundle.operations.some((operation) => operation.kind === 'memory-read'));
}

// Fail-closed boundaries: post-index, register offset, imm9 overflow, shapes.
for (const [label, opStr] of [
  ['post-index', 'x0, [x1], #8'],
  ['register offset', 'x0, [x1, x2]'],
  ['imm9 overflow', 'x0, [x1, #300]'],
  ['imm9 underflow', 'x0, [x1, #-257]'],
  ['no memory operand', 'x0, x1'],
  ['W destination', 'w0, [x1]'],
]) {
  const bundle = lift('ldraa', opStr);
  assert.equal(bundle?.completeness, 'partial', `${label}: must fail closed`);
  assert.equal(bundle.operations.filter((operation) => operation.kind === 'memory-read').length, 0, `${label}: zero definite operations`);
}
{
  const bundle = lift('ldraa', 'x0');
  assert.equal(bundle?.completeness, 'partial', 'single-operand shape must fail closed');
}

// Capstone-decoded production path through the arm64e plugin.
const capstone = await createCapstoneArm64Session();
try {
  const fixtures = {
    ldraa_plain: [0x20, 0x04, 0x20, 0xf8],
    ldrab_pre8: [0x62, 0x1c, 0xa0, 0xf8],
  };
  for (const [name, bytes] of Object.entries(fixtures)) {
    const raw = capstone.decode(bytes, 0x740000n)[0];
    assert.ok(raw, `${name}: decoder fixture must decode`);
    const bundle = liftArm64eEffects(raw, { instructionId: `arm64e-auth-load-capstone-${name}`, mode: 'arm64e' });
    assert.ok(bundle, `${name}: bundle required`);
    assert.equal(bundle.completeness, 'exact-with-intrinsic', `${name}: ${bundle.unknownEffects?.reason}`);
    assert.equal(bundle.metadata.authenticatedLoad, true, name);
  }
} finally { capstone.close(); }

// Ordinary LDR and PAC/AUT semantics regress nothing.
{
  const ldr = liftArm64eMachineEffects({
    instructionId: 'arm64e-auth-load-ldr-guard',
    mnemonic: 'ldr',
    opStr: 'x0, [x1]',
    ops: parseOperands('x0, [x1]'),
    mode: 'arm64e',
    address: 0x740000n,
    origin: { instructionIds: ['arm64e-auth-load-ldr-guard'] },
  });
  assert.equal(ldr.completeness, 'exact', 'ordinary LDR must stay in the base memory family');
  assert.equal(ldr.metadata.authenticatedLoad, undefined);
  const pacia = liftArm64eEffects({
    instructionId: 'arm64e-auth-load-pacia-guard',
    mnemonic: 'pacia',
    opStr: 'x0, x1',
    ops: parseOperands('x0, x1'),
    mode: 'arm64e',
    address: 0x740000n,
    origin: { instructionIds: ['arm64e-auth-load-pacia-guard'] },
  });
  assert.equal(pacia.completeness, 'exact-with-intrinsic', 'PACIA must keep its register-transform semantics');
  assert.equal(pacia.metadata.authenticatedLoad, undefined);
}

console.log('ARM64e authenticated load (LDRAA/LDRAB) semantics: PASS');
