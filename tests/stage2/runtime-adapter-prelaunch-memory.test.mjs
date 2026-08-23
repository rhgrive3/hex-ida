import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../js/adapters/index.js';
import { DebugAdapterError } from '../../js/debug/adapter.js';

function isNotLaunched(error) {
  return error instanceof DebugAdapterError && error.code === 'not-launched';
}

const adapter = new LocalFunctionSandboxAdapter({});
await adapter.connect();

await assert.rejects(
  adapter.readMemory(0x1000n, 1),
  isNotLaunched,
  'readMemory before launch must fail with the typed not-launched adapter error',
);

await assert.rejects(
  adapter.writeMemory(0x1000n, new Uint8Array([0])),
  isNotLaunched,
  'writeMemory before launch must fail with the typed not-launched adapter error',
);

await adapter.disconnect();
