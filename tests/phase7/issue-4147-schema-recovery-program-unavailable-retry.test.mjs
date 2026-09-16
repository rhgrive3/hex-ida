import test from 'node:test';
import assert from 'node:assert/strict';

import { schemaResultSatisfies } from '../../js/analysis/schema-recovery-contract.js';
import { recoverSchemasForUi, clearSchemaRecoveryTasks } from '../../js/analysis/schema-recovery-task.js';
import { normalizeSchemaRecoveryLimit } from '../../js/schema.js';

function completeStrings() {
  return Object.defineProperty([{ addr:1n, text:'data.csv' }], 'complete', { value:true, configurable:true });
}

function completeProgram() {
  return {
    complete:true,
    unsupported:false,
    completeness:{ complete:true },
    graphCompleteness:{ callsComplete:true, refsComplete:true },
    functionsReferencing(address) { return [{ addr:address === 1n ? 0x1000n : 0x2000n }]; },
    functionRange(address) { return { start:address, end:address + 32n }; },
  };
}

function appWithProgramSequence(...programs) {
  let programCalls = 0;
  const app = {
    schemas:null,
    backend:{ gen:1, readAt:async () => ({ found:false }) },
    store:{ get:(key) => key === 'architecture' ? 'arm64' : null },
    currentSlice:() => null,
    ensureStrings:async () => completeStrings(),
    ensureProgram:async () => {
      const index = Math.min(programCalls, programs.length - 1);
      programCalls++;
      const program = programs[index];
      return typeof program === 'function' ? program(programCalls) : program;
    },
  };
  return { app, programCalls:() => programCalls };
}

test('#4147 program-unavailable early partial is retried in the same epoch', async () => {
  const { app, programCalls } = appWithProgramSequence(null, completeProgram());

  const first = await recoverSchemasForUi(app);
  assert.equal(first.complete, false);
  assert.equal(first.schemaRecoveryDependencyComplete, false);
  assert.equal(programCalls(), 1);

  const second = await recoverSchemasForUi(app);
  assert.equal(programCalls(), 2, 'ensureProgram() must run again once the dependency recovers');
  assert.equal(second.complete, true);
  assert.notEqual(second, first);
  clearSchemaRecoveryTasks(app);
});

test('#4147 program-unavailable partial is never reused as negative evidence', async () => {
  const { app, programCalls } = appWithProgramSequence(null, null, completeProgram());
  const limit = normalizeSchemaRecoveryLimit(undefined);

  const first = await recoverSchemasForUi(app);
  assert.equal(schemaResultSatisfies(first, 1, limit), false);
  assert.equal(app.schemas?.complete, false);
  const second = await recoverSchemasForUi(app);
  assert.equal(schemaResultSatisfies(second, 1, limit), false);
  assert.equal(programCalls(), 2);

  const third = await recoverSchemasForUi(app);
  assert.equal(third.complete, true);
  assert.equal(programCalls(), 3);
  clearSchemaRecoveryTasks(app);
});

test('#4147 complete recovery keeps sharing one settled task', async () => {
  const { app, programCalls } = appWithProgramSequence(completeProgram());
  const [left, right] = await Promise.all([recoverSchemasForUi(app), recoverSchemasForUi(app)]);
  assert.equal(left, right);
  assert.equal(programCalls(), 1);
  const after = await recoverSchemasForUi(app);
  assert.equal(after, left);
  assert.equal(programCalls(), 1);
  clearSchemaRecoveryTasks(app);
});

test('#4147 concurrent waiters share one unavailable-dependency task', async () => {
  const { app, programCalls } = appWithProgramSequence(null, completeProgram());
  const [left, right] = await Promise.all([recoverSchemasForUi(app), recoverSchemasForUi(app)]);
  assert.equal(left, right);
  assert.equal(left.complete, false);
  assert.equal(programCalls(), 1);
  const retry = await recoverSchemasForUi(app);
  assert.equal(retry.complete, true);
  assert.equal(programCalls(), 2);
  clearSchemaRecoveryTasks(app);
});

test('#4147 aborted consumer leaves the epoch entry retryable', async () => {
  const { app, programCalls } = appWithProgramSequence(null, completeProgram());
  const controller = new AbortController();
  controller.abort('consumer-closed');
  await assert.rejects(() => recoverSchemasForUi(app, { signal:controller.signal }), (error) => error.name === 'AbortError');
  const retry = await recoverSchemasForUi(app);
  assert.equal(retry.complete, true);
  assert.equal(programCalls(), 2);
  clearSchemaRecoveryTasks(app);
});

console.log('issue #4147 schema recovery program-unavailable retry: PASS');
