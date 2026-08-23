import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../js/adapters/index.js';
import { DebugAdapterError } from '../../js/debug/adapter.js';
import { DEFAULT_OBJECT_BASE } from '../../js/symbolic/function-sandbox.js';

const io = {
  fetch: async (address) => BigInt(address) === 0x1000n ? { mn:'ret', ops:'' } : null,
  read: async () => null,
  isExecutable: (address) => BigInt(address) === 0x1000n,
  symbolFor: () => null,
};

const adapter = new LocalFunctionSandboxAdapter(io);
await adapter.connect();
await adapter.launch({ address:0x1000n, objectAsArg0:false });

for (const invalid of [256, -1, 1.5]) {
  await assert.rejects(
    adapter.writeMemory(DEFAULT_OBJECT_BASE, [invalid]),
    (error) => error instanceof DebugAdapterError && error.code === 'invalid-byte',
    `writeMemory must reject invalid byte ${invalid} instead of coercing it`,
  );
}

await adapter.disconnect();
