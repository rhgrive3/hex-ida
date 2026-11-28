import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFormatSafeRebuildTransaction,
  validateFormatSafeMutation,
} from '../js/rebuild/format-safe.js';
import {
  SHIFTED_PTR_FLAGS,
  ShiftedPtrRegistry,
  fnv1a32,
  parseShiftedTypeAnnotation,
} from '../js/analysis/recovery/shifted-ptr-spec.js';
import {
  createCompactFunctionSet,
  demoteLowInformationAbsenceClaims,
  materializeCompactFunctionSet,
} from '../js/diff/compact-function-set.js';
import { pointsToAlias } from '../js/analysis/pointsto/alias.js';
import {
  createPointsToSet,
  createPointsToTarget,
  exactRange,
} from '../js/analysis/pointsto/lattice.js';
import { createAnalysisStatus } from '../js/analysis/status.js';

// =============================================================================
// Minimal binary builders for format-safe.js tests
// =============================================================================
function buildMinimalPe64({ checkSum = 0, fileAlignment = 0x200, sectionAlignment = 0x1000, extraSections = [] } = {}) {
  const peOffset = 0x80;
  const optSize = 0xf0;
  const sectionCount = 1 + extraSections.length;
  const secTableOffset = peOffset + 24 + optSize;
  const totalSize = 0x600;
  const buf = new Uint8Array(totalSize);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x4d; buf[1] = 0x5a; // MZ
  dv.setUint32(0x3c, peOffset, true);
  buf[peOffset] = 0x50; buf[peOffset + 1] = 0x45; // PE\0\0
  dv.setUint16(peOffset + 4, 0x8664, true); // AMD64
  dv.setUint16(peOffset + 6, sectionCount, true);
  dv.setUint32(peOffset + 8, 0x11223344, true); // TimeDateStamp
  dv.setUint16(peOffset + 20, optSize, true);
  const opt = peOffset + 24;
  dv.setUint16(opt, 0x20b, true); // PE32+
  dv.setUint32(opt + 16, 0x1000, true); // entryRva
  dv.setBigUint64(opt + 24, 0x140000000n, true); // imageBase
  dv.setUint32(opt + 32, sectionAlignment, true);
  dv.setUint32(opt + 36, fileAlignment, true);
  dv.setUint32(opt + 60, 0x200, true); // sizeOfHeaders
  dv.setUint32(opt + 64, checkSum, true); // CheckSum
  dv.setUint16(opt + 68, 3, true); // subsystem
  dv.setUint32(opt + 108, 16, true); // numberOfRvaAndSizes

  const sections = [
    { name: '.text', virtualSize: 0x100, virtualAddress: 0x1000, rawSize: 0x200, rawOffset: 0x200, characteristics: 0x60000020 },
    ...extraSections,
  ];
  let maxEnd = 0;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const off = secTableOffset + i * 40;
    for (let j = 0; j < Math.min(8, s.name.length); j++) buf[off + j] = s.name.charCodeAt(j);
    dv.setUint32(off + 8, s.virtualSize, true);
    dv.setUint32(off + 12, s.virtualAddress, true);
    dv.setUint32(off + 16, s.rawSize, true);
    dv.setUint32(off + 20, s.rawOffset, true);
    dv.setUint32(off + 36, s.characteristics ?? 0x40000040, true);
    maxEnd = Math.max(maxEnd, s.virtualAddress + Math.max(s.virtualSize, s.rawSize));
  }
  const sizeOfImage = Math.ceil(maxEnd / sectionAlignment) * sectionAlignment;
  dv.setUint32(opt + 56, sizeOfImage, true);
  return buf;
}

function buildMinimalMacho64({
  textAddr = 0x100000100,
  textSize = 0x10,
  textOff = 0x100,
  sec2Addr = 0x100000140,
  sec2Size = 0x10,
  sec2Off = 0x140,
  segVmAddr = 0x100000000,
  segVmSize = 0x1000,
  segFileOff = 0,
  segFileSize = 0x200,
} = {}) {
  const buf = new Uint8Array(0x300);
  const dv = new DataView(buf.buffer);
  const segCmdSize = 72 + 2 * 80; // 232
  const verCmdSize = 16;
  const loadCommandsSize = segCmdSize + verCmdSize; // 248

  dv.setUint32(0, 0xfeedfacf, true); // MH_MAGIC_64
  dv.setUint32(4, 0x01000007, true); // CPU_TYPE_X86_64
  dv.setUint32(8, 3, true);
  dv.setUint32(12, 2, true); // MH_EXECUTE
  dv.setUint32(16, 2, true); // ncmds
  dv.setUint32(20, loadCommandsSize, true);

  // LC_SEGMENT_64 at offset 32
  const seg = 32;
  dv.setUint32(seg, 0x19, true);
  dv.setUint32(seg + 4, segCmdSize, true);
  for (let i = 0; i < 6; i++) buf[seg + 8 + i] = '__TEXT'.charCodeAt(i);
  dv.setBigUint64(seg + 24, BigInt(segVmAddr), true);
  dv.setBigUint64(seg + 32, BigInt(segVmSize), true);
  dv.setBigUint64(seg + 40, BigInt(segFileOff), true);
  dv.setBigUint64(seg + 48, BigInt(segFileSize), true);
  dv.setUint32(seg + 64, 2, true); // nsects

  const writeSec = (off, name, segName, addr, size, fileOff) => {
    for (let i = 0; i < name.length; i++) buf[off + i] = name.charCodeAt(i);
    for (let i = 0; i < segName.length; i++) buf[off + 16 + i] = segName.charCodeAt(i);
    dv.setBigUint64(off + 32, BigInt(addr), true);
    dv.setBigUint64(off + 40, BigInt(size), true);
    dv.setUint32(off + 48, fileOff, true);
  };
  writeSec(seg + 72, '__text', '__TEXT', textAddr, textSize, textOff);
  writeSec(seg + 72 + 80, '__const', '__TEXT', sec2Addr, sec2Size, sec2Off);

  // LC_VERSION_MIN_MACOSX at seg + segCmdSize
  const ver = seg + segCmdSize;
  dv.setUint32(ver, 0x24, true);
  dv.setUint32(ver + 4, verCmdSize, true);
  dv.setUint32(ver + 8, 0x000a0f00, true);
  dv.setUint32(ver + 12, 0x000a0f00, true);
  return buf;
}

function buildMinimalElf64({ phEntSize = 56, phCount = 0, overlapShstrtabTail = false } = {}) {
  // Layout:
  // 0x00..0x3f: ELF64 header
  // 0x40..0x47: .comment ("hi\0\0\0\0\0\0")
  // 0x48..0x5c: .shstrtab ("\0.comment\0.shstrtab\0") -> 20 bytes (0x48..0x5b)
  // 0x5c..0x60: 5 zero bytes for ".bss\0" -> shoff = 0x61? align to 8 -> let's place .shstrtab at 0x48, len=20 (0x48..0x5c),
  //   plus 5 bytes ".bss\0" -> 0x61... wait: 0x48 + 20 + 5 = 0x61; to make source.length + 64 aligned to 8,
  //   make shstrtab start at 0x4b (len 20 -> ends 0x5f), + 5 = 0x64, shoff = 0x64, 3 sections * 64 = 192 -> total = 0x124 (not %8).
  //   Let's make shstrtab start at 0x4f (len 20 -> ends 0x63), + 5 = 0x68 (multiple of 8!), shoff = 0x68, 3*64 = 192 -> total = 0x128 (multiple of 8!).
  const strtabBytes = new TextEncoder().encode('\0.comment\0.shstrtab\0'); // 20 bytes
  const strtabOff = 0x4f;
  const shoff = strtabOff + strtabBytes.length + 5; // 0x68
  const secCount = overlapShstrtabTail ? 4 : 3;
  const totalLen = shoff + secCount * 64;
  const buf = new Uint8Array(totalLen);
  const dv = new DataView(buf.buffer);

  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  dv.setUint16(16, 2, true); // ET_EXEC
  dv.setUint16(18, 0x3e, true); // x86_64
  dv.setUint32(20, 1, true);
  dv.setBigUint64(32, phCount > 0 ? 0x40n : 0n, true); // phoff
  dv.setBigUint64(40, BigInt(shoff), true); // shoff
  dv.setUint16(52, 64, true); // ehsize
  dv.setUint16(54, phEntSize, true); // phentsize
  dv.setUint16(56, phCount, true); // phnum
  dv.setUint16(58, 64, true); // shentsize
  dv.setUint16(60, secCount, true); // shnum
  dv.setUint16(62, secCount - 1, true); // shstrndx (terminal!)

  // .comment at 0x40 (8 bytes)
  buf.set(new TextEncoder().encode('ok\0'), 0x40);
  buf.set(strtabBytes, strtabOff);

  const writeShdr = (idx, nameOff, type, off, size) => {
    const base = shoff + idx * 64;
    dv.setUint32(base, nameOff, true);
    dv.setUint32(base + 4, type, true);
    dv.setBigUint64(base + 24, BigInt(off), true);
    dv.setBigUint64(base + 32, BigInt(size), true);
  };
  writeShdr(0, 0, 0, 0, 0); // SHT_NULL
  writeShdr(1, 1, 1, 0x40, 8); // .comment (SHT_PROGBITS)
  if (overlapShstrtabTail) {
    // Section 2 overlaps [strtabOff + 20, strtabOff + 25) with zero bytes
    writeShdr(2, 1, 1, strtabOff + strtabBytes.length, 4);
    writeShdr(3, 10, 3, strtabOff, strtabBytes.length); // .shstrtab terminal
  } else {
    writeShdr(2, 10, 3, strtabOff, strtabBytes.length); // .shstrtab terminal
  }
  return buf;
}

// =============================================================================
// 1. js/analysis/pointsto/alias.js
// =============================================================================
test('pointsToAlias: same rootEntityId under distinct rootKey is NOT falsely separated by nonEscapingRoots', () => {
  const status = createAnalysisStatus({
    snapshotId: 'snap-wave4-d',
    analyzerId: 'pointsto-wave4',
    analyzerVersion: '1',
    completeness: 'complete',
  });
  const a = createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'heap-like',
    rootIdentity: 'alloc_view_a',
    rootEntityId: 'entity:alloc:1',
    offsetRange: exactRange(0),
    widthBits: 64,
  });
  const b = createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'heap-like',
    rootIdentity: 'alloc_view_b',
    rootEntityId: 'entity:alloc:1',
    offsetRange: exactRange(0),
    widthBits: 64,
  });
  assert.notEqual(a.rootKey, b.rootKey);
  const res = pointsToAlias(
    createPointsToSet({ targets: [a] }),
    createPointsToSet({ targets: [b] }),
    { status, widthBitsLeft: 64, widthBitsRight: 64, nonEscapingRoots: new Set(['entity:alloc:1']) },
  );
  assert.equal(res.relation, 'may');
  assert.ok(!res.reasonCodes.includes('distinct-non-escaping-allocation'));
});

test('pointsToAlias: non-singleton absolute interval with exact:true never produces false MustAlias', () => {
  const status = createAnalysisStatus({
    snapshotId: 'snap-wave4-d-must',
    analyzerId: 'pointsto-wave4',
    analyzerVersion: '1',
    completeness: 'complete',
  });
  // Raw uncanonicalized target objects simulating caller bypass
  const left = {
    top: false,
    lossReasons: [],
    targets: [{
      rootKey: 'k1',
      addressSpace: 'memory',
      address: '4096',
      widthBits: 64,
      offsetRange: { min: 0n, max: 16n, exact: true },
    }],
  };
  const right = {
    top: false,
    lossReasons: [],
    targets: [{
      rootKey: 'k2',
      addressSpace: 'memory',
      address: '4096',
      widthBits: 64,
      offsetRange: { min: 0n, max: 16n, exact: true },
    }],
  };
  const res = pointsToAlias(left, right, { status, widthBitsLeft: 64, widthBitsRight: 64 });
  assert.notEqual(res.relation, 'must');
  assert.equal(res.relation, 'may');
});

test('pointsToAlias: malformed non-bigint range and missing lossReasons/targets fail closed without throwing', () => {
  const status = createAnalysisStatus({
    snapshotId: 'snap-wave4-d-guard',
    analyzerId: 'pointsto-wave4',
    analyzerVersion: '1',
    completeness: 'complete',
  });
  const topMissingLoss = pointsToAlias({ top: true }, { top: false, targets: [] }, { status, widthBitsLeft: 64, widthBitsRight: 64 });
  assert.equal(topMissingLoss.relation, 'unknown');

  const missingTargets = pointsToAlias({ top: false }, { top: false }, { status, widthBitsLeft: 64, widthBitsRight: 64 });
  assert.equal(missingTargets.relation, 'unknown');

  const badRange = pointsToAlias(
    { top: false, targets: [{ rootKey: 'a', addressSpace: 'memory', address: '4096', widthBits: 64, offsetRange: { min: 0, max: 4, exact: false } }] },
    { top: false, targets: [{ rootKey: 'b', addressSpace: 'memory', address: '8192', widthBits: 64, offsetRange: { min: 0, max: 4, exact: false } }] },
    { status, widthBitsLeft: 64, widthBitsRight: 64 },
  );
  assert.equal(badRange.relation, 'may');
  assert.ok(badRange.reasonCodes.includes('provenance-lost'));
});

// =============================================================================
// 2. js/analysis/recovery/shifted-ptr-spec.js
// =============================================================================
test('shifted-ptr-spec: parseShiftedTypeAnnotation handles negative hex & int32 bounds', () => {
  const negHex = parseShiftedTypeAnnotation('Child * __shifted(Parent, -0x18)');
  assert.deepEqual(negHex, { pointeeType: 'Child', parentType: 'Parent', shiftOffset: -24 });

  const bareNegHex = parseShiftedTypeAnnotation('__shifted(Parent, -0x10)');
  assert.deepEqual(bareNegHex, { pointeeType: 'Parent', parentType: 'Parent', shiftOffset: -16 });

  assert.equal(parseShiftedTypeAnnotation('__shifted(Parent, 0x80000000)'), null);
  assert.equal(parseShiftedTypeAnnotation('__shifted(Parent, -0x80000001)'), null);
});

test('shifted-ptr-spec: double-shift prevention emits unadjusted expr, negative shift preserves sign, UTF-8 fnv1a32', () => {
  const reg = new ShiftedPtrRegistry();
  assert.equal(reg.register(0x1000n, null).ok, false);
  assert.equal(reg.register(0x1000n, { varKey: 'arg:0', shiftOffset: 0x1_0000_0000 }).ok, false);
  assert.equal(reg.get(NaN, 'arg:0'), null);
  assert.equal(reg.get('not-a-va', 'arg:0'), null);

  // Thunk already adjusted -> effectiveShift === 0 -> direct member access (no double shift in expr)
  reg.register(0x1000n, {
    varKey: 'arg:0',
    parentType: 'Node',
    shiftOffset: 0x18,
    specFlags: SHIFTED_PTR_FLAGS.FROM_CXX_THUNK,
  });
  const noDouble = reg.resolveMemberAccess(0x1000n, 'arg:0', 4, {
    members: [{ name: 'id', offset: 4, size: 4, kind: 'field' }],
  }, { varName: 'p', alreadyAdjustedByThunk: true });
  assert.equal(noDouble.ok, true);
  assert.equal(noDouble.doubleShiftPrevented, true);
  assert.equal(noDouble.pathAExpr, 'p->id');
  assert.equal(noDouble.pathBC11Expr, 'p->id');

  // Invalid accessOffset fails cleanly
  assert.deepEqual(reg.resolveMemberAccess(0x1000n, 'arg:0', undefined), { ok: false, reason: 'invalid_access_offset' });

  // Negative shift preserves minus sign in HEX_CONTAINER_OF and distinguishes negative fallback name
  reg.register(0x2000n, {
    varKey: 'arg:0',
    parentType: 'Base',
    shiftOffset: -0x10,
    specFlags: SHIFTED_PTR_FLAGS.ALLOW_NEG_OFFSET,
  });
  const negRes = reg.resolveMemberAccess(0x2000n, 'arg:0', 0x8, null, { varName: 'q' });
  assert.equal(negRes.ok, true);
  assert.equal(negRes.parentOffset, -8);
  assert.equal(negRes.memberName, 'field_neg_8');
  assert.equal(negRes.pathBC11Expr, 'HEX_CONTAINER_OF(q, Base, -0x10)->field_neg_8');

  // fnv1a32: ASCII unchanged, UTF-8 multi-byte matches UTF-8 bytes
  assert.equal(fnv1a32('arg:0'), fnv1a32('arg:0'));
  const utf8Bytes = new TextEncoder().encode('あ');
  let expected = 0x811c9dc5;
  for (const b of utf8Bytes) {
    expected ^= b;
    expected = Math.imul(expected, 0x01000193) >>> 0;
  }
  assert.equal(fnv1a32('あ'), expected);
});

// =============================================================================
// 3. js/rebuild/format-safe.js
// =============================================================================
test('format-safe: PE CheckSum !== 0 rejected symmetrically in create & validate, ELF/Mach-O unaffected', () => {
  const peZero = buildMinimalPe64({ checkSum: 0 });
  const txOk = createFormatSafeRebuildTransaction({
    binaryId: 'pe-zero',
    loaderVersion: '1.0.0',
    source: peZero,
    format: 'pe',
    architecture: 'x86_64',
    mutation: { kind: 'pe-timestamp', timestamp: 0x55667788 },
  });
  assert.equal(txOk.impact.sections[0], 'COFF.TimeDateStamp');

  const peNonZero = buildMinimalPe64({ checkSum: 0x12345678 });
  assert.throws(() => createFormatSafeRebuildTransaction({
    binaryId: 'pe-nonzero',
    loaderVersion: '1.0.0',
    source: peNonZero,
    format: 'pe',
    architecture: 'x86_64',
    mutation: { kind: 'pe-timestamp', timestamp: 0x55667788 },
  }), /format-safe-pe-checksum-nonzero-unsupported/);

  // Symmetric rejection in validateFormatSafeMutation even if a transaction is replayed against non-zero CheckSum
  const peMutated = new Uint8Array(peZero);
  new DataView(peMutated.buffer).setUint32(0x80 + 8, 0x55667788, true);
  new DataView(peMutated.buffer).setUint32(0x80 + 24 + 64, 0xdeadbeef, true);
  const valRes = validateFormatSafeMutation({ transaction: txOk, original: peZero, output: peMutated });
  assert.equal(valRes.ok, false);
  assert.equal(valRes.reason, 'format-safe-pe-checksum-nonzero-unsupported');

  // Mach-O min-version impact.sections is populated (no undefined)
  const macho = buildMinimalMacho64();
  const machoTx = createFormatSafeRebuildTransaction({
    binaryId: 'macho-ver',
    loaderVersion: '1.0.0',
    source: macho,
    format: 'macho',
    architecture: 'x86_64',
    mutation: { kind: 'macho-min-version', version: 0x000b0000 },
  });
  assert.deepEqual(machoTx.impact.sections, ['LC_VERSION_MIN_MACOSX.version']);
});

test('format-safe: PE all-section VA overlap & fileAlignment power-of-2; Mach-O containment/overlap; ELF e_phentsize & shstrtab overlap', () => {
  // PE: non-power-of-2 fileAlignment rejected
  const peBadAlign = buildMinimalPe64({ fileAlignment: 0x300 });
  assert.throws(() => createFormatSafeRebuildTransaction({
    binaryId: 'pe-bad-align',
    loaderVersion: '1.0.0',
    source: peBadAlign,
    format: 'pe',
    architecture: 'x86_64',
    mutation: { kind: 'pe-section-virtual-size', virtualSize: 0x200 },
  }), /format-safe-pe-layout-alignment-invalid/);

  // PE: out-of-order section[2] overlapping .text extension rejected
  const peOverlap = buildMinimalPe64({
    extraSections: [
      { name: '.rdata', virtualSize: 0x100, virtualAddress: 0x2000, rawSize: 0x200, rawOffset: 0x400 },
      { name: '.late', virtualSize: 0x100, virtualAddress: 0x1200, rawSize: 0, rawOffset: 0 },
    ],
  });
  assert.throws(() => createFormatSafeRebuildTransaction({
    binaryId: 'pe-va-overlap',
    loaderVersion: '1.0.0',
    source: peOverlap,
    format: 'pe',
    architecture: 'x86_64',
    mutation: { kind: 'pe-section-virtual-size', virtualSize: 0x300 },
  }), /format-safe-pe-layout-section-overlap/);

  // Mach-O: target.address < segment.vmaddr rejected
  const machoBadVm = buildMinimalMacho64({ textAddr: 0x0fffff000 });
  assert.throws(() => createFormatSafeRebuildTransaction({
    binaryId: 'macho-bad-vm',
    loaderVersion: '1.0.0',
    source: machoBadVm,
    format: 'macho',
    architecture: 'x86_64',
    mutation: { kind: 'macho-section-size', size: 0x20 },
  }), /format-safe-macho-layout-source-vm-range-invalid/);

  // Mach-O: same-offset file overlap rejected
  const machoFileOverlap = buildMinimalMacho64({ sec2Off: 0x100 });
  assert.throws(() => createFormatSafeRebuildTransaction({
    binaryId: 'macho-file-overlap',
    loaderVersion: '1.0.0',
    source: machoFileOverlap,
    format: 'macho',
    architecture: 'x86_64',
    mutation: { kind: 'macho-section-size', size: 0x20 },
  }), /format-safe-macho-layout-source-overlap/);

  // ELF: invalid e_phentsize when phCount > 0 rejected
  const elfBadPh = buildMinimalElf64({ phCount: 1, phEntSize: 32 });
  assert.throws(() => createFormatSafeRebuildTransaction({
    binaryId: 'elf-bad-ph',
    loaderVersion: '1.0.0',
    source: elfBadPh,
    format: 'elf',
    architecture: 'x86_64',
    mutation: { kind: 'elf-comment', tag: 'new' },
  }), /format-safe-elf-program-header-size-invalid/);

  // ELF: .shstrtab tail overlap with another section rejected
  const elfOverlap = buildMinimalElf64({ overlapShstrtabTail: true });
  assert.throws(() => createFormatSafeRebuildTransaction({
    binaryId: 'elf-shstrtab-overlap',
    loaderVersion: '1.0.0',
    source: elfOverlap,
    format: 'elf',
    architecture: 'x86_64',
    mutation: { kind: 'elf-add-nobits-section', name: '.bss', size: 0x100, alignment: 8 },
  }), /format-safe-elf-section-name-space-overlap/);
});

// =============================================================================
// 4. js/diff/compact-function-set.js
// =============================================================================
test('compact-function-set: invalid funcs sets complete=false/invalid-function-entry, 64-bit size safe, first-wins symbols, numeric sort, leading zeros', () => {
  // Invalid entry in symbols.funcs must NOT shrink total and must mark complete=false
  const setWithInvalid = createCompactFunctionSet({
    funcs: ['0x00000000000000001000', 'not-an-addr', 0x2000],
    addrs: ['0x00000000000000001000', '0x1000', '0x2000'],
    names: ['   ', 'primary_fn', 'second_fn'],
    functionStartsComplete: true,
  }, 'arm64');
  assert.equal(setWithInvalid.total, 3);
  assert.equal(setWithInvalid.count, 2);
  assert.equal(setWithInvalid.complete, false);
  assert.equal(setWithInvalid.truncationReason, 'invalid-function-entry');

  // Leading-zero hex address normalized, whitespace name ignored, first non-empty symbol wins
  const setAliases = createCompactFunctionSet({
    funcs: ['0x00000000000000001000', 0x7fff000000001000n],
    addrs: ['0x1000', '0x1000', '0x1000'],
    names: ['   ', 'first_canonical', 'later_alias'],
    functionStartsComplete: true,
  }, 'arm64');
  assert.equal(setAliases.complete, true);
  const materialized = materializeCompactFunctionSet(setAliases);
  assert.equal(materialized[0].name, 'first_canonical');
  assert.equal(materialized[0].size, 0, 'diff > MAX_SAFE_INTEGER clamps safely to 0');

  // Numeric address sorting in demoteLowInformationAbsenceClaims across hex strings & BigInts
  const demoted = demoteLowInformationAbsenceClaims({
    deleted: [{ before: { address: '0x1000' } }],
    new: [{ after: { address: '0x200' } }],
    unresolved: [],
    changes: [
      { changeType: 'modified', before: { address: 0x300n } },
      { changeType: 'deleted', before: { address: '0x1000' } },
      { changeType: 'new', after: { address: '0x200' } },
    ],
  });
  const addrs = demoted.changes.map((c) => c.before?.address ?? c.after?.address);
  assert.deepEqual(addrs, ['0x200', 0x300n, '0x1000']);
});
