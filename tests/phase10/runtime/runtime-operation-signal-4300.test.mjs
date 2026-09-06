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