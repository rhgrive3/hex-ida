import assert from 'node:assert/strict';
import fs from 'node:fs';
import url from 'node:url';

// Issue #5371: parseUnwindStarts() bounded second-level entries only against
// the whole __unwind_info buffer. Compact-unwind second-level pages are
// 4 KiB, so a malformed entryPageOffset/entryCount could walk past the page
// end and reinterpret the next page's header, the LSDA index, or any other
// __unwind_info payload as compact-unwind entries — minting function starts
// for addresses that were never encoded.

const machoSrc = fs.readFileSync(
  url.fileURLToPath(new URL('../../../js/macho.js', import.meta.url)),
  'utf8',
);
new Function('root', machoSrc)(globalThis);
const { parseUnwindStarts } = globalThis.MachO;

// __unwind_info layout: 28-byte header, one real index entry + sentinel.
// Index entry at 28: funcOffset @28, secondLevelPageOffset @32, lsdaOffset @36.
// Page starts at 40 (pageOff). Bytes beyond pageOff+0x1000 simulate the
// next page / LSDA-index payload an attacker points the entry array at.
function build({ entryOff, count, entries = [], decoy = 0xdeadbeef, decoy2 = 0x00c0ffee }) {
  const pageOff = 40;
  const buf = new Uint8Array(pageOff + 0x1000 + 16);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 1, true);                       // version
  dv.setUint32(20, 28, true);                     // indexSectionOffset
  dv.setUint32(24, 2, true);                      // indexCount (real + sentinel)
  dv.setUint32(28, 0x1000, true);                 // funcOffset
  dv.setUint32(32, pageOff, true);                // secondLevelPageOffset
  dv.setUint32(36, pageOff + 8, true);            // lsdaIndexOffset
  dv.setUint32(pageOff, 2, true);                 // UNWIND_SECOND_LEVEL_REGULAR
  dv.setUint16(pageOff + 4, entryOff, true);      // entryPageOffset (relative to page)
  dv.setUint16(pageOff + 6, count, true);         // entryCount
  entries.forEach((funcOffset, index) => {
    dv.setUint32(pageOff + entryOff + index * 8, funcOffset, true);
    dv.setUint32(pageOff + entryOff + index * 8 + 4, 0, true); // lsda (unused here)
  });
  // Decoy payload right after the page boundary: would decode as entries
  // under the buf.length-only bound.
  dv.setUint32(pageOff + 0x1000, decoy, true);
  dv.setUint32(pageOff + 0x1008, decoy2, true);
  return buf;
}

const IMAGE_BASE = 0x100000000n;

// --- attack 1: regular page entry array crossing the page boundary ---------
{
  const starts = parseUnwindStarts(build({ entryOff: 0x1000, count: 2 }), IMAGE_BASE);
  assert.deepEqual(starts, [],
    'a regular entry array starting at the page boundary must not read into the next page');
}

// --- attack 2: in-page header but count extends past the page end ----------
{
  const starts = parseUnwindStarts(build({ entryOff: 0xff8, count: 2, entries: [0x1000] }), IMAGE_BASE);
  assert.deepEqual(starts, [IMAGE_BASE + 0x1000n],
    'only the entry inside the 4 KiB page survives; the past-end entry is dropped');
}

// --- attack 3: compressed page with the same overrun -----------------------
{
  const buf = build({ entryOff: 0x1000, count: 1 });
  const dv = new DataView(buf.buffer);
  dv.setUint32(40, 3, true); // UNWIND_SECOND_LEVEL_COMPRESSED
  dv.setUint32(28, 0x1000, true); // functionOffset for the compressed form
  const starts = parseUnwindStarts(buf, IMAGE_BASE);
  assert.deepEqual(starts, [],
    'a compressed entry array starting at the page boundary must not read the decoy past the page');
}

// --- controls: legitimate in-page pages are unaffected ---------------------
{
  const starts = parseUnwindStarts(build({ entryOff: 8, count: 2, entries: [0x1000, 0x1040] }), IMAGE_BASE);
  assert.deepEqual(starts, [IMAGE_BASE + 0x1000n, IMAGE_BASE + 0x1040n],
    'well-formed regular pages still produce their function starts');
}
{
  const buf = build({ entryOff: 8, count: 2 });
  const dv = new DataView(buf.buffer);
  dv.setUint32(40, 3, true);      // UNWIND_SECOND_LEVEL_COMPRESSED
  dv.setUint32(28, 0x1000, true); // functionOffset for the compressed form
  dv.setUint32(48, 0x00000abc, true);
  dv.setUint32(52, 0x00000abd, true);
  const starts = parseUnwindStarts(buf, IMAGE_BASE);
  assert.deepEqual(starts, [IMAGE_BASE + 0x1abcn, IMAGE_BASE + 0x1abdn],
    'well-formed compressed pages still produce their function starts');
}

console.log('issue #5371 compact-unwind second-level page-bound regression: PASS');
