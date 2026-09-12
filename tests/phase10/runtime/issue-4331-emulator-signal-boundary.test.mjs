import assert from 'node:assert/strict';
import test from 'node:test';

import { DebugAdapterError } from '../../../js/debug/adapter.js';
import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';

function providerFor(execute) {
  return new EmulatorProvider({
    id: 'issue-4331-engine',
    version: '1',
    execute,
  });
}

function invalidSignal(error) {
  return error instanceof DebugAdapterError && error.code === 'invalid-signal';
}

test('#4331 rejects malformed external signals before engine/controller work', async () => {
  const malformed = [
    {},
    { aborted: false },
    { aborted: 'false', addEventListener() {}, removeEventListener() {} },
    { aborted: false, addEventListener: null, removeEventListener() {} },
    { aborted: false, addEventListener() {}, removeEventListener: null },
    false,
    true,
    0,
    1,
    '',
    'abort',
  ];

  for (const signal of malformed) {
    let executeCalls = 0;
    const provider = providerFor(async () => {
      executeCalls += 1;
      return { termination: 'return' };
    });
    const session = await provider.openSession(
      { binaryId: 'bin-4331', sessionNonce: `malformed-${typeof signal}` },
      { connect: false },
    );

    await assert.rejects(
      () => session.facets.emulator.run({}, { signal }),
      invalidSignal,
    );
    assert.equal(executeCalls, 0, 'malformed signal must be rejected before engine execution');
    assert.equal(session.controllers.size, 0, 'malformed signal must not leak a runtime controller');
    await session.close();
  }
});


test('#4331 malformed aborted getter fails before controller allocation', async () => {
  let executeCalls = 0;
  const signal = {
    get aborted() {
      throw new Error('aborted getter failed');
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const provider = providerFor(async () => {
    executeCalls += 1;
    return { termination: 'return' };
  });
  const session = await provider.openSession(
    { binaryId: 'bin-4331', sessionNonce: 'getter-failure' },
    { connect: false },
  );

  await assert.rejects(
    () => session.facets.emulator.run({}, { signal }),
    invalidSignal,
  );
  assert.equal(executeCalls, 0);
  assert.equal(session.controllers.size, 0);
  await session.close();
});

test('#4331 post-listener signal invalidation detaches and releases controller', async () => {
  let abortedReads = 0;
  let removeCalls = 0;
  let executeCalls = 0;
  let installedListener = null;
  const signal = {
    get aborted() {
      abortedReads += 1;
      return abortedReads === 1 ? false : 'invalid-after-subscribe';
    },
    addEventListener(_type, listener) {
      installedListener = listener;
    },
    removeEventListener(_type, listener) {
      removeCalls += 1;
      assert.equal(listener, installedListener);
    },
  };
  const provider = providerFor(async () => {
    executeCalls += 1;
    return { termination: 'return' };
  });
  const session = await provider.openSession(
    { binaryId: 'bin-4331', sessionNonce: 'post-listener-invalid' },
    { connect: false },
  );

  await assert.rejects(
    () => session.facets.emulator.run({}, { signal }),
    invalidSignal,
  );
  assert.equal(executeCalls, 0);
  assert.equal(removeCalls, 1);
  assert.equal(session.controllers.size, 0);
  await session.close();
});

test('#4331 listener setup failure is canonical and cleanup-safe', async () => {
  let executeCalls = 0;
  let removeCalls = 0;
  const signal = {
    aborted: false,
    addEventListener() {
      throw new Error('listener setup failed');
    },
    removeEventListener() {
      removeCalls += 1;
    },
  };
  const provider = providerFor(async () => {
    executeCalls += 1;
    return { termination: 'return' };
  });
  const session = await provider.openSession(
    { binaryId: 'bin-4331', sessionNonce: 'setup-failure' },
    { connect: false },
  );

  await assert.rejects(
    () => session.facets.emulator.run({}, { signal }),
    invalidSignal,
  );
  assert.equal(executeCalls, 0);
  assert.equal(removeCalls, 1, 'setup failure should best-effort detach a possibly installed listener');
  assert.equal(session.controllers.size, 0);
  await session.close();
});

test('#4331 cleanup failure cannot mask a completed run or leak its controller', async () => {
  let removeCalls = 0;
  const signal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() {
      removeCalls += 1;
      throw new Error('listener cleanup failed');
    },
  };
  const provider = providerFor(async () => ({ termination: 'return' }));
  const session = await provider.openSession(
    { binaryId: 'bin-4331', sessionNonce: 'cleanup-failure' },
    { connect: false },
  );

  const result = await session.facets.emulator.run({}, { signal });
  assert.equal(result.termination, 'return');
  assert.equal(removeCalls, 1);
  assert.equal(session.controllers.size, 0);
  await session.close();
});

test('#4331 preserves real AbortSignal pre-abort and in-flight cancellation', async () => {
  {
    let executeCalls = 0;
    const provider = providerFor(async () => {
      executeCalls += 1;
      return { termination: 'return' };
    });
    const session = await provider.openSession(
      { binaryId: 'bin-4331', sessionNonce: 'pre-abort' },
      { connect: false },
    );
    const external = new AbortController();
    external.abort();

    const result = await session.facets.emulator.run({}, { signal: external.signal });
    assert.equal(executeCalls, 0);
    assert.equal(result.termination, 'cancelled');
    assert.equal(result.completeness, 'truncated');
    assert.equal(session.controllers.size, 0);
    await session.close();
  }

  {
    let releaseEngine;
    const provider = providerFor(async () => new Promise((resolve) => {
      releaseEngine = () => resolve({ termination: 'return' });
    }));
    const session = await provider.openSession(
      { binaryId: 'bin-4331', sessionNonce: 'in-flight-abort' },
      { connect: false },
    );
    const external = new AbortController();
    const pending = session.facets.emulator.run({}, { signal: external.signal, timeoutMs: 1000 });
    await new Promise((resolve) => setImmediate(resolve));
    external.abort();

    const result = await pending;
    assert.equal(result.termination, 'cancelled');
    assert.equal(result.completeness, 'truncated');
    assert.equal(session.controllers.size, 0);
    releaseEngine();
    await new Promise((resolve) => setImmediate(resolve));
    await session.close();
  }
});
