import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_IL2CPP_METADATA_BYTES } from '../../../js/il2cpp.js';

const WORKER_URL = new URL('../../../js/il2cpp-worker.js', import.meta.url);

async function loadWorker() {
  const posts = [];
  const prior = globalThis.self;
  const scope = { postMessage: (message) => posts.push(message) };
  globalThis.self = scope;
  // Fresh instance per call (cache-busted) so onmessage binds to this scope;
  // globalThis.self stays bound because the handler resolves self.postMessage
  // at send time.
  await import(`${WORKER_URL.href}?lane07=${Math.random()}`);
  const send = async (data) => {
    await scope.onmessage({ data });
    return posts[posts.length - 1];
  };
  const dispose = () => { if (prior === undefined) delete globalThis.self; else globalThis.self = prior; };
  return { posts, send, dispose };
}

test('#8782 a provably oversize declared File is rejected without calling arrayBuffer()', async () => {
  let arrayBufferCalls = 0;
  const file = {
    size: MAX_IL2CPP_METADATA_BYTES + 1,
    arrayBuffer() { arrayBufferCalls += 1; return Promise.resolve(new ArrayBuffer(0)); },
  };
  const { send, dispose } = await loadWorker();
  try {
    const reply = await send({ t: 'parse', id: 1, file });
    assert.equal(arrayBufferCalls, 0, 'the whole file must never be materialized once its declared size is already over budget');
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'IL2CPP_METADATA_BUDGET');
    assert.match(reply.error.message, /too large/);
  } finally { dispose(); }
});

test('#8782 byteLength is honored as a declared size for non-File blobs', async () => {
  let arrayBufferCalls = 0;
  const blob = {
    byteLength: 5 * MAX_IL2CPP_METADATA_BYTES,
    arrayBuffer() { arrayBufferCalls += 1; return Promise.resolve(new ArrayBuffer(0)); },
  };
  const { send, dispose } = await loadWorker();
  try {
    const reply = await send({ t: 'parse', id: 2, file: blob });
    assert.equal(arrayBufferCalls, 0);
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'IL2CPP_METADATA_BUDGET');
  } finally { dispose(); }
});

test('#8782 an explicit smaller maxInputBytes tightens the pre-admission boundary', async () => {
  let arrayBufferCalls = 0;
  const file = { size: 1024, arrayBuffer() { arrayBufferCalls += 1; return Promise.resolve(new ArrayBuffer(0)); } };
  const { send, dispose } = await loadWorker();
  try {
    const reply = await send({ t: 'parse', id: 3, file, maxInputBytes: 16 });
    assert.equal(arrayBufferCalls, 0, 'a caller-tightened budget must reject before materialization too');
    assert.equal(reply.error.code, 'IL2CPP_METADATA_BUDGET');
  } finally { dispose(); }
});

test('#8782 an in-budget / size-unknown File still reaches the parser (behavior preserved)', async () => {
  let arrayBufferCalls = 0;
  const tiny = new Uint8Array([0x00, 0x01, 0x02]);
  const file = { arrayBuffer() { arrayBufferCalls += 1; return Promise.resolve(tiny.buffer); } };
  const { send, dispose } = await loadWorker();
  try {
    const reply = await send({ t: 'parse', id: 4, file });
    assert.equal(arrayBufferCalls, 1, 'no declared size means no pre-admission shortcut; the parser still decides');
    assert.equal(reply.ok, false);
    assert.notEqual(reply.error.code, 'IL2CPP_METADATA_BUDGET', 'a short non-metadata buffer fails on magic/size, not the input budget');
  } finally { dispose(); }
});
