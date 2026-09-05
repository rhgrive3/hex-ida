import assert from 'node:assert/strict';
import { CapabilityExecutor } from '../../../js/ai/capabilities/executor.js';

const authorization = { kind: 'proposal', token: 'approved-token' };

function executorFor(app) {
  return new CapabilityExecutor({
    app,
    catalog: {
      get(id) {
        return {
          id,
          agentExposed: true,
          requiresApproval: true,
          inputSchema: { type: 'object' },
          category: 'annotation',
        };
      },
    },
  });
}

async function rejectsToolFailed(promise) {
  await assert.rejects(promise, (error) => error?.type === 'tool_failed');
}

{
  let chromeUpdates = 0;
  const executor = executorFor({
    notes: { setComment: () => false },
    updateChrome: () => { chromeUpdates += 1; },
  });
  await rejectsToolFailed(executor.execute(
    'annotation.comment',
    { address: '4096', value: 'approved note' },
    { authorization },
  ));
  assert.equal(chromeUpdates, 0, 'failed comment persistence must not publish a UI success update');
}

{
  let symbolRenames = 0;
  const executor = executorFor({
    notes: {
      nameOf: () => 'before',
      setName: () => false,
    },
    symbols: { rename: () => { symbolRenames += 1; } },
  });
  await rejectsToolFailed(executor.execute(
    'annotation.rename',
    { address: '4096', value: 'after' },
    { authorization },
  ));
  assert.equal(symbolRenames, 0, 'failed name persistence must stop before the coupled symbol rename');
}

{
  const notes = {
    structs: [],
    save: () => false,
  };
  const executor = executorFor({ notes });
  await rejectsToolFailed(executor.execute(
    'annotation.struct-field',
    { struct: 'Pair', offset: 0, field: 'left', type: 'int' },
    { authorization },
  ));
}

{
  const executor = executorFor({
    notes: { setType: () => false },
  });
  await rejectsToolFailed(executor.execute(
    'annotation.set-type',
    { address: '4096', key: 'return', value: 'int' },
    { authorization },
  ));
}

{
  let saved = 0;
  let renamed = 0;
  const app = {
    notes: {
      structs: [],
      setComment: () => true,
      nameOf: () => 'before',
      setName: () => true,
      setType: () => true,
      save: () => { saved += 1; return true; },
    },
    symbols: { rename: () => { renamed += 1; } },
  };
  const executor = executorFor(app);
  assert.equal((await executor.execute(
    'annotation.comment',
    { address: '4096', value: 'ok' },
    { authorization },
  )).ok, true);
  assert.equal((await executor.execute(
    'annotation.rename',
    { address: '4096', value: 'renamed' },
    { authorization },
  )).ok, true);
  assert.equal((await executor.execute(
    'annotation.set-type',
    { address: '4096', key: 'return', value: 'int' },
    { authorization },
  )).ok, true);
  assert.equal((await executor.execute(
    'annotation.struct-field',
    { struct: 'Pair', offset: 0, field: 'left', type: 'int' },
    { authorization },
  )).ok, true);
  assert.equal(renamed, 1);
  assert.equal(saved, 1);
}

{
  let setNameCalls = 0;
  const executor = executorFor({
    notes: {
      nameOf: () => 'before',
      setName: () => {
        setNameCalls += 1;
        return setNameCalls === 1;
      },
    },
    symbols: {
      rename: () => { throw new Error('symbol rename failed'); },
    },
  });
  await assert.rejects(
    executor.execute(
      'annotation.rename',
      { address: '4096', value: 'after' },
      { authorization },
    ),
    (error) => error?.type === 'tool_failed' && /rolled back/i.test(error.message),
  );
  assert.equal(setNameCalls, 2, 'rename rollback must attempt to persist the previous note value');
}

console.log('issue-3758 AI annotation persistence regression: ok');
