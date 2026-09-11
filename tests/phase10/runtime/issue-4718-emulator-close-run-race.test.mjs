import assert from 'node:assert/strict';
import test from 'node:test';

import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve=res; });
  return { promise, resolve };
}

async function runCloseRace({ observeAbort }) {
  const gate=deferred();
  let markStarted;
  const started=new Promise((resolve) => { markStarted=resolve; });
  const engine={
    deterministic:true,
    async execute(_input, { signal }) {
      markStarted();
      await gate.promise;
      if (observeAbort && signal.aborted) throw new Error('engine observed abort');
      return { termination:'return', events:[] };
    },
    async disconnect() {},
  };
  const provider=new EmulatorProvider(engine);
  const session=await provider.openSession({ binaryId:'bin-4718', sessionNonce:`race-${observeAbort ? 'abort' : 'ignore'}` });
  const running=session.facets.emulator.run({});
  await started;

  const closing=session.close();
  assert.equal(session.state,'closing');
  await closing;
  assert.equal(session.closed,true);
  assert.equal(session.state,'closed');

  gate.resolve();
  await assert.rejects(
    running,
    (error) => error?.code==='runtime-session-stale' && error.details?.termination==='cancelled',
  );
  assert.equal(session.state,'closed');
  assert.equal(provider.activeSession,null);
  await assert.rejects(
    () => session.facets.emulator.replay(),
    (error) => error?.code==='emulator-replay-missing',
  );
}

test('P10 EmulatorProvider does not publish a run after close observes abort (#4718)', async () => {
  await runCloseRace({ observeAbort:true });
});

test('P10 EmulatorProvider does not publish a run when engine ignores close abort (#4718)', async () => {
  await runCloseRace({ observeAbort:false });
});
