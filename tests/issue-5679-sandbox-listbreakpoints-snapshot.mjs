import test from 'node:test';
import assert from 'node:assert/strict';

import { LocalFunctionSandboxAdapter } from '../js/adapters/index.js';

// #5679: LocalFunctionSandboxAdapter.listBreakpoints() returned the internal
// breakpoint objects by reference. normalizeBreakpoint() results are unfrozen,
// so editing a listed object mutated the adapter's ledger — desyncing it from
// the emulator breakpoints that launch() registered and leaving stale
// breakpoints behind when removeBreakpoint() used a mutated address.

function adapterWithBreakpoint() {
  const io = {
    backend: { gen: 1, binaryId: 'binary-5679' },
    store: { get: () => null },
    analysisQueries: { snapshot: async () => ({ snapshotId: 'snap-5679' }), binaryInfo: async () => ({}) },
    async ensureProgram() { return null; },
  };
  const adapter = new LocalFunctionSandboxAdapter(io);
  return adapter;
}

test('#5679 listBreakpoints returns snapshot copies, not ledger references', async () => {
  const adapter = adapterWithBreakpoint();
  await adapter.setBreakpoint({ id: 'bp:test', kind: 'address', address: 0x1000n });

  const listed = await adapter.listBreakpoints();
  assert.equal(listed.length, 1);
  listed[0].address = 0x3000n; // public API result edit

  const again = await adapter.listBreakpoints();
  assert.equal(again[0].address, 0x1000n,
    'mutating a listed result must not rewrite the adapter ledger');
});

test('#5679 mutating a listed breakpoint cannot orphan the emulator registration', async () => {
  const adapter = adapterWithBreakpoint();
  await adapter.setBreakpoint({ id: 'bp:test', kind: 'address', address: 0x1000n });
  await adapter.launch({ address: 0x2000n });
  assert.ok(adapter.sandbox.emulator.breakpoints.has('4096'), 'launch registers the breakpoint');

  const listed = await adapter.listBreakpoints();
  listed[0].address = 0x3000n;

  await adapter.removeBreakpoint('bp:test');
  assert.equal(adapter.sandbox.emulator.breakpoints.has('4096'), false,
    'the original registration must be removed, not orphaned by a mutated copy');
});
