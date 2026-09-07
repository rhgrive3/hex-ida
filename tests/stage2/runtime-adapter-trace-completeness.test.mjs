import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../js/adapters/index.js';

const io = {
  fetch: async () => ({ mn:'ret', ops:'' }),
  read: async () => null,
  isExecutable: () => true,
  symbolFor: () => null,
};

function fakeResult(trace, { steps = trace.length, traceMeta = {} } = {}) {
  return {
    trace,
    traceMeta,
    steps,
    takenBranches:[],
    touchedFields:[],
    before:[],
    after:[],
    modifiedObjectRanges:[],
    returnValue:0n,
    stopped:null,
  };
}

const producerTruncated = new LocalFunctionSandboxAdapter(io);
await producerTruncated.connect();
await producerTruncated.launch({ address:0x1000n, objectAsArg0:false });
const sourceResult = producerTruncated._normalizeResult(fakeResult(
  [{ addr:0x1000n, text:'nop' }, { type:'call', addr:0x1000n, target:0x2000n, text:'bl #0x2000' }],
  { steps:1, traceMeta:{ truncated:true, dropped:25, limit:4000 } },
));
assert.equal(sourceResult.trace.incomplete, true, 'producer truncation must make the adapter trace incomplete even when event count exceeds step count');
assert.equal(sourceResult.trace.sourceTruncated, true);
assert.equal(sourceResult.trace.sourceDropped, 25);
assert.equal(sourceResult.trace.sourceLimit, 4000);
await producerTruncated.disconnect();

const localTruncated = new LocalFunctionSandboxAdapter(io, { trace:{ maxEvents:16 } });
await localTruncated.connect();
await localTruncated.launch({ address:0x1000n, objectAsArg0:false });
const events = Array.from({ length:20 }, (_, i) => ({ addr:0x1000n + BigInt(i * 4), text:'nop' }));
const localResult = localTruncated._normalizeResult(fakeResult(events, { steps:20, traceMeta:{ truncated:false, dropped:0, limit:4000 } }));
assert.ok(localResult.trace.dropped > 0, 'bounded adapter trace buffer must report local drops');
assert.equal(localResult.trace.incomplete, true, 'local ring-buffer drops must make the trace incomplete');
await localTruncated.disconnect();
