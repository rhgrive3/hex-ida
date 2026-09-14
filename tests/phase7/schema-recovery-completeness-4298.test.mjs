import test from 'node:test';
import assert from 'node:assert/strict';

import {
  annotateSchemaResult,
  dependencyCompleteness,
  schemaResultSatisfies,
} from '../../js/analysis/schema-recovery-contract.js';
import { recoverSchemasForUi, clearSchemaRecoveryTasks } from '../../js/analysis/schema-recovery-task.js';
import { App } from '../../js/app.js';

function completeStrings() {
  return Object.defineProperty([{ addr:1n, text:'data.csv' }], 'complete', {
    value:true,
    configurable:true,
  });
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

function appWithDependencies({ program }) {
  let programCalls = 0;
  const app = {
    schemas:null,
    backend:{ gen:1, readAt:async () => ({ found:false }) },
    store:{ get:(key) => key === 'architecture' ? 'arm64' : null },
    ensureStrings:async () => completeStrings(),
    ensureProgram:async () => {
      programCalls++;
      return typeof program === 'function' ? program(programCalls) : program;
    },
  };
  return { app, programCalls:() => programCalls };
}

function legacyApp({ strings = completeStrings(), program }) {
  const app = Object.create(App.prototype);
  app.schemas = null;
  app.schemasBusy = null;
  app.schemasBusyEpoch = -1;
  app.backend = { gen:1, readAt:async () => ({ found:false }) };
  app.store = { get:(key) => key === 'architecture' ? 'arm64' : null };
  app.currentSlice = () => null;
  app.ensureStrings = async () => strings;
  app.ensureProgram = async () => typeof program === 'function' ? program() : program;
  return app;
}

test('#4298 legacy ensureSchemas publishes explicit incompleteness for null dependencies before modern retry', async () => {
  const app = legacyApp({ program:null });
  const legacy = await app.ensureSchemas();
  assert.equal(Array.isArray(legacy), true);
  assert.equal(legacy.complete, false);
  assert.equal(legacy.incompleteReason, 'program-partial');
  assert.equal(legacy.schemaRecoveryDependencyComplete, false);
  const modern = await recoverSchemasForUi(app);
  assert.equal(modern.complete, false);
  assert.notEqual(modern, legacy, 'modern recovery must not reuse legacy failure artifact');
  clearSchemaRecoveryTasks(app);
});

test('#4298 legacy ensureSchemas exception artifact is not a modern complete cache hit', async () => {
  const app = legacyApp({ program:completeProgram() });
  let failed = true;
  app.ensureStrings = async () => {
    if (failed) { failed = false; throw new Error('dependency unavailable'); }
    return completeStrings();
  };
  const legacy = await app.ensureSchemas();
  assert.equal(legacy.complete, false);
  assert.equal(legacy.incompleteReason, 'schema-recovery-failed');
  const modern = await recoverSchemasForUi(app);
  assert.equal(modern.complete, true);
  assert.notEqual(modern, legacy);
  clearSchemaRecoveryTasks(app);
});

test('#4298 legacy ensureSchemas retries after a dependency becomes available in the same epoch', async () => {
  let calls = 0;
  const app = legacyApp({ program:() => ++calls === 1 ? null : completeProgram() });
  const failed = await app.ensureSchemas();
  assert.equal(failed.complete, false);
  const recovered = await app.ensureSchemas();
  assert.equal(recovered.complete, true);
  assert.notEqual(recovered, failed);
  assert.equal(calls, 2);
});

test('#4298 legacy null dependency is represented as an incomplete artifact, never a plain complete array', () => {
  const result = annotateSchemaResult([], dependencyCompleteness(completeStrings(), null), { epoch:7, maxSchemas:300 });
  assert.deepEqual([...result], []);
  assert.equal(result.complete, false);
  assert.equal(result.incompleteReason, 'program-partial');
  assert.deepEqual(result.dependencyReasons, ['program-partial']);
  assert.equal(result.schemaRecoveryEpoch, 7);
  assert.equal(result.schemaRecoveryMaxSchemas, 300);
  assert.equal(result.schemaRecoveryDependencyComplete, false);
  assert.equal(schemaResultSatisfies(result, 7, 300), false);
});

test('#4298 legacy exception artifact is explicit and retryable', () => {
  const result = annotateSchemaResult([], { complete:false, reasons:['schema-recovery-failed'] }, { epoch:7, maxSchemas:300 });
  assert.equal(result.complete, false);
  assert.equal(result.incompleteReason, 'schema-recovery-failed');
  assert.deepEqual(result.dependencyReasons, ['schema-recovery-failed']);
  assert.equal(schemaResultSatisfies(result, 7, 300), false);
});

test('#4298 dependency-partial modern result is retried when the dependency becomes available', async () => {
  const { app, programCalls } = appWithDependencies({
    program:(calls) => calls === 1 ? {
      complete:false,
      unsupported:false,
      completeness:{ complete:false, reasons:['program-partial'] },
      graphCompleteness:{ callsComplete:false, refsComplete:true },
      functionsReferencing:() => [],
      functionRange:() => null,
    } : completeProgram(),
  });

  const partial = await recoverSchemasForUi(app);
  assert.equal(partial.complete, false);
  assert.equal(partial.schemaRecoveryDependencyComplete, false);
  const complete = await recoverSchemasForUi(app);
  assert.equal(complete.complete, true);
  assert.notEqual(complete, partial);
  assert.equal(programCalls(), 2);
  clearSchemaRecoveryTasks(app);
});

test('#4298 budget-partial result remains reusable and stronger budgets remain monotonic', async () => {
  const { app, programCalls } = appWithDependencies({ program:completeProgram() });
  const partial = await recoverSchemasForUi(app, { budget:{ maxSchemas:0 } });
  assert.equal(partial.complete, false);
  assert.equal(partial.schemaRecoveryDependencyComplete, true);
  assert.equal(partial.schemaRecoveryBudgetPartial, true);
  assert.equal(schemaResultSatisfies(partial, 1, 0), true);
  const same = await recoverSchemasForUi(app, { budget:{ maxSchemas:0 } });
  assert.equal(same, partial);
  const complete = await recoverSchemasForUi(app, { budget:{ maxSchemas:1 } });
  assert.equal(complete.complete, true);
  assert.notEqual(complete, partial);
  assert.equal(programCalls(), 2);
  clearSchemaRecoveryTasks(app);
});

test('#4298 complete zero-schema result is reusable only for its current epoch identity', async () => {
  const { app, programCalls } = appWithDependencies({ program:completeProgram() });
  const first = await recoverSchemasForUi(app);
  assert.equal(first.complete, true);
  assert.equal(first.length, 0);
  assert.equal(schemaResultSatisfies(first, 1, 300), true);
  app.backend.gen = 2;
  const second = await recoverSchemasForUi(app);
  assert.equal(second.complete, true);
  assert.notEqual(second, first);
  assert.equal(second.schemaRecoveryEpoch, 2);
  assert.equal(programCalls(), 2);
  clearSchemaRecoveryTasks(app);
});

test('#4298 file/slice reset drops the legacy cache before the next epoch can recover', async () => {
  let calls = 0;
  const app = legacyApp({ program:() => { calls++; return completeProgram(); } });
  const first = await app.ensureSchemas();
  assert.equal(first.complete, true);
  app.forgetSemantics(true);
  assert.equal(app.schemas, null);
  const sameEpoch = await recoverSchemasForUi(app);
  assert.equal(sameEpoch.complete, true);
  assert.notEqual(sameEpoch, first);
  assert.equal(calls, 2, 'reset must clear completed same-epoch task entries');
  app.backend.gen = 2;
  const second = await recoverSchemasForUi(app);
  assert.equal(second.complete, true);
  assert.equal(second.schemaRecoveryEpoch, 2);
  assert.equal(calls, 3);
  clearSchemaRecoveryTasks(app);
});

test('#4298 raw legacy arrays and stale identities cannot satisfy the modern cache predicate', () => {
  assert.equal(schemaResultSatisfies([], 1, 300), false);
  const current = annotateSchemaResult([], { complete:true, reasons:[] }, { epoch:1, maxSchemas:300 });
  assert.equal(schemaResultSatisfies(current, 2, 300), false);
  assert.equal(schemaResultSatisfies(current, 1, 301), true);
  const unsupported = [];
  Object.defineProperty(unsupported, 'unsupported', { value:true, configurable:true });
  const unsupportedArtifact = annotateSchemaResult(unsupported, { complete:true, reasons:[] }, { epoch:1, maxSchemas:300 });
  assert.equal(unsupportedArtifact.schemaRecoveryBudgetPartial, false);
  assert.equal(schemaResultSatisfies(unsupportedArtifact, 1, 300), false);
});

test('#4298 legacy and modern paths share the same dependency completeness semantics', () => {
  const strings = completeStrings();
  const complete = dependencyCompleteness(strings, completeProgram());
  const partialStrings = Object.defineProperty([], 'complete', { value:false, configurable:true });
  const partial = dependencyCompleteness(partialStrings, completeProgram());
  assert.deepEqual(complete, { complete:true, reasons:[] });
  assert.deepEqual(partial, { complete:false, reasons:['strings-partial'] });
  const legacy = annotateSchemaResult([], partial, { epoch:1, maxSchemas:300 });
  assert.equal(legacy.complete, false);
  assert.equal(legacy.schemaRecoveryDependencyComplete, false);
  assert.equal(schemaResultSatisfies(legacy, 1, 300), false);
});
