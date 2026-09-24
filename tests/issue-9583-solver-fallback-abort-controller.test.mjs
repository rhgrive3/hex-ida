import assert from 'node:assert/strict';
import test from 'node:test';

const NativeAbortController = globalThis.AbortController;

test('#9583 fallback abort dispatch isolates listener failures and exposes AbortSignal reason', async () => {
  globalThis.AbortController = undefined;
  try {
    const { SolverSession } = await import(`../js/symbolic/solver/session.js?issue9583=${Date.now()}`);
    const seen = [];
    let internalSignal = null;
    class ProbeSession extends SolverSession {
      async _executeCheck(_query, _options, _token, signal) {
        internalSignal = signal;
        signal.addEventListener('abort', () => {
          seen.push('first');
          throw new Error('listener exploded');
        });
        signal.addEventListener('abort', () => { seen.push('second'); }, { once: true });
        return new Promise(() => {});
      }
    }

    const session = new ProbeSession({ id: 'probe', version: '1.0.0' }, { timeoutMs: 0 });
    const pending = session.check({ id: 'q' });
    for (let i = 0; i < 20 && internalSignal === null; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(internalSignal, 'provider must receive the fallback signal');
    assert.equal(internalSignal.aborted, false);
    assert.equal(internalSignal.reason, undefined);

    await assert.doesNotReject(() => session.cancel());
    const result = await pending;

    assert.deepEqual(seen, ['first', 'second'], 'a throwing listener must not suppress later abort subscribers');
    assert.equal(internalSignal.aborted, true);
    assert.equal(internalSignal.reason?.name, 'AbortError');
    assert.throws(
      () => internalSignal.throwIfAborted(),
      (error) => error === internalSignal.reason,
      'throwIfAborted must throw the stored abort reason',
    );
    assert.equal(result.lifecycle?.cancelled, true);

    internalSignal.addEventListener('abort', () => seen.push('late'));
    await session.cancel();
    assert.deepEqual(seen, ['first', 'second'], 'listeners added after abort must not be retained or dispatched later');
  } finally {
    globalThis.AbortController = NativeAbortController;
  }
});

test('#9583 native AbortController path remains native when available', async () => {
  if (typeof NativeAbortController !== 'function') return;
  globalThis.AbortController = NativeAbortController;
  const { SolverSession } = await import(`../js/symbolic/solver/session.js?issue9583native=${Date.now()}`);
  let internalSignal = null;
  class ProbeSession extends SolverSession {
    async _executeCheck(_query, _options, _token, signal) {
      internalSignal = signal;
      return { status: 'unknown', reason: 'probe', lifecycle: { publishable: false } };
    }
  }
  const session = new ProbeSession({ id: 'probe', version: '1.0.0' }, { timeoutMs: 0 });
  await session.check({ id: 'q' });
  assert.ok(internalSignal instanceof AbortSignal);
});
