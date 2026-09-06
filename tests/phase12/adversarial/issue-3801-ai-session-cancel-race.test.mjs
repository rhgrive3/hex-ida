import assert from 'node:assert/strict';
import { AiSession } from '../../../js/ai/ui/session.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function runLateSettlementCase(kind) {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const engine = {
    run() {
      calls++;
      if (calls === 1) return first.promise;
      if (calls === 2) return second.promise;
      throw new Error(`unexpected engine call ${calls}`);
    },
  };

  const session = new AiSession({ engine, storage: null });
  const a = session.ask('first', { context: {} });
  await Promise.resolve();
  const firstController = session.controller;
  assert.ok(firstController, 'turn A must own an AbortController');
  assert.equal(session.busy, true);

  assert.equal(session.cancel(), true);
  assert.equal(session.busy, false, 'cancel keeps immediate retry behavior');

  const b = session.ask('second', { context: {} });
  await Promise.resolve();
  const secondController = session.controller;
  assert.ok(secondController, 'turn B must own an AbortController');
  assert.notEqual(secondController, firstController);
  assert.equal(session.busy, true);

  if (kind === 'resolve') first.resolve({ answer: 'late first' });
  else first.reject(new Error('late first failure'));

  const aTurn = await a;
  assert.equal(aTurn.status, 'cancelled');
  assert.equal(session.controller, secondController, 'late A settlement must not clear B controller');
  assert.equal(session.busy, true, 'late A settlement must not make B look idle');

  assert.equal(await session.ask('third', { context: {} }), null, 'turn C must be rejected while B is active');
  assert.equal(calls, 2, 'rejected turn C must not reach the engine');

  second.resolve({ answer: 'second done' });
  const bTurn = await b;
  assert.equal(bTurn.status, 'done');
  assert.equal(session.controller, null, 'B settlement clears its own controller');
  assert.equal(session.busy, false, 'B settlement clears busy');
}

await runLateSettlementCase('resolve');
await runLateSettlementCase('reject');

console.log('[phase12] issue #3801 AI session cancel settlement race passed');
