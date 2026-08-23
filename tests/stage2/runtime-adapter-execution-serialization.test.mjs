import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../js/adapters/index.js';

let releaseFetch;
let markFetchStarted;
const blockedFetch = new Promise((resolve) => { releaseFetch = resolve; });
const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
let firstFetch = true;
let fetches = 0;

const io = {
  fetch: async () => {
    fetches++;
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
await adapter.launch({ address:0x1000n, objectAsArg0:false });

const running = adapter.resume({ maxSteps:10 });
await fetchStarted;
const fetchesBeforeStep = fetches;

await assert.rejects(
  () => adapter.stepInto(),
  (error) => error?.code === 'already-running',
  'single-step must not enter an emulator owned by an active resume',
);
assert.equal(fetches, fetchesBeforeStep, 'rejected stepInto must not start a second instruction fetch');

releaseFetch();
await running;
assert.equal(adapter.activeRun, null);
assert.equal(adapter.running, false);

await adapter.disconnect();
