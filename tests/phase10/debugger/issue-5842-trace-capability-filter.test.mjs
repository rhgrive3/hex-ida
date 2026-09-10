import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../../js/adapters/index.js';

// #5842: LocalFunctionSandboxAdapter advertises traceCall / traceReturn /
// traceBranch / traceMemoryWrite as individual capabilities, but its trace()
// override ignored the capability discriminator that
// DebugAdapter._traceCapability passes in and always returned the whole
// TraceRingBuffer snapshot. Each advertised capability must return only its
// own event class; generic trace() keeps the full buffer.

function seededAdapter() {
  const adapter = new LocalFunctionSandboxAdapter({});
  adapter.traceBuffer.push({ type: 'instruction', address: 0x1000n, text: 'nop' });
  adapter.traceBuffer.push({ type: 'call', address: 0x1004n, target: 0x2000n, text: 'bl 0x2000' });
  adapter.traceBuffer.push({ type: 'branch', address: 0x1008n, target: 0x1010n, taken: true });
  adapter.traceBuffer.push({ type: 'return', address: 0x100cn, target: 0x2004n, text: 'ret' });
  adapter.traceBuffer.push({ type: 'memory-write', address: 0x2000n, size: 4, region: 'stack', before: 0n, after: 1n });
  return adapter;
}

test('5842: traceCall returns only call events', async () => {
  const result = await seededAdapter().traceCall();
  assert.ok(result.events.length > 0, 'at least the call event must survive the filter');
  assert.ok(result.events.every((e) => e.type === 'call'));
  assert.equal(result.events[0].address, 0x1004n);
});

test('5842: traceReturn returns only return events', async () => {
  const result = await seededAdapter().traceReturn();
  assert.ok(result.events.length > 0);
  assert.ok(result.events.every((e) => e.type === 'return'));
});

test('5842: traceBranch returns only branch events', async () => {
  const result = await seededAdapter().traceBranch();
  assert.ok(result.events.length > 0);
  assert.ok(result.events.every((e) => e.type === 'branch'));
});

test('5842: traceMemoryWrite returns only memory-write events', async () => {
  const result = await seededAdapter().traceMemoryWrite();
  assert.ok(result.events.length > 0);
  assert.ok(result.events.every((e) => e.type === 'memory-write'));
});

test('5842: generic trace keeps the whole buffer', async () => {
  const result = await seededAdapter().trace();
  assert.deepEqual(result.events.map((e) => e.type), ['instruction', 'call', 'branch', 'return', 'memory-write']);
});

test('5842: capability filter keeps buffer statistics and does not mutate the ring', async () => {
  const adapter = seededAdapter();
  const generic = await adapter.trace();
  const filtered = await adapter.traceCall();
  assert.equal(filtered.seen, generic.seen);
  assert.equal(filtered.dropped, generic.dropped);
  assert.equal(filtered.bytes, generic.bytes);
  // the ring itself is untouched by filtering: a later generic read still
  // sees every event
  assert.equal((await adapter.trace()).events.length, generic.events.length);
});

test('5842: unknown capability discriminator stays unfiltered', async () => {
  const result = await seededAdapter().trace({ capability: 'traceFunction' });
  assert.equal(result.events.length, 5);
});
