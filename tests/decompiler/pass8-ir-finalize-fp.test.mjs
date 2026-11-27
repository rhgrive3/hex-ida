import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, setSemanticMigrationMode, OP, VK } from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';
import { finalizeLegacyProjection } from '../../js/semantics/compat/semantic-ir-v2-to-v1-finalize.js';
import { inferSemanticTypes, reachingRegisterTypeValue } from '../../js/decompiler/type-recovery.js';

const BASE = 0x100000000n;

function buildV2Ir(lines, extraOpts = {}) {
  const rows = lines.map((line, row) => {
    const trimmed = String(line).trim();
    const split = trimmed.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? trimmed : trimmed.slice(0, split),
      ops: split < 0 ? '' : trimmed.slice(split + 1).trim(),
    };
  });
  const rowOfAddress = (address) => {
    const delta = address - BASE;
    return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
  };
  const model = buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  try {
    return buildIR(model, { rowOfAddress, ...extraOpts });
  } finally {
    setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
  }
}

test('Fix 1: finalizeLegacyProjection transfers CALL return reg to source before clearing shadow.reg', () => {
  const argX0 = { id: 0, kind: VK.ARG, reg: 'x0', stateKey: 'state:x0', version: 0, bits: 64, def: null, uses: [], const: null };
  const preCallX0 = { id: 1, kind: VK.DEF, reg: 'x0', stateKey: 'state:x0', version: 1, bits: 64, def: null, uses: [], const: null };
  const callRet = { id: 2, kind: VK.DEF, reg: null, stateKey: null, version: 0, bits: 64, def: null, uses: [], const: null };
  const shadowX0 = { id: 3, kind: VK.DEF, reg: 'x0', stateKey: 'state:x0', version: 2, bits: 64, def: null, uses: [], const: null };
  const storeVal = { id: 4, kind: VK.ARG, reg: 'w1', stateKey: 'state:x1', version: 0, bits: 32, def: null, uses: [], const: null };

  const sbfizInst = { id: 0, op: OP.BFX, sub: 'extract', block: 0, row: 0, dst: preCallX0, args: [{ value: argX0, bits: 64 }], extra: {} };
  preCallX0.def = sbfizInst;

  const callInst = { id: 1, op: OP.CALL, sub: null, block: 0, row: 1, dst: callRet, args: [{ value: preCallX0, bits: 64 }], extra: { name: 'malloc' } };
  callRet.def = callInst;

  const stateWriteInst = {
    id: 2, op: OP.MOV, sub: null, block: 0, row: 1, dst: shadowX0,
    args: [{ value: callRet, bits: 64 }],
    extra: { stateWrite: { key: 'state:x0' }, publicStateIdentity: 'x0' },
  };
  shadowX0.def = stateWriteInst;

  const storeInst = {
    id: 3, op: OP.STORE, sub: null, block: 0, row: 2, dst: null,
    args: [{ value: storeVal, bits: 32 }],
    addr: { base: shadowX0, index: null, disp: 0n, size: 4 },
    extra: {},
  };

  const retInst = { id: 4, op: OP.RET, sub: null, block: 0, row: 3, dst: null, args: [], extra: {} };

  const ir = {
    values: [argX0, preCallX0, callRet, shadowX0, storeVal],
    instructions: [sbfizInst, callInst, stateWriteInst, storeInst, retInst],
    blocks: [{ index: 0, id: 0, insts: [sbfizInst, callInst, stateWriteInst, storeInst, retInst], succ: [] }],
    args: new Map([['x0', argX0], ['w1', storeVal]]),
    locations: new Map(),
  };

  const observer = { records: [], expected: new WeakSet(), unavailable: new WeakSet() };
  finalizeLegacyProjection(ir, null, observer);

  assert.equal(callRet.reg, 'x0', 'CALL return value should receive transferred x0 register identity');
  assert.equal(callRet.stateKey, 'state:x0', 'CALL return value should receive transferred stateKey');
  assert.equal(shadowX0.reg, null, 'aliased shadow should have reg cleared');
  assert.equal(storeInst.addr.base, callRet, 'store base should alias to CALL return value');

  const reaching = reachingRegisterTypeValue(ir, retInst, 'x0');
  assert.equal(reaching, callRet, 'reaching x0 at RET must resolve to malloc() CALL return, not pre-call sbfiz');

  const regTransfer = observer.records.find((e) => e.kind === 'state-reg-transfer');
  assert.ok(regTransfer, 'observer should record state-reg-transfer');
  assert.equal(regTransfer.before.reg, null);
  assert.equal(regTransfer.after.reg, 'x0');
  assert.deepEqual(regTransfer.identityFields, ['reg']);
});

test('Fix 2a: adrp and adr 64-bit constants are tagged addressDerived=true while ordinary/btype constants are not', () => {
  const irAdrp = buildV2Ir([
    'adrp x0, 0x100001000',
    'add x0, x0, #0x10',
    'mov x1, #42',
    'ret',
  ]);
  const adrpConst = irAdrp.instructions.find((i) => i.row === 0 && i.op === OP.CONST && i.dst?.bits === 64);
  assert.ok(adrpConst, 'expected 64-bit CONST for adrp');
  assert.equal(adrpConst.extra.addressDerived, true, 'adrp 64-bit CONST must be tagged addressDerived=true');

  const btypeConst = irAdrp.instructions.find((i) => i.row === 0 && i.op === OP.CONST && i.dst?.bits === 2);
  assert.ok(btypeConst, 'expected 2-bit btype CONST in adrp bundle');
  assert.notEqual(btypeConst.extra.addressDerived, true, '2-bit btype CONST must not be tagged addressDerived');

  const movConst = irAdrp.instructions.find((i) => i.row === 2 && i.op === OP.CONST && i.dst?.bits === 64);
  assert.ok(movConst, 'expected 64-bit CONST for mov x1, #42');
  assert.notEqual(movConst.extra.addressDerived, true, 'ordinary mov immediate must not be tagged addressDerived');

  const irAdr = buildV2Ir([
    'adr x0, 0x100000010',
    'ret',
  ]);
  const adrConst = irAdr.instructions.find((i) => i.row === 0 && i.op === OP.CONST && i.dst?.bits === 64);
  assert.ok(adrConst, 'expected 64-bit CONST for adr');
  assert.equal(adrConst.extra.addressDerived, true, 'adr 64-bit CONST must be tagged addressDerived=true');
});

test('Fix 2b & 2c: ARM64 scalar FP unary ops project cleanly with width/signedness and no spurious OP.UNKNOWN', () => {
  const ir = buildV2Ir([
    'scvtf d1, w0',
    'ucvtf d2, w1',
    'fcvtzs w2, d1',
    'fcvtzu w3, d1',
    'fcvtps w4, d1',
    'fcvtms w5, d1',
    'fcvtns w6, d1',
    'fcvtas w7, d1',
    'fcvtpu x8, d1',
    'fcvtmu x9, d1',
    'fcvtnu x10, d1',
    'fcvtau x11, d1',
    'frinta d3, d1',
    'frintm d4, d1',
    'frintn d5, d1',
    'frintp d6, d1',
    'frintz d7, d1',
    'fcvt s0, d1',
    'fsqrt d0, d1',
    'fadd d0, d0, d1',
    'fcmp d0, d1',
    'ret',
  ]);

  const expectedUnary = [
    [0, 'scvtf', 64, true],
    [1, 'ucvtf', 64, false],
    [2, 'fcvtzs', 32, true],
    [3, 'fcvtzu', 32, false],
    [4, 'fcvtps', 32, true],
    [5, 'fcvtms', 32, true],
    [6, 'fcvtns', 32, true],
    [7, 'fcvtas', 32, true],
    [8, 'fcvtpu', 64, false],
    [9, 'fcvtmu', 64, false],
    [10, 'fcvtnu', 64, false],
    [11, 'fcvtau', 64, false],
    [12, 'frinta', 64, undefined],
    [13, 'frintm', 64, undefined],
    [14, 'frintn', 64, undefined],
    [15, 'frintp', 64, undefined],
    [16, 'frintz', 64, undefined],
    [17, 'fcvt', 32, undefined],
    [18, 'fsqrt', 64, undefined],
  ];

  for (const [row, sub, bits, signed] of expectedUnary) {
    const unInst = ir.instructions.find((i) => i.row === row && i.op === OP.UN && i.sub === sub);
    assert.ok(unInst, `row ${row} should project to OP.UN ${sub}`);
    assert.equal(unInst.bits, bits, `row ${row} (${sub}) should preserve ${bits}-bit width`);
    assert.equal(unInst.extra.float, true, `row ${row} (${sub}) should set extra.float=true`);
    if (signed !== undefined) {
      assert.equal(unInst.extra.signed, signed, `row ${row} (${sub}) should set extra.signed=${signed}`);
    }
  }

  const unknowns = ir.instructions.filter((i) => i.op === OP.UNKNOWN);
  assert.equal(unknowns.length, 0, `expected zero spurious OP.UNKNOWN instructions, got ${unknowns.length}`);

  const clobbers = ir.instructions.filter((i) => i.op === OP.CLOBBER);
  assert.equal(clobbers.length, 0, `expected zero OP.CLOBBER instructions for projected scalar FP ops, got ${clobbers.length}`);

  // Verify type recovery types fcvtps/fcvtpu destinations as signed/unsigned ints, not floating
  const recovered = inferSemanticTypes(ir, {});
  const fcvtpsDst = ir.instructions.find((i) => i.row === 4 && i.op === OP.UN && i.sub === 'fcvtps').dst;
  const fcvtpuDst = ir.instructions.find((i) => i.row === 8 && i.op === OP.UN && i.sub === 'fcvtpu').dst;
  assert.equal(recovered.values.get(fcvtpsDst.id)?.name, 'int32');
  assert.equal(recovered.values.get(fcvtpuDst.id)?.name, 'uint64');
});

test('Fix 2d: ARM64 SIMD movi #0 projects to V1_OP.CONST 0 while non-zero movi stays conservative', () => {
  const irZero = buildV2Ir([
    'movi v0.2s, #0',
    'fadd d0, d0, d1',
    'ret',
  ]);
  const zeroConst = irZero.instructions.find((i) => i.row === 0 && i.op === OP.CONST && i.extra?.compatSource === 'exact-arm64-simd-zero-splat');
  assert.ok(zeroConst, 'movi v0.2s, #0 should project to V1_OP.CONST 0');
  assert.equal(zeroConst.extra.float, 0);
  assert.equal(zeroConst.dst.floatConst, 0);

  const fadd = irZero.instructions.find((i) => i.row === 1 && i.op === OP.BIN && i.sub === 'fadd');
  assert.ok(fadd, 'expected fadd after movi v0.2s, #0');
  // Trace d0 input back through mov/trunc/zext to the CONST 0
  let cur = fadd.args[0]?.value;
  for (let steps = 0; cur?.def?.op === OP.MOV && steps < 8; steps++) cur = cur.def.args[0]?.value;
  assert.equal(cur?.def, zeroConst, 'd0 input to fadd should trace directly to movi V1_OP.CONST 0');

  // 128-bit zero-splat must not crash range-domain (>64-bit)
  const irZero128 = buildV2Ir([
    'movi v0.4s, #0',
    'ret',
  ]);
  const zeroConst128 = irZero128.instructions.find((i) => i.row === 0 && i.op === OP.CONST && i.extra?.compatSource === 'exact-arm64-simd-zero-splat');
  assert.ok(zeroConst128, 'movi v0.4s, #0 should project to V1_OP.CONST 0 without >64-bit range error');
  assert.equal(zeroConst128.extra.float, 0);

  const irNonZero = buildV2Ir([
    'movi v0.2s, #1',
    'ret',
  ]);
  const nonZeroClobber = irNonZero.instructions.find((i) => i.row === 0 && i.op === OP.CLOBBER && i.intrinsicId === 'arm64.simd.movi');
  assert.ok(nonZeroClobber, 'non-zero movi v0.2s, #1 must stay conservative OP.CLOBBER');
});

function makeVariadicCallIr(calleeName, fmtAddr, gpCount, fpCount = 0) {
  const values = [];
  const argsMap = new Map();
  const instructions = [];
  let nextValId = 0;
  let nextInstId = 0;

  const gpArgs = [];
  for (let i = 0; i < gpCount; i++) {
    const v = { id: nextValId++, kind: VK.ARG, reg: `x${i}`, bits: 64, def: null, uses: [], const: null };
    values.push(v);
    argsMap.set(`x${i}`, v);
    gpArgs.push(v);
  }
  const fpArgs = [];
  for (let i = 0; i < fpCount; i++) {
    const v = { id: nextValId++, kind: VK.ARG, reg: `d${i}`, bits: 64, def: null, uses: [], const: null };
    values.push(v);
    argsMap.set(`d${i}`, v);
    fpArgs.push(v);
  }

  // Put the format string address in the callee's format register
  const fmtRegMap = {
    printf: 0, sprintf: 1, snprintf: 2, __sprintf_chk: 3, __snprintf_chk: 4, sscanf: 1,
  };
  const fmtIdx = fmtRegMap[calleeName];
  const callArgs = gpArgs.map((v) => ({ value: v, bits: 64 }));
  if (fmtAddr != null && fmtIdx != null) {
    const fmtVal = { id: nextValId++, kind: VK.DEF, reg: `x${fmtIdx}`, bits: 64, def: null, uses: [], const: fmtAddr };
    const addrInst = { id: nextInstId++, op: OP.ADDR, sub: 'adrp', block: 0, row: 0, dst: fmtVal, args: [], extra: { value: fmtAddr, addressDerived: true } };
    fmtVal.def = addrInst;
    values.push(fmtVal);
    instructions.push(addrInst);
    callArgs[fmtIdx] = { value: fmtVal, bits: 64 };
  }
  for (const fv of fpArgs) callArgs.push({ value: fv, bits: 64 });

  const callRet = { id: nextValId++, kind: VK.DEF, reg: 'x0', bits: 64, def: null, uses: [], const: null };
  const callInst = {
    id: nextInstId++, op: OP.CALL, sub: null, block: 0, row: 1, dst: callRet,
    args: callArgs, extra: { name: calleeName },
  };
  callRet.def = callInst;
  values.push(callRet);
  instructions.push(callInst);
  for (const a of callArgs) a.value.uses.push(callInst);

  const retInst = { id: nextInstId++, op: OP.RET, sub: null, block: 0, row: 2, dst: null, args: [{ value: callRet, bits: 64 }], extra: {} };
  callRet.uses.push(retInst);
  instructions.push(retInst);

  return {
    values,
    instructions,
    blocks: [{ index: 0, id: 0, insts: instructions, succ: [] }],
    args: argsMap,
    locations: new Map(),
  };
}

test('Fix 3: variadic printf/sprintf/snprintf/__snprintf_chk/sscanf cap GP arg reads via static format string', () => {
  // sprintf(x0=buf, x1="%d", x2=val) with live-through x3, x4
  const irSprintf = makeVariadicCallIr('sprintf', 0x2000n, 5);
  const resSprintf = inferSemanticTypes(irSprintf, { addressRefs: [{ row: 0, addr: 0x2000n, text: '%d' }] });
  assert.deepEqual(resSprintf.args.map((a) => a.reg), ['x0', 'x1', 'x2'], 'sprintf("%d") must not promote x3/x4');

  // snprintf(x0=buf, x1=n, x2="%d", x3=val) with live-through x4, x5
  const irSnprintf = makeVariadicCallIr('snprintf', 0x2010n, 6);
  const resSnprintf = inferSemanticTypes(irSnprintf, { addressRefs: [{ row: 0, addr: 0x2010n, text: '%d' }] });
  assert.deepEqual(resSnprintf.args.map((a) => a.reg), ['x0', 'x1', 'x2', 'x3'], 'snprintf("%d") must not promote x4/x5');

  // __snprintf_chk(x0=buf, x1=n, x2=flag, x3=osz, x4="%s", x5=str) with live-through x6, x7
  const irSnprintfChk = makeVariadicCallIr('__snprintf_chk', 0x2020n, 8);
  const resSnprintfChk = inferSemanticTypes(irSnprintfChk, { addressRefs: [{ row: 0, addr: 0x2020n, text: '%s' }] });
  assert.deepEqual(resSnprintfChk.args.map((a) => a.reg), ['x0', 'x1', 'x2', 'x3', 'x4', 'x5'], '__snprintf_chk("%s") must not promote x6/x7');

  // printf("%f %f", d0, d1) with live-through x1, x2 and d2
  const irPrintfFp = makeVariadicCallIr('printf', 0x2030n, 3, 3);
  const resPrintfFp = inferSemanticTypes(irPrintfFp, {}, { stringFor: (addr) => addr === 0x2030n ? '%f %f' : null });
  assert.deepEqual(resPrintfFp.args.map((a) => a.reg), ['d0', 'd1'], 'printf("%f %f") should keep d0,d1 and drop unused x1,x2,d2');

  // sscanf(x0=str, x1="%d %lf", x2=&a, x3=&b) — both %d and %lf pass GP pointers!
  const irSscanf = makeVariadicCallIr('sscanf', 0x2040n, 6);
  const resSscanf = inferSemanticTypes(irSscanf, { addressRefs: [{ row: 0, addr: 0x2040n, text: '%d %lf' }] });
  assert.deepEqual(resSscanf.args.map((a) => a.reg), ['x0', 'x1', 'x2', 'x3'], 'sscanf("%d %lf") keeps x2,x3 pointers and drops x4,x5');

  // Dynamic/unresolvable format string falls back conservatively
  const irDynamic = makeVariadicCallIr('printf', null, 3);
  const resDynamic = inferSemanticTypes(irDynamic, {});
  assert.deepEqual(resDynamic.args.map((a) => a.reg), ['x0', 'x1', 'x2'], 'unresolvable printf format stays conservative');
});
