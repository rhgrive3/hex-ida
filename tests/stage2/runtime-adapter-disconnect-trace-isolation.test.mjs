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
  registers:{ x1:objectBase },
  objectMemory:[{ offset:0, size:8, value:0x1234n }],
  traceMemoryReads:true,
});

const running = adapter.resume({ maxSteps:10 });
await fetchStarted;
await adapter.disconnect();
releaseFetch();

await assert.rejects(running, (error) => error?.code === 'stale-run');
assert.equal(adapter.connected, false);
assert.deepEqual(
  (await adapter.trace()).events,
  [],
  'an obsolete sandbox must not repopulate the adapter-visible trace buffer after disconnect',
);
