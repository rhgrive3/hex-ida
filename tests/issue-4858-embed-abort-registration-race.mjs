import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRpcClient, waitForEmbedReady } from '../js/userscript/embed-protocol.js';
import { waitForEmbedChildBootstrap } from '../js/userscript/embed-bootstrap.js';
import { createSandboxMonitor } from '../js/userscript/chatgpt-sandbox-host.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const VALID_TOKEN = 'ab'.repeat(32);

function registrationRaceSignal() {
  let aborted = false;
  let removals = 0;
  return {
    signal: {
      get aborted() { return aborted; },
      addEventListener(type) {
        assert.equal(type, 'abort');
        // Model the check -> listener-registration window: abort happens while
        // registration is in progress, but the already-fired event is not replayed.
        aborted = true;
      },
      removeEventListener(type) {
        assert.equal(type, 'abort');
        removals++;
      },
    },
    get removals() { return removals; },
  };
}

function registrationDeliveryRaceSignal() {
  let aborted = false;
  let removals = 0;
  return {
    signal: {
      get aborted() { return aborted; },
      addEventListener(type, listener) {
        assert.equal(type, 'abort');
        // Model an EventTarget that synchronously delivers abort while the
        // subscription call is still on the stack. The post-registration
        // recheck must not repeat cancellation after this callback settles.
        aborted = true;
        listener();
      },
      removeEventListener(type) {
        assert.equal(type, 'abort');
        removals++;
      },
    },
    get removals() { return removals; },
  };
}

function fakePort() {
  const posted = [];
  return {
    posted,
    postMessage(message) { posted.push(message); },
    close() {},
    start() {},
    addEventListener() {},
    removeEventListener() {},
  };
}

function messageTarget() {
  const listeners = new Set();
  return {
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
    dispatch(event) { for (const fn of [...listeners]) fn(event); },
    get messageListeners() { return listeners.size; },
  };
}

{
  const race = registrationRaceSignal();
  await assert.rejects(
    waitForEmbedReady(fakePort(), { nonce: VALID_TOKEN, timeoutMs: 20, signal: race.signal }),
    (error) => error?.code === 'RPC_ABORTED',
    'ready handshake must reject when abort races with listener registration',
  );
  assert.equal(race.removals, 1, 'ready abort listener must be removed exactly once');
}

{
  const race = registrationDeliveryRaceSignal();
  await assert.rejects(
    waitForEmbedReady(fakePort(), { nonce: VALID_TOKEN, timeoutMs: 20, signal: race.signal }),
    (error) => error?.code === 'RPC_ABORTED',
    'ready handshake must reject on synchronous abort delivery during registration',
  );
  assert.equal(race.removals, 1, 'ready settlement must remain exactly once when delivery and recheck both run');
}

{
  const controller = new AbortController();
  controller.abort('cancelled-before-ready');
  await assert.rejects(
    waitForEmbedReady(fakePort(), { nonce: VALID_TOKEN, timeoutMs: 20, signal: controller.signal }),
    (error) => error?.code === 'RPC_ABORTED',
    'already-aborted signal must reject ready wait immediately',
  );
}

{
  const race = registrationRaceSignal();
  const port = fakePort();
  const client = createRpcClient(port);
  await assert.rejects(
    client.call('chatgpt.request', { value: 'raced' }, { signal: race.signal, timeoutMs: 20 }),
    (error) => error?.code === 'RPC_ABORTED',
    'RPC call must reject when abort races with listener registration',
  );
  assert.equal(port.posted.length, 0,
    'no request or cancel envelope may be sent for a call aborted before the request was posted');
  assert.equal(race.removals, 1, 'RPC call abort listener must be removed exactly once');
}

{
  const race = registrationDeliveryRaceSignal();
  const port = fakePort();
  const client = createRpcClient(port);
  await assert.rejects(
    client.call('chatgpt.request', { value: 'sync' }, { signal: race.signal, timeoutMs: 20 }),
    (error) => error?.code === 'RPC_ABORTED',
    'RPC call must reject on synchronous abort delivery during registration',
  );
  assert.equal(port.posted.filter((message) => message.kind === 'request').length, 0,
    'a request must never be sent after abort settled the call during registration');
  assert.equal(port.posted.filter((message) => message.kind === 'cancel').length, 1,
    'the cancel path must find the pending entry and must fire exactly once');
  assert.equal(race.removals, 1, 'RPC call cancellation must remain exactly once after synchronous abort delivery');
}

{
  const controller = new AbortController();
  controller.abort('cancelled-before-call');
  const port = fakePort();
  const client = createRpcClient(port);
  await assert.rejects(
    client.call('chatgpt.request', { value: 'pre' }, { signal: controller.signal, timeoutMs: 20 }),
    (error) => error?.code === 'RPC_ABORTED',
    'already-aborted signal must reject RPC calls immediately',
  );
  assert.equal(port.posted.length, 0, 'an already-aborted call must not post anything');
}

{
  const controller = new AbortController();
  const port = fakePort();
  const client = createRpcClient(port);
  const pending = client.call('chatgpt.status', {}, { signal: controller.signal, timeoutMs: 100 });
  controller.abort('cancelled-after-send');
  await assert.rejects(pending, (error) => error?.code === 'RPC_ABORTED',
    'abort after the request was sent must still reject the call');
  assert.equal(port.posted.filter((message) => message.kind === 'request').length, 1,
    'a normal call must still send exactly one request envelope');
  assert.equal(port.posted.filter((message) => message.kind === 'cancel').length, 1,
    'a sent request must be cancelled with exactly one cancel envelope');
}

{
  const race = registrationRaceSignal();
  const parent = messageTarget();
  await assert.rejects(
    waitForEmbedChildBootstrap({
      windowRef: parent,
      expectedSource: {},
      childOrigin: 'https://worker.example',
      generation: '12',
      timeoutMs: 20,
      signal: race.signal,
    }),
    (error) => error?.code === 'EMBED_BOOTSTRAP_ABORTED' && error?.name === 'AbortError',
    'child bootstrap must reject when abort races with listener registration',
  );
  assert.equal(race.removals, 1, 'bootstrap abort listener must be removed exactly once');
  assert.equal(parent.messageListeners, 0, 'bootstrap message listener must be cleaned up exactly once');
}

{
  const race = registrationDeliveryRaceSignal();
  const parent = messageTarget();
  await assert.rejects(
    waitForEmbedChildBootstrap({
      windowRef: parent,
      expectedSource: {},
      childOrigin: 'https://worker.example',
      generation: '13',
      timeoutMs: 20,
      signal: race.signal,
    }),
    (error) => error?.code === 'EMBED_BOOTSTRAP_ABORTED' && error?.name === 'AbortError',
    'child bootstrap must reject on synchronous abort delivery during registration',
  );
  assert.equal(race.removals, 1, 'bootstrap settlement must remain exactly once when delivery and recheck both run');
  assert.equal(parent.messageListeners, 0, 'bootstrap message listener must stay cleaned up after synchronous delivery');
}

{
  const controller = new AbortController();
  controller.abort('cancelled-before-bootstrap');
  await assert.rejects(
    waitForEmbedChildBootstrap({
      windowRef: messageTarget(),
      expectedSource: {},
      childOrigin: 'https://worker.example',
      generation: '14',
      timeoutMs: 20,
      signal: controller.signal,
    }),
    (error) => error?.code === 'EMBED_BOOTSTRAP_ABORTED' && error?.name === 'AbortError',
    'already-aborted signal must reject child bootstrap immediately',
  );
}

{
  const race = registrationRaceSignal();
  const win = messageTarget();
  const monitor = createSandboxMonitor({
    windowRef: win,
    iframe: { contentWindow: {} },
    generation: 3,
    sandboxToken: VALID_TOKEN,
    timeoutMs: 20,
    signal: race.signal,
  });
  await assert.rejects(
    monitor.ready,
    (error) => error?.name === 'AbortError',
    'sandbox monitor ready must reject when abort races with listener registration',
  );
  const failure = await monitor.failure;
  assert.equal(failure?.name, 'AbortError', 'sandbox monitor failure must resolve with the abort error');
  assert.equal(race.removals, 1, 'sandbox monitor abort listener must be removed exactly once');
  assert.equal(win.messageListeners, 0, 'sandbox monitor message listener must be cleaned up exactly once');
}

{
  const controller = new AbortController();
  controller.abort('superseded-before-monitor');
  const win = messageTarget();
  const monitor = createSandboxMonitor({
    windowRef: win,
    iframe: { contentWindow: {} },
    generation: 4,
    sandboxToken: VALID_TOKEN,
    timeoutMs: 20,
    signal: controller.signal,
  });
  await assert.rejects(
    monitor.ready,
    (error) => error?.name === 'AbortError',
    'sandbox monitor must reject immediately for an already-aborted signal',
  );
  assert.equal(await monitor.failure instanceof Error, true,
    'sandbox monitor failure must resolve with the abort error for an already-aborted signal');
  assert.equal(win.messageListeners, 0, 'sandbox monitor listeners must be cleaned up for an already-aborted signal');
}

{
  const race = registrationDeliveryRaceSignal();
  const win = messageTarget();
  const monitor = createSandboxMonitor({
    windowRef: win,
    iframe: { contentWindow: {} },
    generation: 5,
    sandboxToken: VALID_TOKEN,
    timeoutMs: 20,
    signal: race.signal,
  });
  await assert.rejects(
    monitor.ready,
    (error) => error?.name === 'AbortError',
    'sandbox monitor must reject on synchronous abort delivery during registration',
  );
  await monitor.failure;
  assert.equal(race.removals, 1, 'sandbox monitor cleanup must remain exactly once when delivery and recheck both run');
  assert.equal(win.messageListeners, 0, 'sandbox monitor message listener must stay cleaned up after synchronous delivery');
}

{
  const win = messageTarget();
  const iframe = { contentWindow: {} };
  const monitor = createSandboxMonitor({
    windowRef: win,
    iframe,
    generation: 9,
    sandboxToken: VALID_TOKEN,
    timeoutMs: 1000,
  });
  win.dispatch({
    source: iframe.contentWindow,
    origin: 'null',
    data: {
      type: 'hex.embed.sandbox-ready',
      protocol: 'hex-embed-v1',
      version: 1,
      generation: '9',
      sandboxToken: VALID_TOKEN,
    },
  });
  const ready = await monitor.ready;
  assert.equal(ready.generation, '9', 'a non-aborted monitor must still resolve sandbox-ready normally');
  monitor.close();
}

console.log('issue 4858 userscript embed abort registration race: ok');
