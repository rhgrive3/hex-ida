// Regression for #5688: a closed DebugSession must fail closed on
// controller()/newEpoch() — it may not mint fresh abort controllers or
// re-enter the adapter's epoch API after disconnect().
import assert from 'node:assert/strict';
import { DebugSession } from '../js/runtime/session.js';

const epochCalls = [];
const adapter = {
  id: 'stub', kind: 'stub', capabilities: { connect: true, disconnect: true },
  async connect() {},
  setEpoch(value) { epochCalls.push(value); },
  async disconnect() {},
};

const session = new DebugSession(adapter, { binaryHash: 'bin' });
await session.connect();
assert.equal(session.controller().signal.aborted, false, 'a live session mints open controllers');
session.newEpoch();
await session.disconnect();
assert.equal(session.closed, true);
const epochCallsAtDisconnect = epochCalls.length;
const epochAtDisconnect = session.epoch;
const controllersAtDisconnect = session.controllers.size;

assert.throws(() => session.controller(), (error) => error.code === 'session-closed',
  'controller() must reject on a closed session');
assert.throws(() => session.newEpoch(), (error) => error.code === 'session-closed',
  'newEpoch() must reject on a closed session');
assert.equal(epochCalls.length, epochCallsAtDisconnect, 'the adapter epoch API must not be re-entered after disconnect');

// A live session keeps the existing controller/newEpoch contract.
{
  const adapter2 = {
    id: 'stub2', kind: 'stub2', capabilities: { connect: true, disconnect: true },
    async connect() {}, setEpoch(value) { epochCalls.push(value); }, async disconnect() {},
  };
  const live = new DebugSession(adapter2, { binaryHash: 'bin' });
  await live.connect();
  const controller = live.controller();
  live.newEpoch();
  assert.equal(controller.signal.aborted, true, 'newEpoch still cancels outstanding controllers');
  assert.equal(typeof live.controller().signal.aborted, 'boolean');
  await live.disconnect();
}

console.log('issue #5688 closed-session guards regressions PASS');
