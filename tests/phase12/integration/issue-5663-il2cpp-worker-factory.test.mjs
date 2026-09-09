import assert from 'node:assert/strict';
import { parseMetadataFileInWorker } from '../../../js/il2cpp-runtime.js';

let posted = null;
let terminated = 0;
const worker = {
  onmessage: null,
  onerror: null,
  onmessageerror: null,
  postMessage(message) {
    posted = message;
    queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true, result: { version: 29 } } }));
  },
  terminate() { terminated += 1; },
};

const parsed = await parseMetadataFileInWorker({}, { workerFactory: () => worker });
assert.deepEqual(parsed, { version: 29 }, 'normal worker construction and response stay unchanged');
assert.equal(posted?.id > 0, true);
assert.equal(terminated, 1, 'successful parsing still terminates the worker');

const factoryError = new Error('worker-create-failed');
let synchronousThrow = false;
let pending;
try {
  pending = parseMetadataFileInWorker({}, { workerFactory() { throw factoryError; } });
} catch {
  synchronousThrow = true;
}
assert.equal(synchronousThrow, false, 'worker construction failure must stay inside the Promise API');
assert.equal(typeof pending?.then, 'function');
await assert.rejects(pending, (error) => error === factoryError, 'the factory failure must be the Promise rejection');

const defaultFactoryError = new Error('default-worker-create-failed');
const hadWorker = Object.hasOwn(globalThis, 'Worker');
const originalWorker = globalThis.Worker;
globalThis.Worker = class ThrowingWorker {
  constructor() { throw defaultFactoryError; }
};
let defaultPending;
try {
  assert.doesNotThrow(() => {
    defaultPending = parseMetadataFileInWorker({});
  });
} finally {
  if (hadWorker) globalThis.Worker = originalWorker;
  else delete globalThis.Worker;
}
assert.equal(typeof defaultPending?.then, 'function');
await assert.rejects(defaultPending, (error) => error === defaultFactoryError, 'the default Worker factory must use the same Promise boundary');

let nonErrorPending;
assert.doesNotThrow(() => {
  nonErrorPending = parseMetadataFileInWorker({}, { workerFactory() { throw 'worker-create-string'; } });
});
await assert.rejects(nonErrorPending, (error) => error === 'worker-create-string', 'non-Error factory failures must also reject');

const postMessageError = new Error('worker-post-message-failed');
const postMessageWorker = {
  onmessage: null,
  onerror: null,
  onmessageerror: null,
  terminated: 0,
  postMessage() { throw postMessageError; },
  terminate() { this.terminated += 1; },
};
let postMessagePending;
assert.doesNotThrow(() => {
  postMessagePending = parseMetadataFileInWorker({}, { workerFactory: () => postMessageWorker });
});
assert.equal(typeof postMessagePending?.then, 'function');
await assert.rejects(postMessagePending, (error) => error === postMessageError, 'postMessage failure must preserve Error identity');
assert.equal(postMessageWorker.terminated, 1, 'postMessage failure must terminate the worker exactly once');

async function assertWorkerEventFailure(eventName, eventError) {
  const eventWorker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    terminated: 0,
    postMessage() {
      queueMicrotask(() => this[eventName]?.({ error: eventError, message: eventError.message }));
    },
    terminate() { this.terminated += 1; },
  };
  let eventPending;
  assert.doesNotThrow(() => {
    eventPending = parseMetadataFileInWorker({}, { workerFactory: () => eventWorker });
  });
  assert.equal(typeof eventPending?.then, 'function');
  await assert.rejects(eventPending, (error) => error === eventError, `${eventName} must preserve Error identity`);
  assert.equal(eventWorker.terminated, 1, `${eventName} must terminate the worker exactly once`);
}

await assertWorkerEventFailure('onerror', new Error('worker-runtime-failed'));
await assertWorkerEventFailure('onmessageerror', new Error('worker-message-decode-failed'));

console.log('issue #5663 IL2CPP worker factory Promise boundary: PASS');
