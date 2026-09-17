import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeEventNormalizer } from '../../../js/runtime/events.js';
import { RuntimeModuleBindingTable } from '../../../js/runtime/provider-identity.js';

const context = {
  runtimeSessionId: 'runtime-8858',
  providerId: 'provider-8858',
  providerVersion: '1',
  sessionEpoch: 1,
};

function event(streamId, sequence, kind = 'trace-marker', payload = {}) {
  return { ...context, streamId, sequence, kind, payload };
}

test('#8858 accepted ordered occurrences stay stale beyond the default dedupe horizon', () => {
  const normalizer = new RuntimeEventNormalizer(context, { maxEvents: 1, maxBytes: 1024 * 1024 });
  assert.ok(normalizer.push(event('control', 1, 'paused')));
  normalizer.flush();
  assert.ok(normalizer.push(event('control', 2, 'resumed')));
  normalizer.flush();

  for (let index = 0; index < 8192; index += 1) {
    assert.ok(normalizer.push(event('noise', 100 + index)));
    normalizer.flush();
  }

  assert.equal(normalizer.push(event('control', 1, 'paused')), null,
    'a committed old control occurrence must not become fresh after bounded-history rollover');
});

test('#8858 opaque state-changing provider IDs are not evicted by bounded best-effort history', () => {
  const normalizer = new RuntimeEventNormalizer(context, { maxEvents: 1, maxBytes: 1024 * 1024, maxDedupeEntries: 16 });
  assert.ok(normalizer.push({ ...context, providerEventId:'control:1', kind:'paused', payload:{} }));
  normalizer.flush();
  for (let index = 0; index < 32; index += 1) {
    assert.ok(normalizer.push({ ...context, providerEventId:`noise:${index}`, kind:'trace-marker', payload:{} }));
    normalizer.flush();
  }
  assert.equal(
    normalizer.push({ ...context, providerEventId:'control:1', kind:'paused', payload:{} }),
    null,
    'state-changing opaque identity remains replay-protected when non-state history rolls over',
  );
});

test('#8858 ordered streams retain a bounded out-of-order window without reopening stale history', () => {
  const normalizer = new RuntimeEventNormalizer(context, { maxEvents: 4, maxBytes: 1024 * 1024, maxDedupeEntries: 16 });
  assert.ok(normalizer.push(event('ordered', 10)));
  assert.ok(normalizer.push(event('ordered', 12)));
  assert.ok(normalizer.push(event('ordered', 11)), 'an unseen in-window reordered occurrence remains admissible');
  assert.equal(normalizer.push(event('ordered', 11)), null, 'the reordered occurrence remains deduplicated');
  normalizer.flush();

  assert.ok(normalizer.push(event('ordered', 100)));
  normalizer.flush();
  assert.equal(normalizer.push(event('ordered', 10)), null, 'history older than the reorder window fails closed');
});

test('#8858 flush cannot retract a committed state-changing event to make room for the loss marker', () => {
  const normalizer = new RuntimeEventNormalizer(context, { maxEvents: 1, maxBytes: 1024 * 1024, maxDedupeEntries: 16 });
  const load = event('modules', 1, 'module-load', { module: { id: 'M' } });
  const neverAccepted = event('trace', 1);
  assert.ok(normalizer.push(load));
  assert.equal(normalizer.push(neverAccepted), null);

  const batch = normalizer.flush();
  assert.deepEqual(batch.events.map((item) => item.kind), ['module-load']);
  assert.equal(batch.dropped, 1);
  assert.equal(batch.completeness, 'truncated');
  assert.equal(normalizer.push(load), null, 'accepted state authority remains replay-protected after flush');
  assert.ok(normalizer.push(neverAccepted), 'a capacity-dropped event that was never accepted remains retryable');
});

test('#8858 module lifecycle rejects an older/equal load after a newer unload but allows a genuine reload', () => {
  const modules = new RuntimeModuleBindingTable('runtime-session-8858');
  const binding = {
    bindingKey: 'M',
    runtimeBase: 0x1000n,
    runtimeSize: 0x100n,
    staticBase: 0x5000n,
    binaryId: 'bin-test',
    identityState: 'exact',
  };

  modules.load({ ...binding, loadedSequence: 1 });
  modules.unload('M', 2);
  assert.throws(
    () => modules.load({ ...binding, loadedSequence: 1 }),
    (error) => error?.code === 'invalid-module-sequence',
  );
  assert.throws(
    () => modules.load({ ...binding, loadedSequence: 2 }),
    (error) => error?.code === 'invalid-module-sequence',
  );
  const reloaded = modules.load({ ...binding, loadedSequence: 3 });
  assert.equal(reloaded.generation, 2);
  assert.equal(reloaded.loadedSequence, 3);
});

test('#8858 an unload tombstone also blocks a later stale first load', () => {
  const modules = new RuntimeModuleBindingTable('runtime-session-8858-tombstone');
  assert.equal(modules.unload('M', 5), null);
  assert.throws(
    () => modules.load({ bindingKey:'M', runtimeBase:0x1000n, runtimeSize:0x100n, loadedSequence:4 }),
    (error) => error?.code === 'invalid-module-sequence',
  );
  assert.equal(modules.load({ bindingKey:'M', runtimeBase:0x1000n, runtimeSize:0x100n, loadedSequence:6 }).loadedSequence, 6);
});
