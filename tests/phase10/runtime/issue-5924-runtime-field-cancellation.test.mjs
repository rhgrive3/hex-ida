import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeAnalysisPlatform } from '../../../js/runtime/index.js';
import { DebugAdapter, DebugAdapterError } from '../../../js/debug/adapter.js';

let nextAdapterId = 0;

class ReadMemoryAdapter extends DebugAdapter {
  constructor({ deferred = false, bytes = new Uint8Array(4096) } = {}) {
    super({
      id: `runtime-field-5924-${++nextAdapterId}`,
      kind: 'test',
      capabilities: { readMemory:true },
    });
    this.deferred = deferred;
    this.bytes = bytes;
    this.calls = [];
    this.pending = [];
    this.started = new Promise((resolve) => { this.resolveStarted = resolve; });
  }

  readMemory(address, size, options = {}) {
    this.calls.push({ address, size, options });
    this.resolveStarted();
    if (!this.deferred) return Promise.resolve(this.bytes.slice(0, size));
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  resolveRead(bytes = this.bytes) {
    const request = this.pending.shift();
    assert.ok(request, 'a deferred read must be pending before it is resolved');
    request.resolve(bytes);
  }
}

async function fixture(options = {}) {
  const adapter = new ReadMemoryAdapter(options);
  const platform = new RuntimeAnalysisPlatform({ symbolic:false });
  const session = await platform.startSession({ adapter, binaryHash:'fixture:5924', connect:false });
  return { adapter, platform, session };
}

async function flushLateRead() {
  await new Promise((resolve) => setImmediate(resolve));
}

function errorCode(code) {
  return (error) => error instanceof DebugAdapterError && error.code === code;
}

test('P10 #5924 normal reads forward operation options and preserve boundaries', async () => {
  for (const size of [1, 4096]) {
    const { adapter, platform, session } = await fixture();
    const result = await platform.readRuntimeField(0x1000n, size, { timeoutMs:100 });
    assert.equal(result.bytes.length, size);
    assert.equal(result.evidence.length, 1);
    assert.equal(platform.evidence.length, 1);
    assert.equal(adapter.calls.length, 1);
    assert.equal(adapter.calls[0].size, size);
    assert.equal(typeof adapter.calls[0].options.signal?.addEventListener, 'function');
    assert.equal(adapter.calls[0].options.timeoutMs, 100);
    assert.equal(session.controllers.size, 0);
  }
});

test('P10 #5924 external abort bounds an uncooperative read and drops late bytes', async () => {
  const { adapter, platform, session } = await fixture({ deferred:true });
  const external = new AbortController();
  const pending = platform.readRuntimeField(0x2000n, 8, { signal:external.signal, timeoutMs:1000 });
  await adapter.started;
  external.abort('caller-cancelled');
  await assert.rejects(pending, errorCode('cancelled'));
  assert.equal(session.controllers.size, 0);

  adapter.resolveRead(new Uint8Array(8));
  await flushLateRead();
  assert.equal(platform.evidence.length, 0, 'late bytes after abort must not publish RuntimeEvidence');
});

test('P10 #5924 timeout bounds an uncooperative read and drops late bytes', async () => {
  const { adapter, platform, session } = await fixture({ deferred:true });
  const pending = platform.readRuntimeField(0x3000n, 8, { timeoutMs:20 });
  await adapter.started;
  await assert.rejects(pending, errorCode('timeout'));
  assert.equal(session.controllers.size, 0);

  adapter.resolveRead(new Uint8Array(8));
  await flushLateRead();
  assert.equal(platform.evidence.length, 0, 'late bytes after timeout must not publish RuntimeEvidence');
});

test('P10 #5924 session epoch cancellation bounds reads and rejects late bytes', async () => {
  const { adapter, platform, session } = await fixture({ deferred:true });
  const pending = platform.readRuntimeField(0x4000n, 8, { timeoutMs:1000 });
  await adapter.started;
  session.newEpoch();
  await assert.rejects(pending, errorCode('session-epoch-changed'));
  assert.equal(session.controllers.size, 0);

  adapter.resolveRead(new Uint8Array(8));
  await flushLateRead();
  assert.equal(platform.evidence.length, 0, 'late bytes after an epoch change must not publish RuntimeEvidence');
});

test('P10 #5924 session disconnect bounds reads and rejects late bytes', async () => {
  const { adapter, platform, session } = await fixture({ deferred:true });
  const pending = platform.readRuntimeField(0x5000n, 8, { timeoutMs:1000 });
  await adapter.started;
  const closing = platform.sessions.close(session.id);
  await assert.rejects(pending, errorCode('disconnected'));
  await closing;

  adapter.resolveRead(new Uint8Array(8));
  await flushLateRead();
  assert.equal(platform.evidence.length, 0, 'late bytes after disconnect must not publish RuntimeEvidence');
});

test('P10 #5924 short reads remain validation failures without evidence', async () => {
  const { adapter, platform, session } = await fixture({ bytes:new Uint8Array([1, 2]) });
  await assert.rejects(platform.readRuntimeField(0x6000n, 4), errorCode('short-read'));
  assert.equal(platform.evidence.length, 0);
  assert.equal(adapter.calls.length, 1);
  assert.equal(session.controllers.size, 0);
});
