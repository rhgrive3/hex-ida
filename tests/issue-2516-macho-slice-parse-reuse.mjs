import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { MemoryByteSource } from '../js/binary/source.js';
import { parseMachOSource, clearMachOSourceCache } from '../js/binary/macho-source-cache.js';
import { parseMachOSource as parseMachOSourceRaw } from '../js/binary/source-loaders.js';

function fatFixture() {
  const bytes = new Uint8Array(0x300), dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0xcafebabe, false); dv.setUint32(4, 2, false);
  const CPU_ARM64 = 0x0100000c;
  const writeFat = (p, subtype, off) => {
    dv.setUint32(p, CPU_ARM64, false); dv.setUint32(p + 4, subtype, false);
    dv.setUint32(p + 8, off, false); dv.setUint32(p + 12, 32, false); dv.setUint32(p + 16, 0, false);
  };
  writeFat(8, 2, 0x100); writeFat(28, 0, 0x200);
  const writeThin = (off, subtype) => {
    dv.setUint32(off, 0xfeedfacf, true);
    dv.setInt32(off + 4, CPU_ARM64, true); dv.setInt32(off + 8, subtype, true);
    dv.setUint32(off + 12, 2, true); dv.setUint32(off + 16, 0, true);
    dv.setUint32(off + 20, 0, true); dv.setUint32(off + 24, 0, true); dv.setUint32(off + 28, 0, true);
  };
  writeThin(0x100, 2); writeThin(0x200, 0);
  return bytes;
}

const RANGES = { pageSize: 64 * 1024, maxPageSize: 2 * 1024 * 1024, maxCachedBytes: 16 * 1024 * 1024, maxReads: 4096 };

test('#2516 selected FAT slice parse is single-flight across analysis and pointer consumers', async () => {
  const bytes = fatFixture();
  const source = new MemoryByteSource(bytes);
  clearMachOSourceCache(source);

  let rawCalls = 0;
  const wrapped = {
    size: source.size,
    maxReadLength: source.maxReadLength,
    read: (offset, length, options = {}) => { rawCalls += 1; return source.read(offset, length, options); },
  };
  const workerOptions = { sliceIndex: 1, ranges: RANGES };

  const first = parseMachOSource(wrapped, { ...workerOptions });
  const second = parseMachOSource(wrapped, { ...workerOptions });
  assert.notEqual(first, second, 'distinct consumer promises are returned');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.metadata.fat.selected.offset, 0x200n);
  assert.equal(b.metadata.fat.selected.offset, 0x200n);

  const third = await parseMachOSource(wrapped, { ...workerOptions });
  assert.equal(third.metadata.fat.selected.offset, 0x200n);

  const baseline = await (async () => {
    const probeSource = new MemoryByteSource(bytes);
    clearMachOSourceCache(probeSource);
    await parseMachOSourceRaw(probeSource, { sliceIndex: 1 });
    return rawCalls;
  })();
  assert.ok(rawCalls <= baseline + 1, `reparse avoided: ${rawCalls} vs baseline ${baseline + 1}`);
  clearMachOSourceCache(source);
});

test('#2516 pointer-resolution cancellation does not destroy the shared slice parse', async () => {
  const bytes = fatFixture();
  const source = new MemoryByteSource(bytes);
  clearMachOSourceCache(source);
  const options = { sliceIndex: 1, ranges: RANGES };

  const producer = parseMachOSource(source, { ...options });
  const image = await producer;

  const victim = new AbortController();
  const cancelled = parseMachOSource(source, { ...options, signal: victim.signal });
  victim.abort();
  await assert.rejects(cancelled, (error) => error?.name === 'AbortError' || /cancelled/i.test(String(error?.message)));

  const survivor = await parseMachOSource(source, { ...options });
  assert.equal(survivor.metadata.fat.selected.offset, 0x200n);
  clearMachOSourceCache(source);
});

test('#2516 platform worker routes slice analysis/pointer work through the shared cache', () => {
  const worker = fs.readFileSync(new URL('../js/platform/worker.js', import.meta.url), 'utf8');
  assert.match(worker, /from '\.\.\/binary\/index\.js'/);
  assert.match(worker, /parseMachOSource/);
  assert.doesNotMatch(worker, /from '\.\.\/binary\/source-loaders\.js'/);
  assert.match(worker, /pointerImages/);
  const chained = fs.readFileSync(new URL('../js/chained.js', import.meta.url), 'utf8');
  assert.match(chained, /parseImage/);
});
