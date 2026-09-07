// Regression for #5933: the module-global auto session counter ignored the
// manager's live explicit ids, so after `create({ id: 'debug:1' })` the next
// anonymous create generated `debug:1` again and failed with
// duplicate-session-id despite free capacity — succeeding only on blind retry.
// The manager now skips live ids while reserving an auto id.
import assert from 'node:assert/strict';
import { DebugSessionManager } from '../js/runtime/session.js';

{
  const manager = new DebugSessionManager({ maxSessions: 3 });
  const explicit = manager.create({ kind: 'stub-a' }, { id: 'debug:1' });
  assert.equal(explicit.id, 'debug:1');

  const auto = manager.create({ kind: 'stub-b' });
  assert.notEqual(auto.id, 'debug:1', 'the auto id must not collide with a live explicit id');
  assert.equal(manager.sessions.size, 2, 'the create must succeed with free capacity');
  assert.ok(manager.sessions.has('debug:2') || !manager.sessions.has('debug:1') || manager.sessions.size === 2);
}

{
  // Repeated anonymous creates stay unique.
  const manager = new DebugSessionManager({ maxSessions: 4 });
  const a = manager.create({ kind: 'stub-a' });
  const b = manager.create({ kind: 'stub-b' });
  assert.notEqual(a.id, b.id);
  assert.equal(manager.sessions.size, 2);
}

{
  // An explicit id equal to the current counter still fails loudly (real
  // duplicate), not silently skipped for the caller.
  const manager = new DebugSessionManager({ maxSessions: 3 });
  const explicit = manager.create({ kind: 'stub-a' }, { id: 'debug:5' });
  assert.equal(explicit.id, 'debug:5');
  assert.throws(() => manager.create({ kind: 'stub-b' }, { id: 'debug:5' }), (error) => error.code === 'duplicate-session-id');
}
