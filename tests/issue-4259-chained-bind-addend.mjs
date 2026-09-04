import assert from 'node:assert/strict';
import { chainedImportSymbols } from '../js/chained.js';
import { parseChainedImports, parseChainedBindingSites } from '../js/binary/macho-dyld.js';
import { parseMachO } from '../js/binary/macho.js';

// 1. Issue #6226: sliceIndex non-number coercion
{
  const thin = new Uint8Array(0x100);
  new DataView(thin.buffer).setUint32(0, 0xfeedfacf, true);
  const file = new Blob([thin]);

  // Thin Mach-O with valid or nullish sliceIndex
  assert.deepEqual(await chainedImportSymbols(file, 0), []);
  assert.deepEqual(await chainedImportSymbols(file, null), []);
  assert.deepEqual(await chainedImportSymbols(file, undefined), []);

  // Invalid sliceIndex must fail closed, not coerce to slice 0 or 1
  assert.deepEqual(await chainedImportSymbols(file, ['1']), []);
  assert.deepEqual(await chainedImportSymbols(file, '1'), []);
  assert.deepEqual(await chainedImportSymbols(file, true), []);
  assert.deepEqual(await chainedImportSymbols(file, {}), []);
  assert.deepEqual(await chainedImportSymbols(file, -1), []);
  assert.deepEqual(await chainedImportSymbols(file, 1.5), []);
  assert.deepEqual(await chainedImportSymbols(file, NaN), []);
  assert.deepEqual(await chainedImportSymbols(file, Infinity), []);
}

// 2. Issue #4259: inline addend unsignedness in decodeChainedPointer
{
  function testAddend(format, addendVal, expectedBigInt) {
    const bytes = new Uint8Array(0x300);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, 28, true);
    view.setUint32(28, 1, true);
    view.setUint32(32, 8, true);
    view.setUint32(36, 24, true);
    view.setUint16(40, 0x1000, true);
    view.setUint16(42, format, true);
    view.setBigUint64(44, 0n, true);
    view.setUint32(52, 0, true);
    view.setUint16(56, 1, true);
    view.setUint16(58, 0, true);

    if (format === 2 || format === 6) {
      const raw = (1n << 63n) | (BigInt(addendVal) << 24n);
      view.setBigUint64(0x100, raw, true);
    } else if (format === 3) {
      const raw32 = (1 << 31) | (addendVal << 20);
      view.setUint32(0x100, raw32, true);
    }

    const r = {
      length: bytes.length, bytes,
      u16: (o) => view.getUint16(o, true),
      u32: (o) => view.getUint32(o, true),
      u64: (o) => view.getBigUint64(o, true),
    };
    const segment = { address: 0x1000n, size: 0x1000n, fileOffset: 0x100n, fileSize: 0x200n };
    const image = {
      imageBase: 0x1000n,
      metadata: { chainedFixups: { complete: true, importsComplete: true } },
      warnings: [],
      segments: [segment],
      addressToOffset(address) { return address >= 0x1000n && address < 0x1200n ? 0x100n + (address - 0x1000n) : null; },
    };
    const imports = [{ name: '_fn', sites: [] }];
    const status = parseChainedBindingSites(r, { offset: 0, size: 0x80 }, image, imports, [segment]);
    assert.equal(status.bindingSites, 1);
    assert.equal(imports[0].sites[0].addend, expectedBigInt);
  }

  // Format 2: DYLD_CHAINED_PTR_64 (8-bit unsigned addend 0..255)
  testAddend(2, 0x00, 0n);
  testAddend(2, 0x7f, 127n);
  testAddend(2, 0x80, 128n);
  testAddend(2, 0xff, 255n);

  // Format 6: DYLD_CHAINED_PTR_64_OFFSET (8-bit unsigned addend 0..255)
  testAddend(6, 0x00, 0n);
  testAddend(6, 0x7f, 127n);
  testAddend(6, 0x80, 128n);
  testAddend(6, 0xff, 255n);

  // Format 3: DYLD_CHAINED_PTR_32 (6-bit unsigned addend 0..63)
  testAddend(3, 0x00, 0n);
  testAddend(3, 0x1f, 31n);
  testAddend(3, 0x20, 32n);
  testAddend(3, 0x3f, 63n);
}

// 3. Issue #4279: parseChainedImports format 3 (DYLD_CHAINED_IMPORT_ADDEND64) uint64 addend
{
  function testImportFormat3(addendU64, expectedBigInt) {
    const bytes = new Uint8Array(0x100);
    const dv = new DataView(bytes.buffer);
    dv.setUint32(0, 0, true);
    dv.setUint32(4, 0x80, true);
    dv.setUint32(8, 0x20, true);
    dv.setUint32(12, 0x50, true);
    dv.setUint32(16, 1, true);
    dv.setUint32(20, 3, true);
    dv.setUint32(24, 0, true);

    dv.setUint32(0x20, 1, true);
    dv.setUint32(0x24, 0, true);
    dv.setBigUint64(0x28, addendU64, true);

    new TextEncoder().encodeInto('_foo\0', bytes.subarray(0x50));

    const r = {
      bytes,
      u32: (o) => dv.getUint32(o, true),
      u64: (o) => dv.getBigUint64(o, true),
      cstring: (o, len) => '_foo',
    };
    const image = { metadata: {}, warnings: [], imports: [], libraries: ['/usr/lib/libSystem.B.dylib'] };
    const parsed = parseChainedImports(r, { offset: 0, size: 0x100 }, image);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].addend, expectedBigInt);
  }

  testImportFormat3(0x0000000000000000n, 0n);
  testImportFormat3(0x7fffffffffffffffn, 9223372036854775807n);
  testImportFormat3(0x8000000000000000n, 9223372036854775808n);
  testImportFormat3(0xffffffffffffffffn, 18446744073709551615n);
}

// 4. Issue #4266 & #4340: lib_ordinal sentinel ranges
{
  function testImportOrdinal(format, rawOrdinal, expectedLibrary, expectedOrdinal) {
    const bytes = new Uint8Array(0x100);
    const dv = new DataView(bytes.buffer);
    dv.setUint32(0, 0, true);
    dv.setUint32(4, 0x80, true);
    dv.setUint32(8, 0x20, true);
    dv.setUint32(12, 0x50, true);
    dv.setUint32(16, 1, true);
    dv.setUint32(20, format, true);
    dv.setUint32(24, 0, true);

    if (format === 1) {
      dv.setUint32(0x20, rawOrdinal, true);
    } else if (format === 3) {
      dv.setUint32(0x20, rawOrdinal, true);
      dv.setUint32(0x24, 0, true);
      dv.setBigUint64(0x28, 0n, true);
    }
    new TextEncoder().encodeInto('_sym\0', bytes.subarray(0x50));
    const r = {
      bytes,
      u32: (o) => dv.getUint32(o, true),
      u64: (o) => dv.getBigUint64(o, true),
      cstring: (o, len) => '_sym',
    };
    const libs = { [rawOrdinal - 1]: '/usr/lib/lib' + rawOrdinal + '.dylib' };
    const image = { metadata: {}, warnings: [], imports: [], libraries: libs };
    const parsed = parseChainedImports(r, { offset: 0, size: 0x100 }, image);
    assert.equal(parsed[0].library, expectedLibrary);
    assert.equal(parsed[0].ordinal, expectedOrdinal);
  }

  testImportOrdinal(1, 0x7f, '/usr/lib/lib127.dylib', 127);
  testImportOrdinal(1, 0x80, '/usr/lib/lib128.dylib', 128);
  testImportOrdinal(1, 0xf0, '/usr/lib/lib240.dylib', 240);
  testImportOrdinal(1, 0xff, '<main-executable>', -1);
  testImportOrdinal(1, 0xfe, '<flat-lookup>', -2);
  testImportOrdinal(1, 0xfd, '<weak-lookup>', -3);

  testImportOrdinal(3, 0x7fff, '/usr/lib/lib32767.dylib', 32767);
  testImportOrdinal(3, 0x8000, '/usr/lib/lib32768.dylib', 32768);
  testImportOrdinal(3, 0xfff0, '/usr/lib/lib65520.dylib', 65520);
  testImportOrdinal(3, 0xffff, '<main-executable>', -1);
  testImportOrdinal(3, 0xfffe, '<flat-lookup>', -2);
  testImportOrdinal(3, 0xfffd, '<weak-lookup>', -3);
}

// 5. Issue #4340: n_desc ordinal 253 (0xfd) maps to library 253, NOT weak-lookup
{
  const bytes = new Uint8Array(0x6000);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0xfeedfacf, true);
  dv.setInt32(4, 0x0100000c, true);
  dv.setUint32(12, 2, true);
  const numLibs = 254;
  const ncmds = numLibs + 1;
  dv.setUint32(16, ncmds, true);

  let p = 32;
  for (let i = 0; i < numLibs; i++) {
    dv.setUint32(p, 0xc, true);
    dv.setUint32(p + 4, 64, true);
    dv.setUint32(p + 8, 24, true);
    new TextEncoder().encodeInto('/usr/lib/lib' + (i + 1) + '.dylib\0', bytes.subarray(p + 24, p + 64));
    p += 64;
  }

  const symtabCmd = p;
  dv.setUint32(p, 2, true);
  dv.setUint32(p + 4, 24, true);
  const symoff = p + 24;
  const stroff = symoff + 32;
  dv.setUint32(p + 8, symoff, true);
  dv.setUint32(p + 12, 2, true);
  dv.setUint32(p + 16, stroff, true);
  dv.setUint32(p + 20, 64, true);

  dv.setUint32(symoff, 1, true);
  dv.setUint8(symoff + 4, 0x01);
  dv.setUint8(symoff + 5, 0);
  dv.setUint16(symoff + 6, 0xfd << 8, true);

  dv.setUint32(symoff + 16, 6, true);
  dv.setUint8(symoff + 20, 0x01);
  dv.setUint8(symoff + 21, 0);
  dv.setUint16(symoff + 22, 0xff << 8, true);

  new TextEncoder().encodeInto('\0_foo\0_bar\0', bytes.subarray(stroff));
  dv.setUint32(20, (symtabCmd + 24) - 32, true);

  const img = parseMachO(bytes);
  assert.equal(img.libraries.length, 254);
  const fooImp = img.imports.find((i) => i.name === '_foo');
  const barImp = img.imports.find((i) => i.name === '_bar');
  assert.ok(fooImp, 'foo import found');
  assert.ok(barImp, 'bar import found');
  assert.equal(fooImp.ordinal, 253);
  assert.equal(fooImp.library, '/usr/lib/lib253.dylib', '0xfd must resolve to library 253, NOT weak-lookup');
  assert.equal(barImp.ordinal, 255);
  assert.equal(barImp.library, '<main-executable>');
}

console.log('Mach-O chained import/addend/ordinal/slice regressions (#4259, #4266, #4279, #4340, #6226): PASS');
