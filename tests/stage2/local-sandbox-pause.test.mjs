import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../js/adapters/index.js';

function program(entries) {
  const table = new Map(entries.map(([address, mnemonic, operands = '']) => [
    BigInt(address).toString(),
    { mn: mnemonic, ops: operands },
  ]));
  return {
    fetch: async (address) => table.get(BigInt(address).toString()) || null,
    read: async () => null,
    isExecutable: (address) => table.has(BigInt(address).toString()),
    symbolFor: () => null,
  };
}

const adapter = new LocalFunctionSandboxAdapter(program([
  [0x1720, 'add', 'x0, x0, #1'],
  [0x1724, 'b', '#0x1720'],
]));
await adapter.connect();
await adapter.launch({ address: 0x1720n, arguments: [0n], objectAsArg0: false });

let pauseRequested = false;
const paused = await adapter.resume({
  maxSteps: 5000,
  onProgress: (steps) => {
    if (!pauseRequested && steps >= 500) {
      pauseRequested = true;
      void adapter.pause();
    }
  },
});
assert.equal(paused.stop.kind, 'paused');
assert.equal(adapter.cancelled, false);

const before = (await adapter.readRegisters()).x0;
const resumed = await adapter.resume({ maxSteps: 2 });
const after = (await adapter.readRegisters()).x0;
assert.notEqual(after, before);
assert.notEqual(resumed.stop.kind, 'cancelled');

await adapter.launch({ address: 0x1720n, arguments: [0n], objectAsArg0: false });
let cancelRequested = false;
const cancelled = await adapter.resume({
  maxSteps: 5000,
  onProgress: (steps) => {
    if (!cancelRequested && steps >= 500) {
      cancelRequested = true;
      void adapter.cancel();
    }
  },
});
assert.equal(cancelled.stop.kind, 'cancelled');
await adapter.disconnect();

// Exact-head CI trigger after current-main reconciliation.
// Generated outputs are synchronized before this final validation pass.
