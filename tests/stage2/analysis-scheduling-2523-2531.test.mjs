import assert from 'node:assert/strict';
import {
  analyzeFunctionCached,
  clearAnalysisCache,
  resolveModelTexts,
} from '../../js/analyze.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeSymbols(gen = 1) {
  return {
    gen,
    nameAt() { return null; },
    label() { return null; },
  };
}

function makeChunk() {
  return {
    mn: ['ret'],
    ops: [''],
    bytes: new Uint8Array(4),
  };
}

// #2523: compatible concurrent consumers must share one function-analysis producer.
{
  clearAnalysisCache();
  const gate = deferred();
  let fetches = 0;
  const backend = {
    fetchChunk() {
      fetches++;
      return gate.promise;
    },
  };
  const region = { id: 7, vmAddr: 0x1000n, size: 4n, revision: 1 };
  const symbols = makeSymbols();

  const a = analyzeFunctionCached(backend, region, 0, 0, symbols, null, { texts: false });
  const b = analyzeFunctionCached(backend, region, 0, 0, symbols, null, { texts: false });
  await Promise.resolve();
  assert.equal(fetches, 1, 'same-key concurrent consumers must start one producer');

  gate.resolve(makeChunk());
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra, rb, 'same-key consumers should receive the shared result object');
  assert.equal(fetches, 1);
}

// #2523: aborting one waiter must not cancel shared work still needed by another waiter.
{
  clearAnalysisCache();
  const gate = deferred();
  let fetches = 0;
  const backend = {
    fetchChunk() {
      fetches++;
      return gate.promise;
    },
  };
  const region = { id: 8, vmAddr: 0x2000n, size: 4n, revision: 1 };
  const symbols = makeSymbols(2);
  const controller = new AbortController();

  const cancelled = analyzeFunctionCached(
    backend, region, 0, 0, symbols, null,
    { texts: false, signal: controller.signal },
  );
  const survivor = analyzeFunctionCached(backend, region, 0, 0, symbols, null, { texts: false });
  await Promise.resolve();
  assert.equal(fetches, 1);

  controller.abort('route-disposed');
  gate.resolve(makeChunk());
  await assert.rejects(cancelled, (error) => error?.name === 'AbortError');
  const result = await survivor;
  assert.equal(result.instructions, 1);
  assert.equal(fetches, 1, 'surviving waiter must reuse the original producer');
}

function pointerBytes(value) {
  let v = BigInt(value);
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

// #2531: both direct and indirect text-resolution stages are bounded instead of
// dispatching 96 readAt requests at once. Coverage stays at 96 references.
{
  const refs = Array.from({ length: 96 }, (_, i) => ({ addr: BigInt(i + 1) }));
  const model = { addressRefs: refs, semantic: [], facts: { stringRefs: [], strings: [] }, calls: [] };
  let active = 0;
  let peak = 0;
  let reads = 0;
  const backend = {
    async readAt(addr) {
      active++;
      peak = Math.max(peak, active);
      reads++;
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      if (addr >= 1n && addr <= 96n) {
        return { found: true, bytes: pointerBytes(0x10000n + addr), text: '', terminated: false };
      }
      return null;
    },
  };

  await resolveModelTexts(backend, model, 96);
  assert.equal(reads, 192, 'coverage must remain 96 direct + 96 indirect reads');
  assert.ok(peak <= 6, `readAt peak concurrency must be <= 6, got ${peak}`);
}

console.log('stage2 analysis scheduling regressions (#2523, #2531): PASS');
