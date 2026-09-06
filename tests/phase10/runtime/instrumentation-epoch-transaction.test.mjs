import assert from 'node:assert/strict';
import test from 'node:test';
import { InstrumentationProvider } from '../../../js/runtime/instrumentation-provider.js';

function eventEpoch(session) {
  return session.facets.instrumentation.events.ingest({ kind: 'trace-marker' }).sessionEpoch;
}

test('instrumentation epoch transition is failure-atomic for synchronous backend failure', async () => {
  const provider = new InstrumentationProvider({
    setEpoch() { throw new Error('sync epoch update failed'); },
  });
  const session = await provider.openSession({ binaryId: 'bin_epoch_sync_fail' });
  assert.equal(session.epoch, 1);
  assert.throws(() => session.newProviderEpoch(), /sync epoch update failed/);
  assert.equal(session.epoch, 1);
  assert.equal(eventEpoch(session), 1);
  await session.close();
});

test('instrumentation epoch transition is failure-atomic for asynchronous backend rejection', async () => {
  const provider = new InstrumentationProvider({
    async setEpoch() { throw new Error('async epoch update failed'); },
  });
  const session = await provider.openSession({ binaryId: 'bin_epoch_async_fail' });
  await assert.rejects(session.newProviderEpoch(), /async epoch update failed/);
  assert.equal(session.epoch, 1);
  assert.equal(eventEpoch(session), 1);
  await session.close();
});

test('instrumentation epoch commits only after asynchronous backend success and rejects overlap', async () => {
  let resolveEpoch;
  let requestedEpoch = null;
  const provider = new InstrumentationProvider({
    setEpoch(next) {
      requestedEpoch = next;
      return new Promise((resolve) => { resolveEpoch = resolve; });
    },
  });
  const session = await provider.openSession({ binaryId: 'bin_epoch_async_success' });
  const pending = session.newProviderEpoch('async-success');
  assert.equal(requestedEpoch, 2);
  assert.equal(session.epoch, 1);
  assert.equal(eventEpoch(session), 1);
  assert.throws(() => session.newProviderEpoch(), /epoch transition is already in progress/);
  resolveEpoch();
  assert.equal(await pending, 2);
  assert.equal(session.epoch, 2);
  assert.equal(eventEpoch(session), 2);
  await session.close();
});

test('instrumentation epoch preserves synchronous backend return compatibility', async () => {
  const provider = new InstrumentationProvider({ setEpoch(next) { return next; } });
  const session = await provider.openSession({ binaryId: 'bin_epoch_sync_success' });
  assert.equal(session.newProviderEpoch('sync-success'), 2);
  assert.equal(session.epoch, 2);
  assert.equal(eventEpoch(session), 2);
  await session.close();
});
