import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../js/adapters/index.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

{
  const blockedFetch = deferred();
  const fetchStarted = deferred();
  let firstFetch = true;
  let fetches = 0;
  const io = {
    fetch: async () => {
      fetches++;
      if (firstFetch) {
        firstFetch = false;
        fetchStarted.resolve();
        await blockedFetch.promise;
      }
      return { mn:'ret', ops:'' };
    },
    read: async () => null,
    isExecutable: () => true,
    symbolFor: () => null,
  };

  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  await adapter.launch({ address:0x1000n, objectAsArg0:false });

  const running = adapter.resume({ maxSteps:10 });
  await fetchStarted.promise;
  const fetchesBeforeStep = fetches;

  await assert.rejects(
    () => adapter.stepInto(),
    (error) => error?.code === 'already-running',
    'single-step must not enter an emulator owned by an active resume',
  );
  assert.equal(fetches, fetchesBeforeStep, 'rejected stepInto must not start a second instruction fetch');

  blockedFetch.resolve();
  await running;
  assert.equal(adapter.activeRun, null);
  assert.equal(adapter.running, false);

  await adapter.disconnect();
}

{
  const blockedFetch = deferred();
  const fetchStarted = deferred();
  let firstFetch = true;
  const io = {
    fetch: async () => {
      if (firstFetch) {
        firstFetch = false;
        fetchStarted.resolve();
        await blockedFetch.promise;
      }
      return { mn:'ret', ops:'' };
    },
    read: async () => null,
    isExecutable: () => true,
    symbolFor: () => null,
  };

  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  await adapter.launch({ address:0x1000n, objectAsArg0:false, registers:{x0:1n} });

  const stepping = adapter.stepInto();
  await fetchStarted.promise;
  await adapter.launch({ address:0x2000n, objectAsArg0:false, registers:{x0:22n} });
  blockedFetch.resolve();

  await assert.rejects(
    stepping,
    (error) => error?.code === 'stale-run',
    'a deferred single-step must not publish trace/state after a newer launch',
  );
  const registers = await adapter.readRegisters();
  assert.equal(registers.pc, 0x2000n);
  assert.equal(registers.x0, 22n);
  assert.deepEqual((await adapter.trace()).events, [], 'stale step completion must not append events to the new generation');
  assert.equal(adapter.activeRun, null);
  assert.equal(adapter.running, false);

  await adapter.disconnect();
}
