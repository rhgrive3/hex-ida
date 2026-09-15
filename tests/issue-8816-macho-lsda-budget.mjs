// Issue #8816 regression: js/macho.js::parseUnwindLsdaEntries() eagerly
// materialized one `fnOff + ':' + tableOff` string key per pair (inside a Set)
// on top of a BigInt-object output, before any caller-side cap could filter it.
// A ~5.2 MiB __unwind_info holding 650,000 LSDA pairs therefore retained enough
// JS state to OOM a 128 MiB worker heap. The helper now drops the string-key
// Set, charges a shared UNWIND_LSDA_MAX budget before each output object, sorts
// the bounded set, and collapses exact adjacent duplicates — marking the result
// truncated instead of over-allocating.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const machoFile = path.join(root, 'js/macho.js');
new Function('root', fs.readFileSync(machoFile, 'utf8'))(globalThis);
const { parseUnwindLsdaEntries } = globalThis.MachO;

const UNWIND_LSDA_MAX = 200_000;
const IMAGE_BASE = 0x100000000n;
const HEADER = 28, ROW = 12, LSDA_START = 64;

// A valid v1 __unwind_info whose single LSDA interval [LSDA_START, end) holds
// `pairs` 8-byte (fnOff, tableOff) records; a second index row delimits the end.
function buildLsda(pairs, { dupEvery = 0, zeroTableAt = -1 } = {}) {
  const end = LSDA_START + pairs * 8;
  const buf = new Uint8Array(end + 8);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 1, true);                 // version
  dv.setUint32(20, HEADER, true);           // indexSectionOffset
  dv.setUint32(24, 2, true);                // indexCount (real + end delimiter)
  dv.setUint32(HEADER + 8, LSDA_START, true);
  dv.setUint32(HEADER + ROW + 8, end, true);
  for (let k = 0; k < pairs; k++) {
    const x = LSDA_START + k * 8;
    const fnOff = dupEvery && k >= dupEvery ? ((k - dupEvery) * 4) + 1 : (k * 4) + 1;
    const tableOff = k === zeroTableAt ? 0 : (k * 8) + 1024;
    dv.setUint32(x, fnOff, true);
    dv.setUint32(x + 4, tableOff, true);
  }
  return buf;
}

const norm = (entries) => entries.map((e) => ({ f: e.functionStart.toString(16), l: e.lsda.toString(16) }));

// --- unique normal pairs preserve exact function/LSDA addresses; not truncated.
{
  const base = IMAGE_BASE;
  const entries = parseUnwindLsdaEntries(buildLsda(3), IMAGE_BASE); // pairs 0..2
  assert.deepEqual(norm(entries), [
    { f: (base + 1n).toString(16), l: (base + 1024n).toString(16) },
    { f: (base + 5n).toString(16), l: (base + 1032n).toString(16) },
    { f: (base + 9n).toString(16), l: (base + 1040n).toString(16) },
  ]);
  assert.equal(entries.truncated, false);
}

// --- tableOff === 0 records are skipped (no landing pad), as before.
{
  const entries = parseUnwindLsdaEntries(buildLsda(3, { zeroTableAt: 1 }), IMAGE_BASE);
  assert.equal(entries.length, 2);
  const dropped = IMAGE_BASE + 1032n; // k=1 tableOff would have been 1*8+1024
  assert.ok(entries.every((e) => e.lsda !== dropped), 'the zero-tableOff pair must be dropped');
}

// --- exact duplicate pairs are deduplicated (sorted-adjacent == old global key Set).
{
  // pairs [A,B,A,B] -> 2 unique.
  const buf = buildLsda(4);
  const dv = new DataView(buf.buffer);
  const setPair = (k, fn, tbl) => { const x = LSDA_START + k * 8; dv.setUint32(x, fn, true); dv.setUint32(x + 4, tbl, true); };
  setPair(0, 8, 1024); setPair(1, 16, 2048); setPair(2, 8, 1024); setPair(3, 16, 2048);
  const entries = parseUnwindLsdaEntries(buf, IMAGE_BASE);
  assert.equal(entries.length, 2, 'exact duplicate LSDA pairs collapse to one entry each');
  assert.equal(entries.truncated, false);
}

// --- the 650k-pair blow-up is capped, marked truncated, and completes without throwing.
{
  const entries = parseUnwindLsdaEntries(buildLsda(650_000), IMAGE_BASE);
  assert.ok(entries.length <= UNWIND_LSDA_MAX, `output must be capped: got ${entries.length}`);
  assert.equal(entries.length, UNWIND_LSDA_MAX, 'budget is reached before over-allocating');
  assert.equal(entries.truncated, true);
  // sorted by lsda then functionStart, strictly unique.
  for (let i = 1; i < entries.length; i++) {
    const a = entries[i - 1], b = entries[i];
    assert.ok(a.lsda < b.lsda || (a.lsda === b.lsda && a.functionStart <= b.functionStart));
    assert.ok(!(a.lsda === b.lsda && a.functionStart === b.functionStart), 'no duplicate pair survives');
  }
}

// --- a small old-space child process cannot be OOMed by the 650k-pair fixture.
{
  const script = `
    const fs = require('fs');
    new Function('root', fs.readFileSync(${JSON.stringify(machoFile)}, 'utf8'))(globalThis);
    const HEADER = 28, ROW = 12, LSDA_START = 64, pairs = 650000;
    const end = LSDA_START + pairs * 8;
    const buf = new Uint8Array(end + 8);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 1, true); dv.setUint32(20, HEADER, true); dv.setUint32(24, 2, true);
    dv.setUint32(HEADER + 8, LSDA_START, true); dv.setUint32(HEADER + ROW + 8, end, true);
    for (let k = 0; k < pairs; k++) { const x = LSDA_START + k * 8; dv.setUint32(x, k * 4 + 1, true); dv.setUint32(x + 4, k * 8 + 1024, true); }
    const e = globalThis.MachO.parseUnwindLsdaEntries(buf, 0x100000000n);
    if (e.length > 200000) { console.error('UNBOUNDED ' + e.length); process.exit(2); }
    console.log('OK ' + e.length + ' ' + e.truncated);
  `;
  const stdout = execFileSync(process.execPath, ['--max-old-space-size=128', '-e', script], { encoding: 'utf8' });
  assert.match(stdout, /^OK \d+ true$/m, `child heap must not OOM: ${stdout}`);
}

console.log('issue #8816 LSDA-index aggregate-budget regressions: PASS');
