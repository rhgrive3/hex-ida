import assert from 'node:assert/strict';
import { DevSupervisorEngineV0 } from '../../js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DevAgentUiSettings } from '../../js/ai/dev/ui/settings.js';
import { DEV_RUN_STATUS } from '../../js/ai/dev/run/dev-run.js';

await testAnsweringAAfterAnotherConversationRanResumesA();
await testWaitingHumanRunLeavesRegistryWhenResolved();
await testReconstructedEngineKeepsLastRunFallback();
console.log('issue #5162 per-conversation human resume: ok');

/* #5162: conversation A WAITING_HUMAN, then any run on conversation B
   overwrites the single settings.lastRun slot; A's human response must still
   find and resume A's waiting run instead of creating a new orphaning run. */
async function testAnsweringAAfterAnotherConversationRanResumesA() {
  const harness = createHarness([
    { type: 'human', question: 'A confirm', blocking: true },
    { type: 'final', answer: 'B done', completedTasks: ['B'], remaining: [] },
    { type: 'final', answer: 'A resumed', completedTasks: ['A'], remaining: [] },
  ]);

  await harness.engine.run({ mode: 'agent', question: 'start A', conversationId: 'hex-A' });
  const runA = harness.settings.lastRun;
  assert.equal(runA.status, DEV_RUN_STATUS.WAITING_HUMAN, 'run A must wait for a human');
  assert.equal(runA.hexConversationId, 'hex-A');

  await harness.engine.run({ mode: 'agent', question: 'start B', conversationId: 'hex-B' });
  const runB = harness.settings.lastRun;
  assert.equal(runB.status, DEV_RUN_STATUS.COMPLETED, 'run B must complete and overwrite lastRun');

  const resumable = harness.engine.resumableHumanRun({ conversationId: 'hex-A' });
  assert.equal(resumable?.runId, runA.runId, 'A\'s WAITING_HUMAN run must stay discoverable after B ran');

  await harness.engine.run({ mode: 'agent', question: 'A answer', conversationId: 'hex-A' });
  const after = harness.settings.lastRun;
  assert.equal(after.runId, runA.runId, 'the human response must resume run A, not create a new run');
  assert.equal(after.status, DEV_RUN_STATUS.COMPLETED, 'run A must complete with its answer');
}

/* Once a waiting run leaves WAITING_HUMAN it must not be revivable. */
async function testWaitingHumanRunLeavesRegistryWhenResolved() {
  const harness = createHarness([
    { type: 'human', question: 'A confirm', blocking: true },
    { type: 'final', answer: 'A answered', completedTasks: ['A'], remaining: [] },
    { type: 'final', answer: 'fresh A run', completedTasks: [], remaining: [] },
  ]);

  await harness.engine.run({ mode: 'agent', question: 'start A', conversationId: 'hex-A' });
  const runA = harness.settings.lastRun;
  assert.equal(runA.status, DEV_RUN_STATUS.WAITING_HUMAN);

  await harness.engine.run({ mode: 'agent', question: 'A answer', conversationId: 'hex-A' });
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.COMPLETED);

  assert.equal(
    harness.engine.resumableHumanRun({ conversationId: 'hex-A' }),
    null,
    'a resolved run must not stay resumable',
  );
  const next = await harness.engine.run({ mode: 'agent', question: 'new A turn', conversationId: 'hex-A' });
  assert.notEqual(harness.settings.lastRun.runId, runA.runId, 'a fresh turn starts a fresh run');
  assert.match(next.answer, /fresh A run|Dev Supervisor run/);
}

/* Engine reconstruction (fresh page load) keeps the settings.lastRun
   continuity contract. */
async function testReconstructedEngineKeepsLastRunFallback() {
  const harness = createHarness([
    { type: 'human', question: 'A confirm', blocking: true },
    { type: 'final', answer: 'A resumed after reload', completedTasks: ['A'], remaining: [] },
  ]);
  await harness.engine.run({ mode: 'agent', question: 'start A', conversationId: 'hex-A' });
  const runA = harness.settings.lastRun;

  const revived = new DevSupervisorEngineV0({
    supervisor: harness.engine.supervisor,
    settings: harness.settings,
    bridge: harness.bridge,
  });
  assert.equal(revived.resumableHumanRun({ conversationId: 'hex-A' })?.runId, runA.runId);
}

function createHarness(decisions) {
  let sequence = 0;
  const supervisor = new DevSupervisorV0({
    idFactory: (kind) => `${kind}-${++sequence}`,
    now: () => '2026-08-18T00:00:00.000Z',
  });
  const settings = new DevAgentUiSettings({ storage: null });
  settings.setAgentProfile('dev');
  settings.setDecisionPolicy('yolo');
  let index = 0;
  const bridge = {
    async request(_prompt, _options = {}) {
      return { text: JSON.stringify(decisions[Math.min(index++, decisions.length - 1)]) };
    },
  };
  const engine = new DevSupervisorEngineV0({ supervisor, settings, bridge });
  return { engine, supervisor, settings, bridge };
}
