import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePE } from '../../../js/binary/pe.js';

const IMAGE_BASE32 = 0x400000;
const TEXT_RVA = 0x1000;
const RDATA_RVA = 0x2000;
const LOAD_CONFIG_FILE = 0x400;
const SAFESEH_TABLE_RVA = 0x2048;
const SAFESEH_TABLE_FILE = 0x448;

function buildPE({
  machine = 0x014c,
  bits = 32,
  declaredSize = 72,
  directorySize = declaredSize,
  tableVa = IMAGE_BASE32 + SAFESEH_TABLE_RVA,
  handlers = [0x1010],
  handlerCount = handlers.length,
  textVirtualSize = 0x300,
  textRawSize = 0x200,
} = {}) {
  const bytes = new Uint8Array(0x600);
  const view = new DataView(bytes.buffer);
  const u16 = (o, x) => view.setUint16(o, x, true);
  const u32 = (o, x) => view.setUint32(o, x >>> 0, true);
  const u64 = (o, x) => view.setBigUint64(o, BigInt(x), true);
  const put = (o, s) => bytes.set(new TextEncoder().encode(s), o);

  u16(0, 0x5a4d);
  u32(0x3c, 0x80);
  u32(0x80, 0x00004550);
  const coff = 0x84;
  u16(coff + 0, machine);
  u16(coff + 2, 2);
  u16(coff + 16, bits === 64 ? 0xf0 : 0xe0);
  u16(coff + 18, bits === 64 ? 0x0022 : 0x0102);

  const opt = coff + 20;
  u16(opt + 0, bits === 64 ? 0x20b : 0x10b);
  u32(opt + 16, TEXT_RVA);
  u32(opt + 20, TEXT_RVA);
  if (bits === 64) u64(opt + 24, 0x140000000n);
  else {
    u32(opt + 24, RDATA_RVA);
    u32(opt + 28, IMAGE_BASE32);
  }
  u32(opt + 32, 0x1000);
  u32(opt + 36, 0x200);
  u32(opt + 56, 0x3000);
  u32(opt + 60, 0x200);
  u16(opt + 68, 3);
  const numberOfRvaAndSizes = bits === 64 ? opt + 108 : opt + 92;
  const dirBase = bits === 64 ? opt + 112 : opt + 96;
  u32(numberOfRvaAndSizes, 16);
  u32(dirBase + 10 * 8, RDATA_RVA);
  u32(dirBase + 10 * 8 + 4, directorySize);

  let s = opt + (bits === 64 ? 0xf0 : 0xe0);
  put(s, '.text');
  u32(s + 8, textVirtualSize);
  u32(s + 12, TEXT_RVA);
  u32(s + 16, textRawSize);
  u32(s + 20, 0x200);
  u32(s + 36, 0x60000020);
  s += 40;
  put(s, '.rdata');
  u32(s + 8, 0x200);
  u32(s + 12, RDATA_RVA);
  u32(s + 16, 0x200);
  u32(s + 20, 0x400);
  u32(s + 36, 0x40000040);

  bytes[0x200] = 0xc3;
  bytes[0x210] = 0xc3;
  bytes[0x220] = 0xc3;

  u32(LOAD_CONFIG_FILE + 0, declaredSize);
  u32(LOAD_CONFIG_FILE + 64, tableVa);
  u32(LOAD_CONFIG_FILE + 68, handlerCount);
  handlers.forEach((rva, index) => u32(SAFESEH_TABLE_FILE + index * 4, rva));
  return bytes;
}

function safeSEHSeeds(image) {
  return image.functions.filter((seed) => seed.abiMetadata?.peSafeSEH === true);
}

function reasons(image) {
  return image.metadata.peMetadata?.reasons || [];
}

test('PE32/I386 Size=72 publishes validated SafeSEH handlers without requiring GuardCF (#8166)', () => {
  const image = parsePE(buildPE());
  assert.deepEqual(image.metadata.loadConfig.safeSEHHandlers, [0x401010n]);
  assert.equal(image.metadata.loadConfig.safeSEHHandlerTable, 0x402048n);
  assert.equal(image.metadata.loadConfig.safeSEHHandlerCount, 1n);
  assert.equal(safeSEHSeeds(image).length, 1);
  assert.equal(safeSEHSeeds(image)[0].address, 0x401010n);
  assert.equal(safeSEHSeeds(image)[0].source, 'exception');
  assert.equal(safeSEHSeeds(image)[0].exactFunctionStart, true);
  assert.equal(image.metadata.peMetadata.complete, true);
});

test('multiple sorted unique handlers are retained and promoted (#8166)', () => {
  const image = parsePE(buildPE({ handlers: [0x1010, 0x1020] }));
  assert.deepEqual(image.metadata.loadConfig.safeSEHHandlers, [0x401010n, 0x401020n]);
  assert.deepEqual(safeSEHSeeds(image).map((seed) => seed.address), [0x401010n, 0x401020n]);
  assert.equal(image.metadata.peMetadata.complete, true);
});

test('SafeSEH count beyond the mapped table capacity is partial and fail-closed (#8166)', () => {
  const handlers = Array.from({ length: 110 }, (_, index) => 0x1010 + index);
  const image = parsePE(buildPE({ handlers, handlerCount: 111 }));
  assert.equal(safeSEHSeeds(image).length, 0);
  assert.deepEqual(image.metadata.loadConfig.safeSEHHandlers, []);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(reasons(image).includes('load-config:safeseh-count-span'));
});

test('unmapped SafeSEH table VA is partial and publishes no authority (#8166)', () => {
  const image = parsePE(buildPE({ tableVa: IMAGE_BASE32 + 0x3000 }));
  assert.equal(safeSEHSeeds(image).length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(reasons(image).includes('load-config:safeseh-table-span'));
});

test('descending or duplicate SafeSEH RVAs invalidate the whole table (#8166)', () => {
  for (const handlers of [[0x1020, 0x1010], [0x1010, 0x1010]]) {
    const image = parsePE(buildPE({ handlers }));
    assert.equal(safeSEHSeeds(image).length, 0);
    assert.deepEqual(image.metadata.loadConfig.safeSEHHandlers, []);
    assert.equal(image.metadata.peMetadata.complete, false);
    assert.ok(reasons(image).includes('load-config:safeseh-order'));
  }
});

test('non-executable and zero-fill-only handlers are partial and fail-closed (#8166)', () => {
  const nonExecutable = parsePE(buildPE({ handlers: [0x2050] }));
  assert.equal(safeSEHSeeds(nonExecutable).length, 0);
  assert.ok(reasons(nonExecutable).includes('load-config:safeseh-target-non-executable'));

  const zeroFill = parsePE(buildPE({ handlers: [0x1200], textVirtualSize: 0x300, textRawSize: 0x200 }));
  assert.equal(safeSEHSeeds(zeroFill).length, 0);
  assert.ok(reasons(zeroFill).includes('load-config:safeseh-target-not-file-backed'));
});

test('zero SafeSEH RVA is malformed and cannot become authoritative (#8166)', () => {
  const image = parsePE(buildPE({ handlers: [0] }));
  assert.equal(safeSEHSeeds(image).length, 0);
  assert.deepEqual(image.metadata.loadConfig.safeSEHHandlers, []);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(reasons(image).includes('load-config:safeseh-target-zero'));
});

test('SafeSEH stays x86/PE32-only (#8166)', () => {
  const arm = parsePE(buildPE({ machine: 0x01c0, bits: 32 }));
  assert.equal(safeSEHSeeds(arm).length, 0);
  assert.equal(arm.metadata.loadConfig?.safeSEHHandlers, undefined);

  const x64 = parsePE(buildPE({ machine: 0x8664, bits: 64 }));
  assert.equal(safeSEHSeeds(x64).length, 0);
  assert.equal(x64.metadata.loadConfig?.safeSEHHandlers, undefined);
});

test('shared PE metadata budget stops SafeSEH before publishing partial authority (#8166)', () => {
  const image = parsePE(buildPE({ handlers: [0x1010, 0x1020] }), {
    metadataLimits: { records: 1 },
  });
  assert.equal(safeSEHSeeds(image).length, 0);
  assert.deepEqual(image.metadata.loadConfig.safeSEHHandlers, []);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(reasons(image).some((reason) => reason.startsWith('budget:safeseh-handler:records')));
});
