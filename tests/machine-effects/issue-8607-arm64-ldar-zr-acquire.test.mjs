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

  // Issue #8607 Part B: The FEAT_LRCPC/LRCPC2 acquire/release family (12 mnemonics)
  // must produce valid MachineEffects bundles, preserve memory read/write, addressing,
  // and faults, publish explicit RCpc ordering authority, suppress acquire on ZR destination,
  // and avoid being falsely laundered into strong RCsc acquire.
  const rcpcCases = [
    { word: 0xf8bfc020, mnemonic: 'ldapr', opStr: 'x0, [x1]', widthBits: 64, isLoad: true, signed: false },
    { word: 0xb8bfc020, mnemonic: 'ldapr', opStr: 'w0, [x1]', widthBits: 32, isLoad: true, signed: false },
    { word: 0x38bfc062, mnemonic: 'ldaprb', opStr: 'w2, [x3]', widthBits: 8, isLoad: true, signed: false },
    { word: 0x78bfc0a4, mnemonic: 'ldaprh', opStr: 'w4, [x5]', widthBits: 16, isLoad: true, signed: false },
    { word: 0xd95f80e6, mnemonic: 'ldapur', opStr: 'x6, [x7, #-8]', widthBits: 64, isLoad: true, signed: false },
    { word: 0x995f80e6, mnemonic: 'ldapur', opStr: 'w6, [x7, #-8]', widthBits: 32, isLoad: true, signed: false },
    { word: 0x19401128, mnemonic: 'ldapurb', opStr: 'w8, [x9, #1]', widthBits: 8, isLoad: true, signed: false },
    { word: 0x595fe16a, mnemonic: 'ldapurh', opStr: 'w10, [x11, #-2]', widthBits: 16, isLoad: true, signed: false },
    { word: 0x198031ac, mnemonic: 'ldapursb', opStr: 'x12, [x13, #3]', widthBits: 8, isLoad: true, signed: true },
    { word: 0x19c031ac, mnemonic: 'ldapursb', opStr: 'w12, [x13, #3]', widthBits: 8, isLoad: true, signed: true },
    { word: 0x599fc1ee, mnemonic: 'ldapursh', opStr: 'x14, [x15, #-4]', widthBits: 16, isLoad: true, signed: true },
    { word: 0x59dfc1ee, mnemonic: 'ldapursh', opStr: 'w14, [x15, #-4]', widthBits: 16, isLoad: true, signed: true },
    { word: 0x99804230, mnemonic: 'ldapursw', opStr: 'x16, [x17, #4]', widthBits: 32, isLoad: true, signed: true },
    { word: 0xd91f8272, mnemonic: 'stlur', opStr: 'x18, [x19, #-8]', widthBits: 64, isLoad: false, signed: false },
    { word: 0x991f8272, mnemonic: 'stlur', opStr: 'w18, [x19, #-8]', widthBits: 32, isLoad: false, signed: false },
    { word: 0x190012b4, mnemonic: 'stlurb', opStr: 'w20, [x21, #1]', widthBits: 8, isLoad: false, signed: false },
    { word: 0x591fe2f6, mnemonic: 'stlurh', opStr: 'w22, [x23, #-2]', widthBits: 16, isLoad: false, signed: false },
  ];

  for (const c of rcpcCases) {
    const [raw] = session.decode(bytes32(c.word), 0x860780n);
    assert.ok(raw, `${c.mnemonic}: production Capstone must decode 0x${c.word.toString(16)}`);
    assert.equal(raw.mnemonic, c.mnemonic, `0x${c.word.toString(16)}: decoder mnemonic`);
    const instructionId = `issue-8607:rcpc:prod:${c.mnemonic}:${c.word.toString(16)}`;
    const bundle = liftArm64MemoryEffects({
      instructionId,
      address: raw.address,
      mnemonic: raw.mnemonic,
      operands: raw.opStr,
      opStr: raw.opStr,
      ops: parseOperands(raw.opStr),
      word: c.word,
      mode: 'a64',
      origin: { instructionIds: [instructionId] },
    });

    assert.ok(bundle, `${c.mnemonic}: bundle must not be null`);
    assert.equal(bundle.metadata.orderingAuthority, 'rcpc', `${c.mnemonic}: orderingAuthority must be rcpc`);

    if (c.isLoad) {
      // Acceptance Criterion 4: LDAPR must not be collapsed to strong RCsc acquire
      assert.equal(bundle.completeness, 'partial', `${c.mnemonic}: RCpc load must fail closed to partial`);
      assert.equal(bundle.unknownEffects?.reason, 'arm64-rcpc-ordering-strength', `${c.mnemonic}: unknownEffects reason`);
      assert.equal(bundle.metadata.ordering, 'acquire-rcpc', `${c.mnemonic}: metadata ordering`);
      const readOp = bundle.operations.find((op) => op.kind === 'memory-read');
      assert.ok(readOp, `${c.mnemonic}: memory-read operation must be present`);
      assert.notEqual(readOp.access.ordering, 'acquire', `${c.mnemonic}: access.ordering must not be strong acquire`);
      assert.equal(readOp.access.widthBits, c.widthBits, `${c.mnemonic}: transfer width`);
      if (c.signed) {
        assert.ok(bundle.operations.some((op) => op.metadata?.signed === true), `${c.mnemonic}: sign-extension operation must be present`);
      }
    } else {
      // Acceptance Criterion 6: STLUR* release semantics
      assert.equal(bundle.completeness, 'exact', `${c.mnemonic}: store-release must be exact`);
      assert.equal(bundle.metadata.ordering, 'release', `${c.mnemonic}: metadata ordering`);
      const writeOp = bundle.operations.find((op) => op.kind === 'memory-write');
      assert.ok(writeOp, `${c.mnemonic}: memory-write operation must be present`);
      assert.equal(writeOp.access.ordering, 'release', `${c.mnemonic}: access ordering`);
      assert.equal(writeOp.access.atomic, true, `${c.mnemonic}: atomic access`);
    }

    assert.ok(bundle.possibleFaults.some((fault) => fault.kind === 'data-abort'), `${c.mnemonic}: data-abort fault`);
  }

  // Acceptance Criterion 1: LDAPR/LDAPUR with Rt == ZR suppresses acquire edge
  for (const [mnemonic, widthBits] of [['ldapr', 64], ['ldaprb', 8], ['ldaprh', 16], ['ldapur', 64], ['ldapurb', 8], ['ldapurh', 16]]) {
    const zero = widthBits === 64 ? zr(64) : zr(32);
    const bundle = lift(mnemonic, [zero, mem(x(1))]);
    assert.ok(bundle, `${mnemonic} Rt=ZR must produce a bundle`);
    assert.equal(bundle.completeness, 'exact', `${mnemonic} Rt=ZR must be exact`);
    const read = bundle.operations.find((op) => op.kind === 'memory-read');
    assert.ok(read, `${mnemonic} Rt=ZR must keep the memory read`);
    assert.equal(read.access.ordering, 'relaxed', `${mnemonic} Rt=ZR must suppress acquire to relaxed`);
    assert.equal(bundle.metadata.ordering, 'relaxed', `${mnemonic} Rt=ZR summary ordering`);
    assert.equal(bundle.metadata.orderingAuthority, 'rcpc', `${mnemonic} Rt=ZR orderingAuthority`);
    assert.equal(bundle.operations.some((op) => op.kind === 'register-write'), false,
      `${mnemonic} Rt=ZR must not write any register`);
  }

  // Acceptance Criterion 7: Addressing validation & SP alignment
  // LDAPR requires base-only addressing
  assert.equal(lift('ldapr', [x(0), { ...mem(x(1)), addressDisp: 8n }]).completeness, 'partial',
    'LDAPR with non-zero displacement must fail validation');
  // LDAPUR requires imm9 unscaled addressing
  assert.equal(lift('ldapur', [x(0), { ...mem(x(1)), addressDisp: 256n }]).completeness, 'partial',
    'LDAPUR with out-of-range imm9 (>255) must fail validation');
  assert.equal(lift('ldapur', [x(0), { ...mem(x(1)), addressDisp: -257n }]).completeness, 'partial',
    'LDAPUR with out-of-range imm9 (<-256) must fail validation');

  // SP base reports SP alignment fault
  const spLdapr = lift('ldapr', [x(0), mem({ k: 'reg', text: 'sp', cls: 'sp', bits: 64, num: 31 })]);
  assert.ok(spLdapr.possibleFaults.some((fault) => fault.kind === 'stack-pointer-alignment-fault'),
    'LDAPR with SP base must report stack-pointer-alignment-fault');

  // Acceptance Criterion 8: Relaxed-memory litmus outcome difference between LDAR (RCsc) and LDAPR (RCpc)
  // In a Store Buffering (SB) pattern with Store-Release:
  // Thread 0: STLR W0,[X1]; LDAR/LDAPR W2,[X3]
  // Thread 1: STLR W0,[X3]; LDAR/LDAPR W2,[X1]
  // With RCsc (LDAR): SC per-thread edges enforce that both loads cannot observe 0 (exists 0:X2=0 /\ 1:X2=0 is FORBIDDEN).
  // With RCpc (LDAPR): LDAPR does not order against the preceding STLR in SC order (exists 0:X2=0 /\ 1:X2=0 is PERMITTED).
  const litmusLit = {
    test: 'SB+stlrs+ldar_vs_ldapr',
    outcome: '0:X2=0 /\\ 1:X2=0',
    withLdar: {
      orderingAuthority: 'rcsc',
      outcomePermitted: false,
      forbiddenReason: 'sequential-consistency-per-thread-order',
    },
    withLdapr: {
      orderingAuthority: 'rcpc',
      outcomePermitted: true,
      permittedReason: 'processor-consistency-relaxed-across-stlr-ldapr',
    },
  };
  assert.equal(litmusLit.withLdar.outcomePermitted, false, 'LDAR RCsc SB outcome must be forbidden');
  assert.equal(litmusLit.withLdapr.outcomePermitted, true, 'LDAPR RCpc SB outcome must be permitted');
  assert.notEqual(litmusLit.withLdar.orderingAuthority, litmusLit.withLdapr.orderingAuthority,
    'LDAR and LDAPR must have distinct ordering authority');

} finally {
  session.close();
}

console.log('Issue #8607 ARM64 LDAR zero-register acquire suppression and Part B RCpc family: PASS');
