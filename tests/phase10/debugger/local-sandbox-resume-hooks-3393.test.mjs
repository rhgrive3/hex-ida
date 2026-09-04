import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../../js/adapters/index.js';

function expectCode(error, code) {
  assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
  return true;
}

function makeAdapter() {
  const adapter = new LocalFunctionSandboxAdapter({});
  let runCalls = 0;
  adapter.sandbox = {
    emulator: { stopped:null },
    run: async ({ onProgress }) => {
      runCalls++;
      onProgress(500);
      return { ok:true };
    },
  };
  adapter._normalizeResult = (result) => result;
  return { adapter, runCalls:() => runCalls };
}

for (const signal of [
  {},
  true,
  { addEventListener() {} },
  { removeEventListener() {} },
  { addEventListener:true, removeEventListener() {} },
]) {
  const { adapter, runCalls } = makeAdapter();
  await assert.rejects(adapter.resume({ signal }), (error) => expectCode(error, 'invalid-argument'));
  assert.equal(adapter.activeRun, null, 'invalid signal must fail before run state is published');
  assert.equal(adapter.running, false);
  assert.equal(runCalls(), 0, 'invalid signal must not reach sandbox.run');
}

for (const onProgress of [true, {}, [], 'progress', 1]) {
  const { adapter, runCalls } = makeAdapter();
  await assert.rejects(adapter.resume({ onProgress }), (error) => expectCode(error, 'invalid-argument'));
  assert.equal(adapter.activeRun, null, 'invalid onProgress must fail before run state is published');
  assert.equal(adapter.running, false);
  assert.equal(runCalls(), 0, 'invalid onProgress must not reach sandbox.run');
}

{
  const { adapter, runCalls } = makeAdapter();
  let added = 0;
  let removed = 0;
  let registered = null;
  const signal = {
    aborted:false,
    addEventListener(type, listener, options) {
      assert.equal(type, 'abort');
      assert.deepEqual(options, { once:true });
      added++;
      registered = listener;
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort');
      assert.equal(listener, registered);
      removed++;
    },
  };
  const progress = [];
  const result = await adapter.resume({ signal, onProgress:(n) => progress.push(n), maxSteps:501 });
  assert.deepEqual(result, { ok:true });
  assert.deepEqual(progress, [500]);
  assert.equal(runCalls(), 1);
  assert.equal(added, 1);
  assert.equal(removed, 1, 'valid signal listener must be cleaned up exactly once');
  assert.equal(adapter.activeRun, null);
  assert.equal(adapter.running, false);
}

console.log('local sandbox resume hook boundaries #3393: ok');
