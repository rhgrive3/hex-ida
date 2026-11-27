import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  shannonEntropy,
  scanHighEntropyWindows,
  scanCryptoConstants,
  analyzeCryptoInsnDensity,
} from '../js/analysis/crypto-entropy.js';
import { pinpointFunction } from '../js/pinpoint-legacy.js';
import { compileGoal } from '../js/goalc.js';

function makeHighEntropyBytes(len) {
  const out = new Uint8Array(len);
  let x = 0x12345678;
  for (let i = 0; i < len; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = (x >>> 24) & 0xff;
  }
  return out;
}

test('shannonEntropy matches between WASM and JS fallback across zero, uniform, and high-entropy buffers', () => {
  const zeros = new Uint8Array(4096);
  const uniform = new Uint8Array(4096);
  for (let i = 0; i < uniform.length; i++) uniform[i] = i & 0xff;
  const prng = makeHighEntropyBytes(4096);

  assert.equal(shannonEntropy(zeros), 0);
  assert.equal(shannonEntropy(zeros, { engine: 'js' }), 0);

  const uWasm = shannonEntropy(uniform);
  const uJs = shannonEntropy(uniform, { engine: 'js' });
  assert.ok(Math.abs(uWasm - 8.0) <= 0.002, `expected ~8.0, got ${uWasm}`);
  assert.ok(Math.abs(uWasm - uJs) <= 0.002, `WASM ${uWasm} vs JS ${uJs}`);

  const pWasm = shannonEntropy(prng);
  const pJs = shannonEntropy(prng, { engine: 'js' });
  assert.ok(pWasm > 7.8, `expected > 7.8, got ${pWasm}`);
  assert.ok(Math.abs(pWasm - pJs) <= 0.002, `WASM ${pWasm} vs JS ${pJs}`);
});

test('scanHighEntropyWindows locates embedded high-entropy region in both WASM and JS', () => {
  const buf = new Uint8Array(16384); // 4 windows of 4096
  buf.set(makeHighEntropyBytes(4096), 8192); // window #2 is high-entropy

  const wasmHits = scanHighEntropyWindows(buf, { baseAddress: 0x10000n, windowSize: 4096, step: 4096, threshold: 7.2 });
  const jsHits = scanHighEntropyWindows(buf, { baseAddress: 0x10000n, windowSize: 4096, step: 4096, threshold: 7.2, engine: 'js' });

  assert.equal(wasmHits.length, 1);
  assert.equal(wasmHits[0].offset, 8192);
  assert.equal(wasmHits[0].address, 0x12000n);
  assert.ok(wasmHits[0].entropy > 7.8);
  assert.equal(jsHits.length, 1);
  assert.equal(jsHits[0].offset, 8192);
});

test('scanCryptoConstants detects AES S-Box, SHA-256 K/H0, MD5, ChaCha20, and CRC32 in WASM and JS', () => {
  const buf = new Uint8Array(4096);
  // AES S-Box at 0x40
  buf.set([0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76], 0x40);
  // SHA-256 K[0..3] LE at 0x200
  buf.set([0x98, 0x2f, 0x8a, 0x42, 0x91, 0x44, 0x37, 0x71, 0xcf, 0xfb, 0xc0, 0xb5, 0xa5, 0xdb, 0xb5, 0xe9], 0x200);
  // ChaCha20 "expand 32-byte k" at 0x400
  buf.set(new TextEncoder().encode('expand 32-byte k'), 0x400);
  // CRC32 IEEE LE at 0x600
  buf.set([0x00, 0x00, 0x00, 0x00, 0x96, 0x30, 0x07, 0x77, 0x2c, 0x61, 0x0e, 0xee, 0xba, 0x51, 0x09, 0x99], 0x600);

  const wasmHits = scanCryptoConstants(buf, { baseAddress: 0x100000n });
  const jsHits = scanCryptoConstants(buf, { baseAddress: 0x100000n, engine: 'js' });

  const ids = (arr) => arr.map((h) => `${h.id}@0x${h.offset.toString(16)}`);
  assert.deepEqual(ids(wasmHits), ['aes-sbox@0x40', 'sha256-k@0x200', 'chacha20@0x400', 'crc32-ieee@0x600']);
  assert.deepEqual(ids(jsHits), ids(wasmHits));
  assert.equal(wasmHits[0].address, 0x100040n);
});

test('analyzeCryptoInsnDensity detects hardware crypto & bitwise loops while ignoring zeroing idioms', () => {
  const hw = analyzeCryptoInsnDensity([
    { mnemonic: 'aese', operands: 'v0.16b, v1.16b' },
    { mnemonic: 'aesmc', operands: 'v0.16b, v0.16b' },
    { mnemonic: 'ret', operands: '' },
  ]);
  assert.equal(hw.hwCryptoCount, 2);

  const bitwiseLoop = analyzeCryptoInsnDensity([
    { mnemonic: 'ldr', operands: 'w8, [x0]' },
    { mnemonic: 'eor', operands: 'w8, w8, w1' },
    { mnemonic: 'ror', operands: 'w8, w8, #7' },
    { mnemonic: 'eor', operands: 'w8, w8, w2' },
    { mnemonic: 'lsl', operands: 'w9, w8, #3' },
    { mnemonic: 'eor', operands: 'w8, w8, w9' },
    { mnemonic: 'lsr', operands: 'w10, w8, #5' },
    { mnemonic: 'eor', operands: 'w8, w8, w10' },
    { mnemonic: 'str', operands: 'w8, [x0]' },
    { mnemonic: 'ret', operands: '' },
  ]);
  assert.equal(bitwiseLoop.highBitwiseDensity, true);
  assert.ok(bitwiseLoop.xorCount >= 4 && bitwiseLoop.rotateCount === 1);

  const plainZeroing = analyzeCryptoInsnDensity([
    { mnemonic: 'xor', operands: 'eax, eax' },
    { mnemonic: 'xor', operands: 'edx, edx' },
    { mnemonic: 'xor', operands: 'ecx, ecx' },
    { mnemonic: 'eor', operands: 'w0, w0, w0' },
    { mnemonic: 'mov', operands: 'rbx, rdi' },
    { mnemonic: 'ret', operands: '' },
  ]);
  assert.equal(plainZeroing.xorCount, 0);
  assert.equal(plainZeroing.highBitwiseDensity, false);
});

test('pinpointFunction with crypto goal awards fn-crypto-hw-insn and outranks non-crypto peer', async () => {
  const goal = compileGoal('暗号化').goal;
  const symbols = { symbolCount: 0, functionCount: 2, addrs: [], names: [], renames: new Map(), nameAt: () => '' };
  const ranked = [
    { addr: 0x1000n, score: 20, reasons: [{ code: 'string-ref', points: 20, detail: { text: 'cipher' } }], strings: [{ text: 'cipher', users: 1 }] },
    { addr: 0x2000n, score: 20, reasons: [{ code: 'string-ref', points: 20, detail: { text: 'cipher' } }], strings: [{ text: 'cipher', users: 1 }] },
  ];
  const disasmByAddr = new Map([
    [0x1000n, [
      { address: 0x1000n, mnemonic: 'mov', operands: 'w0, #1' },
      { address: 0x1004n, mnemonic: 'ret', operands: '' },
    ]],
    [0x2000n, [
      { address: 0x2000n, mnemonic: 'aese', operands: 'v0.16b, v1.16b' },
      { address: 0x2004n, mnemonic: 'aesmc', operands: 'v0.16b, v0.16b' },
      { address: 0x2008n, mnemonic: 'ret', operands: '' },
    ]],
  ]);
  const pin = await pinpointFunction({
    goal,
    ranked,
    symbols,
    deep: true,
    analyze: async (a) => ({ instructions: disasmByAddr.get(BigInt(a)) || [] }),
  });
  const c2000 = pin.candidates.find((c) => c.addr === 0x2000n);
  const c1000 = pin.candidates.find((c) => c.addr === 0x1000n);
  assert.ok(c2000.evidence.some((e) => e.code === 'fn-crypto-hw-insn'), '0x2000 has fn-crypto-hw-insn');
  assert.ok((c2000.fusion?.rawLogOdds ?? 0) > (c1000.fusion?.rawLogOdds ?? -999), 'hw-crypto function outranks plain peer');
});
