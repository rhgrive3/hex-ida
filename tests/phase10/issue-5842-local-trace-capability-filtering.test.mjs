// Regression for #5842: LocalFunctionSandboxAdapter advertised traceCall/
// traceReturn/traceBranch/traceMemoryWrite as individual capabilities, but its
// generic trace() override ignored options.capability and always returned the
// whole ring-buffer snapshot. A traceCall() request therefore returned a mix
// of instruction, branch, call and memory events. Multiplexed capability
// requests now filter the snapshot to the capability's own event stream.
import assert from 'node:assert/strict';
import test from 'node:test';

import { LocalFunctionSandboxAdapter } from '../../js/adapters/index.js';

function seededAdapter() {
  const adapter = new LocalFunctionSandboxAdapter({});
  adapter.traceBuffer.push({ type: 'instruction', address: 0x1000n, text: 'nop' });
  adapter.traceBuffer.push({ type: 'call', address: 0x1004n, target: 0x2000n, text: 'bl 0x2000' });
  adapter.traceBuffer.push({ type: 'branch', address: 0x1008n, target: 0x1010n, taken: true });
  adapter.traceBuffer.push({ type: 'return', address: 0x100cn, text: 'ret' });
  adapter.traceBuffer.push({ type: 'memory-write', address: 0x3000n, size: 4, region: 'heap', before: 0n, after: 42n });
  return adapter;
}

test('#5842 traceCall returns only call events', async () => {
  const adapter = seededAdapter();
  const result = await adapter.traceCall();
  assert.deepEqual(result.events.map((event) => event.type), ['call']);
});

test('#5842 traceReturn returns only return events', async () => {
  const adapter = seededAdapter();
  const result = await adapter.traceReturn();
  assert.deepEqual(result.events.map((event) => event.type), ['return']);
});

test('#5842 traceBranch returns only branch events', async () => {
  const adapter = seededAdapter();
  const result = await adapter.traceBranch();
  assert.deepEqual(result.events.map((event) => event.type), ['branch']);
});

test('#5842 traceMemoryWrite returns only memory-write events', async () => {
  const adapter = seededAdapter();
  const result = await adapter.traceMemoryWrite();
  assert.deepEqual(result.events.map((event) => event.type), ['memory-write']);
});

test('#5842 the generic trace() keeps returning the full stream', async () => {
  const adapter = seededAdapter();
  const result = await adapter.trace();
  assert.equal(result.events.length, 5, 'no capability requested: the whole buffer stays visible');
});
