import assert from 'node:assert/strict';
import fs from 'node:fs';
import url from 'node:url';

// Issue #8832: js/macho.js::parseEhFrameRanges() accepted any structurally
// decodable FDE [start,end) without proving the range is contained in one
// executable/file-backed mapping. worker-fixes.js then uses a returned FDE as
// authoritative function extent: `__strictlyInsideFunctionRange()` suppresses
// otherwise plausible function starts anywhere inside it. A 37-byte fixture can
// therefore declare a ~4 GiB extent over a 4 KiB code region and hide every other
// candidate. The ELF unwind path already requires sameExecutableRange(); the Mach-O
// classic path now enforces the same containment and fails an out-of-mapping FDE
// closed (never clipped) while isolating it from unrelated valid FDEs.

const machoSrc = fs.readFileSync(
  url.fileURLToPath(new URL('../../../js/macho.js', import.meta.url)),
  'utf8',
);
new Function('root', machoSrc)(globalThis);
const { parseEhFrameRanges } = globalThis.MachO;

// A zR CIE (version 1) with fdeEncoding = DW_EH_PE_absptr (0x00) plus one FDE per
// descriptor, all using 8-byte absolute start / range fields.
function buildEh(fdes) {
  const bytes = new Uint8Array(17 + fdes.length * 24);
  const dv = new DataView(bytes.buffer);
  let p = 0;
  dv.setUint32(p, 13, true); p += 4;      // CIE length
  dv.setUint32(p, 0, true); p += 4;       // CIE id = 0
  for (const b of [0x01, 0x7a, 0x52, 0x00, 0x01, 0x78, 0x1e, 0x01, 0x00]) bytes[p++] = b;
  for (const f of fdes) {
    const lenPos = p;
    dv.setUint32(p, 20, true); p += 4;               // FDE length (4+8+8 body)
    dv.setUint32(p, lenPos + 4, true); p += 4;        // backwards CIE pointer -> CIE at 0
    dv.setBigUint64(p, BigInt(f.init), true); p += 8; // initial_location (absptr)
    dv.setBigUint64(p, BigInt(f.range), true); p += 8;// address_range (absptr)
  }
  return bytes;
}

const OPTS = { pointerSize: 8 };
const base = { start: 0x100000000n, end: 0x100001000n };   // 4 KiB executable code domain
const codeDomains = [base];

// 1. The exact #8832 reproducer: a 37-byte FDE claiming a ~4 GiB extent over a
//    4 KiB code region is rejected as authoritative extent...
{
  const buf = buildEh([{ init: 0x100000000n, range: 0x100000000n }]);
  const rejected = parseEhFrameRanges(buf, 0n, { ...OPTS, execRanges: codeDomains, align: 4n });
  assert.deepEqual(rejected, [], 'out-of-mapping FDE extent rejected (#8832)');
  // ...while a bare structural decode (no mapping authority supplied) keeps the
  // historical behavior so non-authoritative callers are unaffected.
  const legacy = parseEhFrameRanges(buf, 0n, OPTS);
  assert.equal(legacy.length, 1, 'parser without exec-mapping authority is unchanged');
  assert.equal(legacy[0].start, 0x100000000n);
  assert.equal(legacy[0].end, 0x200000000n);
}

// 2. A wholly-contained FDE is preserved exactly; a 1-byte overhang is rejected.
{
  const good = parseEhFrameRanges(buildEh([{ init: 0x100000000n, range: 0x1000n }]), 0n,
    { ...OPTS, execRanges: codeDomains, align: 4n });
  assert.equal(good.length, 1, 'FDE inside one executable mapping preserved');
  assert.deepEqual([good[0].start, good[0].end], [0x100000000n, 0x100001000n]);
  const overhang = parseEhFrameRanges(buildEh([{ init: 0x100000000n, range: 0x1008n }]), 0n,
    { ...OPTS, execRanges: codeDomains, align: 4n });
  assert.deepEqual(overhang, [], 'extent leaving the mapping is rejected, not clipped');
}

// 3. A start inside the mapping but end outside is rejected.
{
  const r = parseEhFrameRanges(buildEh([{ init: 0x100000400n, range: 0x1000n }]), 0n,
    { ...OPTS, execRanges: codeDomains, align: 4n }); // end 0x100001400 > 0x100001000
  assert.deepEqual(r, [], 'partial overhang rejected');
}

// 4. Crossing two DISJOINT executable mappings is rejected.
{
  const split = [
    { start: 0x100000000n, end: 0x100000800n },
    { start: 0x100000900n, end: 0x100001000n },
  ];
  const r = parseEhFrameRanges(buildEh([{ init: 0x100000400n, range: 0x800n }]), 0n,
    { ...OPTS, execRanges: split, align: 4n }); // spans [0x100000400,0x100000c00) across the gap
  assert.deepEqual(r, [], 'extent crossing an unmapped gap is rejected');
  // The same span is allowed once it is one continuous code domain.
  const contig = parseEhFrameRanges(buildEh([{ init: 0x100000400n, range: 0x800n }]), 0n,
    { ...OPTS, execRanges: [{ start: 0x100000000n, end: 0x100001000n }], align: 4n });
  assert.equal(contig.length, 1, 'one continuous code domain preserved');
}

// 5. ISA start alignment is enforced when an authority-provided align is given.
{
  const misaligned = parseEhFrameRanges(buildEh([{ init: 0x100000002n, range: 0x100n }]), 0n,
    { ...OPTS, execRanges: codeDomains, align: 4n });
  assert.deepEqual(misaligned, [], 'non-aligned FDE start rejected');
  const aligned = parseEhFrameRanges(buildEh([{ init: 0x100000004n, range: 0x100n }]), 0n,
    { ...OPTS, execRanges: codeDomains, align: 4n });
  assert.equal(aligned.length, 1, 'aligned FDE preserved');
}

// 6. One malformed FDE cannot discard an unrelated valid FDE (local isolation).
{
  const r = parseEhFrameRanges(buildEh([
    { init: 0x100000000n, range: 0x40000n }, // huge, leaves the mapping
    { init: 0x100000800n, range: 0x200n },   // contained
  ]), 0n, { ...OPTS, execRanges: codeDomains, align: 4n });
  assert.equal(r.length, 1, 'malformed FDE isolated, valid one retained');
  assert.deepEqual([r[0].start, r[0].end], [0x100000800n, 0x100000a00n]);
}

// 7. An empty executable-mapping set means "no code authority" -> everything fails closed.
{
  const r = parseEhFrameRanges(buildEh([{ init: 0x100000000n, range: 0x1000n }]), 0n,
    { ...OPTS, execRanges: [], align: 4n });
  assert.deepEqual(r, [], 'no executable mapping supplied -> fail closed');
}

console.log('issue #8832 Mach-O .eh_frame FDE executable-mapping containment: PASS');
