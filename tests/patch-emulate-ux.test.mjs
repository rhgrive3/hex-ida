import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  PatchSet,
  assemble,
  decodeArm64PatchWord,
  suggestPatches,
  validatePatchRange,
  validateMultiInstructionPatchRange,
} from '../js/patch.js';
import { createApi, makeEmulator, overlayStagedPatches } from '../js/script.js';
import { parseDebuggerArgument, explainEmulatorFault } from '../js/tools-base.js';

function u32le(bytes, offset = 0) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function makeMockApp({ insns = [], dataBytes = new Uint8Array(0x100), patches = new PatchSet() } = {}) {
  const vmAddr = 0x1000n;
  const region = { id: 'text', name: '__text', vmAddr, fileOffset: 0n, size: 0x100n, exec: true };
  const mn = insns.map((i) => i.mn);
  const ops = insns.map((i) => i.ops);
  return {
    patches,
    store: {
      get(key) {
        if (key === 'architecture') return 'arm64';
        if (key === 'regions') return [region];
        if (key === 'file') return { name: 'sample', size: dataBytes.length };
        return null;
      },
    },
    codeRegion: () => region,
    symbols: {
      nameAt: () => null,
      label: () => null,
      functionAt: () => ({ start: vmAddr, end: vmAddr + 0x40n }),
    },
    backend: {
      async readAt(addr, len) {
        const rel = Number(BigInt(addr) - vmAddr);
        if (rel < 0 || rel >= dataBytes.length) return { found: false, bytes: null };
        const end = Math.min(dataBytes.length, rel + len);
        return { found: true, bytes: dataBytes.slice(rel, end) };
      },
      async fetchChunk() {
        return { mn, ops };
      },
    },
  };
}

test('ARM64 patch assembler supports cbz/cbnz/tbz/tbnz, movn, negative mov, and multi-instruction', () => {
  const at = 0x1000n;

  const cbz = assemble('cbz w0, 0x1008', at);
  assert.ok(cbz.bytes && cbz.bytes.length === 4);
  assert.equal(u32le(cbz.bytes), 0x34000040);
  assert.deepEqual(decodeArm64PatchWord(u32le(cbz.bytes), at), { mn: 'cbz', ops: 'w0, #0x1008' });

  const cbnz = assemble('cbnz x2, 0x1010', at);
  assert.ok(cbnz.bytes && cbnz.bytes.length === 4);
  assert.equal(u32le(cbnz.bytes), 0xB5000082);
  assert.deepEqual(decodeArm64PatchWord(u32le(cbnz.bytes), at), { mn: 'cbnz', ops: 'x2, #0x1010' });

  const tbz = assemble('tbz w0, #0, 0x1008', at);
  assert.ok(tbz.bytes && tbz.bytes.length === 4);
  assert.equal(u32le(tbz.bytes), 0x36000040);
  assert.deepEqual(decodeArm64PatchWord(u32le(tbz.bytes), at), { mn: 'tbz', ops: 'w0, #0, #0x1008' });

  const tbnz = assemble('tbnz x1, #35, 0x1008', at);
  assert.ok(tbnz.bytes && tbnz.bytes.length === 4);
  assert.equal(u32le(tbnz.bytes), 0xB7180041);
  assert.deepEqual(decodeArm64PatchWord(u32le(tbnz.bytes), at), { mn: 'tbnz', ops: 'x1, #35, #0x1008' });

  // Bit index > 31 on W register must be rejected
  assert.ok(assemble('tbz w0, #32, 0x1008', at).error);

  const movnW = assemble('movn w0, #0', at);
  assert.equal(u32le(movnW.bytes), 0x12800000);
  assert.deepEqual(decodeArm64PatchWord(u32le(movnW.bytes), at), { mn: 'movn', ops: 'w0, #0x0' });

  const movNeg = assemble('mov x0, #-1', at);
  assert.equal(u32le(movNeg.bytes), 0x92800000);
  assert.deepEqual(decodeArm64PatchWord(u32le(movNeg.bytes), at), { mn: 'movn', ops: 'x0, #0x0' });

  assert.ok(assemble('movn x0, x1', at).error);

  const multi = assemble('mov w0, #1; ret', at);
  assert.ok(multi.bytes && multi.bytes.length === 8);
  assert.deepEqual(decodeArm64PatchWord(u32le(multi.bytes, 0), at), { mn: 'movz', ops: 'w0, #0x1' });
  assert.deepEqual(decodeArm64PatchWord(u32le(multi.bytes, 4), at + 4n), { mn: 'ret', ops: '' });
});

test('suggestPatches provides cbz/cbnz/tbz/tbnz recipes and 8-byte multi-instruction presets', () => {
  const at = 0x1000n;
  const cbzPresets = suggestPatches('cbz', 'w0, #0x1010', at);
  assert.ok(cbzPresets.some((p) => p.id === 'invert' && p.text === 'cbnz w0, 0x1010'));
  assert.ok(cbzPresets.some((p) => p.id === 'always' && p.text === 'b 0x1010'));
  assert.ok(cbzPresets.some((p) => p.id === 'nop' && p.text === 'nop'));
  for (const p of cbzPresets) assert.ok(assemble(p.text, at).bytes, p.text);

  const tbnzPresets = suggestPatches('tbnz', 'x3, #5, #0x1020', at);
  assert.ok(tbnzPresets.some((p) => p.id === 'invert' && p.text === 'tbz x3, #5, 0x1020'));
  assert.ok(tbnzPresets.some((p) => p.id === 'always' && p.text === 'b 0x1020'));
  for (const p of tbnzPresets) assert.ok(assemble(p.text, at).bytes, p.text);

  const noMulti = suggestPatches('stp', 'x29, x30, [sp, #-16]!', at, { availableBytes: 4 });
  assert.equal(noMulti.some((p) => p.id === 'always_true'), false);

  const withMulti = suggestPatches('stp', 'x29, x30, [sp, #-16]!', at, { availableBytes: 8 });
  assert.ok(withMulti.some((p) => p.id === 'always_true' && p.text === 'mov w0, #1; ret'));
  assert.ok(withMulti.some((p) => p.id === 'always_false' && p.text === 'mov w0, #0; ret'));
  assert.ok(withMulti.some((p) => p.id === 'always_neg1' && p.text === 'movn w0, #0; ret'));
  for (const p of withMulti) assert.ok(assemble(p.text, at).bytes, p.text);

  const region = { vmAddr: 0x1000n, fileOffset: 0n, size: 0x100n };
  assert.ok(validatePatchRange(region, 0x1000n, 8, 0x100n, true).error);
  assert.equal(validateMultiInstructionPatchRange(region, 0x1000n, 8, 0x100n).ok, true);
  assert.ok(validateMultiInstructionPatchRange(region, 0x1000n, 6, 0x100n).error);
});

test('makeEmulator overlays staged patches onto instruction fetches and memory reads with A/B toggle', async () => {
  const originalBytes = new Uint8Array(0x40);
  originalBytes[0x20] = 0x11;
  originalBytes[0x21] = 0x22;
  const patches = new PatchSet();
  const app = makeMockApp({
    insns: [
      { mn: 'mov', ops: 'w0, #0' },
      { mn: 'ret', ops: '' },
    ],
    dataBytes: originalBytes,
    patches,
  });

  // Unpatched run returns 0
  const emuOrig = makeEmulator(app);
  emuOrig.setup(0x1000n, []);
  await emuOrig.run(100);
  assert.equal(emuOrig.x[0], 0n);

  // Stage a multi-instruction patch returning 1 + a data byte patch at +0x20
  const built = assemble('mov w0, #1; ret', 0x1000n);
  patches.add(0n, new Uint8Array(8), built.bytes, { addr: 0x1000n, text: 'mov w0, #1; ret' });
  patches.add(0x20n, new Uint8Array([0x11, 0x22]), new Uint8Array([0xAA, 0xBB]), { addr: 0x1020n, text: 'AA BB' });

  // Patched run (default applyPatches: true) returns 1 and reads overlaid memory
  const emuPatched = makeEmulator(app);
  emuPatched.setup(0x1000n, []);
  await emuPatched.run(100);
  assert.equal(emuPatched.x[0], 1n);
  const dumpedPatched = await emuPatched.dump(0x1020n, 2);
  assert.deepEqual(Array.from(dumpedPatched), [0xAA, 0xBB]);
  // Underlying buffer must remain untouched
  assert.deepEqual(Array.from(originalBytes.slice(0x20, 0x22)), [0x11, 0x22]);

  // A/B compare with applyPatches: false executes original instruction and reads original memory
  const emuDisabled = makeEmulator(app, { applyPatches: false });
  emuDisabled.setup(0x1000n, []);
  await emuDisabled.run(100);
  assert.equal(emuDisabled.x[0], 0n);
  const dumpedOrig = await emuDisabled.dump(0x1020n, 2);
  assert.deepEqual(Array.from(dumpedOrig), [0x11, 0x22]);

  // Script API also supports applyPatches option
  const { api } = createApi(app, () => {});
  const resPatched = await api.run(0x1000n, [], 100);
  assert.equal(resPatched.x0, 1n);
  const resOrig = await api.run(0x1000n, [], 100, { signal: null, applyPatches: false });
  assert.equal(resOrig.x0, 0n);

  // Direct overlay helper check
  const overlaid = overlayStagedPatches(patches, app.store.get('regions'), 0x1020n, new Uint8Array([0x11, 0x22]));
  assert.deepEqual(Array.from(overlaid), [0xAA, 0xBB]);
});

test('parseDebuggerArgument trims whitespace and supports signed hex', () => {
  assert.deepEqual(parseDebuggerArgument('  42  '), { ok: true, value: 42n, error: null });
  assert.deepEqual(parseDebuggerArgument('\t0x1000\n'), { ok: true, value: 0x1000n, error: null });
  assert.deepEqual(parseDebuggerArgument(' -1 '), { ok: true, value: -1n, error: null });
  assert.deepEqual(parseDebuggerArgument(' -0x10 '), { ok: true, value: -16n, error: null });
  assert.equal(parseDebuggerArgument('   ').ok, false);
  assert.equal(parseDebuggerArgument('abc').ok, false);
});

test('explainEmulatorFault translates common fault/stop reasons into plain Japanese with hints', () => {
  const nullPtr = explainEmulatorFault('unmapped-memory', 'no backing memory for 0x10');
  assert.match(nullPtr, /NULL/);
  assert.match(nullPtr, /ダミー領域を引数にセット/);

  const unmapped = explainEmulatorFault('unmapped-memory', 'no backing memory for 0xdeadbeef');
  assert.match(unmapped, /割り当てられていないメモリ領域/);
  assert.match(unmapped, /ヒント/);

  const stepLimit = explainEmulatorFault(null, '50,000 命令ぶん進んだので、いったん止めました。');
  assert.match(stepLimit, /上限/);
  assert.match(stepLimit, /ヒント/);

  const unsup = explainEmulatorFault('unsupported-instruction', 'scalar floating-point lane is not modelled');
  assert.match(unsup, /対応していない命令/);
  assert.match(unsup, /nop/);

  const normal = explainEmulatorFault('program-return', '最初の呼び出し元まで戻ってきました（実行おわり）。');
  assert.match(normal, /正常に終了/);
});

test('tools-base.js and sandbox.js wire up beginner patch/emulation UX controls', async () => {
  const toolsSrc = await fs.readFile(new URL('../js/tools-base.js', import.meta.url), 'utf8');
  assert.match(toolsSrc, /パッチ適用状態で試す/);
  assert.match(toolsSrc, /ダミー領域を引数にセット/);
  assert.match(toolsSrc, /元に戻す \(Undo\)/);
  assert.match(toolsSrc, /ensureReadyForRun/);
  assert.match(toolsSrc, /try \{\s*const bytes = await emu\.dump\(a, 64\);/);

  const sandboxSrc = await fs.readFile(new URL('../js/sandbox.js', import.meta.url), 'utf8');
  assert.match(sandboxSrc, /emulatorCreate', options == null \? \[addr, args\] : \[addr, args, options\]/);
});

test('Review Finding 1: staged raw-hex and partial patches fail closed instead of executing unpatched instructions', async () => {
  const originalBytes = new Uint8Array(0x40);
  const patches = new PatchSet();
  const app = makeMockApp({
    insns: [
      { mn: 'mov', ops: 'w0, #42' },
      { mn: 'ret', ops: '' },
    ],
    dataBytes: originalBytes,
    patches,
  });

  // Full 4-byte raw hex patch that decodeArm64PatchWord cannot decode (0x00000000 = UDF #0)
  patches.add(0n, new Uint8Array(4), new Uint8Array([0x00, 0x00, 0x00, 0x00]), { addr: 0x1000n, text: '00 00 00 00', mode: 'raw' });
  const emuRaw = makeEmulator(app);
  emuRaw.setup(0x1000n, []);
  await emuRaw.run(20);
  assert.notEqual(emuRaw.x[0], 42n);
  assert.equal(emuRaw.stopCode, 'instruction-fetch-failed');

  // Partial 1-byte patch overlapping [0x1000, 0x1004) must also fail closed, never fall back to fetchChunk
  patches.clear();
  patches.add(1n, new Uint8Array([0x00]), new Uint8Array([0xFF]), { addr: 0x1001n, text: 'FF', mode: 'raw' });
  const emuPartial = makeEmulator(app);
  emuPartial.setup(0x1000n, []);
  await emuPartial.run(20);
  assert.notEqual(emuPartial.x[0], 42n);
  assert.equal(emuPartial.stopCode, 'instruction-fetch-failed');
});

test('Review Finding 6: script patch API and tools-base emit store.set({ patches }) on mutation', async () => {
  const storeSets = [];
  const patches = new PatchSet();
  const app = makeMockApp({
    insns: [{ mn: 'nop', ops: '' }],
    dataBytes: new Uint8Array(0x40),
    patches,
  });
  app.store.set = (patch) => storeSets.push(patch);

  const { api } = createApi(app, () => {});
  const res = await api.patch(0x1000n, 'nop');
  assert.equal(res.ok, true);
  assert.deepEqual(storeSets, [{ patches: 1 }]);

  const toolsSrc = await fs.readFile(new URL('../js/tools-base.js', import.meta.url), 'utf8');
  const setMatches = toolsSrc.match(/app\.store\?\.set\?\.\(\{\s*patches:\s*app\.patches\.size\s*\}\)/g) || [];
  assert.ok(setMatches.length >= 4, `expected >= 4 store patch notifications in tools-base.js, got ${setMatches.length}`);
});

test('Review Finding 7: decodeArm64PatchWord rejects unallocated 32-bit MOVZ/MOVN (sf=0, hw>=2)', () => {
  // 32-bit MOVZ with hw=2 (lsl #32) and hw=3 (lsl #48) are UNALLOCATED
  assert.equal(decodeArm64PatchWord(0x52C00020, 0x1000n), null);
  assert.equal(decodeArm64PatchWord(0x52E00020, 0x1000n), null);
  // 32-bit MOVN with hw=2 and hw=3 are UNALLOCATED
  assert.equal(decodeArm64PatchWord(0x12C00020, 0x1000n), null);
  assert.equal(decodeArm64PatchWord(0x12E00020, 0x1000n), null);
  // Valid 32-bit hw=1 (lsl #16) and 64-bit hw=2 (lsl #32) still decode
  assert.deepEqual(decodeArm64PatchWord(0x52A00020, 0x1000n), { mn: 'movz', ops: 'w0, #0x1, lsl #16' });
  assert.deepEqual(decodeArm64PatchWord(0xD2C00020, 0x1000n), { mn: 'movz', ops: 'x0, #0x1, lsl #32' });
});

test('Review Finding 9: assemble() coerces numeric and string `at` consistently for single-instruction assembly', () => {
  const expected = assemble('b 0x1008', 0x1000n);
  const fromNum = assemble('b 0x1008', 0x1000);
  const fromStr = assemble('b 0x1008', '0x1000');
  assert.deepEqual(Array.from(fromNum.bytes), Array.from(expected.bytes));
  assert.deepEqual(Array.from(fromStr.bytes), Array.from(expected.bytes));
  assert.ok(assemble('nop').bytes);
});

test('Review Finding 10: explainEmulatorFault handles max-steps stopCode', () => {
  const maxSteps = explainEmulatorFault('max-steps', 'stopped');
  assert.match(maxSteps, /上限/);
  assert.match(maxSteps, /ヒント/);
});

test('Review Finding 11: overlayStagedPatches skips zero-fill sections during file-offset fallback', () => {
  const patches = new PatchSet();
  patches.add(0n, new Uint8Array([0x00, 0x00]), new Uint8Array([0xDE, 0xAD]), {});
  const regions = [
    { id: 'bss', name: '__bss', vmAddr: 0x9000n, fileOffset: 0n, size: 0x100n, zerofill: true },
    { id: 'bss2', name: '__common', vmAddr: 0xA000n, fileOffset: 0n, size: 0x100n, fileSize: 0 },
    { id: 'data', name: '__data', vmAddr: 0x2000n, fileOffset: 0n, size: 0x100n, fileSize: 0x100n },
  ];
  // Should NOT overlay onto zerofill/fileSize===0 regions
  assert.deepEqual(Array.from(overlayStagedPatches(patches, regions, 0x9000n, new Uint8Array([0x00, 0x00]))), [0x00, 0x00]);
  assert.deepEqual(Array.from(overlayStagedPatches(patches, regions, 0xA000n, new Uint8Array([0x00, 0x00]))), [0x00, 0x00]);
  // Should overlay onto the real file-backed region
  assert.deepEqual(Array.from(overlayStagedPatches(patches, regions, 0x2000n, new Uint8Array([0x00, 0x00]))), [0xDE, 0xAD]);
});

test('Review Finding 12: suggestPatches does not capture hex bit index as tbz/tbnz branch target', () => {
  const recipes = suggestPatches('tbz', 'w0, #0x1f, sub_1020', 0x1000n);
  assert.equal(recipes.some((r) => r.id === 'invert'), false);
  assert.equal(recipes.some((r) => r.id === 'always'), false);
});
