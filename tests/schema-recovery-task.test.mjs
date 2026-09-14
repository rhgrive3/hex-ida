import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverSchemasForUi, clearSchemaRecoveryTasks } from '../js/analysis/schema-recovery-task.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  let cancelCount = 0;
  promise.cancel = () => { cancelCount++; };
  return { promise, resolve, reject, get cancelCount() { return cancelCount; } };
}

function fakeApp(stringsDeferred, programDeferred) {
  const starts = [];
  const app = {
    schemas:null,
    backend:{
      gen:1,
      readAt() { throw new Error('readAt should not run in this fixture'); },
    },
    store:{ get(key) { return key === 'architecture' ? 'arm64' : null; } },
    ensureStrings() { starts.push('strings'); return stringsDeferred.promise; },
    ensureProgram() { starts.push('program'); return programDeferred.promise; },
  };
  return { app, starts };
}

test('strings and ProgramIndex dependencies start independently instead of serially', async () => {
  const strings = deferred();
  const program = deferred();
  const { app, starts } = fakeApp(strings, program);
  const pending = recoverSchemasForUi(app);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(starts.sort(), ['program', 'strings']);
  strings.resolve([]);
  program.resolve({ unsupported:true, complete:false, incompleteReason:'fixture' });
  const result = await pending;
  assert.deepEqual([...result], []);
  assert.equal(app.schemas, result);
  clearSchemaRecoveryTasks(app);
});

test('closing the only schema consumer aborts schema work without cancelling shared global producers', async () => {
  const strings = deferred();
  const program = deferred();
  const { app } = fakeApp(strings, program);
  const controller = new AbortController();
  const pending = recoverSchemasForUi(app, { signal:controller.signal });
  await Promise.resolve();
  controller.abort('sheet-closed');
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.equal(strings.cancelCount, 0, 'shared string producer must not be globally cancelled');
  assert.equal(program.cancelCount, 0, 'shared ProgramIndex producer must not be globally cancelled');
  strings.resolve([]);
  program.resolve({ unsupported:true, complete:false });
  clearSchemaRecoveryTasks(app);
});

test('an aborted schema consumer never publishes a stale schema cache', async () => {
  const strings = deferred();
  const program = deferred();
  const { app } = fakeApp(strings, program);
  const controller = new AbortController();
  const pending = recoverSchemasForUi(app, { signal:controller.signal });
  await Promise.resolve();
  controller.abort('route-left');
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  strings.resolve([]);
  program.resolve({ unsupported:true, complete:false });
  await Promise.resolve();
  assert.equal(app.schemas, null);
  clearSchemaRecoveryTasks(app);
});
