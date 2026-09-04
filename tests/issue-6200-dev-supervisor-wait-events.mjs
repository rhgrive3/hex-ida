import assert from 'node:assert/strict';
import test from 'node:test';

import { validateDevSupervisorDecision, parseDevSupervisorDecision } from '../js/ai/dev/protocol/hex-dev-supervisor-v1.js';
import { DEV_EVENT_TYPES } from '../js/ai/dev/events/dev-events.js';

test('1. valid single wait event worker.completed is accepted', () => {
  const decision = validateDevSupervisorDecision({
    type: 'wait',
    events: ['worker.completed'],
    reason: 'waiting for completion',
  });
  assert.equal(decision.type, 'wait');
  assert.deepEqual(decision.events, ['worker.completed']);
  assert.equal(decision.reason, 'waiting for completion');
});

test('2. multiple valid wait events worker.failed and worker.cancelled are accepted', () => {
  const decision = validateDevSupervisorDecision({
    type: 'wait',
    events: ['worker.failed', 'worker.cancelled'],
    reason: 'waiting for terminal event',
  });
  assert.deepEqual(decision.events, ['worker.failed', 'worker.cancelled']);
});

test('3. unknown wait event worker.teleported is rejected', () => {
  assert.throws(
    () => validateDevSupervisorDecision({
      type: 'wait',
      events: ['worker.teleported'],
      reason: 'waiting for teleporter',
    }),
    /wait\.events contains an unsupported Dev event\./,
  );
});

test('4. mixed known and unknown wait events are rejected', () => {
  assert.throws(
    () => validateDevSupervisorDecision({
      type: 'wait',
      events: ['worker.completed', 'worker.teleported'],
      reason: 'mixed events',
    }),
    /wait\.events contains an unsupported Dev event\./,
  );
});

test('5. blank or empty strings in wait.events are rejected', () => {
  assert.throws(
    () => validateDevSupervisorDecision({
      type: 'wait',
      events: ['   '],
      reason: 'blank event',
    }),
    /wait\.events must be an array of non-empty strings\./,
  );
  assert.throws(
    () => validateDevSupervisorDecision({
      type: 'wait',
      events: [''],
      reason: 'empty event',
    }),
    /wait\.events must be an array of non-empty strings\./,
  );
});

test('6. empty array in wait.events is accepted', () => {
  const decision = validateDevSupervisorDecision({
    type: 'wait',
    events: [],
    reason: 'nothing to do',
  });
  assert.deepEqual(decision.events, []);
});

test('7. parseDevSupervisorDecision parses valid JSON and rejects unsupported wait events', () => {
  const validJson = JSON.stringify({
    type: 'wait',
    events: ['human.responded'],
    reason: 'waiting for human input',
  });
  const parsed = parseDevSupervisorDecision(validJson);
  assert.equal(parsed.type, 'wait');
  assert.deepEqual(parsed.events, ['human.responded']);

  const invalidJson = JSON.stringify({
    type: 'wait',
    events: ['custom.magic.event'],
    reason: 'magic',
  });
  assert.throws(
    () => parseDevSupervisorDecision(invalidJson),
    /wait\.events contains an unsupported Dev event\./,
  );
});

test('8. all DEV_EVENT_TYPES are accepted individually', () => {
  for (const event of DEV_EVENT_TYPES) {
    const decision = validateDevSupervisorDecision({
      type: 'wait',
      events: [event],
      reason: `waiting for ${event}`,
    });
    assert.deepEqual(decision.events, [event]);
  }
});
