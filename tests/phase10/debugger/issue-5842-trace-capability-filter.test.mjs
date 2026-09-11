import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../../js/adapters/index.js';
import { DebugAdapterError } from '../../../js/debug/adapter.js';

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

// #5842 review follow-up: the multiplexed subtype form traceCall({limit:1})
// compiles to trace({capability:'traceCall', args:[{limit:1}]}) and the direct
// discriminator form passes limit at the top level. Subtype options must
// survive the multiplex, the capability filter must run before any limit cut
// (newer heterogeneous events never displace the target class), and the limit
// value itself stays strictly validated.

function mixedAdapter() {
  const adapter = new LocalFunctionSandboxAdapter({});
  adapter.traceBuffer.push({ type: 'call', address: 0x1004n, target: 0x2000n, text: 'bl 0x2000' });
  adapter.traceBuffer.push({ type: 'call', address: 0x1006n, target: 0x2002n, text: 'bl 0x2002' });
  adapter.traceBuffer.push({ type: 'branch', address: 0x1008n, target: 0x1010n, taken: true });
  adapter.traceBuffer.push({ type: 'instruction', address: 0x100cn, text: 'nop' });
  return adapter;
}

test('5842: subtype limit rides through the multiplexed args carrier', async () => {
  const result = await mixedAdapter().traceCall({ limit: 1 });
  assert.equal(result.events.length, 1, 'traceCall({limit:1}) must return exactly one call event');
  assert.equal(result.events[0].address, 0x1006n, 'the newest call event is kept');
});

test('5842: newer heterogeneous events never displace the subtype limit target', async () => {
  const adapter = mixedAdapter();
  const viaSubtype = await adapter.traceCall({ limit: 1 });
  const viaDirect = await adapter.trace({ capability: 'traceCall', limit: 1 });
  assert.deepEqual(viaDirect.events, viaSubtype.events, 'direct discriminator form agrees with the subtype form');
  assert.equal(viaDirect.events.length, 1);
  assert.equal(viaDirect.events[0].type, 'call');
  assert.equal(viaDirect.events[0].address, 0x1006n, 'the newest call is kept even though newer non-call events exist');
});

test('5842: subtype limit cut applies to the filtered class, not the raw ring', async () => {
  const result = await mixedAdapter().trace({ capability: 'traceCall', limit: 2 });
  assert.deepEqual(result.events.map((e) => e.address), [0x1004n, 0x1006n]);
});

test('5842: subtype limit zero returns an empty event list', async () => {
  const result = await mixedAdapter().traceCall({ limit: 0 });
  assert.deepEqual(result.events, []);
});

test('5842: subtype limit is strictly validated and fails closed', async () => {
  const adapter = mixedAdapter();
  await assert.rejects(adapter.traceCall({ limit: '1' }),
    (error) => error instanceof DebugAdapterError && error.code === 'invalid-number');
  await assert.rejects(adapter.traceCall({ limit: 1.5 }),
    (error) => error instanceof DebugAdapterError && error.code === 'invalid-number');
  await assert.rejects(adapter.trace({ capability: 'traceCall', args: { limit: 1 } }),
    (error) => error instanceof DebugAdapterError && error.code === 'invalid-request');
});

test('5842: generic trace limit semantics are unchanged', async () => {
  const adapter = mixedAdapter();
  const limited = await adapter.trace({ limit: 2 });
  assert.deepEqual(limited.events.map((e) => e.type), ['branch', 'instruction'], 'generic limit still cuts the raw ring tail before any filtering');
  const full = await adapter.trace();
  assert.deepEqual(full.events.map((e) => e.type), ['call', 'call', 'branch', 'instruction']);
});
