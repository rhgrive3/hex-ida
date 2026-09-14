import assert from 'node:assert/strict';
import test from 'node:test';

import {
  installDemandDrivenAnalysis,
  __demandDrivenInternalsForTests,
} from '../../../js/analysis/demand-driven-runtime.js';

const { installWorkerBackedIdentity } = __demandDrivenInternalsForTests;

const HEX64 = 'a'.repeat(64);

async function withFakeScheduler(run) {
  const originalScheduler = globalThis.scheduler;
  const scheduled = [];
  globalThis.scheduler = {
    postTask(fn) {
      return new Promise((resolve, reject) => {
        scheduled.push({ settle: (signal) => {
          if (signal && signal.aborted) reject(Object.assign(new Error('scheduled work aborted'), { name: 'AbortError' }));
          else { fn(); resolve(); }
        } });
      });
    },
  };
  try {
    return await run(scheduled);
  } finally {
    globalThis.scheduler = originalScheduler;
  }
}

function abortedError(signal) {
  return signal?.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' });
}

function deferredHashBackend() {
  const deferred = [];
  return {
    deferred,
    ensureContentHash(onProgress, signal) {
      if (signal?.aborted) return Promise.reject(abortedError(signal));
      return new Promise((resolve, reject) => {
        deferred.push({ resolve, reject });
        signal?.addEventListener('abort', () => reject(abortedError(signal)), { once: true });
      });
    },
  };
}

test('#4611 a cancelled binary-id single-flight is not reused by the next caller', async () => {
  await withFakeScheduler(async (scheduled) => {
    const hash = deferredHashBackend();
    const backend = { file: 'file.bin', gen: 1, ensureContentHash: hash.ensureContentHash };
    installWorkerBackedIdentity({ backend });

    const controllerA = new AbortController();
    const promiseA = backend.ensureBinaryId({ signal: controllerA.signal });
    assert.equal(scheduled.length, 1, 'first caller schedules the shared producer');
    controllerA.abort();
    await assert.rejects(promiseA);

    // The first producer never settles here (its scheduler task is still
    // pending), so the owner still holds the cancelled entry. The next caller
    // must get a fresh producer instead of joining the cancelled one.
    const controllerB = new AbortController();
    const promiseB = backend.ensureBinaryId({ signal: controllerB.signal });
    assert.equal(scheduled.length, 2, 'cancelled entry must not be reused');

    scheduled[0].settle(controllerA.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    scheduled[1].settle(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    hash.deferred.at(-1).resolve(HEX64);
    const binaryId = await promiseB;
    assert.equal(binaryId, `bin_sha256_${HEX64}`);
    assert.equal(backend.binaryId, binaryId);
  });
});

test('#4611 a cancelled function-discovery single-flight is not reused by the next caller', async () => {
  await withFakeScheduler(async () => {
    const guessFunctions = [];
    const app = {
      backend: {
        gen: 1,
        guessFunctions(regionId) {
          return new Promise((resolve, reject) => {
            guessFunctions.push({ settle: (signal) => {
              if (signal && signal.aborted) reject(abortedError(signal));
              else resolve({ starts: [{ address: '0x1000' }], discoveryComplete: true });
            } });
          });
        },
      },
      programRegions: () => [{ id: 'region-1', exec: true, vmAddr: 0x1000, size: 0x1000 }],
      symbols: { addFunctions() {} },
    };
    installDemandDrivenAnalysis(app);

    const controllerA = new AbortController();
    const promiseA = app.ensureFunctions({ id: 'region-1', exec: true }, { signal: controllerA.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(guessFunctions.length, 1, 'first caller starts the shared producer');
    controllerA.abort();
    await assert.rejects(promiseA);

    const controllerB = new AbortController();
    const promiseB = app.ensureFunctions({ id: 'region-1', exec: true }, { signal: controllerB.signal });
    assert.equal(guessFunctions.length, 2, 'cancelled discovery producer must not be reused');

    guessFunctions[0].settle(controllerA.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    guessFunctions[1].settle(null);
    const symbols = await promiseB;
    assert.equal(symbols.functionDiscovery.complete, true);
  });
});
