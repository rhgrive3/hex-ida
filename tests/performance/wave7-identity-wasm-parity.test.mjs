import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { openBinary } from '../../js/binary/index.js';
import { buildSampleBinary } from '../../js/sample.js';
import { fnv64Bytes, fnv64ByteView, fnv64Hex } from '../../js/core/identity/fnv64.js';
import { stableStringify, stableDigest } from '../../js/core/identity/index.js';
import { getWasmCallCount, resetAllTelemetry, isWasmEngineAvailable } from '../../js/core/hex-engine-bridge.js';

const GOLDEN_CORPUS = [
  { id: 'macho-sample-arm64', load: () => buildSampleBinary() },
  { id: 'arm64-semantic-holdout', load: () => new Uint8Array(fs.readFileSync('tests/scpa/fixtures/arm64-real-byte-semantic-holdout.elf')) },
  { id: 'arm64-fpsimd-holdout', load: () => new Uint8Array(fs.readFileSync('tests/scpa/fixtures/arm64-real-byte-fpsimd-atomic-holdout.elf')) },
  { id: 'arm64-threaded-int', load: () => new Uint8Array(fs.readFileSync('tests/scpa/fixtures/threaded-integer.elf')) },
  { id: 'arm64-threaded-mem', load: () => new Uint8Array(fs.readFileSync('tests/scpa/fixtures/threaded-call-memory.elf')) },
  { id: 'arm64-dispatch-table', load: () => new Uint8Array(fs.readFileSync('tests/scpa/fixtures/dispatch-table.elf')) },
  { id: 'arm64-gnu-b-key-cfi', load: () => new Uint8Array(fs.readFileSync('tests/phase4/binary/fixtures/issue-4255-gnu-b-key-cfi.elf')) },
];

function withEngineMode(mode, fn) {
  const prev = globalThis.HEX_ENGINE;
  globalThis.HEX_ENGINE = mode;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete globalThis.HEX_ENGINE;
    else globalThis.HEX_ENGINE = prev;
  }
}

test('Wave 7 Identity WASM: golden fixture 1-bit parity and telemetry count >= 1', () => {
  assert.equal(isWasmEngineAvailable(), true, 'WASM engine must be available');
  const golden = JSON.parse(fs.readFileSync('fixtures/golden/identity-outputs.json', 'utf8'));
  assert.equal(golden.length, 7);

  const byId = new Map(GOLDEN_CORPUS.map((entry) => [entry.id, entry]));

  resetAllTelemetry();
  withEngineMode('wasm', () => {
    for (const rec of golden) {
      const entry = byId.get(rec.binary);
      assert.ok(entry, `Missing fixture loader for ${rec.binary}`);
      const img = openBinary(entry.load(), { strings: true });
      const sec = (img.sections || []).find((s) => s.perms?.execute || /\.text|__text/i.test(s.name || ''));
      assert.ok(sec, `Missing executable section for ${rec.binary}`);
      const baseAddr = BigInt(sec.address ?? 0n);
      const fileOff = Number(sec.fileOffset ?? 0n);
      const fileLen = Number(sec.fileSize ?? sec.size ?? 0n);
      const rawBytes = img.bytes.subarray(fileOff, fileOff + fileLen);
      assert.equal(rawBytes.length, rec.inputLen);

      const viewRes = fnv64ByteView(rawBytes);
      assert.equal(viewRes.low, rec.low, `fnv64ByteView low mismatch on ${rec.binary}`);
      assert.equal(viewRes.high, rec.high, `fnv64ByteView high mismatch on ${rec.binary}`);

      const bytesRes = fnv64Bytes(rawBytes);
      assert.equal(bytesRes.low, rec.low, `fnv64Bytes low mismatch on ${rec.binary}`);
      assert.equal(bytesRes.high, rec.high, `fnv64Bytes high mismatch on ${rec.binary}`);

      const insnCount = Math.floor(rawBytes.length / 4);
      const digestInput = { binary: rec.binary, len: rawBytes.length, base: baseAddr.toString(16), insnCount };
      assert.equal(stableDigest(digestInput), rec.stableDigestHex, `stableDigest mismatch on ${rec.binary}`);

      const strInput = { b: 2, a: [1, -0, null, true, 'hex'], c: { z: 9, y: 8 } };
      assert.equal(stableStringify(strInput), rec.stableStringify, `stableStringify mismatch on ${rec.binary}`);
    }
  });

  const wasmCalls = getWasmCallCount('identity');
  assert.ok(wasmCalls >= golden.length * 4, `Expected >= ${golden.length * 4} identity WASM calls, got ${wasmCalls}`);
});

test('Wave 7 Identity WASM vs JS: 0-diff parity across edge cases', () => {
  const sparse = [1, 2, 3];
  delete sparse[1];

  const protoObj = {};
  Object.defineProperty(protoObj, '__proto__', { value: 42, enumerable: true, configurable: true, writable: true });
  protoObj.a = 1;

  const cases = [
    null,
    true,
    false,
    0,
    -0,
    1,
    -42,
    0.1,
    0.1 + 0.2,
    1e-7,
    1e20,
    1e21,
    1e100,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '',
    'plain-ascii',
    '日本語テスト 🚀 "quote" \\slash\n\t\u0000',
    '\ud800',
    '\udc00',
    123456789012345678901234567890n,
    new Date('2026-01-02T03:04:05.678Z'),
    new Uint8Array([0, 1, 127, 128, 255]),
    new Uint8Array([9, 8, 7]).buffer,
    new Map([['b', 2], ['a', 1], [10, 'ten'], [2, 'two']]),
    new Set(['z', 'a', 1, -0, null]),
    [1, -0, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, true, 'hex', { z: 1, a: 2 }],
    sparse,
    { '10': 1, '2': 2, '0': 0, b: 3, a: 4 },
    { keep: null, dropNan: Number.NaN, dropInf: Number.POSITIVE_INFINITY, dropUndef: undefined, dropFn: () => 1, dropSym: Symbol('x') },
    { nested: { z: [1, { b: -0, a: '🚀' }], a: new Date(0) } },
    { loneKey: '\ud800', '\udc00': 'loneVal' },
    protoObj,
  ];

  resetAllTelemetry();
  for (const val of cases) {
    const jsStr = withEngineMode('js', () => stableStringify(val));
    const wasmStr = withEngineMode('wasm', () => stableStringify(val));
    assert.equal(wasmStr, jsStr, `stableStringify diff for ${String(val)}`);

    const jsDig = withEngineMode('js', () => stableDigest(val));
    const wasmDig = withEngineMode('wasm', () => stableDigest(val));
    assert.equal(wasmDig, jsDig, `stableDigest diff for ${String(val)}`);
  }

  assert.equal(withEngineMode('wasm', () => stableStringify(undefined)), undefined);
  assert.equal(withEngineMode('js', () => stableStringify(undefined)), undefined);

  assert.ok(getWasmCallCount('identity') >= 1, 'Expected WASM identity calls during edge-case parity check');
});

test('Wave 7 Identity WASM: error contracts and custom seed/iterator fallback parity', () => {
  const cyclic = { a: 1 };
  cyclic.self = cyclic;

  class CustomThing {
    constructor() { this.x = 1; }
  }

  const invalidDate = new Date(Number.NaN);

  for (const mode of ['wasm', 'js']) {
    withEngineMode(mode, () => {
      assert.throws(() => stableStringify(cyclic), /identity-cyclic-value/);
      assert.throws(() => stableDigest(cyclic), /identity-cyclic-value/);
      assert.throws(() => stableStringify(new CustomThing()), /identity-unsupported-object/);
      assert.throws(() => stableDigest(new CustomThing()), /identity-unsupported-object/);
      assert.throws(() => stableStringify(invalidDate), /identity-invalid-date/);
      assert.throws(() => stableDigest(invalidDate), /identity-invalid-date/);
      assert.throws(() => fnv64ByteView(new Uint8Array([1]), -1, 0), /fnv64-invalid-seed/);
      assert.throws(() => fnv64Bytes([256]), /hashBytes byte must be an integer 0\.\.255/);
    });
  }

  // Custom seed must stay bit-exact with JS
  const sample = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]);
  const jsCustomSeed = withEngineMode('js', () => fnv64ByteView(sample, 0x12345678, 0x9abcdef0));
  const wasmCustomSeed = withEngineMode('wasm', () => fnv64ByteView(sample, 0x12345678, 0x9abcdef0));
  assert.deepEqual(wasmCustomSeed, jsCustomSeed);
  assert.equal(fnv64Hex(wasmCustomSeed.low, wasmCustomSeed.high), fnv64Hex(jsCustomSeed.low, jsCustomSeed.high));
});

test('Wave 7 Identity WASM: HEX_ENGINE=js rollback executes zero WASM calls', () => {
  const payload = { b: 2, a: [1, -0, null, true, 'hex'], c: { z: 9, y: 8 } };
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  resetAllTelemetry();
  const jsResults = withEngineMode('js', () => ({
    str: stableStringify(payload),
    dig: stableDigest(payload),
    view: fnv64ByteView(bytes),
    iter: fnv64Bytes(bytes),
  }));
  assert.equal(getWasmCallCount('identity'), 0, 'HEX_ENGINE=js must record 0 WASM identity calls');

  const wasmResults = withEngineMode('wasm', () => ({
    str: stableStringify(payload),
    dig: stableDigest(payload),
    view: fnv64ByteView(bytes),
    iter: fnv64Bytes(bytes),
  }));
  assert.ok(getWasmCallCount('identity') >= 4, 'HEX_ENGINE=wasm must record >= 4 WASM identity calls');
  assert.deepEqual(wasmResults, jsResults);
});
