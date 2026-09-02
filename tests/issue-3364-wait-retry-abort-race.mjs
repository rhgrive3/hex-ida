import assert from 'node:assert/strict';
import { waitForRetry } from '../js/ai/provider/worker-transport.js';

// Deterministically abort during listener registration without dispatching the
// callback. The post-registration `signal.aborted` check is the only thing that
// can observe this transition before the retry timer fires.
{
  let aborted = false;
  let addCalls = 0;
  let removeCalls = 0;
  const signal = {
    get aborted() { return aborted; },
    addEventListener(type, _listener) {
      assert.equal(type, 'abort');
      addCalls += 1;
      aborted = true;
    },
    removeEventListener(type) {
      assert.equal(type, 'abort');
      removeCalls += 1;
    },
  };
  const started = Date.now();
  const result = await waitForRetry(1, '0.2', signal);
  const elapsed = Date.now() - started;
  assert.equal(result, false);
  assert.equal(addCalls, 1);
  assert.equal(removeCalls, 1);
  assert.ok(elapsed < 150, `abort race must not wait for retry timer (${elapsed}ms)`);
}

// Already-aborted and normal retry behavior remain unchanged.
{
  const controller = new AbortController();
  controller.abort('stop');
  assert.equal(await waitForRetry(1, '0.2', controller.signal), false);
}
{
  const controller = new AbortController();
  assert.equal(await waitForRetry(1, '0', controller.signal), true);
}

console.log('issue #3364 waitForRetry abort subscription race: PASS');
