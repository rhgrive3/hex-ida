import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import url from 'node:url';
import vm from 'node:vm';

// Issue #8764: worker-legacy.js::swiftReflectionFunctionStarts() followed every
// 4-byte __swift5_types entry independently. A class whose descriptor is
// aliased N times was reparsed N times, and each alias rewalked the full
// (up to 4096-entry) VTable — O(aliases x VTable) work for byte-identical
// results that the final Set deduplicated only afterwards. ~65 KiB of
// metadata stalled classic-worker function discovery ~8.7s. Each physical
// descriptor (and each failed/unmapped descriptor identity) is now parsed at
// most once per run, one aggregate budget is charged BEFORE reading or
// walking a VTable, and exhaustion returns an explicitly truncated result
// that guessFunctions() and worker-fixes propagate as incomplete evidence.

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..');
const context = vm.createContext({
  console, performance, URL, URLSearchParams, TextDecoder, TextEncoder, Blob,
  Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int32Array,
  BigUint64Array, BigInt64Array, DataView, ArrayBuffer,
  BigInt, Map, Set, WeakMap, WeakSet, Promise, Object, Array, Math, Number,
  String, Boolean, RegExp, Error, TypeError, RangeError, JSON, Date,
  setTimeout, clearTimeout,
});
context.self = context;
context.globalThis = context;
context.self.postMessage = () => {};
context.importScripts = () => {};
for (const file of ['js/macho.js', 'js/words.js', 'js/worker-budget.js', 'js/worker-legacy.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}

const BASE = 0x100000n;

function buildImage({ aliases, descriptors, vtableCount, brokenRange = null }) {
  const descStride = 52 + vtableCount * 8 + 16;
  const secLen = aliases * 4;
  const img = new Uint8Array(secLen + descStride * descriptors + 1024);
  const dv = new DataView(img.buffer);
  for (let i = 0; i < aliases; i++) {
    const field = BASE + BigInt(i * 4);
    dv.setInt32(i * 4, Number(BASE + BigInt(secLen) + BigInt(i % descriptors) * BigInt(descStride) - field), true);
  }
  for (let d = 0; d < descriptors; d++) {
    const desc = BASE + BigInt(secLen) + BigInt(d * descStride);
    const at = (addr) => Number(addr - BASE);
    dv.setUint32(at(desc), 0x80000010, true);            // kind=class, HasVTable, init=0, non-generic
    dv.setUint32(at(desc + 44n), 0, true);               // vtable offset (unused)
    dv.setUint32(at(desc + 48n), vtableCount, true);     // method count
    for (let i = 0; i < vtableCount; i++) {
      const fieldAddr = desc + 52n + BigInt(i * 8 + 4);
      const target = BASE + BigInt(secLen + descriptors * descStride + 16) + BigInt(i * 4 + d * 4096 * 4);
      dv.setUint32(at(desc + 52n + BigInt(i * 8)), 0, true);
      dv.setInt32(at(fieldAddr), Number(target - fieldAddr), true);
    }
  }
  const regions = [
    { vmAddr: BASE, size: BigInt(img.length), fileOffset: 0n, section: '', exec: false, zerofill: false },
    { vmAddr: BASE, size: BigInt(secLen), fileOffset: 0n, section: '__swift5_types', exec: false, zerofill: false },
  ];
  return { img, regions, lo: BASE + BigInt(secLen + descriptors * descStride + 8), hi: BASE + BigInt(img.length) + 0x40000n };
}

async function drive(image, regions, lo, hi, brokenStart = null) {
  context.__img = image;
  context.__regions = regions;
  context.__lo = lo;
  context.__hi = hi;
  context.__broken = brokenStart;
  return vm.runInContext(`(async () => {
    let calls = 0, bytes = 0;
    readRange = async (off, len) => {
      calls++; bytes += Number(len);
      if (__broken != null && Number(off) === Number(__broken)) throw new Error('synthetic io failure');
      const o = Number(off);
      if (o < 0 || o + Number(len) > __img.length) throw new Error('past EOF');
      return __img.subarray(o, o + Number(len));
    };
    const out = await swiftReflectionFunctionStarts({ regions: __regions }, __lo, __hi, null);
    return { values: Array.from(out), truncated: out.truncated === true, reason: out.truncationReason || null, calls, bytes };
  })()`, context);
}

test('#8764 8,000 aliases to one 4096-entry VTable parse the descriptor once', async () => {
  const { img, regions, lo, hi } = buildImage({ aliases: 8000, descriptors: 1, vtableCount: 4096 });
  const t0 = Date.now();
  const r = await drive(img, regions, lo, hi);
  const elapsed = Date.now() - t0;
  // section records + head + vtable header + vtable body — independent of alias count.
  assert.ok(r.calls <= 8, `descriptor reads must be alias-independent (${r.calls})`);
  assert.ok(r.bytes < 100_000, `single physical descriptor, not 8k VTable rewalks (${r.bytes} bytes)`);
  assert.equal(r.truncated, false);
  assert.equal(r.values.length, 4096);
  assert.ok(elapsed < 2000, `65 KiB alias storm must not stall (${elapsed} ms)`);
});

test('#8764 many distinct descriptors share one aggregate work budget', async () => {
  const { img, regions, lo, hi } = buildImage({ aliases: 100, descriptors: 100, vtableCount: 4096 });
  const r = await drive(img, regions, lo, hi);
  assert.equal(r.truncated, true);
  assert.equal(r.reason, 'vtable-work-limit');
  // 200k-entry budget / 4096 per VTable: far fewer than 100 descriptor walks.
  assert.ok(r.calls < 250, `budget aborted before walking every VTable (${r.calls})`);
});

test('#8764 repeated failing descriptor aliases are negative-cached', async () => {
  const { img, regions, lo, hi } = buildImage({ aliases: 5000, descriptors: 1, vtableCount: 8 });
  const r = await drive(img, regions, lo, hi, BigInt(5000 * 4));  // fail the first descriptor's head read
  assert.ok(r.calls <= 6, `bad descriptor identity parsed once, not per alias (${r.calls})`);
  assert.equal(r.values.length, 0);
});

test('#8764 ordinary Swift metadata recovery stays exact for admitted records', async () => {
  const { img, regions, lo, hi } = buildImage({ aliases: 3, descriptors: 2, vtableCount: 16 });
  const r = await drive(img, regions, lo, hi);
  assert.equal(r.truncated, false);
  assert.equal(new Set(r.values).size, r.values.length);
  assert.equal(r.values.length, 32);            // both distinct descriptors walked exactly once
  assert.ok(r.values.every((v) => (v & 3n) === 0n && v >= lo && v < hi));
});

test('#8764 callers propagate the bounded result as incomplete discovery', () => {
  const legacy = fs.readFileSync(path.join(root, 'js/worker-legacy.js'), 'utf8');
  assert.match(legacy, /swiftStarts\.truncated[\s\S]{0,200}swift-reflection-/);
  assert.match(legacy, /unwindMetadataTruncated \|\| swiftMetadataTruncated/);
  assert.match(legacy, /unwindMetadataReason \|\| swiftMetadataReason/);
  const fixes = fs.readFileSync(path.join(root, 'js/worker-fixes.js'), 'utf8');
  assert.match(fixes, /swiftStarts\.truncated\) \{ metadataIncomplete = true; metadataTruncationReason \|\|= 'swift-reflection-'/);
});
