/**
 * Wave 13 K5: Byte-search WASM vs JS 0-diff parity, cross-chunk boundary,
 * and HEX_ENGINE rollback / telemetry verification suite.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as hexEngineBridge from '../../js/core/hex-engine-bridge.js';
import { getWasmCallCount, resetAllTelemetry } from '../../js/core/wasm-telemetry.js';
import { compileBytePattern } from '../../js/platform/byte-search.js';

function withEngineMode(mode, fn) {
  const prevGlobal = globalThis.HEX_ENGINE;
  const prevInternal = globalThis.__HEX_ENGINE_MODE__;
  const prevEnv = process.env.HEX_ENGINE;
  try {
    delete globalThis.__HEX_ENGINE_MODE__;
    if (mode === undefined) {
      delete globalThis.HEX_ENGINE;
      delete process.env.HEX_ENGINE;
    } else {
      globalThis.HEX_ENGINE = mode;
      process.env.HEX_ENGINE = mode;
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

function collectAllMatches(bytes, pattern, mask, foldAscii, from = 0) {
  const matcher = compileBytePattern(pattern, mask, foldAscii);
  assert.ok(matcher, 'compileBytePattern must return a matcher for valid inputs');
  const offsets = [];
  for (let at = matcher.find(bytes, from); at >= 0; at = matcher.find(bytes, at + 1)) {
    offsets.push(at);
  }
  return offsets;
}

let seed = 0x51a7f3c9;
function nextRand() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
}

const MASK_PALETTE = [255, 255, 255, 0x0f, 0xf0, 0x00, 0x55, 0xaa];

test('Wave 13 byte-search parity: 600 randomized fuzz trials (masked, ASCII-folded, overlaps, boundaries) match 100% between WASM and JS', () => {
  for (let trial = 0; trial < 600; trial += 1) {
    const patLen = 3 + (nextRand() % 28);
    const bufLen = trial % 10 === 0
      ? 4096 + (nextRand() % 4096)
      : nextRand() % 512;
    const bytes = new Uint8Array(bufLen);
    for (let i = 0; i < bufLen; i += 1) bytes[i] = nextRand() & 255;

    const foldAscii = trial % 2 === 0;
    const pattern = new Uint8Array(patLen);
    const mask = foldAscii ? null : new Uint8Array(patLen);
    for (let i = 0; i < patLen; i += 1) {
      pattern[i] = nextRand() & 255;
      if (mask) {
        mask[i] = MASK_PALETTE[nextRand() % MASK_PALETTE.length];
        if (trial % 5 !== 0) pattern[i] &= mask[i];
      }
    }

    // Plant 1-3 hits (including potential overlaps) on most trials.
    if (bufLen >= patLen && trial % 4 !== 0) {
      const hits = 1 + (nextRand() % 3);
      for (let h = 0; h < hits; h += 1) {
        const at = nextRand() % (bufLen - patLen + 1);
        for (let i = 0; i < patLen; i += 1) {
          if (foldAscii) {
            const b = pattern[i];
            const flip = (nextRand() & 1) !== 0;
            if (flip && b >= 65 && b <= 90) bytes[at + i] = b + 32;
            else if (flip && b >= 97 && b <= 122) bytes[at + i] = b - 32;
            else bytes[at + i] = b;
          } else {
            bytes[at + i] = (nextRand() & (255 ^ mask[i])) | pattern[i];
          }
        }
      }
    }

    const from = trial % 17 === 0 ? Math.max(0, bufLen - patLen) : (nextRand() % 7);
    const jsOffsets = withEngineMode('js', () => collectAllMatches(bytes, pattern, mask, foldAscii, from));
    const wasmOffsets = withEngineMode('wasm', () => collectAllMatches(bytes, pattern, mask, foldAscii, from));
    assert.deepStrictEqual(wasmOffsets, jsOffsets, `fuzz trial ${trial} (bufLen=${bufLen}, patLen=${patLen}, foldAscii=${foldAscii}, from=${from})`);
  }
});

test('Wave 13 byte-search parity: 300 KiB buffer cross-chunk boundary hits at 262,144B and overlapping matches agree 100%', () => {
  const BUF_SIZE = 300 * 1024;  // 307,200 bytes (> 262,144B chunk boundary)
  const CHUNK_BOUNDARY = 262144;

  // 1. ASCII-folded cross-chunk boundary + prefix/suffix/overlap hits
  {
    const buf = new Uint8Array(BUF_SIZE);
    buf.fill(0x78);  // 'x'
    const needle = new TextEncoder().encode('NeEdLe42');
    const planted = [0, 4093, CHUNK_BOUNDARY - 4, CHUNK_BOUNDARY + 16, BUF_SIZE - needle.length];
    for (const pos of planted) {
      for (let i = 0; i < needle.length; i += 1) {
        const ch = needle[i];
        buf[pos + i] = (pos % 2 === 0 && ch >= 65 && ch <= 90) ? ch + 32 : ch;
      }
    }
    const pat = new TextEncoder().encode('needle42');
    const jsOffsets = withEngineMode('js', () => collectAllMatches(buf, pat, null, true, 0));
    const wasmOffsets = withEngineMode('wasm', () => collectAllMatches(buf, pat, null, true, 0));
    assert.deepStrictEqual(wasmOffsets, jsOffsets);
    assert.deepStrictEqual(wasmOffsets, planted);
  }

  // 2. Masked hex pattern straddling 262,144B chunk boundary
  {
    const buf = new Uint8Array(BUF_SIZE);
    buf.fill(0x11);
    const pat = new Uint8Array([0xde, 0xa0, 0x00, 0xbe, 0x0f, 0xef]);
    const mask = new Uint8Array([0xff, 0xf0, 0x00, 0xff, 0x0f, 0xff]);
    const planted = [128, CHUNK_BOUNDARY - 3, CHUNK_BOUNDARY + 5, BUF_SIZE - pat.length];
    for (const pos of planted) {
      buf[pos + 0] = 0xde;
      buf[pos + 1] = 0xa7;  // matches 0xa0 & 0xf0
      buf[pos + 2] = 0x5c;  // wildcard 0x00
      buf[pos + 3] = 0xbe;
      buf[pos + 4] = 0x9f;  // matches 0x0f & 0x0f
      buf[pos + 5] = 0xef;
    }
    const jsOffsets = withEngineMode('js', () => collectAllMatches(buf, pat, mask, false, 0));
    const wasmOffsets = withEngineMode('wasm', () => collectAllMatches(buf, pat, mask, false, 0));
    assert.deepStrictEqual(wasmOffsets, jsOffsets);
    assert.deepStrictEqual(wasmOffsets, planted);
  }

  // 3. Overlapping matches and non-standard `from` values (negative / fractional)
  {
    const bytes = new TextEncoder().encode('aaaaaaa');
    const pat = new TextEncoder().encode('AAA');
    const jsOverlap = withEngineMode('js', () => collectAllMatches(bytes, pat, null, true, 0));
    const wasmOverlap = withEngineMode('wasm', () => collectAllMatches(bytes, pat, null, true, 0));
    assert.deepStrictEqual(wasmOverlap, [0, 1, 2, 3, 4]);
    assert.deepStrictEqual(wasmOverlap, jsOverlap);

    const matcher = compileBytePattern(pat, null, true);
    assert.equal(
      withEngineMode('wasm', () => matcher.find(bytes, -1)),
      withEngineMode('js', () => matcher.find(bytes, -1)),
    );
    assert.equal(
      withEngineMode('wasm', () => matcher.find(bytes, 1.5)),
      withEngineMode('js', () => matcher.find(bytes, 1.5)),
    );
  }
});

test('Wave 13 byte-search telemetry: WASM calls recorded in wasm & auto (>= 8 KiB) modes, 0 calls in HEX_ENGINE=js', () => {
  const bigBuf = new Uint8Array(8192);
  bigBuf.fill(0x20);
  const pat = new TextEncoder().encode('HEXWASM');
  bigBuf.set(pat, 7000);
  const matcher = compileBytePattern(pat, null, true);
  assert.ok(matcher);

  // 1. HEX_ENGINE=js must execute with 0 WASM calls
  resetAllTelemetry();
  const jsHit = withEngineMode('js', () => matcher.find(bigBuf, 0));
  assert.equal(jsHit, 7000);
  assert.equal(getWasmCallCount('byte_search'), 0, 'HEX_ENGINE=js must record 0 byte_search WASM calls');

  // 2. When wasmByteSearchFind is exported by hex-engine-bridge, verify WASM telemetry in wasm & auto modes
  if (typeof hexEngineBridge.wasmByteSearchFind === 'function') {
    resetAllTelemetry();
    const wasmHit = withEngineMode('wasm', () => matcher.find(bigBuf, 0));
    assert.equal(wasmHit, 7000);
    assert.ok(getWasmCallCount('byte_search') > 0, 'HEX_ENGINE=wasm must record byte_search WASM calls');

    resetAllTelemetry();
    const autoHit = withEngineMode('auto', () => matcher.find(bigBuf, 0));
    assert.equal(autoHit, 7000);
    assert.ok(getWasmCallCount('byte_search') > 0, 'HEX_ENGINE=auto (>= 8 KiB) must record byte_search WASM calls');
  }
});
