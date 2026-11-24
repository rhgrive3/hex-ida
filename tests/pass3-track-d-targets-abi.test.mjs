import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { buildIR, OP } from '../js/ir.js';
import { createInstructionId } from '../js/core/identity/index.js';
import { liftArm64MachineEffects } from '../js/targets/architecture/arm64/effects/index.js';
import { liftArm64eEffects } from '../js/targets/architecture/arm64e/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../js/semantics/ir/from-machine-effects.js';
import { MICROSOFT_VECTORCALL_ABI } from '../js/targets/abi/microsoft-vectorcall.js';
import { classifyDarwinArm64Arguments } from '../js/targets/abi/darwin-arm64.js';
import { classifySysVAMD64Arguments } from '../js/targets/abi/sysv-amd64.js';
import { classifyMicrosoftX64Arguments, typeBits as msX64TypeBits } from '../js/targets/abi/microsoft-x64.js';

const BASE = 0x100000000n;
function irOf(lines) {
  const rows = lines.map((line, i) => {
    const s = String(line).trim();
    const p = s.indexOf(' ');
    return {
      row: i,
      address: BASE + BigInt(i * 4),
      mn: p < 0 ? s : s.slice(0, p),
      ops: p < 0 ? '' : s.slice(p + 1),
    };
  });
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  const model = buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
  return buildIR(model, { rowOfAddress, semanticMigrationMode: 'legacy-v1' });
}

test('P3-S03-002: zero-offset ARM64 loads/stores and pairs get disp 0n and preserve Memory SSA', () => {
  const ir = irOf([
    'sub sp, sp, #0x20',
    'mov x0, #42',
    'str x0, [sp, #0x10]',
    'mov x1, #7',
    'str x1, [sp]',
    'ldr x2, [sp]',
    'ldr x3, [sp, #0x10]',
    'ldp x29, x30, [sp]',
    'ldr x4, [x19, x20]',
    'ret',
  ]);

  const strZero = ir.instructions.find((i) => i.op === OP.STORE && i.row === 4);
  const ldrZero = ir.instructions.find((i) => i.op === OP.LOAD && i.row === 5);
  const ldr16 = ir.instructions.find((i) => i.op === OP.LOAD && i.row === 6);
  const ldpPair = ir.instructions.filter((i) => i.op === OP.LOAD && i.row === 7);
  const ldrIndexed = ir.instructions.find((i) => i.op === OP.LOAD && i.row === 8);

  assert.equal(strZero?.addr?.disp, 0n);
  assert.equal(ldrZero?.addr?.disp, 0n);
  assert.notEqual(strZero?.loc?.kind, 'unknown', 'zero-offset store must not be classified as MK.UNKNOWN');
  assert.equal(ldrZero?.reachingStore?.row, 4, 'ldr x2, [sp] must reach str x1, [sp]');
  assert.equal(ldrZero?.dst?.const, 7n);
  assert.equal(ldr16?.reachingStore?.row, 2, 'zero-offset store to [sp] must not clobber [sp, #0x10]');
  assert.equal(ldr16?.dst?.const, 42n);

  assert.equal(ldpPair.length, 2);
  assert.equal(ldpPair[0].addr.disp, 0n);
  assert.equal(ldpPair[1].addr.disp, 8n);

  assert.equal(ldrIndexed?.addr?.disp, null, 'indexed memory access without immediate disp keeps disp null');
});

test('P3-S09-001: ARM64e authenticated indirect branches lower via indirect control path with SSA target input', () => {
  for (const [mnemonic, opStr] of [
    ['braa', 'x1, x2'],
    ['brab', 'x1, sp'],
    ['braaz', 'x1'],
    ['brabz', 'x1'],
  ]) {
    const address = 0x2000n;
    const bundle = liftArm64eEffects({
      mnemonic,
      opStr,
      address,
      instructionId: createInstructionId({
        binaryId: 'bin_pass3_track_d',
        sliceId: 'slice_pass3_track_d',
        virtualAddress: address,
        decodeMode: 'arm64e',
        decoderSemanticVersion: `pass3-track-d-${mnemonic}`,
      }),
    });
    assert.equal(bundle.controlEffect.kind, 'branch', `${mnemonic} keeps arm64e effects contract`);
    assert.equal(bundle.metadata?.indirect, true);

    const lowered = lowerMachineEffectBundleToSemanticIr(bundle, {
      functionId: 'fn_arm64e_indirect',
      blockId: 'bb_0x2000',
    });
    const ctrlNode = lowered.nodes.find((n) => n.kind === 'unknown-control-effect');
    const directBranch = lowered.nodes.find((n) => n.kind === 'branch');
    assert.equal(directBranch, undefined, `${mnemonic} must not lower as a static direct branch`);
    assert.ok(ctrlNode, `${mnemonic} must lower through indirect control path`);
    assert.equal(ctrlNode.inputs.length, 1, `${mnemonic} must preserve SSA dependency on authenticated target`);
    assert.equal(ctrlNode.unknown?.reason, 'unresolved-indirect-control-flow');
    assert.deepEqual(ctrlNode.attributes?.indirectControl?.targetValueIds, ctrlNode.inputs);
  }

  // Static direct branch must remain unaffected.
  const directBundle = liftArm64MachineEffects({
    mnemonic: 'b',
    ops: [{ k: 'imm', value: 0x2010n }],
    branchTarget: 0x2010n,
    address: 0x2000n,
    instructionId: createInstructionId({
      binaryId: 'bin_pass3_track_d',
      sliceId: 'slice_pass3_track_d',
      virtualAddress: 0x2000n,
      decodeMode: 'arm64',
      decoderSemanticVersion: 'pass3-track-d-direct-b',
    }),
  });
  const loweredDirect = lowerMachineEffectBundleToSemanticIr(directBundle, {
    functionId: 'fn_arm64_direct',
    blockId: 'bb_0x2000',
  });
  const branchNode = loweredDirect.nodes.find((n) => n.kind === 'branch');
  assert.ok(branchNode, 'static direct branch must still lower to kind branch');
  assert.equal(branchNode.inputs.length, 0);
});

test('P3-S08-001: MICROSOFT_VECTORCALL_ABI.classifyEntryRegister recognizes ymm0-ymm5 and xmm0-xmm5', () => {
  for (let i = 0; i < 6; i++) {
    assert.deepEqual(
      MICROSOFT_VECTORCALL_ABI.classifyEntryRegister(`ymm${i}`),
      { kind: 'argument', reg: `ymm${i}`, index: i, abiClass: 'fp-or-vector' },
    );
    assert.deepEqual(
      MICROSOFT_VECTORCALL_ABI.classifyEntryRegister(`YMM${i}`),
      { kind: 'argument', reg: `ymm${i}`, index: i, abiClass: 'fp-or-vector' },
    );
    assert.deepEqual(
      MICROSOFT_VECTORCALL_ABI.classifyEntryRegister(`xmm${i}`),
      { kind: 'argument', reg: `xmm${i}`, index: i, abiClass: 'fp-or-vector' },
    );
  }
  assert.equal(MICROSOFT_VECTORCALL_ABI.classifyEntryRegister('ymm6').kind, 'incoming-register-state');
  assert.equal(MICROSOFT_VECTORCALL_ABI.classifyEntryRegister('xmm6').kind, 'incoming-register-state');
});

test('P3-S08-002: Darwin ARM64 does not mark 1-byte/2-byte register aggregates as callerExtended', () => {
  const result = classifyDarwinArm64Arguments({
    callPrototype: {
      args: [
        {
          type: 'struct pair_u8',
          bits: 16,
          aggregate: true,
          layout: {
            bytes: 2,
            alignmentBytes: 1,
            fields: [
              { offset: 0, bits: 8, type: 'uint8_t' },
              { offset: 1, bits: 8, type: 'uint8_t' },
            ],
          },
        },
        {
          type: 'struct single_i8',
          bits: 8,
          aggregate: true,
          signed: true,
          layout: {
            bytes: 1,
            alignmentBytes: 1,
            fields: [{ offset: 0, bits: 8, type: 'int8_t' }],
          },
        },
        { type: 'uint8_t', bits: 8, signed: false },
        { type: 'int16_t', bits: 16, signed: true },
      ],
    },
  });

  assert.equal(result.arguments[0].location, 'register');
  assert.equal(result.arguments[0].aggregate, true);
  assert.equal(result.arguments[0].callerExtended, undefined);
  assert.equal(result.arguments[0].extension, undefined);

  assert.equal(result.arguments[1].location, 'register');
  assert.equal(result.arguments[1].aggregate, true);
  assert.equal(result.arguments[1].callerExtended, undefined);
  assert.equal(result.arguments[1].extension, undefined);

  assert.equal(result.arguments[2].callerExtended, true);
  assert.equal(result.arguments[2].extension, 'zero-extend-to-32');
  assert.equal(result.arguments[3].callerExtended, true);
  assert.equal(result.arguments[3].extension, 'sign-extend-to-32');
});

test('P3-S09-002: SysV AMD64 parameterClass classifies __m128/__m256/__m512 as vector arguments', () => {
  const res128 = classifySysVAMD64Arguments(
    { callPrototype: { args: [{ type: '__m128' }, { type: '__m128i' }, { type: '__m128d' }] } },
    {},
  );
  assert.deepEqual(
    res128.arguments.map((a) => a.reg),
    ['xmm0', 'xmm1', 'xmm2'],
  );

  const resWide = classifySysVAMD64Arguments(
    { callPrototype: { args: [{ type: '__m256' }, { type: '__m512i' }, { type: '__m256d' }] } },
    { targetProfile: { avx: true, avx512: true } },
  );
  assert.equal(resWide.arguments[0].reg, 'ymm0');
  assert.equal(resWide.arguments[0].bits, 256);
  assert.equal(resWide.arguments[1].reg, 'zmm1');
  assert.equal(resWide.arguments[1].bits, 512);
  assert.equal(resWide.arguments[2].reg, 'ymm2');
  assert.equal(resWide.arguments[2].bits, 256);
});

test('P3-S09-003: SysV AMD64 and Microsoft x64 typeBits resolve stdint _t fixed-width integer types', () => {
  const sysv = classifySysVAMD64Arguments(
    {
      callPrototype: {
        args: [
          { type: 'int8_t' },
          { type: 'uint8_t' },
          { type: 'int16_t' },
          { type: 'uint16_t' },
          { type: 'int32_t' },
          { type: 'uint32_t' },
        ],
      },
    },
    {},
  );
  assert.deepEqual(
    sysv.arguments.map((a) => a.bits),
    [8, 8, 16, 16, 32, 32],
  );

  assert.equal(msX64TypeBits('int8_t'), 8);
  assert.equal(msX64TypeBits('uint8_t'), 8);
  assert.equal(msX64TypeBits('int16_t'), 16);
  assert.equal(msX64TypeBits('uint16_t'), 16);
  assert.equal(msX64TypeBits('int32_t'), 32);
  assert.equal(msX64TypeBits('uint32_t'), 32);
  assert.equal(msX64TypeBits('int64_t'), 64);
  assert.equal(msX64TypeBits('uint64_t'), 64);
  assert.equal(msX64TypeBits('long long'), 64);
  assert.equal(msX64TypeBits('long'), 32);

  const ms = classifyMicrosoftX64Arguments(
    {
      callPrototype: {
        args: [
          { type: 'uint8_t' },
          { type: 'int16_t' },
          { type: 'uint32_t' },
          { type: 'int64_t' },
        ],
      },
    },
    {},
  );
  assert.deepEqual(
    ms.arguments.map((a) => a.bits),
    [8, 16, 32, 64],
  );
});
