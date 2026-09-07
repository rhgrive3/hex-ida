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

// #3758 persistence/atomicity regressions live in the AI test lane. Importing
// them here keeps them inside the existing required `ai:test` denominator
// without widening Phase 12 ownership for the AI capability executor.
await import('./ai/adversarial/issue-3758-ai-annotation-persistence.test.mjs');
await import('./ai/adversarial/issue-3758-ai-annotation-save-adapter.test.mjs');
await import('./ai-proposal-note-readiness.mjs');

console.log('issue-6255-rename-rollback: ok');
