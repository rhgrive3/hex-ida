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

await testSharedObjectKeptInBothFields();
await testSharedObjectKeptInEveryArraySlot();
await testNestedSharedDagKept();
await testTrueCycleStillCut();
await testSharedObjectAfterCycleBranchIsKept();
await testSharedObjectSurvivesClientReceivePath();
await testFailClosedGuardsStayIntact();

console.log('issue 5020 shared-reference error details: ok');

async function testSharedObjectKeptInBothFields() {
  const shared = { value: 1, label: 'shared' };
  const raw = rawServer({
    'chatgpt.status': () => {
      const error = new Error('shared-details');
      error.code = 'SHARED_DETAILS';
      error.details = { first: shared, second: shared };
      throw error;
    },
  });
  const message = await rawRequest(raw.port, 'alias-1', 'chatgpt.status');
  assert.equal(message.kind, 'error', 'server must answer with an error envelope');
  assert.equal(message.error.code, 'SHARED_DETAILS');
  assert.deepEqual(wire(message.error.details), {
    first: { value: 1, label: 'shared' },
    second: { value: 1, label: 'shared' },
  }, 'a plain shared reference is not a cycle: both fields must survive');
  raw.close();
}

async function testSharedObjectKeptInEveryArraySlot() {
  const shared = { value: 7 };
  const list = [shared, shared, shared];
  const raw = rawServer({
    'chatgpt.status': () => {
      const error = new Error('shared-list');
      error.code = 'SHARED_LIST';
      error.details = { list, again: list };
      throw error;
    },
  });
  const message = await rawRequest(raw.port, 'alias-2', 'chatgpt.status');
  assert.equal(message.kind, 'error');
  assert.deepEqual(wire(message.error.details), {
    list: [{ value: 7 }, { value: 7 }, { value: 7 }],
    again: [{ value: 7 }, { value: 7 }, { value: 7 }],
  }, 'repeated occurrences inside arrays must each serialize');
  raw.close();
}

async function testNestedSharedDagKept() {
  const leaf = { note: 'leaf' };
  const branch = { leaf, tag: 'branch' };
  const raw = rawServer({
    'chatgpt.status': () => {
      const error = new Error('nested-dag');
      error.code = 'NESTED_DAG';
      error.details = {
        one: branch,
        two: { leaf },
        three: [branch, { leaf }, leaf],
      };
      throw error;
    },
  });
  const message = await rawRequest(raw.port, 'alias-3', 'chatgpt.status');
  assert.equal(message.kind, 'error');
  assert.deepEqual(wire(message.error.details), {
    one: { leaf: { note: 'leaf' }, tag: 'branch' },
    two: { leaf: { note: 'leaf' } },
    three: [{ leaf: { note: 'leaf' }, tag: 'branch' }, { leaf: { note: 'leaf' } }, { note: 'leaf' }],
  }, 'a shared subgraph reached from several branches must serialize in every branch');
  raw.close();
}

async function testTrueCycleStillCut() {
  const self = { name: 'root' };
  self.self = self;
  const left = { tag: 'left' };
  const right = { tag: 'right' };
  left.right = right;
  right.left = left;
  const loop = [1];
  loop.push(loop);
  const raw = rawServer({
    'chatgpt.status': () => {
      const error = new Error('real-cycle');
      error.code = 'REAL_CYCLE';
      error.details = { self, mutual: left, loop, plain: { kept: true } };
      throw error;
    },
  });
  const message = await rawRequest(raw.port, 'cycle-1', 'chatgpt.status');
  assert.equal(message.kind, 'error');
  assert.deepEqual(wire(message.error.details), {
    self: { name: 'root' },
    mutual: { tag: 'left', right: { tag: 'right' } },
    loop: [1, null],
    plain: { kept: true },
  }, 'ancestor cycles must stay cut without swallowing sibling data');
  raw.close();
}

async function testSharedObjectAfterCycleBranchIsKept() {
  const shared = { value: 9 };
  const cyclic = { shared };
  cyclic.loop = cyclic;
  const raw = rawServer({
    'chatgpt.status': () => {
      const error = new Error('cycle-then-alias');
      error.code = 'CYCLE_THEN_ALIAS';
      error.details = { before: shared, cyclic, after: shared };
      throw error;
    },
  });
  const message = await rawRequest(raw.port, 'cycle-2', 'chatgpt.status');
  assert.equal(message.kind, 'error');
  assert.deepEqual(wire(message.error.details), {
    before: { value: 9 },
    cyclic: { shared: { value: 9 } },
    after: { value: 9 },
  }, 'a cycle in one branch must not mark a shared object as seen forever');
  raw.close();
}

async function testSharedObjectSurvivesClientReceivePath() {
  const channel = new MessageChannel();
  const client = createRpcClient(channel.port1, { timeoutMs: 200 });
  channel.port2.start();
  channel.port2.addEventListener('message', (event) => {
    const message = event?.data;
    if (message?.kind !== 'request') return;
    const shared = { value: 1 };
    channel.port2.postMessage({
      protocol: EMBED_PROTOCOL,
      version: EMBED_PROTOCOL_VERSION,
      kind: 'error',
      id: message.id,
      method: message.method,
      error: { code: 'REMOTE_SHARED', message: 'remote failed', details: { first: shared, second: shared } },
    });
  });
  await assert.rejects(client.call('chatgpt.status'), (error) => {
    assert.equal(error.code, 'REMOTE_SHARED');
    assert.deepEqual(wire(error.details), { first: { value: 1 }, second: { value: 1 } },
      'the client-side error sanitizer must keep shared references too');
    return true;
  });
  client.close();
  channel.port2.close();
}

async function testFailClosedGuardsStayIntact() {
  const secret = { stack: 'secret-stack', cause: 'secret-cause', keep: 'yes' };
  const weird = new Map([['hostile', 'value']]);
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  const wide = Array.from({ length: 65 }, (_unused, index) => index);
  const raw = rawServer({
    'chatgpt.status': () => {
      const error = new Error('guards');
      error.code = 'GUARDS';
      error.details = {
        secret,
        again: secret,
        nestedError: new Error('do-not-leak'),
        notPlain: weird,
        alsoNotPlain: { map: weird },
        deep,
        wide,
      };
      throw error;
    },
  });
  const message = await rawRequest(raw.port, 'guards-1', 'chatgpt.status');
  assert.equal(message.kind, 'error');
  const text = JSON.stringify(message.error.details);
  assert.doesNotMatch(text, /secret-stack|secret-cause|do-not-leak|hostile/i);
  assert.deepEqual(wire(message.error.details), {
    secret: { keep: 'yes' },
    again: { keep: 'yes' },
    alsoNotPlain: {},
    deep: { a: { b: {} } },
    wide: wide.slice(0, 64),
  }, 'depth, width, key and non-plain-record guards must keep failing closed');
  raw.close();
}

function wire(value) { return JSON.parse(JSON.stringify(value ?? null)); }

function rawServer(handlers, options = {}) {
  const channel = new MessageChannel();
  const server = createRpcServer(channel.port1, { handlers, ...options });
  channel.port2.start();
  return { port: channel.port2, server, close() { server.close(); channel.port2.close(); } };
}

function onceMessage(port) { return new Promise((resolve) => port.addEventListener('message', (event) => resolve(event.data), { once: true })); }

async function rawRequest(port, id, method, params) {
  const responsePromise = onceMessage(port);
  port.postMessage({ protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, kind: 'request', id, method, params });
  return responsePromise;
}
