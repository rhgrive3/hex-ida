import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../js/adapters/index.js';
import { DebugAdapterError } from '../js/debug/adapter.js';
import { DEFAULT_OBJECT_BASE } from '../js/symbolic/function-sandbox.js';

const io = {
  fetch: async (address) => BigInt(address) === 0x1000n ? { mn: 'ret', ops: '' } : null,
  read: async () => null,
  isExecutable: (address) => BigInt(address) === 0x1000n,
  symbolFor: () => null,
};

test('6077: empty write validates the address first', async () => {
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  await adapter.launch({ address: 0x1000n, objectAsArg0: false });
  try {
    await assert.rejects(
      adapter.writeMemory({}, new Uint8Array()),
      (error) => error instanceof DebugAdapterError,
      'structured address must not succeed even for 0 bytes',
    );
    await assert.rejects(
      adapter.writeMemory(-1, []),
      (error) => error instanceof DebugAdapterError,
      'negative address must not succeed even for 0 bytes',
    );
    await assert.rejects(
      adapter.writeMemory('not-an-address!!', new Uint8Array()),
      (error) => error instanceof DebugAdapterError,
      'malformed address must not succeed even for 0 bytes',
    );
  } finally {
    await adapter.disconnect();
  }
});

test('6077: empty write to a valid address still succeeds', async () => {
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  await adapter.launch({ address: 0x1000n, objectAsArg0: false });
  try {
    assert.deepEqual(await adapter.writeMemory(DEFAULT_OBJECT_BASE, new Uint8Array()), { written: 0 });
    assert.deepEqual(await adapter.writeMemory(DEFAULT_OBJECT_BASE, []), { written: 0 });
  } finally {
    await adapter.disconnect();
  }
});
