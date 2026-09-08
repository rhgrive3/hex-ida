import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseDevSupervisorDecision,
  validateDevSupervisorDecision,
} from '../js/ai/dev/protocol/hex-dev-supervisor-v1.js';
import { DEV_EVENT_TYPES } from '../js/ai/dev/events/dev-events.js';
import { DevSupervisorEngineV0 } from '../js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
import { DevSupervisorV0 } from '../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DevAgentUiSettings } from '../js/ai/dev/ui/settings.js';
import { AGENT_PROFILE } from '../js/ai/dev/policy/agent-profile.js';

function waitDecision(events) {
  return { type: 'wait', events, reason: 'wait for worker' };
}

test('#6200 accepts only the declared Dev event vocabulary', () => {
  assert.deepEqual(validateDevSupervisorDecision(waitDecision(['worker.completed'])).events, ['worker.completed']);
  assert.deepEqual(
    validateDevSupervisorDecision(waitDecision(['worker.failed', 'worker.cancelled'])).events,
    ['worker.failed', 'worker.cancelled'],
  );
  for (const event of DEV_EVENT_TYPES) {
    assert.deepEqual(validateDevSupervisorDecision(waitDecision([event])).events, [event]);
  }
});

test('#6200 rejects unknown, mixed, blank and malformed event values', () => {
  for (const events of [
    ['worker.teleported'],
    ['worker.completed', 'worker.teleported'],
    [''],
    ['   '],
    [1],
    [null],
  ]) {
    assert.throws(() => validateDevSupervisorDecision(waitDecision(events)), TypeError);
  }

  assert.throws(
    () => parseDevSupervisorDecision(JSON.stringify(waitDecision(['custom.magic.event']))),
    /unsupported Dev event/,
  );
});

test('#6200 invalid model wait never reaches WAITING_EVENT or worker wait transport', async () => {
  let waitEventCalls = 0;
  const noop = async (args = {}) => args;
  const workerClient = {
    enabled: true,
    discover: async () => [{ tabNodeId: 'same-tab' }],
    claim: noop,
    createChat: noop,
    send: noop,
    observe: noop,
    followup: noop,
    nudge: noop,
    stop: noop,
    result: noop,
    release: noop,
    waitEvent: async () => {
      waitEventCalls += 1;
      throw new Error('invalid wait reached worker transport');
    },
  };
  const supervisor = new DevSupervisorV0({
    workerClient,
    idFactory: (kind) => `issue-6200-${kind}`,
    now: () => '2026-09-05T00:00:00.000Z',
  });
  const settings = new DevAgentUiSettings({ storage: { getItem: () => null, setItem() {} } });
  settings.setAgentProfile(AGENT_PROFILE.DEV);
  const bridge = Object.freeze({
    request: async () => ({ text: JSON.stringify(waitDecision(['worker.teleported'])) }),
  });
  const engine = new DevSupervisorEngineV0({ supervisor, settings, bridge, maxDecisions: 1 });

  await assert.rejects(
    engine.run({ goal: 'consumer-path regression', conversationId: 'issue-6200' }),
    /decision budget exhausted/,
  );
  assert.equal(waitEventCalls, 0);
  assert.notEqual(settings.lastRun?.status, 'WAITING_EVENT');
});
