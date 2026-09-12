import assert from 'node:assert/strict';
import { installDevBootstrapHost } from '../js/userscript/dev/bootstrap-host.js';

const COMMIT = 'a'.repeat(40);
const BUILD = 'b'.repeat(24);
const TOKEN = 'c'.repeat(64);
const HANDOFF = { checkpoint: { runId: 'issue-5048' } };

const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(String(reason?.message || reason)); });

await testFailedReloadNotifiesAndRestoresRetry();
await testStaleGenerationFailureDoesNotTouchCurrentFrame();
await testSynchronousReloadThrowIsRecovered();
await testSuccessfulReloadStaysOneShot();
assert.deepEqual(unhandled, [], 'reload rejections must be reclaimed by the bootstrap host');

console.log('issue-5048 bootstrap reload failure recovery tests passed');

async function testFailedReloadNotifiesAndRestoresRetry() {
  const parent = fakeWindow();
  const first = fakeChild();
  const second = fakeChild();
  let iframe = frame(first, '1');
  let calls = 0;
  const host = {
    get iframe() { return iframe; },
    reload() {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('pre-start reload failure'));
      iframe = frame(second, '2');
      return Promise.resolve();
    },
  };
  const installed = installDevBootstrapHost({ host, runtimeIdentity: { commit: COMMIT, buildId: BUILD }, windowRef: parent });

  requestReload(parent, installed, first, '1');
  assert.deepEqual(first.messages.at(-1), {
    protocol: installed.protocol, type: 'hex.dev.bootstrap.reload-accepted', generation: '1', sandboxToken: TOKEN,
  });
  await delay(10);
  assert.equal(calls, 1);
  const failure = first.messages.find((message) => message.type === 'hex.dev.bootstrap.reload-failed');
  assert.ok(failure, 'a rejected reload must be explicitly reported to the requesting frame');
  assert.equal(failure.protocol, installed.protocol);
  assert.equal(failure.generation, '1');
  assert.equal(failure.sandboxToken, TOKEN);

  requestReload(parent, installed, first, '1');
  assert.equal(first.messages.at(-1)?.type, 'hex.dev.bootstrap.reload-accepted', 'a failed reload must leave the host retryable');
  await delay(10);
  assert.equal(calls, 2, 'the retried reload request must run the reload again');
  assert.equal(first.messages.filter((message) => message.type === 'hex.dev.bootstrap.reload-failed').length, 1);
  installed.close();
}

async function testStaleGenerationFailureDoesNotTouchCurrentFrame() {
  const parent = fakeWindow();
  const first = fakeChild();
  const second = fakeChild();
  let iframe = frame(first, '1');
  let calls = 0;
  const host = {
    get iframe() { return iframe; },
    reload() {
      calls += 1;
      iframe = frame(second, '2');
      if (calls === 1) return Promise.reject(new Error('failed after generation swap'));
      return Promise.resolve();
    },
  };
  const installed = installDevBootstrapHost({ host, runtimeIdentity: { commit: COMMIT, buildId: BUILD }, windowRef: parent });

  requestReload(parent, installed, first, '1');
  await delay(10);
  assert.equal(first.messages.filter((message) => message.type === 'hex.dev.bootstrap.reload-failed').length, 0, 'a stale attempt must not notify a replaced frame');
  assert.equal(second.messages.length, 0, 'a stale attempt completion must not write new-generation state');

  requestReload(parent, installed, second, '2');
  assert.equal(second.messages.at(-1)?.type, 'hex.dev.bootstrap.reload-accepted', 'the current generation must remain able to request reload after a failed attempt');
  await delay(10);
  assert.equal(calls, 2);
  installed.close();
}

async function testSynchronousReloadThrowIsRecovered() {
  const parent = fakeWindow();
  const first = fakeChild();
  let iframe = frame(first, '1');
  let calls = 0;
  const host = {
    get iframe() { return iframe; },
    reload() {
      calls += 1;
      if (calls === 1) throw new Error('synchronous reload failure');
      return Promise.resolve();
    },
  };
  const installed = installDevBootstrapHost({ host, runtimeIdentity: { commit: COMMIT, buildId: BUILD }, windowRef: parent });

  requestReload(parent, installed, first, '1');
  await delay(10);
  const failure = first.messages.find((message) => message.type === 'hex.dev.bootstrap.reload-failed');
  assert.ok(failure, 'a synchronously thrown reload failure must also be managed');
  assert.equal(failure.generation, '1');
  requestReload(parent, installed, first, '1');
  assert.equal(first.messages.at(-1)?.type, 'hex.dev.bootstrap.reload-accepted', 'a synchronously failed reload must leave the host retryable');
  await delay(10);
  assert.equal(calls, 2);
  installed.close();
}

async function testSuccessfulReloadStaysOneShot() {
  const parent = fakeWindow();
  const first = fakeChild();
  const second = fakeChild();
  let iframe = frame(first, '1');
  let calls = 0;
  const host = {
    get iframe() { return iframe; },
    reload() {
      calls += 1;
      iframe = frame(second, '2');
      return Promise.resolve();
    },
  };
  const installed = installDevBootstrapHost({ host, runtimeIdentity: { commit: COMMIT, buildId: BUILD }, windowRef: parent });

  requestReload(parent, installed, first, '1');
  await delay(10);
  requestReload(parent, installed, second, '2');
  await delay(10);
  assert.equal(calls, 1, 'a completed reload must remain one-shot for the host lifetime');
  assert.equal(first.messages.filter((message) => message.type === 'hex.dev.bootstrap.reload-failed').length, 0);
  assert.equal(second.messages.filter((message) => message.type === 'hex.dev.bootstrap.reload-accepted').length, 0);
  installed.close();
}

function requestReload(parent, installed, source, generation) {
  parent.emit({
    origin: 'null',
    source,
    data: {
      protocol: installed.protocol,
      type: 'hex.dev.bootstrap.reload-request',
      generation,
      sandboxToken: TOKEN,
      handoff: { checkpoint: { runId: HANDOFF.checkpoint.runId, generation } },
    },
  });
}

function frame(child, generation) {
  return { contentWindow: child, dataset: { hexGeneration: generation, hexSandboxToken: TOKEN } };
}

function fakeChild() {
  return {
    messages: [],
    postMessage(message) { this.messages.push(message); },
  };
}

function fakeWindow() {
  const listeners = new Set();
  return {
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
    emit(event) { for (const listener of [...listeners]) listener(event); },
  };
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
