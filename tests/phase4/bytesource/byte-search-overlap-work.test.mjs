import assert from 'node:assert/strict';
import test from 'node:test';
import { compileBytePattern } from '../../../js/platform/byte-search.js';

const fold = byte => byte >= 65 && byte <= 90 ? byte + 32 : byte;
function oracle(bytes, pattern, masks, text, from = 0) {
  const out = [];
  for (let at = from; at <= bytes.length - pattern.length; at++) {
    if (pattern.every((b, j) => text ? fold(bytes[at + j]) === fold(b) : (bytes[at + j] & masks[j]) === b)) out.push(at);
  }
  return out;
}
// The legacy fallback deliberately exercises the old production enumeration,
// so this test reports excess work (not merely a missing new method) pre-fix.
function* matches(matcher, bytes, from = 0) {
  if (matcher.findAll) { yield* matcher.findAll(bytes, from); return; }
  for (let at = matcher.find(bytes, from); at !== -1; at = matcher.find(bytes, at + 1)) yield at;
}
function counted(bytes) {
  let probes = 0;
  const view = new Proxy(bytes, { get(target, key) {
    if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) probes++;
    return Reflect.get(target, key, target);
  } });
  return { view, probes: () => probes };
}
for (const mode of ['text', 'exact', 'nibble', 'mixed']) {
  test(`dense overlapping ${mode} matches have a cumulative source-probe bound`, () => {
    const patternLength = 128;
    const bytes = new Uint8Array(2048).fill(0x61);
    const masks = Uint8Array.from({ length: patternLength }, (_, j) => mode === 'nibble' ? 0x0f : mode === 'mixed' ? [255, 0, 0x0f, 0xf0][j % 4] : 255);
    const pattern = Uint8Array.from(masks, m => 0x61 & m);
    if (mode === 'text') pattern.fill(0x41);
    const matcher = compileBytePattern(pattern, masks, mode === 'text');
    for (const from of [0, 7, bytes.length - patternLength, bytes.length]) {
      const { view, probes } = counted(bytes);
      const actual = [...matches(matcher, view, from)];
      assert.deepEqual(actual, oracle(bytes, pattern, masks, mode === 'text', from));
      const budget = 6 * (bytes.length - from) + 3 * patternLength + 16;
      assert.ok(probes() <= budget, `overlap source probes ${probes()} exceed ${budget}`);
    }
  });
}
test('periodic overlaps cross the fast/streaming boundary without loss or duplication', () => {
  const bytes = Uint8Array.from({ length: 4096 }, (_, i) => i % 3 === 0 ? 0x42 : 0x61);
  const pattern = bytes.slice(0, 127), masks = new Uint8Array(pattern.length).fill(255);
  const matcher = compileBytePattern(pattern, masks, false);
  const { view, probes } = counted(bytes);
  assert.deepEqual([...matches(matcher, view, 2)], oracle(bytes, pattern, masks, false, 2));
  assert.ok(probes() <= 6 * bytes.length + 3 * pattern.length + 16, `periodic probes ${probes()}`);
});
test('iterator is lazy, independently restartable, and retains no haystack state between requests', () => {
  const bytes = new Uint8Array(8192).fill(0x41), pattern = new Uint8Array(512).fill(0x61);
  const matcher = compileBytePattern(pattern, null, true);
  assert.equal(typeof matcher.findAll, 'function');
  const { view, probes } = counted(bytes);
  const first = matcher.findAll(view), second = matcher.findAll(bytes, 20);
  assert.equal(probes(), 0);
  assert.deepEqual(first.next(), { value: 0, done: false });
  assert.ok(probes() <= pattern.length + 1, 'first result must not scan the rest of the buffer');
  assert.equal(second.next().value, 20);
  assert.equal(first.next().value, 1);
  first.return();
  const afterReturn = probes();
  assert.equal(first.next().done, true);
  assert.equal(probes(), afterReturn);
  assert.deepEqual([...matcher.findAll(new Uint8Array(8192))], []);
  assert.equal(matcher.find(bytes), 0);
});
test('all-wildcard, impossible masks, and maximum width retain enumeration semantics', () => {
  for (const [pattern, mask, bytes] of [
    [new Uint8Array(3), new Uint8Array(3), new Uint8Array(16)],
    [Uint8Array.of(1, 0, 0), new Uint8Array(3), new Uint8Array(16)],
    [new Uint8Array(4096).fill(1), new Uint8Array(4096).fill(255), new Uint8Array(4200).fill(1)],
  ]) {
    const matcher = compileBytePattern(pattern, mask, false);
    assert.deepEqual([...matches(matcher, bytes, 3)], oracle(bytes, pattern, mask, false, 3));
  }
});
test('seeded arbitrary-mask enumeration agrees with an independent scalar oracle', () => {
  let seed = 0x7f4539ab;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let trial = 0; trial < 512; trial++) {
    const size = 64 + (random() % 128), length = 3 + (random() % 29);
    const bytes = Uint8Array.from({ length: size }, () => random() & 255);
    const masks = Uint8Array.from({ length }, () => random() & 255);
    const pattern = Uint8Array.from(masks, mask => random() & mask);
    const at = random() % (size - length + 1);
    for (let j = 0; j < length; j++) bytes[at + j] = (bytes[at + j] & (255 ^ masks[j])) | pattern[j];
    const matcher = compileBytePattern(pattern, masks, false), from = trial % 7;
    assert.deepEqual([...matches(matcher, bytes, from)], oracle(bytes, pattern, masks, false, from), `trial ${trial}`);
  }
});
