import assert from 'node:assert/strict';
import { waitForRetry } from '../js/ai/provider/worker-transport.js';

// Deterministically abort during listener registration without dispatching the
// callback. The post-registration `signal.aborted` check is the only thing that
// can observe this transition before the retry timer fires. Without the fix the
// timer wins and this resolves true; with the fix the abort path resolves false.
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
  const result = await waitForRetry(1, '0.01', signal);
  assert.equal(result, false);
  assert.equal(addCalls, 1);
  assert.equal(removeCalls, 1);
}

// Already-aborted and normal retry behavior remain unchanged.
{
  const controller = new AbortController();
  controller.abort('stop');
  assert.equal(await waitForRetry(1, '0.01', controller.signal), false);
}
{
  const controller = new AbortController();
  assert.equal(await waitForRetry(1, '0', controller.signal), true);
}

console.log('issue #3364 waitForRetry abort subscription race: PASS');
