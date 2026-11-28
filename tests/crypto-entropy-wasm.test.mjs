import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  shannonEntropy,
  scanHighEntropyWindows,
  classifyHighEntropyKind,
  scanCryptoConstants,
  analyzeCryptoInsnDensity,
  scanBinaryRegionsCrypto,
} from '../js/analysis/crypto-entropy.js';
import { autoAnalyze } from '../js/auto.js';
import { rankCandidates } from '../js/rank.js';
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

test('scanHighEntropyWindows locates embedded high-entropy region & distinguishes compressed headers', () => {
  const buf = new Uint8Array(16384);
  const high = makeHighEntropyBytes(4096);
  buf.set(high, 4096);
  // Stamp gzip header at window #1 (offset 4096)
  buf[4096] = 0x1f; buf[4097] = 0x8b; buf[4098] = 0x08;
  // Raw high-entropy encrypted/packed window at window #2 (offset 8192)
  buf.set(high, 8192);

  const wasmHits = scanHighEntropyWindows(buf, { baseAddress: 0x10000n, windowSize: 4096, step: 4096, threshold: 7.2 });
  const jsHits = scanHighEntropyWindows(buf, { baseAddress: 0x10000n, windowSize: 4096, step: 4096, threshold: 7.2, engine: 'js' });

  assert.equal(wasmHits.length, 2);
  assert.equal(wasmHits[0].kind, 'compressed:gzip');
  assert.equal(wasmHits[1].kind, 'encrypted-or-packed');
  assert.equal(wasmHits[1].address, 0x12000n);
  assert.deepEqual(jsHits.map((h) => [h.offset, h.kind]), wasmHits.map((h) => [h.offset, h.kind]));

  assert.equal(classifyHighEntropyKind(Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd])), 'compressed:zstd');
  assert.equal(classifyHighEntropyKind(Uint8Array.from([0x78, 0x9c, 0x01, 0x02])), 'compressed:zlib');
  assert.equal(classifyHighEntropyKind(Uint8Array.from([0x04, 0x22, 0x4d, 0x18])), 'compressed:lz4');
  assert.equal(classifyHighEntropyKind(Uint8Array.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])), 'compressed:xz');
});

test('scanCryptoConstants detects all standard crypto/hash tables including AES T-Table, SHA-512, BLAKE2b, Blowfish, Keccak in WASM & JS', () => {
  const buf = new Uint8Array(4096);
  buf.set([0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76], 0x40);
  buf.set([0xa5, 0x63, 0x63, 0xc6, 0x84, 0x7c, 0x7c, 0xf8, 0x99, 0x77, 0x77, 0xee, 0x8d, 0x7b, 0x7b, 0xf6], 0x100);
  buf.set([0x98, 0x2f, 0x8a, 0x42, 0x91, 0x44, 0x37, 0x71, 0xcf, 0xfb, 0xc0, 0xb5, 0xa5, 0xdb, 0xb5, 0xe9], 0x200);
  buf.set([0x22, 0xae, 0x28, 0xd7, 0x98, 0x2f, 0x8a, 0x42, 0xcd, 0x65, 0xef, 0x23, 0x91, 0x44, 0x37, 0x71], 0x300);
  buf.set(new TextEncoder().encode('expand 32-byte k'), 0x400);
  buf.set([0x08, 0xc9, 0xbc, 0xf3, 0x67, 0xe6, 0x09, 0x6a, 0x3b, 0xa7, 0xca, 0x84, 0x85, 0xae, 0x67, 0xbb], 0x500);
  buf.set([0x00, 0x00, 0x00, 0x00, 0x96, 0x30, 0x07, 0x77, 0x2c, 0x61, 0x0e, 0xee, 0xba, 0x51, 0x09, 0x99], 0x600);
  buf.set([0x88, 0x6a, 0x3f, 0x24, 0xd3, 0x08, 0xa3, 0x85, 0x2e, 0x8a, 0x19, 0x13, 0x44, 0x73, 0x70, 0x03], 0x700);
  buf.set([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x82, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 0x800);

  const wasmHits = scanCryptoConstants(buf, { baseAddress: 0x100000n });
  const jsHits = scanCryptoConstants(buf, { baseAddress: 0x100000n, engine: 'js' });

  const ids = (arr) => arr.map((h) => `${h.id}@0x${h.offset.toString(16)}`);
  assert.deepEqual(ids(wasmHits), [
    'aes-sbox@0x40',
    'aes-ttable@0x100',
    'sha256-k@0x200',
    'sha512-k@0x300',
    'chacha20@0x400',
    'blake2b-iv@0x500',
    'crc32-ieee@0x600',
    'blowfish-p@0x700',
    'keccak-rc@0x800',
  ]);
  assert.deepEqual(ids(jsHits), ids(wasmHits));
});

test('analyzeCryptoInsnDensity detects HW crypto, bitwise loops, and simple 1-XOR loops while ignoring zeroing idioms', () => {
  const hw = analyzeCryptoInsnDensity([
    { mnemonic: 'aese', operands: 'v0.16b, v1.16b' },
    { mnemonic: 'aesmc', operands: 'v0.16b, v0.16b' },
    { mnemonic: 'ret', operands: '' },
  ]);
  assert.equal(hw.hwCryptoCount, 2);

  // ARM64 simple 1-XOR loop
  const armXorLoop = analyzeCryptoInsnDensity([
    { address: 0x1000n, mnemonic: 'ldrb', operands: 'w8, [x0, x2]' },
    { address: 0x1004n, mnemonic: 'eor', operands: 'w8, w8, w3' },
    { address: 0x1008n, mnemonic: 'strb', operands: 'w8, [x0, x2]' },
    { address: 0x100cn, mnemonic: 'add', operands: 'x2, x2, #1' },
    { address: 0x1010n, mnemonic: 'cmp', operands: 'x2, x1' },
    { address: 0x1014n, mnemonic: 'b.lt', operands: '0x1000' },
    { address: 0x1018n, mnemonic: 'ret', operands: '' },
  ]);
  assert.equal(armXorLoop.hasXorLoop, true);

  // x86-64 simple 1-XOR loop (direct memory xor)
  const x86XorLoop = analyzeCryptoInsnDensity([
    { address: 0x2000n, mnemonic: 'xor', operands: 'byte ptr [rdi+rax], dl' },
    { address: 0x2003n, mnemonic: 'inc', operands: 'rax' },
    { address: 0x2006n, mnemonic: 'cmp', operands: 'rax, rsi' },
    { address: 0x2009n, mnemonic: 'jne', operands: '0x2000' },
    { address: 0x200bn, mnemonic: 'ret', operands: '' },
  ]);
  assert.equal(x86XorLoop.hasXorLoop, true);

  // Plain zeroing idioms must not trigger
  const plainZeroing = analyzeCryptoInsnDensity([
    { address: 0x3000n, mnemonic: 'xor', operands: 'eax, eax' },
    { address: 0x3002n, mnemonic: 'xor', operands: 'edx, edx' },
    { address: 0x3004n, mnemonic: 'eor', operands: 'w0, w0, w0' },
    { address: 0x3008n, mnemonic: 'ret', operands: '' },
  ]);
  assert.equal(plainZeroing.xorCount, 0);
  assert.equal(plainZeroing.hasXorLoop, false);
  assert.equal(plainZeroing.highBitwiseDensity, false);
});

test('rankCandidates + pinpointFunction surface stripped crypto routines via cryptoConstants Xref + 1-XOR loop', async () => {
  const goal = compileGoal('暗号化').goal;
  const symbols = { symbolCount: 0, functionCount: 2, addrs: [], names: [], renames: new Map(), nameAt: () => '' };
  const cryptoConstants = [{ id: 'aes-sbox', name: 'AES S-Box', offset: 0x40, address: 0x90040n, length: 256 }];
  const program = {
    functionsReferencing: (addr, span) => {
      if (typeof span !== 'bigint') throw new TypeError(`functionsReferencing span must be bigint, got ${typeof span}`);
      return BigInt(addr) === 0x90040n ? [{ addr: 0x2000n, site: 0x2004n }] : [];
    },
    calleesOf: () => [],
    callersOf: () => [],
    callCountOf: () => 2,
    functionRange: (a) => ({ start: BigInt(a), end: BigInt(a) + 0x40n }),
    statsOf: () => ({ total: 10, numeric: 2, store: 1, cmp: 1, covered: true }),
  };

  // ZERO strings, ZERO symbols — discovered purely from AES S-Box Xref
  const ranked = rankCandidates({ goal, strings: [], program, symbols, cryptoConstants, limit: 5 });
  assert.equal(ranked.candidates.length, 1);
  assert.equal(ranked.candidates[0].addr, 0x2000n);
  assert.ok(ranked.candidates[0].reasons.some((r) => r.code === 'crypto-const'));

  // Pinpoint verifies 1-XOR loop and awards fn-crypto-bitwise
  const pin = await pinpointFunction({
    goal,
    ranked: ranked.candidates,
    symbols,
    program,
    deep: true,
    analyze: async () => ({
      instructions: [
        { address: 0x2000n, mnemonic: 'ldrb', operands: 'w8, [x0, x2]' },
        { address: 0x2004n, mnemonic: 'eor', operands: 'w8, w8, w3' },
        { address: 0x2008n, mnemonic: 'strb', operands: 'w8, [x0, x2]' },
        { address: 0x200cn, mnemonic: 'add', operands: 'x2, x2, #1' },
        { address: 0x2010n, mnemonic: 'cmp', operands: 'x2, x1' },
        { address: 0x2014n, mnemonic: 'b.lt', operands: '0x2000' },
        { address: 0x2018n, mnemonic: 'ret', operands: '' },
      ],
    }),
  });
  const c2000 = pin.candidates.find((c) => c.addr === 0x2000n);
  assert.ok(c2000.evidence.some((e) => e.code === 'fn-crypto-bitwise'), '1-XOR loop awarded fn-crypto-bitwise');
});

test('analyzeCryptoInsnDensity detects clang -O2/-O3 SIMD vectorized & AVX memory-source XOR loops', () => {
  const simdXorLoop = analyzeCryptoInsnDensity([
    { address: 0x70n, mnemonic: 'movdqu', operands: 'xmm1, xmmword ptr [rdi + rcx]' },
    { address: 0x75n, mnemonic: 'movdqu', operands: 'xmm2, xmmword ptr [rdi + rcx + 0x10]' },
    { address: 0x87n, mnemonic: 'pxor', operands: 'xmm1, xmm0' },
    { address: 0x8bn, mnemonic: 'pxor', operands: 'xmm2, xmm0' },
    { address: 0x8fn, mnemonic: 'movdqu', operands: 'xmmword ptr [rdi + rcx], xmm1' },
    { address: 0x94n, mnemonic: 'movdqu', operands: 'xmmword ptr [rdi + rcx + 0x10], xmm2' },
    { address: 0xaen, mnemonic: 'add', operands: 'rcx, 0x40' },
    { address: 0xb6n, mnemonic: 'jne', operands: '0x70' },
  ]);
  assert.equal(simdXorLoop.hasXorLoop, true);
  assert.equal(simdXorLoop.xorCount, 2);

  const avxMemSrcLoop = analyzeCryptoInsnDensity([
    { address: 0x200n, mnemonic: 'vpxor', operands: 'ymm1, ymm0, ymmword ptr [rdi + rcx]' },
    { address: 0x205n, mnemonic: 'vmovdqu', operands: 'ymmword ptr [rdi + rcx], ymm1' },
    { address: 0x20an, mnemonic: 'add', operands: 'rcx, 0x20' },
    { address: 0x20en, mnemonic: 'jne', operands: '0x200' },
  ]);
  assert.equal(avxMemSrcLoop.hasXorLoop, true);
  assert.equal(avxMemSrcLoop.xorCount, 1);

  const avxZeroOnly = analyzeCryptoInsnDensity([
    { address: 0x300n, mnemonic: 'vpxor', operands: 'ymm0, ymm0, ymm0' },
    { address: 0x304n, mnemonic: 'vmovdqu', operands: 'ymmword ptr [rdi + rcx], ymm0' },
    { address: 0x308n, mnemonic: 'add', operands: 'rcx, 0x20' },
    { address: 0x30cn, mnemonic: 'jne', operands: '0x300' },
  ]);
  assert.equal(avxZeroOnly.hasXorLoop, false);
  assert.equal(avxZeroOnly.xorCount, 0);
});

test('scanBinaryRegionsCrypto + autoAnalyze wire crypto constants & high-entropy regions end-to-end', async () => {
  const raw = new Uint8Array(12288);
  // .rodata at fileOffset=0, vmAddr=0x20000n, size=4096: embed AES S-Box at +0x80
  raw.set([0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76], 0x80);
  // .data at fileOffset=4096, vmAddr=0x30000n, size=4096: high-entropy encrypted payload
  let seed = 0x13579bdf;
  for (let i = 0; i < 4096; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    raw[4096 + i] = (seed >>> 24) & 0xff;
  }
  const fakeFile = {
    slice(s, e) {
      const sub = raw.slice(s, e);
      return { arrayBuffer: async () => sub.buffer };
    },
  };
  const regions = [
    { section: '.rodata', fileOffset: 0n, vmAddr: 0x20000n, size: 4096n, exec: false, zerofill: false },
    { section: '.data', fileOffset: 4096n, vmAddr: 0x30000n, size: 4096n, exec: false, zerofill: false },
  ];
  const cryptoScan = await scanBinaryRegionsCrypto(fakeFile, regions);
  assert.equal(cryptoScan.constants.length, 1);
  assert.equal(cryptoScan.constants[0].id, 'aes-sbox');
  assert.equal(cryptoScan.constants[0].address, 0x20080n);
  assert.equal(cryptoScan.constants[0].section, '.rodata');
  assert.ok(cryptoScan.highEntropy.some((w) => w.kind === 'encrypted-or-packed' && w.address === 0x30000n));

  const fnAddr = 0x10000n;
  const program = {
    callCount: 0,
    refCount: 1,
    statsComplete: true,
    functionsReferencing(addr, span) {
      if (typeof span !== 'bigint') throw new TypeError(`functionsReferencing span must be bigint, got ${typeof span}`);
      if (addr === 0x20080n) return [{ addr: fnAddr, site: fnAddr + 4n }];
      return [];
    },
    callersOf() { return []; },
    calleesOf() { return []; },
    statsOf() { return { inDegree: 1, outDegree: 0 }; },
    functionRange(a) { return a === fnAddr ? { start: fnAddr, end: fnAddr + 64n } : null; },
    callCountOf() { return 0; },
  };
  const symbols = {
    functionCount: 1,
    nameAt(a) { return a === fnAddr ? 'sub_10000' : null; },
    at() { return { addr: fnAddr, size: 64n, name: 'sub_10000' }; },
  };
  const report = await autoAnalyze({ strings: [], program, symbols, cryptoScan, pinpointBudget: 0, deepLimit: 0 });
  assert.equal(report.crypto.constants.length, 1);
  assert.ok(report.findings.some((f) => f.id === 'crypto' && f.actionable && f.text.includes('AES S-Box')));
  assert.ok(report.findings.some((f) => f.id === 'crypto' && f.text.includes('High-entropy region')));
  const cryptoGoal = report.goals.find((g) => g.goal.id === 'crypto');
  assert.ok(cryptoGoal, 'autoAnalyze must surface crypto goal from cryptoScan even with 0 strings');
  assert.equal(cryptoGoal.best.addr, fnAddr);
});

test('scanHighEntropyWindows >1.5MB chunked WASM matches JS fallback exactly across chunk boundaries', () => {
  const buf = new Uint8Array(2 * 1024 * 1024); // 2MB > 1.5MB SCRATCH_CHUNK_MAX
  let seed = 0x55aa1234;
  // Embed high-entropy regions straddling the 1.5MB chunk boundary (1536KB = 0x180000)
  for (const start of [0x10000, 0x17f000, 0x180000, 0x1e0000]) {
    for (let i = 0; i < 4096; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      buf[start + i] = (seed >>> 24) & 0xff;
    }
  }
  const wasmAligned = scanHighEntropyWindows(buf, { baseAddress: 0x400000n, windowSize: 4096, step: 4096, threshold: 7.2 });
  const jsAligned = scanHighEntropyWindows(buf, { baseAddress: 0x400000n, windowSize: 4096, step: 4096, threshold: 7.2, engine: 'js' });
  assert.deepEqual(wasmAligned, jsAligned);
  assert.equal(wasmAligned.length, 4);

  // Overlapping step (step=2048 < windowSize=4096) across chunk boundary
  const wasmOverlap = scanHighEntropyWindows(buf, { baseAddress: 0x400000n, windowSize: 4096, step: 2048, threshold: 7.2 });
  const jsOverlap = scanHighEntropyWindows(buf, { baseAddress: 0x400000n, windowSize: 4096, step: 2048, threshold: 7.2, engine: 'js' });
  assert.deepEqual(wasmOverlap, jsOverlap);
  assert.ok(wasmOverlap.length >= 4);
});
