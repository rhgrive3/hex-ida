import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HEX_EMU_PROT,
  HEX_EMU_STOP_REASON,
  runMiniArm64Emu,
  runMiniArm64EmuWasm,
} from '../js/targets/architecture/arm64/mini-arm64-emu.js';
import {
  INSN_CLASS,
  classifyInsn,
  decodeRegUsage,
  isCallOrRet,
  isRet,
} from '../js/analysis/arm64-insn-bits.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function buildStandaloneTrackAEmuWasm() {
  const wasmPath = path.join(REPO_ROOT, 'wasm', '.tmp-trackA-emu.wasm');
  const sources = [
    'cpp/src/analysis/mini_arm64_emu.cpp',
    'cpp/src/cfg/cff_unflatten.cpp',
  ];
  const args = [
    '--target=wasm32',
    '-std=c++20',
    '-O3',
    '-nostdlib',
    '-fno-exceptions',
    '-fno-rtti',
    '-mbulk-memory',
    '-Wl,--no-entry',
    '-Wl,--export-dynamic',
    '-Icpp/include',
    ...sources,
    '-o',
    wasmPath,
  ];
  try {
    execFileSync('clang++', args, { cwd: REPO_ROOT, stdio: 'pipe' });
    const bytes = fs.readFileSync(wasmPath);
    const mod = new WebAssembly.Module(bytes);
    const imports = WebAssembly.Module.imports(mod);
    assert.equal(
      imports.length,
      0,
      `Track A standalone WASM must have 0 external imports, got ${imports.length}: ${JSON.stringify(imports)}`
    );
    return bytes;
  } finally {
    fs.rmSync(wasmPath, { force: true });
  }
}

const WASM_BYTES = buildStandaloneTrackAEmuWasm();
const { instance: WASM_INST } = await WebAssembly.instantiate(WASM_BYTES, {});
const WASM_EXPORTS = WASM_INST.exports;

function packInsns(words) {
  const buf = new Uint8Array(words.length * 4);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < words.length; i++) {
    dv.setUint32(i * 4, words[i] >>> 0, true);
  }
  return buf;
}

// ============================================================================
// ARM64 / ARM64e Instruction Encoders
// ============================================================================
const NOP = 0xd503201f;
const XPACLRI = 0xd50320ff;
const PACIAZ = 0xd503231f;
const PACIASP = 0xd503233f;
const PACIBZ = 0xd503235f;
const PACIBSP = 0xd503237f;
const AUTIAZ = 0xd503239f;
const AUTIASP = 0xd50323bf;
const AUTIBZ = 0xd50323df;
const AUTIBSP = 0xd50323ff;
const BTI = 0xd503241f;
const BTI_C = 0xd503245f;
const BTI_J = 0xd503249f;
const BTI_JC = 0xd50324df;
const RET = 0xd65f03c0;
const RETAA = 0xd65f0bff;
const RETAB = 0xd65f0fff;

const encMovz64 = (rd, imm16, hw = 0) =>
  (0xd2800000 | ((hw & 3) << 21) | ((imm16 & 0xffff) << 5) | (rd & 31)) >>> 0;
const encAddImm64 = (rd, rn, imm12) =>
  (0x91000000 | ((imm12 & 0xfff) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encSubImm64 = (rd, rn, imm12) =>
  (0xd1000000 | ((imm12 & 0xfff) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encAddReg64 = (rd, rn, rm) =>
  (0x8b000000 | ((rm & 31) << 16) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const encStp64Signed = (rt, rt2, rn, byteOff) => {
  const imm7 = (byteOff / 8) & 0x7f;
  return (0xa9000000 | (imm7 << 15) | ((rt2 & 31) << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
};
const encLdp64Signed = (rt, rt2, rn, byteOff) => {
  const imm7 = (byteOff / 8) & 0x7f;
  return (0xa9400000 | (imm7 << 15) | ((rt2 & 31) << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
};
// Unscaled 9-bit signed immediate Load/Store (GPR only):
// size: 0=8b, 1=16b, 2=32b, 3=64b
// opc:  0=STUR, 1=LDUR, 2=LDURS* (64-bit), 3=LDURS* (32-bit, size<2)
const encLdurStur = (size, opc, rt, rn, imm9) =>
  (0x38000000 |
    ((size & 3) << 30) |
    ((opc & 3) << 22) |
    ((imm9 & 0x1ff) << 12) |
    ((rn & 31) << 5) |
    (rt & 31)) >>> 0;

function runParity(words, initialRegs = {}, entryVa = 0x10000n) {
  const code = packInsns(words);
  const segs = [{ va: entryVa, bytes: code, prot: HEX_EMU_PROT.R | HEX_EMU_PROT.X }];
  const jsRes = runMiniArm64Emu(segs, [], { entryVa, initialRegs, maxSteps: 256 });
  const wasmRes = runMiniArm64EmuWasm(code, {
    entryVa,
    codeVa: entryVa,
    initialRegs,
    maxSteps: 256,
    wasmExports: WASM_EXPORTS,
  });
  assert.ok(wasmRes !== null, 'WASM emulator must execute without fallback');
  assert.equal(jsRes.stopReason, wasmRes.stopReason, 'stopReason JS/WASM parity');
  assert.equal(jsRes.stepsUsed, wasmRes.stepsUsed, 'stepsUsed JS/WASM parity');
  assert.equal(jsRes.sp, wasmRes.sp, 'SP JS/WASM parity');
  assert.deepEqual(jsRes.flags, wasmRes.flags, 'NZCV flags JS/WASM parity');
  if (jsRes.x0 !== null) {
    assert.equal(jsRes.x0, wasmRes.x0, 'X0 JS/WASM parity');
  }
  return { jsRes, wasmRes };
}

test('1. Realistic iOS arm64e PACIBSP + STP + STUR/LDUR (negative imm9) + LDURSW + AUTIBSP + RETAB parity', () => {
  const words = [
    PACIBSP,
    encSubImm64(31, 31, 32),          // sub sp, sp, #32
    encStp64Signed(29, 30, 31, 16),   // stp x29, x30, [sp, #16]
    encAddImm64(29, 31, 16),          // add x29, sp, #16
    encLdurStur(3, 0, 0, 29, -8),     // stur x0, [x29, #-8]
    encLdurStur(2, 0, 1, 29, -12),    // stur w1, [x29, #-12]
    encLdurStur(3, 1, 2, 29, -8),     // ldur x2, [x29, #-8]
    encLdurStur(2, 2, 3, 29, -12),    // ldursw x3, [x29, #-12]
    encAddReg64(0, 2, 3),             // add x0, x2, x3
    encLdp64Signed(29, 30, 31, 16),   // ldp x29, x30, [sp, #16]
    encAddImm64(31, 31, 32),          // add sp, sp, #32
    AUTIBSP,
    RETAB,
  ];
  // x0 = 100, w1 = -5 (0xfffffffb) => ldursw sign-extends to -5n => 100 + (-5) = 95
  const { jsRes, wasmRes } = runParity(words, {
    0: 100n,
    1: 0xfffffffbn,
    29: 0x1122334455667788n,
  });
  assert.equal(jsRes.stopReason, HEX_EMU_STOP_REASON.RETURN_OK);
  assert.equal(jsRes.stepsUsed, words.length);
  assert.equal(jsRes.x0, 95n);
  assert.equal(wasmRes.x0, 95n);
});

test('2. All PAC / BTI / NOP hint instructions + RETAA parity', () => {
  const words = [
    NOP,
    PACIAZ,
    PACIASP,
    PACIBZ,
    PACIBSP,
    AUTIAZ,
    AUTIASP,
    AUTIBZ,
    AUTIBSP,
    XPACLRI,
    BTI,
    BTI_C,
    BTI_J,
    BTI_JC,
    encMovz64(0, 0x1337),
    RETAA,
  ];
  const { jsRes, wasmRes } = runParity(words);
  assert.equal(jsRes.stopReason, HEX_EMU_STOP_REASON.RETURN_OK);
  assert.equal(jsRes.stepsUsed, words.length);
  assert.equal(jsRes.x0, 0x1337n);
  assert.equal(wasmRes.x0, 0x1337n);
});

test('3. LDUR/STUR widths (8/16/32/64), sign-extension (64-bit & 32-bit), and -256/+255 imm9 bounds parity', () => {
  // 3a. LDURSB X (64-bit sign extend 0x80 -> -128n)
  {
    const words = [
      encLdurStur(0, 0, 1, 31, -256),  // sturb w1, [sp, #-256]
      encLdurStur(0, 2, 0, 31, -256),  // ldursb x0, [sp, #-256]
      RET,
    ];
    const { jsRes } = runParity(words, { 1: 0x80n });
    assert.equal(jsRes.stopReason, HEX_EMU_STOP_REASON.RETURN_OK);
    assert.equal(jsRes.x0, 0xffffffffffffff80n);
  }
  // 3b. LDURSB W (32-bit sign extend 0x80 -> 0x00000000ffffff80n)
  {
    const words = [
      encLdurStur(0, 0, 1, 31, -1),    // sturb w1, [sp, #-1]
      encLdurStur(0, 3, 0, 31, -1),    // ldursb w0, [sp, #-1]
      RET,
    ];
    const { jsRes } = runParity(words, { 1: 0x80n });
    assert.equal(jsRes.stopReason, HEX_EMU_STOP_REASON.RETURN_OK);
    assert.equal(jsRes.x0, 0x00000000ffffff80n);
  }
  // 3c. LDURSH X (64-bit sign extend 0x8001) & LDURSH W (32-bit sign extend 0x8001)
  {
    const words64 = [
      encSubImm64(9, 31, 300),         // sub x9, sp, #300
      encLdurStur(1, 0, 1, 9, 255),    // sturh w1, [x9, #255]
      encLdurStur(1, 2, 0, 9, 255),    // ldursh x0, [x9, #255]
      RET,
    ];
    const { jsRes: r64 } = runParity(words64, { 1: 0x8001n });
    assert.equal(r64.x0, 0xffffffffffff8001n);

    const words32 = [
      encSubImm64(9, 31, 300),         // sub x9, sp, #300
      encLdurStur(1, 0, 1, 9, 255),    // sturh w1, [x9, #255]
      encLdurStur(1, 3, 0, 9, 255),    // ldursh w0, [x9, #255]
      RET,
    ];
    const { jsRes: r32 } = runParity(words32, { 1: 0x8001n });
    assert.equal(r32.x0, 0x00000000ffff8001n);
  }
  // 3d. Zero-extending LDURB / LDURH / LDUR W
  {
    const words = [
      encLdurStur(2, 0, 1, 31, -16),   // stur w1, [sp, #-16]
      encLdurStur(0, 1, 2, 31, -16),   // ldurb w2, [sp, #-16] (0xff)
      encLdurStur(1, 1, 3, 31, -16),   // ldurh w3, [sp, #-16] (0xfeff)
      encLdurStur(2, 1, 4, 31, -16),   // ldur w4, [sp, #-16] (0x8000feff)
      encAddReg64(0, 2, 3),
      encAddReg64(0, 0, 4),
      RET,
    ];
    const { jsRes } = runParity(words, { 1: 0xdeadbeef8000feffn });
    assert.equal(jsRes.x0, 0xffn + 0xfeffn + 0x8000feffn);
  }
});

test('4. Rejects PRFUM, unallocated opc=3 (size>=2), and OOB LDUR identically in JS and WASM', () => {
  // PRFUM (size=3, opc=2)
  {
    const { jsRes } = runParity([encLdurStur(3, 2, 0, 31, 0), RET]);
    assert.equal(jsRes.stopReason, HEX_EMU_STOP_REASON.UNSUPPORTED_INSN);
  }
  // Unallocated opc=3, size=2
  {
    const { jsRes } = runParity([encLdurStur(2, 3, 0, 31, 0), RET]);
    assert.equal(jsRes.stopReason, HEX_EMU_STOP_REASON.UNSUPPORTED_INSN);
  }
  // Unallocated opc=3, size=3
  {
    const { jsRes } = runParity([encLdurStur(3, 3, 0, 31, 0), RET]);
    assert.equal(jsRes.stopReason, HEX_EMU_STOP_REASON.UNSUPPORTED_INSN);
  }
  // OOB LDUR read from unmapped address
  {
    const { jsRes } = runParity([encLdurStur(3, 1, 0, 1, -8), RET], { 1: 0x100n });
    assert.equal(jsRes.stopReason, HEX_EMU_STOP_REASON.UNINIT_READ);
  }
});

test('5. arm64-insn-bits.js recognizes RETAA and RETAB across isRet, isCallOrRet, classifyInsn, and decodeRegUsage', () => {
  for (const insn of [RET, RETAA, RETAB]) {
    assert.equal(isRet(insn), true, `isRet(0x${insn.toString(16)})`);
    assert.equal(isCallOrRet(insn), true, `isCallOrRet(0x${insn.toString(16)})`);
    assert.equal(classifyInsn(insn), INSN_CLASS.UNCOND_BR, `classifyInsn(0x${insn.toString(16)})`);
    const ru = decodeRegUsage(insn);
    assert.equal(ru.isRet, true, `decodeRegUsage(0x${insn.toString(16)}).isRet`);
    assert.equal(ru.isCall, false);
    assert.equal(ru.isBranch, false);
  }
  assert.equal(isRet(NOP), false);
  assert.equal(isRet(PACIBSP), false);
  assert.equal(isRet(AUTIBSP), false);
  assert.equal(isCallOrRet(PACIBSP), false);
});
