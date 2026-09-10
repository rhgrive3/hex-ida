// Regression for #5680: RuntimeEventNormalizer.flush() must not try to
// upgrade its weakest queued evidence. A normally accepted 'truncated' event
// (e.g. kind 'gap') made every flush throw runtime-completeness-upgrade
// because the batch unconditionally requested 'partial'.
import assert from 'node:assert/strict';
import { RuntimeEventNormalizer, createRuntimeEventBatch } from '../../../js/runtime/events.js';

function makeNormalizer() {
  return new RuntimeEventNormalizer({
    runtimeSessionId: 'session-5680',
    providerId: 'provider-5680',
    sessionEpoch: 1,
  });
}

// A queued gap event rides out of flush as 'truncated' instead of throwing.
{
  const normalizer = makeNormalizer();
  const pushed = normalizer.push({
    runtimeSessionId: 'session-5680',
    providerId: 'provider-5680',
    sessionEpoch: 1,
    kind: 'gap',
  });
  assert.equal(pushed.completeness, 'truncated', 'gap event is accepted as truncated evidence');
  const batch = normalizer.flush();
  assert.equal(batch.completeness, 'truncated', 'flush must cap the batch at the weakest queued event');
  assert.equal(batch.events.length, 1);
}

// An unsupported queued event caps the batch at 'unsupported'.
{
  const normalizer = makeNormalizer();
  const pushed = normalizer.push({
    runtimeSessionId: 'session-5680',
    providerId: 'provider-5680',
    sessionEpoch: 1,
    kind: 'provider-error',
    completeness: 'unsupported',
  });
  assert.ok(pushed, 'unsupported completeness is accepted at push time');
  const batch = normalizer.flush();
  assert.equal(batch.completeness, 'unsupported', 'flush must not upgrade unsupported evidence to partial');
}

// dropped > 0 keeps the truncated batch marker semantics.
{
  const normalizer = makeNormalizer();
  normalizer.push({ kind: 'paused' });
  const batch = normalizer.flush(); // no loss: 'partial'
  assert.equal(batch.completeness, 'partial', 'loss-free batches stay partial');
}

// Loss still produces the truncated marker batch.
{
  const normalizer = makeNormalizer();
  normalizer.push({ kind: 'paused' });
  // Simulate a normalizer drop through the public budget surface.
  const tight = new RuntimeEventNormalizer(
    { runtimeSessionId: 'session-5680', providerId: 'provider-5680', sessionEpoch: 1 },
    { maxEvents: 1, maxDedupeEntries: 16 },
  );
  tight.push({ kind: 'paused' });
  const second = tight.push({ kind: 'resumed' });
  const lossy = tight.flush();
  assert.equal(lossy.completeness, 'truncated', 'dropped events keep the truncated batch');
  assert.ok(lossy.dropped >= 1 || second == null, 'the tight budget records the loss');
}

// Empty flush stays bounded; the createRuntimeEventBatch upgrade guard stays
// authoritative for direct callers.
{
  const empty = makeNormalizer().flush();
  assert.equal(empty.completeness, 'bounded', 'empty flush remains bounded');
  assert.throws(
    () => createRuntimeEventBatch({
      runtimeSessionId: 'session-5680',
      providerId: 'provider-5680',
      sessionEpoch: 1,
      events: [{ runtimeSessionId: 'session-5680', providerId: 'provider-5680', sessionEpoch: 1, kind: 'gap' }],
      completeness: 'partial',
    }),
    (error) => error.code === 'runtime-completeness-upgrade',
    'the direct-caller upgrade guard must remain fail-closed',
  );
}

console.log('issue #5680 event normalizer flush completeness regression: PASS');
