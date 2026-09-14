import assert from 'node:assert/strict';
import { BinaryImage } from '../../../js/binary/model.js';
import { ByteView } from '../../../js/binary/reader.js';
import { createPEMetadataBudget, parseExceptionFunctions, parseTlsDirectory, parseLoadConfig } from '../../../js/binary/pe-loader.js';

// Issue #5667: PE function-seed producers must honor the architecture's
// instruction alignment. seedValidatedEntrypoint() already rejects unaligned
// ARM64 entrypoints; TLS callbacks, GuardCF function-table entries, and ARM64
// .pdata exception ranges did not, so a crafted image could mint
// high-confidence function seeds at addresses that cannot start an
// instruction (e.g. 2 mod 4 on AArch64).

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function writePointer(bytes, offset, value, bits) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bits === 64) view.setBigUint64(offset, BigInt(value), true);
  else view.setUint32(offset, Number(BigInt(value) & 0xffffffffn), true);
}

function makeArm64Image({ machine = 0xaa64, metadata = {} } = {}) {
  const bytes = new Uint8Array(512);
  const image = new BinaryImage(bytes, { format: 'pe', bits: 64, imageBase: 0n });
  image.metadata = { ...image.metadata, ...metadata };
  // Executable .text at RVA 0x2000, file offset 64.
  image.addSection({
    name: '.text',
    address: 0x2000n,
    size: 0x100n,
    fileOffset: 64n,
    fileSize: 64n,
    perms: { read: true, write: false, execute: true },
  });
  image.addSegment({
    name: '.text',
    address: 0x2000n,
    size: 0x100n,
    fileOffset: 64n,
    fileSize: 64n,
    perms: { read: true, write: false, execute: true },
    source: 'PE-section',
  });
  // Directory metadata at RVA 0x1000 (file offset 0) must itself be mapped for
  // mappedFileSpanForRva() to accept the directory header.
  image.addSegment({
    name: '.rdata',
    address: 0x1000n,
    size: 0x100n,
    fileOffset: 0n,
    fileSize: 0x100n,
    perms: { read: true, write: false, execute: false },
  });
  return { bytes, image };
}

const ALIGN_REASONS = {
  tls: 'tls:callback-target-alignment',
  guardcf: 'load-config:guardcf-target-alignment',
  pdata: 'exception:arm64-pdata-alignment',
};

// --- 1. TLS callback array with an unaligned ARM64 target ---------------
{
  const { bytes, image } = makeArm64Image({ metadata: { machine: 0xaa64 } });
  // TLS directory header (64-bit): 40 bytes, callback array VA at offset 24.
  // Directory at RVA 0x1000 (file offset 0), callback array at RVA 0x3000
  // (file offset 256).
  writePointer(bytes, 24, 0x3000n, 64);
  // callback[0] = unaligned .text address 0x2002 (2 mod 4)
  // callback[1] = aligned .text address 0x2010 (control: still seeds)
  // callback[2] = 0 terminator
  writePointer(bytes, 256, 0x2002n, 64);
  writePointer(bytes, 264, 0x2010n, 64);
  writePointer(bytes, 272, 0n, 64);
  image.addSegment({
    name: '.tls',
    address: 0x3000n,
    size: 0x100n,
    fileOffset: 256n,
    fileSize: 0x100n,
    perms: { read: true, write: false, execute: false },
  });
  parseTlsDirectory(new ByteView(bytes), { rva: 0x1000, size: 40 }, image);
  const seeds = image.functions.filter((f) => f.source === 'tls-callback');
  assert.equal(seeds.length, 1, 'only the aligned TLS callback mints a seed');
  assert.equal(seeds[0].address, 0x2010n);
  const meta = image.metadata.peMetadata || {};
  assert.equal(meta.complete, false, 'unaligned TLS callback lowers metadata completeness');
  assert.equal((meta.reasons || []).includes(ALIGN_REASONS.tls), true);
  assert.equal(image.metadata.tls.callbacks.includes(0x2002n), false, 'unaligned target is not published as a callback');
}

// Aligned callbacks on the same image shape stay complete (control).
{
  const { bytes, image } = makeArm64Image({ metadata: { machine: 0xaa64 } });
  writePointer(bytes, 24, 0x3000n, 64);
  writePointer(bytes, 256, 0x2010n, 64);
  writePointer(bytes, 264, 0n, 64);
  image.addSegment({
    name: '.tls',
    address: 0x3000n,
    size: 0x100n,
    fileOffset: 256n,
    fileSize: 0x100n,
    perms: { read: true, write: false, execute: false },
  });
  parseTlsDirectory(new ByteView(bytes), { rva: 0x1000, size: 40 }, image);
  assert.equal(image.functions.filter((f) => f.source === 'tls-callback').length, 1);
  assert.equal((image.metadata.peMetadata || {}).complete, true, 'aligned TLS callbacks keep metadata complete');
}

// x86_64 TLS callbacks keep 1-byte alignment (no regression).
{
  const { bytes, image } = makeArm64Image({ metadata: { machine: 0x8664 } });
  writePointer(bytes, 24, 0x3000n, 64);
  writePointer(bytes, 256, 0x2003n, 64); // unaligned for ARM, fine for x86
  writePointer(bytes, 264, 0n, 64);
  image.addSegment({
    name: '.tls',
    address: 0x3000n,
    size: 0x100n,
    fileOffset: 256n,
    fileSize: 0x100n,
    perms: { read: true, write: false, execute: false },
  });
  parseTlsDirectory(new ByteView(bytes), { rva: 0x1000, size: 40 }, image);
  assert.equal(image.functions.filter((f) => f.source === 'tls-callback').length, 1, 'x86_64 TLS callbacks are not alignment-gated');
}

// --- 2. GuardCF function table with an unaligned ARM64 target -----------
{
  const { bytes, image } = makeArm64Image({ metadata: { machine: 0xaa64 } });
  // Load-config directory at RVA 0x1000 (file offset 0); 64-bit layout:
  // Size at +0, GuardCFFunctionTable at +128, GuardCFFunctionCount at +136,
  // GuardFlags at +144.
  const u64 = (o, v) => new DataView(bytes.buffer).setBigUint64(o, BigInt(v), true);
  u64(0, 152); // declared Size
  u64(128, 0x3000); // GuardCFFunctionTable VA
  u64(136, 2); // count
  u64(144, 0); // GuardFlags: extra=0 -> 4-byte entries
  // entry[0] = unaligned 0x2002, entry[1] = aligned 0x2010
  writeU32(bytes, 256, 0x2002);
  writeU32(bytes, 260, 0x2010);
  image.addSegment({
    name: '.rdata',
    address: 0x3000n,
    size: 0x100n,
    fileOffset: 256n,
    fileSize: 0x100n,
    perms: { read: true, write: false, execute: false },
  });
  parseLoadConfig(new ByteView(bytes), { rva: 0x1000, size: 152 }, image);
  const seeds = image.functions.filter((f) => f.source === 'guard-cf');
  assert.equal(seeds.length, 1, 'only the aligned GuardCF target mints a seed');
  assert.equal(seeds[0].address, 0x2010n);
  const meta = image.metadata.peMetadata || {};
  assert.equal(meta.complete, false);
  assert.equal((meta.reasons || []).includes(ALIGN_REASONS.guardcf), true);
}

// --- 3. ARM64 .pdata record whose BeginAddress is unaligned -------------
{
  const { bytes, image } = makeArm64Image({ metadata: { machine: 0xaa64 } });
  // .pdata record: Begin=0x2002 (unaligned), packed unwind Flag=1 len=1.
  writeU32(bytes, 0, 0x2002);
  writeU32(bytes, 4, 0x1 | (1 << 2)); // flag=1, FunctionLength=1 (4 bytes)
  image.addSegment({
    name: '.pdata',
    address: 0x1000n,
    size: 8n,
    fileOffset: 0n,
    fileSize: 8n,
    perms: { read: true, write: false, execute: false },
  });
  parseExceptionFunctions(new ByteView(bytes), { rva: 0x1000, size: 8 }, image, 0xaa64);
  assert.equal(image.functions.length, 0, 'unaligned .pdata range does not mint a seed');
  const meta = image.metadata.peMetadata || {};
  assert.equal(meta.complete, false);
  assert.equal((meta.reasons || []).includes(ALIGN_REASONS.pdata), true);
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 1);
}

// Aligned .pdata records still seed (control).
{
  const { bytes, image } = makeArm64Image({ metadata: { machine: 0xaa64 } });
  writeU32(bytes, 0, 0x2000);
  writeU32(bytes, 4, 0x1 | (1 << 2));
  image.addSegment({
    name: '.pdata',
    address: 0x1000n,
    size: 8n,
    fileOffset: 0n,
    fileSize: 8n,
    perms: { read: true, write: false, execute: false },
  });
  parseExceptionFunctions(new ByteView(bytes), { rva: 0x1000, size: 8 }, image, 0xaa64);
  assert.equal(image.functions.length, 1, 'aligned .pdata range still seeds');
  assert.equal(image.functions[0].address, 0x2000n);
  assert.equal((image.metadata.peMetadata || {}).complete, true);
}

// --- 4. Unaligned targets never reach image.functions from any producer --
{
  const { bytes, image } = makeArm64Image({ metadata: { machine: 0xaa64 } });
  writePointer(bytes, 24, 0x3000n, 64);
  writePointer(bytes, 256, 0x2001n, 64);
  writePointer(bytes, 264, 0n, 64);
  image.addSegment({
    name: '.tls',
    address: 0x3000n,
    size: 0x100n,
    fileOffset: 256n,
    fileSize: 0x100n,
    perms: { read: true, write: false, execute: false },
  });
  parseTlsDirectory(new ByteView(bytes), { rva: 0x1000, size: 40 }, image);
  assert.equal(image.functions.length, 0, 'no function seed at 0x2001 (1 mod 4)');
}

console.log('issue #5667 PE function-seed alignment regression: PASS');
