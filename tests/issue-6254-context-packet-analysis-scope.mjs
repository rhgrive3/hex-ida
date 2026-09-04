import assert from 'node:assert/strict';
import test from 'node:test';

import { createDevContextPacket } from '../js/ai/dev/protocol/context-packet.js';
import { devSupervisorContextPacket, buildDevSupervisorPrompt, DEV_PROMPT_MODE } from '../js/ai/dev/protocol/dev-supervisor-prompt.js';

test('1. structured scope { initial: "none", expansionPolicy: "agent" } is preserved', () => {
  const packet = createDevContextPacket({
    taskId: 'task-1',
    objective: 'objective 1',
    scope: { initial: 'none', expansionPolicy: 'agent' },
  });
  assert.deepEqual(packet.scope, { initial: 'none', expansionPolicy: 'agent' });
  assert.ok(Object.isFrozen(packet.scope));
});

test('2. structured scope { initial: "function", expansionPolicy: "locked" } is preserved', () => {
  const packet = createDevContextPacket({
    taskId: 'task-2',
    objective: 'objective 2',
    scope: { initial: 'function', expansionPolicy: 'locked' },
  });
  assert.deepEqual(packet.scope, { initial: 'function', expansionPolicy: 'locked' });
});

test('3. structured scope { initial: "project", expansionPolicy: "auto" } is preserved', () => {
  const packet = createDevContextPacket({
    taskId: 'task-3',
    objective: 'objective 3',
    scope: { initial: 'project', expansionPolicy: 'auto' },
  });
  assert.deepEqual(packet.scope, { initial: 'project', expansionPolicy: 'auto' });
});

test('4. string scope is preserved as string', () => {
  const packet = createDevContextPacket({
    taskId: 'task-4',
    objective: 'objective 4',
    scope: 'js/userscript/dev',
  });
  assert.equal(packet.scope, 'js/userscript/dev');
});

test('5. malformed structured scope is rejected with TypeError rather than [object Object]', () => {
  assert.throws(
    () => createDevContextPacket({
      taskId: 'task-5',
      objective: 'objective 5',
      scope: { initial: 'invalid_scope', expansionPolicy: 'auto' },
    }),
    TypeError,
  );
  assert.throws(
    () => createDevContextPacket({
      taskId: 'task-5',
      objective: 'objective 5',
      scope: { initial: 'function', expansionPolicy: 'invalid_policy' },
    }),
    TypeError,
  );
  assert.throws(
    () => createDevContextPacket({
      taskId: 'task-5',
      objective: 'objective 5',
      scope: 12345,
    }),
    TypeError,
  );
});

test('6. BOOTSTRAP prompt contains structured scope, never [object Object]', () => {
  const run = {
    runId: 'run-100',
    workerId: 'worker-1',
    supervisorSessionKey: 'sess-key',
    goal: 'Audit and build binary feature',
    decisionPolicy: 'normal',
    analysisScope: { initial: 'function', expansionPolicy: 'locked' },
    status: 'ACTIVE',
  };
  const packet = devSupervisorContextPacket(run);
  assert.ok(packet);
  assert.deepEqual(packet.scope, { initial: 'function', expansionPolicy: 'locked' });

  const promptText = buildDevSupervisorPrompt({
    mode: DEV_PROMPT_MODE.BOOTSTRAP,
    run,
    availableTools: ['repo.read'],
    history: [],
    contextPacket: packet,
  });

  assert.ok(!promptText.includes('[object Object]'), 'prompt must not contain [object Object]');
  assert.ok(promptText.includes('"initial":"function"'));
  assert.ok(promptText.includes('"expansionPolicy":"locked"'));
});

test('7. CONTINUATION and BOOTSTRAP scope semantics match', () => {
  const run = {
    runId: 'run-101',
    workerId: 'worker-1',
    supervisorSessionKey: 'sess-key',
    goal: 'Test continuation consistency',
    decisionPolicy: 'normal',
    analysisScope: { initial: 'binary', expansionPolicy: 'agent' },
    status: 'ACTIVE',
  };
  const packet = devSupervisorContextPacket(run);

  const continuationPromptText = buildDevSupervisorPrompt({
    mode: DEV_PROMPT_MODE.CONTINUATION,
    run,
    availableTools: ['repo.read'],
    history: [],
    contextPacket: packet,
  });

  assert.ok(!continuationPromptText.includes('[object Object]'));
  assert.ok(continuationPromptText.includes('"initial":"binary"'));
  assert.ok(continuationPromptText.includes('"expansionPolicy":"agent"'));
});
