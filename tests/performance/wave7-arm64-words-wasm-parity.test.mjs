import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import '../../js/words.js';
import {
  getWasmCallCount,
  resetAllTelemetry,
} from '../../js/core/hex-engine-bridge.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const goldenPath = path.join(root, 'fixtures', 'golden', 'arm64-decode-outputs.json');
const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));

const Words = globalThis.Words;

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

test('W7-arm64-words-wire: all 170 golden instructions match 100% between JS and WASM', async () => {
  assert.equal(golden.length, 170, 'expected 170 golden ARM64 decode entries');
  await Words.initWasmBridge();

  // 1. Collect JS-only baseline (HEX_ENGINE=js -> 0 WASM calls)
  const jsDecoded = withEngineMode('js', () => {
    resetAllTelemetry();
    const out = golden.map((entry) => {
      const w = entry.word >>> 0;
      const pc = BigInt('0x' + entry.addr);
      const kind = Words.classifyWord(w);
      const dec = Words.decodeWord(w, pc);
      assert.equal(kind, dec.kind, `JS classifyWord vs decodeWord mismatch at 0x${entry.addr}`);
      return dec;
    });
    assert.equal(
      getWasmCallCount('arm64_decode'),
      0,
      'HEX_ENGINE=js must perform 0 WASM arm64_decode calls',
    );
    return out;
  });

  // 2. Run WASM path (auto/wasm -> >= 1 WASM calls) and verify 100% parity
  withEngineMode('auto', () => {
    resetAllTelemetry();
    for (let i = 0; i < golden.length; i += 1) {
      const entry = golden[i];
      const w = entry.word >>> 0;
      const pc = BigInt('0x' + entry.addr);
      const wasmKind = Words.classifyWord(w);
      const wasmDec = Words.decodeWord(w, pc);
      const jsDec = jsDecoded[i];

      assert.equal(wasmKind, jsDec.kind, `entry #${i} classifyWord kind mismatch`);
      assert.deepEqual(
        wasmDec,
        jsDec,
        `entry #${i} (0x${w.toString(16)} @ 0x${entry.addr}) decodeWord JS vs WASM mismatch`,
      );

      // Verify against golden fixture fields as well
      assert.equal(wasmDec.kind, entry.kind, `entry #${i} golden kind mismatch`);
      assert.equal(wasmDec.kindName, entry.kindName, `entry #${i} golden kindName mismatch`);
      assert.equal(wasmDec.rd, entry.rd, `entry #${i} golden rd mismatch`);
      assert.equal(wasmDec.rn, entry.rn, `entry #${i} golden rn mismatch`);
      assert.equal(wasmDec.rm, entry.rm, `entry #${i} golden rm mismatch`);
      const gotTarget = wasmDec.target === null ? null : wasmDec.target.toString(16);
      assert.equal(gotTarget, entry.target, `entry #${i} golden target mismatch`);
      const gotPcRel = wasmDec.pcRel ? wasmDec.pcRel.value.toString(16) : null;
      assert.equal(gotPcRel, entry.pcRel, `entry #${i} golden pcRel mismatch`);
      const gotCmp = wasmDec.compareWith === null ? null : String(wasmDec.compareWith);
      assert.equal(gotCmp, entry.compareWith, `entry #${i} golden compareWith mismatch`);
    }

    assert.ok(
      getWasmCallCount('arm64_decode') >= golden.length,
      `expected >= ${golden.length} WASM arm64_decode calls, got ${getWasmCallCount('arm64_decode')}`,
    );
  });
});

test('W7-arm64-words-wire: decodeWordsBatch & classifyWordsBatch match JS 100% and honor HEX_ENGINE=js', async () => {
  await Words.initWasmBridge();
  const words = Uint32Array.from(golden, (entry) => entry.word >>> 0);
  const basePc = 0x100000440n;

  const jsBatch = withEngineMode('js', () => {
    resetAllTelemetry();
    const dec = Words.decodeWordsBatch(words, basePc);
    const kinds = Words.classifyWordsBatch(words);
    assert.equal(
      getWasmCallCount('arm64_decode'),
      0,
      'batch decode under HEX_ENGINE=js must perform 0 WASM calls',
    );
    return { dec, kinds };
  });

  withEngineMode('auto', () => {
    resetAllTelemetry();
    const wasmDec = Words.decodeWordsBatch(words, basePc);
    const wasmKinds = Words.classifyWordsBatch(words);

    assert.equal(wasmDec.length, words.length);
    assert.equal(wasmKinds.length, words.length);
    assert.deepEqual(wasmDec, jsBatch.dec, 'decodeWordsBatch JS vs WASM mismatch');
    assert.deepEqual(Array.from(wasmKinds), Array.from(jsBatch.kinds), 'classifyWordsBatch JS vs WASM mismatch');
    assert.ok(
      getWasmCallCount('arm64_decode') >= 2,
      `expected >= 2 WASM batch calls, got ${getWasmCallCount('arm64_decode')}`,
    );
  });
});

test('W7-arm64-words-wire: process.env.HEX_ENGINE=js disables WASM when globalThis.HEX_ENGINE is unset', async () => {
  await Words.initWasmBridge();
  const prevGlobal = globalThis.HEX_ENGINE;
  const prevInternal = globalThis.__HEX_ENGINE_MODE__;
  const prevEnv = process.env.HEX_ENGINE;
  try {
    delete globalThis.HEX_ENGINE;
    delete globalThis.__HEX_ENGINE_MODE__;
    process.env.HEX_ENGINE = 'js';
    resetAllTelemetry();
    const w = golden[0].word >>> 0;
    const pc = BigInt('0x' + golden[0].addr);
    const dec = Words.decodeWord(w, pc);
    assert.equal(dec.kind, golden[0].kind);
    assert.equal(getWasmCallCount('arm64_decode'), 0, 'process.env.HEX_ENGINE=js must perform 0 WASM calls');
  } finally {
    if (prevGlobal === undefined) delete globalThis.HEX_ENGINE;
    else globalThis.HEX_ENGINE = prevGlobal;
    if (prevInternal === undefined) delete globalThis.__HEX_ENGINE_MODE__;
    else globalThis.__HEX_ENGINE_MODE__ = prevInternal;
    if (prevEnv === undefined) delete process.env.HEX_ENGINE;
    else process.env.HEX_ENGINE = prevEnv;
  }
});
