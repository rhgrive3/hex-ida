import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSymmetricCodeFunctionSet } from '../js/diff/symmetric-function-set.js';
import { fingerprintFunction } from '../js/fingerprint/index.js';

const MIB = 1024 * 1024;
const workerPath = fileURLToPath(
  new URL('../js/platform/capstone-disasm-worker.js', import.meta.url),
);
const workerSource = fs.readFileSync(workerPath, 'utf8');

function deterministicBytes(start, length) {
  const out = new Uint8Array(length);
  const base = Number(start);
  for (let i = 0; i < length; i++) {
    out[i] = ((base + i) * 31 + 17) & 0xff;
  }
  return out;
}

function fakeCapstoneModule() {
  let nextPointer = 16;
  return {
    ARCH_ARM64: 1,
    MODE_ARM: 1,
    MODE_LITTLE_ENDIAN: 0,
    OPT_SKIPDATA: 0,
    OPT_ON: 1,
    _malloc(size) {
      const pointer = nextPointer;
      nextPointer += Math.max(4, Number(size) || 0);
      return pointer;
    },
    _free() {},
    getValue() { return 1; },
    writeArrayToMemory() {},
    UTF8ToString() { return 'nop'; },
    ccall(name) {
      if (name === 'cs_open' || name === 'cs_option') return 0;
      if (name === 'cs_disasm') return 0;
      return 0;
    },
  };
}

function createWorkerHarness(mCapstoneImpl) {
  const posts = [];
  const self = {
    location: { href: 'https://example.test/js/platform/capstone-disasm-worker.js' },
    postMessage(message) { posts.push(message); },
  };
  const context = vm.createContext({
    self,
    importScripts() {},
    MCapstone: mCapstoneImpl,
    URL,
    Uint8Array,
    BigInt,
    console,
  });
  vm.runInContext(workerSource, context, { filename: workerPath });
  return {
    posts,
    send(data) { self.onmessage({ data }); },
  };
}

async function waitFor(predicate, message) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

describe('Full Fix Track 7 — P1: symmetric-function-set short-read advancement under 1 MiB backend clamp', () => {
  test('reads all functions across > 1 MiB region without dropping suffix bytes when backend clamps readAt to 1 MiB', async () => {
    const regionStart = 0x10000n;
    const regionSize = BigInt(2 * MIB + 512 * 1024); // 2.5 MiB
    const regions = [{ id: 'text', exec: true, vmAddr: regionStart, size: regionSize }];

    const funcs = [
      regionStart,                                 // in first 1 MiB
      regionStart + BigInt(MIB - 64),              // straddles 1 MiB boundary
      regionStart + BigInt(MIB + 128),             // in second 1 MiB (previously dropped!)
      regionStart + BigInt(2 * MIB - 32),          // straddles 2 MiB boundary
      regionStart + BigInt(2 * MIB + 64),          // in final 0.5 MiB
    ];
    const funcEnds = [
      regionStart + 128n,
      regionStart + BigInt(MIB + 64),
      regionStart + BigInt(MIB + 384),
      regionStart + BigInt(2 * MIB + 32),
      regionStart + BigInt(2 * MIB + 256),
    ];

    const reads = [];
    const backend = {
      async readAt(address, length) {
        const addr = BigInt(address);
        reads.push({ address: addr, length });
        const regionEnd = regionStart + regionSize;
        const available = Number(regionEnd - addr);
        const clamped = Math.min(length, MIB, Math.max(0, available));
        return { found: true, bytes: deterministicBytes(addr, clamped) };
      },
    };

    const set = await createSymmetricCodeFunctionSet({
      backend,
      symbols: { funcs, funcEnds, functionStartsComplete: true, nameAt: () => null },
      regions,
      architecture: 'arm64',
    });

    assert.equal(set.length, funcs.length);
    assert.equal(set.complete, true);
    assert.equal(set.missingEvidence, 0);
    assert.equal(set.truncationReason, null);

    // Cursor must advance by observed 1 MiB increments instead of skipping to 2 MiB.
    assert.deepEqual(
      reads.map((r) => r.address),
      [regionStart, regionStart + BigInt(MIB), regionStart + BigInt(2 * MIB)],
    );

    for (let i = 0; i < funcs.length; i++) {
      const size = Number(funcEnds[i] - funcs[i]);
      const expected = fingerprintFunction({
        address: funcs[i],
        name: null,
        size,
        architecture: 'arm64',
        bytes: deterministicBytes(funcs[i], size),
      });
      assert.equal(set[i].evidenceCompleteness, 'complete', `function ${i} must be complete`);
      assert.deepEqual(set[i].missingComponents, []);
      assert.equal(set[i].exactBytesHash, expected.exactBytesHash, `function ${i} hash must match`);
    }
  });

  test('stops without infinite loop when backend returns zero observed bytes after a clamped read', async () => {
    const regionStart = 0n;
    const regionSize = BigInt(2 * MIB);
    const regions = [{ id: 'text', exec: true, vmAddr: regionStart, size: regionSize }];
    const funcs = [
      0n,
      BigInt(MIB - 16),
      BigInt(MIB + 64),
    ];
    const funcEnds = [
      64n,
      BigInt(MIB + 16),
      BigInt(MIB + 128),
    ];

    for (const zeroMode of ['empty-bytes', 'not-found']) {
      let calls = 0;
      const backend = {
        async readAt(address, length) {
          calls++;
          assert.ok(calls <= 4, `readAt must not enter a zero-progress infinite loop (${zeroMode})`);
          if (BigInt(address) < BigInt(MIB)) {
            const clamped = Math.min(length, MIB);
            return { found: true, bytes: deterministicBytes(address, clamped) };
          }
          if (zeroMode === 'empty-bytes') {
            return { found: true, bytes: new Uint8Array(0) };
          }
          return { found: false };
        },
      };

      const set = await createSymmetricCodeFunctionSet({
        backend,
        symbols: { funcs, funcEnds, functionStartsComplete: true, nameAt: () => null },
        regions,
        architecture: 'arm64',
      });

      assert.equal(calls, 2, `expected exactly 2 reads (${zeroMode})`);
      assert.equal(set[0].evidenceCompleteness, 'complete');
      assert.equal(set[1].evidenceCompleteness, 'partial');
      assert.equal(set[2].evidenceCompleteness, 'partial');
      assert.equal(set.complete, false);
      assert.equal(set.missingEvidence, 2);
    }
  });

  test('preserves partial semantics for genuine sub-chunk short reads', async () => {
    const set = await createSymmetricCodeFunctionSet({
      symbols: { funcs: [0n], functionStartsComplete: true, nameAt: () => null },
      regions: [{ id: 'text', vmAddr: 0n, size: 4n, exec: true }],
      architecture: 'arm64',
      backend: { async readAt() { return { found: true, bytes: Uint8Array.from([0xaa, 0xbb]) }; } },
    });
    assert.equal(set[0].evidenceCompleteness, 'partial');
    assert.equal(set[0].exactBytesHash, null);
    assert.equal(set.complete, false);
    assert.equal(set.missingEvidence, 1);
  });
});

describe('Full Fix Track 7 — P2: capstone-disasm-worker retries initialization after rejection', () => {
  test('resets modulePromise on MCapstone rejection and succeeds on subsequent request', async () => {
    let initAttempts = 0;
    const worker = createWorkerHarness(() => {
      initAttempts++;
      if (initAttempts === 1) {
        return Promise.reject(new Error('transient wasm load failure'));
      }
      return Promise.resolve(fakeCapstoneModule());
    });

    worker.send({ id: 1, architecture: 'arm64', address: 0, bytes: new Uint8Array(), priority: 'visible' });
    await waitFor(() => worker.posts.length === 1, 'first request must settle with initialization failure');
    assert.equal(worker.posts[0].id, 1);
    assert.equal(worker.posts[0].ok, false);
    assert.match(worker.posts[0].error || '', /Capstone disassembler initialization: transient wasm load failure/);
    assert.equal(initAttempts, 1);

    worker.send({ id: 2, architecture: 'arm64', address: 0, bytes: new Uint8Array(), priority: 'visible' });
    await waitFor(() => worker.posts.length === 2, 'second request must retry MCapstone and succeed');
    assert.equal(worker.posts[1].id, 2);
    assert.equal(worker.posts[1].ok, true);
    assert.equal(initAttempts, 2);

    // Subsequent call must reuse the resolved modulePromise without re-initializing.
    worker.send({ id: 3, architecture: 'arm64', address: 0, bytes: new Uint8Array(), priority: 'visible' });
    await waitFor(() => worker.posts.length === 3, 'third request must reuse cached module');
    assert.equal(worker.posts[2].id, 3);
    assert.equal(worker.posts[2].ok, true);
    assert.equal(initAttempts, 2);
  });

  test('does not poison modulePromise when MCapstone throws synchronously', async () => {
    let initAttempts = 0;
    const worker = createWorkerHarness(() => {
      initAttempts++;
      if (initAttempts === 1) {
        throw new Error('sync init failure');
      }
      return Promise.resolve(fakeCapstoneModule());
    });

    worker.send({ id: 10, architecture: 'arm64', address: 0, bytes: new Uint8Array(), priority: 'visible' });
    await waitFor(() => worker.posts.length === 1, 'first request must report sync throw');
    assert.equal(worker.posts[0].ok, false);
    assert.match(worker.posts[0].error || '', /Capstone disassembler initialization: sync init failure/);

    worker.send({ id: 11, architecture: 'arm64', address: 0, bytes: new Uint8Array(), priority: 'visible' });
    await waitFor(() => worker.posts.length === 2, 'second request must recover after sync throw');
    assert.equal(worker.posts[1].ok, true);
    assert.equal(initAttempts, 2);
  });
});
