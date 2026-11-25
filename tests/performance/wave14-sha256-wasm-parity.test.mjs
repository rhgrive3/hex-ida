import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { IncrementalSha256, sha256BlobHex } from '../../js/cache/content-identity.js';
import {
  getWasmCallCount,
  resetAllTelemetry,
} from '../../js/core/wasm-telemetry.js';

function withEngineMode(mode, fn) {
  const prevGlobal = globalThis.HEX_ENGINE;
  const prevInternal = globalThis.__HEX_ENGINE_MODE__;
  const prevEnv = process.env.HEX_ENGINE;
  try {
    if (mode == null) {
      delete globalThis.HEX_ENGINE;
      delete globalThis.__HEX_ENGINE_MODE__;
      delete process.env.HEX_ENGINE;
    } else {
      globalThis.HEX_ENGINE = mode;
      delete globalThis.__HEX_ENGINE_MODE__;
      delete process.env.HEX_ENGINE;
    }
    return fn();
  } finally {
    if (prevGlobal === undefined) delete globalThis.HEX_ENGINE;
    else globalThis.HEX_ENGINE = prevGlobal;
    if (prevInternal === undefined) delete globalThis.__HEX_ENGINE_MODE__;
    else globalThis.__HEX_ENGINE_MODE__ = prevInternal;
    if (prevEnv === undefined) delete process.env.HEX_ENGINE;
    else process.env.HEX_ENGINE = prevEnv;
  }
}

function makePatternBytes(length, seed = 0x12345678) {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

function sha256Hex(bytes) {
  return new IncrementalSha256().update(bytes).hexDigest();
}

function nodeCryptoSha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

test('Wave 14 SHA-256 WASM parity: NIST FIPS 180-4 vectors and boundary sizes (0B..1MiB)', () => {
  const enc = new TextEncoder();
  const nistVectors = [
    {
      label: 'empty',
      bytes: new Uint8Array(0),
      expected: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
    {
      label: 'abc',
      bytes: enc.encode('abc'),
      expected: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    },
    {
      label: 'nist-448bit-56B',
      bytes: enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      expected: '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    },
  ];

  const boundarySizes = [55, 56, 63, 64, 65, 128, 1000, 1024 * 1024];
  const allCases = [
    ...nistVectors,
    ...boundarySizes.map((len) => {
      const bytes = makePatternBytes(len, 0x9e3779b9 ^ len);
      return {
        label: `pattern-${len}B`,
        bytes,
        expected: nodeCryptoSha256Hex(bytes),
      };
    }),
  ];

  // 1. JS mode: 0 WASM calls
  const jsDigests = withEngineMode('js', () => {
    resetAllTelemetry();
    const results = allCases.map((tc) => {
      const hex = sha256Hex(tc.bytes);
      assert.equal(hex, tc.expected, `JS digest mismatch on ${tc.label}`);
      return hex;
    });
    assert.equal(getWasmCallCount('sha256'), 0, 'HEX_ENGINE=js must record 0 sha256 WASM calls');
    return results;
  });

  // 2. WASM forced mode: 0-diff vs JS and > 0 WASM calls
  withEngineMode('wasm', () => {
    resetAllTelemetry();
    allCases.forEach((tc, idx) => {
      const hex = sha256Hex(tc.bytes);
      assert.equal(hex, jsDigests[idx], `WASM digest mismatch on ${tc.label}`);
      assert.equal(hex, tc.expected, `WASM vs expected mismatch on ${tc.label}`);
    });
    assert.ok(
      getWasmCallCount('sha256') > 0,
      `expected getWasmCallCount('sha256') > 0 in wasm mode, got ${getWasmCallCount('sha256')}`,
    );
  });

  // 3. Auto mode: 0-diff vs JS and > 0 WASM calls (>= 4 blocks triggered by 1000B & 1MiB)
  withEngineMode('auto', () => {
    resetAllTelemetry();
    allCases.forEach((tc, idx) => {
      const hex = sha256Hex(tc.bytes);
      assert.equal(hex, jsDigests[idx], `auto digest mismatch on ${tc.label}`);
    });
    assert.ok(
      getWasmCallCount('sha256') > 0,
      `expected getWasmCallCount('sha256') > 0 in auto mode, got ${getWasmCallCount('sha256')}`,
    );
  });
});

test('Wave 14 SHA-256 WASM parity: chunked streaming update() across irregular boundaries', () => {
  const payload = makePatternBytes(65537, 0xdeadbeef);
  const expected = nodeCryptoSha256Hex(payload);
  const chunkSchedule = [1, 7, 63, 64, 65, 300, 10000, 5, 255, 256, 257, 4096, 13, 511, 512, 513];

  function hashChunked(bytes, chunks) {
    const h = new IncrementalSha256();
    let pos = 0;
    let cIdx = 0;
    while (pos < bytes.length) {
      const size = chunks[cIdx % chunks.length];
      cIdx += 1;
      const end = Math.min(bytes.length, pos + size);
      h.update(bytes.subarray(pos, end));
      pos = end;
    }
    return h.hexDigest();
  }

  const jsHex = withEngineMode('js', () => {
    resetAllTelemetry();
    const out = hashChunked(payload, chunkSchedule);
    assert.equal(getWasmCallCount('sha256'), 0);
    return out;
  });
  assert.equal(jsHex, expected);

  const wasmHex = withEngineMode('wasm', () => {
    resetAllTelemetry();
    const out = hashChunked(payload, chunkSchedule);
    assert.ok(getWasmCallCount('sha256') > 0);
    return out;
  });
  assert.equal(wasmHex, jsHex, 'chunked streaming WASM vs JS mismatch');

  const autoHex = withEngineMode('auto', () => {
    resetAllTelemetry();
    const out = hashChunked(payload, chunkSchedule);
    assert.ok(getWasmCallCount('sha256') > 0);
    return out;
  });
  assert.equal(autoHex, jsHex, 'chunked streaming auto vs JS mismatch');
});

test('Wave 14 SHA-256 WASM parity: sha256BlobHex matches JS and honors HEX_ENGINE=js', async () => {
  const raw = makePatternBytes(262144 + 77, 0xabcdef01);
  const expected = nodeCryptoSha256Hex(raw);
  const fakeBlob = {
    size: raw.byteLength,
    slice(start, end) {
      const sub = raw.subarray(start, end);
      return { arrayBuffer: async () => sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength) };
    },
  };

  const prevGlobal = globalThis.HEX_ENGINE;
  try {
    globalThis.HEX_ENGINE = 'js';
    resetAllTelemetry();
    const jsRes = await sha256BlobHex(fakeBlob, { chunkBytes: 65536 });
    assert.equal(jsRes.hex, expected);
    assert.equal(getWasmCallCount('sha256'), 0);

    globalThis.HEX_ENGINE = 'auto';
    resetAllTelemetry();
    const autoRes = await sha256BlobHex(fakeBlob, { chunkBytes: 65536 });
    assert.equal(autoRes.hex, jsRes.hex);
    assert.ok(getWasmCallCount('sha256') > 0);
  } finally {
    if (prevGlobal === undefined) delete globalThis.HEX_ENGINE;
    else globalThis.HEX_ENGINE = prevGlobal;
  }
});
