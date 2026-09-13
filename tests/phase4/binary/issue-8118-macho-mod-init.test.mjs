import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMachO } from '../../../js/binary/macho.js';

function buildMacho64({
  cpu = 0x0100000c, // ARM64
  subtype = 0,
  filetype = 6, // MH_DYLIB
  textAddr = 0x1000n,
  textSize = 0x1000n,
  textOffset = 0x180,
  textFileSize = 0x80,
  codeAddr = 0x1180n,
  codeBytes = [0xc0, 0x03, 0x5f, 0xd6], // ARM64 ret
  withModInit = true,
  modInitAddr = 0x2000n,
  modInitOffset = 0x200,
  modInitSize = null,
  pointers = [0x1180n],
  modInitFlags = 0x9, // S_MOD_INIT_FUNC_POINTERS
  chainedFixups = null,
} = {}) {
  const actualModInitSize = modInitSize != null ? modInitSize : (pointers.length * 8);
  const totalCmdSize = 152 + (withModInit ? 152 : 0) + (chainedFixups ? 16 : 0);
  const headerSize = 32;
  const ncmds = 1 + (withModInit ? 1 : 0) + (chainedFixups ? 1 : 0);

  const totalFileSize = 0x600;
  const bytes = new Uint8Array(totalFileSize);
  const view = new DataView(bytes.buffer);
  const u32 = (o, x) => view.setUint32(o, x, true);
  const i32 = (o, x) => view.setInt32(o, x, true);
  const u64 = (o, x) => view.setBigUint64(o, BigInt(x), true);
  const put = (o, s) => bytes.set(Buffer.from(s), o);

  // mach_header_64
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  i32(4, cpu);
  i32(8, subtype);
  u32(12, filetype);
  u32(16, ncmds);
  u32(20, totalCmdSize);
  u32(24, 0);

  let p = headerSize;

  // LC_SEGMENT_64: __TEXT + __text
  u32(p, 0x19);
  u32(p + 4, 152);
  put(p + 8, '__TEXT');
  u64(p + 24, textAddr);
  u64(p + 32, textSize);
  u64(p + 40, 0n);
  u64(p + 48, BigInt(textOffset + textFileSize));
  i32(p + 56, 5); // maxprot: r-x
  i32(p + 60, 5); // initprot: r-x
  u32(p + 64, 1); // nsects: 1
  u32(p + 68, 0);

  let q = p + 72;
  put(q, '__text');
  put(q + 16, '__TEXT');
  u64(q + 32, codeAddr);
  u64(q + 40, BigInt(codeBytes.length));
  u32(q + 48, textOffset);
  u32(q + 52, 2); // align: 2^2 = 4
  u32(q + 64, 0x80000400); // S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS

  p += 152;

  // LC_SEGMENT_64: __DATA + __mod_init_func
  if (withModInit) {
    u32(p, 0x19);
    u32(p + 4, 152);
    put(p + 8, '__DATA');
    u64(p + 24, modInitAddr);
    u64(p + 32, 0x1000n);
    u64(p + 40, BigInt(modInitOffset));
    u64(p + 48, BigInt(Math.max(actualModInitSize, 0x100)));
    i32(p + 56, 3); // maxprot: rw-
    i32(p + 60, 3); // initprot: rw-
    u32(p + 64, 1); // nsects: 1
    u32(p + 68, 0);

    q = p + 72;
    put(q, '__mod_init_func');
    put(q + 16, '__DATA');
    u64(q + 32, modInitAddr);
    u64(q + 40, BigInt(actualModInitSize));
    u32(q + 48, modInitOffset);
    u32(q + 52, 3); // align: 2^3 = 8
    u32(q + 64, modInitFlags);

    p += 152;
  }

  // LC_DYLD_CHAINED_FIXUPS (if any)
  if (chainedFixups) {
    const cfOffset = 0x400;
    const cfSize = 0x100;
    u32(p, 0x80000034);
    u32(p + 4, 16);
    u32(p + 8, cfOffset);
    u32(p + 12, cfSize);
    p += 16;

    // Build chained fixups payload at cfOffset
    const cfBase = cfOffset;
    const startsOffset = 0x20;
    u32(cfBase, 0); // fixups_version
    u32(cfBase + 4, startsOffset); // starts_offset
    u32(cfBase + 8, 0); // imports_offset
    u32(cfBase + 12, 0); // symbols_offset
    u32(cfBase + 16, 0); // imports_count
    u32(cfBase + 20, 1); // imports_format
    u32(cfBase + 24, 0); // symbols_format

    const startsBase = cfBase + startsOffset;
    u32(startsBase, 2); // seg_count: 2 (__TEXT and __DATA)
    u32(startsBase + 4, 0); // seg 0 (__TEXT) has no starts
    u32(startsBase + 8, 12); // seg 1 (__DATA) starts at rel offset 12 from startsBase

    const recBase = startsBase + 12;
    u32(recBase, 24); // size
    view.setUint16(recBase + 4, 0x1000, true); // page_size: 4KB
    view.setUint16(recBase + 6, 6, true); // pointer_format: DYLD_CHAINED_PTR_64_OFFSET
    view.setBigUint64(recBase + 8, 0x1000n, true); // segment_offset = 0x2000 - 0x1000 (imageBase = 0x1000)
    u32(recBase + 16, 0); // max_valid_pointer
    view.setUint16(recBase + 20, 1, true); // page_count: 1
    if (chainedFixups.incomplete) {
      // Misaligned or invalid start offset: crosses page boundary
      view.setUint16(recBase + 22, 0x0ffc, true);
    } else if (chainedFixups.rebaseTarget != null) {
      view.setUint16(recBase + 22, 0x0000, true); // start offset 0 in page
      // Target offset in image: target - imageBase = rebaseTarget - 0x1000
      const targetOff = BigInt(chainedFixups.rebaseTarget) - 0x1000n;
      // DYLD_CHAINED_PTR_64_OFFSET: target is 36 bits, high bits are next
      const encodedWord = (targetOff & 0xfffffffffn) | 0n;
      u64(modInitOffset, encodedWord);
    }
  }

  // Populate code
  for (let i = 0; i < codeBytes.length; i++) {
    bytes[textOffset + i] = codeBytes[i];
  }

  // Populate mod_init pointers (if not chainedFixups rebase)
  if (!chainedFixups?.rebaseTarget) {
    for (let i = 0; i < pointers.length; i++) {
      if (modInitOffset + (i + 1) * 8 <= totalFileSize) {
        u64(modInitOffset + i * 8, pointers[i]);
      }
    }
  }

  return bytes;
}

function buildMacho32({
  codeAddr = 0x1180,
  pointers = [0x1180],
} = {}) {
  const totalFileSize = 0x400;
  const bytes = new Uint8Array(totalFileSize);
  const view = new DataView(bytes.buffer);
  const u32 = (o, x) => view.setUint32(o, x, true);
  const i32 = (o, x) => view.setInt32(o, x, true);
  const put = (o, s) => bytes.set(Buffer.from(s), o);

  // mach_header 32-bit
  bytes.set([0xce, 0xfa, 0xed, 0xfe], 0);
  i32(4, 7); // CPU_TYPE_I386
  i32(8, 3); // CPU_SUBTYPE_I386_ALL
  u32(12, 6); // MH_DYLIB
  u32(16, 2); // ncmds: 2
  u32(20, 124 * 2); // sizeofcmds: 2 * (56 + 68)
  u32(24, 0);

  // LC_SEGMENT: __TEXT + __text
  let p = 28;
  u32(p, 1); // LC_SEGMENT
  u32(p + 4, 124);
  put(p + 8, '__TEXT');
  u32(p + 24, 0x1000);
  u32(p + 28, 0x1000);
  u32(p + 32, 0);
  u32(p + 36, 0x200);
  i32(p + 40, 5); // maxprot: r-x
  i32(p + 44, 5); // initprot: r-x
  u32(p + 48, 1); // nsects: 1
  u32(p + 52, 0);

  let q = p + 56;
  put(q, '__text');
  put(q + 16, '__TEXT');
  u32(q + 32, codeAddr);
  u32(q + 36, 4);
  u32(q + 40, 0x180);
  u32(q + 44, 2);
  u32(q + 56, 0x80000400);

  // LC_SEGMENT: __DATA + __mod_init_func
  p = 28 + 124;
  u32(p, 1);
  u32(p + 4, 124);
  put(p + 8, '__DATA');
  u32(p + 24, 0x2000);
  u32(p + 28, 0x1000);
  u32(p + 32, 0x200);
  u32(p + 36, 0x100);
  i32(p + 40, 3);
  i32(p + 44, 3);
  u32(p + 48, 1);
  u32(p + 52, 0);

  q = p + 56;
  put(q, '__mod_init_func');
  put(q + 16, '__DATA');
  u32(q + 32, 0x2000);
  u32(q + 36, pointers.length * 4);
  u32(q + 40, 0x200);
  u32(q + 44, 2);
  u32(q + 56, 0x9); // S_MOD_INIT_FUNC_POINTERS

  // code: x86 ret (0xc3)
  bytes[0x180] = 0xc3;

  for (let i = 0; i < pointers.length; i++) {
    u32(0x200 + i * 4, pointers[i]);
  }

  return bytes;
}

test('1. ARM64 thin Mach-O with valid S_MOD_INIT_FUNC_POINTERS -> initializer metadata + one constructor seed', () => {
  const bytes = buildMacho64({ pointers: [0x1180n] });
  const image = parseMachO(bytes);

  assert.equal(image.functions.length, 1, 'must recover exactly one function seed');
  const seed = image.functions[0];
  assert.equal(seed.address, 0x1180n);
  assert.equal(seed.source, 'constructor');
  assert.equal(seed.exactFunctionStart, true);
  assert.match(seed.functionStartEvidence, /S_MOD_INIT_FUNC_POINTERS/);

  assert.ok(Array.isArray(image.metadata.initializers), 'must record metadata.initializers');
  assert.equal(image.metadata.initializers.length, 1);
  assert.equal(image.metadata.initializers[0].address, 0x1180n);
  assert.equal(image.metadata.initializers[0].slotAddress, 0x2000n);
  assert.equal(image.metadata.initializers[0].valid, true);

  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.equal(image.warnings.length, 0);

});

test('2. Multiple valid entries -> preserve order in metadata and recover targets without duplicates', () => {
  const bytes = buildMacho64({
    pointers: [0x1180n, 0x1184n, 0x1180n],
  });
  const image = parseMachO(bytes);

  // Metadata preserves all 3 entries in exact section order
  assert.equal(image.metadata.initializers.length, 3);
  assert.equal(image.metadata.initializers[0].address, 0x1180n);
  assert.equal(image.metadata.initializers[1].address, 0x1184n);
  assert.equal(image.metadata.initializers[2].address, 0x1180n);

  // Function seeds deduplicate the target 0x1180n
  assert.equal(image.functions.length, 2);
  assert.deepEqual(image.functions.map((f) => f.address), [0x1180n, 0x1184n]);
});

test('3. Same initializer present in symbol or other evidence -> merge without losing constructor provenance', () => {
  const bytes = buildMacho64({ pointers: [0x1180n] });
  const image = parseMachO(bytes);
  assert.equal(image.functions.length, 1);

  // Add symbol seed at 0x1180n to simulate prior/concurrent evidence
  image.functions.push({
    address: 0x1180n,
    source: 'symbol',
    confidence: 0.98,
    name: '_my_ctor',
  });
  image.finalize();

  assert.equal(image.functions.length, 1);
  const merged = image.functions[0];
  assert.equal(merged.address, 0x1180n);
  assert.equal(merged.name, '_my_ctor');
  assert.ok(merged.sources.includes('constructor'), 'must preserve constructor provenance');
  assert.ok(merged.sources.includes('symbol'), 'must preserve symbol provenance');
});

test('4. ARM64 target 2 mod 4 -> retain lifecycle record, no function seed + diagnostic', () => {
  const bytes = buildMacho64({ pointers: [0x1182n] }); // 2 mod 4 misaligned
  const image = parseMachO(bytes);

  assert.equal(image.functions.length, 0, 'misaligned target must not mint a function seed');
  assert.equal(image.metadata.initializers.length, 1);
  assert.equal(image.metadata.initializers[0].valid, false);
  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(image.metadata.machoMetadata.reasons.some((r) => r.includes('mod-init')));
  assert.ok(image.warnings.some((w) => w.includes('alignment') || w.includes('misaligned') || w.includes('mod-init')));
});

test('5. Unmapped or non-executable target -> no seed + diagnostic', () => {
  const unmappedBytes = buildMacho64({ pointers: [0x999990n] });
  const imgUnmapped = parseMachO(unmappedBytes);
  assert.equal(imgUnmapped.functions.length, 0);
  assert.equal(imgUnmapped.metadata.machoMetadata.complete, false);
  assert.ok(imgUnmapped.metadata.machoMetadata.reasons.some((r) => r.includes('mod-init')));

  // Pointing to __DATA (RW, not execute)
  const nonExecBytes = buildMacho64({ pointers: [0x2000n] });
  const imgNonExec = parseMachO(nonExecBytes);
  assert.equal(imgNonExec.functions.length, 0);
  assert.equal(imgNonExec.metadata.machoMetadata.complete, false);
  assert.ok(imgNonExec.metadata.machoMetadata.reasons.some((r) => r.includes('mod-init')));
});

test('6. Target in executable zero-fill tail -> no static seed', () => {
  // __TEXT has fileSize 0x180 + 0x80 = 0x200, so [0x1200, 0x2000) is zero-fill tail
  const bytes = buildMacho64({ pointers: [0x1400n] });
  const image = parseMachO(bytes);

  assert.equal(image.functions.length, 0, 'zero-fill tail target must not mint seed');
  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(image.metadata.machoMetadata.reasons.some((r) => r.includes('mod-init')));
});

test('7. Section size not divisible by pointer width -> partial diagnostic, do not read past section', () => {
  const bytes = buildMacho64({
    pointers: [0x1180n],
    modInitSize: 12, // 12 bytes = 1 pointer (8) + 4 remainder
  });
  const image = parseMachO(bytes);

  // Still recovers the 1 full pointer
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, 0x1180n);
  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(image.metadata.machoMetadata.reasons.some((r) => r.includes('mod-init')));
});

test('8. 32-bit Mach-O -> 4-byte entry width parses correctly', () => {
  const bytes = buildMacho32({ codeAddr: 0x1180, pointers: [0x1180] });
  const image = parseMachO(bytes);

  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, 0x1180n);
  assert.equal(image.functions[0].source, 'constructor');
  assert.equal(image.metadata.initializers.length, 1);
  assert.equal(image.metadata.initializers[0].address, 0x1180n);
  assert.equal(image.metadata.machoMetadata.complete, true);
});

test('9. Chained-fixup-owned pointer slot -> resolves through Mach-O pointer authority', () => {
  // Incomplete chained fixup page: raw word must not be treated as absolute VA
  const incompleteBytes = buildMacho64({
    pointers: [0x1180n],
    chainedFixups: { incomplete: true },
  });
  const imgIncomplete = parseMachO(incompleteBytes);
  assert.equal(imgIncomplete.functions.length, 0, 'incomplete chained page slot must not fall back to raw VA');

  // Valid rebase site: resolves through chained fixup
  const rebaseBytes = buildMacho64({
    chainedFixups: { rebaseTarget: 0x1180n },
  });
  const imgRebase = parseMachO(rebaseBytes);
  assert.equal(imgRebase.functions.length, 1, 'valid rebase site must resolve to constructor seed');
  assert.equal(imgRebase.functions[0].address, 0x1180n);
  assert.equal(imgRebase.functions[0].source, 'constructor');
});

test('10. A Mach-O without an initializer section remains unchanged', () => {
  const bytes = buildMacho64({ withModInit: false });
  const image = parseMachO(bytes);

  assert.equal(image.metadata.initializers, undefined);
  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.equal(image.functions.length, 0);
});

test('11. Minimal reproduction from issue #8118 reproduces expected recovery', () => {
  const bytes = new Uint8Array(0x400);
  const v = new DataView(bytes.buffer);
  const u32 = (o, x) => v.setUint32(o, x, true);
  const i32 = (o, x) => v.setInt32(o, x, true);
  const u64 = (o, x) => v.setBigUint64(o, BigInt(x), true);
  const put = (o, s) => bytes.set(Buffer.from(s), o);

  // mach_header_64: ARM64, MH_DYLIB, two LC_SEGMENT_64 commands
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  i32(4, 0x0100000c); // CPU_TYPE_ARM64
  i32(8, 0);
  u32(12, 6); // MH_DYLIB
  u32(16, 2);
  u32(20, 304); // 2 * (segment_command_64 + section_64)

  // __TEXT + __text, file-backed RX
  let p = 32;
  u32(p, 0x19); u32(p + 4, 152); put(p + 8, '__TEXT');
  u64(p + 24, 0x1000); u64(p + 32, 0x1000);
  u64(p + 40, 0); u64(p + 48, 0x200);
  i32(p + 56, 5); i32(p + 60, 5); u32(p + 64, 1);
  let q = p + 72;
  put(q, '__text'); put(q + 16, '__TEXT');
  u64(q + 32, 0x1180); u64(q + 40, 4);
  u32(q + 48, 0x180);
  u32(q + 64, 0x80000400); // PURE/SOME_INSTRUCTIONS

  // __DATA + __mod_init_func, file-backed RW
  p = 184;
  u32(p, 0x19); u32(p + 4, 152); put(p + 8, '__DATA');
  u64(p + 24, 0x2000); u64(p + 32, 0x1000);
  u64(p + 40, 0x200); u64(p + 48, 0x100);
  i32(p + 56, 3); i32(p + 60, 3); u32(p + 64, 1);
  q = p + 72;
  put(q, '__mod_init_func'); put(q + 16, '__DATA');
  u64(q + 32, 0x2000); u64(q + 40, 8);
  u32(q + 48, 0x200);
  u32(q + 64, 0x9); // S_MOD_INIT_FUNC_POINTERS

  u32(0x180, 0xd65f03c0); // ARM64 ret
  u64(0x200, 0x1180); // initializer pointer

  const image = parseMachO(bytes);
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, 0x1180n);
  assert.equal(image.functions[0].source, 'constructor');
  assert.equal(image.warnings.length, 0);
  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.equal(image.metadata.initializers.length, 1);
  assert.equal(image.metadata.initializers[0].address, 0x1180n);
  assert.equal(image.metadata.initializers[0].valid, true);
});
