// Regression for #5037: on an `onmessage` fallback transport, close() must
// detach exactly the message listeners it added and restore the previous
// handler, so repeated create/close cannot accumulate a wrapper chain.
import assert from 'node:assert/strict';
import {
  DEV_PARENT_RPC_PROTOCOL,
  createDevWorkerParentRpc,
  createDevWorkerParentRpcClient,
} from '../js/userscript/dev/parent-rpc.js';

const REQUEST_ID = `devrpc_${'a'.repeat(32)}`;

function fallbackPort() {
  const delivered = [];
  return {
    onmessage: null,
    postMessage(message) { delivered.push(message); },
    start() {},
    delivered,
  };
}

function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

// 1. Client close() on the fallback transport restores the previous handler.
{
  const port = fallbackPort();
  const base = () => {};
  port.onmessage = base;
  const client = createDevWorkerParentRpcClient({ port });
  assert.notEqual(port.onmessage, base, 'creating the client must install a message handler');
  client.close();
  assert.equal(port.onmessage, base, 'close() must restore the previous onmessage handler');
}

// 2. Repeated create/close cycles leave no wrapper chain behind.
{
  const port = fallbackPort();
  let baseCalls = 0;
  port.onmessage = () => { baseCalls += 1; };
  const base = port.onmessage;
  for (let i = 0; i < 5; i += 1) createDevWorkerParentRpcClient({ port }).close();
  assert.equal(port.onmessage, base, 'five create/close cycles must not accumulate wrappers');
  port.onmessage({ data: null });
  assert.equal(baseCalls, 1, 'the surviving handler must invoke the base handler exactly once');
}

// 3. A closed server on the fallback transport is not reachable from the port.
{
  const port = fallbackPort();
  let discovered = 0;
  const server = createDevWorkerParentRpc({
    port,
    runtime: { async discover() { discovered += 1; return []; } },
  });
  server.close();
  assert.equal(port.onmessage, null, 'server close() must restore the previous onmessage handler');
  port.onmessage?.({
    data: {
      protocol: DEV_PARENT_RPC_PROTOCOL,
      kind: 'request',
      id: REQUEST_ID,
      method: 'dev.worker.discover',
      params: {},
    },
  });
  await tick();
  assert.equal(discovered, 0, 'a closed server must not handle messages delivered through the port');
}

// 4. While open, the fallback server must still route both request and cancel.
{
  const port = fallbackPort();
  let gate;
  const gatePromise = new Promise((resolve) => { gate = resolve; });
  let aborted = 0;
  const server = createDevWorkerParentRpc({
    port,
    runtime: {
      async discover(_args, { signal } = {}) {
        await new Promise((resolve) => {
          signal.addEventListener('abort', () => { aborted += 1; resolve(); }, { once: true });
          gatePromise.then(resolve);
        });
        return [];
      },
    },
  });
  port.onmessage({
    data: {
      protocol: DEV_PARENT_RPC_PROTOCOL,
      kind: 'request',
      id: REQUEST_ID,
      method: 'dev.worker.discover',
      params: {},
    },
  });
  await tick();
  port.onmessage({
    data: {
      protocol: DEV_PARENT_RPC_PROTOCOL,
      kind: 'cancel',
      id: REQUEST_ID,
      method: 'dev.worker.discover',
    },
  });
  await tick();
  assert.equal(aborted, 1, 'the stacked fallback listeners must both receive messages');
  gate();
  await tick();
  assert.ok(
    port.delivered.some((message) => message?.id === REQUEST_ID && ['result', 'error'].includes(message.kind)),
    'the canceled request must settle with exactly one reply',
  );
  server.close();
  assert.equal(port.onmessage, null, 'reverse-order detach must fully unwind the server stack');
}

// 5. Detaching an older fallback listener must not clobber a newer one.
{
  const port = fallbackPort();
  let baseCalls = 0;
  port.onmessage = () => { baseCalls += 1; };
  const base = port.onmessage;
  const first = createDevWorkerParentRpcClient({ port });
  createDevWorkerParentRpcClient({ port });
  first.close();
  assert.notEqual(port.onmessage, base, 'closing an inner listener must not restore over the outer one');
  port.onmessage({ data: null });
  assert.equal(baseCalls, 1, 'the surviving chain must call the base handler exactly once');
}

// 6. The addEventListener transport path keeps its detach behavior.
{
  const added = [];
  const removed = [];
  const port = {
    postMessage() {},
    start() {},
    addEventListener(type, handler) { added.push({ type, handler }); },
    removeEventListener(type, handler) { removed.push({ type, handler }); },
  };
  const server = createDevWorkerParentRpc({ port, runtime: {} });
  assert.equal(added.length, 2);
  server.close();
  assert.equal(removed.length, 2, 'close() must remove both addEventListener handlers');
  for (const { type, handler } of added) {
    assert.ok(removed.some((entry) => entry.type === type && entry.handler === handler));
  }
}

console.log('issue #5037 fallback onmessage listener detach regressions PASS');
