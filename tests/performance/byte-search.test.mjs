import assert from 'node:assert/strict';
import test from 'node:test';
import { compileBytePattern } from '../../js/platform/byte-search.js';
function lower(byte) { return byte >= 65 && byte <= 90 ? byte + 32 : byte; }
function naive(bytes, pattern, mask, foldAscii, from = 0) {
  const out = [];
  for (let at = from; at <= bytes.length - pattern.length; at++) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) {
      const value = foldAscii ? lower(bytes[at + j]) : bytes[at + j];
      if (foldAscii ? value !== lower(pattern[j]) : (value & mask[j]) !== pattern[j]) { match = false; break; }
    }
    if (match) out.push(at);
  }
  return out;
}
function compiled(bytes, pattern, mask, foldAscii, from = 0) {
  const matcher = compileBytePattern(pattern, mask, foldAscii);
  assert.ok(matcher);
  const out = [];
  for (let at = matcher.find(bytes, from); at >= 0; at = matcher.find(bytes, at + 1)) out.push(at);
  return out;
}
let seed = 0x317248ab;
function random() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }

test('Boyer-Moore byte search agrees with the naive oracle for masked and ASCII-folded inputs', () => {
  for (let trial = 0; trial < 1200; trial++) {
    const length = 3 + random() % 24;
    const bytes = Uint8Array.from({ length: random() % 256 }, () => random() & 255);
    const pattern = Uint8Array.from({ length }, () => random() & 255);
    const mask = Uint8Array.from({ length }, () => [255, 255, 255, 15, 240, 0, 85, 170][random() % 8]);
    const foldAscii = trial % 2 === 0;
    if (!foldAscii && trial % 3) for (let i = 0; i < length; i++) pattern[i] &= mask[i];
    if (bytes.length >= length && trial % 4) {
      const at = random() % (bytes.length - length + 1);
      for (let i = 0; i < length; i++) bytes[at + i] = foldAscii ? pattern[i] : (random() & (255 ^ mask[i])) | pattern[i];
    }
    const from = random() % 4;
    assert.deepStrictEqual(compiled(bytes, pattern, mask, foldAscii, from), naive(bytes, pattern, mask, foldAscii, from), `trial ${trial}`);
  }
});

test('search retains overlaps, wildcard matches, exact UTF-8 and boundary offsets', () => {
  const cases = [
    { data: 'aaaaaaa', text: 'AAA' },
    { data: '日本語😀abc日本語😀AbC', text: '日本語😀ABC' },
    { data: 'x'.repeat(262143) + 'Needle' + 'x', text: 'needle' },
    { data: 'a'.repeat(32768), text: 'a'.repeat(63) + 'b' },
  ];
  for (const { data, text } of cases) {
    const bytes = new TextEncoder().encode(data), pattern = new TextEncoder().encode(text);
    assert.deepStrictEqual(compiled(bytes, pattern, null, true), naive(bytes, pattern, null, true));
  }
  assert.deepStrictEqual(compiled(new Uint8Array(12), new Uint8Array(4), new Uint8Array(4), false), [0,1,2,3,4,5,6,7,8]);
  assert.deepStrictEqual(compiled(new Uint8Array(4), new Uint8Array(8), new Uint8Array(8), false), []);
});

test('unusual or oversized patterns decline optimization without changing the old validation path', () => {
  for (const pattern of [null, [], [1], [1,2], [1, , 3], [1,2,'3'], [1,2,256], new Uint8Array(4097)]) {
    assert.equal(compileBytePattern(pattern, [255,255,255], false), null);
  }
  const getter = [1,2,3]; let reads = 0;
  Object.defineProperty(getter, 1, { get() { reads++; return 2; } });
  assert.equal(compileBytePattern(getter, [255,255,255], false), null);
  assert.equal(reads, 0);
  assert.equal(compileBytePattern([1,2,3], null, false), null);
});
