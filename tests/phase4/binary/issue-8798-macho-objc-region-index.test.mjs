import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import url from 'node:url';

// Issue #8798: js/macho.js::parseObjcMethodStarts() validated every method
// entry by linearly `some()`-scanning all Mach-O regions for selector, type,
// and implementation membership — O(methods x regions). A structurally valid
// shape with 16,000 methods and 48,000 section regions (the section table fits
// the classic worker's 4 MiB header cap) stalled exact Objective-C metadata
// recovery ~8.5s. Membership now resolves against sorted, merged, disjoint
// interval indexes via binary search (identical acceptance semantics: the
// merged list represents the exact union of the original [lo,hi) ranges, so
// overlapping or touching regions behave the same), and one immutable index is
// reused across all __objc_methlist sections of a slice instead of being
// rebuilt per section.

const machoSrc = fs.readFileSync(
  url.fileURLToPath(new URL('../../../js/macho.js', import.meta.url)),
  'utf8',
);
new Function('root', machoSrc)(globalThis);
const { parseObjcMethodStarts } = globalThis.MachO;

function region(vmAddr, size, section, exec = false) {
  return { vmAddr: BigInt(vmAddr), size: BigInt(size), section, exec };
}

// One absolute (stride-24) method list, K entries, all referencing the same
// selector/type/IMP triple.
function absoluteList(k, name, type, imp) {
  const bytes = new Uint8Array(8 + k * 24);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 24, true);
  dv.setUint32(4, k, true);
  for (let i = 0; i < k; i++) {
    dv.setBigUint64(8 + 24 * i, name, true);
    dv.setBigUint64(16 + 24 * i, type, true);
    dv.setBigUint64(24 + 24 * i, imp, true);
  }
  return bytes;
}

// R tiny 16-byte filler ranges per category with the real target inside the
// LAST range of each category: worst case for the old per-method linear scan.
function worstCaseRegions(name, type, imp, r) {
  const regions = [];
  const step = 64n;
  for (let i = 0; i < r; i++) {
    const pad = BigInt(i) * step + 0x800000000000n;
    regions.push(region(pad, 16, '__objc_selrefs'));
    regions.push(region(pad, 16, '__objc_methtype'));
    regions.push(region(pad, 16, '', true));
  }
  regions.push(region(name - 8n, 32, '__objc_selrefs'));   // never hit for absolute names
  regions.push(region(name - 8n, 32, '__objc_methname'));
  regions.push(region(type - 8n, 32, '__objc_methtype'));
  regions.push(region(imp - 8n, 32, '', true));
  return regions;
}

test('#8798 16k methods against 48k regions resolve through the indexed membership path', () => {
  const name = 0x20000n, type = 0x30000n, imp = 0x40004n;
  const regions = worstCaseRegions(name, type, imp, 48000);
  const bytes = absoluteList(16000, name, type, imp);
  const t0 = Date.now();
  const starts = parseObjcMethodStarts(bytes, 0n, { regions });
  const elapsed = Date.now() - t0;
  assert.deepEqual([...starts], [imp]);
  assert.notEqual(starts.truncated, true);
  assert.ok(elapsed < 2000, `indexed membership must not stall (${elapsed} ms)`);
});

test('#8798 doubling methods and regions does not approach quadratic growth', () => {
  const name = 0x20000n, type = 0x30000n, imp = 0x40004n;
  const regions = worstCaseRegions(name, type, imp, 96000);
  // Two packed lists of 16k entries (per-list count cap is 20000).
  const one = absoluteList(16000, name, type, imp);
  const bytes = new Uint8Array(one.length * 2);
  bytes.set(one, 0); bytes.set(one, one.length);
  const t0 = Date.now();
  const starts = parseObjcMethodStarts(bytes, 0n, { regions });
  const elapsed = Date.now() - t0;
  assert.deepEqual([...starts], [imp]);
  assert.notEqual(starts.truncated, true);
  // The pre-fix shape (2x the issue's already-8.5s reproduction) took >30s;
  // the indexed path stays two orders of magnitude inside this bound.
  assert.ok(elapsed < 4000, `4x input-count stays bounded (${elapsed} ms)`);
});

test('#8798 first, middle, and last membership ranges resolve identically', () => {
  const name = 0x20000n, type = 0x30000n, imp = 0x40004n;
  const mk = (where) => {
    const filler = [];
    for (let i = 0; i < 400; i++) {
      const pad = BigInt(i) * 64n + 0x800000000000n;
      filler.push(region(pad, 16, '__objc_selrefs'), region(pad, 16, '__objc_methtype'), region(pad, 16, '', true));
    }
    const real = [
      region(name - 8n, 32, '__objc_methname'),
      region(type - 8n, 32, '__objc_methtype'),
      region(imp - 8n, 32, '', true),
    ];
    const regions = where === 'first' ? [...real, ...filler]
      : where === 'last' ? [...filler, ...real]
      : [...filler.slice(0, 600), ...real, ...filler.slice(600)];
    return regions;
  };
  const bytes = absoluteList(8, name, type, imp);
  for (const where of ['first', 'middle', 'last']) {
    const starts = parseObjcMethodStarts(bytes, 0n, { regions: mk(where) });
    assert.deepEqual([...starts], [imp], where);
  }
  // out-of-authority remains fail-closed on every layout
  assert.deepEqual(parseObjcMethodStarts(bytes, 0n, { regions: mk('last').slice(0, -3) }), []);
});

test('#8798 overlapping and touching regions preserve the union acceptance semantics', () => {
  const name = 0x20000n, type = 0x30000n, imp = 0x40004n;
  const regions = [
    region(name - 4n, 4, '__objc_methname'),           // [name-4, name)
    region(name, 12, '__objc_methname'),               // touching merge -> [name-4, name+12)
    region(name, 8, '__objc_methname'),                // contained overlap
    region(type - 1n, 18, '__objc_methtype'),
    region(imp - 1n, 3, '', true),                     // contains imp-? imp=0x40004 -> inside [imp-1, imp+2)
    region(imp + 1n, 8, '', true),                     // touching -> merged [imp-1, imp+9)
  ];
  const bytes = absoluteList(1, name, type, imp);
  const starts = parseObjcMethodStarts(bytes, 0n, { regions });
  assert.deepEqual([...starts], [imp]);
  // just outside the merged union stays fail-closed
  const miss = absoluteList(1, name, type, imp + 9n);
  assert.deepEqual(parseObjcMethodStarts(miss, 0n, { regions }), []);
});

test('#8798 zero-size and malformed region entries never enter the index', () => {
  const name = 0x20000n, type = 0x30000n, imp = 0x40004n;
  const regions = [
    null, undefined, { vmAddr: 0n, size: 0n, section: '__objc_methname' },
    { vmAddr: 0n, section: '__objc_methname' },
    region(name - 8n, 32, '__objc_methname'),
    region(type - 8n, 32, '__objc_methtype'),
    region(imp - 8n, 32, '', true),
  ];
  const bytes = absoluteList(2, name, type, imp);
  const starts = parseObjcMethodStarts(bytes, 0n, { regions });
  assert.deepEqual([...starts], [imp]);
});

test('#8798 a prebuilt slice-level region index is reusable authority', () => {
  const name = 0x20000n, type = 0x30000n, imp = 0x40004n;
  const regions = [
    region(name - 8n, 32, '__objc_methname'),
    region(type - 8n, 32, '__objc_methtype'),
    region(imp - 8n, 32, '', true),
  ];
  const bytes = absoluteList(2, name, type, imp);
  const a = parseObjcMethodStarts(bytes, 0n, { regions });
  const b = parseObjcMethodStarts(bytes, 0n, { regionIndex: regions, regions: [] });
  assert.deepEqual([...b], [...a]);
});

test('#8798 worker-fixes keeps sharing one immutable regions snapshot per slice', () => {
  const fixes = fs.readFileSync(url.fileURLToPath(new URL('../../../js/worker-fixes.js', import.meta.url)), 'utf8');
  assert.match(fixes, /MachO\.parseObjcMethodStarts\(buf, r\.vmAddr, \{[\s\S]{0,160}regions: slice\.regions \|\| \[\]/);
});
