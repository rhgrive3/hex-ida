import assert from 'node:assert/strict';
import { openBinary, openBinarySource } from '../js/binary/index.js';

function makePE(machine, bits, characteristics = 0x0002) {
  const optionalSize = bits === 64 ? 0x70 : 0x60;
  const bytes = new Uint8Array(0x200);
  const view = new DataView(bytes.buffer);
  const pe = 0x80, coff = pe + 4, opt = coff + 20;
  view.setUint16(0, 0x5a4d, true);
  view.setUint32(0x3c, pe, true);
  view.setUint32(pe, 0x00004550, true);
  view.setUint16(coff, machine, true);
  view.setUint16(coff + 16, optionalSize, true);
  view.setUint16(coff + 18, characteristics, true);
  view.setUint16(opt, bits === 64 ? 0x20b : 0x10b, true);
  if (bits === 64) view.setBigUint64(opt + 24, 0x140000000n, true);
  else view.setUint32(opt + 28, 0x00400000, true);
  view.setUint32(opt + 32, 0x1000, true);
  view.setUint32(opt + 36, 0x200, true);
  view.setUint32(opt + 56, 0x1000, true);
  view.setUint32(opt + 60, 0x200, true);
  view.setUint16(opt + 68, 3, true);
  view.setUint32(opt + (bits === 64 ? 108 : 92), 0, true);
  return bytes;
}

for (const [name, machine, bits, arch] of [
  ['I386 PE32', 0x014c, 32, 'x86'],
  ['AMD64 PE32+', 0x8664, 64, 'x86_64'],
  ['ARM PE32', 0x01c0, 32, 'arm'],
  ['ARMNT PE32', 0x01c4, 32, 'armv7'],
  ['ARM64 PE32+', 0xaa64, 64, 'arm64'],
  ['ARM64EC PE32+', 0xa641, 64, 'arm64ec'],
  ['RISC-V 32 PE32', 0x5032, 32, 'riscv32'],
  ['RISC-V 64 PE32+', 0x5064, 64, 'riscv64'],
]) {
  const image = openBinary(makePE(machine, bits));
  assert.equal(image.bits, bits, name);
  assert.equal(image.arch, arch, name);
}

for (const [name, machine, bits] of [
  ['AMD64 + PE32', 0x8664, 32],
  ['I386 + PE32+', 0x014c, 64],
  ['ARM64 + PE32', 0xaa64, 32],
  ['ARM + PE32+', 0x01c0, 64],
  ['ARMNT + PE32+', 0x01c4, 64],
  ['ARM64EC + PE32', 0xa641, 32],
  ['ARM64X + PE32', 0xa64e, 32],
  ['RISC-V 32 + PE32+', 0x5032, 64],
  ['RISC-V 64 + PE32', 0x5064, 32],
]) {
  assert.throws(() => openBinary(makePE(machine, bits)), /PE Machine .* incompatible with PE32/, name);
}

assert.equal(openBinary(makePE(0xa64e, 64)).bits, 64, 'ARM64X remains valid with PE32+');
assert.equal(openBinary(makePE(0, 32)).bits, 32, 'IMAGE_FILE_MACHINE_UNKNOWN remains format-neutral for PE32');
assert.equal(openBinary(makePE(0, 64)).bits, 64, 'IMAGE_FILE_MACHINE_UNKNOWN remains format-neutral for PE32+');

// CLR AnyCPU commonly uses I386 + PE32 without IMAGE_FILE_32BIT_MACHINE.
const anyCpu = openBinary(makePE(0x014c, 32, 0x0002));
assert.equal(anyCpu.arch, 'x86');
assert.equal(anyCpu.bits, 32);

// Characteristics must not launder a contradictory architecture class.
assert.throws(() => openBinary(makePE(0x8664, 32, 0x0102)), /incompatible with PE32/);
assert.throws(() => openBinary(makePE(0x014c, 64, 0x0002)), /incompatible with PE32\+/);

// Source-backed PE parsing must enforce the same boundary before downstream metadata parsing.
{
  const bytes = makePE(0x8664, 32);
  const source = {
    size: BigInt(bytes.length),
    async read(offset, length) {
      const start = Number(offset);
      return bytes.subarray(start, start + length);
    },
  };
  await assert.rejects(
    openBinarySource(source, { ranges: { pageSize: 64, maxCachedBytes: 1024 } }),
    /PE Machine .* incompatible with PE32/,
  );
}

console.log('issue #4088 PE Machine/Magic architecture-class regression: PASS');
