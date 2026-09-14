/*
 * #8810 — Worker run/worker/lease identity must stay a canonical primitive.
 *
 * runId / workerId / leaseId are ownership authority. A structured-cloneable
 * alias such as ['run-A'] or a caller-controlled toString() must never be
 * authenticated as the same principal as the primitive owner.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DedicatedWorkerCoordinator } from '../js/userscript/dev/frame-mesh/dedicated-worker-coordinator.js';
import { IframeWorkerCompletionBridge } from '../js/userscript/dev/frame-mesh/iframe-worker-completion-bridge.js';
import { IframeWorkerPool } from '../js/userscript/dev/frame-mesh/iframe-worker-pool.js';
import { canonicalWorkerIdentity } from '../js/userscript/dev/frame-mesh/worker-identity.js';
import { SingleConversationWorkerCoordinator } from '../js/userscript/dev/single-tab/single-conversation-worker-coordinator.js';

function dedicatedCoordinator() {
  return new DedicatedWorkerCoordinator({
    tabNodeId: 'tab-1',
    controller: {
      on() { return () => {}; },
      observe() { return { state: 'idle' }; },
      result() { return { status: 'idle' }; },
      workerConversation() { return null; },
      isActive() { return false; },
    },
  });
}

function singleTabCoordinator() {
  return new SingleConversationWorkerCoordinator({
    tabNodeId: 'tab-1',
    controller: {
      on() { return () => {}; },
      currentConversation() { return null; },
      observe() { return { state: 'idle' }; },
      result() { return { status: 'idle' }; },
    },
  });
}

function completionBridge() {
  const pool = { start() {}, followup() {}, requireLease() { throw new Error('unused'); } };
  const coordinator = { enqueue() {}, waitEvent() { return Promise.resolve(null); } };
  return new IframeWorkerCompletionBridge({ workerPool: pool, coordinator });
}

function leaseTable() {
  const slot = { index: 1, leaseId: 'lease-X', runId: 'run-A', workerId: 'worker-A' };
  return {
    leases: new Map([['lease-X', 1]]),
    slots: new Map([[1, slot]]),
  };
}

const REJECTED_IDENTITIES = [
  ['a one-element Array', ['run-A']],
  ['a nested Array', [['run-A']]],
  ['an Object', { toString() { return 'run-A'; } }],
  ['a String wrapper', new String('run-A')],
  ['a number', 8810],
  ['a boolean', true],
  ['whitespace only', '   '],
  ['an empty string', ''],
];

test('canonical identity accepts only primitive non-empty strings', () => {
  assert.equal(canonicalWorkerIdentity('run-A', 'runId'), 'run-A');
  assert.equal(canonicalWorkerIdentity(' run-A ', 'runId'), 'run-A');
  for (const [label, value] of REJECTED_IDENTITIES) {
    assert.throws(
      () => canonicalWorkerIdentity(value, 'runId'),
      (error) => error instanceof TypeError && !/undefined/.test(error.message),
      `${label} must not be a canonical identity`,
    );
  }
});

test('identity validation never executes a caller-controlled toString()', () => {
  let hookCalls = 0;
  const spoof = { toString() { hookCalls++; return 'run-A'; } };
  assert.throws(() => canonicalWorkerIdentity(spoof, 'runId'), TypeError);
  assert.equal(hookCalls, 0, 'validation must not invoke caller formatting');
});

test('the dedicated coordinator claims and observes with primitive identity', async () => {
  const coordinator = dedicatedCoordinator();
  const claimed = await coordinator.claim({ runId: 'run-A', workerId: 'worker-A' });
  assert.equal(claimed.runId, 'run-A');
  assert.equal((await coordinator.observe({ runId: 'run-A', workerId: 'worker-A' })).state, 'idle');
});

test('the dedicated coordinator rejects structured claim and authorization identity', async () => {
  for (const [label, override] of REJECTED_IDENTITIES) {
    const coordinator = dedicatedCoordinator();
    await assert.rejects(
      coordinator.claim({ runId: override, workerId: 'worker-A' }),
      TypeError,
      `claim with ${label} runId must be rejected`,
    );
    await assert.rejects(
      coordinator.claim({ runId: 'run-A', workerId: override }),
      TypeError,
      `claim with ${label} workerId must be rejected`,
    );
  }

  const claimed = dedicatedCoordinator();
  await claimed.claim({ runId: 'run-A', workerId: 'worker-A' });
  for (const [label, override] of REJECTED_IDENTITIES) {
    await assert.rejects(
      claimed.observe({ runId: override, workerId: 'worker-A' }),
      (error) => error instanceof TypeError || error?.code === 'conversation-mismatch',
      `observe with ${label} runId must not authorize`,
    );
    await assert.rejects(
      claimed.observe({ runId: 'run-A', workerId: override }),
      (error) => error instanceof TypeError || error?.code === 'conversation-mismatch',
      `observe with ${label} workerId must not authorize`,
    );
  }
});

test('the single-tab coordinator applies the same identity matrix', async () => {
  const coordinator = singleTabCoordinator();
  for (const [label, override] of REJECTED_IDENTITIES) {
    await assert.rejects(
      coordinator.claim({ runId: override, workerId: 'worker-A' }),
      TypeError,
      `claim with ${label} runId must be rejected`,
    );
    await assert.rejects(
      coordinator.claim({ runId: 'run-A', workerId: override }),
      TypeError,
      `claim with ${label} workerId must be rejected`,
    );
  }
  coordinator.claimed = { runId: 'run-A', workerId: 'worker-A' };
  assert.deepEqual(coordinator.assertClaim({ runId: 'run-A', workerId: 'worker-A' }), {
    runId: 'run-A', workerId: 'worker-A',
  });
  assert.throws(
    () => coordinator.assertClaim({ runId: ['run-A'], workerId: 'worker-A' }),
    (error) => error instanceof TypeError || error?.code === 'worker-busy',
  );
});

test('the completion bridge rejects a structured run identity in ownership checks', () => {
  const bridge = completionBridge();
  bridge.runByLease.set('lease-X', 'run-A');
  assert.equal(bridge.assertRunOwnership('lease-X', 'run-A'), 'run-A');
  assert.throws(() => bridge.assertRunOwnership('lease-X', ['run-A']), TypeError);
  assert.throws(() => bridge.assertRunOwnership('lease-X', { toString() { return 'run-A'; } }), TypeError);
  assert.throws(() => bridge.assertRunOwnership(['lease-X'], 'run-A'), TypeError);
  assert.throws(() => bridge.takeRetainedCompletion({ events: ['worker.completed'], runId: ['run-A'] }), TypeError);
  assert.throws(() => bridge.publishGraphCompletion({ runId: ['run-A'], graphId: 'g-1', taskId: 't-1' }), TypeError);
});

test('the pool never collapses a structured lease token onto a real lease', () => {
  const table = leaseTable();
  const requireLease = IframeWorkerPool.prototype.requireLease.bind(table);
  assert.equal(requireLease('lease-X'), table.slots.get(1));
  for (const [label, value] of REJECTED_IDENTITIES) {
    assert.throws(
      () => requireLease(value),
      (error) => error?.code === 'lease-missing',
      `${label} must not resolve a lease`,
    );
  }
  assert.throws(() => requireLease(['lease-X']), (error) => error?.code === 'lease-missing');
});

test('the dedicated event run filter refuses non-canonical identity', async () => {
  const coordinator = dedicatedCoordinator();
  await coordinator.claim({ runId: 'run-A', workerId: 'worker-A' });
  coordinator.onEvent({ kind: 'completed', data: {}, observedAt: 'now' });
  const rejected = await coordinator.waitEvent({ events: ['worker.completed'], runId: ['run-A'] })
    .then(() => null, (error) => error);
  assert.ok(rejected instanceof TypeError, 'a structured run filter must not be accepted');
  assert.equal(coordinator.events.length, 1, 'the rejected filter must not consume the queued event');
  const matched = await coordinator.waitEvent({ events: ['worker.completed'], runId: 'run-A' });
  assert.equal(matched.type, 'worker.completed');
});

test('the dedicated coordinator refuses a non-canonical event run filter', async () => {
  const coordinator = dedicatedCoordinator();
  await coordinator.claim({ runId: 'run-A', workerId: 'worker-A' });
  coordinator.onEvent({ kind: 'completed', data: {}, observedAt: 'now' });
  const rejected = await coordinator.waitEvent({ events: ['worker.completed'], runId: ['run-A'] })
    .then(() => null, (error) => error);
  assert.ok(rejected instanceof TypeError, 'a structured run filter must not be accepted');
  assert.equal(coordinator.events.length, 1, 'the refused filter must not consume the queued event');
  assert.equal((await coordinator.waitEvent({ events: ['worker.completed'], runId: 'run-A' })).type, 'worker.completed');
});

test('the single-tab coordinator refuses a non-canonical event run filter', async () => {
  const coordinator = singleTabCoordinator();
  coordinator.claimed = { runId: 'run-A', workerId: 'worker-A' };
  coordinator.onControllerEvent({ kind: 'heartbeat', data: {}, observedAt: 'now' });
  const rejected = await coordinator.waitEvent({ events: ['worker.heartbeat'], runId: { toString() { return 'run-A'; } } })
    .then(() => null, (error) => error);
  assert.ok(rejected instanceof TypeError, 'a caller-formatted run filter must not be accepted');
  assert.equal(coordinator.events.length, 1, 'the refused filter must not consume the queued event');
  assert.equal((await coordinator.waitEvent({ events: ['worker.heartbeat'], runId: 'run-A' })).type, 'worker.heartbeat');
});

test('an Array identity surviving structured clone is still refused', async () => {
  const onTheWire = structuredClone({ runId: ['run-A'], workerId: ['worker-A'] });
  const claimed = dedicatedCoordinator();
  await claimed.claim({ runId: 'run-A', workerId: 'worker-A' });
  await assert.rejects(claimed.result(onTheWire), TypeError);
  await assert.rejects(claimed.release(onTheWire), TypeError);
});
