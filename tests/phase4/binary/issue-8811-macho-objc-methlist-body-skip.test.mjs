import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import url from 'node:url';

// Issue #8811: js/macho.js::parseObjcMethodStarts() advanced through
// __objc_methlist in 4-byte increments even after validating a complete list,
// so the payload of an accepted list was reinterpreted as fresh overlapping
// list headers. A periodic 96,016-byte fixture cost ~18.6 s (millions of
// nested entry validations) and forged ~24k extra exact IMPs that
// worker-fixes.js then promoted into exactMetadata. The classic
// worker-legacy.js::objcMethodImplementationStarts() helper always skipped the
// accepted body; MachO.parseObjcMethodStarts() now enforces the same
// invariant, charges an aggregate work/result budget so a malformed prefix
// cannot justify unbounded overlapping scans, honors shouldCancel, and marks a
// reduced result explicitly truncated instead of silently complete.

const machoSrc = fs.readFileSync(
  url.fileURLToPath(new URL('../../../js/macho.js', import.meta.url)),
  'utf8',
);
new Function('root', machoSrc)(globalThis);
const { parseObjcMethodStarts } = globalThis.MachO;

const K = 4000;
const VM = 0x1000000000n;          // 64 GiB-ish base; all families stay positive
const NEG = 0x8000000c - 0x100000000; // -2147483636, the i32 value of 0x8000000c

function region(vmAddr, size, section, exec = false) {
  return { vmAddr: BigInt(vmAddr), size: BigInt(size), section, exec };
}

// Periodic [0x8000000c, K] 8-byte pattern: the issue's exact counterexample.
// Every 8 bytes inside an accepted list body re-satisfies the header check.
function periodicFixture() {
  const len = 2 * (8 + K * 12);
  const bytes = new Uint8Array(len);
  const dv = new DataView(bytes.buffer);
  for (let o = 0; o + 4 <= len; o += 4) dv.setUint32(o, (o % 8 < 4) ? 0x8000000c : K, true);
  // Even list indices: name = vm+q+NEG, type = vm+q+4+K, imp = vm+q+8+NEG.
  // Odd list indices:  name = vm+q+K,   type = vm+q+4+NEG, imp = vm+q+8+K.
  // q spans [8, 12K) for the first list and [8+48008, 48008+12K) for the
  // second; generous windows also cover every *inner* (forged) list offset
  // 8..16+12K so the pre-fix scan accepted them all.
  const qLo = 8, qHi = 48008 + K * 12;
  const span = qHi - qLo + 64;
  const regions = [
    region(VM + BigInt(qLo + NEG), span, '__objc_selrefs'),           // even names / forged lists
    region(VM + BigInt(qLo + K), span, '__objc_selrefs'),             // odd names
    region(VM + BigInt(qLo + 4 + NEG), span, '__objc_methtype'),      // odd types (also even-NEG)
    region(VM + BigInt(qLo + 4 + K), span, '__objc_methtype'),        // even types
    region(VM + BigInt(qLo + 8 + NEG), span, '', true),               // even imps
    region(VM + BigInt(qLo + 8 + K), span, '', true),                 // odd imps
  ];
  return { bytes, regions };
}

function expectedPeriodicStarts() {
  const out = new Set();
  for (const hp of [0, 8 + K * 12]) {
    for (let i = 0; i < K; i++) {
      const q = hp + 8 + 12 * i;
      out.add(i % 2 === 0 ? VM + BigInt(q + 8 + NEG) : VM + BigInt(q + 8 + K));
    }
  }
  return out;
}

test('#8811 accepted method-list payload cannot be re-forged as overlapping list headers', () => {
  const { bytes, regions } = periodicFixture();
  const t0 = Date.now();
  const starts = parseObjcMethodStarts(bytes, VM, { regions, architecture: 'arm64' });
  const elapsed = Date.now() - t0;

  assert.equal(starts.length, 8000, 'only the two legitimately packed lists may yield starts');
  const expected = expectedPeriodicStarts();
  assert.equal(starts.length, expected.size);
  for (const a of starts) assert.ok(expected.has(a), 'unexpected forged exact start ' + a);
  assert.notEqual(starts.truncated, true, 'bounded legitimate shape completes');
  assert.ok(elapsed < 5000, `periodic fixture must not stall (${elapsed} ms)`);
});

// Two plain relative lists built with explicit fields, packed or padded.
function buildRelativeLists(entriesPerList, gap) {
  const name = VM + 0x4000n, type = VM + 0x5000n, imp = VM + 0x6000n;
  const mk = () => {
    const b = new Uint8Array(8 + entriesPerList * 12);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 0x80000000 | 12, true);
    dv.setUint32(4, entriesPerList, true);
    for (let i = 0; i < entriesPerList; i++) {
      const q = 8 + 12 * i;
      dv.setInt32(q, Number(name - (VM + BigInt(q))), true);
      dv.setInt32(q + 4, Number(type - (VM + BigInt(q + 4))), true);
      dv.setInt32(q + 8, Number(imp - (VM + BigInt(q + 8))), true);
    }
    return b;
  };
  const a = mk(), b = mk();
  const bytes = new Uint8Array(a.length + gap + b.length);
  bytes.set(a, 0); bytes.set(b, a.length + gap);
  const regions = [
    region(name - 16n, 64, '__objc_selrefs'),
    region(type - 16n, 64, '__objc_methtype'),
    region(imp - 16n, 64, '', true),
  ];
  return { bytes, regions };
}

test('#8811 legitimately consecutive and padded method lists still parse', () => {
  for (const gap of [0, 4, 8]) {
    const { bytes, regions } = buildRelativeLists(16, gap);
    const starts = parseObjcMethodStarts(bytes, VM, { regions });
    assert.notEqual(starts.truncated, true, `gap ${gap} shape completes`);
    assert.ok(starts.includes(VM + 0x6000n), `gap ${gap}: list evidence survives body skip`);
  }
});

test('#8811 absolute (non-relative) method lists keep their old acceptance', () => {
  const name = VM + 0x4000n, type = VM + 0x5000n, imp = VM + 0x6004n;
  const count = 4;
  const bytes = new Uint8Array(8 + count * 24);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 24, true);
  dv.setUint32(4, count, true);
  for (let i = 0; i < count; i++) {
    dv.setBigUint64(8 + 24 * i, name, true);
    dv.setBigUint64(16 + 24 * i, type, true);
    dv.setBigUint64(24 + 24 * i, imp + BigInt(i) * 4n, true);
  }
  const regions = [
    region(name - 8n, 32, '__objc_methname'),
    region(type - 8n, 32, '__objc_methtype'),
    region(imp - 8n, 64, '', true),
  ];
  const starts = parseObjcMethodStarts(bytes, VM, { regions });
  assert.notEqual(starts.truncated, true);
  assert.equal(starts.length, count);
  // out-of-authority name stays fail-closed
  const bad = regions.filter((r) => r.section !== '__objc_methname');
  assert.deepEqual(parseObjcMethodStarts(bytes, VM, { regions: bad }), []);
});

test('#8811 malformed rescan prefix is bounded by the work budget and marked truncated', () => {
  // Headers that pass sanity but fail validation late → repeated entry scans.
  // A tight maxWork must cap total validated entries, never spin unbounded.
  const { bytes, regions } = periodicFixture();
  const capped = parseObjcMethodStarts(bytes, VM, { regions, maxWork: 1000 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.truncationReason, 'work-limit');
  assert.ok(capped.length <= 1000);
  const stopped = parseObjcMethodStarts(bytes, VM, { regions, shouldCancel: () => true });
  assert.equal(stopped.truncated, true);
  assert.equal(stopped.truncationReason, 'cancelled');
  assert.equal(stopped.length, 0);
});

test('#8811 result budget truncates explicitly instead of claiming completeness', () => {
  const { bytes, regions } = buildRelativeLists(64, 0);
  const capped = parseObjcMethodStarts(bytes, VM, { regions, maxResults: 1 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.truncationReason, 'result-limit');
  assert.ok(capped.length >= 1);
});

test('#8811 worker-fixes propagates objc method-start truncation as incomplete evidence', () => {
  const fixes = fs.readFileSync(url.fileURLToPath(new URL('../../../js/worker-fixes.js', import.meta.url)), 'utf8');
  assert.match(fixes, /starts\.truncated[\s\S]{0,200}objc-method-starts-/);
  assert.match(fixes, /MachO\.parseObjcMethodStarts\(buf, r\.vmAddr, \{[\s\S]{0,200}shouldCancel: \(\) => cancelled\(requestId\)/);
});
