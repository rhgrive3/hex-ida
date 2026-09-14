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
        scheduled.push({
          settle(signal) {
            if (signal?.aborted) {
              reject(Object.assign(new Error('scheduled work aborted'), { name:'AbortError' }));
              return;
            }
            Promise.resolve().then(fn).then(resolve, reject);
          },
        });
      });
    },
  };
  try {
    return await run(scheduled);
  } finally {
    globalThis.scheduler = originalScheduler;
  }
}

test('#4749 pre-aborted first binary identity caller creates no producer', async () => {
  await withFakeScheduler(async (scheduled) => {
    let hashCalls = 0;
    const backend = {
      file:{ name:'fixture.bin' },
      gen:1,
      ensureContentHash() {
        hashCalls++;
        return Promise.resolve(HEX64);
      },
    };
    installWorkerBackedIdentity({ backend });
    const reason = Object.assign(new Error('closed-before-request'), { name:'AbortError' });
    const controller = new AbortController();
    controller.abort(reason);

    assert.throws(() => backend.ensureBinaryId({ signal:controller.signal }), (error) => error === reason);
    assert.equal(scheduled.length, 0, 'pre-aborted first caller must not schedule a producer');
    assert.equal(hashCalls, 0, 'pre-aborted first caller must not start hashing');
    assert.equal(backend._binaryIdEntry ?? null, null, 'pre-abort must not leave an orphan entry');
    assert.equal(backend._binaryIdPromise ?? null, null, 'pre-abort must not leave an orphan promise');
  });
});

test('#4749 pre-aborted second binary identity caller does not cancel active producer', async () => {
  await withFakeScheduler(async (scheduled) => {
    let resolveHash;
    let producerSignal = null;
    const backend = {
      file:{ name:'fixture.bin' },
      gen:1,
      ensureContentHash(_progress, signal) {
        producerSignal = signal;
        return new Promise((resolve) => { resolveHash = resolve; });
      },
    };
    installWorkerBackedIdentity({ backend });

    const first = backend.ensureBinaryId({ signal:new AbortController().signal });
    assert.equal(scheduled.length, 1);

    const secondReason = Object.assign(new Error('second-pre-aborted'), { name:'AbortError' });
    const secondController = new AbortController();
    secondController.abort(secondReason);
    assert.throws(() => backend.ensureBinaryId({ signal:secondController.signal }), (error) => error === secondReason);
    assert.equal(scheduled.length, 1, 'pre-aborted joiner must not create another producer');

    scheduled[0].settle(null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(producerSignal?.aborted, false, 'pre-aborted joiner must not cancel the active producer');
    resolveHash(HEX64);
    assert.equal(await first, `bin_sha256_${HEX64}`);
  });
});

test('#4749 completed binary identity remains a cache hit for a pre-aborted caller', async () => {
  const backend = {
    binaryId:`bin_sha256_${HEX64}`,
    file:{ name:'fixture.bin' },
    gen:1,
    ensureContentHash() { throw new Error('cache hit must not hash'); },
  };
  installWorkerBackedIdentity({ backend });
  const controller = new AbortController();
  controller.abort('already closed');
  assert.equal(await backend.ensureBinaryId({ signal:controller.signal }), `bin_sha256_${HEX64}`);
});

function emptyScan() {
  return {
    regionId:'text',
    vmAddr:0x1000n,
    callFrom:new BigUint64Array(0),
    callTo:new BigUint64Array(0),
    callCount:0,
    refFrom:new BigUint64Array(0),
    refTo:new BigUint64Array(0),
    refKind:new Uint8Array(0),
    refCount:0,
    kinds:new Uint8Array(0),
    kindsCovered:0,
    words:0,
    complete:true,
  };
}

test('#4749 scan registration race observes cancellation rejection and permits replacement work', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('aborted-during-scan-registration'), { name:'AbortError' });
  const producerError = Object.assign(new Error('cancelled-zero-waiter-producer'), { name:'AbortError' });
  let cancelCalls = 0;
  let scanCalls = 0;
  const app = {
    backend:{
      gen:0,
      binaryId:'test-binary-4749',
      scanProgram() {
        scanCalls++;
        if (scanCalls === 1) {
          controller.abort(reason);
          let rejectRequest;
          const request = new Promise((_resolve, reject) => { rejectRequest = reject; });
          request.cancel = () => {
            cancelCalls++;
            rejectRequest(producerError);
          };
          return request;
        }
        return Promise.resolve(emptyScan());
      },
    },
    programRegions:() => [{ id:'text', exec:true, vmAddr:0x1000n, size:0x100n }],
    store:{ get:() => null },
  };
  installDemandDrivenAnalysis(app);
  const snapshot = await app.analysisQueries.snapshot();

  await assert.rejects(
    app.analysisQueries.callers(snapshot, 0x1000n, {}, { signal:controller.signal }),
    (error) => error === reason,
  );
  assert.equal(scanCalls, 1, 'race is entered only after scan request creation');
  assert.equal(cancelCalls, 1, 'zero-waiter scan request must be cancelled immediately');

  // Let the cancellation rejection traverse the shared producer chain. With no
  // observer on entry.promise node:test reports this as an unhandled rejection.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const replacement = await app.analysisQueries.callers(snapshot, 0x1000n, {}, {});
  assert.equal(scanCalls, 2, 'a live caller must start replacement work after the retired producer');
  assert.deepEqual(replacement.value, []);
  assert.equal(replacement.status.completeness, 'complete');
});
