import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MemoryEffects } from '../../js/targets/architecture/arm64/effects/memory.js';
import { createCapstoneArm64Session } from './helpers/arm64-capstone-session.mjs';

let sequence = 0;
const x = (n) => ({ k:'reg', text:`x${n}`, cls:'gp', bits:64, num:n });
const w = (n) => ({ k:'reg', text:`w${n}`, cls:'gp', bits:32, num:n });
const zr = (bits = 64) => ({ k:'reg', text:bits === 32 ? 'wzr' : 'xzr', cls:'zr', bits, num:31 });
const mem = (base) => ({ k:'mem', text:'[...]', base, index:null, shift:null, mode:'offset', disp:null, addressDisp:null, writebackDisp:null });

function lift(mnemonic, ops) {
  const instructionId = `issue-8607:${sequence++}:${mnemonic}`;
  return liftArm64MemoryEffects({ mnemonic, ops, mode:'a64', instructionId, origin:{ instructionIds:[instructionId] } });
}
function readAccess(bundle) {
  return bundle.operations.find((operation) => operation.kind === 'memory-read')?.access ?? null;
}
function assertAcquireLoad(bundle, { ordering, widthBits, label }) {
  assert.equal(bundle.completeness, 'exact', `${label}: completeness`);
  const access = readAccess(bundle);
  assert.ok(access, `${label}: a discarded destination must not remove the memory read`);
  assert.equal(access.ordering, ordering, `${label}: read ordering`);
  assert.equal(access.atomic, true, `${label}: read atomicity`);
  assert.equal(access.widthBits, widthBits, `${label}: read width`);
  assert.equal(bundle.metadata.ordering, ordering, `${label}: summary ordering`);
  assert.ok(bundle.possibleFaults.some((fault) => fault.kind === 'data-abort'), `${label}: data-abort`);
}

// Rt == 31 suppresses only the acquire half of LDAR/LDARB/LDARH.
for (const [mnemonic, widthBits] of [['ldar',64], ['ldarb',8], ['ldarh',16]]) {
  const zero = widthBits === 64 ? zr(64) : zr(32);
  assertAcquireLoad(lift(mnemonic, [zero, mem(x(1))]), { ordering:'relaxed', widthBits, label:`${mnemonic.toUpperCase()} Rt=ZR` });
  assert.equal(lift(mnemonic, [zero, mem(x(1))]).operations.some((operation) => operation.kind === 'register-write'), false,
    `${mnemonic}: a discarded load must not write an architectural register`);
}

// A non-zero destination keeps the RCsc acquire authority.
for (const [mnemonic, register, widthBits] of [
  ['ldar', x(0), 64], ['ldar', w(0), 32], ['ldarb', w(0), 8], ['ldarh', w(0), 16],
]) {
  assertAcquireLoad(lift(mnemonic, [register, mem(x(1))]), { ordering:'acquire', widthBits, label:`${mnemonic} Rt!=ZR` });
}

// Release stores are unaffected: an Rt == 31 source stores zero and still publishes.
for (const [mnemonic, widthBits] of [['stlr',64], ['stlrb',8], ['stlrh',16]]) {
  const zeroSource = widthBits === 64 ? zr(64) : zr(32);
  for (const [register, suffix] of [[zeroSource,'Rt=ZR'], [widthBits === 64 ? x(0) : w(0),'Rt!=ZR']]) {
    const bundle = lift(mnemonic, [register, mem(x(1))]);
    assert.equal(bundle.completeness, 'exact', `${mnemonic} ${suffix}: completeness`);
    const access = bundle.operations.find((operation) => operation.kind === 'memory-write')?.access;
    assert.equal(access?.ordering, 'release', `${mnemonic} ${suffix}: store ordering`);
    assert.equal(access?.widthBits, widthBits, `${mnemonic} ${suffix}: store width`);
    assert.equal(bundle.metadata.ordering, 'release', `${mnemonic} ${suffix}: summary ordering`);
  }
}
// Only the destination gates the acquire half: an SP base keeps the same authority
// as the x-register controls above and still reports the CheckSPAlignment fault.
const spZero = lift('ldar', [zr(64), mem({ k:'reg', text:'sp', cls:'sp', bits:64, num:31 })]);
assertAcquireLoad(spZero, { ordering:'relaxed', widthBits:64, label:'LDAR XZR,[SP] (structured)' });
assert.ok(spZero.possibleFaults.some((fault) => fault.kind === 'stack-pointer-alignment-fault'), 'LDAR XZR,[SP]: SP alignment fault');
assert.equal(spZero.possibleFaults.find((fault) => fault.kind === 'data-abort')?.detail?.tagChecked, false,
  'LDAR XZR,[SP]: MTE tag check is skipped for SP');
const spAcquire = lift('ldar', [x(0), mem({ k:'reg', text:'sp', cls:'sp', bits:64, num:31 })]);
assertAcquireLoad(spAcquire, { ordering:'acquire', widthBits:64, label:'LDAR X0,[SP]' });

function bytes32(word) {
  const value = Number(word) >>> 0;
  return Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255);
}

const encodedCases = [
  [0xc8dffc3f, 'ldar', 'xzr, [x1]', 'relaxed', 64],
  [0x08dffc3f, 'ldarb', 'wzr, [x1]', 'relaxed', 8],
  [0x48dffc3f, 'ldarh', 'wzr, [x1]', 'relaxed', 16],
  [0xc8dffc20, 'ldar', 'x0, [x1]', 'acquire', 64],
  [0x08dffc20, 'ldarb', 'w0, [x1]', 'acquire', 8],
  [0x48dffc20, 'ldarh', 'w0, [x1]', 'acquire', 16],
  [0xc8dfffff, 'ldar', 'xzr, [sp]', 'relaxed', 64],
];

const session = await createCapstoneArm64Session();
try {
  for (const [word, mnemonic, opStr, ordering, widthBits] of encodedCases) {
    const [raw] = session.decode(bytes32(word), 0x860700n);
    assert.ok(raw, `${mnemonic} ${opStr}: production Capstone must decode the encoding`);
    assert.equal(raw.mnemonic, mnemonic, `0x${word.toString(16)}: decoder mnemonic`);
    assert.equal(raw.opStr.replace(/\s+/g, ' ').trim(), opStr, `0x${word.toString(16)}: decoder operand text`);
    const instructionId = `issue-8607:capstone:${mnemonic}:${opStr}:${word.toString(16)}`;
    const bundle = liftArm64MemoryEffects({
      instructionId,
      address:raw.address,
      mnemonic:raw.mnemonic,
      operands:raw.opStr,
      opStr:raw.opStr,
      ops:parseOperands(raw.opStr),
      word,
      mode:'a64',
      origin:{ instructionIds:[instructionId] },
    });
    assertAcquireLoad(bundle, { ordering, widthBits, label:`${mnemonic} ${opStr} production encoding` });
  }

  // The FEAT_LRCPC/LRCPC2 acquire family is still unrepresented: an RCpc load must
  // not be modeled as the RCsc-strength `acquire` identity, so it stays fail-closed
  // until the ordering domain can carry that authority. This assertion is the
  // explicit remaining-scope marker for issue #8607 part B.
  for (const [word, mnemonic] of [[0xf8bfc020, 'ldapr'], [0x38bfc062, 'ldaprb'], [0x78bfc0a4, 'ldaprh']]) {
    const [raw] = session.decode(bytes32(word), 0x860780n);
    assert.equal(raw?.mnemonic, mnemonic, `${mnemonic}: the decoder must still resolve the RCpc form`);
    const instructionId = `issue-8607:rcpc:${mnemonic}`;
    assert.equal(liftArm64MemoryEffects({
      instructionId, address:raw.address, mnemonic:raw.mnemonic, operands:raw.opStr, opStr:raw.opStr,
      ops:parseOperands(raw.opStr), word, mode:'a64', origin:{ instructionIds:[instructionId] },
    }), null, `${mnemonic}: an unrepresentable RCpc ordering must not be laundered into acquire`);
  }
} finally {
  session.close();
}

console.log('Issue #8607 ARM64 LDAR zero-register acquire suppression: PASS');
