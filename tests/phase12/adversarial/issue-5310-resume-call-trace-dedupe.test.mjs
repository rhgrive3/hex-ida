// Issue #5310 regression: resume() must not emit both the generic BL/BLR
// instruction entry and the emulator's typed call entry for one execution.
import assert from 'node:assert/strict';
import test from 'node:test';

import { LocalFunctionSandboxAdapter } from '../../../js/adapters/index.js';

async function makeAdapter() {
  const adapter = new LocalFunctionSandboxAdapter({
    async fetch() { return null; },
    async read() { return null; },
  });
  await adapter.launch({ address: 0x1000n });
  return adapter;
}

async function resumeWithTrace(trace) {
  const adapter = await makeAdapter();
  adapter.ensureSandbox().run = async () => ({
    trace,
    steps: trace.length,
    takenBranches: [],
    returnValue: null,
    traceMeta: { truncated: false, dropped: 0, limit: 4096 },
  });
  return adapter.resume();
}

test('#5310 BL typed and generic entries normalize to one call', async () => {
  const result = await resumeWithTrace([
    { addr: 0x1000n, text: 'bl 0x2000' },
    { type: 'call', addr: 0x1000n, target: 0x2000n, indirect: false, text: 'bl 0x2000' },
  ]);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].target, 0x2000n);
  assert.equal(result.trace.events.filter((event) => event.type === 'call').length, 1);
});

test('#5310 BLR typed entry is authoritative over generic fallback', async () => {
  const result = await resumeWithTrace([
    { addr: 0x1100n, text: 'blr x3' },
    { type: 'call', addr: 0x1100n, target: 0x2200n, indirect: true, text: 'blr x3' },
  ]);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].target, 0x2200n);
  assert.equal(result.calls[0].indirect, true);
});

test('#5310 repeated executions at one site remain separate calls', async () => {
  const result = await resumeWithTrace([
    { addr: 0x1200n, text: 'bl 0x3000' },
    { type: 'call', addr: 0x1200n, target: 0x3000n, indirect: false, text: 'bl 0x3000' },
    { addr: 0x1200n, text: 'bl 0x3000' },
    { type: 'call', addr: 0x1200n, target: 0x3000n, indirect: false, text: 'bl 0x3000' },
  ]);
  assert.equal(result.calls.length, 2);
});

test('#5310 legacy-only and different sites are not over-deduplicated', async () => {
  const result = await resumeWithTrace([
    { addr: 0x1300n, text: 'bl 0x4000' },
    { addr: 0x1400n, text: 'blr x4' },
    { type: 'call', addr: 0x1500n, target: 0x5000n, indirect: false, text: 'bl 0x5000' },
    { addr: 0x1500n, text: 'bl 0x5000' },
  ]);
  assert.equal(result.calls.length, 3);
  assert.deepEqual(result.calls.map((call) => call.address), [0x1300n, 0x1400n, 0x1500n]);
});
