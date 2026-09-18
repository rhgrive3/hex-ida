// Issue #8789 regression: js/macho.js::parseUnwindStarts() decoded every
// compact-unwind second-level page independently for each first-level index row,
// with no aggregate output budget. Because many first-level rows can alias a
// single accepted 4 KiB compressed page, a ~22 KiB __unwind_info expanded into
// ~1.5M BigInt starts and OOM-killed a 64 MiB worker heap. The helper now
// decodes each physical page once (keyed by offset), applies the row's own
// funcOffset base for compressed entries, deduplicates function starts as it
// emits, and enforces one shared aggregate budget — marking the returned array
// `truncated` rather than materializing an unbounded result or silently
// blessing a prefix as complete.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const machoFile = path.join(root, 'js/macho.js');
const machoSrc = fs.readFileSync(machoFile, 'utf8');
new Function('root', machoSrc)(globalThis);
const { parseUnwindStarts } = globalThis.MachO;

const UNWIND_STARTS_MAX = 200_000;
const IMAGE_BASE = 0x100000000n;
const HEADER = 28;
const ROW = 12;
const PAGE = 0x1000;

// Build a __unwind_info with `rows` first-level index entries. Every row points
// at the same compressed second-level page (`kind` 3) with `entryCount` valid
// slots; row i carries funcOffset i*PAGE so its decoded starts stay distinct.
function buildAliasedUnwind(rows, entryCount) {
  const pageOff = HEADER + rows * ROW;
  const buf = new Uint8Array(pageOff + PAGE + 8);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 1, true);                 // version
  dv.setUint32(20, HEADER, true);           // indexSectionOffset
  dv.setUint32(24, rows, true);             // indexCount
  // One compressed page header reused by every row.
  dv.setUint32(pageOff, 3, true);           // UNWIND_SECOND_LEVEL_COMPRESSED
  dv.setUint16(pageOff + 4, 8, true);       // entryPageOffset (in-page)
  dv.setUint16(pageOff + 6, entryCount, true);
  for (let k = 0; k < entryCount; k++) dv.setUint32(pageOff + 8 + k * 4, k, true);
  for (let i = 0; i < rows; i++) {
    const e = HEADER + i * ROW;
    dv.setUint32(e, i * PAGE, true);        // funcOffset (row base)
    dv.setUint32(e + 4, pageOff, true);     // secondLevelPageOffset (alias)
  }
  return buf;
}

// A normal single regular page (kind 2) with exact in-page entries.
function buildRegularUnwind(funcOffsets) {
  const pageOff = HEADER + 2 * ROW;
  const buf = new Uint8Array(pageOff + 8 + funcOffsets.length * 8);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 1, true);
  dv.setUint32(20, HEADER, true);
  dv.setUint32(24, 2, true);                // one real row + one out-of-range sentinel
  dv.setUint32(28, 0, true);                // funcOffset (unused by regular kind)
  dv.setUint32(32, pageOff, true);          // secondLevelPageOffset
  dv.setUint32(36, 999999, true);           // sentinel row points past the buffer
  dv.setUint32(pageOff, 2, true);           // UNWIND_SECOND_LEVEL_REGULAR
  dv.setUint16(pageOff + 4, 8, true);
  dv.setUint16(pageOff + 6, funcOffsets.length, true);
  funcOffsets.forEach((f, i) => dv.setUint32(pageOff + 8 + i * 8, f, true));
  return buf;
}

// --- normal regular pages still yield their exact function starts, not truncated.
{
  const starts = parseUnwindStarts(buildRegularUnwind([0x1000, 0x1040, 0x1080]), IMAGE_BASE);
  assert.deepEqual(Array.from(starts), [IMAGE_BASE + 0x1000n, IMAGE_BASE + 0x1040n, IMAGE_BASE + 0x1080n]);
  assert.equal(starts.truncated, false, 'a well-formed page must not be reported truncated');
}

// --- the exact aliasing blow-up is capped, marked truncated, and completes.
{
  const naive = 1500 * 1022;                // > 1.5M — the pre-fix allocation
  assert.ok(naive > UNWIND_STARTS_MAX);
  const starts = parseUnwindStarts(buildAliasedUnwind(1500, 1022), IMAGE_BASE);
  assert.ok(starts.length <= UNWIND_STARTS_MAX, `output must be capped: got ${starts.length}`);
  assert.equal(starts.length, UNWIND_STARTS_MAX, 'budget is reached before over-allocating');
  assert.equal(starts.truncated, true, 'capped expansion must be marked truncated');
  const arr = Array.from(starts);
  assert.deepEqual(arr, [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    'returned starts stay sorted for the caller');
}

// --- identical alias rows (same page + same funcOffset) collapse to unique starts,
//     proving a repeated physical page is not re-expanded and starts are deduplicated.
{
  const starts = parseUnwindStarts(buildAliasedUnwind(400, 64), IMAGE_BASE); // 400 rows share base 0? no: distinct bases
  // distinct funcOffset rows produce distinct starts, so bounded-but-not-truncated
  assert.ok(starts.length <= UNWIND_STARTS_MAX);
  const unique = new Set(starts);
  assert.equal(unique.size, starts.length, 'no duplicate function start is emitted');

  // Force alias with one funcOffset by zeroing all bases.
  const buf = buildAliasedUnwind(500, 32);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < 500; i++) dv.setUint32(HEADER + i * ROW, 0, true);
  const once = parseUnwindStarts(buf, IMAGE_BASE);
  assert.equal(once.length, 32, '500 aliases of one identical page collapse to 32 unique starts');
  assert.equal(once.truncated, false);
}

// --- the aggregate budget is charged before the (cap+1)th allocation: no oversized
//     single-call expansion survives, and a small heap child cannot be OOMed.
{
  const script = `
    const fs = require('fs');
    const src = fs.readFileSync(${JSON.stringify(machoFile)}, 'utf8');
    new Function('root', src)(globalThis);
    const HEADER = 28, ROW = 12, PAGE = 0x1000;
    const rows = 1500, entryCount = 1022, pageOff = HEADER + rows * ROW;
    const buf = new Uint8Array(pageOff + PAGE + 8);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 1, true); dv.setUint32(20, HEADER, true); dv.setUint32(24, rows, true);
    dv.setUint32(pageOff, 3, true); dv.setUint16(pageOff + 4, 8, true); dv.setUint16(pageOff + 6, entryCount, true);
    for (let k = 0; k < entryCount; k++) dv.setUint32(pageOff + 8 + k * 4, k, true);
    for (let i = 0; i < rows; i++) { const e = HEADER + i * ROW; dv.setUint32(e, i * PAGE, true); dv.setUint32(e + 4, pageOff, true); }
    const starts = globalThis.MachO.parseUnwindStarts(buf, 0x100000000n);
    if (starts.length > 200000) { console.error('UNBOUNDED ' + starts.length); process.exit(2); }
    console.log('OK ' + starts.length + ' ' + starts.truncated);
  `;
  const stdout = execFileSync(process.execPath, ['--max-old-space-size=64', '-e', script],
    { encoding: 'utf8' });
  assert.match(stdout, /^OK \d+ true$/m, `child heap must not OOM: ${stdout}`);
}

console.log('issue #8789 compact-unwind index alias aggregate-budget regressions: PASS');
