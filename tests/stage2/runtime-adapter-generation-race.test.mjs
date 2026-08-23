import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../js/adapters/index.js';

let releaseFetch;
let markFetchStarted;
const blockedFetch = new Promise((resolve) => { releaseFetch = resolve; });
const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
let firstFetch = true;

const io = {
  fetch: async () => {
    if (firstFetch) {
      firstFetch = false;
      markFetchStarted();
      await blockedFetch;
      return { mn:'ldr', ops:'x0, [x1]' };
    }
    return { mn:'ret', ops:'' };
  },
  read: async () => null,
  isExecutable: () => true,
  symbolFor: () => null,
};

const adapter = new LocalFunctionSandboxAdapter(io);
await adapter.connect();
const objectBase = 0x0000600000001000n;
await adapter.launch({
  address:0x1000n,
  objectAsArg0:false,
  registers:{ x0:1n, x1:objectBase },
  objectMemory:[{ offset:0, size:8, value:0x1234n }],
  traceMemoryReads:true,
});

const oldController = new AbortController();
const oldRun = adapter.resume({ maxSteps:10, signal:oldController.signal });
await fetchStarted;

const secondLaunch = await adapter.launch({ address:0x2000n, objectAsArg0:false, registers:{ x0:99n } });
assert.equal(secondLaunch.epoch, 2);
assert.equal((await adapter.readRegisters()).x0, 99n);

oldController.abort('old-generation-abort');
assert.equal(adapter.cancelled, false, 'an obsolete AbortSignal must not mutate the new generation cancellation state');

releaseFetch();
await assert.rejects(
  oldRun,
  (error) => error?.code === 'stale-run',
  'an obsolete run must not publish or normalize against a newer launch generation',
);

assert.equal(adapter.epoch, 2);
assert.equal((await adapter.readRegisters()).x0, 99n, 'old run completion must not alter the newly launched sandbox');
assert.equal(adapter.lastResult, null, 'obsolete run completion must not overwrite the new generation result slot');
assert.equal(adapter.running, false);
assert.equal(adapter.activeRun, null);
assert.deepEqual((await adapter.trace()).events, [], 'old-generation memory events must not leak into the new launch trace buffer');

await adapter.disconnect();
