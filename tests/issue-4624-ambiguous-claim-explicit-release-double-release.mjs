import assert from 'node:assert/strict';
import { DevSupervisorEngineV0 } from '../js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
import { DevSupervisorV0 } from '../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DEV_RUN_STATUS } from '../js/ai/dev/run/dev-run.js';

await ambiguousClaimThenExplicitReleaseSuccessDoesNotDoubleRelease();
await ambiguousClaimThenExplicitReleaseFailureKeepsObligation();
await normalClaimSuccessReleasesExactlyOnce();
await abandonedAmbiguousClaimStillSettles();
await ambiguousCleanupAbsorbsNoLease();
await ambiguousCleanupAbsorbsWorkerNotClaimed();
console.log('Dev Supervisor #4624 ambiguous-claim explicit release ownership settle: ok');

async function ambiguousClaimThenExplicitReleaseSuccessDoesNotDoubleRelease() {
  const calls = [];
  const harness = createHarness({
    client: workerClient({
      claim: async () => {
        calls.push('claim');
        throw withCode(new Error('claim transport failed after lease'), 'transport-failure');
      },
      release: async () => { calls.push('release'); return { released: true }; },
    }),
    decisions: [
      { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim a worker' },
      { type: 'tool', tool: 'worker.release', arguments: {}, purpose: 'release the ambiguous slot' },
      { type: 'final', answer: 'settled by explicit release', completedTasks: ['release'], remaining: [] },
    ],
  });

  const result = await harness.engine.run({ goal: 'explicit release after ambiguous claim', conversationId: 'conversation-4624-success' });
  assert.equal(result.answer, 'settled by explicit release');
  assert.deepEqual(
    calls,
    ['claim', 'release'],
    'a successful explicit release must clear the ambiguous-claim obligation so the run never releases a second time',
  );
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.COMPLETED);
}

async function ambiguousClaimThenExplicitReleaseFailureKeepsObligation() {
  const calls = [];
  let releases = 0;
  const harness = createHarness({
    client: workerClient({
      claim: async () => {
        calls.push('claim');
        throw withCode(new Error('claim transport failed after lease'), 'transport-failure');
      },
      release: async () => {
        releases += 1;
        calls.push('release');
        if (releases === 1) throw withCode(new Error('release transport failed'), 'transport-failure');
        return { released: true };
      },
    }),
    decisions: [
      { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim a worker' },
      { type: 'tool', tool: 'worker.release', arguments: {}, purpose: 'try to release the ambiguous slot' },
      { type: 'final', answer: 'release retried after failure', completedTasks: ['release'], remaining: [] },
    ],
  });

  const result = await harness.engine.run({ goal: 'failed explicit release after ambiguous claim', conversationId: 'conversation-4624-failure' });
  assert.equal(result.answer, 'release retried after failure');
  assert.deepEqual(
    calls,
    ['claim', 'release', 'release'],
    'a failed explicit release must keep the cleanup obligation so the run still settles it',
  );
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.COMPLETED);
}

async function normalClaimSuccessReleasesExactlyOnce() {
  const calls = [];
  const harness = createHarness({
    client: workerClient({
      claim: async (args) => { calls.push('claim'); return { workerId: args.workerId, claimed: true }; },
      release: async () => { calls.push('release'); return { released: true }; },
    }),
    decisions: [
      { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim a worker' },
      { type: 'final', answer: 'done', completedTasks: ['claim'], remaining: [] },
    ],
  });

  const result = await harness.engine.run({ goal: 'normal claim', conversationId: 'conversation-4624-normal' });
  assert.equal(result.answer, 'done');
  assert.deepEqual(calls, ['claim', 'release'], 'a confirmed claim must be released exactly once at exit');
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.COMPLETED);
}

async function abandonedAmbiguousClaimStillSettles() {
  const calls = [];
  const harness = createHarness({
    client: workerClient({
      claim: async () => {
        calls.push('claim');
        throw withCode(new Error('claim transport failed after lease'), 'transport-failure');
      },
      release: async () => { calls.push('release'); return { released: true }; },
    }),
    decisions: [
      { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim a worker' },
      { type: 'final', answer: 'gave up', completedTasks: [], remaining: ['worker delegation'] },
    ],
  });

  const result = await harness.engine.run({ goal: 'abandon ambiguous claim', conversationId: 'conversation-4624-abandon' });
  assert.equal(result.answer, 'gave up');
  assert.deepEqual(calls, ['claim', 'release'], 'an abandoned ambiguous claim must still be settled once');
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.PAUSED);
}

async function ambiguousCleanupAbsorbsNoLease() {
  const calls = [];
  const harness = createHarness({
    client: workerClient({
      claim: async () => {
        calls.push('claim');
        throw withCode(new Error('claim transport failed after lease'), 'transport-failure');
      },
      release: async () => {
        calls.push('release');
        throw withCode(new Error('no lease is held'), 'no-lease');
      },
    }),
    decisions: [
      { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim a worker' },
      { type: 'final', answer: 'no lease existed', completedTasks: ['analysis'], remaining: [] },
    ],
  });

  const result = await harness.engine.run({ goal: 'ambiguous cleanup no-lease', conversationId: 'conversation-4624-nolease' });
  assert.equal(result.answer, 'no lease existed');
  assert.deepEqual(calls, ['claim', 'release'], 'a definitive no-lease cleanup proves no ownership was held');
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.COMPLETED, 'no-lease must be absorbed, not fail the run');
}

async function ambiguousCleanupAbsorbsWorkerNotClaimed() {
  const calls = [];
  const harness = createHarness({
    client: workerClient({
      claim: async () => {
        calls.push('claim');
        throw withCode(new Error('claim transport failed after lease'), 'transport-failure');
      },
      release: async () => {
        calls.push('release');
        throw withCode(new Error('worker is not claimed'), 'worker-not-claimed');
      },
    }),
    decisions: [
      { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim a worker' },
      { type: 'final', answer: 'worker was never claimed', completedTasks: ['analysis'], remaining: [] },
    ],
  });

  const result = await harness.engine.run({ goal: 'ambiguous cleanup worker-not-claimed', conversationId: 'conversation-4624-notclaimed' });
  assert.equal(result.answer, 'worker was never claimed');
  assert.deepEqual(calls, ['claim', 'release'], 'a definitive worker-not-claimed cleanup proves no ownership was held');
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.COMPLETED, 'worker-not-claimed must be absorbed, not fail the run');
}

function createHarness({ client, decisions }) {
  let sequence = 0;
  const supervisor = new DevSupervisorV0({
    workerClient: client,
    idFactory: (kind) => `${kind}-${++sequence}`,
    now: () => '2026-09-12T00:00:00.000Z',
  });
  const settings = {
    decisionPolicy: 'normal',
    analysisScope: undefined,
    lastRun: null,
    setLastRun(run) { this.lastRun = run; },
  };
  let index = 0;
  const bridge = {
    async request() {
      const decision = decisions[Math.min(index, decisions.length - 1)];
      index += 1;
      return JSON.stringify(decision);
    },
  };
  const engine = new DevSupervisorEngineV0({ supervisor, settings, bridge });
  return { engine, settings };
}

function workerClient(overrides) {
  const unused = async () => { throw new Error('unexpected Dev Worker call in this regression.'); };
  return {
    enabled: true,
    discover: unused, claim: unused, createChat: unused, send: unused, observe: unused,
    followup: unused, nudge: unused, stop: unused, result: unused, release: unused, waitEvent: unused,
    ...overrides,
  };
}

function withCode(error, code) { error.code = code; return error; }
