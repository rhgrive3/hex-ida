import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryByteSource } from '../../js/binary/source.js';
import { parseMachOSource } from '../../js/binary/macho-source-cache.js';
import { describeBinaryImage } from '../../js/platform/describe.js';
import { workerClient } from '../helpers/performance-worker.mjs';

function thinMachO({ cpu, subtype, vmBase, segmentName, sectionName, symbolName = '_entry' }) {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const putName = (offset, text) => bytes.set(new TextEncoder().encode(text).subarray(0, 16), offset);
  const u32 = (offset, value) => view.setUint32(offset, value, true);
  const i32 = (offset, value) => view.setInt32(offset, value, true);
  const u64 = (offset, value) => view.setBigUint64(offset, BigInt(value), true);

  u32(0, 0xfeedfacf);
  i32(4, cpu);
  i32(8, subtype);
  u32(12, 2);
  u32(16, 3);
  u32(20, 200);
  u32(24, 0);
  u32(28, 0);

  const segment = 32;
  u32(segment, 0x19); // LC_SEGMENT_64
  u32(segment + 4, 152);
  putName(segment + 8, segmentName);
  u64(segment + 24, vmBase);
  u64(segment + 32, 0x1000n);
  u64(segment + 40, 0n);
  u64(segment + 48, 0x400n);
  i32(segment + 56, 5);
  i32(segment + 60, 5);
  u32(segment + 64, 1);
  u32(segment + 68, 0);

  const section = segment + 72;
  putName(section, sectionName);
  putName(section + 16, segmentName);
  u64(section + 32, vmBase + 0x200n);
  u64(section + 40, 0x20n);
  u32(section + 48, 0x200);
  u32(section + 52, 2);
  u32(section + 56, 0);
  u32(section + 60, 0);
  u32(section + 64, 0x80000400);
  u32(section + 68, 0);
  u32(section + 72, 0);
  u32(section + 76, 0);

  const main = segment + 152;
  u32(main, 0x80000028); // LC_MAIN
  u32(main + 4, 24);
  u64(main + 8, 0x200n);
  u64(main + 16, 0n);

  const symtab = main + 24;
  u32(symtab, 0x2); // LC_SYMTAB
  u32(symtab + 4, 24);
  u32(symtab + 8, 0x240);
  u32(symtab + 12, 1);
  u32(symtab + 16, 0x250);
  u32(symtab + 20, 0x40);

  u32(0x240, 1);
  bytes[0x244] = 0x0f; // N_SECT | N_EXT
  bytes[0x245] = 1;
  view.setUint16(0x246, 0, true);
  u64(0x248, vmBase + 0x200n);
  bytes[0x250] = 0;
  bytes.set(new TextEncoder().encode(symbolName), 0x251);
  bytes[0x251 + symbolName.length] = 0;

  bytes.fill(0x90, 0x200, 0x220);
  return bytes;
}

function fatFixture({
  x86VmBase = 0x100000000n,
  armVmBase = 0x200000000n,
  x86Segment = '__X86',
  armSegment = '__ARM',
} = {}) {
  const x86 = thinMachO({
    cpu:0x01000007, subtype:3, vmBase:x86VmBase,
    segmentName:x86Segment, sectionName:'__x86text', symbolName:'_only_x86',
  });
  const arm = thinMachO({
    cpu:0x0100000c, subtype:0, vmBase:armVmBase,
    segmentName:armSegment, sectionName:'__armtext', symbolName:'_only_arm',
  });
  const bytes = new Uint8Array(0x9000);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xcafebabe, false);
  view.setUint32(4, 2, false);
  const addSlice = (offset, cpu, subtype, fileOffset, size) => {
    view.setUint32(offset, cpu, false);
    view.setUint32(offset + 4, subtype, false);
    view.setUint32(offset + 8, fileOffset, false);
    view.setUint32(offset + 12, size, false);
    view.setUint32(offset + 16, 14, false);
  };
  addSlice(8, 0x01000007, 3, 0x4000, x86.length);
  addSlice(28, 0x0100000c, 0, 0x8000, arm.length);
  bytes.set(x86, 0x4000);
  bytes.set(arm, 0x8000);
  return bytes;
}

function itemSignature(kind, item) {
  if (kind === 'segments' || kind === 'sections') return [item.name, item.address, item.size, item.fileOffset, item.fileSize];
  if (kind === 'functions') return [item.address, item.size ?? null, item.source ?? null];
  if (kind === 'imports' || kind === 'exports' || kind === 'symbols' || kind === 'libraries' || kind === 'relocations') return item;
  throw new Error(`unexpected kind ${kind}`);
}

test('#4960 metadata uses the requested universal Mach-O slice', async () => {
  const bytes = fatFixture();
  const selected = await parseMachOSource(new MemoryByteSource(bytes), { sliceIndex:0 });
  assert.equal(selected.arch, 'x86_64');
  const expectedDescriptor = describeBinaryImage(selected, {
    name:'fat.bin',
    engine:{ arm64:false, arm64e:false, verified:false },
  });

  const client = await workerClient(new URL('../../js/platform/worker.js?issue4960', import.meta.url));
  try {
    await client.request({
      t:'open',
      file:{
        name:'fat.bin',
        size:bytes.length,
        read:async (offset, length) => bytes.subarray(Number(offset), Number(offset) + length),
      },
    });

    const defaultSummary = await client.request({ t:'metadata', kind:'summary' });
    assert.equal(defaultSummary.summary.arch, 'arm64', 'the fixture must default to the ARM64 slice');
    const defaultSymbols = await client.request({ t:'metadata', kind:'symbols' });
    assert.equal(defaultSymbols.items[0]?.name, '_only_arm', 'default metadata must retain the open-selected slice');

    await assert.rejects(
      client.request({ t:'metadata', kind:'summary', sliceIndex:0, epoch:0 }),
      /Stale platform request|platform request/i,
      'stale-epoch metadata must fail before slice selection can publish or reuse state',
    );

    const summary = await client.request({ t:'metadata', kind:'summary', sliceIndex:0 });
    assert.equal(summary.summary.arch, 'x86_64');
    assert.deepEqual(summary.capability, expectedDescriptor.capability, 'capability must describe the requested slice');
    assert.equal(summary.metadata.fat.selected.arch, 'x86_64');
    assert.equal(selected.symbols[0]?.name, '_only_x86', 'fixture must expose slice-specific symbol metadata');

    for (const kind of ['segments', 'sections', 'imports', 'exports', 'symbols', 'relocations', 'functions', 'libraries']) {
      const actual = await client.request({ t:'metadata', kind, sliceIndex:0, start:0, limit:500 });
      const expected = selected[kind] || [];
      assert.equal(actual.total, expected.length, `${kind}: selected-slice count`);
      assert.deepEqual(
        Array.from(actual.items, (item) => itemSignature(kind, item)),
        Array.from(expected, (item) => itemSignature(kind, item)),
        `${kind}: selected-slice contents`,
      );
    }

    const analysis = await client.request({ t:'analyze', sliceIndex:0 });
    assert.deepEqual(Array.from(analysis.funcs), selected.functions.map((entry) => entry.address));
    const pointer = await client.request({ t:'resolvePointer', sliceIndex:0, raw:0x100000200n });
    assert.equal(pointer, 0x100000200n, 'pointer resolution must share the same selected address universe');

    await assert.rejects(
      client.request({ t:'metadata', kind:'summary', sliceIndex:99 }),
      /Invalid Mach-O slice index|platform request/i,
    );

    const replacementBytes = fatFixture({
      x86VmBase:0x300000000n,
      armVmBase:0x400000000n,
      x86Segment:'__X86NEW',
      armSegment:'__ARMNEW',
    });
    await client.request({
      t:'open',
      file:{
        name:'replacement-fat.bin',
        size:replacementBytes.length,
        read:async (offset, length) => replacementBytes.subarray(Number(offset), Number(offset) + length),
      },
    });
    const replacementSegments = await client.request({ t:'metadata', kind:'segments', sliceIndex:0 });
    assert.equal(replacementSegments.items[0].name, '__X86NEW', 'a successful open must invalidate cached images from the previous file');
    assert.equal(replacementSegments.items[0].address, 0x300000000n);

    const thin = thinMachO({
      cpu:0x01000007, subtype:3, vmBase:0x500000000n,
      segmentName:'__THIN', sectionName:'__thintext', symbolName:'_only_thin',
    });
    await client.request({
      t:'open',
      file:{
        name:'thin.bin',
        size:thin.length,
        read:async (offset, length) => thin.subarray(Number(offset), Number(offset) + length),
      },
    });
    const thinSummary = await client.request({ t:'metadata', kind:'summary', sliceIndex:0 });
    assert.equal(thinSummary.summary.arch, 'x86_64', 'sliceIndex must not perturb non-fat binaries');
    const thinSegments = await client.request({ t:'metadata', kind:'segments', sliceIndex:0 });
    assert.equal(thinSegments.items[0].name, '__THIN');
  } finally {
    client.close();
  }
});
