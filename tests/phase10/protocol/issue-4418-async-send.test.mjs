import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RUNTIME_PROVIDER_PROTOCOL,
  RUNTIME_PROVIDER_PROTOCOL_VERSION,
  RuntimeProviderProtocolClient,
} from '../../../js/runtime/provider-protocol.js';

function packet(type, extra = {}) {
  return {
    protocol: RUNTIME_PROVIDER_PROTOCOL,
    version: RUNTIME_PROVIDER_PROTOCOL_VERSION,
    type,
    ...extra,
  };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function drainUnhandledRejections() {
  await nextTurn();
  await nextTurn();
}

async function captureUnhandledRejections(callback) {
  const reasons = [];
  const listener = (reason) => reasons.push(reason);
  process.on('unhandledRejection', listener);
  try {
    return await callback(reasons);
  } finally {
    await drainUnhandledRejections();
    process.off('unhandledRejection', listener);
  }
}

function settleWithin(promise, milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'deadline' }), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ kind: 'value', value });
      },
      (error) => {
        clearTimeout(timer);
        resolve({ kind: 'error', error });
      },
    );
  });
}

class RecordingTransport {
  constructor(send = () => undefined) {
    this.sendImpl = send;
    this.sent = [];
    this.listener = null;
  }

  send(value) {
    this.sent.push(value);
    return this.sendImpl(value);
  }

  onMessage(listener) {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  receive(value) {
    return this.listener?.(value);
  }
}

function responseFor(request, result = { ok: true }) {
  return packet('response', { id: request.id, epoch: request.epoch, result });
}

test('#4418 sync send success keeps the request pending until its response', async () => {
  const transport = new RecordingTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 1000 });
  const pending = client.request('runtime.session.test', { input: 1 });
  const request = transport.sent[0];

  assert.equal(request.type, 'request');
  assert.equal(client.pending.size, 1);
  transport.receive(responseFor(request, { value: 1 }));
  assert.deepEqual(await pending, { value: 1 });
  assert.equal(client.pending.size, 0);
  client.close();
});

test('#4418 sync send exceptions reject immediately and remove pending state', async () => {
  const sendError = new Error('sync send failed');
  const transport = new RecordingTransport(() => {
    throw sendError;
  });
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 1000 });

  const pending = client.request('runtime.session.test');
  await assert.rejects(pending, (error) => error === sendError);
  assert.equal(client.pending.size, 0);
  client.close();
});

test('#4418 Promise.resolve transport sends do not settle the provider request', async () => {
  const transport = new RecordingTransport(() => Promise.resolve());
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 1000 });
  const pending = client.request('runtime.session.test');
  const request = transport.sent[0];

  await nextTurn();
  assert.equal(client.pending.size, 1);
  transport.receive(responseFor(request));
  assert.deepEqual(await pending, { ok: true });
  client.close();
});

test('#4418 Promise.reject transport sends reject immediately without an unhandled rejection', async () => {
  await captureUnhandledRejections(async (unhandled) => {
    const sendError = new Error('async send failed');
    const transport = new RecordingTransport((value) => value.type === 'request' ? Promise.reject(sendError) : undefined);
    const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 100 });

    try {
      const pending = client.request('runtime.session.test');
      const outcome = await settleWithin(pending, 50);
      assert.equal(outcome.kind, 'error');
      assert.equal(outcome.error, sendError);
      assert.equal(client.pending.size, 0);
      await drainUnhandledRejections();
      assert.deepEqual(unhandled, []);
    } finally {
      client.close();
      await drainUnhandledRejections();
    }
  });
});

test('#4418 Promise.reject transport sends preserve falsy rejection reasons', async () => {
  await captureUnhandledRejections(async (unhandled) => {
    for (const sendError of [null, undefined, false, 0, '']) {
      const transport = new RecordingTransport((value) => value.type === 'request' ? Promise.reject(sendError) : undefined);
      const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 100 });

      try {
        const outcome = await settleWithin(client.request('runtime.session.test'), 50);
        assert.equal(outcome.kind, 'error');
        assert.strictEqual(outcome.error, sendError);
        assert.equal(client.pending.size, 0);
      } finally {
        client.close();
        await drainUnhandledRejections();
      }
    }
    assert.deepEqual(unhandled, []);
  });
});

test('#4418 sync transport sends preserve falsy thrown reasons', async () => {
  for (const sendError of [null, undefined, false, 0, '']) {
    const transport = new RecordingTransport(() => {
      throw sendError;
    });
    const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 100 });

    try {
      const outcome = await settleWithin(client.request('runtime.session.test'), 50);
      assert.equal(outcome.kind, 'error');
      assert.strictEqual(outcome.error, sendError);
      assert.equal(client.pending.size, 0);
    } finally {
      client.close();
    }
  }
});

test('#4418 late send rejection after timeout cannot double-settle or become unhandled', async () => {
  await captureUnhandledRejections(async (unhandled) => {
    let rejectRequest;
    const transport = new RecordingTransport((value) => {
      if (value.type === 'request') {
        return new Promise((_, reject) => {
          rejectRequest = reject;
        });
      }
      if (value.type === 'cancel') return Promise.reject(new Error('cancel send failed'));
      return undefined;
    });
    const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 10 });

    try {
      const pending = client.request('runtime.session.test');
      await assert.rejects(pending, (error) => error?.code === 'timeout');
      assert.equal(client.pending.size, 0);
      assert.equal(typeof rejectRequest, 'function');

      rejectRequest(new Error('late request send failed'));
      await drainUnhandledRejections();
      assert.deepEqual(unhandled, []);
    } finally {
      client.close();
      await drainUnhandledRejections();
    }
  });
});

test('#4418 abort and epoch races clean up once while late send failures stay contained', async () => {
  await captureUnhandledRejections(async (unhandled) => {
    const requestRejectors = [];
    const transport = new RecordingTransport((value) => {
      if (value.type === 'request') {
        return new Promise((_, reject) => requestRejectors.push(reject));
      }
      if (value.type === 'cancel') return Promise.reject(new Error('cancel send failed'));
      return undefined;
    });
    const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 1000 });

    try {
      const controller = new AbortController();
      let abortSettlements = 0;
      const aborted = client.request('runtime.session.test', null, { signal: controller.signal }).then(
        () => ({ kind: 'resolved' }),
        (error) => {
          abortSettlements++;
          return { kind: 'rejected', error };
        },
      );
      const abortRequest = transport.sent.find((item) => item.type === 'request');
      controller.abort('fixture');
      const abortResult = await aborted;
      assert.equal(abortResult.kind, 'rejected');
      assert.equal(abortResult.error?.code, 'cancelled');
      assert.equal(abortSettlements, 1);
      assert.equal(client.pending.size, 0);
      assert.equal(transport.sent.filter((item) => item.type === 'cancel' && item.id === abortRequest.id).length, 1);
      requestRejectors.shift()(new Error('late abort send failed'));
      await drainUnhandledRejections();

      let epochSettlements = 0;
      const epochPending = client.request('runtime.session.test').then(
        () => ({ kind: 'resolved' }),
        (error) => {
          epochSettlements++;
          return { kind: 'rejected', error };
        },
      );
      const epochRequest = transport.sent.findLast((item) => item.type === 'request');
      client.setEpoch(2);
      const epochResult = await epochPending;
      assert.equal(epochResult.kind, 'rejected');
      assert.equal(epochResult.error?.code, 'cancelled');
      assert.equal(epochSettlements, 1);
      assert.equal(client.pending.size, 0);
      assert.equal(transport.sent.filter((item) => item.type === 'cancel' && item.id === epochRequest.id).length, 1);
      requestRejectors.shift()(new Error('late epoch send failed'));
      await drainUnhandledRejections();

      assert.deepEqual(unhandled, []);
    } finally {
      client.close();
      await drainUnhandledRejections();
    }
  });
});
