import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { getHexEngineExports } from '../js/core/hex-engine-wasm.js';
import {
  HEX_OK,
  wasmDecompileArm64Function,
  resetHexEngineForTest,
} from '../js/core/hex-engine-bridge.js';

function encodeWords(words) {
  const buf = new Uint8Array(words.length * 4);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < words.length; i += 1) {
    dv.setUint32(i * 4, words[i] >>> 0, true);
  }
  return buf;
}

function runEmu(ex, words, { initRegs = {}, mutateState = null, stackInit = null } = {}) {
  const base = ex.hex_deobf_scratch_ptr();
  const statePtr = base;
  const codePtr = (base + 0x1138 + 7) & ~7;
  const codeBytes = encodeWords(words);
  new Uint8Array(ex.memory.buffer).set(codeBytes, codePtr);

  const entryVa = 0x10000n;
  const initSt = ex.hex_arm64_emu_init(statePtr, entryVa, entryVa, codeBytes.length, 64);
  assert.equal(initSt, HEX_OK);

  const dv = new DataView(ex.memory.buffer);
  for (const [reg, val] of Object.entries(initRegs)) {
    const idx = Number(reg);
    if (idx === 31) {
      dv.setBigUint64(statePtr + 0xf8, BigInt.asUintN(64, BigInt(val)), true);
    } else {
      dv.setBigUint64(statePtr + idx * 8, BigInt.asUintN(64, BigInt(val)), true);
    }
  }
  if (stackInit) {
    const stackOff = statePtr + 0x138;
    for (const [off, byteVal] of stackInit) {
      dv.setUint8(stackOff + off, byteVal & 0xff);
    }
  }
  if (mutateState) mutateState(dv, statePtr);

  const runSt = ex.hex_arm64_emu_run(statePtr, codePtr, codeBytes.length);
  return {
    status: runSt,
    x0: dv.getBigUint64(statePtr + 0, true),
    x1: dv.getBigUint64(statePtr + 8, true),
    sp: dv.getBigUint64(statePtr + 0xf8, true),
    faultCode: dv.getUint32(statePtr + 0x114, true),
    stackBytes: new Uint8Array(ex.memory.buffer, statePtr + 0x138, 0x1000).slice(),
  };
}

test('WASM artifact invariants: 0 external imports and within raw/gzip size budgets', () => {
  const wasmBytes = fs.readFileSync(new URL('../wasm/hex_engine.wasm', import.meta.url));
  const mod = new WebAssembly.Module(wasmBytes);
  assert.deepEqual(WebAssembly.Module.imports(mod), []);
  const maxRaw = Math.floor(1.40 * 1024 * 1024);
  const maxGzip = 520 * 1024;
  const gzipLen = gzipSync(wasmBytes, { level: 9 }).length;
  assert.ok(wasmBytes.length <= maxRaw, `raw ${wasmBytes.length} > ${maxRaw}`);
  assert.ok(gzipLen <= maxGzip, `gzip ${gzipLen} > ${maxGzip}`);
});

test('mini_arm64_emu: sign-extending loads unified across unsigned-offset, pre/post-index, and register-offset', () => {
  const ex = getHexEngineExports();
  assert.ok(ex, 'WASM exports must be available');
  const STACK_BASE = 0x00007fff0000f000n;
  const RET = 0xd65f03c0;

  // Stack data at offset 0x00: 0x80 (-128), 0x00, 0xFE, 0xFF (-2 as i16), 0xFC, 0xFF, 0xFF, 0xFF (-4 as i32)
  const stackInit = [
    [0, 0x80], [1, 0x00],
    [2, 0xfe], [3, 0xff],
    [4, 0xfc], [5, 0xff], [6, 0xff], [7, 0xff],
  ];

  // 1. Unsigned offset: LDRSH W0, [SP, #2] (size=1, opc=3, imm12=1 -> 0x79C007E0)
  {
    const insn = (1 << 30) | 0x39000000 | (3 << 22) | (1 << 10) | (31 << 5) | 0;
    const r = runEmu(ex, [insn, RET], { initRegs: { 31: STACK_BASE }, stackInit });
    assert.equal(r.faultCode, 1);
    assert.equal(r.x0, 0xfffffffen); // 32-bit sign-extended -2 zero-extended to X0
  }

  // 2. Pre-index: LDRSW X0, [X1, #4]! (size=2, opc=2, imm9=4, mode=3 -> 0xB8804C20)
  {
    const insn = (2 << 30) | 0x38000c00 | (2 << 22) | (4 << 12) | (1 << 5) | 0;
    const r = runEmu(ex, [insn, RET], { initRegs: { 1: STACK_BASE }, stackInit });
    assert.equal(r.faultCode, 1);
    assert.equal(r.x0, 0xfffffffffffffffcn); // 64-bit sign-extended -4
    assert.equal(r.x1, STACK_BASE + 4n);
  }

  // 3. Post-index: LDRSB W0, [X1], #1 (size=0, opc=3, imm9=1, mode=1 -> 0x38C01420)
  {
    const insn = (0 << 30) | 0x38000400 | (3 << 22) | (1 << 12) | (1 << 5) | 0;
    const r = runEmu(ex, [insn, RET], { initRegs: { 1: STACK_BASE }, stackInit });
    assert.equal(r.faultCode, 1);
    assert.equal(r.x0, 0xffffff80n); // 32-bit sign-extended -128
    assert.equal(r.x1, STACK_BASE + 1n);
  }

  // 4. Register offset: LDRSH W0, [SP, X2] (size=1, opc=3, Rm=2, opt=3(LSL), S=0, Rn=31, Rt=0)
  {
    const insn = (1 << 30) | 0x38200800 | (3 << 22) | (2 << 16) | (3 << 13) | (31 << 5) | 0;
    const r = runEmu(ex, [insn, RET], { initRegs: { 31: STACK_BASE, 2: 2n }, stackInit });
    assert.equal(r.faultCode, 1);
    assert.equal(r.x0, 0xfffffffen);
  }

  // 5. Reject unallocated (size=2, opc=3) and PRFM (size=3, opc=2) with UNSUPPORTED_INSN (5)
  {
    const unalloc = (2 << 30) | 0x39000000 | (3 << 22) | (31 << 5) | 0;
    const r1 = runEmu(ex, [unalloc, RET], { initRegs: { 31: STACK_BASE } });
    assert.equal(r1.faultCode, 5);

    const prfmPre = (3 << 30) | 0x38000c00 | (2 << 22) | (1 << 5) | 0;
    const r2 = runEmu(ex, [prfmPre, RET], { initRegs: { 1: STACK_BASE } });
    assert.equal(r2.faultCode, 5);
  }
});

test('mini_arm64_emu: STP prevents partial write on OOB, LDP blocks wraparound, and stack_top corruption cannot OOB', () => {
  const ex = getHexEngineExports();
  const STACK_BASE = 0x00007fff0000f000n;
  const STACK_TOP = 0x00007fff00010000n;
  const RET = 0xd65f03c0;

  // 1. STP X0, X1, [SP, #0] when SP = STACK_TOP - 8 (1st word in bounds, 2nd word OOB)
  // Must fault MEM_OOB (4) AND leave the last 8 bytes of stack untouched (0xAA sentinel)
  const stpX0X1Sp = 0xa90007e0; // stp x0, x1, [sp]
  const sentinelInit = Array.from({ length: 8 }, (_, i) => [0xff8 + i, 0xaa]);
  const rStp = runEmu(ex, [stpX0X1Sp, RET], {
    initRegs: { 0: 0x1122334455667788n, 1: 0x99aabbccddeeff00n, 31: STACK_TOP - 8n },
    stackInit: sentinelInit,
  });
  assert.equal(rStp.faultCode, 4, 'STP straddling stack_top must fault MEM_OOB');
  for (let i = 0; i < 8; i += 1) {
    assert.equal(rStp.stackBytes[0xff8 + i], 0xaa, `byte ${i} must not be partially overwritten`);
  }

  // 2. LDP X0, X1, [X2, #0] when X2 = 0xFFFFFFFFFFFFFFFC (addr + width wraps around 64-bit)
  const ldpX0X1X2 = 0xa9400440; // ldp x0, x1, [x2]
  const rLdp = runEmu(ex, [ldpX0X1X2, RET], { initRegs: { 2: 0xfffffffffffffffcn } });
  assert.equal(rLdp.faultCode, 4, 'LDP with 64-bit wraparound must fault MEM_OOB');

  // 3. Corrupted stack_top > stack_base + 4096 must NOT allow OOB write beyond s->stack[4096]
  const strX0X1 = 0xf9000020; // str x0, [x1]
  const rCorrupt = runEmu(ex, [strX0X1, RET], {
    initRegs: { 0: 0xdeadbeefn, 1: STACK_BASE + 0x1000n },
    mutateState: (dv, statePtr) => {
      dv.setBigUint64(statePtr + 0x130, STACK_BASE + 0x4000n, true); // corrupt stack_top
    },
  });
  assert.equal(rCorrupt.faultCode, 4, 'Corrupted stack_top must be clamped by HEX_ARM64_EMU_STACK_SIZE');
});

test('swift_demangle_wasm: handles valid symbols and adversarial/oversized inputs safely without trapping', () => {
  const ex = getHexEngineExports();
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function callDemangle(sym) {
    const bytes = enc.encode(sym);
    const inPtr = ex.hex_demangle_in_buf_ptr() >>> 0;
    const inCap = ex.hex_demangle_in_buf_cap() >>> 0;
    const outPtr = ex.hex_demangle_out_buf_ptr() >>> 0;
    const outCap = ex.hex_demangle_out_buf_cap() >>> 0;
    const outLenPtr = ex.hex_demangle_out_len_ptr() >>> 0;
    const writeLen = Math.min(bytes.length, inCap);
    new Uint8Array(ex.memory.buffer, inPtr, writeLen).set(bytes.subarray(0, writeLen));
    const status = ex.hex_demangle_symbol(inPtr, bytes.length, outPtr, outCap, outLenPtr);
    const outLen = new DataView(ex.memory.buffer).getUint32(outLenPtr, true);
    const text = outLen > 0 ? dec.decode(new Uint8Array(ex.memory.buffer, outPtr, outLen)) : '';
    return { status, text };
  }

  // Valid Swift symbol
  const ok = callDemangle('$s4main3fooyyF');
  assert.equal(ok.status, HEX_OK);
  assert.match(ok.text, /main\.foo\(\)/);

  // Oversized Swift symbol (> kMaxSwiftInputLen = 2048) -> clean error, no trap
  const oversized = '$s' + 'A'.repeat(2500);
  const resOver = callDemangle(oversized);
  assert.notEqual(resOver.status, HEX_OK);

  // Deeply nested / malformed Swift mangled input -> clean return, no trap or infinite loop
  const malformed = '$s' + 'Say'.repeat(200) + 'G'.repeat(200);
  const resBad = callDemangle(malformed);
  assert.ok(typeof resBad.status === 'number');
});

test('ASRV under JS parity mode emits signed arithmetic right shift (not unsigned SHR)', () => {
  resetHexEngineForTest();
  // asrv x0, x0, x1 (0x9AC12800); ret (0xD65F03C0)
  const res = wasmDecompileArm64Function({
    words: [0x9ac12800, 0xd65f03c0],
    baseAddr: 0x1000n,
    funcName: 'asr_test',
  });
  assert.ok(res && typeof res.pseudocode === 'string', 'ASRV decompile should succeed via arm64_general_emit');
  assert.match(res.pseudocode, /\(int64_t\)/, 'ASRV must emit signed int64_t shift');
  assert.match(res.pseudocode, />>/, 'ASRV must emit right shift');
});

test('wasmDecompileArm64Function: propagates rawLossFlags & 2 (unknown-call-arguments) and handles 8192-word boundary', () => {
  const ex = getHexEngineExports();

  // 1. Direct WASM boundary check: 8192 words accepted, 8193 words -> HEX_ERR_RESOURCE_LIMIT (3)
  ex.hex_engine_scratch_reset();
  const nOk = 8192;
  const ptrOk = ex.hex_engine_scratch_alloc(nOk * 4);
  assert.ok(ptrOk);
  const viewOk = new Uint32Array(ex.memory.buffer, ptrOk, nOk);
  viewOk.fill(0xd503201f); // NOP
  viewOk[nOk - 1] = 0xd65f03c0; // RET
  const st8192 = ex.hex_engine_decompile_arm64(ptrOk, nOk, 0x1000n, 0, 0, 1);
  assert.equal(st8192, HEX_OK, '8192-word function must succeed');

  ex.hex_engine_scratch_reset();
  const nOver = 8193;
  const ptrOver = ex.hex_engine_scratch_alloc(nOver * 4);
  assert.ok(ptrOver);
  const viewOver = new Uint32Array(ex.memory.buffer, ptrOver, nOver);
  viewOver.fill(0xd503201f);
  viewOver[nOver - 1] = 0xd65f03c0;
  const st8193 = ex.hex_engine_decompile_arm64(ptrOver, nOver, 0x1000n, 0, 0, 1);
  assert.equal(st8193, 3, '8193-word function must return HEX_ERR_RESOURCE_LIMIT (3)');

  // 2. Indirect call / external BL triggers rawLossFlags & 2 (unknown-call-arguments)
  // bl #0x2000 (pc=0x1000 -> delta=+0x1000 -> imm26=0x400 -> 0x94000400); ret
  const resCall = wasmDecompileArm64Function({
    words: [0xa9bf7bfd, 0x910003fd, 0x94000400, 0xa8c17bfd, 0xd65f03c0],
    baseAddr: 0x1000n,
    funcName: 'caller_loss_test',
  });
  assert.ok(resCall && typeof resCall.pseudocode === 'string');
  assert.equal((resCall.lossFlags & 2) !== 0, true, 'lossFlags bit 2 must be set for unknown call args');
  assert.ok(resCall.lossReasons.includes('unknown-call-arguments'));
});

test('findRodataSlice: R_AARCH64_RELATIVE relocation with addend >= 2^63 does not throw RangeError', () => {
  // Build a minimal valid ELF64 LE file with .shstrtab, .rodata, and .rela.dyn containing addend = 0x8000000000001000n
  const totalSize = 0x500;
  const elf = new Uint8Array(totalSize);
  const dv = new DataView(elf.buffer);

  // ELF64 header
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0); // EI_MAG, ELFCLASS64, ELFDATA2LSB, EV_CURRENT
  dv.setUint16(16, 3, true); // ET_DYN
  dv.setUint16(18, 183, true); // EM_AARCH64
  dv.setUint32(20, 1, true);
  dv.setBigUint64(40, 0x300n, true); // e_shoff
  dv.setUint16(52, 64, true); // e_ehsize
  dv.setUint16(58, 64, true); // e_shentsize
  dv.setUint16(60, 4, true); // e_shnum (NULL, .shstrtab, .rodata, .rela.dyn)
  dv.setUint16(62, 1, true); // e_shstrndx

  // .shstrtab at 0x100
  const shstr = '\0.shstrtab\0.rodata\0.rela.dyn\0';
  const shstrBytes = new TextEncoder().encode(shstr);
  elf.set(shstrBytes, 0x100);

  // .rodata at 0x200, va=0x20000, size=64
  // .rela.dyn at 0x280, size=24 (1 Elf64_Rela entry)
  dv.setBigUint64(0x280, 0x20000n, true); // r_offset inside .rodata
  dv.setBigUint64(0x288, 1027n, true); // R_AARCH64_RELATIVE
  dv.setBigUint64(0x290, 0x8000000000001000n, true); // r_addend >= 2^63

  // Section headers at 0x300 (4 * 64 bytes)
  const writeShdr = (idx, nameOff, type, addr, off, size, entsize = 0n) => {
    const base = 0x300 + idx * 64;
    dv.setUint32(base + 0, nameOff, true);
    dv.setUint32(base + 4, type, true);
    dv.setBigUint64(base + 16, addr, true);
    dv.setBigUint64(base + 24, off, true);
    dv.setBigUint64(base + 32, size, true);
    dv.setBigUint64(base + 56, entsize, true);
  };
  writeShdr(1, 1, 3, 0n, 0x100n, BigInt(shstrBytes.length)); // .shstrtab (SHT_STRTAB)
  writeShdr(2, 11, 1, 0x20000n, 0x200n, 64n); // .rodata (SHT_PROGBITS)
  writeShdr(3, 19, 4, 0x20280n, 0x280n, 24n, 24n); // .rela.dyn (SHT_RELA)

  // Function with indirect branch (`br x0`) so wasmDecompileArm64Function invokes findRodataSlice
  const res = wasmDecompileArm64Function({
    words: [0xd61f0000],
    baseAddr: 0x1000n,
    funcName: 'reloc_high_addend_test',
    fileBytes: elf,
  });
  assert.ok(res && typeof res.pseudocode === 'string', 'High-bit R_AARCH64_RELATIVE addend must not throw RangeError');
});
