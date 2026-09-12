import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

import {
  EMBED_PROTOCOL,
  EMBED_PROTOCOL_VERSION,
  createRpcClient,
  createRpcServer,
} from '../js/userscript/embed-protocol.js';

const unhandled = [];
const onUnhandled = (reason) => { unhandled.push(reason); };
process.on('unhandledRejection', onUnhandled);

await testThrowingEnumerableGetterDetails();
await testSideEffectGetterNotExecuted();
await testPlainDataDetailsPreserved();
await testCyclicDetails();
await testSanitizerFailureStillResponds();

process.off('unhandledRejection', onUnhandled);
assert.deepEqual(unhandled.map((reason) => reason?.message ?? String(reason)), [], 'server must not leak unhandled rejections');

console.log('issue 5023 embed error details accessor: ok');

async function testThrowingEnumerableGetterDetails() {
  const raw = rawServer({
    'chatgpt.status': () => {
      const details = { keep: 'yes' };
      Object.defineProperty(details, 'boom', {
        enumerable: true,
        get() { throw new Error('getter executed'); },
      });
      const error = new Error('handler failed');
      error.code = 'HANDLER_FAILED';
      error.details = details;
      throw error;
    },
  });
  const message = await rawRequest(raw.port, 'getter-throw', 'chatgpt.status');
  assert.equal(message.kind, 'error');
  assert.equal(message.error.code, 'HANDLER_FAILED');
  assert.equal(message.error.message, 'handler failed');
  assert.deepEqual({ ...message.error.details }, { keep: 'yes' });
  assert.equal(Object.hasOwn(message.error.details, 'boom'), false);
  assert.equal(await stillHealthy(raw.port, 'getter-throw-next'), 'healthy');
  raw.close();
}

async function testSideEffectGetterNotExecuted() {
  let recordAccesses = 0;
  let arrayAccesses = 0;
  const list = ['first'];
  Object.defineProperty(list, '1', {
    enumerable: true,
    get() { arrayAccesses += 1; return 'executed'; },
  });
  const raw = rawServer({
    'chatgpt.status': () => {
      const details = { note: 'plain' };
      Object.defineProperty(details, 'peek', {
        enumerable: true,
        get() { recordAccesses += 1; return 'secret'; },
      });
      details.list = list;
      const error = new Error('side effect host');
      error.code = 'SIDE_EFFECT';
      error.details = details;
      throw error;
    },
  });
  const message = await rawRequest(raw.port, 'getter-effect', 'chatgpt.status');
  assert.equal(message.error.code, 'SIDE_EFFECT');
  assert.equal(recordAccesses, 0);
  assert.equal(arrayAccesses, 0);
  assert.deepEqual({ ...message.error.details }, { note: 'plain', list: ['first', undefined] });
  assert.equal(Object.hasOwn(message.error.details, 'peek'), false);
  raw.close();
}

async function testPlainDataDetailsPreserved() {
  const details = {
    count: 2,
    label: 'plain',
    ok: true,
    missing: null,
    big: 10n,
    list: [1, 'two', [3]],
    nested: { deep: { deeper: { deepest: 'leaf' } } },
    stack: 'do-not-send',
    cause: 'do-not-send-either',
  };
  const raw = rawServer({
    'chatgpt.status': () => {
      const error = new Error('plain data');
      error.code = 'PLAIN_DATA';
      error.details = details;
      throw error;
    },
  });
  const message = await rawRequest(raw.port, 'plain-data', 'chatgpt.status');
  assert.equal(message.error.code, 'PLAIN_DATA');
  assert.deepEqual({ ...message.error.details }, {
    count: 2,
    label: 'plain',
    ok: true,
    missing: null,
    big: '10',
    list: [1, 'two', [3]],
    nested: { deep: { deeper: { deepest: 'leaf' } } },
  });
  assert.equal(Object.hasOwn(message.error.details, 'stack'), false);
  assert.equal(Object.hasOwn(message.error.details, 'cause'), false);
  raw.close();
}

async function testCyclicDetails() {
  const details = { name: 'root', list: [] };
  details.list.push(details);
  details.self = details;
  const raw = rawServer({
    'chatgpt.status': () => {
      const error = new Error('cyclic');
      error.code = 'CYCLIC';
      error.details = details;
      throw error;
    },
  });
  const message = await rawRequest(raw.port, 'cyclic', 'chatgpt.status');
  assert.equal(message.error.code, 'CYCLIC');
  assert.deepEqual({ ...message.error.details }, { name: 'root', list: [undefined] });
  assert.equal(Object.hasOwn(message.error.details, 'self'), false);
  raw.close();
}

async function testSanitizerFailureStillResponds() {
  const hostileDetails = rawServer({
    'chatgpt.status': () => {
      const error = new Error('details accessor hostile');
      error.code = 'HOSTILE_DETAILS';
      Object.defineProperty(error, 'details', {
        enumerable: true,
        get() { throw new Error('getter executed'); },
      });
      throw error;
    },
  });
  const message = await rawRequest(hostileDetails.port, 'hostile-details', 'chatgpt.status');
  assert.equal(message.kind, 'error');
  assert.equal(message.error.code, 'RPC_INTERNAL_ERROR');
  assert.equal(typeof message.error.message, 'string');
  assert.equal(message.error.message.length > 0, true);
  assert.equal(Object.hasOwn(message.error, 'details'), false);
  assert.equal(await stillHealthy(hostileDetails.port, 'hostile-details-next'), 'healthy');
  hostileDetails.close();

  const pair = rpcPair({
    'chatgpt.status': () => {
      const error = new Error('message accessor hostile');
      Object.defineProperty(error, 'message', {
        configurable: true,
        get() { throw new Error('getter executed'); },
      });
      throw error;
    },
    'chatgpt.capabilities': () => 'cap',
  }, { timeoutMs: 1000 });
  await assert.rejects(
    withDeadline(pair.client.call('chatgpt.status'), 'fixed RPC error'),
    (error) => error?.code === 'RPC_INTERNAL_ERROR',
  );
  assert.equal(await pair.client.call('chatgpt.capabilities'), 'cap');
  pair.close();
}

function rpcPair(handlers, options = {}) {
  const channel = new MessageChannel();
  const server = createRpcServer(channel.port1, { handlers, ...options.server });
  const client = createRpcClient(channel.port2, { timeoutMs: options.timeoutMs ?? 250 });
  return { client, server, close() { client.close(); server.close(); } };
}

function rawServer(handlers) {
  const channel = new MessageChannel();
  const server = createRpcServer(channel.port1, {
    handlers: { 'chatgpt.capabilities': () => 'healthy', ...handlers },
  });
  channel.port2.start();
  return { port: channel.port2, server, close() { server.close(); channel.port2.close(); } };
}

function request(id, method, params) {
  return { protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, kind: 'request', id, method, params };
}

function rawRequest(port, id, method, params) {
  const response = new Promise((resolve) => {
    port.addEventListener('message', (event) => resolve(event.data), { once: true });
  });
  port.postMessage(request(id, method, params));
  return withDeadline(response, `RPC response for ${id}`);
}

async function stillHealthy(port, id) {
  const message = await rawRequest(port, id, 'chatgpt.capabilities');
  assert.equal(message.kind, 'result');
  return message.result;
}

function withDeadline(promise, what) {
  let timer = null;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 250);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
