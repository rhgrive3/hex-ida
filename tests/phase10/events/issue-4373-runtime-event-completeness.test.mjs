import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeEventNormalizer, createRuntimeEventBatch } from '../../../js/runtime/events.js';

const base = {
  runtimeSessionId: 'runtime-4373',
  providerId: 'provider-4373',
  providerVersion: '1',
  sessionEpoch: 1,
};

function event(completeness, kind = 'provider-warning') {
  return { ...base, kind, payload: {}, completeness };
}

test('#4373 derives omitted batch completeness from non-empty source events', () => {
  for (const completeness of ['unsupported', 'truncated', 'partial', 'bounded']) {
    const batch = createRuntimeEventBatch({ ...base, events: [event(completeness)] });
    assert.equal(batch.completeness, completeness);
  }
});

test('#4373 an explicit completeness upgrade remains rejected', () => {
  assert.throws(() => createRuntimeEventBatch({
    ...base,
    completeness: 'complete',
    events: [event('unsupported')],
}), /cannot upgrade/i);
});

test('#4373 normalizer flush does not upgrade an unsupported source event', () => {
  const normalizer = new RuntimeEventNormalizer(base);
  assert.ok(normalizer.push(event('unsupported')));
  assert.equal(normalizer.flush().completeness, 'unsupported');
});

test('#4373 loss markers remain truncated and empty batches keep their defaults', () => {
  for (const lossEvent of [
    event('truncated', 'gap'),
    event('truncated', 'dropped-events'),
  ]) {
    const batch = createRuntimeEventBatch({ ...base, events: [lossEvent] });
    assert.equal(batch.completeness, 'truncated');
  }

  assert.equal(createRuntimeEventBatch({ ...base, events: [] }).completeness, 'partial');
  assert.equal(createRuntimeEventBatch({ ...base, events: [], dropped: 1 }).completeness, 'truncated');
});
