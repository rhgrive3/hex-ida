import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { scanStrings as residentScanStrings } from '../../../js/binary/strings.js';
import { boundedOffset, checkedChunkIndex, chunkLength, exactExternalInteger, regionSize, utf8Len, isExactFunctionSeed } from '../../../js/platform/worker-validation.js';

const workerPath = fileURLToPath(new URL('../../../js/platform/worker.js', import.meta.url));
const workerSource = fs.readFileSync(workerPath, 'utf8').replace(/^import .*;\n/gm, '');

function fixtureImage() {
  return {
    arch: 'x86_64', format: 'raw', fileSize: 0n, metadata: {},
    libraries: [], imports: [], symbols: [], functions: [],
    addressToOffset() { return null; },
  };
}

function createWorkerHarness(bytes) {
  const posts = [];
  const sourceBytes = Uint8Array.from(bytes);
  const self = { postMessage(message) { posts.push(message); } };
  class FakeCachedByteSource {
    constructor(base) {
      this.size = base.size;
      this.maxReadLength = base.maxReadLength;
      this.bytes = base.bytes;
    }
    async read(offset, length) { return this.readExactly(offset, length); }
    async readExactly(offset, length) {
      const start = Number(offset);
      return this.bytes.slice(start, start + length);
    }
    clear() {}
    memoryStats() { return { bytesCached: 0 }; }
  }
  const context = vm.createContext({
    self, TextDecoder, TextEncoder, AbortController, Uint8Array, BigUint64Array,
    BigInt, Promise, Map, Set, URL, setTimeout, clearTimeout, console,
    asByteSource(input) {
      return { size: input.size, maxReadLength: 8 * 1024 * 1024, bytes: input.bytes };
    },
    CachedByteSource: FakeCachedByteSource,
    detectBinary() { return { format: 'raw', fat: false }; },
    async openBinarySource() { return { ...fixtureImage(), fileSize: BigInt(sourceBytes.length) }; },
    async parseMachOSource() { return fixtureImage(); },
    describeBinaryImage() {
      return {
        platform: {}, slices: [], capability: null,
        raw: { id: 'raw', vmAddr: 0x1000n, fileOffset: 0n, size: BigInt(sourceBytes.length) },
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

  async function request(data) {
    self.onmessage({ data });
    for (let i = 0; i < 100; i++) {
      const reply = [...posts].reverse().find((message) =>
        (message.t === 'ok' || message.t === 'err') && message.id === data.id);
      if (reply) {
        if (reply.t === 'err') throw new Error(reply.error);
        return reply.result;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`request ${data.id} did not settle`);
  }

  return { request };
}

async function platformScan(text, min) {
  const bytes = new TextEncoder().encode(text);
  const worker = createWorkerHarness([...bytes, 0]);
  await worker.request({
    t: 'open', id: 1, epoch: 1,
    file: { name: 'issue-4956.bin', size: bytes.length + 1, bytes: Uint8Array.from([...bytes, 0]) },
  });
  return worker.request({ t: 'strings', id: 2, epoch: 1, regionId: 'raw', min, limit: 8 });
}

function residentScan(text, min) {
  const bytes = new TextEncoder().encode(text);
  return residentScanStrings({
    bytes: Uint8Array.from([...bytes, 0]), sections: [], segments: [],
    offsetToAddress(offset) { return 0x1000n + BigInt(offset); },
  }, { minLength: min, utf16: false });
}

for (const [label, text, min, expectedHit] of [
  ['ASCII at threshold', 'abcd', 4, true],
  ['ASCII below threshold', 'abc', 4, false],
  ['supplementary characters below code-point threshold', '😀😀', 4, false],
  ['supplementary characters at code-point threshold', '😀😀', 2, true],
  ['tab escape below code-point threshold', 'A\tB', 4, false],
  ['newline escape below code-point threshold', 'A\nB', 4, false],
]) {
  const platform = await platformScan(text, min);
  const resident = residentScan(text, min);
  assert.equal(platform.results.length > 0, expectedHit, `${label}: platform result`);
  assert.equal(resident.length > 0, expectedHit, `${label}: resident result`);
  if (text.includes('\t') || text.includes('\n')) assert.equal(platform.results.length, 0, `${label}: escaped text must not inflate minLength`);
}

const control = await platformScan('A\tB', 2);
assert.deepEqual(Array.from(control.results, (entry) => entry.text), ['A\\tB']);
const newline = await platformScan('A\nB', 2);
assert.deepEqual(Array.from(newline.results, (entry) => entry.text), ['A\\nB']);

console.log('issue #4956 platform string minLength code-point parity: PASS');
