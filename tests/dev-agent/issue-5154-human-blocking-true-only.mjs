import assert from 'node:assert/strict';
import {
  parseDevSupervisorDecision,
  validateDevSupervisorDecision,
} from '../../js/ai/dev/protocol/hex-dev-supervisor-v1.js';
import { devBootstrapContractText } from '../../js/ai/dev/protocol/dev-supervisor-prompt.js';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DevSupervisorEngineV0 } from '../../js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
import { DevAgentUiSettings } from '../../js/ai/dev/ui/settings.js';
import { AGENT_PROFILE } from '../../js/ai/dev/policy/agent-profile.js';
import { DEV_RUN_STATUS } from '../../js/ai/dev/run/dev-run.js';

// 1. blocking:true remains valid.
{
  const decision = validateDevSupervisorDecision({
    type: 'human',
    question: '確認してください',
    blocking: true,
  });
  assert.equal(decision.blocking, true);
}

// 2. blocking:false is rejected at the protocol boundary.
{
  assert.throws(
    () => validateDevSupervisorDecision({ type: 'human', question: 'q', blocking: false }),
    /human\.blocking must be true\./,
  );
  assert.throws(
    () => parseDevSupervisorDecision('{"type":"human","question":"q","blocking":false}'),
    /human\.blocking must be true\./,
  );
}

// 3. Non-boolean blocking values stay rejected.
{
  for (const blocking of ['true', 1, null, undefined]) {
    assert.throws(
      () => validateDevSupervisorDecision({ type: 'human', question: 'q', blocking }),
      TypeError,
    );
  }
}

// 4. An invalid (blocking:false) human decision routes into the engine's
//    decision-invalid recovery loop instead of being applied.
{
  let requestCount = 0;
  const supervisor = new DevSupervisorV0({ now: () => '2026-09-11T00:00:00.000Z' });
  const bridge = Object.freeze({
    async request() {
      requestCount += 1;
      if (requestCount === 1) {
        return { text: JSON.stringify({ type: 'human', question: '確認だけ', blocking: false }) };
      }
      return { text: JSON.stringify({ type: 'final', answer: 'done', completedTasks: [], remaining: [] }) };
    },
  });
  const storage = { getItem: () => null, setItem() {} };
  const settings = new DevAgentUiSettings({ storage });
  settings.setAgentProfile(AGENT_PROFILE.DEV);
  const engine = new DevSupervisorEngineV0({ supervisor, settings, bridge });
  const result = await engine.run({ goal: 'demo', conversationId: 'c-blocking' });
  assert.equal(result.answer, 'done');
  assert.equal(requestCount, 2, 'the invalid human decision must be recovered, not applied');
}

// 5. A valid human decision still transitions the run to WAITING_HUMAN.
{
  const supervisor = new DevSupervisorV0({ now: () => '2026-09-11T00:00:00.000Z' });
  const run = supervisor.createRun({ goal: 'demo', conversationId: 'c-human' });
  const applied = supervisor.applyDecision(run, validateDevSupervisorDecision({
    type: 'human',
    question: '確認してください',
    blocking: true,
  }));
  assert.equal(applied.run.status, DEV_RUN_STATUS.WAITING_HUMAN);
  assert.equal(applied.decision.blocking, true);
}

// 6. The published prompt contract and the validator's accepted domain agree.
{
  const contract = devBootstrapContractText({ availableTools: [] });
  assert.ok(contract.includes('"blocking":true'), 'prompt must publish the blocking:true shape');
  assert.ok(!contract.includes('"blocking":false'), 'prompt must not advertise blocking:false');
}

console.log('issue #5154 human blocking true-only regressions PASS');
