import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64AtomicEffects } from '../../js/targets/architecture/arm64/effects/atomic.js';
import { createCapstoneArm64Session } from './helpers/arm64-capstone-session.mjs';

let sequence = 0;
const x = (n) => ({ k:'reg', text:`x${n}`, cls:'gp', bits:64, num:n });
const w = (n) => ({ k:'reg', text:`w${n}`, cls:'gp', bits:32, num:n });
const zr = (bits = 64) => ({ k:'reg', text:bits === 32 ? 'wzr' : 'xzr', cls:'zr', bits, num:31 });
const sp = () => ({ k:'reg', text:'sp', cls:'sp', bits:64, num:31 });
const mem = (base) => ({ k:'mem', text:'[...]', base, index:null, shift:null, mode:'offset', disp:null, addressDisp:null, writebackDisp:null });

function lift(mnemonic, ops) {
  const instructionId = `issue-8603:${sequence++}:${mnemonic}`;
  return liftArm64AtomicEffects({ mnemonic, ops, mode:'a64', instructionId, origin:{ instructionIds:[instructionId] } });
}
function atomicIntrinsic(bundle) {
  return bundle.operations.find((operation) => operation.kind === 'intrinsic' && operation.intrinsicId?.startsWith('arm64.atomic.'));
}
function memoryReadOrdering(bundle) {
  const direct = bundle.operations.find((operation) => operation.kind === 'memory-read');
  if (direct) return direct.access.ordering;
  return atomicIntrinsic(bundle)?.effectSummary?.memoryRead?.accesses?.[0]?.ordering ?? null;
}
function memoryWriteOrdering(bundle) {
  return atomicIntrinsic(bundle)?.effectSummary?.memoryWrite?.accesses?.[0]?.ordering ?? null;
}
function assertOrdering(bundle, { read, write = null, summary = null, label }) {
  assert.equal(bundle.completeness, 'exact-with-intrinsic', `${label}: completeness`);
  assert.equal(memoryReadOrdering(bundle), read, `${label}: read ordering`);
  if (write !== null) assert.equal(memoryWriteOrdering(bundle), write, `${label}: write ordering`);
  if (summary !== null) {
    const intrinsic = atomicIntrinsic(bundle);
    assert.equal(intrinsic?.metadata?.ordering ?? bundle.metadata?.ordering, summary, `${label}: summary ordering`);
  }
}

// Architecturally controlling zero-register fields suppress only the acquire half.
assertOrdering(lift('ldadda', [x(0), zr(), mem(x(1))]), { read:'relaxed', write:'relaxed', summary:'relaxed', label:'LDADDA Rt=XZR' });
assertOrdering(lift('ldaddal', [x(0), zr(), mem(x(1))]), { read:'relaxed', write:'release', summary:'release', label:'LDADDAL Rt=XZR' });
assertOrdering(lift('swpa', [x(0), zr(), mem(x(1))]), { read:'relaxed', write:'relaxed', summary:'relaxed', label:'SWPA Rt=XZR' });
assertOrdering(lift('swpal', [x(0), zr(), mem(x(1))]), { read:'relaxed', write:'release', summary:'release', label:'SWPAL Rt=XZR' });
assertOrdering(lift('casa', [zr(), x(0), mem(x(1))]), { read:'relaxed', write:'relaxed', summary:'relaxed', label:'CASA Rs=XZR' });
assertOrdering(lift('casal', [zr(), x(0), mem(x(1))]), { read:'relaxed', write:'release', summary:'release', label:'CASAL Rs=XZR' });
assertOrdering(lift('ldaddab', [w(0), zr(32), mem(x(1))]), { read:'relaxed', write:'relaxed', summary:'relaxed', label:'LDADDAB Rt=WZR' });

for (const [mnemonic, bits] of [['ldaxr',64], ['ldaxrb',32], ['ldaxrh',32]]) {
  const bundle = lift(mnemonic, [zr(bits), mem(x(1))]);
  assertOrdering(bundle, { read:'relaxed', label:`${mnemonic.toUpperCase()} Rt=ZR` });
  assert.ok(bundle.operations.some((operation) => operation.kind === 'intrinsic' && operation.intrinsicId === 'arm64.exclusive-monitor-set'),
    `${mnemonic}: destination discard must not suppress exclusive-monitor state`);
}

// Byte/halfword/word/doubleword coverage across each affected family.
for (const [mnemonic, source, result, widthBits] of [
  ['ldaddab', w(0), zr(32), 8],
  ['ldaddah', w(0), zr(32), 16],
  ['ldadda', w(0), zr(32), 32],
  ['ldadda', x(0), zr(64), 64],
  ['swpab', w(0), zr(32), 8],
  ['swpah', w(0), zr(32), 16],
  ['swpa', w(0), zr(32), 32],
  ['swpa', x(0), zr(64), 64],
]) {
  const bundle = lift(mnemonic, [source, result, mem(x(1))]);
  assertOrdering(bundle, { read:'relaxed', write:'relaxed', summary:'relaxed', label:`${mnemonic} ${widthBits}-bit Rt=ZR` });
  assert.equal(atomicIntrinsic(bundle).metadata.widthBits, widthBits, `${mnemonic}: width matrix`);
}
for (const [mnemonic, expected, replacement, widthBits] of [
  ['casab', zr(32), w(0), 8],
  ['casah', zr(32), w(0), 16],
  ['casa', zr(32), w(0), 32],
  ['casa', zr(64), x(0), 64],
]) {
  const bundle = lift(mnemonic, [expected, replacement, mem(x(1))]);
  assertOrdering(bundle, { read:'relaxed', write:'relaxed', summary:'relaxed', label:`${mnemonic} ${widthBits}-bit Rs=ZR` });
  assert.equal(atomicIntrinsic(bundle).metadata.widthBits, widthBits, `${mnemonic}: width matrix`);
}
for (const [mnemonic, dest, widthBits] of [
  ['ldaxrb', zr(32), 8],
  ['ldaxrh', zr(32), 16],
  ['ldaxr', zr(32), 32],
  ['ldaxr', zr(64), 64],
]) {
  const bundle = lift(mnemonic, [dest, mem(x(1))]);
  assertOrdering(bundle, { read:'relaxed', label:`${mnemonic} ${widthBits}-bit Rt=ZR` });
  assert.equal(bundle.metadata.widthBits, widthBits, `${mnemonic}: exclusive width matrix`);
}

// Non-ZR controls retain acquire/acq-rel semantics.
assertOrdering(lift('ldadda', [x(0), x(2), mem(x(1))]), { read:'acquire', write:'relaxed', summary:'acquire', label:'LDADDA non-ZR' });
assertOrdering(lift('casal', [x(0), x(2), mem(x(1))]), { read:'acquire', write:'release', summary:'acq-rel', label:'CASAL non-ZR' });
assertOrdering(lift('ldaxr', [x(0), mem(x(1))]), { read:'acquire', label:'LDAXR non-ZR' });

// Only the architecturally controlling field gates acquire.
assertOrdering(lift('ldadda', [zr(), x(2), mem(x(1))]), { read:'acquire', write:'relaxed', summary:'acquire', label:'LDADDA source=XZR only' });
assertOrdering(lift('casa', [x(0), zr(), mem(x(1))]), { read:'acquire', write:'relaxed', summary:'acquire', label:'CASA replacement=XZR only' });
assertOrdering(lift('ldadda', [x(0), x(2), mem(sp())]), { read:'acquire', write:'relaxed', summary:'acquire', label:'LDADDA base=SP' });

function bytes32(word) {
  const value = Number(word) >>> 0;
  return Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24);
}

const encodedCases = [
  [0xf8a0003f, 'ldadda', 'relaxed', 'relaxed'],
  [0xf8e0003f, 'ldaddal', 'relaxed', 'release'],
  [0xf8a0803f, 'swpa', 'relaxed', 'relaxed'],
  [0xf8e0803f, 'swpal', 'relaxed', 'release'],
  [0xc8ff7c20, 'casa', 'relaxed', 'relaxed'],
  [0xc8fffc20, 'casal', 'relaxed', 'release'],
  [0x38a0003f, 'ldaddab', 'relaxed', 'relaxed'],
  [0xc85ffc3f, 'ldaxr', 'relaxed', null],
  [0x085ffc3f, 'ldaxrb', 'relaxed', null],
];

const session = await createCapstoneArm64Session();
try {
  for (const [word, mnemonic, read, write] of encodedCases) {
    const [raw] = session.decode(bytes32(word), 0x860300n);
    assert.ok(raw, `${mnemonic}: production Capstone must decode issue encoding`);
    assert.equal(raw.mnemonic, mnemonic, `${mnemonic}: production decoder mnemonic`);
    const instructionId = `issue-8603:capstone:${mnemonic}:${word.toString(16)}`;
    const bundle = liftArm64AtomicEffects({
      instructionId,
      address:raw.address,
      mnemonic:raw.mnemonic,
      operands:raw.opStr,
      opStr:raw.opStr,
      ops:parseOperands(raw.opStr),
      mode:'a64',
      origin:{ instructionIds:[instructionId] },
    });
    assertOrdering(bundle, { read, write, label:`${mnemonic} production encoding` });
  }
} finally {
  session.close();
}

console.log('Issue #8603 ARM64 atomic ZR acquire suppression: PASS');
