import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RuntimeProviderPlatform,
  RuntimeProviderSession,
} from '../../../js/runtime/provider-platform.js';

function makeProvider(id, closeFactory) {
  let ordinal = 0;
  const provider = {
    descriptor() {
      return { id, version: '1', kind: 'test', facets: [] };
    },
    async openSession(request = {}) {
      ordinal++;
      const session = new RuntimeProviderSession({
        provider,
        request: {
          binaryId: request.binaryId ?? 'binary-A',
          sessionNonce: request.sessionNonce ?? `session-${ordinal}`,
        },
        facets: {},
      });
      session.setState('ready');
      session.close = closeFactory({ session, request, ordinal });
      return session;
    },
  };
  return provider;
}

function markClosed(session) {
  session.closed = true;
  session.state = 'closed';
}

test('P10 RuntimeProviderPlatform keeps a failed close retryable (#4626)', async () => {
  const platform = new RuntimeProviderPlatform();
  let attempts = 0;
  platform.register(makeProvider('retry-close', ({ session }) => async () => {
    attempts++;
    if (attempts === 1) throw new Error('transient close failure');
    markClosed(session);
  }));

  const session = await platform.openSession('retry-close', {
    binaryId: 'binary-A',
    sessionNonce: 'retry',
  });

  await assert.rejects(platform.closeSession(session.runtimeSessionId), /transient close failure/);
  assert.equal(attempts, 1);
  assert.equal(platform.getSession(session.runtimeSessionId), session);
  assert.equal(platform.current, session);

  assert.equal(await platform.closeSession(session.runtimeSessionId), true);
  assert.equal(attempts, 2);
  assert.equal(platform.getSession(session.runtimeSessionId), null);
  assert.equal(platform.current, null);

  await session.close();
  assert.equal(attempts, 2, 'successful close remains idempotent');
});

test('P10 RuntimeProviderPlatform single-flights concurrent closes (#4626)', async () => {
  const platform = new RuntimeProviderPlatform();
  let attempts = 0;
  let releaseClose;
  const gate = new Promise((resolve) => { releaseClose = resolve; });
  platform.register(makeProvider('single-flight-close', ({ session }) => async () => {
    attempts++;
    await gate;
    markClosed(session);
  }));

  const session = await platform.openSession('single-flight-close', {
    binaryId: 'binary-A',
    sessionNonce: 'concurrent',
  });
  const first = session.close();
  const second = session.close();

  await Promise.resolve();
  assert.equal(attempts, 1, 'backend close must run once while a close is in flight');
  releaseClose();
  await Promise.all([first, second]);

  assert.equal(attempts, 1);
  assert.equal(platform.getSession(session.runtimeSessionId), null);
  assert.equal(platform.current, null);
});

test('P10 RuntimeProviderPlatform closeAll retains failed sessions for retry (#4626)', async () => {
  const platform = new RuntimeProviderPlatform();
  const attempts = new Map();
  let allowFailedClose = false;
  platform.register(makeProvider('close-all-retry', ({ session, request }) => async () => {
    const key = request.sessionNonce;
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
    if (key === 'failed' && !allowFailedClose) throw new Error('close-all transient failure');
    markClosed(session);
  }));

  const successful = await platform.openSession('close-all-retry', {
    binaryId: 'binary-A',
    sessionNonce: 'successful',
  });
  const failed = await platform.openSession('close-all-retry', {
    binaryId: 'binary-A',
    sessionNonce: 'failed',
  });
  assert.equal(platform.current, failed);

  await platform.closeAll();

  assert.equal(platform.getSession(successful.runtimeSessionId), null);
  assert.equal(platform.getSession(failed.runtimeSessionId), failed);
  assert.equal(platform.current, failed, 'failed current session remains reachable');
  assert.equal(attempts.get('successful'), 1);
  assert.equal(attempts.get('failed'), 1);

  allowFailedClose = true;
  await platform.closeAll();

  assert.equal(attempts.get('failed'), 2);
  assert.equal(platform.getSession(failed.runtimeSessionId), null);
  assert.equal(platform.current, null);
});
