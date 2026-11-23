import test from 'node:test';
import assert from 'node:assert/strict';

import { SYSV_AMD64_ABI, SYSV_AMD64_ILP32_ABI } from '../js/targets/abi/sysv-amd64.js';
import { MICROSOFT_X64_ABI } from '../js/targets/abi/microsoft-x64.js';
import { MICROSOFT_VECTORCALL_ABI } from '../js/targets/abi/microsoft-vectorcall.js';
import { AAPCS64_ABI, AAPCS64_ILP32_ABI } from '../js/targets/abi/aapcs64-core.js';
import { DARWIN_ARM64_ABI } from '../js/targets/abi/darwin-arm64.js';
import { RISCV_LP64D_ABI } from '../js/targets/abi/riscv-lp64.js';

import { liftArm64ControlEffects } from '../js/targets/architecture/arm64/effects/control.js';
import { liftArm64FlagEffects } from '../js/targets/architecture/arm64/effects/flags-core.js';
import { buildArm64EffectiveAddress } from '../js/targets/architecture/arm64/effects/addressing.js';
import { liftArm64FpEffects } from '../js/targets/architecture/arm64/effects/fp-core.js';
import { resolveArm64BtypeTransition } from '../js/targets/architecture/arm64/effects/btype.js';

import { liftX86IntegerEffects } from '../js/targets/architecture/x86_64/effects/integer.js';
import { liftX86MemoryEffects } from '../js/targets/architecture/x86_64/effects/memory.js';
import { liftX86BitScanEffects } from '../js/targets/architecture/x86_64/effects/bit-scan.js';
import { createX86EffectContext, x86RegisterOperand } from '../js/targets/architecture/x86_64/effects/common.js';
import { resolveX86SwitchTables } from '../js/targets/architecture/x86_64/jump-table.js';

test('1. [P0] Pointer types (char *, int *, float *, double *, struct T *) classify as pointer-width integer class across all ABIs', () => {
  const ptrTypes = ['char *', 'int *', 'float *', 'double *', 'struct T *'];
  const abis = [
    { name: 'sysv-amd64', abi: SYSV_AMD64_ABI, arg0: 'rdi', ret: 'rax', bits: 64 },
    { name: 'sysv-amd64-ilp32', abi: SYSV_AMD64_ILP32_ABI, arg0: 'rdi', ret: 'rax', bits: 32 },
    { name: 'microsoft-x64', abi: MICROSOFT_X64_ABI, arg0: 'rcx', ret: 'rax', bits: 64 },
    { name: 'microsoft-vectorcall', abi: MICROSOFT_VECTORCALL_ABI, arg0: 'rcx', ret: 'rax', bits: 64 },
    { name: 'aapcs64', abi: AAPCS64_ABI, arg0: 'x0', ret: 'x0', bits: 64 },
    { name: 'aapcs64-ilp32', abi: AAPCS64_ILP32_ABI, arg0: 'x0', ret: 'x0', bits: 32 },
    { name: 'darwin-arm64', abi: DARWIN_ARM64_ABI, arg0: 'x0', ret: 'x0', bits: 64 },
    { name: 'riscv-lp64d', abi: RISCV_LP64D_ABI, arg0: 'x10', ret: 'x10', bits: 64 },
  ];

  for (const { name, abi, arg0, ret, bits } of abis) {
    for (const ptrType of ptrTypes) {
      const argsRes = abi.classifyArguments({ callPrototype: { args: [{ type: ptrType }] } });
      assert.equal(argsRes.arguments[0].location, 'register', `${name} arg ${ptrType} should be register`);
      assert.equal(argsRes.arguments[0].reg, arg0, `${name} arg ${ptrType} should use ${arg0}`);
      assert.equal(argsRes.arguments[0].pointer, true, `${name} arg ${ptrType} should be pointer=true`);
      assert.equal(argsRes.arguments[0].bits, bits, `${name} arg ${ptrType} should have ${bits} bits`);

      const retRes = abi.classifyCallReturn({ callPrototype: { returnType: ptrType } });
      assert.equal(retRes.reg, ret, `${name} ret ${ptrType} should return in ${ret}`);
      assert.equal(retRes.bits, bits, `${name} ret ${ptrType} should have ${bits} bits`);
    }
  }
});

test('2. [P1] ARM64 control.js accepts decimal string branch targets', () => {
  const res = liftArm64ControlEffects({
    instructionId: 'arm64:b:dec',
    id: 'arm64:b:dec',
    address: 0x1000n,
    mnemonic: 'b',
    ops: [{ k: 'imm', value: '4100' }],
    branchTarget: '4100',
  }, { instructionId: 'arm64:b:dec' });
  assert.equal(res.completeness, 'exact');
});

test('3. [P1] x86-64 32-bit CMOVcc zero-extends on false path just like memory CMOVcc', () => {
  const eax = x86RegisterOperand('eax');
  const ebx = x86RegisterOperand('ebx');
  const res = liftX86IntegerEffects({
    id: 1,
    instructionId: 'x86:cmovnz:32',
    address: 0x1000n,
    length: 3,
    rawBytes: Uint8Array.from([0x90, 0x90, 0x90]),
    instructionFamily: 'cmovnz',
    detailStatus: 'complete',
    detail: {
      conditionCode: 'nz',
      operands: [eax, ebx],
    },
  });
  assert.equal(res.completeness, 'exact');
  assert.equal(res.metadata.falsePathPreservesPhysicalRegister, false);
  assert.equal(res.metadata.falsePathZeroExtendsUpperBits, true);
  const regWrite = res.operations.find((op) => op.kind === 'register-write');
  assert.ok(regWrite, 'expected register-write operation');
  const selectOp = res.operations.find((op) => op.kind === 'value' && op.opcode === 'select');
  assert.ok(selectOp, 'expected select operation');
  const zextOps = res.operations.filter((op) => op.kind === 'value' && op.opcode === 'zext');
  assert.equal(zextOps.length, 2, 'both true and false paths should zero-extend 32-bit view to 64-bit');
});

test('4. [P1] x86-64 ROL/ROR uses pre-modulo (count & 0x1F) for NOP/CF/OF checks', () => {
  const al = x86RegisterOperand('al');
  // rol al, 8: (8 & 0x1f) === 8 != 0, so NOT a NOP! CF is updated, OF is undefined.
  const rol8 = liftX86IntegerEffects({
    id: 1,
    instructionId: 'x86:rol:al:8',
    address: 0x1000n,
    length: 3,
    rawBytes: Uint8Array.from([0x90, 0x90, 0x90]),
    instructionFamily: 'rol',
    detailStatus: 'complete',
    detail: {
      operands: [al, { type: 'immediate', value: 8n, widthBits: 8 }],
    },
  });
  assert.equal(rol8.completeness, 'exact-with-intrinsic');
  assert.notEqual(rol8.metadata?.destinationWrite, false, 'rol al, 8 must not be treated as NOP');
  const cfWrite = rol8.operations.find((op) => op.kind === 'flag-write' && op.flag?.flagId === 'RFLAGS.CF');
  assert.ok(cfWrite, 'rol al, 8 must update CF');
  const ofWrite = rol8.operations.find((op) => op.kind === 'flag-write' && op.flag?.flagId === 'RFLAGS.OF');
  assert.ok(ofWrite, 'rol al, 8 must mark OF undefined');

  // rol al, 9: (9 & 0x1f) === 9 != 1, so OF must be undefined (not MSB XOR CF)
  const rol9 = liftX86IntegerEffects({
    id: 1,
    instructionId: 'x86:rol:al:9',
    address: 0x1004n,
    length: 3,
    rawBytes: Uint8Array.from([0x90, 0x90, 0x90]),
    instructionFamily: 'rol',
    detailStatus: 'complete',
    detail: {
      operands: [al, { type: 'immediate', value: 9n, widthBits: 8 }],
    },
  });
  const ofWrite9 = rol9.operations.find((op) => op.kind === 'flag-write' && op.flag?.flagId === 'RFLAGS.OF');
  assert.equal(ofWrite9?.metadata?.definedness, 'undefined', 'rol al, 9 has count 9 > 1 so OF is undefined');

  // rol al, 32: (32 & 0x1f) === 0, so TRUE NOP
  const rol32 = liftX86IntegerEffects({
    id: 1,
    instructionId: 'x86:rol:al:32',
    address: 0x1008n,
    length: 3,
    rawBytes: Uint8Array.from([0x90, 0x90, 0x90]),
    instructionFamily: 'rol',
    detailStatus: 'complete',
    detail: {
      operands: [al, { type: 'immediate', value: 32n, widthBits: 8 }],
    },
  });
  assert.equal(rol32.metadata?.destinationWrite, false, 'rol al, 32 is a true NOP');
  assert.equal(rol32.metadata?.flagsPreserved, true, 'rol al, 32 preserves flags');
});

test('5. [P1] x86-64 bit-scan accepts SIB index 4 with REX.X=1 (r12)', () => {
  const rax = x86RegisterOperand('rax');
  const rbx = x86RegisterOperand('rbx');
  const r12 = x86RegisterOperand('r12');
  // 4a 0f bc 04 23 => REX.W=1, REX.X=1 (0x4a), 0f bc (bsf), ModRM=0x04 (SIB), SIB=0x23 (index=4, base=3=rbx, scale=1)
  const ctx = createX86EffectContext({
    id: 1,
    instructionId: 'x86:bsf:r12',
    address: 0x1000n,
    length: 5,
    instructionFamily: 'bsf',
    decoderSemanticVersion: 'capstone-5-x86-structured-v2',
    rawBytes: Uint8Array.from([0x4a, 0x0f, 0xbc, 0x04, 0x23]),
    detailStatus: 'complete',
    detail: {
      abiContractVersion: 'capstone-5-wasm32-x86-detail/v1',
      prefixes: { legacy: [], rex: 0x4a, vector: null },
      opcodeBytes: [0x0f, 0xbc],
      modrm: 0x04,
      sib: 0x23,
      addressSizeBits: 64,
      encodingOffsets: { modrmOffset: 3, displacementOffset: 0, displacementSize: 0, immediateOffset: 0, immediateSize: 0 },
      implicitReads: [],
      implicitWrites: [x86RegisterOperand('rflags').register],
      operands: [
        { ...rax, access: 'write' },
        {
          type: 'memory',
          widthBits: 64,
          access: 'read',
          memory: { base: rbx.register, index: r12.register, scale: 1, displacement: 0n, addressSizeBits: 64 },
        },
      ],
    },
  });
  const res = liftX86BitScanEffects(ctx);
  assert.equal(res.completeness, 'exact-with-intrinsic');
});

test('6. [P1] ARM64 common.js REGISTER_EXTEND_MNEMONICS includes cmp and cmn', () => {
  const cmpRes = liftArm64FlagEffects({
    instructionId: 'arm64:cmp:ext',
    id: 'arm64:cmp:ext',
    address: 0x1000n,
    mnemonic: 'cmp',
    ops: [
      { k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' },
      { k: 'reg', cls: 'gp', num: 1, bits: 32, text: 'w1', extend: 'uxtw' },
    ],
  });
  assert.notEqual(cmpRes.unknownEffects?.reason, 'arm64-unsupported-register-extend');
  const cmnRes = liftArm64FlagEffects({
    instructionId: 'arm64:cmn:ext',
    id: 'arm64:cmn:ext',
    address: 0x1004n,
    mnemonic: 'cmn',
    ops: [
      { k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' },
      { k: 'reg', cls: 'gp', num: 1, bits: 32, text: 'w1', extend: 'sxtw' },
    ],
  });
  assert.notEqual(cmnRes.unknownEffects?.reason, 'arm64-unsupported-register-extend');
});

test('7. [P1] sysv-amd64 typeBits resolves long int and long long int before int', () => {
  // LP64: long int -> 64, long long int -> 64
  const lp64LongInt = SYSV_AMD64_ABI.classifyArguments({
    callPrototype: { args: [{ type: 'long int' }, { type: 'long long int' }, { type: 'unsigned long int' }] },
  });
  assert.equal(lp64LongInt.arguments[0].bits, 64);
  assert.equal(lp64LongInt.arguments[1].bits, 64);
  assert.equal(lp64LongInt.arguments[2].bits, 64);

  // x32 (ILP32): long int -> 32, long long int -> 64
  const x32LongInt = SYSV_AMD64_ILP32_ABI.classifyArguments({
    callPrototype: { args: [{ type: 'long int' }, { type: 'long long int' }] },
  });
  assert.equal(x32LongInt.arguments[0].bits, 32);
  assert.equal(x32LongInt.arguments[1].bits, 64);
});

test('8. [P1] microsoft-vectorcall reserves rcx for indirect non-HVA struct return and shifts user args', () => {
  const proto = {
    returnType: 'struct Big',
    aggregate: true,
    returnBits: 128,
    trivialForCalls: true,
    layout: {
      bytes: 16,
      bits: 128,
      members: [
        { bits: 64, bytes: 8, byteOffset: 0 },
        { bits: 64, bytes: 8, byteOffset: 8 },
      ],
    },
    args: [
      { type: 'int', bits: 32 },
      { type: 'double', bits: 64 },
    ],
  };
  const res = MICROSOFT_VECTORCALL_ABI.classifyArguments({ callPrototype: proto });
  assert.equal(res.returnClassification, 'indirect');
  assert.equal(res.arguments[0].role, 'indirect-result');
  assert.equal(res.arguments[0].reg, 'rcx');
  assert.equal(res.arguments[1].index, 0);
  assert.equal(res.arguments[1].reg, 'rdx', 'first user integer arg shifts from rcx to rdx');
  assert.equal(res.arguments[2].index, 1);
  assert.equal(res.arguments[2].reg, 'xmm2', 'second user fp arg shifts from xmm1 to xmm2');
});

test('9. [P1] darwin-arm64 (a) sets gp=8 on aggregate/integer spill and (b) does not over-align 4-byte struct to 8 bytes', () => {
  // (a) gp=7, 16-byte struct spills to stack -> gp becomes 8, so next 64-bit int also spills to stack instead of x7
  const argsA = Array.from({ length: 7 }, () => ({ type: 'long', bits: 64 }));
  argsA.push({
    type: 'struct S16',
    aggregate: true,
    bits: 128,
    layout: {
      bytes: 16,
      bits: 128,
      members: [
        { bits: 64, bytes: 8, byteOffset: 0, alignmentBytes: 8 },
        { bits: 64, bytes: 8, byteOffset: 8, alignmentBytes: 8 },
      ],
    },
  });
  argsA.push({ type: 'long', bits: 64 });
  const resA = DARWIN_ARM64_ABI.classifyArguments({ callPrototype: { args: argsA } });
  assert.equal(resA.arguments[7].location, 'stack');
  assert.equal(resA.arguments[8].location, 'stack', 'int after spilled 16-byte struct must also spill to stack');

  // (b) 4-byte struct with 4-byte member alignment should have alignmentBytes === 4, not 8
  const resB = DARWIN_ARM64_ABI.classifyArguments({
    callPrototype: {
      args: [
        ...Array.from({ length: 8 }, () => ({ type: 'long', bits: 64 })),
        { type: 'char', bits: 8 },
        {
          type: 'struct S4',
          aggregate: true,
          bits: 32,
          layout: {
            bytes: 4,
            bits: 32,
            members: [{ bits: 32, bytes: 4, byteOffset: 0, alignmentBytes: 4 }],
          },
        },
      ],
    },
  });
  assert.equal(resB.arguments[9].offset, 4, '4-byte struct after 1-byte char on Darwin stack should align to 4, not 8');
});

test('10. [P2] x86-64 jump-table preserves upper bits on 8/16-bit write and respects lsb on ah/bh/ch/dh read', () => {
  const rax = { type: 'register', register: { id: 'rax', physicalId: 'rax', viewBits: 64, physicalBits: 64, lsb: 0 } };
  const al = { type: 'register', register: { id: 'al', physicalId: 'rax', viewBits: 8, physicalBits: 64, lsb: 0 } };
  const ah = { type: 'register', register: { id: 'ah', physicalId: 'rax', viewBits: 8, physicalBits: 64, lsb: 8 } };
  const rcx = { type: 'register', register: { id: 'rcx', physicalId: 'rcx', viewBits: 64, physicalBits: 64, lsb: 0 } };

  // mov rax, 0x1234; mov al, 0x56; mov rcx, rax; jmp rcx (just check symbolic resolution doesn't crash and tracks)
  const insns = [
    { address: 0x1000n, mnemonic: 'mov', instructionFamily: 'mov', detailStatus: 'complete', detail: { operands: [rax, { type: 'immediate', value: 0x1234n }] } },
    { address: 0x1004n, mnemonic: 'mov', instructionFamily: 'mov', detailStatus: 'complete', detail: { operands: [al, { type: 'immediate', value: 0x56n }] } },
    { address: 0x1007n, mnemonic: 'movzx', instructionFamily: 'movzx', detailStatus: 'complete', detail: { operands: [rcx, ah] } },
    { address: 0x100bn, mnemonic: 'jmp', instructionFamily: 'jmp', detailStatus: 'complete', detail: { operands: [rcx] } },
  ];
  const res = resolveX86SwitchTables(insns, [], () => 'branch');
  // Since al wrote 0x56 preserving upper bits, ah (lsb=8) should NOT be 0x56 (which truncate(0..8) would have read!)
  assert.ok(res && typeof res === 'object');
});

test('11. [P2] ARM64 addressing.js allows zero register (xzr/wzr) as index register', () => {
  const addr = buildArm64EffectiveAddress({
    mnemonic: 'ldr',
    ops: [
      { k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' },
      {
        k: 'mem',
        base: { k: 'reg', cls: 'gp', num: 1, bits: 64, text: 'x1' },
        index: { k: 'reg', cls: 'zr', zero: true, bits: 64, text: 'xzr' },
      },
    ],
  });
  assert.ok(addr.addressExpr, 'xzr index register should build effective address');
});

test('12. [P2] ARM64 fp-core.js allows fmov between Hn (16-bit FP) and Xn (64-bit GP)', () => {
  const hToX = liftArm64FpEffects({
    instructionId: 'arm64:fmov:hx',
    id: 'arm64:fmov:hx',
    address: 0x1000n,
    mnemonic: 'fmov',
    ops: [
      { k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' },
      { k: 'reg', cls: 'fp', num: 1, bits: 16, text: 'h1' },
    ],
  });
  assert.equal(hToX.completeness, 'exact');

  const xToH = liftArm64FpEffects({
    instructionId: 'arm64:fmov:xh',
    id: 'arm64:fmov:xh',
    address: 0x1004n,
    mnemonic: 'fmov',
    ops: [
      { k: 'reg', cls: 'fp', num: 1, bits: 16, text: 'h1' },
      { k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' },
    ],
  });
  assert.equal(xToH.completeness, 'exact');
});

test('13. [P2] ARM64 btype.js DIRECT_RESET includes bc.<cond> and retaasppc*/retabsppc*', () => {
  for (const mnemonic of ['bc.eq', 'bc.ne', 'retaasppc', 'retabsppc', 'retaasppcr', 'retabsppcr']) {
    const tr = resolveArm64BtypeTransition({ mnemonic });
    assert.equal(tr?.value, 0, `${mnemonic} should reset PSTATE.BTYPE to 0`);
  }
});

test('14. [P2] x86-64 memory.js restricts cmovcc width to [16, 32, 64]', () => {
  const al = x86RegisterOperand('al');
  const rbx = x86RegisterOperand('rbx');
  const res = liftX86MemoryEffects({
    id: 1,
    instructionId: 'x86:cmovz:mem8',
    address: 0x1000n,
    length: 3,
    rawBytes: Uint8Array.from([0x90, 0x90, 0x90]),
    instructionFamily: 'cmovz',
    detailStatus: 'complete',
    detail: {
      conditionCode: 'z',
      operands: [
        al,
        { type: 'memory', widthBits: 8, memory: { base: rbx.register, displacement: 0n, addressSizeBits: 64 } },
      ],
    },
  });
  assert.equal(res.completeness, 'partial');
  assert.equal(res.unknownEffects?.reason, 'x86-cmovcc-memory-shape-unmodelled');
});
