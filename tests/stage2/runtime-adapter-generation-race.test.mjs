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
    }
    return { mn:'ret', ops:'' };
  },
  read: async () => null,
  isExecutable: () => true,
  symbolFor: () => null,
};

const adapter = new LocalFunctionSandboxAdapter(io);
await adapter.connect();
await adapter.launch({ address:0x1000n, objectAsArg0:false, registers:{ x0:1n } });

const oldRun = adapter.resume({ maxSteps:10 });
await fetchStarted;

const secondLaunch = await adapter.launch({ address:0x2000n, objectAsArg0:false, registers:{ x0:99n } });
assert.equal(secondLaunch.epoch, 2);
assert.equal((await adapter.readRegisters()).x0, 99n);

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

await adapter.disconnect();
