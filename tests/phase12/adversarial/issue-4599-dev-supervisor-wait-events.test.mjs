import assert from 'node:assert/strict';

import {
  parseDevSupervisorDecision,
  validateDevSupervisorDecision,
} from '../../../js/ai/dev/protocol/hex-dev-supervisor-v1.js';
import { DEV_EVENT_TYPE, DEV_WORKER_EVENT_TYPES } from '../../../js/ai/dev/events/dev-events.js';
import { DevSupervisorEngineV0 } from '../../../js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
import { DevSupervisorV0 } from '../../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DevAgentUiSettings } from '../../../js/ai/dev/ui/settings.js';
import { AGENT_PROFILE } from '../../../js/ai/dev/policy/agent-profile.js';

const waitDecision = (events) => ({ type: 'wait', events, reason: 'wait for worker' });

assert.throws(
  () => validateDevSupervisorDecision(waitDecision([])),
  /wait\.events must be a non-empty array/,
  '#4599: an empty wait set must fail at the Supervisor protocol boundary',
);
assert.throws(
  () => parseDevSupervisorDecision(JSON.stringify(waitDecision([]))),
  /wait\.events must be a non-empty array/,
  '#4599: parsed model output must enforce the same non-empty wait contract',
);

for (const event of DEV_WORKER_EVENT_TYPES) {
  assert.deepEqual(validateDevSupervisorDecision(waitDecision([event])).events, [event]);
}
assert.throws(
  () => validateDevSupervisorDecision(waitDecision([DEV_EVENT_TYPE.HUMAN_RESPONDED])),
  /unsupported Dev event/,
  '#4599: human responses use the human/resumeHuman path and must never enter Worker wait transport',
);
assert.throws(
  () => parseDevSupervisorDecision(JSON.stringify(waitDecision([DEV_EVENT_TYPE.HUMAN_RESPONDED]))),
  /unsupported Dev event/,
  '#4599: parsed model output must reject human.responded as a Worker wait event',
);
for (const events of [new Array(1), ['worker.typo'], [' worker.completed '], [''], ['   '], [null], [1]]) {
  assert.throws(() => validateDevSupervisorDecision(waitDecision(events)), TypeError);
}

let waitEventCalls = 0;
let modelCalls = 0;
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
  idFactory: (kind) => `issue-4599-${kind}`,
  now: () => '2026-09-13T00:00:00.000Z',
});
const settings = new DevAgentUiSettings({ storage: { getItem: () => null, setItem() {} } });
settings.setAgentProfile(AGENT_PROFILE.DEV);
const bridge = Object.freeze({
  request: async () => {
    modelCalls += 1;
    if (modelCalls === 1) return { text: JSON.stringify(waitDecision([DEV_EVENT_TYPE.HUMAN_RESPONDED])) };
    return {
      text: JSON.stringify({
        type: 'final',
        answer: 'recovered after invalid wait',
        completedTasks: [],
        remaining: [],
      }),
    };
  },
});
const engine = new DevSupervisorEngineV0({ supervisor, settings, bridge, maxDecisions: 2 });
const result = await engine.run({ goal: 'verify wait validation', conversationId: 'issue-4599' });
assert.equal(modelCalls, 2, '#4599: invalid wait should consume a decision and recover through re-plan');
assert.equal(waitEventCalls, 0, '#4599: human.responded wait must fail before the worker event transport');
assert.match(result.text ?? result.answer ?? '', /recovered after invalid wait/);
assert.notEqual(settings.lastRun?.status, 'FAILED');

console.log('issue-4599 dev supervisor wait event contract: ok');
