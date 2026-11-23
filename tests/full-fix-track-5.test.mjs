import test from 'node:test';
import assert from 'node:assert/strict';

import { AAPCS64_ABI } from '../js/targets/abi/aapcs64-core.js';
import { DARWIN_ARM64_ABI } from '../js/targets/abi/darwin-arm64.js';
import { RISCV_LP64D_ABI } from '../js/targets/abi/riscv-lp64.js';
import { MICROSOFT_VECTORCALL_ABI } from '../js/targets/abi/microsoft-vectorcall.js';
import { liftArm64MemoryEffects } from '../js/targets/architecture/arm64/effects/memory.js';
import { decorateArm64GcsEffects, liftArm64ControlEffects } from '../js/targets/architecture/arm64/effects/control.js';

test('1. [P0] AAPCS64 places >8B..<=16B composite entirely on stack when 8 - gp < words (Rules C.11-C.15)', () => {
  const sevenInts = Array.from({ length: 7 }, () => ({ type: 'uint64_t', bits: 64 }));
  const struct16 = {
    type: 'struct Pair',
    aggregate: true,
    bits: 128,
    bytes: 16,
    alignment: 8,
    members: [
      { type: 'uint64_t', bits: 64, bytes: 8, byteOffset: 0 },
      { type: 'uint64_t', bits: 64, bytes: 8, byteOffset: 8 },
    ],
  };
  const trailingInt = { type: 'uint64_t', bits: 64 };

  const res = AAPCS64_ABI.classifyArguments({
    callPrototype: { parameters: [...sevenInts, struct16, trailingInt] },
  });

  // Arg 7 (struct16) must NOT split across x7 and stack; must go wholly to stack at offset 0.
  assert.equal(res.arguments[7].location, 'stack');
  assert.equal(res.arguments[7].offset, 0);
  assert.equal(res.arguments[7].bytes, 16);
  assert.equal(res.srcs.some((s) => s.reg === 'x7'), false, 'x7 must not be used for split composite or subsequent arg');

  // Arg 8 (trailingInt) must also be on the stack because NGRN became 8 (Rule C.12).
  assert.equal(res.arguments[8].location, 'stack');
  assert.equal(res.arguments[8].offset, 16);
  assert.equal(res.arguments[8].bytes, 8);

  // Also test 12-byte composite (needed = 2 words) at gp === 7.
  const struct12 = {
    type: 'struct Tri32',
    aggregate: true,
    bits: 96,
    bytes: 12,
    alignment: 4,
    members: [
      { type: 'uint32_t', bits: 32, bytes: 4, byteOffset: 0 },
      { type: 'uint32_t', bits: 32, bytes: 4, byteOffset: 4 },
      { type: 'uint32_t', bits: 32, bytes: 4, byteOffset: 8 },
    ],
  };
  const res12 = AAPCS64_ABI.classifyArguments({
    callPrototype: { parameters: [...sevenInts, struct12] },
  });
  assert.equal(res12.arguments[7].location, 'stack');
  assert.equal(res12.arguments[7].offset, 0);
  assert.equal(res12.arguments[7].bytes, 16);
  assert.equal(res12.srcs.some((s) => s.reg === 'x7'), false);
});

test('2. [P0] Darwin ARM64 aligns 16B natural-alignment GP arguments to even register numbers', () => {
  // Case A: uint64_t (x0), then __int128 (alignmentBytes=16) -> must skip x1 and use x2..x3
  const resScalar = DARWIN_ARM64_ABI.classifyArguments({
    callPrototype: {
      parameters: [
        { type: 'uint64_t', bits: 64 },
        { type: '__int128', bits: 128 },
      ],
    },
  });
  assert.equal(resScalar.arguments[0].reg, 'x0');
  assert.equal(resScalar.arguments[1].location, 'register');
  assert.deepEqual(resScalar.arguments[1].regs, ['x2', 'x3']);

  // Case B: uint64_t (x0), then 16B-aligned composite -> must skip x1 and use x2..x3
  const resAgg = DARWIN_ARM64_ABI.classifyArguments({
    callPrototype: {
      parameters: [
        { type: 'uint64_t', bits: 64 },
        {
          type: 'struct Aligned16',
          aggregate: true,
          bits: 128,
          bytes: 16,
          alignmentBytes: 16,
          members: [
            { type: 'uint64_t', bits: 64, bytes: 8, byteOffset: 0 },
            { type: 'uint64_t', bits: 64, bytes: 8, byteOffset: 8 },
          ],
        },
      ],
    },
  });
  assert.equal(resAgg.arguments[1].location, 'register');
  assert.deepEqual(resAgg.arguments[1].regs, ['x2', 'x3']);

  // Case C: 7 uint64_t args (gp=7), then __int128 -> gp rounds to 8 -> spills to stack
  const sevenInts = Array.from({ length: 7 }, () => ({ type: 'uint64_t', bits: 64 }));
  const resSpill = DARWIN_ARM64_ABI.classifyArguments({
    callPrototype: {
      parameters: [...sevenInts, { type: '__int128', bits: 128 }],
    },
  });
  assert.equal(resSpill.arguments[7].location, 'stack');
  assert.equal(resSpill.arguments[7].offset, 0);
  assert.equal(resSpill.srcs.some((s) => s.reg === 'x7'), false);
});

test('3. [P0] RISC-V LP64D disables hardware FP struct flattening at anonymous variadic positions', () => {
  const fpPair = {
    type: 'struct DoublePair',
    aggregate: true,
    bits: 128,
    bytes: 16,
    members: [
      { type: 'double', bits: 64, bytes: 8, byteOffset: 0 },
      { type: 'double', bits: 64, bytes: 8, byteOffset: 8 },
    ],
  };

  // Anonymous variadic position (index 1 >= fixedParameterCount 1): must use integer regs x11..x12, NOT f10..f11
  const resVar = RISCV_LP64D_ABI.classifyArguments({
    callPrototype: {
      variadic: true,
      fixedParameterCount: 1,
      parameters: [{ type: 'const char *' }, fpPair],
    },
  });
  assert.equal(resVar.arguments[0].reg, 'x10');
  assert.equal(resVar.arguments[1].location, 'registers');
  assert.deepEqual(resVar.arguments[1].regs, ['x11', 'x12']);
  assert.equal(resVar.srcs.some((s) => s.reg === 'f10' || s.reg === 'f11'), false);

  // Mixed float+int struct at anonymous variadic position must also bypass FP flattening
  const mixedPair = {
    type: 'struct FloatInt',
    aggregate: true,
    bits: 64,
    bytes: 8,
    members: [
      { type: 'float', bits: 32, bytes: 4, byteOffset: 0 },
      { type: 'int32_t', bits: 32, bytes: 4, byteOffset: 4 },
    ],
  };
  const resMixedVar = RISCV_LP64D_ABI.classifyArguments({
    callPrototype: {
      variadic: true,
      fixedParameterCount: 1,
      parameters: [{ type: 'const char *' }, mixedPair],
    },
  });
  assert.equal(resMixedVar.arguments[1].location, 'registers');
  assert.deepEqual(resMixedVar.arguments[1].regs, ['x11']);
  assert.equal(resMixedVar.srcs.some((s) => s.reg === 'f10'), false);

  // Named (non-variadic) position still flattens to f10..f11
  const resNamed = RISCV_LP64D_ABI.classifyArguments({
    callPrototype: {
      variadic: true,
      fixedParameterCount: 1,
      parameters: [fpPair],
    },
  });
  assert.equal(resNamed.arguments[0].location, 'flattened-registers');
  assert.deepEqual(resNamed.arguments[0].regs, ['f10', 'f11']);
});

test('4. [P1] AAPCS64 fails closed (allocationUncertain=true) after unproven/unsupported/padded aggregates', () => {
  const cases = [
    { name: 'SVE scalable', arg0: { type: 'svfloat32_t' }, expectedLoc0: 'unsupported' },
    { name: 'invalid HFA+HVA metadata', arg0: { type: 'struct Bad', aggregate: true, hfa: true, hva: true, bits: 64 }, expectedLoc0: 'unknown' },
    { name: 'unproven HFA', arg0: { type: 'struct BadHfa', aggregate: true, hfa: true, members: 2 }, expectedLoc0: 'unknown' },
    { name: 'unproven aggregate', arg0: { type: 'struct Opaque', aggregate: true }, expectedLoc0: 'unknown' },
    {
      name: 'padded aggregate in GP path',
      arg0: {
        type: 'struct Padded',
        aggregate: true,
        bits: 64,
        alignment: 8,
        layout: {
          bytes: 16,
          bits: 64,
          members: [{ type: 'uint64_t', bits: 64, bytes: 8, byteOffset: 0 }],
        },
      },
      expectedLoc0: 'unknown',
    },
  ];

  for (const { name, arg0, expectedLoc0 } of cases) {
    const res = AAPCS64_ABI.classifyArguments({
      callPrototype: { parameters: [arg0, { type: 'uint64_t', bits: 64 }] },
    });
    assert.equal(res.arguments[0].location, expectedLoc0, `${name}: arg0 location`);
    assert.equal(res.arguments[1].location, 'unknown', `${name}: arg1 must be unknown after uncertain arg0`);
    assert.equal(res.arguments[1].reason, 'preceding-argument-layout-not-proven', `${name}: arg1 reason`);
    assert.equal(res.stackArgsUnknown, true, `${name}: stackArgsUnknown must be true`);
    assert.equal(res.stackArgsMayContainPointers, true, `${name}: stackArgsMayContainPointers must be true`);
    assert.equal(res.srcs.some((s) => s.reg === 'x0' && s.mustUse === true), false, `${name}: x0 must not be deterministically assigned`);
  }
});

test('5. [P1] AAPCS64 stack fallback aligns non-HFA 16B-aligned arguments (128-bit FP/SIMD)', () => {
  const eightDoubles = Array.from({ length: 8 }, () => ({ type: 'double', bits: 64 }));
  // 9th arg is double -> stack offset 0, size 8 (stackOffset becomes 8)
  // 10th arg is 128-bit FP -> must align up to 16 (offset 16, bytes 16)
  const resFp128 = AAPCS64_ABI.classifyArguments({
    callPrototype: {
      parameters: [
        ...eightDoubles,
        { type: 'double', bits: 64 },
        { type: 'float128', abiClass: 'fp', bits: 128 },
      ],
    },
  });
  assert.equal(resFp128.arguments[8].location, 'stack');
  assert.equal(resFp128.arguments[8].offset, 0);
  assert.equal(resFp128.arguments[9].location, 'stack');
  assert.equal(resFp128.arguments[9].offset, 16);
  assert.equal(resFp128.arguments[9].bytes, 16);

  // Same for 128-bit SIMD vector spilling to stack after an 8-byte stack argument
  const resSimd128 = AAPCS64_ABI.classifyArguments({
    callPrototype: {
      parameters: [
        ...eightDoubles,
        { type: 'double', bits: 64 },
        { type: 'vector', abiClass: 'vector', bits: 128 },
      ],
    },
  });
  assert.equal(resSimd128.arguments[9].location, 'stack');
  assert.equal(resSimd128.arguments[9].offset, 16);
  assert.equal(resSimd128.arguments[9].bytes, 16);
});

test('6. [P1] Darwin ARM64 fails closed after unproven arguments and reflects uncertainty in stackArgsUnknown', () => {
  const cases = [
    { name: 'Apple long double width conflict', arg0: { type: 'long double', bits: 128 } },
    { name: 'invalid HFA+HVA metadata', arg0: { type: 'struct Bad', aggregate: true, hfa: true, hva: true, bits: 64 } },
    { name: 'unproven HFA', arg0: { type: 'struct BadHfa', aggregate: true, hfa: true, members: 2 } },
    { name: 'unproven aggregate', arg0: { type: 'struct Opaque', aggregate: true } },
    {
      name: 'unproven aggregate alignment',
      arg0: {
        type: 'struct Unaligned',
        aggregate: true,
        bits: 64,
        layout: { bytes: 8, bits: 64, members: [{ bits: 64, bytes: 8, byteOffset: 0 }] },
      },
    },
    {
      name: 'padded aggregate in GP path',
      arg0: {
        type: 'struct Padded',
        aggregate: true,
        bits: 64,
        alignmentBytes: 8,
        layout: {
          bytes: 16,
          bits: 64,
          members: [{ type: 'uint64_t', bits: 64, bytes: 8, byteOffset: 0 }],
        },
      },
    },
  ];

  for (const { name, arg0 } of cases) {
    const res = DARWIN_ARM64_ABI.classifyArguments({
      callPrototype: { parameters: [arg0, { type: 'uint64_t', bits: 64 }] },
    });
    assert.equal(res.arguments[0].location, 'unknown', `${name}: arg0 location`);
    assert.equal(res.arguments[1].location, 'unknown', `${name}: arg1 must be unknown`);
    assert.equal(res.arguments[1].reason, 'preceding-argument-layout-not-proven', `${name}: arg1 reason`);
    assert.equal(res.stackArgsUnknown, true, `${name}: stackArgsUnknown must be true`);
    assert.equal(res.stackArgsMayContainPointers, true, `${name}: stackArgsMayContainPointers must be true`);
    assert.equal(res.partial, true, `${name}: partial must be true`);
    assert.equal(res.srcs.some((s) => s.reg === 'x0' && s.mustUse === true), false, `${name}: x0 must not be deterministically assigned`);
  }
});

test('7. [P1] RISC-V LP64 reflects allocationUnknown in stackArgsUnknown and stackArgsMayContainPointers', () => {
  const res = RISCV_LP64D_ABI.classifyArguments({
    callPrototype: {
      parameters: [
        { type: 'struct Opaque', aggregate: true },
        { type: 'uint64_t', bits: 64 },
      ],
    },
  });
  assert.equal(res.arguments[0].location, 'unknown');
  assert.equal(res.arguments[1].location, 'unknown');
  assert.equal(res.stackArgsUnknown, true);
  assert.equal(res.stackArgsMayContainPointers, true);
  assert.equal(res.completeness, 'partial');
});

test('8. [P1] Microsoft __vectorcall fails closed when returnResult.hiddenResultPossible === true', () => {
  const proto = {
    returnType: 'struct Big',
    returnBits: 192,
    aggregate: true,
    args: [{ type: 'uint64_t', bits: 64 }, { type: 'double', bits: 64 }],
  };
  const ret = MICROSOFT_VECTORCALL_ABI.classifyCallReturn({ callPrototype: proto });
  assert.equal(ret.hiddenResultPossible, true, 'precondition: return classification reports hiddenResultPossible');

  const res = MICROSOFT_VECTORCALL_ABI.classifyArguments({ callPrototype: proto });
  assert.equal(res.partial, true);
  assert.equal(res.stackArgsUnknown, true);
  assert.equal(res.stackArgsMayContainPointers, true);
  assert.equal(res.hiddenResultPossible, true);
  assert.equal(res.returnClassification, 'partial-hidden-result-possible');
  assert.equal(res.arguments.some((arg) => arg.mustUse === true), false, 'must not deterministically assign registers when hidden result is possible');
});

test('9. [P1] ARM64 prefetch() filters null index physicalId (xzr/wzr) from registersRead', () => {
  for (const indexReg of ['xzr', 'wzr']) {
    const res = liftArm64MemoryEffects({
      instructionId: `arm64:prfm:${indexReg}`,
      id: `arm64:prfm:${indexReg}`,
      address: 0x1000n,
      mnemonic: 'prfm',
      ops: [
        { k: 'other', text: 'pldl1keep' },
        {
          k: 'mem',
          base: 'x0',
          index: indexReg,
          ...(indexReg === 'wzr' ? { extend: { op: 'uxtw', amount: 0 } } : {}),
        },
      ],
    }, { instructionId: `arm64:prfm:${indexReg}` });

    assert.equal(res.completeness, 'exact-with-intrinsic', `prfm with ${indexReg} should be exact-with-intrinsic`);
    const intrinsicOp = res.operations.find((op) => op.kind === 'intrinsic' && op.intrinsicId === 'arm64.memory-system-prefetch-hint');
    assert.ok(intrinsicOp, 'expected prefetch intrinsic operation');
    const regsRead = intrinsicOp.effectSummary.registersRead;
    assert.deepEqual(regsRead, ['x0'], `registersRead for ${indexReg} must not include null`);
    assert.equal(regsRead.includes(null), false);
    assert.equal(regsRead.includes(undefined), false);
  }
});

test('10. [P2] ARM64 decorateArm64GcsEffects avoids bogus 0x4 write on missing address and wraps linkAddress to 64 bits', () => {
  // Case A: missing instruction.address must NOT push a bogus 0x4 memory-write
  const baseBundleNoAddr = liftArm64ControlEffects({
    instructionId: 'arm64:bl:no-addr',
    id: 'arm64:bl:no-addr',
    mnemonic: 'bl',
    address: null,
    ops: [{ k: 'imm', value: 0x1000n }],
    callTarget: 0x1000n,
  }, { instructionId: 'arm64:bl:no-addr' });
  const resNoAddr = decorateArm64GcsEffects(
    { mnemonic: 'bl', address: null },
    { gcsEnabled: true },
    baseBundleNoAddr,
  );
  assert.equal(resNoAddr.completeness, 'partial');
  assert.equal(resNoAddr.unknownEffects?.reason, 'arm64-gcs-link-address-unavailable');
  const memWritesNoAddr = resNoAddr.operations.filter((op) => op.kind === 'memory-write');
  assert.equal(memWritesNoAddr.length, 0, 'must not emit bogus 0x4 memory-write when address is null');

  // Case B: address = 0xfffffffffffffffcn wraps linkAddress + 4n -> 0n (64-bit unsigned)
  const blWrapInsn = {
    instructionId: 'arm64:bl:wrap',
    id: 'arm64:bl:wrap',
    address: 0xfffffffffffffffcn,
    mnemonic: 'bl',
    ops: [{ k: 'imm', value: 0x0n }],
    callTarget: 0x0n,
  };
  const baseWrapBundle = liftArm64ControlEffects(blWrapInsn, { instructionId: 'arm64:bl:wrap' });
  const resWrap = decorateArm64GcsEffects(blWrapInsn, { gcsEnabled: true }, baseWrapBundle);
  const gcsWrite = resWrap.operations.find(
    (op) => op.kind === 'memory-write' && op.metadata?.purpose === 'gcs-push-return-address',
  );
  assert.ok(gcsWrite, 'expected gcs-push-return-address memory-write');
  assert.equal(BigInt(gcsWrite.value.value), 0n, 'linkAddress must wrap modulo 2^64 to 0n');
});
