import assert from 'node:assert/strict';
import { BinaryImage } from '../../../js/binary/model.js';
import { ByteView } from '../../../js/binary/reader.js';
import { parseEhFrameHeader } from '../../../js/binary/elf-unwind.js';
import { parseSourceRanges } from '../../../js/binary/source-reader.js';

const HDR_OFF = 0x20;
const HDR_VA = 0x5000n;

function putPtr(view, off, bits, value) {
  if (bits === 64) view.setBigUint64(off, BigInt(value), true);
  else view.setUint32(off, Number(BigInt(value) & 0xffffffffn), true);
}

function makeFixture({ bits = 64, target = 0x1004n, mappings, expectedDomain = 0x3000n }) {
  const bytes = new Uint8Array(0x500);
  const view = new DataView(bytes.buffer);
  bytes[HDR_OFF] = 1;
  bytes[HDR_OFF + 1] = 0x80; // DW_EH_PE_absptr | DW_EH_PE_indirect
  bytes[HDR_OFF + 2] = 0x03; // fde_count: udata4
  bytes[HDR_OFF + 3] = 0x03; // table: udata4 (unused because count=0)
  putPtr(view, HDR_OFF + 4, bits, target);
  view.setUint32(HDR_OFF + 4 + bits / 8, 0, true);

  const image = new BinaryImage(bytes, { format:'elf', arch:bits === 64 ? 'x86_64' : 'x86', bits, endian:'little' });
  for (const m of mappings) {
    image.addSegment({
      name:m.name || 'LOAD', address:m.address, size:m.size,
      fileOffset:m.fileOffset, fileSize:m.fileSize,
      perms:{ read:true, write:false, execute:false }, source:'PT_LOAD',
    });
  }
  image.addSection({
    name:'.eh_frame', address:expectedDomain, size:0x20n,
    fileOffset:0x300n, fileSize:0x20n,
    perms:{ read:true, write:false, execute:false }, source:'ELF-section',
  });
  return { bytes, view, image };
}

function parse(fixture, bits) {
  parseEhFrameHeader(
    new ByteView(fixture.bytes, { littleEndian:true }),
    { addr:HDR_VA, offset:BigInt(HDR_OFF), size:0x20n },
    fixture.image,
    bits,
    null,
  );
}

// Fully file-backed pointer inside one mapping remains valid.
{
  const f = makeFixture({
    mappings:[{ address:0x1000n, size:0x20n, fileOffset:0x100n, fileSize:0x20n }],
  });
  putPtr(f.view, 0x104, 64, 0x3000n);
  parse(f, 64);
  assert.equal(f.image.metadata.ehFrameHeader?.ehFrameAddress, 0x3000n);
  assert.equal(f.image.metadata.ehFrameHeader?.validation, 'verified');
}

// File-adjacent but VA-discontinuous mappings must not be concatenated into an
// indirect pointer. Old code starts at file 0x104 and leaks bytes from file
// 0x108 even though VA 0x1008 is unmapped.
{
  const f = makeFixture({
    expectedDomain:0x4000n,
    mappings:[
      { address:0x1000n, size:8n, fileOffset:0x100n, fileSize:8n },
      { address:0x3000n, size:8n, fileOffset:0x108n, fileSize:8n },
    ],
  });
  putPtr(f.view, 0x104, 64, 0x4000n);
  parse(f, 64);
  assert.equal(f.image.metadata.ehFrameHeader, undefined);
  assert.ok(f.image.warnings.some((w) => /DW_EH_PE_indirect target 0x1004 is not readable/.test(w)));
}

// A zero-fill tail is virtual memory, not the following raw file bytes. The
// low dword names .eh_frame and the zero-fill high dword must stay zero.
{
  const f = makeFixture({
    mappings:[{ address:0x1000n, size:0x10n, fileOffset:0x100n, fileSize:8n }],
  });
  f.view.setUint32(0x104, 0x3000, true);
  f.view.setUint32(0x108, 0xdeadbeef, true); // unrelated raw bytes after p_filesz
  parse(f, 64);
  assert.equal(f.image.metadata.ehFrameHeader?.ehFrameAddress, 0x3000n);
  assert.equal(f.image.metadata.ehFrameHeader?.validation, 'verified');
}

// VA-contiguous mappings may compose a pointer even when their raw file ranges
// are discontiguous; virtual mapping semantics, not raw adjacency, decide it.
{
  const f = makeFixture({
    mappings:[
      { address:0x1000n, size:8n, fileOffset:0x100n, fileSize:8n },
      { address:0x1008n, size:8n, fileOffset:0x200n, fileSize:8n },
    ],
  });
  f.view.setUint32(0x104, 0x3000, true);
  f.view.setUint32(0x108, 0xdeadbeef, true); // wrong raw neighbor
  f.view.setUint32(0x200, 0, true);          // true VA continuation
  parse(f, 64);
  assert.equal(f.image.metadata.ehFrameHeader?.ehFrameAddress, 0x3000n);
  assert.equal(f.image.metadata.ehFrameHeader?.validation, 'verified');
}

// ELF32 has the same whole-span requirement for a 4-byte indirect pointer.
{
  const f = makeFixture({
    bits:32,
    target:0x1002n,
    expectedDomain:0x4000n,
    mappings:[
      { address:0x1000n, size:4n, fileOffset:0x100n, fileSize:4n },
      { address:0x3000n, size:4n, fileOffset:0x104n, fileSize:4n },
    ],
  });
  putPtr(f.view, 0x102, 32, 0x4000n);
  parse(f, 32);
  assert.equal(f.image.metadata.ehFrameHeader, undefined);
  assert.ok(f.image.warnings.some((w) => /DW_EH_PE_indirect target 0x1002 is not readable/.test(w)));
}

const SOURCE_HDR_ADDR = 0x3000n;
const SOURCE_TEXT_ADDR = 0x1000n;
const SOURCE_EH_ADDR = 0x2000n;
const SOURCE_PERSONALITY_ADDR = 0x4000n;
const SOURCE_EH_OFF = 0x100;
const SOURCE_PERSONALITY_OFF = 0x280;

function makeIndirectPersonalityFixture({ mapPersonality = true } = {}) {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const u8 = (off, value) => view.setUint8(off, value);
  const u32 = (off, value) => view.setUint32(off, Number(BigInt(value) & 0xffffffffn), true);

  // .eh_frame_hdr: one direct table entry naming FDE 0x2020 for function 0x1010.
  u8(0, 1);
  u8(1, 0x03); // eh_frame_ptr: udata4
  u8(2, 0x03); // fde_count: udata4
  u8(3, 0x03); // table: udata4
  u32(4, SOURCE_EH_ADDR);
  u32(8, 1);
  u32(12, 0x1010n);
  u32(16, 0x2020n);

  // CIE at 0x2000: zPR, with an indirect udata4 personality pointer. The
  // pointer target itself lives at file offset 0x280, deliberately outside
  // the source-backed parser's initial cache.
  let p = SOURCE_EH_OFF;
  u32(p, 19); p += 4;
  u32(p, 0); p += 4;
  u8(p++, 1);
  u8(p++, 0x7a); u8(p++, 0x50); u8(p++, 0x52); u8(p++, 0);
  u8(p++, 1); u8(p++, 0x78); u8(p++, 30);
  u8(p++, 6);
  u8(p++, 0x83); // DW_EH_PE_indirect | DW_EH_PE_udata4
  u32(p, SOURCE_PERSONALITY_ADDR); p += 4;
  u8(p++, 0x03); // FDE initial location encoding: udata4

  // FDE at 0x2020, referencing the CIE and describing executable 0x1010..0x102f.
  p = SOURCE_EH_OFF + 0x20;
  u32(p, 13); p += 4;
  u32(p, 0x24); p += 4;
  u32(p, 0x1010n); p += 4;
  u32(p, 0x20n); p += 4;
  u8(p, 0);

  view.setBigUint64(SOURCE_PERSONALITY_OFF, 0x12345678n, true);

  const configure = (backing) => {
    const image = new BinaryImage(backing, { format:'elf', arch:'x86_64', bits:64, endian:'little' });
    image.addSection({
      name:'.eh_frame_hdr', address:SOURCE_HDR_ADDR, size:0x40n,
      fileOffset:0n, fileSize:0x40n,
      perms:{ read:true, write:false, execute:false }, source:'ELF-section',
    });
    image.addSection({
      name:'.text', address:SOURCE_TEXT_ADDR, size:0x80n,
      fileOffset:0x80n, fileSize:0x80n,
      perms:{ read:true, write:false, execute:true }, source:'ELF-section',
    });
    image.addSection({
      name:'.eh_frame', address:SOURCE_EH_ADDR, size:0x100n,
      fileOffset:BigInt(SOURCE_EH_OFF), fileSize:0x100n,
      perms:{ read:true, write:false, execute:false }, source:'ELF-section',
    });
    if (mapPersonality) {
      image.addSegment({
        name:'LOAD-personality', address:SOURCE_PERSONALITY_ADDR, size:0x10n,
        fileOffset:BigInt(SOURCE_PERSONALITY_OFF), fileSize:0x10n,
        perms:{ read:true, write:false, execute:false }, source:'PT_LOAD',
      });
    }
    parseEhFrameHeader(
      new ByteView(backing, { littleEndian:true }),
      { addr:SOURCE_HDR_ADDR, offset:0n, size:0x40n },
      image,
      64,
      null,
    );
    return image;
  };

  return { bytes, configure };
}

function makeSource(bytes, requests) {
  return {
    size:BigInt(bytes.length),
    maxReadLength:64,
    async read(offset, length) {
      const start = Number(offset);
      requests.push({ offset:BigInt(offset), length });
      return bytes.subarray(start, start + length);
    },
    async readExactly(offset, length) {
      return this.read(offset, length);
    },
  };
}

// Source-backed CIE/FDE consumers must propagate a missing indirect personality
// target to parseSourceRanges(), which fetches it and restarts to resident parity.
{
  const f = makeIndirectPersonalityFixture();
  const resident = f.configure(f.bytes);
  const requests = [];
  const sourceBacked = await parseSourceRanges(
    makeSource(f.bytes, requests),
    (backing) => f.configure(backing),
    {},
    {
      pageSize:8,
      maxPageSize:8,
      maxCachedBytes:0x200,
      initial:[
        { offset:0n, bytes:f.bytes.subarray(0, 0x40) },
        { offset:BigInt(SOURCE_EH_OFF), bytes:f.bytes.subarray(SOURCE_EH_OFF, SOURCE_EH_OFF + 0x40) },
      ],
    },
  );
  assert.equal(resident.metadata.ehFrameHeader?.validation, 'verified');
  assert.equal(sourceBacked.metadata.ehFrameHeader?.validation, resident.metadata.ehFrameHeader?.validation);
  assert.deepEqual(
    sourceBacked.functions.map((fn) => [fn.address, fn.source, fn.exactFunctionStart]),
    resident.functions.map((fn) => [fn.address, fn.source, fn.exactFunctionStart]),
  );
  assert.ok(
    requests.some((request) => request.offset === BigInt(SOURCE_PERSONALITY_OFF) && request.length === 8),
    'uncached indirect personality bytes must be fetched through the source-range retry path',
  );
}

// The source retry must not turn a genuinely unmapped indirect target into
// evidence: no mapping means fail closed, with no unwind function minted.
{
  const f = makeIndirectPersonalityFixture({ mapPersonality:false });
  const resident = f.configure(f.bytes);
  const requests = [];
  const sourceBacked = await parseSourceRanges(
    makeSource(f.bytes, requests),
    (backing) => f.configure(backing),
    {},
    {
      pageSize:8,
      maxPageSize:8,
      maxCachedBytes:0x200,
      initial:[
        { offset:0n, bytes:f.bytes.subarray(0, 0x40) },
        { offset:BigInt(SOURCE_EH_OFF), bytes:f.bytes.subarray(SOURCE_EH_OFF, SOURCE_EH_OFF + 0x40) },
      ],
    },
  );
  assert.equal(resident.metadata.ehFrameHeader?.validation, 'partial');
  assert.equal(sourceBacked.metadata.ehFrameHeader?.validation, 'partial');
  assert.equal(sourceBacked.metadata.ehFrameHeader?.invalidEntries, 1);
  assert.equal(sourceBacked.functions.filter((fn) => fn.source === 'unwind').length, 0);
  assert.equal(requests.length, 0, 'unmapped virtual targets must not trigger arbitrary source reads');
}

console.log('issue #4261 DW_EH_PE_indirect virtual span validation: PASS');
