import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeChainedPointer } from '../js/binary/macho-dyld.js';
import { parseMachO } from '../js/binary/macho-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function loadMachOLegacy() {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'js/macho.js'), 'utf8');
  const ctx = { globalThis: null, self: null };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.runInNewContext(src, ctx);
  return ctx.MachO;
}

// ── 1. P1-S06-001: macho-dyld.js high8 tag ordering & 56-bit validation ──

test('P1-S06-001: DYLD_CHAINED_PTR_64_OFFSET applies imageBase before high8 tag', () => {
  const imageBase = 0x100000000n;
  const target = 0x2345n;
  const high8 = 0xffn;
  const raw = target | (high8 << 36n);

  const decoded = decodeChainedPointer(raw, 6, imageBase);
  assert.ok(decoded, 'format 6 rebase with high8 should decode');
  assert.equal(decoded.bind, false);
  assert.equal(decoded.target, (imageBase + target) | (high8 << 56n));
  assert.equal(decoded.target, 0xff00000100002345n);
});

test('P1-S06-001: DYLD_CHAINED_PTR_64_OFFSET rejects base+target overflowing 56 bits when high8 is set', () => {
  // base + target = 0x0100000000010000n (bit 56 set) -> collides with high8.
  const imageBase = 0x00ffffffffff0000n;
  const target = 0x20000n;
  const high8 = 0x01n;
  const raw = target | (high8 << 36n);

  const decoded = decodeChainedPointer(raw, 6, imageBase);
  assert.equal(decoded, null, 'base+target exceeding 56-bit range with high8 must fail closed');
});

test('P1-S06-001: DYLD_CHAINED_PTR_64_OFFSET keeps target null when imageBase is null even with high8', () => {
  const raw = 0x2345n | (0xabn << 36n);
  const decoded = decodeChainedPointer(raw, 6, null);
  assert.ok(decoded);
  assert.equal(decoded.target, null);
});

test('P1-S06-001: vmOffset formats (7, 9, 12) apply imageBase before high8 and validate 56-bit range', () => {
  const imageBase = 0x100000000n;
  const target = 0x4560n;
  const high8 = 0xffn;
  const raw = target | (high8 << 43n);

  for (const format of [7, 9, 12]) {
    const decoded = decodeChainedPointer(raw, format, imageBase);
    assert.ok(decoded, `format ${format} rebase with high8 should decode`);
    assert.equal(decoded.target, 0xff00000100004560n, `format ${format} must tag after rebasing`);

    // 56-bit overflow collision when high8 is non-zero must be rejected.
    const overflow = decodeChainedPointer(0x20000n | (0x02n << 43n), format, 0x00ffffffffff0000n);
    assert.equal(overflow, null, `format ${format} must reject base+target > 56-bit when high8 != 0`);

    // Kernel-style 64-bit base with high8 === 0n remains valid.
    const kernel = decodeChainedPointer(0x1000n, format, 0xfffffff007004000n);
    assert.ok(kernel, `format ${format} with high8=0 and kernel base must decode`);
    assert.equal(kernel.target, 0xfffffff007005000n);

    // Non-zero high8 with kernel-style 64-bit base must be rejected.
    const kernelTagged = decodeChainedPointer(0x1000n | (0x12n << 43n), format, 0xfffffff007004000n);
    assert.equal(kernelTagged, null, `format ${format} with kernel base and non-zero high8 must fail closed`);
  }
});

// ── 2. Hotspot (js/macho.js): ehReadSLEB 10-byte negative 64-bit SLEB128 ──

function encodeSLEB10(value) {
  let v = BigInt(value);
  const out = [];
  for (let i = 0; i < 10; i++) {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (i < 9) byte |= 0x80;
    out.push(byte);
  }
  return out;
}

function buildEhFrameWithSlebFde(pcBeginBytes, pcRangeBytes) {
  // CIE: length(4) + id(4)=0 + version(1)=1 + aug("zR\0") + codeAlign(1)=1
  //      + dataAlign(1)=0x78(-8) + retReg(1)=30 + augLen(1)=1 + fdeEnc(1)=0x19 (pcrel|sleb128)
  const cieBody = [
    0x00, 0x00, 0x00, 0x00, // CIE_id = 0
    0x01,                   // version = 1
    0x7a, 0x52, 0x00,       // "zR\0"
    0x01,                   // code_alignment_factor = 1
    0x78,                   // data_alignment_factor = -8
    0x1e,                   // return_address_register = 30
    0x01,                   // augmentation data length = 1
    0x19,                   // FDE encoding = DW_EH_PE_pcrel (0x10) | DW_EH_PE_sleb128 (0x09)
    0x00, 0x00, 0x00,       // pad to 16 bytes
  ];
  const cieStart = 0;
  const fdeStart = 4 + cieBody.length; // 20

  // FDE: length(4) + ciePointer(4) + pcBegin(sleb128) + pcRange(sleb128) + augLen(1)=0
  // ciePointer is offset from the ciePointer field itself back to cieStart.
  const ciePointerFieldOff = fdeStart + 4;
  const ciePointer = ciePointerFieldOff - cieStart;
  const fdeBody = [
    ciePointer & 0xff, (ciePointer >>> 8) & 0xff, (ciePointer >>> 16) & 0xff, (ciePointer >>> 24) & 0xff,
    ...pcBeginBytes,
    ...pcRangeBytes,
    0x00, // augmentation length = 0
  ];
  while (fdeBody.length % 4 !== 0) fdeBody.push(0x00);

  const buf = new Uint8Array(4 + cieBody.length + 4 + fdeBody.length + 4);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, cieBody.length, true);
  buf.set(cieBody, 4);
  dv.setUint32(fdeStart, fdeBody.length, true);
  buf.set(fdeBody, fdeStart + 4);
  // 4-byte zero terminator already present.
  return { buf, pcBeginFieldOff: fdeStart + 8 };
}

test('Hotspot js/macho.js: ehReadSLEB sign-extends 10-byte negative 64-bit SLEB128', () => {
  const MachO = loadMachOLegacy();
  const sectionVM = 0x100004000n;
  const targetStart = 0x100002000n;
  const targetSize = 0x80n;

  // Build FDE with 10-byte padded negative SLEB128 displacement.
  const dummy = buildEhFrameWithSlebFde(new Array(10).fill(0), [0x00]);
  const fieldVA = sectionVM + BigInt(dummy.pcBeginFieldOff);
  const negDisp = targetStart - fieldVA; // negative displacement
  assert.ok(negDisp < 0n);

  const sleb10 = encodeSLEB10(negDisp);
  assert.equal(sleb10.length, 10);
  assert.equal(sleb10[9], 0x7f, '10th byte of negative 64-bit SLEB128 should be 0x7f');

  const { buf } = buildEhFrameWithSlebFde(sleb10, [0x80, 0x01]); // range = 0x80
  const ranges = MachO.parseEhFrameRanges(buf, sectionVM, {
    regions: [{ vaddr: 0x100000000n, size: 0x8000n, perms: 'r-x' }],
    alignment: 4n,
  });

  assert.equal(ranges.length, 1, '10-byte negative SLEB128 pcBegin must resolve to valid FDE range');
  assert.equal(ranges[0].start, targetStart);
  assert.equal(ranges[0].end, targetStart + targetSize);
});

test('Hotspot js/macho.js: ehReadSLEB rejects out-of-int64-range 10-byte SLEB128', () => {
  const MachO = loadMachOLegacy();
  const sectionVM = 0x100004000n;
  // 10th byte 0x01 with bit 6 clear represents +2^63 (exceeds signed 64-bit max).
  const overflowSleb = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01];
  const { buf } = buildEhFrameWithSlebFde(overflowSleb, [0x10]);
  const ranges = MachO.parseEhFrameRanges(buf, sectionVM, {
    regions: [{ vaddr: 0x100000000n, size: 0x8000n, perms: 'r-x' }],
    alignment: 4n,
  });
  assert.equal(ranges.length, 0, 'overflowing 10-byte SLEB128 must be rejected');
});

// ── 3. Hotspot (js/binary/macho-core.js): LC_DATA_IN_CODE & file-backing contiguity ──

function writeCString(u8, offset, str, maxLen) {
  for (let i = 0; i < Math.min(str.length, maxLen); i++) {
    u8[offset + i] = str.charCodeAt(i);
  }
}

function buildMachO64({
  textFileSize = 0x100,
  textVmSize = 0x100,
  extraTextSections = [],
  modInitTargets = [],
  initOffsetTargets = [],
  entryoff = null,
  dataInCodeEntries = [],
  functionStartsPayload = null,
}) {
  const imageBase = 0x100000000n;
  const textFileOff = 0x1000;
  const textVmAddr = imageBase + 0x1000n;
  const dataFileOff = 0x2000;
  const dataVmAddr = imageBase + 0x2000n;
  const linkeditOff = 0x3000;
  const totalSize = 0x4000;

  const u8 = new Uint8Array(totalSize);
  const dv = new DataView(u8.buffer);

  // Fill __text with valid ARM64 RET instructions (0xd65f03c0).
  for (let off = textFileOff; off + 4 <= textFileOff + textFileSize; off += 4) {
    dv.setUint32(off, 0xd65f03c0, true);
  }

  // Build __TEXT sections list.
  const textSections = [
    {
      sectname: '__text',
      segname: '__TEXT',
      addr: textVmAddr,
      size: BigInt(textVmSize),
      offset: textFileOff,
      flags: 0x80000400, // S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS
    },
    ...extraTextSections,
  ];

  // Build __DATA sections list.
  const dataSections = [];
  let dataCursorOff = dataFileOff;
  let dataCursorVa = dataVmAddr;

  if (modInitTargets.length > 0) {
    const size = modInitTargets.length * 8;
    for (let i = 0; i < modInitTargets.length; i++) {
      dv.setBigUint64(dataCursorOff + i * 8, modInitTargets[i], true);
    }
    dataSections.push({
      sectname: '__mod_init_func',
      segname: '__DATA',
      addr: dataCursorVa,
      size: BigInt(size),
      offset: dataCursorOff,
      flags: 0x09, // S_MOD_INIT_FUNC_POINTERS
    });
    dataCursorOff += size;
    dataCursorVa += BigInt(size);
  }

  if (initOffsetTargets.length > 0) {
    const size = initOffsetTargets.length * 4;
    for (let i = 0; i < initOffsetTargets.length; i++) {
      dv.setUint32(dataCursorOff + i * 4, Number(initOffsetTargets[i]), true);
    }
    dataSections.push({
      sectname: '__init_offsets',
      segname: '__DATA',
      addr: dataCursorVa,
      size: BigInt(size),
      offset: dataCursorOff,
      flags: 0x16, // S_INIT_FUNC_OFFSETS
    });
    dataCursorOff += size;
    dataCursorVa += BigInt(size);
  }

  // Write LINKEDIT payloads.
  let linkeditCursor = linkeditOff;
  let diceOff = 0, diceSize = 0;
  if (dataInCodeEntries.length > 0) {
    diceOff = linkeditCursor;
    diceSize = dataInCodeEntries.length * 8;
    for (let i = 0; i < dataInCodeEntries.length; i++) {
      const e = dataInCodeEntries[i];
      dv.setUint32(diceOff + i * 8, e.offset, true);
      dv.setUint16(diceOff + i * 8 + 4, e.length, true);
      dv.setUint16(diceOff + i * 8 + 6, e.kind ?? 1, true);
    }
    linkeditCursor += diceSize;
  }

  let fnStartsOff = 0, fnStartsSize = 0;
  if (functionStartsPayload) {
    fnStartsOff = linkeditCursor;
    fnStartsSize = functionStartsPayload.length;
    u8.set(functionStartsPayload, fnStartsOff);
    linkeditCursor += fnStartsSize;
  }

  // Write Mach-O 64-bit header (ARM64).
  const loadCommands = [];

  // LC_SEGMENT_64 __TEXT
  {
    const cmdsize = 72 + textSections.length * 80;
    const cmd = new Uint8Array(cmdsize);
    const cdv = new DataView(cmd.buffer);
    cdv.setUint32(0, 0x19, true); // LC_SEGMENT_64
    cdv.setUint32(4, cmdsize, true);
    writeCString(cmd, 8, '__TEXT', 16);
    cdv.setBigUint64(24, imageBase, true);
    cdv.setBigUint64(32, 0x1000n + BigInt(textVmSize), true);
    cdv.setBigUint64(40, 0n, true);
    cdv.setBigUint64(48, 0x1000n + BigInt(textFileSize), true);
    cdv.setUint32(56, 7, true); // maxprot rwx
    cdv.setUint32(60, 5, true); // initprot r-x
    cdv.setUint32(64, textSections.length, true);
    cdv.setUint32(68, 0, true);
    for (let i = 0; i < textSections.length; i++) {
      const s = textSections[i];
      const base = 72 + i * 80;
      writeCString(cmd, base, s.sectname, 16);
      writeCString(cmd, base + 16, s.segname, 16);
      cdv.setBigUint64(base + 32, s.addr, true);
      cdv.setBigUint64(base + 40, s.size, true);
      cdv.setUint32(base + 48, s.offset, true);
      cdv.setUint32(base + 52, 2, true);
      cdv.setUint32(base + 64, s.flags, true);
    }
    loadCommands.push(cmd);
  }

  // LC_SEGMENT_64 __DATA (if needed)
  if (dataSections.length > 0) {
    const cmdsize = 72 + dataSections.length * 80;
    const cmd = new Uint8Array(cmdsize);
    const cdv = new DataView(cmd.buffer);
    cdv.setUint32(0, 0x19, true);
    cdv.setUint32(4, cmdsize, true);
    writeCString(cmd, 8, '__DATA', 16);
    cdv.setBigUint64(24, dataVmAddr, true);
    cdv.setBigUint64(32, 0x1000n, true);
    cdv.setBigUint64(40, BigInt(dataFileOff), true);
    cdv.setBigUint64(48, 0x1000n, true);
    cdv.setUint32(56, 3, true);
    cdv.setUint32(60, 3, true);
    cdv.setUint32(64, dataSections.length, true);
    for (let i = 0; i < dataSections.length; i++) {
      const s = dataSections[i];
      const base = 72 + i * 80;
      writeCString(cmd, base, s.sectname, 16);
      writeCString(cmd, base + 16, s.segname, 16);
      cdv.setBigUint64(base + 32, s.addr, true);
      cdv.setBigUint64(base + 40, s.size, true);
      cdv.setUint32(base + 48, s.offset, true);
      cdv.setUint32(base + 52, 3, true);
      cdv.setUint32(base + 64, s.flags, true);
    }
    loadCommands.push(cmd);
  }

  // LC_MAIN
  if (entryoff != null) {
    const cmd = new Uint8Array(24);
    const cdv = new DataView(cmd.buffer);
    cdv.setUint32(0, 0x80000028, true); // LC_MAIN
    cdv.setUint32(4, 24, true);
    cdv.setBigUint64(8, BigInt(entryoff), true);
    cdv.setBigUint64(16, 0n, true);
    loadCommands.push(cmd);
  }

  // LC_DATA_IN_CODE
  if (diceSize > 0) {
    const cmd = new Uint8Array(16);
    const cdv = new DataView(cmd.buffer);
    cdv.setUint32(0, 0x29, true); // LC_DATA_IN_CODE
    cdv.setUint32(4, 16, true);
    cdv.setUint32(8, diceOff, true);
    cdv.setUint32(12, diceSize, true);
    loadCommands.push(cmd);
  }

  // LC_FUNCTION_STARTS
  if (fnStartsSize > 0) {
    const cmd = new Uint8Array(16);
    const cdv = new DataView(cmd.buffer);
    cdv.setUint32(0, 0x26, true); // LC_FUNCTION_STARTS
    cdv.setUint32(4, 16, true);
    cdv.setUint32(8, fnStartsOff, true);
    cdv.setUint32(12, fnStartsSize, true);
    loadCommands.push(cmd);
  }

  const sizeofcmds = loadCommands.reduce((sum, c) => sum + c.length, 0);
  dv.setUint32(0, 0xfeedfacf, true); // MH_MAGIC_64
  dv.setUint32(4, 0x0100000c, true); // CPU_TYPE_ARM64
  dv.setUint32(8, 0, true);
  dv.setUint32(12, 2, true); // MH_EXECUTE
  dv.setUint32(16, loadCommands.length, true);
  dv.setUint32(20, sizeofcmds, true);
  dv.setUint32(24, 0, true);
  dv.setUint32(28, 0, true);

  let cmdOff = 32;
  for (const cmd of loadCommands) {
    u8.set(cmd, cmdOff);
    cmdOff += cmd.length;
  }

  return u8;
}

test('Hotspot js/binary/macho-core.js: entrypoint rejects LC_DATA_IN_CODE and non-contiguous file backing', () => {
  // Entrypoint at file offset 0x1000 (VA 0x100001000) covered by LC_DATA_IN_CODE.
  const imgData = parseMachO(buildMachO64({
    entryoff: 0x1000,
    dataInCodeEntries: [{ offset: 0x1000, length: 4, kind: 1 }],
  }));
  assert.equal(imgData.metadata.entrypointValid, false);
  assert.equal(imgData.functions.some((f) => f.source === 'entrypoint'), false);

  // Entrypoint at 0x100001008 when only 2 bytes are file-backed (textFileSize = 10, textVmSize = 0x100).
  const imgShort = parseMachO(buildMachO64({
    textFileSize: 10,
    textVmSize: 0x100,
    entryoff: 0x1008,
  }));
  assert.equal(imgShort.metadata.entrypointValid, false);
  assert.equal(imgShort.functions.some((f) => f.source === 'entrypoint'), false);

  // Control: valid entrypoint outside LC_DATA_IN_CODE with full 4-byte file backing.
  const imgOk = parseMachO(buildMachO64({
    entryoff: 0x1008,
    dataInCodeEntries: [{ offset: 0x1000, length: 4, kind: 1 }],
  }));
  assert.equal(imgOk.metadata.entrypointValid, true);
  assert.equal(imgOk.functions.some((f) => f.source === 'entrypoint' && f.address === 0x100001008n), true);
});

test('Hotspot js/binary/macho-core.js: S_MOD_INIT_FUNC_POINTERS rejects LC_DATA_IN_CODE and discontiguous file backing', () => {
  // Two targets:
  // 1) 0x100001000 -> inside LC_DATA_IN_CODE (must be rejected)
  // 2) 0x100001008 -> only 2 bytes file-backed before zero-fill tail (must be rejected)
  // 3) 0x100001004 -> valid 4-byte file-backed instruction outside LC_DATA_IN_CODE (must be accepted)
  const img = parseMachO(buildMachO64({
    textFileSize: 10,
    textVmSize: 0x100,
    modInitTargets: [0x100001000n, 0x100001008n, 0x100001004n],
    dataInCodeEntries: [{ offset: 0x1000, length: 4, kind: 1 }],
  }));

  const inits = img.metadata.initializers;
  assert.equal(inits.length, 3);
  assert.equal(inits[0].valid, false, 'mod_init target inside LC_DATA_IN_CODE must be rejected');
  assert.equal(inits[1].valid, false, 'mod_init target with <4 contiguous file-backed bytes must be rejected');
  assert.equal(inits[2].valid, true, 'valid mod_init target must be accepted');

  const ctorAddrs = img.functions.filter((f) => f.source === 'constructor').map((f) => f.address);
  assert.deepEqual(ctorAddrs, [0x100001004n]);
});

test('Hotspot js/binary/macho-core.js: S_INIT_FUNC_OFFSETS rejects LC_DATA_IN_CODE and discontiguous file backing', () => {
  const img = parseMachO(buildMachO64({
    textFileSize: 10,
    textVmSize: 0x100,
    initOffsetTargets: [0x1000n, 0x1008n, 0x1004n],
    dataInCodeEntries: [{ offset: 0x1000, length: 4, kind: 1 }],
  }));

  const inits = img.metadata.initializers;
  assert.equal(inits.length, 3);
  assert.equal(inits[0].valid, false, 'init_offset target inside LC_DATA_IN_CODE must be rejected');
  assert.equal(inits[1].valid, false, 'init_offset target with <4 contiguous file-backed bytes must be rejected');
  assert.equal(inits[2].valid, true, 'valid init_offset target must be accepted');

  const ctorAddrs = img.functions.filter((f) => f.source === 'constructor').map((f) => f.address);
  assert.deepEqual(ctorAddrs, [0x100001004n]);
});

test('Hotspot js/binary/macho-core.js: LC_FUNCTION_STARTS rejects partial LC_DATA_IN_CODE overlap and partial file backing', () => {
  // ULEB128 for 0x1000 is [0x80, 0x20], followed by 0x00 terminator.
  const fnStartsAt1000 = new Uint8Array([0x80, 0x20, 0x00]);

  // LC_DATA_IN_CODE overlaps bytes [0x1002, 0x1004) of the 4-byte ARM64 instruction at 0x1000.
  const imgOverlap = parseMachO(buildMachO64({
    functionStartsPayload: fnStartsAt1000,
    dataInCodeEntries: [{ offset: 0x1002, length: 2, kind: 1 }],
  }));
  assert.equal(imgOverlap.metadata.functionStarts.complete, false);
  assert.equal(imgOverlap.functions.some((f) => f.source === 'function_starts'), false);

  // Only 2 bytes file-backed at 0x1000 (textFileSize = 2, textVmSize = 0x100).
  const imgPartialFile = parseMachO(buildMachO64({
    textFileSize: 2,
    textVmSize: 0x100,
    functionStartsPayload: fnStartsAt1000,
  }));
  assert.equal(imgPartialFile.metadata.functionStarts.complete, false);
  assert.equal(imgPartialFile.functions.some((f) => f.source === 'function_starts'), false);
});
