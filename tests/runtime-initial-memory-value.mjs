import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../js/adapters/index.js';
import { DebugAdapterError } from '../js/debug/adapter.js';
import { RUNTIME_HEAP_BASE } from '../js/runtime/memory.js';

const io = {
  fetch: async () => null,
  read: async () => null,
  isExecutable: () => false,
  symbolFor: () => null,
};

// #3267: negative hexadecimal initial-memory strings must fail through the
// adapter validation contract, never through native BigInt SyntaxError.
{
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  await assert.rejects(
    adapter.launch({
      address: 0x1000n,
      objectAsArg0: false,
      heap: [{ address: RUNTIME_HEAP_BASE, size: 8, value: '-0x1' }],
    }),
    (error) => {
      assert.ok(error instanceof DebugAdapterError);
      assert.equal(error.code, 'invalid-argument');
      assert.doesNotMatch(String(error.message), /Cannot convert .* to a BigInt/i);
      return true;
    },
  );
  await adapter.disconnect();
}

// Existing accepted forms remain compatible.
for (const [value, label] of [[-1n, 'bigint'], [-1, 'number'], ['-1', 'decimal'], ['0x1', 'hex']]) {
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  const launched = await adapter.launch({
    address: 0x1000n,
    objectAsArg0: false,
    heap: [{ address: RUNTIME_HEAP_BASE, size: 8, value }],
  });
  assert.equal(launched.launched, true, `${label} initial memory remains accepted`);
  await adapter.disconnect();
}

console.log('runtime initial-memory value validation: PASS');
