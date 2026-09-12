import assert from 'node:assert/strict';
import { DevSupervisorEngineV0 } from '../js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
import { DevSupervisorV0 } from '../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DEV_RUN_STATUS } from '../js/ai/dev/run/dev-run.js';

await testExplicitReleaseSuccessClearsAmbiguousClaimObligation();
await testSecondCleanupReleaseFailureFailsRunOnUnfixedEngine();
await testExplicitReleaseFailureKeepsCleanupObligation();
await testExplicitReleaseAfterConfirmedClaimDoesNotAddCleanupRelease();
await testNormalClaimFinalReleasesExactlyOnce();
await testAmbiguousClaimFinalStillAttemptsCleanupRelease();
await testAmbiguousCleanupAbsorbsNoLeaseCodes();
console.log('issue #4624 explicit release settles claim obligation: ok');

async function testExplicitReleaseSuccessClearsAmbiguousClaimObligation() {
  const calls = [];
  const harness = createHarness({
    client: workerClient({
      claim: async () => {
        calls.push('claim');
        throw Object.assign(new Error('Dev Worker RPC timed out: dev.worker.claim'), { code: 'transport-failure' });
      },
      release: async () => { calls.push('release'); return { released: true }; },
    }),
    decisions: [
      { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim a worker' },
      { type: 'tool', tool: 'worker.release', arguments: {}, purpose: 'explicitly release after the ambiguous claim' },
      { type: 'final', answer: 'ownership settled by the explicit release', completedTasks: ['release'], remaining: [] },
    ],
  });

  const result = await harness.engine.run({ goal: 'explicit release after ambiguous claim', conversationId: 'conversation-4624-explicit' });
  assert.equal(result.answer, 'ownership settled by the explicit release');
  assert.deepEqual(calls, ['claim', 'release'], 'a successful explicit release must satisfy the cleanup obligation with no second release');
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.COMPLETED);
}

async function testSecondCleanupReleaseFailureFailsRunOnUnfixedEngine() {
  const calls = [];
  const harness = createHarness({
    client: workerClient({
      claim: async () => {
        calls.push('claim');
        throw Object.assign(new Error('Dev Worker RPC timed out: dev.worker.claim'), { code: 'transport-failure' });
      },
      release: async () => {
        calls.push('release');
        if (calls.filter((call) => call === 'release').length > 1) {
          throw Object.assign(new Error('release transport failed'), { code: 'transport-failure' });
        }
        return { released: true };
      },
    }),
    decisions: [
      { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim a worker' },
      { type: 'tool', tool: 'worker.release', arguments: {}, purpose: 'explicitly release after the ambiguous claim' },
      { type: 'final', answer: 'no second release may be attempted', completedTasks: ['release'], remaining: [] },
    ],
  });

  const result = await harness.engine.run({ goal: 'second release hazard', conversationId: 'conversation-4624-hazard' });
  assert.equal(result.answer, 'no second release may be attempted');
  assert.deepEqual(calls, ['claim', 'release'], 'the authoritative explicit release must remove the redundant cleanup release entirely');
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.COMPLETED);
}

async function testExplicitReleaseFailureKeepsCleanupObligation() {
  const calls = [];
  let releases = 0;
  const harness = createHarness({
    client: workerClient({
      claim: async () => {
        calls.push('claim');
        throw Object.assign(new Error('Dev Worker RPC timed out: dev.worker.claim'), { code: 'transport-failure' });
      },
      release: async () => {
        calls.push('release');
        releases += 1;
        if (releases === 1) throw Object.assign(new Error('explicit release transport failed'), { code: 'transport-failure' });
        return { released: true };
      },
    }),
    decisions: [
      { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim a worker' },
      { type: 'tool', tool: 'worker.release', arguments: {}, purpose: 'explicitly release after the ambiguous claim' },
      { type: 'final', answer: 'cleanup retried after the failed explicit release', completedTasks: ['release'], remaining: [] },
    ],
  });

  const result = await harness.engine.run({ goal: 'failed explicit release keeps obligation', conversationId: 'conversation-4624-failed' });
  assert.equal(result.answer, 'cleanup retried after the failed explicit release');
  assert.deepEqual(calls, ['claim', 'release', 'release'], 'a failed explicit release must keep the cleanup obligation for run exit');
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.COMPLETED);
}

async function testExplicitReleaseAfterConfirmedClaimDoesNotAddCleanupRelease() {
  const calls = [];
  const harness = createHarness({
    client: workerClient({
      claim: async (args) => { calls.push('claim'); return { workerId: args.workerId, claimed: true }; },
      release: async () => { calls.push('release'); return { released: true }; },
    }),
    decisions: [
      { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim a worker' },
      { type: 'tool', tool: 'worker.release', arguments: {}, purpose: 'explicitly release the worker' },
      { type: 'final', answer: 'released once', completedTasks: ['release'], remaining: [] },
    ],
  });

  const result = await harness.engine.run({ goal: 'confirmed claim then explicit release', conversationId: 'conversation-4624-confirmed' });
  assert.equal(result.answer, 'released once');
  assert.deepEqual(calls, ['claim', 'release'], 'an explicit release after a confirmed claim must remain a single release');
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.COMPLETED);
}

async function testNormalClaimFinalReleasesExactlyOnce() {
  const calls = [];
  const harness = createHarness({
    client: workerClient({
      claim: async (args) => { calls.push('claim'); return { workerId: args.workerId, claimed: true }; },
      release: async () => { calls.push('release'); return { released: true }; },
    }),
    decisions: [
      { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim a worker' },
      { type: 'final', answer: 'done holding the worker until exit', completedTasks: ['work'], remaining: [] },
    ],
  });

  const result = await harness.engine.run({ goal: 'confirmed claim cleanup at final', conversationId: 'conversation-4624-final' });
  assert.equal(result.answer, 'done holding the worker until exit');
  assert.deepEqual(calls, ['claim', 'release'], 'a confirmed claim must be released exactly once at run exit');
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.COMPLETED);
}

async function testAmbiguousClaimFinalStillAttemptsCleanupRelease() {
  const calls = [];
  const harness = createHarness({
    client: workerClient({
      claim: async () => {
        calls.push('claim');
        throw Object.assign(new Error('Dev Worker RPC timed out: dev.worker.claim'), { code: 'transport-failure' });
      },
      release: async () => { calls.push('release'); return { released: true }; },
    }),
    decisions: [
      { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim a worker' },
      { type: 'final', answer: 'gave up on the Worker', completedTasks: [], remaining: ['worker delegation'] },
    ],
  });

  const result = await harness.engine.run({ goal: 'abandoned ambiguous claim', conversationId: 'conversation-4624-abandon' });
  assert.equal(result.answer, 'gave up on the Worker');
  assert.deepEqual(calls, ['claim', 'release'], 'an ambiguous claim abandoned at final must still attempt the cleanup release');
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.PAUSED);
}

async function testAmbiguousCleanupAbsorbsNoLeaseCodes() {
  for (const code of ['no-lease', 'worker-not-claimed']) {
    const calls = [];
    const harness = createHarness({
      client: workerClient({
        claim: async () => {
          calls.push('claim');
          throw Object.assign(new Error('Dev Worker RPC timed out: dev.worker.claim'), { code: 'transport-failure' });
        },
        release: async () => {
          calls.push('release');
          throw Object.assign(new Error(`absorbed ${code}`), { code });
        },
      }),
      decisions: [
        { type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim a worker' },
        { type: 'final', answer: `absorbed ${code}`, completedTasks: ['analysis'], remaining: [] },
      ],
    });

    const result = await harness.engine.run({ goal: `ambiguous cleanup absorbs ${code}`, conversationId: `conversation-4624-absorb-${code}` });
    assert.equal(result.answer, `absorbed ${code}`);
    assert.deepEqual(calls, ['claim', 'release'], `cleanup release must still be attempted for ${code}`);
    assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.COMPLETED, `${code} must stay absorbed at run exit`);
  }
}

function createHarness({ client, decisions }) {
  let sequence = 0;
  const supervisor = new DevSupervisorV0({
    workerClient: client,
    idFactory: (kind) => `${kind}-${++sequence}`,
    now: () => '2026-08-18T00:00:00.000Z',
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
