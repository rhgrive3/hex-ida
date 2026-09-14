import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AiSession } from '../js/ai/ui/session.js';
import { launcherStateForSessionEvent } from '../js/ai/ui/launcher-state.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function observeLauncher(session, { open }) {
  const launcher = { state: 'idle', unread: 0 };
  session.on((event) => {
    const state = launcherStateForSessionEvent(event.type, session.busy);
    if (state) launcher.state = state;
    if (event.type === 'settled' && state === 'idle' && !open) {
      launcher.unread += 1;
      launcher.state = 'attention';
    }
  });
  return launcher;
}

async function assertProductionWiring() {
  const source = await readFile(new URL('../js/ai/ui/assistant.js', import.meta.url), 'utf8');
  assert.match(source, /launcherStateForSessionEvent\(event\.type, session\.busy\)/,
    'assistant launcher state must derive from the current session busy authority');
  assert.match(source, /event\.type === 'settled' && launcherState === 'idle' && !open/,
    'stale settled events must not mint unread/attention while another turn is active');
}

async function runLateSettlementCase(kind, { open }) {
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
  const launcher = observeLauncher(session, { open });
  const a = session.ask('first', { context: {} });
  await Promise.resolve();
  const firstController = session.controller;
  assert.ok(firstController, 'turn A must own an AbortController');
  assert.equal(session.busy, true);
  assert.equal(launcher.state, 'running');

  assert.equal(session.cancel(), true);
  assert.equal(session.busy, false, 'cancel keeps immediate retry behavior');

  const b = session.ask('second', { context: {} });
  await Promise.resolve();
  const secondController = session.controller;
  assert.ok(secondController, 'turn B must own an AbortController');
  assert.notEqual(secondController, firstController);
  assert.equal(session.busy, true);
  assert.equal(launcher.state, 'running');

  if (kind === 'resolve') first.resolve({ answer: 'late first' });
  else first.reject(new Error('late first failure'));

  const aTurn = await a;
  assert.equal(aTurn.status, 'cancelled');
  assert.equal(session.controller, secondController, 'late A settlement must not clear B controller');
  assert.equal(session.busy, true, 'late A settlement must not make B look idle');
  assert.equal(launcher.state, 'running', 'late A settled event must not idle/attention the launcher while B is active');
  assert.equal(launcher.unread, 0, 'stale A settlement must not create unread attention while B is active');

  assert.equal(await session.ask('third', { context: {} }), null, 'turn C must be rejected while B is active');
  assert.equal(calls, 2, 'rejected turn C must not reach the engine');
  assert.equal(launcher.state, 'running');

  second.resolve({ answer: 'second done' });
  const bTurn = await b;
  assert.equal(bTurn.status, 'done');
  assert.equal(session.controller, null, 'B settlement clears its own controller');
  assert.equal(session.busy, false, 'B settlement clears busy');
  assert.equal(launcher.state, open ? 'idle' : 'attention', 'only B settlement may end the running launcher state');
  assert.equal(launcher.unread, open ? 0 : 1, 'closed launcher gets exactly one unread marker for B');
}

await assertProductionWiring();
await runLateSettlementCase('resolve', { open: true });
await runLateSettlementCase('reject', { open: false });

console.log('[ai] issue #3801 AI session cancel settlement race passed');
