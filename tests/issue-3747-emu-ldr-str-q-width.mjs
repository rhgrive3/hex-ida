import assert from 'node:assert/strict';
import { Emulator } from '../js/emu.js';

const SRC = 0x1000n;
const DST = 0x1100n;

function sourceBytes(fill = 0) {
  return Array.from({ length: 16 }, (_, i) => (0xa0 + i + fill) & 0xff);
}

async function newEmu(source) {
  const emu = new Emulator();
  emu.mapZero(SRC, 0x200);
  for (let i = 0; i < 16; i++) await emu.store(SRC + BigInt(i), 1, BigInt(source[i]));
  for (let i = 0; i < 16; i++) await emu.store(DST + BigInt(i), 1, 0n);
  emu.set('x1', SRC);
  emu.set('x2', DST);
  return emu;
}

async function readBack(emu) {
  const out = [];
  for (let i = 0; i < 16; i++) out.push(Number(await emu.load(DST + BigInt(i), 1)));
  return out;
}

function regOp(text) {
  const m = /^([bhsdq])(\d+)$/i.exec(text);
  const bits = { b: 8, h: 16, s: 32, d: 64, q: 128 }[m[1].toLowerCase()];
  return { k: 'reg', text: text.toLowerCase(), cls: 'fp', bits, num: Number(m[2]) };
}

function be(bytes) {
  return bytes.reduceRight((acc, x) => (acc << 8n) | BigInt(x), 0n);
}

async function roundTrip(reg, width, source) {
  const emu = await newEmu(source);
  await emu.execute('ldr', `${reg}, [x1]`, 0n);
  await emu.execute('str', `${reg}, [x2]`, 0n);
  const written = await readBack(emu);
  assert.deepEqual(
    written.slice(0, width),
    source.slice(0, width),
    `${reg.toUpperCase()} must transfer exactly ${width} raw bytes, got ${written.map((x) => x.toString(16).padStart(2, '0')).join(' ')}`,
  );
  assert.deepEqual(
    written.slice(width),
    new Array(16 - width).fill(0),
    `${reg.toUpperCase()} must not touch the ${16 - width} bytes past its ${width}-byte access`,
  );
  return written;
}

await roundTrip('s0', 4, sourceBytes());
await roundTrip('d0', 8, sourceBytes());
await roundTrip('q0', 16, sourceBytes());

// Two vectors that differ only in their upper 64 bits must not store the same
// memory: the 8-byte truncation made the difference unobservable.
const lowerOnly = sourceBytes(0);
const upperOnly = lowerOnly.map((x, i) => (i < 8 ? x : (x + 0x40) & 0xff));
const storedFor = async (source) => {
  const emu = await newEmu(source);
  await emu.execute('ldr', 'q0, [x1]', 0n);
  await emu.execute('str', 'q0, [x2]', 0n);
  return readBack(emu);
};
const fromLower = await storedFor(lowerOnly);
const fromUpper = await storedFor(upperOnly);
assert.notDeepEqual(fromLower, fromUpper, 'LDR/STR Q0 must preserve a difference carried only in the upper 64 bits');
assert.deepEqual(fromUpper.slice(8), upperOnly.slice(8), 'Q0 upper 64 bits must round-trip through memory');

async function rawBitRetention(reg, width) {
  const op = regOp(reg);
  for (const pattern of reg === 's0'
    ? [[0x80000000], [0x7fa5dead], [0x7fc00000]]
    : [[0x80000000, 0x00000000], [0x7ff40000, 0xdeadbeef], [0xfff80000, 0x00000000]]) {
    const encoding = reg === 's0'
      ? [pattern[0] & 0xff, (pattern[0] >>> 8) & 0xff, (pattern[0] >>> 16) & 0xff, (pattern[0] >>> 24) & 0xff]
      : [
        pattern[1] & 0xff, (pattern[1] >>> 8) & 0xff, (pattern[1] >>> 16) & 0xff, (pattern[1] >>> 24) & 0xff,
        pattern[0] & 0xff, (pattern[0] >>> 8) & 0xff, (pattern[0] >>> 16) & 0xff, (pattern[0] >>> 24) & 0xff,
      ];
    const source = [...encoding, ...sourceBytes(0x11).slice(width)];
    const emu = await newEmu(source);
    await emu.execute('ldr', `${reg}, [x1]`, 0n);
    assert.equal(be(encoding), be(source.slice(0, width)), 'fixture sanity');
    assert.equal(emu.fpBits(op), be(source.slice(0, width)), `${reg.toUpperCase()} raw encoding must survive LDR`);
    await emu.execute('str', `${reg}, [x2]`, 0n);
    assert.deepEqual(
      await readBack(emu),
      [...source.slice(0, width), ...new Array(16 - width).fill(0)],
      `${reg.toUpperCase()} raw encoding must survive LDR/STR`,
    );
  }
}

await rawBitRetention('s0', 4);
await rawBitRetention('d0', 8);

console.log('issue #3747 emulator LDR/STR Q register 128-bit width: ok');
