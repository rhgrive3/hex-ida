// Regression for #6077: an empty byte list must not skip writeMemory's address
// validation — the empty-data shortcut sits after asAddress().
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LocalFunctionSandboxAdapter } from '../js/adapters/index.js';

function harness() {
  const calls = { assert: 0, store: 0 };
  const adapter = Object.assign(Object.create(LocalFunctionSandboxAdapter.prototype), {
    capabilities: { writeMemory: true },
    require(name) { if (!this.capabilities[name]) throw new Error('capability-unavailable:' + name); },
    sandbox: {
      emulator: {
        async store() { calls.store++; },
      },
    },
    memoryMap: { assert(start, length, mode) { calls.assert++; calls.last = { start: String(start), length, mode }; } },
    traceState: { suppressMemory: 0 },
    epoch: 0,
  });
  return { adapter, calls };
}

test('#6077 a structured non-address cannot pass as an empty write', async () => {
  const { adapter } = harness();
  await assert.rejects(
    adapter.writeMemory({}, new Uint8Array()),
    (error) => error?.code === 'invalid-address',
  );
});

test('#6077 a negative address cannot pass as an empty write', async () => {
  const { adapter } = harness();
  await assert.rejects(
    adapter.writeMemory(-1, []),
    (error) => error?.code === 'invalid-address',
  );
});

test('#6077 a valid address keeps the 0-byte write success semantics', async () => {
  const { adapter, calls } = harness();
  const result = await adapter.writeMemory(0x1000n, []);
  assert.deepEqual(result, { written: 0 });
  assert.equal(calls.assert, 1, 'address must be validated');
  assert.equal(calls.last.length, 0);
  assert.equal(calls.store, 0, 'nothing is written for an empty list');
});

test('#6077 a non-empty write still validates and stores', async () => {
  const { adapter, calls } = harness();
  const result = await adapter.writeMemory(0x1000n, new Uint8Array([0x41, 0x42]));
  assert.equal(result.written, 2);
  assert.equal(calls.last.start, '4096');
  assert.equal(calls.last.length, 2);
  assert.equal(calls.store, 1);
});
