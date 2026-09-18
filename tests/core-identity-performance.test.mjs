import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonSafe, stableStringify, stableDigest } from '../js/core/identity/index.js';
import { fnv64Text, fnv64Bytes, fnv64Hex } from '../js/core/identity/fnv64.js';
import * as baseline from './helpers/core-identity-baseline-oracle.mjs';

let state = 0x75ab9213;
function random() { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; }
function oldFnv(units, low = 0x84222325, high = 0xcbf29ce4) {
  let hash = (BigInt(high) << 32n) | BigInt(low);
  for (const unit of units) hash = BigInt.asUintN(64, (hash ^ BigInt(unit)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}
function oldText(text, low, high) {
  return oldFnv(Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)), low, high);
}
function outcome(fn) {
  try { return { ok: true, value: fn() }; }
  catch (error) { return { ok: false, name: error.name, message: error.message }; }
}
function same(value) {
  assert.deepStrictEqual(outcome(() => jsonSafe(value)), outcome(() => baseline.jsonSafe(value)));
  assert.deepStrictEqual(outcome(() => stableStringify(value)), outcome(() => baseline.stableStringify(value)));
  assert.deepStrictEqual(outcome(() => stableDigest(value)), outcome(() => baseline.stableDigest(value)));
}

test('limb FNV is bit-exact for both identity seeds and every UTF-16 code unit', () => {
  const allUnits = Array.from({ length: 65536 }, (_, i) => String.fromCharCode(i)).join('');
  for (const text of ['', 'a', 'foobar', '日本語\0😀\ud800\udfff', allUnits]) {
    assert.equal(fnv64Text(text), oldText(text));
    assert.equal(fnv64Text(text, 0xcbf29ce4, 0x84222325), oldText(text, 0xcbf29ce4, 0x84222325));
  }
  for (let i = 0; i < 400; i++) {
    const text = Array.from({ length: random() % 128 }, () => String.fromCharCode(random() & 0xffff)).join('');
    const low = random(), high = random();
    assert.equal(fnv64Text(text, low, high), oldText(text, low, high));
    assert.equal(stableDigest({ text, i }), baseline.stableDigest({ text, i }));
  }
});

test('byte FNV is exact across carry, overflow, arbitrary seeds and chunk boundaries', () => {
  const bytes = Uint8Array.from({ length: 16385 }, (_, i) => i < 256 ? i : random() & 255);
  const expected = oldFnv(bytes);
  for (const chunkSize of [1, 3, 17, 255, 1024, 8192, 16385]) {
    let low = 0x84222325, high = 0xcbf29ce4;
    for (let at = 0; at < bytes.length; at += chunkSize) {
      ({ low, high } = fnv64Bytes(bytes.subarray(at, at + chunkSize), low, high));
    }
    assert.equal(fnv64Hex(low, high), expected, `chunk size ${chunkSize}`);
  }
  for (let i = 0; i < 400; i++) {
    const low = random(), high = random();
    const sample = bytes.subarray(0, random() % 256);
    const actual = fnv64Bytes(sample, low, high);
    assert.equal(fnv64Hex(actual.low, actual.high), oldFnv(sample, low, high));
  }
  for (const byte of [NaN, Infinity, -1, 256, 1.5, '1', 1n, true, null, undefined, {}]) {
    assert.throws(() => fnv64Bytes([byte]), /hashBytes byte must be an integer 0\.\.255/);
  }
  for (const seed of [-1, 0x100000000, NaN, Infinity, 1.5, '1', 1n, null]) {
    assert.throws(() => fnv64Text('test', seed, 0), /fnv64-invalid-seed/);
    assert.throws(() => fnv64Bytes([], 0, seed), /fnv64-invalid-seed/);
  }
});

test('allocation-reduced jsonSafe preserves sorted own descriptors and prototype names', () => {
  const value = JSON.parse('{"z":3,"__proto__":{"keep":1},"constructor":2,"toString":4,"10":10,"2":2,"a":5}');
  const actual = jsonSafe(value), expected = baseline.jsonSafe(value);
  assert.deepStrictEqual(Object.getOwnPropertyDescriptors(actual), Object.getOwnPropertyDescriptors(expected));
  assert.equal(Object.getPrototypeOf(actual), Object.prototype);
  same(value);
  let setterCalls = 0;
  Object.defineProperty(Object.prototype, '__hex_perf_inherited_setter__', {
    set() { setterCalls++; }, configurable: true,
  });
  Object.defineProperty(Object.prototype, '__hex_perf_inherited_readonly__', {
    value: 'inherited', writable: false, configurable: true,
  });
  let result;
  try {
    result = jsonSafe({ __hex_perf_inherited_setter__: 123, __hex_perf_inherited_readonly__: 456 });
  } finally {
    delete Object.prototype.__hex_perf_inherited_setter__;
    delete Object.prototype.__hex_perf_inherited_readonly__;
  }
  assert.equal(setterCalls, 0);
  assert.deepStrictEqual(result, { __hex_perf_inherited_setter__: 123, __hex_perf_inherited_readonly__: 456 });
});

test('canonical serialization matches the pinned oracle for containers, cycles and exceptional values', () => {
  const cycle = {}; cycle.self = cycle;
  const fixtures = [undefined, null, false, true, -0, NaN, Infinity, 999999999999999999999n,
    '日本語😀', new Date('2026-09-09'), new Date(NaN), Symbol('x'), () => 1,
    new Uint8Array([0, 128, 255]).subarray(1), new DataView(new Uint8Array([1, 2, 3]).buffer),
    [undefined, , null, -0], { b: undefined, a: null, f: () => 0, symbol: Symbol('y') }, cycle,
    new Map([[1n, new Set([3, 2, 1])], ['1', { x: 3 }]]), new Set([1, '1', 1n, { z: 1 }, { a: 2 }])];
  for (const value of fixtures) same(value);
  for (let i = 0; i < 150; i++) {
    const record = {};
    for (let n = 0; n < 12; n++) record[`field_${random() % 19}`] = [random(), BigInt(random()), String.fromCharCode(random() & 0xffff), n % 3 ? null : -0];
    same({ record, list: Object.values(record), set: new Set(Object.keys(record)) });
  }
});

test('#5054 jsonSafe snapshots each enumerable property value exactly once', () => {
  let invalidReads = 0;
  const nanThenThrow = {};
  Object.defineProperty(nanThenThrow, 'x', {
    enumerable: true,
    get() {
      invalidReads++;
      if (invalidReads > 1) throw new Error('getter evaluated twice');
      return NaN;
    },
  });
  assert.deepStrictEqual(jsonSafe(nanThenThrow), {});
  assert.equal(invalidReads, 1);

  let changingReads = 0;
  const nanThenNull = {};
  Object.defineProperty(nanThenNull, 'x', {
    enumerable: true,
    get() {
      changingReads++;
      return changingReads === 1 ? NaN : null;
    },
  });
  assert.deepStrictEqual(jsonSafe(nanThenNull), {});
  assert.equal(changingReads, 1);

  let nullReads = 0;
  const nullThenThrow = new Proxy({}, {
    ownKeys() { return ['x']; },
    getOwnPropertyDescriptor(_target, key) {
      if (key === 'x') return { enumerable: true, configurable: true };
      return undefined;
    },
    get(_target, key) {
      if (key !== 'x') return undefined;
      nullReads++;
      if (nullReads > 1) throw new Error('proxy property evaluated twice');
      return null;
    },
  });
  assert.deepStrictEqual(jsonSafe(nullThenThrow), { x: null });
  assert.equal(nullReads, 1);

  for (const lossy of [NaN, Infinity, -Infinity, () => 1, Symbol('x')]) {
    let reads = 0;
    const value = {};
    Object.defineProperty(value, 'x', { enumerable: true, get() { reads++; return lossy; } });
    assert.deepStrictEqual(jsonSafe(value), {});
    assert.equal(reads, 1);
  }

  let undefinedReads = 0;
  const explicitUndefined = {};
  Object.defineProperty(explicitUndefined, 'x', {
    enumerable: true,
    get() { undefinedReads++; return undefined; },
  });
  assert.deepStrictEqual(jsonSafe(explicitUndefined), { x: undefined });
  assert.equal(undefinedReads, 1);

  const nestedReads = [];
  const nested = {};
  Object.defineProperty(nested, 'outer', {
    enumerable: true,
    get() {
      nestedReads.push('outer');
      const child = {};
      Object.defineProperty(child, 'inner', {
        enumerable: true,
        get() { nestedReads.push('inner'); return Infinity; },
      });
      return child;
    },
  });
  assert.deepStrictEqual(jsonSafe(nested), { outer: {} });
  assert.deepStrictEqual(nestedReads, ['outer', 'inner']);

  assert.deepStrictEqual(jsonSafe({ keep: null, preserveUntilJson: undefined }), { keep: null, preserveUntilJson: undefined });
  assert.equal(stableStringify({ z: 1, a: null, dropAtJson: undefined }), '{"a":null,"z":1}');
  assert.equal(stableDigest({ z: 1, a: null }), baseline.stableDigest({ z: 1, a: null }));

  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => jsonSafe(cycle), /identity-cyclic-value/);
});
