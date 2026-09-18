import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import url from 'node:url';
import vm from 'node:vm';

// Issue #8770: the legacy worker's __init_offsets / __objc_methlist discovery
// helpers scanned every matching section descriptor independently. When several
// section records alias the SAME file-backed span (regionsFrom() preserves each
// descriptor), N aliases re-read and re-walk the identical bytes, so ~1.06 MiB of
// metadata cost ~6.25s while the output Set deduplicated the byte-identical
// results only afterwards. Each distinct physical metadata span is now scanned at
// most once per run, one aggregate work budget bounds partially-overlapping
// distinct spans, cancellation is observed inside large sections, and exhaustion
// is propagated by guessFunctions() and worker-fixes.js as incomplete evidence.

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
const MiB = 1024 * 1024;

// __init_offsets payloads: every uint32 entry resolves to imageBase + INIT_DELTA,
// a single valid, 4-aligned executable target. aliases section descriptors all
// point at the same fileOffset (span reuse) so a correct scan yields exactly one
// recovered function start no matter how many descriptors alias it.
const INIT_DELTA = 0x1000n;

function initRegions({ aliases, spanBytes = MiB }) {
  const regions = [];
  for (let i = 0; i < aliases; i++) {
    regions.push({
      vmAddr: BASE + BigInt(spanBytes) + BigInt(i * 8),
      size: BigInt(spanBytes),
      fileOffset: 0n,               // all aliases reference the SAME file bytes
      section: '__init_offsets',
      exec: false, zerofill: false,
    });
  }
  return regions;
}

// Distinct spans: each descriptor covers a different (contiguous) fileOffset, so
// exact-span canonicalization cannot collapse them and only the aggregate budget
// bounds total entry work.
function distinctInitRegions({ sections, spanBytes = MiB }) {
  const regions = [];
  for (let i = 0; i < sections; i++) {
    regions.push({
      vmAddr: BASE + BigInt(spanBytes) + BigInt(i * 8),
      size: BigInt(spanBytes),
      fileOffset: BigInt(i * spanBytes),
      section: '__init_offsets',
      exec: false, zerofill: false,
    });
  }
  return regions;
}

function buildInitImage(totalBytes) {
  const img = new Uint8Array(totalBytes);
  const dv = new DataView(img.buffer);
  for (let p = 0; p + 4 <= totalBytes; p += 4) dv.setUint32(p, Number(INIT_DELTA), true);
  return img;
}

function objcRegions({ aliases, spanBytes = 64 }) {
  const regions = [];
  for (let i = 0; i < aliases; i++) {
    regions.push({
      vmAddr: BASE + BigInt(spanBytes) + BigInt(i * 8),
      size: BigInt(spanBytes),
      fileOffset: 0n,                // aliases share one physical __objc_methlist span
      section: '__objc_methlist',
      exec: false, zerofill: false,
    });
  }
  return regions;
}

async function drive(fn, image, regions) {
  context.__img = image;
  context.__regions = regions;
  context.__lo = BASE;
  context.__hi = BASE + BigInt(image.length) + 0x40000n;
  context.__imageBase = BASE;
  return vm.runInContext(`(async () => {
    let calls = 0, bytes = 0;
    readRange = async (off, len) => {
      calls++; bytes += Number(len);
      const o = Number(off);
      if (o < 0 || o + Number(len) > __img.length) throw new Error('past EOF');
      return __img.subarray(o, o + Number(len));
    };
    const slice = { regions: __regions };
    const out = await (${fn})(slice, __lo, __hi, __imageBase, null);
    return { values: Array.from(out).map((v) => v.toString()), truncated: out.truncated === true, reason: out.truncationReason || null, calls, bytes };
  })()`, context);
}

test('#8770 100 exact-alias __init_offsets sections over one span are scanned once', async () => {
  const img = buildInitImage(MiB);
  const r = await drive('initializerFunctionStarts', img, initRegions({ aliases: 100 }));
  assert.ok(r.calls <= 4, `physical span reads must be alias-independent (${r.calls})`);
  assert.ok(r.bytes <= 4 * MiB, `not 100 * 1 MiB of rescanned metadata (${r.bytes} bytes)`);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.values, [(BASE + INIT_DELTA).toString()]);   // output unchanged for aliased input
});

test('#8770 ordinary (non-aliased) __init_offsets recovery stays exact', async () => {
  const img = buildInitImage(2 * MiB);
  const r = await drive('initializerFunctionStarts', img, distinctInitRegions({ sections: 2 }));
  assert.equal(r.truncated, false);
  assert.deepEqual(r.values, [(BASE + INIT_DELTA).toString()]);
});

test('#8770 many distinct overlapping spans are bounded by an aggregate budget', async () => {
  const img = buildInitImage(8 * MiB);
  const r = await drive('initializerFunctionStarts', img, distinctInitRegions({ sections: 8 }));
  assert.equal(r.truncated, true, 'budget must abort, not scan 8 MiB unconditionally');
  assert.ok(r.reason, 'truncation must carry a stable reason');
  // recovered starts remain valid 4-aligned in-range targets
  assert.ok(r.values.every((v) => BigInt(v) % 4n === 0n));
});

test('#8770 aliased __objc_methlist descriptors do not rescan the same bytes', async () => {
  const img = new Uint8Array(64);   // content irrelevant to the read-accounting boundary
  const r = await drive('objcMethodImplementationStarts', img, objcRegions({ aliases: 100 }));
  assert.ok(r.calls <= 4, `aliased method-list spans read once (${r.calls})`);
});

test('#8770 callers propagate the bounded metadata result as incomplete discovery', () => {
  const legacy = fs.readFileSync(path.join(root, 'js/worker-legacy.js'), 'utf8');
  assert.match(legacy, /swiftMetadataTruncated \|\| legacyMetadataTruncated/);
  assert.match(legacy, /initStarts\.truncated|methodStarts\.truncated/);
  const fixes = fs.readFileSync(path.join(root, 'js/worker-fixes.js'), 'utf8');
  assert.match(fixes, /initStarts\.truncated\) \{ metadataIncomplete = true; metadataTruncationReason \|\|= 'legacy-init-/);
});
