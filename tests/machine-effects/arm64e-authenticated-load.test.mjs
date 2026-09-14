import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { ARM64E_ARCHITECTURE } from '../../js/targets/architecture/index.js';
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
// signed scaled S:imm9 offset, a 64-bit load, auth/data-abort faults, and a
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

// Pre-index GP base/destination overlap is architecturally constrained-unpredictable.
// Do not publish one deterministic load/writeback outcome as exact authority.
for (const mnemonic of ['ldraa', 'ldrab']) {
  const bundle = lift(mnemonic, 'x1, [x1, #8]!');
  assert.equal(bundle.completeness, 'partial', `${mnemonic}: writeback overlap must fail closed`);
  assert.equal(bundle.operations.some((operation) => operation.kind === 'memory-read'), false, `${mnemonic}: no definite memory-read authority`);
  assert.deepEqual(writesOf(bundle), [], `${mnemonic}: no definite destination/writeback authority`);
  assert.equal(bundle.metadata.failClosed, true, `${mnemonic}: overlap must be marked fail-closed`);
  assert.match(bundle.unknownEffects?.reason ?? '', /overlap|constrained-unpredictable/i, `${mnemonic}: reason must identify overlap`);
}

// Non-overlap GP pre-index and SP pre-index remain exact positive controls.
{
  const gp = lift('ldraa', 'x1, [x2, #8]!');
  assert.equal(gp.completeness, 'exact-with-intrinsic');
  assert.deepEqual(writesOf(gp), ['x1', 'x2']);
  const sp = lift('ldrab', 'x1, [sp, #8]!');
  assert.equal(sp.completeness, 'exact-with-intrinsic');
  assert.deepEqual(writesOf(sp), ['x1', 'sp']);
}

// Signed S:imm9 offset is scaled by 8: exact architectural boundaries are
// -4096..4088 bytes, and non-multiples of 8 are not encodable.
for (const opStr of ['x4, [x5, #-4096]!', 'x4, [x5, #4088]!', 'x4, [x5, #-256]!']) {
  const bundle = lift('ldraa', opStr);
  assert.equal(bundle.completeness, 'exact-with-intrinsic', `${opStr}: ${bundle.unknownEffects?.reason}`);
}
for (const opStr of ['x4, [x5, #-4104]!', 'x4, [x5, #4096]!', 'x4, [x5, #1]!']) {
  const bundle = lift('ldraa', opStr);
  assert.equal(bundle.completeness, 'partial', `${opStr}: invalid scaled S:imm9 must fail closed`);
  assert.equal(bundle.operations.some((operation) => operation.kind === 'memory-read'), false, opStr);
}

// SP is a legal LDRAA/LDRAB base. Offset form authenticates/loads through SP
// without writeback and preserves CheckSPAlignment plus the n==31 tag-check rule.
{
  const bundle = lift('ldraa', 'x6, [sp]');
  assert.equal(bundle.completeness, 'exact-with-intrinsic', bundle.unknownEffects?.reason);
  assert.ok(readsOf(bundle).includes('sp'), 'SP base must be read');
  assert.deepEqual(writesOf(bundle), ['x6'], 'offset form must not write SP');
  assert.equal(intrinsicOf(bundle).metadata.pointerRegister, 'sp');
  assert.equal(bundle.metadata.writeback, null);
  assert.ok(bundle.possibleFaults.some((fault) => fault.kind === 'stack-pointer-alignment-fault'), 'SP alignment fault must remain explicit');
  const dataAbort = bundle.possibleFaults.find((fault) => fault.kind === 'data-abort');
  assert.equal(dataAbort?.detail?.tagChecked, false, 'SP offset form has tagchecked=false');
  assert.equal(dataAbort?.detail?.causes?.includes('tag-check'), false, 'SP offset form must not invent a tag-check cause');
}

// Pre-index SP form writes the authenticated+offset address back to SP and is
// tag checked because architectural tagchecked = wback || n != 31.
{
  const bundle = lift('ldrab', 'x7, [sp, #8]!');
  assert.equal(bundle.completeness, 'exact-with-intrinsic', bundle.unknownEffects?.reason);
  assert.deepEqual(writesOf(bundle), ['x7', 'sp']);
  assert.deepEqual(bundle.metadata.writeback, { mode: 'pre', baseRegister: 'sp' });
  const dataAbort = bundle.possibleFaults.find((fault) => fault.kind === 'data-abort');
  assert.equal(dataAbort?.detail?.tagChecked, true);
  assert.ok(dataAbort?.detail?.causes?.includes('tag-check'));
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
  ['misaligned positive displacement', 'x0, [x1, #300]'],
  ['misaligned negative displacement', 'x0, [x1, #-257]'],
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

// Raw decoder text that cannot be reconstructed must fail closed, never throw
// an adapter ReferenceError or fabricate definite memory/register effects.
for (const opStr of ['x0, nonsense', 'x0, [x31]', 'bogus, [sp]']) {
  let bundle;
  assert.doesNotThrow(() => { bundle = ARM64E_ARCHITECTURE.liftExact({ mnemonic:'ldraa', opStr }, { instructionId:`arm64e-auth-load-malformed-${opStr}`, mode:'arm64e' }); }, opStr);
  assert.equal(bundle?.completeness, 'partial', `${opStr}: malformed raw operand text must fail closed`);
  assert.equal(bundle.operations.some((operation) => operation.kind === 'memory-read'), false, opStr);
}

// Capstone-decoded production path through the arm64e plugin.
const capstone = await createCapstoneArm64Session();
try {
  const fixtures = {
    ldraa_plain: [0x20, 0x04, 0x20, 0xf8],
    ldrab_pre8: [0x62, 0x1c, 0xa0, 0xf8],
    ldraa_sp: [0xe0, 0x07, 0x20, 0xf8],
    ldrab_sp_pre8: [0xe1, 0x1f, 0xa0, 0xf8],
  };
  for (const [name, bytes] of Object.entries(fixtures)) {
    const raw = capstone.decode(bytes, 0x740000n)[0];
    assert.ok(raw, `${name}: decoder fixture must decode`);
    const bundle = ARM64E_ARCHITECTURE.liftExact(raw, { instructionId: `arm64e-auth-load-capstone-${name}`, mode: 'arm64e' });
    assert.ok(bundle, `${name}: bundle required`);
    assert.equal(bundle.completeness, 'exact-with-intrinsic', `${name}: ${bundle.unknownEffects?.reason}`);
    assert.equal(bundle.metadata.authenticatedLoad, true, name);
    if (name.includes('_sp')) {
      assert.ok(readsOf(bundle).includes('sp'), `${name}: production decoder SP base must lift`);
      assert.ok(bundle.possibleFaults.some((fault) => fault.kind === 'stack-pointer-alignment-fault'), `${name}: SP alignment fault required`);
    }
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
