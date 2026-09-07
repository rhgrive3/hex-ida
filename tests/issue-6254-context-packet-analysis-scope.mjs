import assert from 'node:assert/strict';
import test from 'node:test';

import { createDevContextPacket } from '../js/ai/dev/protocol/context-packet.js';
import {
  buildDevSupervisorPrompt,
  devSupervisorContextPacket,
  DEV_PROMPT_MODE,
} from '../js/ai/dev/protocol/dev-supervisor-prompt.js';

function packet(scope) {
  return createDevContextPacket({ taskId: 'scope-test', objective: 'preserve analysis scope', scope });
}

test('#6254 preserves canonical structured scopes and string compatibility', () => {
  for (const scope of [
    { initial: 'none', expansionPolicy: 'agent' },
    { initial: 'function', expansionPolicy: 'locked' },
    { initial: 'project', expansionPolicy: 'auto' },
    { initial: ' BINARY ', expansionPolicy: ' AGENT ' },
  ]) {
    const normalized = packet(scope).scope;
    assert.deepEqual(normalized, {
      initial: scope.initial.trim().toLowerCase(),
      expansionPolicy: scope.expansionPolicy.trim().toLowerCase(),
    });
    assert.ok(Object.isFrozen(normalized));
  }
  assert.equal(packet('js/userscript/dev').scope, 'js/userscript/dev');
  assert.equal(packet('   ').scope, null);
});

test('#6254 rejects malformed structured child values without coercion', () => {
  const coercible = { toString: () => 'function' };
  for (const scope of [
    { initial: ['function'], expansionPolicy: 'locked' },
    { initial: { value: 'function' }, expansionPolicy: 'locked' },
    { initial: true, expansionPolicy: 'locked' },
    { initial: 1, expansionPolicy: 'locked' },
    { initial: coercible, expansionPolicy: 'locked' },
    { initial: 'function', expansionPolicy: ['locked'] },
    { initial: 'function', expansionPolicy: { value: 'locked' } },
    { initial: 'function', expansionPolicy: false },
    { initial: 'function', expansionPolicy: 0 },
    { initial: 'invalid', expansionPolicy: 'auto' },
    { initial: 'function', expansionPolicy: 'invalid' },
    Object.assign(Object.create({ inherited: true }), { initial: 'function', expansionPolicy: 'locked' }),
    12345,
  ]) {
    assert.throws(() => packet(scope), TypeError);
  }
});

test('#6254 BOOTSTRAP retains scope after loose run fields are omitted', () => {
  const run = {
    runId: 'run-6254-bootstrap',
    workerId: 'worker-1',
    supervisorSessionKey: 'scope-session',
    goal: 'audit one function',
    decisionPolicy: 'normal',
    analysisScope: { initial: 'function', expansionPolicy: 'locked' },
    status: 'ACTIVE',
  };
  const contextPacket = devSupervisorContextPacket(run);
  assert.deepEqual(contextPacket.scope, run.analysisScope);

  const prompt = buildDevSupervisorPrompt({
    mode: DEV_PROMPT_MODE.BOOTSTRAP,
    run,
    availableTools: ['repo.read'],
    history: [],
    contextPacket,
  });
  assert.ok(!prompt.includes('[object Object]'));
  assert.ok(prompt.includes('"initial":"function"'));
  assert.ok(prompt.includes('"expansionPolicy":"locked"'));
});

test('#6254 CONTINUATION and BOOTSTRAP preserve equivalent scope semantics', () => {
  const run = {
    runId: 'run-6254-continuation',
    workerId: 'worker-1',
    supervisorSessionKey: 'scope-session',
    goal: 'continue binary audit',
    decisionPolicy: 'normal',
    analysisScope: { initial: 'binary', expansionPolicy: 'agent' },
    status: 'ACTIVE',
  };
  const contextPacket = devSupervisorContextPacket(run);
  for (const mode of [DEV_PROMPT_MODE.BOOTSTRAP, DEV_PROMPT_MODE.CONTINUATION]) {
    const prompt = buildDevSupervisorPrompt({
      mode,
      run,
      availableTools: ['repo.read'],
      history: [],
      contextPacket,
    });
    assert.ok(!prompt.includes('[object Object]'));
    assert.ok(prompt.includes('"initial":"binary"'));
    assert.ok(prompt.includes('"expansionPolicy":"agent"'));
  }
});
