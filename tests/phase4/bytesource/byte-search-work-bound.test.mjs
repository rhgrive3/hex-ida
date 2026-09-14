import assert from 'node:assert/strict';
import test from 'node:test';
import { compileBytePattern } from '../../../js/platform/byte-search.js';

function folded(byte) { return byte >= 65 && byte <= 90 ? byte + 32 : byte; }
function naive(bytes, pattern, masks, foldAscii, from = 0) {
  const result = [];
  for (let at = from; at <= bytes.length - pattern.length; at++) {
    let matched = true;
    for (let j = 0; j < pattern.length; j++) {
      const actual = foldAscii ? folded(bytes[at + j]) : bytes[at + j];
      const expected = foldAscii ? folded(pattern[j]) : pattern[j];
      if (foldAscii ? actual !== expected : (actual & masks[j]) !== expected) { matched = false; break; }
    }
    if (matched) result.push(at);
  }
  return result;
}
function allMatches(matcher, bytes, from = 0) {
  const result = [];
  let minimum = from;
  for (let at = matcher.find(bytes, minimum); at !== -1; at = matcher.find(bytes, minimum)) {
    // Enforce caller progress as well as oracle equality: a faulty fallback
    // that ignores `from` must fail promptly, not strand the test in a loop.
    assert.ok(Number.isInteger(at) && at >= minimum && at < bytes.length, `non-advancing match ${at} before ${minimum}`);
    result.push(at);
    minimum = at + 1;
  }
  return result;
}
function counted(bytes) {
  let reads = 0;
  const view = new Proxy(bytes, {
    get(target, name) {
      if (typeof name === 'string' && /^(0|[1-9][0-9]*)$/.test(name)) reads++;
      return Reflect.get(target, name, target);
    },
  });
  return { view, count: () => reads };
}
function assertFindWork(bytes, pattern, masks, foldAscii, from = 0) {
  const matcher = compileBytePattern(pattern, masks, foldAscii);
  assert.ok(matcher);
  const oracle = naive(bytes, pattern, masks, foldAscii, from)[0] ?? -1;
  const { view, count } = counted(bytes);
  assert.equal(matcher.find(view, from), oracle);
  // This is a deterministic source-probe bound, NOT an elapsed-time assertion.
  // Native BigInt bit operations in the bounded fallback have separate cost.
  const limit = 4 * (bytes.length - from) + 2 * pattern.length + 16;
  assert.ok(count() <= limit, `source probes ${count()} exceed ${limit} (n=${bytes.length}, m=${pattern.length}, from=${from})`);
}

for (const mode of ['text', 'exact-hex', 'high-nibble', 'low-nibble', 'mixed']) {
  test(`repeated suffix keeps source probes bounded: ${mode}`, () => {
    const n = 4096, m = 128;
    const fill = mode === 'mixed' ? 0xaa : 0x61;
    const bytes = new Uint8Array(n).fill(fill);
    const masks = Uint8Array.from({ length: m }, (_, j) => mode === 'high-nibble' ? 0xf0 : mode === 'low-nibble' ? 0x0f : mode === 'mixed' ? [0xff, 0, 0x55, 0xaa][j % 4] : 0xff);
    masks[0] = 0xff;
    const pattern = Uint8Array.from(masks, mask => fill & mask);
    pattern[0] = fill ^ 1;
    assertFindWork(bytes, pattern, masks, mode === 'text');
  });
}

test('fallback finds late ASCII-folded positives and retains nonzero from offsets', () => {
  const bytes = new Uint8Array(4096).fill(0x41);
  const pattern = new Uint8Array(128).fill(0x61); pattern[0] = 0x62;
  bytes[3000] = 0x42;
  assertFindWork(bytes, pattern, null, true);
  assertFindWork(bytes, pattern, null, true, 63);
  assertFindWork(bytes, pattern, null, true, 3001);
});

test('late overlapping matches and reused compiled state agree with a naive oracle', () => {
  const bytes = new Uint8Array(6000).fill(0x61);
  const pattern = new Uint8Array(128).fill(0x61); pattern[1] = 0x62;
  for (const at of [4096, 4223, 4350]) bytes[at + 1] = 0x62;
  const masks = new Uint8Array(pattern.length).fill(255);
  const matcher = compileBytePattern(pattern, masks, false);
  const actual = allMatches(matcher, bytes);
  assert.deepEqual(actual, naive(bytes, pattern, masks, false));
  assert.deepEqual(actual, [4096, 4223, 4350]);
  // A compiled object must not retain the previous haystack's partial state.
  assert.equal(matcher.find(new Uint8Array(6000).fill(0x61)), -1);
  assert.equal(matcher.find(bytes), 4096);
});

test('all wildcard and impossible masked patterns keep their original semantics', () => {
  const bytes = new Uint8Array(32);
  const masks = new Uint8Array(3);
  const any = compileBytePattern(new Uint8Array(3), masks, false);
  assert.equal(any.find(bytes, 7), 7);
  assert.equal(any.find(bytes, 30), -1);
  const impossible = compileBytePattern(Uint8Array.of(1, 0, 0), masks, false);
  assert.equal(impossible.find(bytes), -1);
  const narrow = compileBytePattern(Uint8Array.of(0x81, 0, 0), Uint8Array.of(0x0f, 0xff, 0xff), false);
  assert.equal(narrow.find(bytes), -1);
});

test('maximum compiled length stays bounded and matches on the final valid start', () => {
  const pattern = new Uint8Array(4096).fill(0x61); pattern[0] = 0x62;
  const bytes = new Uint8Array(8224).fill(0x61); bytes[4128] = 0x62;
  assertFindWork(bytes, pattern, null, true);
});

test('small complete binary-input and mask matrix preserves all matches', () => {
  let cases = 0;
  for (let pat = 0; pat < 8; pat++) {
    const pattern = Uint8Array.from({ length: 3 }, (_, i) => (pat >> i) & 1);
    for (let rawMask = 0; rawMask < 27; rawMask++) {
      let value = rawMask;
      const masks = Uint8Array.from({ length: 3 }, () => { const out = [0, 1, 255][value % 3]; value = Math.floor(value / 3); return out; });
      const matcher = compileBytePattern(pattern, masks, false);
      for (let word = 0; word < 128; word++) {
        const bytes = Uint8Array.from({ length: 7 }, (_, i) => (word >> i) & 1);
        const actual = allMatches(matcher, bytes);
        assert.deepEqual(actual, naive(bytes, pattern, masks, false)); cases++;
      }
    }
  }
  assert.equal(cases, 27648);
});


test('compiled admissions remain an owned snapshot and reset for each find', () => {
  const pattern = new Uint8Array(128).fill(0x61); pattern[0] = 0x62;
  const masks = new Uint8Array(128).fill(255);
  const matcher = compileBytePattern(pattern, masks, false);
  assert.equal(matcher.find(new Uint8Array(4096).fill(0x61)), -1);
  pattern.fill(0); masks.fill(0);
  const bytes = new Uint8Array(4096).fill(0x61); bytes[3000] = 0x62;
  assert.equal(matcher.find(bytes), 3000);
  assert.equal(matcher.find(bytes, 3001), -1);
  assert.equal(matcher.find(bytes), 3000);
});

test('forced repeated-prefix inputs agree with a naive oracle over arbitrary bit masks', () => {
  let seed = 0x156adc9b;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let trial = 0; trial < 256; trial++) {
    const size = 1024, length = [7, 16, 31, 64, 127][trial % 5];
    const bytes = new Uint8Array(size).fill(0xaa);
    for (let at = size / 2; at < size; at++) bytes[at] = random() & 255;
    const masks = Uint8Array.from({ length }, () => random() & 255); masks[0] = 255;
    const pattern = Uint8Array.from(masks, mask => 0xaa & mask); pattern[0] = 0x2a;
    if (trial % 3) {
      const position = size - length;
      for (let j = 0; j < length; j++) bytes[position + j] = (random() & (255 ^ masks[j])) | pattern[j];
    }
    const from = trial % 17;
    assertFindWork(bytes, pattern, masks, false, from);
    const matcher = compileBytePattern(pattern, masks, false);
    const actual = allMatches(matcher, bytes, from);
    assert.deepEqual(actual, naive(bytes, pattern, masks, false, from), `mask trial ${trial}`);
  }
});
