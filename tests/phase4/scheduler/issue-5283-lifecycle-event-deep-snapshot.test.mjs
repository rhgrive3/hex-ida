import assert from 'node:assert/strict';
import { createSchedulerEventBuffer } from '../../../js/core/scheduler/lifecycle-events.js';

// #5283: buffered lifecycle events are historical snapshots. Nested details
// must neither retain producer aliases nor expose mutable internal state.
{
  const buffer = createSchedulerEventBuffer({ capacity: 4 });
  const diagnostic = { reason: 'before', nested: { code: 7n } };
  const ids = ['a'];
  const details = { diagnostic, ids };

  buffer.onEvent({ seq: 1, type: 'job.failed', artifactId: 'art-a', details });

  diagnostic.reason = 'after';
  diagnostic.nested.code = 9n;
  ids.push('b');

  const snapshot = buffer.snapshot();
  assert.equal(snapshot[0].details.diagnostic.reason, 'before');
  assert.equal(snapshot[0].details.diagnostic.nested.code, 7n);
  assert.deepEqual(snapshot[0].details.ids, ['a']);
  assert.ok(Object.isFrozen(snapshot[0].details.diagnostic));
  assert.ok(Object.isFrozen(snapshot[0].details.diagnostic.nested));
  assert.ok(Object.isFrozen(snapshot[0].details.ids));
  assert.throws(() => { snapshot[0].details.diagnostic.reason = 'mutated-through-snapshot'; }, TypeError);
  assert.throws(() => { snapshot[0].details.ids.push('snapshot-mutation'); }, TypeError);
  assert.equal(buffer.snapshot()[0].details.diagnostic.reason, 'before');
  assert.deepEqual(buffer.snapshot()[0].details.ids, ['a']);
}

// A top-level frozen details object is not evidence that its children are
// immutable. The buffer still needs an owned deep snapshot.
{
  const buffer = createSchedulerEventBuffer();
  const child = { reason: 'frozen-parent-before' };
  const details = Object.freeze({ child });

  buffer.onEvent({ seq: 2, type: 'job.failed', artifactId: 'art-b', details });
  child.reason = 'frozen-parent-after';

  const saved = buffer.snapshot()[0];
  assert.notEqual(saved.details, details, 'buffer must own its details snapshot');
  assert.notEqual(saved.details.child, child, 'nested producer aliases must be detached');
  assert.equal(saved.details.child.reason, 'frozen-parent-before');
  assert.ok(Object.isFrozen(saved.details.child));
}

// Existing ring-buffer ordering/capacity/drop semantics stay intact while
// details are snapshotted.
{
  const buffer = createSchedulerEventBuffer({ capacity: 2 });
  buffer.onEvent({ seq: 1, type: 'test', details: { seq: { value: 1 } } });
  buffer.onEvent({ seq: 2, type: 'test', details: { seq: { value: 2 } } });
  buffer.onEvent({ seq: 3, type: 'test', details: { seq: { value: 3 } } });
  assert.equal(buffer.size, 2);
  assert.equal(buffer.dropped, 1);
  assert.deepEqual(buffer.snapshot().map((event) => event.seq), [2, 3]);
}

console.log('phase4 scheduler issue-5283 lifecycle event deep snapshot: PASS');
