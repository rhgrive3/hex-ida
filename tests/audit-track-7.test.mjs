import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { ByteView } from '../js/binary/reader.js';
import { parseLoadConfig, mappedFileRangeForRva, mappedFileSpanForRva } from '../js/binary/pe-loader.js';
import { parseSafeSEHLoadConfig } from '../js/binary/pe-safeseh.js';
import { parseCHPELoadConfig } from '../js/binary/pe-chpe.js';
import { demangleRustSymbol } from '../js/metadata/rust.js';
import { parseMachO } from '../js/binary/macho-core.js';
import { applyMachOTlvInitializers } from '../js/binary/macho-tlv-init.js';
import { parsePclntabHeader, parseGoFunctions, parseGoTypeDescriptor } from '../js/metadata/go.js';

function loadLegacyMachO() {
  const code = fs.readFileSync(new URL('../js/macho.js', import.meta.url), 'utf8');
  const ctx = {
    BigInt,
    DataView,
    Uint8Array,
    Int32Array,
    Uint32Array,
    ArrayBuffer,
    TextDecoder,
    Map,
    Set,
    Math,
    Number,
    String,
    Array,
    Object,
    Error,
    RangeError,
    TypeError,
    console,
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.runInNewContext(code, ctx, { filename: 'js/macho.js' });
  return ctx.MachO;
}

function makeBudgetRecorder() {
  const partials = [];
  const budget = {
    stopped: false,
    take: () => true,
    partial: (reason, msg) => partials.push({ reason, msg }),
  };
  return { budget, partials };
}

// ---------------------------------------------------------------------------
// [T7-P0-1] 切詰め PE Load Config の OOB リード防止
// ---------------------------------------------------------------------------
test('T7-P0-1: parseLoadConfig prevents OOB reads on truncated header/directory and avoids duplicate directory-span', () => {
  // Case 1: mapped header span exceeds underlying buffer length
  {
    const buf = new Uint8Array(0x202); // only 2 bytes at offset 0x200
    const r = new ByteView(buf, { littleEndian: true });
    const { budget, partials } = makeBudgetRecorder();
    const image = {
      format: 'pe',
      bits: 64,
      arch: 'x86_64',
      imageBase: 0x140000000n,
      sections: [{ name: '.rdata', address: 0x140001000n, size: 0x1000n, fileOffset: 0x200n, fileSize: 0x1000n }],
      segments: [],
      functions: [],
      warnings: [],
      metadata: { machine: 0x8664 },
    };
    assert.doesNotThrow(() => parseLoadConfig(r, { rva: 0x1000, size: 208 }, image, budget));
    assert.ok(partials.some((p) => p.reason === 'load-config:truncated'));
  }

  // Case 2: declared < 4 (internalSize = 2) -> records load-config:truncated, no OOB
  {
    const buf = new Uint8Array(0x400);
    new DataView(buf.buffer).setUint32(0x200, 2, true);
    const r = new ByteView(buf, { littleEndian: true });
    const { budget, partials } = makeBudgetRecorder();
    const image = {
      format: 'pe',
      bits: 64,
      arch: 'x86_64',
      imageBase: 0x140000000n,
      sections: [{ name: '.rdata', address: 0x140001000n, size: 0x100n, fileOffset: 0x200n, fileSize: 0x100n }],
      segments: [],
      functions: [],
      warnings: [],
      metadata: { machine: 0x8664 },
    };
    assert.doesNotThrow(() => parseLoadConfig(r, { rva: 0x1000, size: 208 }, image, budget));
    assert.ok(partials.some((p) => p.reason === 'load-config:truncated'));
  }

  // Case 3: mapped section is smaller than declared size -> directory-span recorded once, no OOB in SafeSEH/CHPE
  {
    const buf = new Uint8Array(0x210);
    new DataView(buf.buffer).setUint32(0x200, 208, true);
    const r = new ByteView(buf, { littleEndian: true });
    const { budget, partials } = makeBudgetRecorder();
    const image = {
      format: 'pe',
      bits: 64,
      arch: 'x86_64',
      imageBase: 0x140000000n,
      sections: [{ name: '.rdata', address: 0x140001000n, size: 0x10n, fileOffset: 0x200n, fileSize: 0x10n }],
      segments: [],
      functions: [],
      warnings: [],
      metadata: { machine: 0x8664 },
    };
    assert.doesNotThrow(() => parseLoadConfig(r, { rva: 0x1000, size: 208 }, image, budget));
    const spanPartials = partials.filter((p) => p.reason === 'load-config:directory-span');
    assert.equal(spanPartials.length, 1);
  }
});

test('T7-P0-1: standalone parseSafeSEHLoadConfig & parseCHPELoadConfig guard truncated inputs without penalizing non-target/small configs', () => {
  // SafeSEH truncated buffer
  {
    const r = new ByteView(new Uint8Array(40), { littleEndian: true });
    const { budget, partials } = makeBudgetRecorder();
    const image = { bits: 32, imageBase: 0x400000n, functions: [], metadata: { machine: 0x014c } };
    assert.doesNotThrow(() => parseSafeSEHLoadConfig(r, 0, 72, image, budget, mappedFileRangeForRva, mappedFileSpanForRva));
    assert.ok(partials.some((p) => p.reason === 'load-config:truncated'));
  }

  // SafeSEH non-target machine & small valid size -> no partial
  {
    const r = new ByteView(new Uint8Array(128), { littleEndian: true });
    const { budget, partials } = makeBudgetRecorder();
    const image = { bits: 64, imageBase: 0x140000000n, functions: [], metadata: { machine: 0x8664 } };
    parseSafeSEHLoadConfig(r, 0, 64, image, budget, mappedFileRangeForRva, mappedFileSpanForRva);
    assert.equal(partials.length, 0);
  }

  // CHPE truncated buffer -> records load-config:truncated BEFORE _chpeParsed = true
  {
    const r = new ByteView(new Uint8Array(100), { littleEndian: true });
    const { budget, partials } = makeBudgetRecorder();
    const image = { format: 'pe', bits: 64, arch: 'x86_64', imageBase: 0x140000000n, metadata: {} };
    assert.doesNotThrow(() => parseCHPELoadConfig(r, 0, 208, image, budget, mappedFileRangeForRva, mappedFileSpanForRva));
    assert.ok(partials.some((p) => p.reason === 'load-config:truncated'));
    assert.notEqual(image.metadata._chpeParsed, true);
  }

  // CHPE small valid size (144 < 208 on 64-bit) -> no partial
  {
    const r = new ByteView(new Uint8Array(256), { littleEndian: true });
    const { budget, partials } = makeBudgetRecorder();
    const image = { format: 'pe', bits: 64, arch: 'x86_64', imageBase: 0x140000000n, metadata: {} };
    parseCHPELoadConfig(r, 0, 144, image, budget, mappedFileRangeForRva, mappedFileSpanForRva);
    assert.equal(partials.length, 0);
  }
});

// ---------------------------------------------------------------------------
// [T7-P0-2] Rust v0 Punycode デコーダの演算前オーバーフロー＆無限ループ防止
// ---------------------------------------------------------------------------
test('T7-P0-2: Rust v0 Punycode decoder rejects overflowing deltas without hanging or throwing', () => {
  // Huge base-36 delta that would overflow w and i to Infinity and hang adapt()
  const raw1 = '9'.repeat(30) + 'a';
  const overflowPayload = `_RCu${raw1.length}_${raw1}`;
  const t0 = Date.now();
  const res1 = demangleRustSymbol(overflowPayload);
  const elapsed = Date.now() - t0;
  assert.equal(res1.parsed, false);
  assert.equal(res1.stats.encodedBytes, raw1.length);
  assert.ok(elapsed < 500, `Expected fast rejection, took ${elapsed}ms`);

  // Overflow via high digits repeated after delimiter
  const raw2 = 'abc_' + '9'.repeat(35) + 'a';
  const overflowPayload2 = `_RCu${raw2.length}_${raw2}`;
  const res2 = demangleRustSymbol(overflowPayload2);
  assert.equal(res2.parsed, false);
  assert.equal(res2.stats.encodedBytes, raw2.length);

  // Valid Rust v0 Unicode identifier still decodes cleanly
  // "日本語" in punycode is "wgv71a119e"
  const validUnicode = demangleRustSymbol('_RCu10_wgv71a119e');
  assert.equal(validUnicode.parsed, true);
  assert.equal(validUnicode.demangled, '日本語');
});

// ---------------------------------------------------------------------------
// [T7-P1-1] Mach-O arm64_32 の4バイトポインタ幅統一（fail-closed 維持）
// ---------------------------------------------------------------------------
test('T7-P1-1: Mach-O arm64_32 uses 4-byte pointer width in interpose and TLV init while failing closed on invalid bits', () => {
  // 1. TLV initializers with arm64_32 + bits: 64 -> 4-byte pointer slots
  {
    const buf = new Uint8Array(0x200);
    const dv = new DataView(buf.buffer);
    // Two 4-byte pointers at fileOffset 0x100: target 0x100000040 (as 32-bit 0x4000 + imageBase 0)
    dv.setUint32(0x100, 0x4000, true);
    dv.setUint32(0x104, 0x4004, true);
    const image = {
      arch: 'arm64_32',
      bits: 64,
      endian: 'little',
      sections: [
        {
          name: '__thread_init',
          segment: '__DATA',
          address: 0x5000n,
          size: 8n, // 2 entries * 4 bytes
          fileOffset: 0x100n,
          fileSize: 8n,
          flags: 0x15, // S_THREAD_LOCAL_INIT_FUNCTION_POINTERS
          perms: { read: true, write: true, execute: false },
        },
        {
          name: '__text',
          segment: '__TEXT',
          address: 0x4000n,
          size: 0x20n,
          fileOffset: 0x40n,
          fileSize: 0x20n,
          flags: 0x80000000,
          perms: { read: true, write: false, execute: true },
        },
      ],
      segments: [],
      functions: [],
      warnings: [],
      metadata: {},
      sectionAt(addr) {
        return this.sections.find((s) => addr >= s.address && addr < s.address + s.size) || null;
      },
      segmentAt() { return null; },
      addressToOffset(addr) {
        const s = this.sectionAt(addr);
        if (!s) return null;
        return s.fileOffset + (addr - s.address);
      },
    };
    applyMachOTlvInitializers(buf, image);
    assert.equal(image.metadata.tlvInitializers.length, 2);
    assert.equal(image.metadata.tlvInitializers[0].address, 0x4000n);
    assert.equal(image.metadata.tlvInitializers[1].address, 0x4004n);
    assert.equal(image.metadata.tlvInitializers[0].valid, true);
    assert.equal(image.metadata.tlvInitializers[1].valid, true);
  }

  // 2. TLV initializers with arm64_32 + invalid bits (e.g. 16) -> fail-closed
  {
    const buf = new Uint8Array(0x200);
    const image = {
      arch: 'arm64_32',
      bits: 16,
      endian: 'little',
      sections: [
        {
          name: '__thread_init',
          segment: '__DATA',
          address: 0x5000n,
          size: 8n,
          fileOffset: 0x100n,
          fileSize: 8n,
          flags: 0x15,
        },
      ],
      segments: [],
      functions: [],
      warnings: [],
      metadata: {},
    };
    applyMachOTlvInitializers(buf, image);
    assert.ok(image.metadata.machoMetadata?.reasons?.includes('tlv-init:unsupported-pointer-width'));
    assert.equal(image.functions.length, 0);
  }

  // 3. Mach-O parseMachO interpose section on arm64_32 (32-bit header, 4-byte pointers)
  {
    const headerSize = 28;
    const segCmdSize = 56 + 2 * 68;
    const textOff = 0x100;
    const interposeOff = 0x120;
    const totalSize = 0x140;
    const buf = new Uint8Array(totalSize);
    const dv = new DataView(buf.buffer);
    const writeAscii = (off, s) => { for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); };

    // mach_header (32-bit, CPU_TYPE_ARM64_32 = 0x0200000c)
    dv.setUint32(0, 0xfeedface, true);
    dv.setInt32(4, 0x0200000c, true);
    dv.setInt32(8, 1, true);
    dv.setUint32(12, 2, true);
    dv.setUint32(16, 1, true);
    dv.setUint32(20, segCmdSize, true);
    dv.setUint32(24, 0, true);

    // LC_SEGMENT (0x1)
    let p = headerSize;
    dv.setUint32(p, 0x1, true);
    dv.setUint32(p + 4, segCmdSize, true);
    writeAscii(p + 8, '__TEXT');
    dv.setUint32(p + 24, 0x4000, true); // vmaddr
    dv.setUint32(p + 28, 0x200, true);  // vmsize
    dv.setUint32(p + 32, 0, true);      // fileoff
    dv.setUint32(p + 36, totalSize, true); // filesize
    dv.setInt32(p + 40, 7, true);
    dv.setInt32(p + 44, 5, true);
    dv.setUint32(p + 48, 2, true);      // nsects
    dv.setUint32(p + 52, 0, true);

    // Section 1: __text at vm 0x4100, file 0x100, size 0x20
    let q = p + 56;
    writeAscii(q, '__text');
    writeAscii(q + 16, '__TEXT');
    dv.setUint32(q + 32, 0x4100, true);
    dv.setUint32(q + 36, 0x20, true);
    dv.setUint32(q + 40, textOff, true);
    dv.setUint32(q + 44, 2, true);
    dv.setUint32(q + 56, 0x80000000, true);

    // Section 2: __interpose at vm 0x4120, file 0x120, size 8 (one 4+4 tuple)
    q += 68;
    writeAscii(q, '__interpose');
    writeAscii(q + 16, '__DATA');
    dv.setUint32(q + 32, 0x4120, true);
    dv.setUint32(q + 36, 8, true);
    dv.setUint32(q + 40, interposeOff, true);
    dv.setUint32(q + 44, 2, true);
    dv.setUint32(q + 56, 0x10, true); // S_INTERPOSING

    // Interpose tuple: replacement=0x4100, replacee=0x4104
    dv.setUint32(interposeOff, 0x4100, true);
    dv.setUint32(interposeOff + 4, 0x4104, true);

    const image = parseMachO(buf);
    assert.equal(image.arch, 'arm64_32');
    assert.equal(image.metadata.interpose.length, 1);
    assert.equal(image.metadata.interpose[0].valid, true);
    assert.equal(image.metadata.interpose[0].replacement, 0x4100n);
    assert.equal(image.metadata.interpose[0].replacee, 0x4104n);
  }
});

// ---------------------------------------------------------------------------
// [T7-P1-2] レガシー MachO.parseFat / parseSlice の切詰めヘッダ境界検査
// ---------------------------------------------------------------------------
test('T7-P1-2: legacy MachO.parseFat and parseSlice enforce header bounds', () => {
  const MachO = loadLegacyMachO();

  // parseFat: truncated (< 8 bytes) -> null
  assert.equal(MachO.parseFat(new ArrayBuffer(0), 0n), null);
  assert.equal(MachO.parseFat(new ArrayBuffer(4), 4n), null);
  assert.equal(MachO.parseFat(new ArrayBuffer(7), 7n), null);

  // parseFat: non-FAT magic -> null
  {
    const buf = new ArrayBuffer(16);
    new DataView(buf).setUint32(0, 0xfeedfacf, false);
    new DataView(buf).setUint32(4, 1, false);
    assert.equal(MachO.parseFat(buf, 16n), null);
  }

  // parseSlice: truncated 64-bit header (< 32 bytes) -> Error('Truncated Mach-O header')
  {
    const buf = new ArrayBuffer(12);
    new DataView(buf).setUint32(0, 0xfeedfacf, true);
    assert.throws(() => MachO.parseSlice(buf, 0n, 12n), /Truncated Mach-O header/);
  }

  // parseSlice: truncated 32-bit header (< 28 bytes) -> Error('Truncated Mach-O header')
  {
    const buf = new ArrayBuffer(20);
    new DataView(buf).setUint32(0, 0xfeedface, true);
    assert.throws(() => MachO.parseSlice(buf, 0n, 20n), /Truncated Mach-O header/);
  }
});

// ---------------------------------------------------------------------------
// [T7-P1-3] PE CHPE 検証完了前の image.arch 汚染抑止
// ---------------------------------------------------------------------------
test('T7-P1-3: parseCHPELoadConfig does not pollute image.arch on invalid CHPE metadata while preserving hybrid flag', () => {
  const buf = new Uint8Array(0x2000);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0x1000, 208, true);
  // Invalid pointer (unmapped VA)
  dv.setBigUint64(0x1000 + 200, 0x140099000n, true);

  const { budget, partials } = makeBudgetRecorder();
  const baseImage = {
    format: 'pe',
    bits: 64,
    arch: 'x86_64',
    imageBase: 0x140000000n,
    sections: [],
    segments: [],
    functions: [],
    metadata: { sizeOfImage: 0x4000 },
  };
  const wrapperImage = Object.create(baseImage);

  parseCHPELoadConfig(
    new ByteView(buf, { littleEndian: true }),
    0x1000,
    208,
    wrapperImage,
    budget,
    () => null,
    () => null,
  );

  assert.equal(baseImage.arch, 'x86_64');
  assert.equal(wrapperImage.arch, 'x86_64');
  assert.equal(wrapperImage.metadata.hybrid, true);
  assert.equal(baseImage.chpeCodeMap.length, 0);
  assert.ok(partials.some((p) => p.reason === 'load-config:chpe-codemap-invalid'));
});

// ---------------------------------------------------------------------------
// [T7-P2-1] MachO.stubSymbols の BigInt 乗算・reserved1 境界・クランプ＆validMapping 検証
// ---------------------------------------------------------------------------
test('T7-P2-1: MachO.stubSymbols validates validMapping, reserved1 bounds, size clamping, and BigInt address arithmetic', () => {
  const MachO = loadLegacyMachO();
  const indirectBuf = new Uint8Array(12); // 3 uint32 entries
  const dv = new DataView(indirectBuf.buffer);
  dv.setUint32(0, 0, true);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, 2, true);
  const sym = { names: ['_foo', '_bar', '_baz'] };

  const info = {
    pointerBits: 64,
    segments: [
      // Explicitly invalid segment -> skipped
      {
        validMapping: false,
        sections: [
          { stubs: true, reserved1: 0, reserved2: 12, size: 12n, addr: 0x1000n },
        ],
      },
      // Mock segment (validMapping: undefined) with mixed sections
      {
        sections: [
          // Explicitly invalid section -> skipped
          { stubs: true, validMapping: false, reserved1: 0, reserved2: 12, size: 12n, addr: 0x2000n },
          // Negative reserved1 -> skipped safely without RangeError
          { stubs: true, reserved1: -1, reserved2: 12, size: 12n, addr: 0x3000n },
          // Non-safe-integer reserved1 -> skipped
          { stubs: true, reserved1: Number.NaN, reserved2: 12, size: 12n, addr: 0x3100n },
          // Huge section size + large entSize -> clamped safely, exact BigInt addr multiplication
          { stubs: true, reserved1: 1, reserved2: 0x20000000, size: 0xffffffffffffffffn, addr: 0x100000000n },
        ],
      },
    ],
  };

  const out = MachO.stubSymbols(info, indirectBuf, sym);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, '_bar');
  assert.equal(out[0].addr, 0x100000000n);
  assert.equal(out[1].name, '_baz');
  assert.equal(out[1].addr, 0x100000000n + 0x20000000n);
});

// ---------------------------------------------------------------------------
// [T7-P2-2] Go pclntab / 型記述子の Number() 変換前 BigInt MAX_SAFE_INTEGER 境界検査
// ---------------------------------------------------------------------------
test('T7-P2-2: Go pclntab header, function entries, and type descriptors enforce MAX_SAFE_INTEGER bounds while allowing high textStart', () => {
  const OVER_MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

  // 1. Go 1.20 header with nfunc > MAX_SAFE_INTEGER -> pclntab-offset-overflow
  {
    const buf = new Uint8Array(128);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0xfffffff1, true); // Go 1.20+
    buf[6] = 1; // minLC
    buf[7] = 8; // ptrSize
    dv.setBigUint64(8, OVER_MAX_SAFE, true); // nfunc
    const h = parsePclntabHeader(buf);
    assert.equal(h.valid, false);
    assert.equal(h.reason, 'pclntab-offset-overflow');
  }

  // 2. Go 1.20 header with nfiles > MAX_SAFE_INTEGER -> pclntab-offset-overflow
  {
    const buf = new Uint8Array(128);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0xfffffff1, true);
    buf[6] = 1;
    buf[7] = 8;
    dv.setBigUint64(8, 1n, true);
    dv.setBigUint64(16, OVER_MAX_SAFE, true); // nfiles
    const h = parsePclntabHeader(buf);
    assert.equal(h.valid, false);
    assert.equal(h.reason, 'pclntab-offset-overflow');
  }

  // 3. Go 1.20 header with high canonical textStart (> MAX_SAFE_INTEGER) -> accepted as BigInt
  {
    const buf = new Uint8Array(128);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0xfffffff1, true);
    buf[6] = 1;
    buf[7] = 8;
    dv.setBigUint64(8, 0n, true); // nfunc
    dv.setBigUint64(16, 0n, true); // nfiles
    dv.setBigUint64(24, 0xffff800000401000n, true); // textStart
    dv.setBigUint64(32, 72n, true); // funcnametabOff
    dv.setBigUint64(40, 72n, true); // cutabOff
    dv.setBigUint64(48, 72n, true); // filetabOff
    dv.setBigUint64(56, 72n, true); // pctabOff
    dv.setBigUint64(64, 72n, true); // pclnOff
    const h = parsePclntabHeader(buf);
    assert.equal(h.valid, true);
    assert.equal(h.textStart, 0xffff800000401000n);
  }

  // 4. Go 1.20 table offset > MAX_SAFE_INTEGER -> invalid-table-offset with offsetName
  {
    const buf = new Uint8Array(128);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0xfffffff1, true);
    buf[6] = 1;
    buf[7] = 8;
    dv.setBigUint64(8, 0n, true);
    dv.setBigUint64(16, 0n, true);
    dv.setBigUint64(24, 0x401000n, true);
    dv.setBigUint64(32, OVER_MAX_SAFE, true); // funcnametabOff
    dv.setBigUint64(40, 72n, true);
    dv.setBigUint64(48, 72n, true);
    dv.setBigUint64(56, 72n, true);
    dv.setBigUint64(64, 72n, true);
    const h = parsePclntabHeader(buf);
    assert.equal(h.valid, false);
    assert.equal(h.reason, 'invalid-table-offset');
    assert.equal(h.offsetName, 'funcnametabOff');
  }

  // 5. Go 1.2 funcOff > MAX_SAFE_INTEGER -> counted as invalidEntries and skipped
  {
    const buf = new Uint8Array(64);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0xfffffffb, true); // Go 1.2
    buf[6] = 1;
    buf[7] = 8;
    dv.setBigUint64(8, 1n, true); // nfunc = 1
    dv.setBigUint64(16, 0x401000n, true); // entryPC
    dv.setBigUint64(24, OVER_MAX_SAFE, true); // funcOff > MAX_SAFE_INTEGER
    const h = parsePclntabHeader(buf);
    assert.equal(h.valid, true);
    const parsed = parseGoFunctions(buf, h);
    assert.equal(parsed.functions.length, 0);
    assert.equal(parsed.completeness.invalidEntries, 1);
  }

  // 6. parseGoTypeDescriptor with size or ptrdata > MAX_SAFE_INTEGER -> returns null
  {
    const buf = new Uint8Array(64);
    const dv = new DataView(buf.buffer);
    dv.setBigUint64(0, OVER_MAX_SAFE, true); // size
    dv.setBigUint64(8, 0n, true);            // ptrdata
    assert.equal(parseGoTypeDescriptor(buf, 0, { ptrSize: 8, version: '1.22' }), null);

    dv.setBigUint64(0, 16n, true);
    dv.setBigUint64(8, OVER_MAX_SAFE, true); // ptrdata
    assert.equal(parseGoTypeDescriptor(buf, 0, { ptrSize: 8, version: '1.22' }), null);
  }
});
