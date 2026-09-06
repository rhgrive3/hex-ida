import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeAnalysisPlatform } from '../../../js/runtime/index.js';
import { DebugAdapter, DebugAdapterError } from '../../../js/debug/adapter.js';

class BlockingTraceAdapter extends DebugAdapter {
  constructor() {
    super({ id:'runtime-signal-4300', kind:'test', capabilities:{ traceFunction:true } });
    this.entered = new Promise((resolve) => { this._entered = resolve; });
  }

  async trace({ signal } = {}) {
    this._entered();
    if (signal?.aborted) throw new DebugAdapterError('cancelled', 'cancelled');
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DebugAdapterError('cancelled', 'cancelled')), { once:true });
    });
  }
}

async function fixture() {
  const adapter = new BlockingTraceAdapter();
  const platform = new RuntimeAnalysisPlatform({ symbolic:false });
  const session = await platform.startSession({ adapter, binaryHash:'fixture:4300', connect:false });
  return { adapter, platform, session };
}

function invalidSignalError(error) {
  return error instanceof DebugAdapterError && error.code === 'invalid-signal';
}

test('runtime operations reject malformed signals before allocating a session controller (#4300)', async () => {
  const { platform, session } = await fixture();
  const malformed = [
    {}, true, false, 0, '',
    { addEventListener() {} },
    { removeEventListener() {} },
    { addEventListener: true, removeEventListener() {} },
  ];

  for (const signal of malformed) {
    await assert.rejects(platform.traceFunction(0x1000n, { signal }), invalidSignalError);
    assert.equal(session.controllers.size, 0);
  }

  await assert.rejects(
    platform.runExperiment({ id:'experiment:4300', cases:[] }, { signal:{} }),
    invalidSignalError,
  );
  assert.equal(session.controllers.size, 0);
});

test('runtime signal setup is failure-atomic and snapshots listener authority (#4300)', async () => {
  {
    const { platform, session } = await fixture();
    let removes = 0;
    const signal = {
      aborted:false,
      addEventListener() { throw new Error('attach-failed'); },
      removeEventListener() { removes += 1; },
    };
    await assert.rejects(platform.traceFunction(0x1000n, { signal }), invalidSignalError);
    assert.equal(removes, 1, 'failed attachment should best-effort detach a partially installed listener');
    assert.equal(session.controllers.size, 0);
  }

  {
    const { platform, session } = await fixture();
    let addReads = 0;
    let removeReads = 0;
    const signal = {
      aborted:false,
      get addEventListener() {
        addReads += 1;
        return addReads === 1 ? function add(_type, listener) { listener(); } : null;
      },
      get removeEventListener() {
        removeReads += 1;
        return removeReads === 1 ? function remove() {} : null;
      },
    };
    await assert.rejects(platform.traceFunction(0x1000n, { signal }), /cancelled/);
    assert.equal(addReads, 1);
    assert.equal(removeReads, 1);
    assert.equal(session.controllers.size, 0);
  }

  {
    const { platform, session } = await fixture();
    let abortedReads = 0;
    const signal = {
      get aborted() {
        abortedReads += 1;
        if (abortedReads === 1) return false;
        throw new Error('aborted-failed');
      },
      addEventListener() {},
      removeEventListener() {},
    };
    await assert.rejects(platform.traceFunction(0x1000n, { signal }), invalidSignalError);
    assert.equal(abortedReads, 2);
    assert.equal(session.controllers.size, 0);
  }

  {
    const { platform, session } = await fixture();
    const signal = {
      aborted:false,
      addEventListener(_type, listener) { listener(); },
      removeEventListener() { throw new Error('detach-failed'); },
    };
    await assert.rejects(platform.traceFunction(0x1000n, { signal }), invalidSignalError);
    assert.equal(session.controllers.size, 0);
  }
});

test('valid AbortSignal pre-abort and in-flight abort keep controller cleanup semantics (#4300)', async () => {
  {
    const { platform, session } = await fixture();
    const external = new AbortController();
    external.abort('pre-aborted');
    await assert.rejects(platform.traceFunction(0x1000n, { signal:external.signal }), /cancelled/);
    assert.equal(session.controllers.size, 0);
  }

  {
    const { adapter, platform, session } = await fixture();
    const external = new AbortController();
    const pending = platform.traceFunction(0x1000n, { signal:external.signal });
    await adapter.entered;
    assert.equal(session.controllers.size, 1);
    external.abort('in-flight');
    await assert.rejects(pending, /cancelled/);
    assert.equal(session.controllers.size, 0);
  }
});