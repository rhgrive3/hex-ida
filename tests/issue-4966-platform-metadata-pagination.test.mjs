import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  boundedOffset,
  checkedChunkIndex,
  chunkLength,
  exactExternalInteger,
  regionSize,
  utf8Len,
  isExactFunctionSeed,
} from '../js/platform/worker-validation.js';

const workerPath = fileURLToPath(new URL('../js/platform/worker.js', import.meta.url));
const workerSource = fs.readFileSync(workerPath, 'utf8').replace(/^import .*;\n/gm, '');

const SYMBOL_COUNT = 5001;

function fixtureImage() {
  const item = (_unused, index) => ({ name: `S${index}`, address: BigInt(0x1000 + index), size: 1n, fileOffset: BigInt(index), fileSize: 1n });
  return {
    arch: 'arm64', format: 'raw', fileSize: BigInt(SYMBOL_COUNT), metadata: {}, warnings: [],
    segments: [], sections: [], imports: [], exports: [], relocations: [], functions: [], libraries: [],
    symbols: Array.from({ length: SYMBOL_COUNT }, item),
    summary() { return { format: 'raw', arch: 'arm64' }; },
    addressToOffset() { return null; },
  };
}

function createWorkerHarness({ openImage = fixtureImage(), sliceImage = openImage } = {}) {
  const posts = [];
  let sliceParses = 0;
  const self = { postMessage(message) { posts.push(message); } };
  class FakeCachedByteSource {
    constructor(base) { this.size = base.size; this.maxReadLength = base.maxReadLength; }
    async read() { return new Uint8Array(0); }
    async readExactly() { return new Uint8Array(0); }
    clear() {}
    memoryStats() { return { bytesCached: 0 }; }
  }
  const context = vm.createContext({
    self, TextDecoder, TextEncoder, AbortController, Uint8Array, BigUint64Array,
    BigInt, Promise, Map, Set, URL, setTimeout, clearTimeout, console,
    asByteSource(input) { return { size: input.size, maxReadLength: 1024 }; },
    CachedByteSource: FakeCachedByteSource,
    detectBinary() { return { format: openImage.format, fat: !!openImage.metadata?.fat }; },
    async openBinarySource() { return openImage; },
    async parseMachOSource() { sliceParses += 1; return sliceImage; },
    describeBinaryImage(binaryImage) {
      return {
        platform: {}, slices: [], capability: { arch: binaryImage.arch },
        raw: { id: 'raw', vmAddr: 0n, fileOffset: 0n, size: BigInt(SYMBOL_COUNT) },
      };
    },
    fingerprintVendors() { return []; },
    async hashByteSource() { return 'hash'; },
    boundedOffset, checkedChunkIndex, chunkLength, exactExternalInteger, regionSize, utf8Len, isExactFunctionSeed,
    analysisFromBinaryImage() { return {}; },
    emptyAnalysis() { return {}; },
    async analyzeDecodedSemanticFunction() { return {}; },
    resolveMachOPointer() { return null; },
  });
  vm.runInContext(workerSource, context, { filename: workerPath });

  let id = 1;
  async function request(t, payload = {}) {
    const requestId = id++;
    await self.onmessage({ data: { t, id: requestId, epoch: 1, ...payload } });
    const reply = [...posts].reverse().find((message) =>
      (message.t === 'ok' || message.t === 'err') && message.id === requestId);
    assert.ok(reply, `request ${t} did not settle`);
    if (reply.t === 'err') throw new Error(reply.error);
    return reply.result;
  }
  return { request, sliceParseCount: () => sliceParses };
}

const worker = createWorkerHarness();
await worker.request('open', { file: { name: 'metadata.bin', size: SYMBOL_COUNT } });

const first = await worker.request('metadata', { kind: 'symbols', start: 0, limit: 1 });
assert.equal(first.start, 0);
assert.deepEqual(Array.from(first.items, (entry) => entry.name), ['S0']);
assert.equal(first.next, 1);

const second = await worker.request('metadata', { kind: 'symbols', start: 1, limit: 2 });
assert.deepEqual(Array.from(second.items, (entry) => entry.name), ['S1', 'S2']);
assert.equal(second.next, 3);

for (const payload of [
  { start: 1.5, limit: 1 },
  { start: Infinity, limit: 1 },
  { start: Number.MAX_SAFE_INTEGER + 1, limit: 1 },
  { start: -1, limit: 1 },
  { start: '1', limit: 1 },
  { start: true, limit: 1 },
  { start: 0, limit: 1.5 },
  { start: 0, limit: Infinity },
  { start: 0, limit: Number.MAX_SAFE_INTEGER + 1 },
  { start: 0, limit: 0 },
  { start: 0, limit: -1 },
  { start: 0, limit: '2' },
  { start: 0, limit: [2] },
]) {
  await assert.rejects(
    worker.request('metadata', { kind: 'symbols', ...payload }),
    /metadata (start|limit) must be a (non-negative|positive) safe integer/,
    `malformed pagination must reject: ${JSON.stringify(payload)}`,
  );
}

let coercionCalls = 0;
const hostile = new Proxy({
  valueOf() { coercionCalls += 1; throw new Error('coercion-called'); },
  [Symbol.toPrimitive]() { coercionCalls += 1; throw new Error('coercion-called'); },
}, {
  get(target, key, receiver) {
    coercionCalls += 1;
    return Reflect.get(target, key, receiver);
  },
});
await assert.rejects(
  worker.request('metadata', { kind: 'symbols', start: hostile, limit: 1 }),
  /metadata start must be a non-negative safe integer/,
);
assert.equal(coercionCalls, 0, 'validation must not inspect/coerce structured pagination values');

const negativeZero = await worker.request('metadata', { kind: 'symbols', start: -0, limit: 1 });
assert.equal(Object.is(negativeZero.start, -0), false, 'published cursor start must canonicalize -0 to +0');
assert.equal(negativeZero.next, 1);

const capped = await worker.request('metadata', { kind: 'symbols', start: 0, limit: 6000 });
assert.equal(capped.start, 0);
assert.equal(capped.items.length, 5000);
assert.equal(capped.next, 5000);

const finalPage = await worker.request('metadata', { kind: 'symbols', start: 5000, limit: 1 });
assert.deepEqual(Array.from(finalPage.items, (entry) => entry.name), ['S5000']);
assert.equal(finalPage.next, null, 'next:null is reserved for actual end-of-list exhaustion');

const defaults = await worker.request('metadata', { kind: 'symbols' });
assert.equal(defaults.start, 0);
assert.equal(defaults.items.length, 500);
assert.equal(defaults.next, 500);

const fatPrimary = {
  ...fixtureImage(),
  format: 'macho',
  metadata: { fat: { slices: [{}, {}] } },
  symbols: [{ name: 'PRIMARY' }],
};
const fatSlice = fixtureImage();
const fatWorker = createWorkerHarness({ openImage: fatPrimary, sliceImage: fatSlice });
await fatWorker.request('open', { file: { name: 'fat-metadata.bin', size: SYMBOL_COUNT } });
const slicePage = await fatWorker.request('metadata', { kind: 'symbols', sliceIndex: 1, start: 1, limit: 2 });
assert.deepEqual(Array.from(slicePage.items, (entry) => entry.name), ['S1', 'S2'], 'pagination must use the selected Mach-O slice');
assert.equal(slicePage.start, 1);
assert.equal(slicePage.next, 3);
assert.equal(fatWorker.sliceParseCount(), 1, 'non-default slice must be resolved through the slice-aware production path');
await assert.rejects(
  fatWorker.request('metadata', { kind: 'symbols', sliceIndex: 1, start: '1', limit: 1 }),
  /metadata start must be a non-negative safe integer/,
  'pagination validation must remain active after selected-slice authority is established',
);

console.log('platform metadata pagination #4966: PASS');
