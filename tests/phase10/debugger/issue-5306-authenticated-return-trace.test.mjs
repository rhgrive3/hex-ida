// Regression for #5306: the local sandbox trace normalizer classified return
// events with /^ret\b/i, whose word boundary can never hold before the
// ARM64e authenticated-return suffixes — `retaa`/`retab` (which the local
// Emulator executes as returns) were dropped from the traceReturn surface,
// so authenticated returns never produced return trace events.
// Contract now: `ret`, `retaa` and `retab` all classify as return events
// (case-insensitive) in the LocalFunctionSandboxAdapter trace buffer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalFunctionSandboxAdapter } from '../../../js/adapters/index.js';

async function traceFor(text) {
  const io = {
    async fetch(address) { return { mn: text, ops: '' }; },
    async read() { return null; },
  };
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.launch({ address: 0x1000n, registers: { x30: 0x900n }, memoryMappings: [] });
  await adapter.stepInto();
  const snapshot = await adapter.trace();
  return snapshot.events.filter((event) => event?.type === 'return');
}

test('#5306 retaa/retab classify as return trace events', async () => {
  for (const text of ['ret', 'retaa', 'retab', 'RETAA', 'Retab']) {
    const returns = await traceFor(text);
    assert.ok(returns.length >= 1, `${text} must produce a return event`);
    assert.equal(returns[0].text, text);
  }
});
