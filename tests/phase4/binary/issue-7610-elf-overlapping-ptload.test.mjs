// Regression for #7610: two PT_LOADs mapping the same VM range to different
// file bytes were both accepted and the first-wins equal-size mapping lookup
// published the earlier program header's bytes as canonical, while the Linux
// loader executes the later mapping (runtime vs Hex byte provenance inverted,
// empty warnings). Ambiguous overlapping PT_LOADs now fail closed at parse
// time; non-overlapping loads and loads whose overlapping file bytes are
// identical stay accepted.
import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf.js';

function buildELF(loads) {
  const PHOFF = 64, PHENT = 56;
  const b = new Uint8Array(0x400);
  const dv = new DataView(b.buffer);
  const W16 = (o, v) => dv.setUint16(o, v, true);
  const W32 = (o, v) => dv.setUint32(o, v, true);
  const W64 = (o, v) => dv.setBigUint64(o, BigInt(v), true);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  W16(16, 2); W16(18, 62); W32(20, 1); W64(24, 0x400000n);
  W64(32, PHOFF); W64(40, 0); W32(48, 0); W16(52, 64); W16(54, PHENT); W16(56, loads.length);
  loads.forEach((load, i) => {
    const p = PHOFF + i * PHENT;
    W32(p, 1); W32(p + 4, 5);
    W64(p + 8, load.offset); W64(p + 16, 0x400000n); W64(p + 24, 0x400000n);
    W64(p + 32, load.filesz); W64(p + 40, load.filesz); W64(p + 48, 0x1000n);
  });
  b[0x100] = 0xAA; b[0x200] = 0xBB;
  return b;
}

// overlapping VM range with different file bytes must fail closed (both orders)
assert.throws(
  () => parseELF(buildELF([{ offset: 0x100, filesz: 0x100 }, { offset: 0x200, filesz: 0x100 }])),
  /overlaps PT_LOAD 0 with a different file mapping/,
  'later mapping must not silently lose runtime authority');
assert.throws(
  () => parseELF(buildELF([{ offset: 0x200, filesz: 0x100 }, { offset: 0x100, filesz: 0x100 }])),
  /overlaps PT_LOAD 0 with a different file mapping/,
  'the ambiguity is order-symmetric');

// overlapping VM range with IDENTICAL file bytes stays accepted
{
  const bytes = buildELF([{ offset: 0x100, filesz: 0x100 }, { offset: 0x100, filesz: 0x100 }]);
  const image = parseELF(bytes);
  assert.equal(image.segments.length, 2);
  assert.equal(image.warnings.length, 0);
}

// non-overlapping loads are unaffected
{
  const bytes = buildELF([{ offset: 0x100, filesz: 0x100 }, { offset: 0x100, filesz: 0x100, shifted: true }]);
  // second load at a different VA
  const PHOFF = 64, PHENT = 56;
  const dv = new DataView(bytes.buffer);
  const W64 = (o, v) => dv.setBigUint64(o, BigInt(v), true);
  W64(PHOFF + PHENT + 16, 0x400100n); W64(PHOFF + PHENT + 24, 0x400100n);
  const image = parseELF(bytes);
  assert.equal(image.segments.length, 2);
  assert.equal(image.warnings.length, 0);
  assert.equal([...image.readVirtual(0x400000n, 1)][0], 0xAA, 'first load reads its own bytes');
}

console.log('issue #7610 ambiguous overlapping PT_LOAD fail-closed regression: PASS');
