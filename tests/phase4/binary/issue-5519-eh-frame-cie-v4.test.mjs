import assert from 'node:assert/strict';
import fs from 'node:fs';
import url from 'node:url';

// Issue #5519: parseEhFrameRanges() only special-cased CIE version 1. CIE
// version 4 inserts address_size and segment_selector_size between the
// augmentation string and code_alignment_factor; without consuming those two
// ubytes the parser misread them as the code-align ULEB and lost every FDE
// that referenced the CIE (e.g. a valid `zR` CIE produced zero ranges).

const machoSrc = fs.readFileSync(
  url.fileURLToPath(new URL('../../../js/macho.js', import.meta.url)),
  'utf8',
);
const MachO = {};
new Function('root', machoSrc)(globalThis);
const { parseEhFrameRanges } = globalThis.MachO;

function uleb(value) {
  const out = [];
  let v = BigInt(value);
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return out;
}
function sleb(value) {
  const out = [];
  let v = BigInt(value), more = true;
  while (more) {
    let b = Number(v & 0x7fn); v >>= 7n;
    if ((v === 0n && (b & 0x40) === 0) || (v === -1n && (b & 0x40) !== 0)) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return out;
}

// One CIE (zR augmentation, fdeEncoding pcrel|sdata4) plus one FDE describing
// the function at section offset 0x1000 with a 0x40-byte range.
function buildEhFrame({ version4 }) {
  const cieBody = version4
    ? [0x04, 0x7a, 0x52, 0x00, 0x08, 0x00, ...uleb(1), ...sleb(-8), ...uleb(0x1e), 0x01, 0x1b]
    : [0x01, 0x7a, 0x52, 0x00, ...uleb(1), ...sleb(-8), 0x1e, 0x01, 0x1b];
  const cieId = [0x00, 0x00, 0x00, 0x00];
  const cieLen = cieId.length + cieBody.length;
  // FDE CIE pointer: backwards section offset from the pointer field itself.
  const cieOffset = cieLen + 8;
  const pcRel = 0x1000 - 4 - 8; // sdata4 relative to the address after its field
  const fdeContent = [
    cieOffset & 0xff, (cieOffset >> 8) & 0xff, (cieOffset >> 16) & 0xff, (cieOffset >> 24) & 0xff,
    pcRel & 0xff, (pcRel >> 8) & 0xff, (pcRel >> 16) & 0xff, (pcRel >> 24) & 0xff,
    0x40, 0x00, 0x00, 0x00,
  ];
  const fdeLen = fdeContent.length;
  const buf = new Uint8Array(4 + cieLen + 4 + fdeLen);
  const dv = new DataView(buf.buffer);
  let p = 0;
  dv.setUint32(p, cieLen, true); p += 4;
  buf.set(cieId, p); p += 4;
  buf.set(cieBody, p); p += cieBody.length;
  dv.setUint32(p, fdeLen, true); p += 4;
  buf.set(fdeContent, p);
  return buf;
}

const sectionVM = 0x20000000n;

// Version 1 keeps its exact historical result.
{
  const ranges = parseEhFrameRanges(buildEhFrame({ version4: false }), sectionVM);
  assert.equal(ranges.length, 1, 'CIE version 1 still recovers the FDE');
  // start = sectionVM + (fdePointerFieldOffset + pcRel); the pcRel constant
  // already accounts for the field's position, so the absolute value lands
  // where the encoding puts it (section offset 0x100d for the v1 layout).
  assert.equal(ranges[0].start, 536875021n);
  assert.equal(ranges[0].end, 536875021n + 0x40n);
}

// Version 4 CIE now recovers the same FDE that was previously lost entirely.
{
  const ranges = parseEhFrameRanges(buildEhFrame({ version4: true }), sectionVM);
  assert.equal(ranges.length, 1, 'a valid CIE version 4 no longer kills its FDE');
  assert.equal(ranges[0].start, 536875023n);
  assert.equal(ranges[0].end, 536875023n + 0x40n);
}

// A truncated version-4 header (missing the two new fields) fails closed
// without poisoning the scan.
{
  const buf = new Uint8Array(32);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 16, true); // record length
  dv.setUint32(4, 0, true);  // CIE id
  buf.set([0x04, 0x7a, 0x52, 0x00], 8); // version 4, "zR\0" and nothing else
  const ranges = parseEhFrameRanges(buf, sectionVM);
  assert.deepEqual(ranges, [], 'truncated v4 CIE contributes no ranges');
}

console.log('issue #5519 .eh_frame CIE version 4 regression: PASS');
