// Regression for #8997: schema recovery derives its candidate universe from the
// ProgramIndex / symbol generation (functionsReferencing() / functionRange()), but
// the canonical artifact + task identity only bound backend epoch + maxSchemas +
// completeness. A `complete:true` result produced from generation G1 therefore
// stayed reusable, coalescable, and publishable after the current ProgramIndex
// moved to G2 inside the same backend epoch, laundering a stale analysis result as
// authoritative complete. The fix carries the #4487 symbol-generation authority
// (ProgramIndex.gen / app.symbols.gen) through the shared freshness contract.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  annotateSchemaResult,
  dependencyCompleteness,
  schemaDependencyGeneration,
  schemaResultSatisfies,
} from '../../js/analysis/schema-recovery-contract.js';
import { recoverSchemasForUi, clearSchemaRecoveryTasks } from '../../js/analysis/schema-recovery-task.js';
import { App } from '../../js/app.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function strings() {
  return Object.defineProperty([{ addr:1n, text:'data.csv' }], 'complete', { value:true, configurable:true });
}

// A complete ProgramIndex at a specific semantic generation. Zero referencing
// functions keeps the recovered universe deterministic (empty) while the
// generation tag is exactly the identity this issue is about.
function program(gen) {
  return {
    gen,
    complete:true,
    unsupported:false,
    completeness:{ complete:true },
    graphCompleteness:{ callsComplete:true, refsComplete:true },
    functionsReferencing:() => [],
    functionRange:() => null,
  };
}

function modernApp() {
  const state = { programCalls:0, gate:null };
  const app = {
    schemas:null,
    symbols:{ gen:1 },
    backend:{ gen:7, readAt:async () => ({ found:false }) },
    store:{ get:(key) => (key === 'architecture' ? 'arm64' : null) },
    ensureStrings:async () => strings(),
    ensureProgram:async () => {
      state.programCalls++;
      const generation = app.symbols.gen;
      if (state.gate && generation === 1) await state.gate.promise;
      return program(generation);
    },
  };
  return { app, state };
}

function legacyApp() {
  const state = { programCalls:0 };
  const app = Object.create(App.prototype);
  app.schemas = null;
  app.schemasBusy = null;
  app.schemasBusyEpoch = -1;
  app.schemasBusyGeneration = -1;
  app.symbols = { gen:1 };
  app.backend = { gen:3, readAt:async () => ({ found:false }) };
  app.store = { get:(key) => (key === 'architecture' ? 'arm64' : null) };
  app.currentSlice = () => null;
  app.ensureStrings = async () => strings();
  app.ensureProgram = async () => { state.programCalls++; return program(app.symbols.gen); };
  return { app, state };
}

test('#8997 schema artifacts bind a dependency generation and reject cross-generation reuse', () => {
  const artifact = annotateSchemaResult([{ table:1 }], { complete:true, reasons:[] }, { epoch:7, maxSchemas:300, dependencyGeneration:5 });
  assert.equal(artifact.complete, true);
  assert.equal(artifact.schemaRecoveryDependencyGeneration, 5);
  assert.equal(schemaResultSatisfies(artifact, 7, 300, 5), true, 'same generation may reuse');
  assert.equal(schemaResultSatisfies(artifact, 7, 300, 6), false, 'a different ProgramIndex generation must not reuse a complete artifact');
  assert.equal(schemaResultSatisfies(artifact, 7, 300), false, 'an omitted generation (0) must not reuse a tagged artifact');
  assert.equal(schemaDependencyGeneration({ symbols:{ gen:9 } }), 9);
  assert.equal(schemaDependencyGeneration({}), 0);
});

test('#8997 budget-partial reuse is also generation-scoped within one epoch', () => {
  const truncated = [{ table:1 }];
  Object.defineProperty(truncated, 'truncated', { value:true, configurable:true });
  Object.defineProperty(truncated, 'truncationReason', { value:'schema-recovery-limit', configurable:true });
  const partial = annotateSchemaResult(truncated, { complete:true, reasons:[] }, { epoch:7, maxSchemas:1, dependencyGeneration:4 });
  assert.equal(partial.complete, false);
  assert.equal(partial.schemaRecoveryDependencyComplete, true);
  assert.equal(partial.schemaRecoveryBudgetPartial, true);
  // budget-partial stays intentionally reusable for its own generation...
  assert.equal(schemaResultSatisfies(partial, 7, 1, 4), true);
  // ...but not for a different semantic generation.
  assert.equal(schemaResultSatisfies(partial, 7, 1, 5), false);
});

test('#8997 counterexample A: a settled complete zero-schema result is not reused across a same-epoch generation change', async () => {
  const { app, state } = modernApp();
  app.symbols.gen = 1;
  const first = await recoverSchemasForUi(app);
  assert.equal(first.complete, true);
  assert.equal(first.schemaRecoveryDependencyGeneration, 1);
  assert.equal(state.programCalls, 1);

  // backend.gen stays 7; only the semantic dependency generation moves to G2.
  app.symbols.gen = 2;
  const second = await recoverSchemasForUi(app);
  assert.notEqual(second, first, 'G2 must recover against the current ProgramIndex, not reuse the G1 artifact');
  assert.equal(second.schemaRecoveryDependencyGeneration, 2);
  assert.equal(state.programCalls, 2, 'ensureProgram() must run for the new generation');

  // The settled TASKS entry is independently stale: clearing only the public cache
  // must still refuse to hand back the G1 result for a G2 request.
  app.schemas = null;
  const third = await recoverSchemasForUi(app);
  assert.notEqual(third, first);
  assert.equal(third.schemaRecoveryDependencyGeneration, 2);
  clearSchemaRecoveryTasks(app);
});

test('#8997 counterexample A (control): same epoch + same generation still reuses safely', async () => {
  const { app, state } = modernApp();
  const first = await recoverSchemasForUi(app);
  const again = await recoverSchemasForUi(app);
  assert.equal(again, first, 'an unchanged generation keeps single-flight/cache reuse');
  assert.equal(state.programCalls, 1);
  clearSchemaRecoveryTasks(app);
});

test('#8997 counterexample B: an in-flight older-generation task neither coalesces a newer caller nor publishes after refinement', async () => {
  const { app, state } = modernApp();
  state.gate = deferred();
  app.symbols.gen = 1;
  const g1 = recoverSchemasForUi(app);
  await new Promise((resolve) => setTimeout(resolve, 0)); // let G1 enter ensureProgram and suspend

  app.symbols.gen = 2;
  const g2 = recoverSchemasForUi(app);
  state.gate.resolve();
  const [a, b] = await Promise.all([g1, g2]);

  assert.notEqual(b, a, 'the G2 caller must not attach to the pending G1 task');
  assert.equal(a.schemaRecoveryDependencyGeneration, 1);
  assert.equal(b.schemaRecoveryDependencyGeneration, 2);
  assert.equal(app.schemas, b, 'the stale G1 completion must not overwrite app.schemas');
  assert.notEqual(app.schemas, a);

  const later = await recoverSchemasForUi(app);
  assert.equal(later, b, 'later same-generation requests observe the G2 result');
  clearSchemaRecoveryTasks(app);
});

test('#8997 legacy App.ensureSchemas() obeys the same dependency-aware cache identity', async () => {
  const { app, state } = legacyApp();
  const first = await app.ensureSchemas();
  assert.equal(first.complete, true);
  assert.equal(first.schemaRecoveryDependencyGeneration, 1);
  assert.equal(state.programCalls, 1);

  app.symbols.gen = 2;
  const second = await app.ensureSchemas();
  assert.notEqual(second, first, 'the legacy busy/cache reuse must not bypass the generation-aware freshness check');
  assert.equal(second.schemaRecoveryDependencyGeneration, 2);
  assert.equal(state.programCalls, 2);
});

test('#8997 legacy App.ensureSchemas() does not let a different-generation request reuse an in-flight busy of the old generation', async () => {
  const { app, state } = legacyApp();
  const gate = deferred();
  app.ensureProgram = async () => {
    const generation = app.symbols.gen;
    state.programCalls++;
    if (generation === 1) await gate.promise;
    return program(generation);
  };
  const p1 = app.ensureSchemas();
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.symbols.gen = 2;
  const p2 = app.ensureSchemas();
  assert.notEqual(app.schemasBusy, p1, 'a new-generation request must start its own busy task, not reuse the G1 busy');
  gate.resolve();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(b.schemaRecoveryDependencyGeneration, 2);
  assert.equal(app.schemas, b, 'the gen-2 result is authoritative');
  // The suspended G1 computation must not launder a generation-1 artifact into a
  // generation-2 world: whichever value the stale busy resolves to, it is the
  // current gen-2 result, never a complete-but-stale gen-1 result.
  assert.equal(a.schemaRecoveryDependencyGeneration, 2, 'no stale gen-1 result is handed to a caller once the generation advanced');
});
