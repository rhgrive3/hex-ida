import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { jsonSafe, stableStringify, stableDigest, deepFreeze } from '../../js/core/identity/index.js';
import { createOriginSet, isReusableOriginSet } from '../../js/core/identity/origin.js';
import { isDeeplyFrozenPlainData, isKnownImmutableData, isKnownCanonicalJsonData,
  ordinaryJsonBehavior } from '../../js/core/identity/immutable-data.js';
import * as oracle from '../helpers/aggregate-speed-baseline/js/core/identity/index.js';

function certify(value) { deepFreeze(value); assert.equal(isDeeplyFrozenPlainData(value), true); return value; }
function compare(value) {
  assert.equal(stableStringify(value), oracle.stableStringify(value));
  assert.equal(stableDigest(value), oracle.stableDigest(value));
}

test('a producer-owned origin is reusable without certifying every descendant', () => {
  const origin = createOriginSet({ instructionIds: ['mobile:1'], sourceLocations: [{ file: '日本語', line: 1 }] });
  assert.equal(isReusableOriginSet(origin), true);
  assert.equal(isKnownImmutableData(origin.sourceLocations[0]), false);
  assert.equal(isDeeplyFrozenPlainData(origin), true);
  assert.equal(isKnownCanonicalJsonData(origin), false);
  assert.equal(isKnownImmutableData(origin.sourceLocations[0]), false);
  assert.equal(createOriginSet(origin), origin);
  compare(origin);
});

test('metadata eviction recertifies values but never evicts producer authority', () => {
  const original = certify({ a: [1, 2, 3] });
  const origin = createOriginSet({ instructionIds: ['mobile:eviction'] });
  certify(origin); const before = stableDigest(original), originBefore = stableDigest(origin);
  for (let i = 0; i < 65537; i++) certify({ n: i });
  assert.equal(isKnownImmutableData(original), false);
  assert.equal(isKnownImmutableData(origin), false);
  assert.equal(stableDigest(original), before);
  assert.equal(createOriginSet(origin), origin);
  assert.equal(isReusableOriginSet(origin), true);
  certify(original); certify(origin);
  assert.equal(stableDigest(original), before); assert.equal(stableDigest(origin), originBefore);
  compare(original); compare(origin);
});

test('text and digest eviction only causes exact recomputation', () => {
  const original = certify({ a: [1, 2, 3], big: 18446744073709551617n });
  const before = stableDigest(original), text = stableStringify(original);
  // More roots than either digest or text cache can retain in one generation.
  for (let i = 0; i < 8200; i++) stableDigest(certify({ i, text: '日本語'.repeat(16) }));
  assert.equal(stableDigest(original), before); assert.equal(stableStringify(original), text);
  compare(original);
});

test('large shared projections are call-local and public copies never alias', () => {
  const child = certify({ z: 123n, a: [1, -0, undefined, '日本語'] });
  const root = certify({ z: child, a: child, big: 'x'.repeat(300000) });
  for (let i = 0; i < 3; i++) compare(root);
  const copy = jsonSafe(root), second = jsonSafe(root);
  assert.notEqual(copy, second); assert.notEqual(copy.a, copy.z); assert.notEqual(copy.a, second.a);
  copy.a.a[0] = 99; assert.equal(root.a.a[0], 1); assert.equal(second.a.a[0], 1);
});

test('frozen external lookalikes and accessors cannot borrow the origin brand', () => {
  const origin = createOriginSet({ instructionIds: ['mobile:lookalike'] });
  const raw = { ...origin, sourceLocations: [{ nested: { value: 1 } }] }; Object.freeze(raw);
  assert.equal(isReusableOriginSet(raw), false); assert.equal(isDeeplyFrozenPlainData(raw), false);
  const before = stableDigest(raw); raw.sourceLocations[0].nested.value = 2;
  assert.notEqual(stableDigest(raw), before); compare(raw);
  let reads = 0;
  const accessor = Object.freeze(Object.defineProperty({}, 'instructionIds', {
    enumerable: true, get() { reads++; return origin.instructionIds; },
  }));
  assert.equal(isDeeplyFrozenPlainData(accessor), false); assert.equal(reads, 0);
});

test('changed array behavior makes origins follow the existing normalization fallback', () => {
  const origin = createOriginSet({ instructionIds: ['mobile:intrinsics'] });
  const map = Array.prototype.map;
  try {
    Array.prototype.map = function(fn, ...rest) { return map.call(this, fn, ...rest).concat('added'); };
    assert.equal(ordinaryJsonBehavior(), false);
    certify(origin); compare(origin);
  } finally { Array.prototype.map = map; }
  compare(origin);
});

test('origin, identity and eligibility imports initialize correctly in each entry order', () => {
  const paths = ['index.js', 'origin.js', 'immutable-data.js'];
  for (const first of paths) {
    const ordered = [first, ...paths.filter(path => path !== first)];
    const imports = ordered.map(path => new URL('../../js/core/identity/' + path, import.meta.url).href);
    const script = `for (const url of ${JSON.stringify(imports)}) await import(url);
` +
      `const i = await import(${JSON.stringify(new URL('../../js/core/identity/index.js', import.meta.url).href)});
` +
      `const o = await import(${JSON.stringify(new URL('../../js/core/identity/origin.js', import.meta.url).href)});
` +
      `const m = await import(${JSON.stringify(new URL('../../js/core/identity/immutable-data.js', import.meta.url).href)});
` +
      `const origin=o.createOriginSet({instructionIds:['cycle:ok']}); if(!m.isDeeplyFrozenPlainData(origin))throw Error('eligibility');
` +
      `if(!i.stableDigest(origin))throw Error('digest');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  }
});
