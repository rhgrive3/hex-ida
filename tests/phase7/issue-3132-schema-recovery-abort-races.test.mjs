import test from 'node:test';
import assert from 'node:assert/strict';

import { recoverSchemasForUi, clearSchemaRecoveryTasks } from '../../js/analysis/schema-recovery-task.js';

function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

/*
 * Deterministic reproduction of the check->subscribe abort race: the consumer
 * signal is still live when the pre-check runs and reports `aborted` the
 * moment the listener is registered. A real AbortSignal dispatches no
 * retroactive event for that window, so without a post-registration recheck
 * the waiter hangs and the owned backend read keeps running.
 */
function raceSignal() {
  const listeners = [];
  return {
    aborted:false,
    reason:'sheet-closed',
    addEventListener(_type, listener) { listeners.push(listener); this.aborted = true; },
    removeEventListener(_type, listener) { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); },
  };
}

function timeoutRace(promise, label) {
  const timeout = new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${label}: abort was dropped in the check->subscribe window`)), 250));
  timeout.catch(() => {});
  return Promise.race([promise, timeout]);
}

function fakeApp() {
  let cancelled = 0;
  let readCalls = 0;
  let releaseRead;
  const app = {
    backend:{ gen:7, readAt(address, length) {
      readCalls += 1;
      const promise = new Promise((resolve) => { releaseRead = () => resolve({ found:true, bytes:new Uint8Array(length) }); });
      promise.cancel = () => { cancelled += 1; };
      return promise;
    } },
    ensureStrings:async () => Object.assign([{ addr:0x1000n, text:'data.csv' }], { complete:true }),
    ensureProgram:async () => ({
      complete:true,
      architecture:'arm64',
      functionsReferencing:() => [{ addr:0x2000n }],
      functionRange:() => ({ start:0x2000n, end:0x2100n }),
    }),
    store:{ get:() => null },
  };
  return { app, cancelled:() => cancelled, readCalls:() => readCalls, release:() => releaseRead?.() };
}

test('issue-3132: a consumer aborted between the pre-check and listener registration publishes nothing and issues no owned reads', async () => {
  const { app, readCalls, release } = fakeApp();
  const signal = raceSignal();
  const pending = recoverSchemasForUi(app, { signal, budget:{ maxSchemas:1 } });
  // Subscribe synchronously: the recheck path may reject before any yield.
  const assertion = assert.rejects(timeoutRace(pending, 'owned read'), (error) => error?.name === 'AbortError');
  await tick();
  await assertion;
  assert.equal(readCalls(), 0, 'an aborted consumer must never drive owned backend reads');
  assert.equal(app.schemas, undefined, 'aborted recovery must not publish a schema cache');
  release();
  clearSchemaRecoveryTasks(app);
});

test('issue-3132: a UI waiter aborted between the pre-check and listener registration still rejects', async () => {
  const { app, release } = fakeApp();
  const signal = raceSignal();
  const pending = recoverSchemasForUi(app, { signal, budget:{ maxSchemas:1 } });
  const assertion = assert.rejects(timeoutRace(pending, 'ui waiter'), (error) => error?.name === 'AbortError');
  await tick();
  await assertion;
  release();
  clearSchemaRecoveryTasks(app);
});
