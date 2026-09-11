import assert from 'node:assert/strict';
import { parsePE } from '../js/binary/pe.js';
import { parsePESource } from '../js/binary/source-loaders.js';
import { MemoryByteSource } from '../js/binary/source.js';

function peFixture({ bits = 64, imageBase, entryRva = 0x1000 } = {}) {
  const is64 = bits === 64;
  const sizeOptional = is64 ? 112 : 96;
  const bytes = new Uint8Array(0x400);
  const dv = new DataView(bytes.buffer);
  dv.setUint16(0, 0x5a4d, true);
  dv.setUint32(0x3c, 0x80, true);
  const pe = 0x80;
  dv.setUint32(pe, 0x00004550, true);
  const coff = pe + 4;
  dv.setUint16(coff, is64 ? 0x8664 : 0x014c, true);
  dv.setUint16(coff + 2, 1, true);
  dv.setUint16(coff + 16, sizeOptional, true);
  dv.setUint16(coff + 18, 0x0002, true);
  const opt = coff + 20;
  dv.setUint16(opt, is64 ? 0x20b : 0x10b, true);
  dv.setUint32(opt + 16, entryRva, true);
  if (is64) dv.setBigUint64(opt + 24, imageBase ?? 0x140000000n, true);
  else dv.setUint32(opt + 28, Number(imageBase ?? 0x00400000n), true);
  dv.setUint32(opt + 32, 0x1000, true);
  dv.setUint32(opt + 36, 0x200, true);
  dv.setUint32(opt + 56, 0x2000, true);
  dv.setUint32(opt + 60, 0x200, true);
  dv.setUint16(opt + 68, 3, true);
  dv.setUint32(opt + (is64 ? 108 : 92), 0, true);

  const sec = opt + sizeOptional;
  bytes.set(new TextEncoder().encode('.text'), sec);
  dv.setUint32(sec + 8, 0x100, true);
  dv.setUint32(sec + 12, 0x1000, true);
  dv.setUint32(sec + 16, 0x200, true);
  dv.setUint32(sec + 20, 0x200, true);
  dv.setUint32(sec + 36, 0x60000020, true);
  return bytes;
}

{
  const pe64 = parsePE(peFixture({ bits:64, imageBase:0x140000000n }));
  assert.equal(pe64.imageBase, 0x140000000n);
  assert.equal(pe64.entrypoint, 0x140001000n);
  assert.equal(pe64.functions.some((f) => f.source === 'entrypoint'), true);

  const pe32 = parsePE(peFixture({ bits:32, imageBase:0x00400000n }));
  assert.equal(pe32.imageBase, 0x00400000n);
  assert.equal(pe32.entrypoint, 0x00401000n);

  const nextAligned = parsePE(peFixture({ bits:64, imageBase:0x140010000n }));
  assert.equal(nextAligned.imageBase, 0x140010000n);
}

for (const [bits, imageBase] of [
  [64, 0x140001000n],
  [64, 0x140000001n],
  [64, 0x13fffffffn],
  [64, 0x14000ffffn],
  [32, 0x00401000n],
  [32, 0x00400001n],
]) {
  assert.throws(
    () => parsePE(peFixture({ bits, imageBase })),
    /ImageBase.*64 KiB aligned/,
    `PE${bits === 64 ? '32+' : '32'} ImageBase 0x${imageBase.toString(16)} must be rejected`,
  );
}

{
  const sourceValid = await parsePESource(new MemoryByteSource(peFixture({ bits:64, imageBase:0x180000000n })));
  assert.equal(sourceValid.imageBase, 0x180000000n);
  await assert.rejects(
    parsePESource(new MemoryByteSource(peFixture({ bits:64, imageBase:0x180001000n }))),
    /ImageBase.*64 KiB aligned/,
  );
}

console.log('issue #4163 PE ImageBase alignment regression PASS');
