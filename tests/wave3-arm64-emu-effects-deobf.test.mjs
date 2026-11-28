import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HEX_EMU_DEFAULT_SP,
  HEX_EMU_PAGE_SIZE,
  HEX_EMU_PROT,
  HEX_EMU_SPAN_KIND,
  HEX_EMU_STOP_REASON,
  HEX_EMU_STUB_KIND,
  MiniArm64Emu,
  runMiniArm64Emu,
  runMiniArm64EmuWasm,
} from '../js/targets/architecture/arm64/mini-arm64-emu.js';
import {
  DEOBF_EVAL_KIND,
  OPAQUE_PREDICATE_RESULT,
  evalArm64Deobf,
} from '../js/targets/architecture/arm64/deobf-eval-arm64.js';
import {
  ARM64E_EFFECTS_MEMORY_SEMANTIC_VERSION,
  liftArm64eAuthenticatedLoadEffects,
} from '../js/targets/architecture/arm64e/effects-memory.js';

function u32WordsToBytes(words) {
  const out = new Uint8Array(words.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < words.length; i++) {
    dv.setUint32(i * 4, words[i] >>> 0, true);
  }
  return out;
}

// =============================================================================
// 1. MiniArm64Emu: 2-bit opc on unsigned-offset & pre/post-index LDR/STR
// =============================================================================
test('MiniArm64Emu unsigned-offset LDRSB/LDRSH/LDRSW (opc=2,3) sign-extend without corrupting memory, PRFM/unalloc stop', () => {
  const data = new Uint8Array([
    0x80, 0x00, 0x00, 0x00, // +0: -128 (i8)
    0x00, 0x80, 0x00, 0x00, // +4: -32768 (i16)
    0x00, 0x00, 0x00, 0x80, // +8: -2147483648 (i32)
  ]);

  // ldrsb x0, [x1, #0]  (size=0, opc=2): 0x39800020
  // ldrsh x2, [x1, #4]  (size=1, opc=2, imm12=2): 0x79800822
  // ldrsw x3, [x1, #8]  (size=2, opc=2, imm12=2): 0xb9800823
  // ldrsb w4, [x1, #0]  (size=0, opc=3): 0x39c00024
  // ldrsh w5, [x1, #4]  (size=1, opc=3, imm12=2): 0x79c00825
  // ret
  const code = u32WordsToBytes([
    0x39800020,
    0x79800822,
    0xb9800823,
    0x39c00024,
    0x79c00825,
    0xd65f03c0,
  ]);

  const emu = new MiniArm64Emu([
    { va: 0x10000n, bytes: code, prot: HEX_EMU_PROT.R | HEX_EMU_PROT.X },
    { va: 0x20000n, bytes: data, prot: HEX_EMU_PROT.R | HEX_EMU_PROT.W },
  ], [], {
    entryVa: 0x10000n,
    initialRegs: { 0: 0x11111111n, 1: 0x20000n, 2: 0x22222222n, 3: 0x33333333n },
  });
  const res = emu.run();
  assert.equal(res.stopReason, HEX_EMU_STOP_REASON.RETURN_OK);
  assert.equal(res.x0, 0xffffffffffffff80n);
  assert.equal(emu.getGpr(2), 0xffffffffffff8000n);
  assert.equal(emu.getGpr(3), 0xffffffff80000000n);
  assert.equal(emu.getGpr(4), 0xffffff80n);
  assert.equal(emu.getGpr(5), 0xffff8000n);
  assert.equal(res.cowPagesUsed, 0, 'signed loads must NEVER write to memory');

  // PRFM (size=3, opc=2): 0xf9800020 -> UNSUPPORTED_INSN, no memory write
  const prfmRes = runMiniArm64Emu([
    { va: 0x10000n, bytes: u32WordsToBytes([0xf9800020, 0xd65f03c0]), prot: HEX_EMU_PROT.R | HEX_EMU_PROT.X },
    { va: 0x20000n, bytes: data, prot: HEX_EMU_PROT.R | HEX_EMU_PROT.W },
  ], [], { entryVa: 0x10000n, initialRegs: { 0: 0xdeadbeefn, 1: 0x20000n } });
  assert.equal(prfmRes.stopReason, HEX_EMU_STOP_REASON.UNSUPPORTED_INSN);
  assert.equal(prfmRes.cowPagesUsed, 0);

  // Unallocated unsigned-offset (size=2, opc=3): 0xb9c00020 -> UNSUPPORTED_INSN
  const unallocRes = runMiniArm64Emu([
    { va: 0x10000n, bytes: u32WordsToBytes([0xb9c00020, 0xd65f03c0]), prot: HEX_EMU_PROT.R | HEX_EMU_PROT.X },
    { va: 0x20000n, bytes: data, prot: HEX_EMU_PROT.R | HEX_EMU_PROT.W },
  ], [], { entryVa: 0x10000n, initialRegs: { 1: 0x20000n } });
  assert.equal(unallocRes.stopReason, HEX_EMU_STOP_REASON.UNSUPPORTED_INSN);
});

test('MiniArm64Emu pre/post-index LDRSB/LDRSH/LDRSW (opc=2,3) sign-extend and update base without corrupting memory', () => {
  const data = new Uint8Array([0xfe, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x80]);
  // ldrsb x0, [x1], #2    (size=0, opc=2, simm9=2, post=01): 0x38802420
  // ldrsh w2, [x1], #2    (size=1, opc=3, simm9=2, post=01): 0x78c02422
  // ldrsw x3, [x1, #0]!   (size=2, opc=2, simm9=0, pre=11):  0xb8800c23
  // ret
  const code = u32WordsToBytes([
    0x38802420,
    0x78c02422,
    0xb8800c23,
    0xd65f03c0,
  ]);
  const emu = new MiniArm64Emu([
    { va: 0x10000n, bytes: code, prot: HEX_EMU_PROT.R | HEX_EMU_PROT.X },
    { va: 0x20000n, bytes: data, prot: HEX_EMU_PROT.R | HEX_EMU_PROT.W },
  ], [], {
    entryVa: 0x10000n,
    initialRegs: { 0: 0x1234n, 1: 0x20000n },
  });
  const res = emu.run();
  assert.equal(res.stopReason, HEX_EMU_STOP_REASON.RETURN_OK);
  assert.equal(res.x0, 0xfffffffffffffffen);
  assert.equal(emu.getGpr(2), 0xffff8000n);
  assert.equal(emu.getGpr(3), 0xffffffff80000000n);
  assert.equal(emu.getGpr(1), 0x20004n);
  assert.equal(res.cowPagesUsed, 0);

  // Unallocated pre-index (size=3, opc=2): 0xf8800c20 -> UNSUPPORTED_INSN
  const badPre = runMiniArm64Emu([
    { va: 0x10000n, bytes: u32WordsToBytes([0xf8800c20, 0xd65f03c0]), prot: HEX_EMU_PROT.R | HEX_EMU_PROT.X },
    { va: 0x20000n, bytes: data, prot: HEX_EMU_PROT.R | HEX_EMU_PROT.W },
  ], [], { entryVa: 0x10000n, initialRegs: { 1: 0x20000n } });
  assert.equal(badPre.stopReason, HEX_EMU_STOP_REASON.UNSUPPORTED_INSN);
});

// =============================================================================
// 2. MiniArm64Emu: initialRegs[31] (SP), unallocated encodings, BSS/bounds, fetch, BLR stub, cross-page dirtySpans
// =============================================================================
test('MiniArm64Emu applies initialRegs[31] (SP) and rejects unallocated MOV/ADD/Logical encodings', () => {
  const retOnly = u32WordsToBytes([0xd65f03c0]);
  const spRes = runMiniArm64Emu(
    [{ va: 0x10000n, bytes: retOnly, prot: HEX_EMU_PROT.R | HEX_EMU_PROT.X }],
    [],
    { entryVa: 0x10000n, initialRegs: { 31: 0x7fff0000f000n } },
  );
  assert.equal(spRes.stopReason, HEX_EMU_STOP_REASON.RETURN_OK);
  assert.equal(spRes.sp, 0x7fff0000f000n);

  const unallocWords = [
    0x52c00020, // movz w0, #1, lsl #32 (sf=0, hw=2)
    0xb2800000, // mov wide opc=1 (unallocated)
    0x8bc10000, // add x0, x0, x1, ror #0 (shiftType=3 in ADD shifted reg)
    0x0b018000, // add w0, w0, w1, lsl #32 (sf=0, imm6=32)
    0x0a018000, // and w0, w0, w1, lsl #32 (sf=0, imm6=32)
  ];
  for (const w of unallocWords) {
    const r = runMiniArm64Emu(
      [{ va: 0x10000n, bytes: u32WordsToBytes([w, 0xd65f03c0]), prot: HEX_EMU_PROT.R | HEX_EMU_PROT.X }],
      [],
      { entryVa: 0x10000n, initialRegs: { 0: 1n, 1: 2n } },
    );
    assert.equal(r.stopReason, HEX_EMU_STOP_REASON.UNSUPPORTED_INSN, `word 0x${w.toString(16)} must fail as UNSUPPORTED_INSN`);
  }
});

test('MiniArm64Emu handles seg.size > seg.bytes.length (BSS vs non-BSS), PC alignment, and segment-end fetch', () => {
  // ldr w0, [x1, #4]; ret  (reading past 4-byte file tail in an 8-byte segment)
  const code = u32WordsToBytes([0xb9400420, 0xd65f03c0]);

  // BSS segment: tail reads as 0
  const bssRes = runMiniArm64Emu([
    { va: 0x10000n, bytes: code, prot: HEX_EMU_PROT.R | HEX_EMU_PROT.X },
    { va: 0x20000n, size: 8, bytes: new Uint8Array([1, 2, 3, 4]), prot: HEX_EMU_PROT.R | HEX_EMU_PROT.W | HEX_EMU_PROT.BSS },
  ], [], { entryVa: 0x10000n, initialRegs: { 1: 0x20000n } });
  assert.equal(bssRes.stopReason, HEX_EMU_STOP_REASON.RETURN_OK);
  assert.equal(bssRes.x0, 0n);

  // Non-BSS segment: tail triggers UNINIT_READ (no TypeError)
  const nonBssRes = runMiniArm64Emu([
    { va: 0x10000n, bytes: code, prot: HEX_EMU_PROT.R | HEX_EMU_PROT.X },
    { va: 0x20000n, size: 8, bytes: new Uint8Array([1, 2, 3, 4]), prot: HEX_EMU_PROT.R },
  ], [], { entryVa: 0x10000n, initialRegs: { 1: 0x20000n } });
  assert.equal(nonBssRes.stopReason, HEX_EMU_STOP_REASON.UNINIT_READ);

  // Unaligned PC must not fetch
  const unalignedRes = runMiniArm64Emu(
    [{ va: 0x10000n, bytes: code, prot: HEX_EMU_PROT.R | HEX_EMU_PROT.X }],
    [],
    { entryVa: 0x10002n },
  );
  assert.equal(unalignedRes.stopReason, HEX_EMU_STOP_REASON.UNSUPPORTED_INSN);

  // Segment-end crossing (2-byte exec seg followed by non-exec seg) must fail fetch
  const crossRes = runMiniArm64Emu([
    { va: 0x10000n, bytes: new Uint8Array([0xc0, 0x03]), prot: HEX_EMU_PROT.R | HEX_EMU_PROT.X },
    { va: 0x10002n, bytes: new Uint8Array([0x5f, 0xd6]), prot: HEX_EMU_PROT.R },
  ], [], { entryVa: 0x10000n });
  assert.equal(crossRes.stopReason, HEX_EMU_STOP_REASON.UNSUPPORTED_INSN);
});

test('MiniArm64Emu BLR executes registered pure stubs and extractDirtySpans merges cross-page spans', () => {
  // blr x8 (0xd63f0100); ret (0xd65f03c0)
  const code = u32WordsToBytes([0xd63f0100, 0xd65f03c0]);
  const strBytes = new TextEncoder().encode('hello\0');
  const stubRes = runMiniArm64Emu(
    [
      { va: 0x10000n, bytes: code, prot: HEX_EMU_PROT.R | HEX_EMU_PROT.X },
      { va: 0x20000n, bytes: strBytes, prot: HEX_EMU_PROT.R },
    ],
    [{ va: 0x30000n, stubKind: HEX_EMU_STUB_KIND.STRLEN }],
    { entryVa: 0x10000n, flags: 0x01, initialRegs: { 0: 0x20000n, 8: 0x30000n } },
  );
  assert.equal(stubRes.stopReason, HEX_EMU_STOP_REASON.RETURN_OK);
  assert.equal(stubRes.x0, 5n);

  // Write "ABCDEFGH\0" straddling 4 KiB boundary (0x20ffc..0x21004)
  // str x0, [x1, #0]; strb wzr, [x1, #8]; ret
  const writeCode = u32WordsToBytes([
    0xf9000020, // str x0, [x1]
    0x3900203f, // strb wzr, [x1, #8]
    0xd65f03c0, // ret
  ]);
  const val = 0x4847464544434241n; // "ABCDEFGH" in LE
  const spanRes = runMiniArm64Emu(
    [{ va: 0x10000n, bytes: writeCode, prot: HEX_EMU_PROT.R | HEX_EMU_PROT.X }],
    [],
    { entryVa: 0x10000n, initialRegs: { 0: val, 1: 0x20000n + BigInt(HEX_EMU_PAGE_SIZE) - 4n } },
  );
  assert.equal(spanRes.stopReason, HEX_EMU_STOP_REASON.RETURN_OK);
  assert.equal(spanRes.dirtySpans.length, 1);
  assert.equal(spanRes.dirtySpans[0].kind, HEX_EMU_SPAN_KIND.EMU_STR);
  assert.equal(spanRes.dirtySpans[0].text, 'ABCDEFGH');
  assert.equal(spanRes.dirtySpans[0].va, 0x20ffcn);
});

test('runMiniArm64EmuWasm schema/arg0Val/initialRegs parity and runMiniArm64Emu fallback on faultCode=5 & BSS', () => {
  // add x0, x0, #1; ret
  const addCode = u32WordsToBytes([0x91000400, 0xd65f03c0]);

  // arg0Val via flags & 0x04
  const wasmArg0 = runMiniArm64EmuWasm(addCode, {
    _engine: 'wasm',
    entryVa: 0x10000n,
    codeVa: 0x10000n,
    flags: 0x04,
    arg0Val: 41n,
  });
  assert.ok(wasmArg0 && wasmArg0.engine === 'wasm');
  assert.equal(wasmArg0.x0, 42n);
  assert.equal(wasmArg0.partialRun, false);
  assert.equal(wasmArg0.cowPagesUsed, 0);
  assert.deepEqual(wasmArg0.dirtySpans, []);

  // initialRegs[0] overrides arg0Val (matching JS constructor order)
  const wasmOverride = runMiniArm64EmuWasm(addCode, {
    _engine: 'wasm',
    entryVa: 0x10000n,
    codeVa: 0x10000n,
    flags: 0x04,
    arg0Val: 41n,
    initialRegs: { 0: 99n },
  });
  assert.equal(wasmOverride.x0, 100n);

  // preferWasm falls back to JS on faultCode === 5 (NEON DUP V0.16B, W0: 0x4e010c00)
  const neonCode = u32WordsToBytes([0x4e010c00, 0xd65f03c0]);
  const fallbackRes = runMiniArm64Emu(
    [{ va: 0x10000n, bytes: neonCode, prot: HEX_EMU_PROT.R | HEX_EMU_PROT.X }],
    [],
    { _engine: 'wasm', preferWasm: true, entryVa: 0x10000n, initialRegs: { 0: 0x5an } },
  );
  assert.equal(fallbackRes.engine, 'js');
  assert.equal(fallbackRes.stopReason, HEX_EMU_STOP_REASON.RETURN_OK);

  // preferWasm skips WASM when memsz > bytes.length (BSS tail)
  const bssCode = u32WordsToBytes([0xb9400420, 0xd65f03c0]); // ldr w0, [x1, #4]; ret
  const bssFallback = runMiniArm64Emu(
    [{ va: 0x10000n, memsz: 16, bytes: bssCode, prot: HEX_EMU_PROT.R | HEX_EMU_PROT.X | HEX_EMU_PROT.BSS }],
    [],
    { _engine: 'wasm', preferWasm: true, entryVa: 0x10000n, initialRegs: { 1: 0x10008n } },
  );
  assert.equal(bssFallback.engine, 'js');
  assert.equal(bssFallback.stopReason, HEX_EMU_STOP_REASON.RETURN_OK);
  assert.equal(bssFallback.x0, 0n);
  assert.equal(bssFallback.sp, HEX_EMU_DEFAULT_SP);
});

// =============================================================================
// 3. arm64e/effects-memory.js: APDAKey/APDBKey + structuredOperandList hardening
// =============================================================================
test('arm64e/effects-memory.js uses APDAKey/APDBKey and hardens structuredOperandList', () => {
  assert.equal(ARM64E_EFFECTS_MEMORY_SEMANTIC_VERSION, '2');
  let seq = 0;
  const ctx = () => ({ instructionId: `wave3-auth-load-${++seq}`, mode: 'arm64e' });

  const ldraa = liftArm64eAuthenticatedLoadEffects({ mnemonic: 'ldraa', opStr: 'x0, [x1, #8]' }, ctx());
  assert.equal(ldraa.completeness, 'exact-with-intrinsic');
  assert.equal(ldraa.metadata.keyIdentity, 'APDAKey');

  const ldrab = liftArm64eAuthenticatedLoadEffects({ mnemonic: 'ldrab', opStr: 'x0, [x1, #8]' }, ctx());
  assert.equal(ldrab.completeness, 'exact-with-intrinsic');
  assert.equal(ldrab.metadata.keyIdentity, 'APDBKey');

  // All 5 string operand fields parse bracketed memory operands properly
  for (const field of ['opStr', 'op_str', 'operandString', 'operands', 'args']) {
    const bundle = liftArm64eAuthenticatedLoadEffects({ mnemonic: 'ldraa', [field]: 'x2, [x3, #16]' }, ctx());
    assert.equal(bundle.completeness, 'exact-with-intrinsic', `${field} must lift cleanly`);
    assert.equal(bundle.metadata.keyIdentity, 'APDAKey');
  }

  // [x1]! omitted displacement pre-index must not produce "#undefined"
  const preZero = liftArm64eAuthenticatedLoadEffects({ mnemonic: 'ldraa', opStr: 'x0, [x1]!' }, ctx());
  assert.equal(preZero.completeness, 'exact-with-intrinsic');
  assert.equal(JSON.stringify(preZero).includes('#undefined'), false);

  // 3+ operands and unbalanced brackets must fail closed
  for (const bad of ['x0, [x1, #8], #16', 'x0, [x1, #8', 'x0, ]x1[', 'x0, [x1]]']) {
    const bundle = liftArm64eAuthenticatedLoadEffects({ mnemonic: 'ldraa', opStr: bad }, ctx());
    assert.equal(bundle.completeness, 'partial', `${bad} must fail closed`);
    assert.equal(bundle.operations.some((op) => op.kind === 'memory-read'), false, bad);
  }
});

// =============================================================================
// 4. deobf-eval-arm64.js: signed loads, HINT vs unsupported stop, unknown branch stop, RETAA/RETAB, BL clobber, SP free
// =============================================================================
test('deobf-eval-arm64.js decodes signed loads properly, skips HINTs, and stops on unsupported/unknown branches', () => {
  // roData: -128 (i8) at 0x50000, -1 (i32) at 0x50004
  const roBytes = new Uint8Array([0x80, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff]);
  // movz x1, #0x5, lsl #16 (0xd2a000a1)
  // ldrsb x0, [x1, #0]     (0x39800020)
  // ldrsw x2, [x1, #4]     (0xb9800422)
  // ldrsb w3, [x1, #0]     (0x39c00023)
  // prfm  pldl1keep, [x1]  (0xf9800020) -> NOP
  // paciasp                (0xd503233f) -> HINT skip
  // retaa                  (0xd65f0bff) -> terminate!
  // movz x4, #0x99         (0xd2801324) -> must NOT execute after retaa
  const code = u32WordsToBytes([
    0xd2a000a1,
    0x39800020,
    0xb9800422,
    0x39c00023,
    0xf9800020,
    0xd503233f,
    0xd65f0bff,
    0xd2801324,
  ]);
  const ev = evalArm64Deobf(code, { funcVa: 0x40000n, roSegments: [{ va: 0x50000n, bytes: roBytes }] });
  assert.equal(ev.finalRegs[0], 0xffffffffffffff80n);
  assert.equal(ev.finalRegs[2], 0xffffffffffffffffn);
  assert.equal(ev.finalRegs[3], 0xffffff80n);
  assert.equal(ev.finalRegs[4], null, 'RETAA must terminate before subsequent instructions');

  // Unsupported instruction (mul x0, x1, x2 = 0x9b027c20) stops safely instead of leaving stale x0
  const unsupCode = u32WordsToBytes([
    0xd2800020, // movz x0, #1
    0x9b027c20, // mul x0, x1, x2 (unsupported)
    0xd2800045, // movz x5, #2 (must NOT execute)
    0xd65f03c0, // ret
  ]);
  const evUnsup = evalArm64Deobf(unsupCode);
  assert.equal(evUnsup.finalRegs[5], null);

  // Unknown B.cond records UNKNOWN and stops without fall-through
  const unkBcond = u32WordsToBytes([
    0x54000040, // b.eq +8 (flags unknown!)
    0xd2800026, // movz x6, #1 (must NOT execute on fall-through)
    0xd65f03c0, // ret
  ]);
  const evUnkB = evalArm64Deobf(unkBcond);
  assert.equal(evUnkB.opaquePredicates.length, 1);
  assert.equal(evUnkB.opaquePredicates[0].result, OPAQUE_PREDICATE_RESULT.UNKNOWN);
  assert.equal(evUnkB.finalRegs[6], null);

  // Unknown CBZ records UNKNOWN and stops without fall-through
  const unkCbz = u32WordsToBytes([
    0xb4000040, // cbz x0, +8 (x0 is null!)
    0xd2800027, // movz x7, #1 (must NOT execute)
    0xd65f03c0, // ret
  ]);
  const evUnkCbz = evalArm64Deobf(unkCbz);
  assert.equal(evUnkCbz.opaquePredicates.length, 1);
  assert.equal(evUnkCbz.opaquePredicates[0].result, OPAQUE_PREDICATE_RESULT.UNKNOWN);
  assert.equal(evUnkCbz.finalRegs[7], null);
});

test('deobf-eval-arm64.js clobbers x30+vstack on BL, handles BRK, and clears freed stack on ADD SP, SP, #imm', () => {
  // Write "TEST\0" to [sp, #-16], then BL +0x40 -> clears x30 & vstack
  const blCode = u32WordsToBytes([
    0xd10043ff, // sub sp, sp, #16
    0xd280002e, // movz x14, #1
    0xd280003e, // movz x30, #1
    0x5288aa80, // movz w0, #0x4554 ('TE')
    0x72aa8a60, // movk w0, #0x5453, lsl #16 ('ST') -> "TEST"
    0xb90003e0, // str w0, [sp]
    0x390013ff, // strb wzr, [sp, #4]
    0x94000010, // bl +0x40 -> clobbers x0..x18, x30, flags, vstack
    0xd65f03c0, // ret
  ]);
  const evBl = evalArm64Deobf(blCode);
  assert.equal(evBl.finalRegs[14], null);
  assert.equal(evBl.finalRegs[30], null);
  assert.equal(evBl.records.filter((r) => r.kind === DEOBF_EVAL_KIND.STACK_STR).length, 0);

  // ADD SP, SP, #16 frees stack region [oldSp, oldSp+16)
  const freeCode = u32WordsToBytes([
    0xd10043ff, // sub sp, sp, #16
    0x5288aa80, // movz w0, #0x4554
    0x72aa8a60, // movk w0, #0x5453, lsl #16
    0xb90003e0, // str w0, [sp]
    0x390013ff, // strb wzr, [sp, #4]
    0x910043ff, // add sp, sp, #16 -> frees [oldSp, oldSp+16)
    0xd65f03c0, // ret
  ]);
  const evFree = evalArm64Deobf(freeCode);
  assert.equal(evFree.records.filter((r) => r.kind === DEOBF_EVAL_KIND.STACK_STR).length, 0);

  // BRK #0 (0xd4200000) clobbers x0..x18 and flags.known
  const brkCode = u32WordsToBytes([
    0xd2800020, // movz x0, #1
    0xf1000400, // subs x0, x0, #1 -> flags.known = true
    0xd4200000, // brk #0
    0xd65f03c0, // ret
  ]);
  const evBrk = evalArm64Deobf(brkCode);
  assert.equal(evBrk.finalRegs[0], null);
  assert.equal(evBrk.finalFlags.known, false);
});
