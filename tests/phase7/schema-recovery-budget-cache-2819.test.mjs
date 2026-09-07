import test from 'node:test';
import assert from 'node:assert/strict';

import { recoverSchemasForUi, clearSchemaRecoveryTasks } from '../../js/analysis/schema-recovery-task.js';

function fixture(readAt) {
  const strings = [
    { addr:1n, text:'a.csv' },
    { addr:2n, text:'b.json' },
  ];
  Object.defineProperty(strings, 'complete', { value:true, configurable:true });
  const program = {
    complete:true,
    unsupported:false,
    completeness:{ complete:true },
    graphCompleteness:{ callsComplete:true, refsComplete:true },
    functionsReferencing(address) {
      return [{ addr:address === 1n ? 0x1000n : 0x2000n }];
    },
    functionRange(address) {
      return { start:address, end:address + 32n };
    },
  };
  return {
    backend:{ gen:7, readAt },
    ensureStrings:async () => strings,
    ensureProgram:async () => program,
    store:{ get:(key) => key === 'architecture' ? 'arm64' : null },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('#2819 completed low-budget partial result is upgraded by a stronger request', async () => {
  let reads = 0;
  const app = fixture(async () => {
    reads++;
    return { found:false };
  });

  const small = await recoverSchemasForUi(app, { budget:{ maxSchemas:1 } });
  assert.equal(small.complete, false);
  assert.match(small.incompleteReason, /schema-recovery-limit/);
  assert.equal(small.schemaRecoveryMaxSchemas, 1);
  assert.equal(reads, 1);
  assert.equal(app.schemas, small, 'partial result remains available to legacy/UI readers');

  const same = await recoverSchemasForUi(app, { budget:{ maxSchemas:1 } });
  assert.equal(same, small, 'same-budget caller reuses the completed task');
  assert.equal(reads, 1);

  const large = await recoverSchemasForUi(app, { budget:{ maxSchemas:2 } });
  assert.notEqual(large, small, 'stronger budget must not inherit the first truncated result');
  assert.equal(large.complete, true);
  assert.equal(large.schemaRecoveryMaxSchemas, 2);
  assert.equal(reads, 3, 'stronger producer must scan both candidates');
  assert.equal(app.schemas, large);

  const weaker = await recoverSchemasForUi(app, { budget:{ maxSchemas:0 } });
  assert.equal(weaker, large, 'complete result safely satisfies weaker requests');
  assert.equal(reads, 3);
  clearSchemaRecoveryTasks(app);
});

test('#2819 late weaker task cannot overwrite a completed stronger task', async () => {
  const pendingReads = [];
  const app = fixture(() => {
    const request = deferred();
    pendingReads.push(request);
    return request.promise;
  });

  const smallPending = recoverSchemasForUi(app, { budget:{ maxSchemas:1 } });
  await waitFor(() => pendingReads.length === 1, 'small-budget read');

  const largePending = recoverSchemasForUi(app, { budget:{ maxSchemas:2 } });
  await waitFor(() => pendingReads.length === 2, 'large-budget first read');

  pendingReads[1].resolve({ found:false });
  await waitFor(() => pendingReads.length === 3, 'large-budget second read');
  pendingReads[2].resolve({ found:false });
  const large = await largePending;
  assert.equal(large.complete, true);
  assert.equal(app.schemas, large);

  pendingReads[0].resolve({ found:false });
  const small = await smallPending;
  assert.equal(small.complete, false);
  assert.equal(app.schemas, large, 'late weak completion must not overwrite strong cache');

  const after = await recoverSchemasForUi(app, { budget:{ maxSchemas:2 } });
  assert.equal(after, large);
  assert.equal(pendingReads.length, 3);
  clearSchemaRecoveryTasks(app);
});
