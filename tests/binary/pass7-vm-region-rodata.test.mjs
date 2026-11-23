import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveModelTexts } from '../../js/analyze.js';
import { workerClient } from '../helpers/performance-worker.mjs';
import { NodeBackend } from '../harness.mjs';

/**
 * Build a minimal valid ELF64 AArch64 PIE binary where non-allocable sections
 * (.symtab, .comment, .shstrtab) have sh_addr = 0 and large sizes that would
 * overlap low PIE .rodata addresses (0x7f8..0x838) if mistakenly indexed.
 */
function buildPieElfWithNonAllocSections() {
  const fileSize = 0x3000;
  const buf = new Uint8Array(fileSize);
  const dv = new DataView(buf.buffer);
  const enc = new TextEncoder();

  // ELF64 header (64 bytes at 0x0000)
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0); // ELF64, LE, v1
  dv.setUint16(16, 3, true);    // e_type = ET_DYN (PIE)
  dv.setUint16(18, 183, true);  // e_machine = EM_AARCH64
  dv.setUint32(20, 1, true);    // e_version = 1
  dv.setBigUint64(24, 0x700n, true);  // e_entry
  dv.setBigUint64(32, 64n, true);     // e_phoff
  dv.setBigUint64(40, 0x2c00n, true); // e_shoff
  dv.setUint32(48, 0, true);          // e_flags
  dv.setUint16(52, 64, true);         // e_ehsize
  dv.setUint16(54, 56, true);         // e_phentsize
  dv.setUint16(56, 1, true);          // e_phnum
  dv.setUint16(58, 64, true);         // e_shentsize
  dv.setUint16(60, 7, true);          // e_shnum (NULL + 6 sections)
  dv.setUint16(62, 6, true);          // e_shstrndx = 6 (.shstrtab)

  // Program header 0: PT_LOAD covering 0x0000..0x1000 (PF_R | PF_X)
  const ph = 64;
  dv.setUint32(ph + 0, 1, true);       // p_type = PT_LOAD
  dv.setUint32(ph + 4, 5, true);       // p_flags = PF_R | PF_X
  dv.setBigUint64(ph + 8, 0n, true);   // p_offset
  dv.setBigUint64(ph + 16, 0n, true);  // p_vaddr
  dv.setBigUint64(ph + 24, 0n, true);  // p_paddr
  dv.setBigUint64(ph + 32, 0x1000n, true); // p_filesz
  dv.setBigUint64(ph + 40, 0x1000n, true); // p_memsz
  dv.setBigUint64(ph + 48, 0x1000n, true); // p_align

  // .text at 0x700 (RET = 0xd65f03c0)
  dv.setUint32(0x700, 0xd65f03c0, true);

  // .rodata at 0x7f8..0x878 (size 0x80)
  buf.set(enc.encode('A\0'), 0x7f8);
  buf[0x800] = 0x00; // "" (0-char empty string)
  buf.set(enc.encode('-1\0'), 0x808);
  dv.setFloat64(0x810, 1.5, true); // 00 00 00 00 00 00 f8 3f
  buf.set(enc.encode('B\0'), 0x838);

  // Non-allocable .symtab at file offset 0x1000, size 0x1000 (fills 0xde so shadowing is obvious)
  buf.fill(0xde, 0x1000, 0x2000);

  // Non-allocable .comment at file offset 0x2000, size 0x900
  buf.set(enc.encode('GCC: (Debian) 12.2.0\0'), 0x2000);

  // .shstrtab at file offset 0x2900
  const names = ['', '.ehdr', '.text', '.rodata', '.symtab', '.comment', '.shstrtab'];
  const nameOffsets = [];
  let cursor = 0x2900;
  for (const name of names) {
    nameOffsets.push(cursor - 0x2900);
    const bytes = enc.encode(name + '\0');
    buf.set(bytes, cursor);
    cursor += bytes.length;
  }
  const shstrtabSize = cursor - 0x2900;

  // Section header helper (64 bytes each at 0x2c00)
  function writeShdr(idx, { nameOff, type, flags, addr, offset, size, entsize = 0n }) {
    const base = 0x2c00 + idx * 64;
    dv.setUint32(base + 0, nameOff, true);
    dv.setUint32(base + 4, type, true);
    dv.setBigUint64(base + 8, flags, true);
    dv.setBigUint64(base + 16, addr, true);
    dv.setBigUint64(base + 24, offset, true);
    dv.setBigUint64(base + 32, size, true);
    dv.setUint32(base + 40, 0, true);
    dv.setUint32(base + 44, 0, true);
    dv.setBigUint64(base + 48, 8n, true);
    dv.setBigUint64(base + 56, entsize, true);
  }

  const SHF_ALLOC = 0x2n;
  const SHF_EXECINSTR = 0x4n;
  const SHF_MERGE = 0x10n;
  const SHF_STRINGS = 0x20n;

  // 0: SHT_NULL
  writeShdr(0, { nameOff: nameOffsets[0], type: 0, flags: 0n, addr: 0n, offset: 0n, size: 0n });
  // 1: .ehdr (valid SHF_ALLOC section at VA 0x0..0x40 — must NOT be excluded!)
  writeShdr(1, { nameOff: nameOffsets[1], type: 1, flags: SHF_ALLOC, addr: 0n, offset: 0n, size: 0x40n });
  // 2: .text
  writeShdr(2, { nameOff: nameOffsets[2], type: 1, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0x700n, offset: 0x700n, size: 0x10n });
  // 3: .symtab (non-allocable, placed BEFORE .rodata to prove it does not shadow .rodata)
  writeShdr(3, { nameOff: nameOffsets[4], type: 2, flags: 0n, addr: 0n, offset: 0x1000n, size: 0x1000n, entsize: 24n });
  // 4: .comment (non-allocable SHF_MERGE|SHF_STRINGS without SHF_ALLOC, also before .rodata)
  writeShdr(4, { nameOff: nameOffsets[5], type: 1, flags: SHF_MERGE | SHF_STRINGS, addr: 0n, offset: 0x2000n, size: 0x900n });
  // 5: .rodata (SHF_ALLOC at low PIE VA 0x7f8..0x878)
  writeShdr(5, { nameOff: nameOffsets[3], type: 1, flags: SHF_ALLOC, addr: 0x7f8n, offset: 0x7f8n, size: 0x80n });
  // 6: .shstrtab (non-allocable)
  writeShdr(6, { nameOff: nameOffsets[6], type: 3, flags: 0n, addr: 0n, offset: 0x2900n, size: BigInt(shstrtabSize) });

  return buf;
}

test('platform worker: non-allocable .symtab/.comment at VA 0 do not shadow PIE .rodata, while allocable VA 0 section remains mapped', async () => {
  const elf = buildPieElfWithNonAllocSections();
  const client = await workerClient(new URL('../../js/platform/worker.js?pass7track1', import.meta.url));
  try {
    await client.request({
      t: 'open',
      file: {
        name: 'pie-test.elf',
        size: elf.length,
        read: async (offset, length) => elf.subarray(Number(offset), Number(offset) + length),
      },
    });

    const at7f8 = await client.request({ t: 'readAt', addr: 0x7f8n, len: 16, text: true });
    assert.equal(at7f8.found, true);
    assert.equal(at7f8.region, '.rodata');
    assert.equal(at7f8.text, 'A');
    assert.equal(at7f8.terminated, true);

    const at800 = await client.request({ t: 'readAt', addr: 0x800n, len: 16, text: true });
    assert.equal(at800.found, true);
    assert.equal(at800.region, '.rodata');
    assert.equal(at800.text, '');
    assert.equal(at800.terminated, true);

    const at838 = await client.request({ t: 'readAt', addr: 0x838n, len: 16, text: true });
    assert.equal(at838.found, true);
    assert.equal(at838.region, '.rodata');
    assert.equal(at838.text, 'B');
    assert.equal(at838.terminated, true);

    const at810 = await client.request({ t: 'readAt', addr: 0x810n, len: 16, text: true });
    assert.equal(at810.found, true);
    assert.equal(at810.region, '.rodata');
    const dv = new DataView(at810.bytes.buffer, at810.bytes.byteOffset, 8);
    assert.equal(dv.getFloat64(0, true), 1.5);

    // Valid SHF_ALLOC section at VA 0x0 must still resolve to ELF header magic
    const atZero = await client.request({ t: 'readAt', addr: 0n, len: 4, text: false });
    assert.equal(atZero.found, true);
    assert.equal(atZero.region, '.ehdr');
    assert.deepEqual(Array.from(atZero.bytes.slice(0, 4)), [0x7f, 0x45, 0x4c, 0x46]);
  } finally {
    client.close();
  }
});

test('worker-legacy: vmToFile excludes non-allocable .symtab/.comment at VA 0 and readAt handles 0/1-char .rodata strings cleanly', async () => {
  const elf = buildPieElfWithNonAllocSections();
  // Put a non-printable byte followed by NUL at 0x840 inside .rodata
  elf[0x840] = 0x01;
  elf[0x841] = 0x00;

  const backend = new NodeBackend();
  const file = {
    name: 'pie-legacy.elf',
    size: elf.length,
    slice(start, end) {
      const part = elf.subarray(Number(start), Number(end));
      return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
    },
  };
  await backend.open(file);
  await new Promise((resolve, reject) => {
    const prev = globalThis.self.postMessage;
    globalThis.self.postMessage = (msg) => {
      if (msg && msg.id === 999999) {
        globalThis.self.postMessage = prev;
        if (msg.t === "ok") resolve(msg.result);
        else reject(new Error(msg.error || "setRegions failed"));
      } else if (prev) {
        prev(msg);
      }
    };
    globalThis.self.onmessage({
      data: {
        id: 999999,
        t: "setRegions",
        regions: [
    { id: 'symtab', kind: 'section', name: '.symtab', section: '.symtab', vmAddr: 0n, fileOffset: 0x1000n, size: 0x1000n, read: false, write: false, exec: false, zerofill: false },
    { id: 'comment', kind: 'section', name: '.comment', section: '.comment', vmAddr: 0n, fileOffset: 0x2000n, size: 0x900n, source: 'section-header', flags: 0x30n, zerofill: false },
    { id: 'ehdr', kind: 'section', name: '.ehdr', section: '.ehdr', vmAddr: 0n, fileOffset: 0n, size: 0x40n, source: 'section-header', flags: 0x2n, read: true, zerofill: false },
    { id: 'rodata', kind: 'section', name: '.rodata', section: '.rodata', vmAddr: 0x7f8n, fileOffset: 0x7f8n, size: 0x80n, source: 'section-header', flags: 0x2n, read: true, zerofill: false },
        ],
      },
    });
  });

  const at7f8 = await backend.readAt(0x7f8n, 16, true);
  assert.equal(at7f8.found, true);
  assert.equal(at7f8.region, '.rodata');
  assert.equal(at7f8.text, 'A');
  assert.equal(at7f8.terminated, true);

  const at800 = await backend.readAt(0x800n, 16, true);
  assert.equal(at800.found, true);
  assert.equal(at800.region, '.rodata');
  assert.equal(at800.text, '');
  assert.equal(at800.terminated, true);

  const at838 = await backend.readAt(0x838n, 16, true);
  assert.equal(at838.found, true);
  assert.equal(at838.region, '.rodata');
  assert.equal(at838.text, 'B');
  assert.equal(at838.terminated, true);

  // Non-printable byte before NUL must NOT look like a terminated empty string
  const at840 = await backend.readAt(0x840n, 16, true);
  assert.equal(at840.found, true);
  assert.equal(at840.terminated, false);

  // Allocable VA 0 section still resolves
  const atZero = await backend.readAt(0n, 4, false);
  assert.equal(atZero.found, true);
  assert.equal(atZero.region, '.ehdr');
  assert.deepEqual(Array.from(atZero.bytes.slice(0, 4)), [0x7f, 0x45, 0x4c, 0x46]);
});

test('resolveModelTexts: resolves 0-char and 1-char .rodata strings for direct refs and preserves raw FP bytes for .rodata loads', async () => {
  const doubleBytes = new Uint8Array(8);
  new DataView(doubleBytes.buffer).setFloat64(0, 1.0, true); // starts with 0x00!
  const floatBytes = new Uint8Array(4);
  new DataView(floatBytes.buffer).setFloat32(0, 3.5, true);
  const dataBytes = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f]);

  const memory = new Map([
    ['2040', { found: true, region: '.rodata', bytes: new Uint8Array([0x41, 0x00]), text: 'A', terminated: true }],          // 0x7f8
    ['2048', { found: true, region: '.rodata', bytes: new Uint8Array([0x00, 0x42]), text: '', terminated: true }],           // 0x800 ("")
    ['2056', { found: true, region: '.rodata', bytes: new Uint8Array([0x2d, 0x31, 0x00]), text: '-1', terminated: true }],   // 0x808 ("-1")
    ['2064', { found: true, region: '.rodata', bytes: new Uint8Array([0x01, 0x00]), text: '', terminated: true }],           // 0x810 (non-printable)
    ['2072', { found: true, region: '.rodata', bytes: doubleBytes, text: '', terminated: true }],                            // 0x818 (double 1.0 load)
    ['2080', { found: true, region: '.rodata.cst4', bytes: floatBytes, text: '', terminated: true }],                        // 0x820 (float 3.5f load)
    ['4096', { found: true, region: '.data', bytes: dataBytes, text: '', terminated: true }],                                // 0x1000 (.data empty/load)
  ]);

  const backend = {
    async readAt(addr) {
      return memory.get(BigInt(addr).toString()) || { found: false };
    },
  };

  const makeValue = () => ({ kind: 'addr', ev: [] });
  const model = {
    addressRefs: [
      { row: 1, addr: 0x7f8n, value: makeValue() },              // direct "A"
      { row: 2, addr: 0x800n, value: makeValue() },              // direct ""
      { row: 3, addr: 0x808n, value: makeValue() },              // direct "-1"
      { row: 4, addr: 0x810n, value: makeValue() },              // direct non-printable
      { row: 5, addr: 0x818n, value: makeValue(), load: true },  // .rodata double 1.0 load
      { row: 6, addr: 0x820n, value: makeValue(), load: true },  // .rodata.cst4 float 3.5f load
      { row: 7, addr: 0x1000n, value: makeValue() },             // .data direct (must NOT resolve "")
      { row: 8, addr: 0x1000n, value: makeValue(), load: true }, // .data load (must NOT preserve bytes)
    ],
    semantic: [],
    facts: {
      stringRefs: [
        { row: 1, addr: 0x7f8n },
        { row: 2, addr: 0x800n },
        { row: 3, addr: 0x808n },
      ],
      strings: [],
    },
    calls: [],
  };

  await resolveModelTexts(backend, model, 96, { architecture: 'arm64' });

  // 1-char "A"
  assert.equal(model.addressRefs[0].text, 'A');
  assert.equal(model.addressRefs[0].value.kind, 'string');
  assert.equal(model.addressRefs[0].value.text, 'A');

  // 0-char ""
  assert.equal(model.addressRefs[1].text, '');
  assert.equal(model.addressRefs[1].value.kind, 'string');
  assert.equal(model.addressRefs[1].value.text, '');

  // 2-char "-1"
  assert.equal(model.addressRefs[2].text, '-1');

  // Non-printable [0x01, 0x00] in .rodata must NOT be treated as ""
  assert.equal(model.addressRefs[3].text, undefined);

  // .rodata double 1.0 load: NOT misclassified as "", raw 8 bytes preserved
  assert.equal(model.addressRefs[4].text, undefined);
  assert.deepEqual(model.addressRefs[4].bytes, Array.from(doubleBytes));
  assert.equal(new DataView(Uint8Array.from(model.addressRefs[4].bytes).buffer).getFloat64(0, true), 1.0);

  // .rodata.cst4 float 3.5f load: raw 4 bytes preserved
  assert.equal(model.addressRefs[5].text, undefined);
  assert.deepEqual(model.addressRefs[5].bytes, Array.from(floatBytes));
  assert.equal(new DataView(Uint8Array.from(model.addressRefs[5].bytes).buffer).getFloat32(0, true), 3.5);

  // .data direct ref: NOT resolved as empty string
  assert.equal(model.addressRefs[6].text, undefined);

  // .data load: NOT preserved as read-only literal bytes
  assert.equal(model.addressRefs[7].bytes, undefined);

  // facts.strings includes all three resolved direct .rodata strings including ""
  assert.deepEqual(model.facts.strings, ['A', '', '-1']);
});
