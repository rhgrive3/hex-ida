import assert from 'node:assert/strict';
import test from 'node:test';

import { LocalFunctionSandboxAdapter } from '../../js/adapters/index.js';
import { DEFAULT_OBJECT_BASE } from '../../js/symbolic/function-sandbox.js';

const io = {
  fetch: async () => ({ mn:'ret', ops:'' }),
  read: async () => null,
  isExecutable: () => true,
  symbolFor: () => null,
};

function fakeResult(trace = []) {
  return {
    trace,
    traceMeta:{ truncated:false, dropped:0, limit:4000 },
    steps:trace.length,
    takenBranches:[],
    touchedFields:[],
    before:[],
    after:[],
    modifiedObjectRanges:[],
    returnValue:0n,
    stopped:null,
  };
}

function instructionTrace(count, base = 0x1000n) {
  return Array.from({ length:count }, (_, index) => ({
    addr:base + BigInt(index * 4),
    text:'nop',
  }));
}

test('#6301 keeps the complete current-run memory summary when the cumulative trace ring evicts', async () => {
  const adapter = new LocalFunctionSandboxAdapter(io, { trace:{ maxEvents:16 } });
  await adapter.connect();
  await adapter.launch({ address:0x1000n, objectAsArg0:false });

  const sandbox = adapter.sandbox;
  sandbox.run = async () => {
    for (let index = 0; index < 20; index++) {
      await sandbox.emulator.store(DEFAULT_OBJECT_BASE + BigInt(index), 1, BigInt(index));
    }
    return fakeResult(instructionTrace(20));
  };

  const first = await adapter.resume();
  assert.equal(first.stores.length, 20, 'run-local summary must retain stores evicted from the bounded trace ring');
  assert.deepEqual(first.stores.map((event) => event.address),
    Array.from({ length:20 }, (_, index) => DEFAULT_OBJECT_BASE + BigInt(index)));
  assert.equal(first.loads.length, 0);
  assert.ok(first.trace.events.length <= 16, 'cumulative trace must retain its configured maxEvents bound');
  assert.equal(first.trace.incomplete, true, 'ring eviction must still mark the cumulative trace incomplete');
  assert.equal(adapter.traceState.runMemoryEvents, null, 'resume must release its launch-scoped run capture');

  await adapter.writeMemory(DEFAULT_OBJECT_BASE, Uint8Array.of(0xaa));
  sandbox.run = async () => fakeResult([{ addr:0x1100n, text:'nop' }]);
  const second = await adapter.resume();
  assert.equal(second.stores.length, 0, 'prior-run and administrative writes must not replay into the next resume');
  assert.equal(second.loads.length, 0);

  sandbox.run = async () => {
    await sandbox.emulator.store(DEFAULT_OBJECT_BASE + 0x40n, 1, 0x55n);
    return fakeResult([{ addr:0x1104n, text:'nop' }]);
  };
  const third = await adapter.resume();
  assert.deepEqual(third.stores.map((event) => event.address), [DEFAULT_OBJECT_BASE + 0x40n]);

  await adapter.disconnect();
});
