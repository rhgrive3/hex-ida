/**
 * #6255 regression: annotation.rename commits two coupled mutations
 * (notes.setName then symbols.rename). When the symbol rename throws, the
 * executor must roll the note mutation back instead of leaving a
 * failed-but-mutated state behind.
 */
import assert from 'node:assert/strict';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';

function appFor({ renameThrows = false, rollbackThrows = false } = {}) {
  let noteName = 'before';
  let symbolName = 'before';
  let refreshes = 0;
  return {
    app: {
      notes: {
        nameOf: () => noteName,
        setName: (_address, value) => {
          if (rollbackThrows && value !== 'after') throw new Error('note adapter exploded during rollback');
          noteName = value;
        },
      },
      symbols: {
        rename: (_address, value) => {
          if (renameThrows) throw new Error('symbol rename failed');
          symbolName = value;
        },
        nameAt: () => symbolName,
      },
      refreshCount: () => refreshes,
      viewer: { setSymbols: () => { refreshes++; } },
      updateChrome: () => { refreshes++; },
    },
    state: () => ({ noteName, symbolName, refreshes }),
  };
}

/* successful rename still commits both mutations */
{
  const { app, state } = appFor();
  const executor = new CapabilityExecutor({ catalog: { get: (id) => (id === 'annotation.rename' ? { id, agentExposed: true, inputSchema: { type: 'object' } } : null) }, app });
  const result = await executor.execute('annotation.rename', { address: '4096', value: 'after' });
  assert.equal(result.ok, true);
  assert.deepEqual(state(), { noteName: 'after', symbolName: 'after', refreshes: 2 });
}

/* symbols.rename failure rolls the note back to the prior state */
{
  const { app, state } = appFor({ renameThrows: true });
  const executor = new CapabilityExecutor({ catalog: { get: (id) => (id === 'annotation.rename' ? { id, agentExposed: true, inputSchema: { type: 'object' } } : null) }, app });
  await assert.rejects(
    () => executor.execute('annotation.rename', { address: '4096', value: 'after' }),
    /symbol rename failed/,
  );
  const snapshot = state();
  assert.equal(snapshot.noteName, 'before', 'failed rename must not leave the note mutation applied');
  assert.equal(snapshot.symbolName, 'before');
  assert.equal(snapshot.refreshes, 2, 'refresh must still run so internal and display state converge after rollback');
}

/* rename over an address that had no previous note restores to no-note */
{
  let noteName = null;
  const app = {
    notes: { nameOf: () => noteName, setName: (_address, value) => { noteName = value || null; } },
    symbols: { rename: () => { throw new Error('symbol rename failed'); } },
    viewer: { setSymbols() {} },
    updateChrome() {},
  };
  const executor = new CapabilityExecutor({ catalog: { get: (id) => (id === 'annotation.rename' ? { id, agentExposed: true, inputSchema: { type: 'object' } } : null) }, app });
  await assert.rejects(
    () => executor.execute('annotation.rename', { address: '4097', value: 'after' }),
    /symbol rename failed/,
  );
  assert.equal(noteName, null, 'a fresh rename that fails must restore the absence of a note');
}

/* rollback failure is surfaced as an explicit tool_failed, never silent */
{
  const { app, state } = appFor({ renameThrows: true, rollbackThrows: true });
  const executor = new CapabilityExecutor({ catalog: { get: (id) => (id === 'annotation.rename' ? { id, agentExposed: true, inputSchema: { type: 'object' } } : null) }, app });
  await assert.rejects(
    () => executor.execute('annotation.rename', { address: '4096', value: 'after' }),
    (error) => error.type === 'tool_failed' && /rolled back/.test(error.message) && /symbol rename failed/.test(error.details?.cause || ''),
  );
  assert.equal(state().refreshes, 0, 'display state must not be refreshed from a partially applied rename');
}

/* #5132: a display refresh (viewer.setSymbols / updateChrome) is not part of
   the canonical mutation. Its failure must surface as a refreshWarning on a
   successful result — never as a failed proposal whose mutation persisted. */
{
  const { app, state } = appFor();
  app.viewer.setSymbols = () => { throw new Error('viewer render failed'); };
  const executor = new CapabilityExecutor({ catalog: { get: (id) => (id === 'annotation.rename' ? { id, agentExposed: true, inputSchema: { type: 'object' } } : null) }, app });
  const result = await executor.execute('annotation.rename', { address: '4096', value: 'after' });
  assert.equal(result.ok, true, 'a display refresh failure must not fail the applied rename');
  assert.match(result.refreshWarning, /viewer symbols refresh failed/);
  assert.deepEqual(state(), { noteName: 'after', symbolName: 'after', refreshes: 1 }, 'the canonical rename must stay applied (the throwing viewer never reached its counter; chrome did)');
}

/* #5132: chrome refresh failure alone also stays a warning */
{
  const { app, state } = appFor();
  app.updateChrome = () => { throw new Error('chrome update failed'); };
  const executor = new CapabilityExecutor({ catalog: { get: (id) => (id === 'annotation.rename' ? { id, agentExposed: true, inputSchema: { type: 'object' } } : null) }, app });
  const result = await executor.execute('annotation.rename', { address: '4096', value: 'after' });
  assert.equal(result.ok, true);
  assert.match(result.refreshWarning, /chrome refresh failed/);
  assert.deepEqual(state(), { noteName: 'after', symbolName: 'after', refreshes: 1 }, 'the canonical rename must stay applied (the throwing chrome never reached its counter; viewer did)');
}

/* #5132: comment path — same refresh separation */
{
  let comment = 'old';
  let refreshed = 0;
  const app = {
    notes: {
      comment: () => comment,
      setComment: (_address, value) => { comment = value; },
    },
    viewer: { setSymbols: () => { throw new Error('viewer render failed'); } },
    updateChrome: () => { refreshed += 1; },
  };
  const executor = new CapabilityExecutor({ catalog: { get: (id) => (id === 'annotation.comment' ? { id, agentExposed: true, inputSchema: { type: 'object' } } : null) }, app });
  const result = await executor.execute('annotation.comment', { address: '4096', value: 'note text' });
  assert.equal(result.ok, true, 'a display refresh failure must not fail the applied comment');
  assert.match(result.refreshWarning, /viewer symbols refresh failed/);
  assert.equal(comment, 'note text', 'the canonical comment must stay applied');
  assert.equal(refreshed, 1);
}

/* #5132: no refresh failure — the success result keeps its exact prior shape */
{
  const { app } = appFor();
  const executor = new CapabilityExecutor({ catalog: { get: (id) => (id === 'annotation.rename' ? { id, agentExposed: true, inputSchema: { type: 'object' } } : null) }, app });
  const result = await executor.execute('annotation.rename', { address: '4096', value: 'after' });
  assert.deepEqual(result, { ok: true, address: '4096', value: 'after' }, 'the success result must not gain a refreshWarning when refreshes succeed');
}

/* #5132: a rollback-path refresh failure must not mask the original rename failure */
{
  const { app } = appFor({ renameThrows: true });
  app.viewer.setSymbols = () => { throw new Error('viewer render failed during rollback'); };
  const executor = new CapabilityExecutor({ catalog: { get: (id) => (id === 'annotation.rename' ? { id, agentExposed: true, inputSchema: { type: 'object' } } : null) }, app });
  await assert.rejects(
    () => executor.execute('annotation.rename', { address: '4096', value: 'after' }),
    /symbol rename failed/,
    'the original rename failure must surface even when the rollback refresh also fails',
  );
}

// AI persistence/atomicity regressions live in the AI test lane. Importing
// them here keeps them inside the existing required `ai:test` denominator
// without widening Phase 12 ownership for AI production files.
await import('./ai/adversarial/issue-3758-ai-annotation-persistence.test.mjs');
await import('./ai/adversarial/issue-3758-ai-annotation-save-adapter.test.mjs');
await import('./ai/adversarial/issue-3773-ai-approval-token-atomic.test.mjs');
await import('./ai-proposal-note-readiness.mjs');

console.log('issue-6255-rename-rollback: ok');
