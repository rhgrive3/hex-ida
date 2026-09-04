import test from 'node:test';
import assert from 'node:assert/strict';
import { VariableInstructionIndex } from '../js/viewer/variable-instruction-index.js';

test('issue 6222: _join handles abort race between check and listener registration', async () => {
  const index = new VariableInstructionIndex({
    disassembleAt: async () => ({ supported: true, instructions: [] }),
    pageBytes: 64,
  });

  let checkCount = 0;
  let listener = null;
  let listenerRemoved = false;
  const signal = {
    get aborted() {
      checkCount++;
      return checkCount > 1;
    },
    get reason() {
      return Object.assign(new Error('test-aborted-during-race'), { name: 'AbortError' });
    },
    addEventListener(type, fn) {
      if (type === 'abort') listener = fn;
    },
    removeEventListener(type, fn) {
      if (type === 'abort' && fn === listener) listenerRemoved = true;
    },
  };

  const source = new Promise((resolve) => {
    setTimeout(() => resolve('page-resolved-too-late'), 50);
  });

  await assert.rejects(
    () => index._join(source, signal),
    (err) => {
      assert.equal(err.name, 'AbortError');
      return true;
    }
  );

  assert.ok(listenerRemoved, 'abort listener must be cleaned up on rejection');
});

test('issue 6222: _join removes abort listener on normal resolution (no leak)', async () => {
  const index = new VariableInstructionIndex({
    disassembleAt: async () => ({ supported: true, instructions: [] }),
    pageBytes: 64,
  });

  let listenerRemoved = false;
  let listener = null;
  const signal = {
    aborted: false,
    addEventListener(type, fn) {
      if (type === 'abort') listener = fn;
    },
    removeEventListener(type, fn) {
      if (type === 'abort' && fn === listener) listenerRemoved = true;
    },
  };

  const result = await index._join(Promise.resolve('normal-page'), signal);
  assert.equal(result, 'normal-page');
  assert.ok(listenerRemoved, 'abort listener must be cleaned up on normal resolution');
});

test('issue 6222: ensurePage relays abort if signal becomes aborted before listener registration', async () => {
  let innerControllerSignal = null;
  const disassembleAt = async (addr, { signal }) => {
    innerControllerSignal = signal;
    await new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    return { supported: true, instructions: [] };
  };

  const index = new VariableInstructionIndex({
    disassembleAt,
    pageBytes: 64,
  });
  index.configureRegion({ id: 'text', vmAddr: 0x1000n, size: 0x100n });

  let checkCount = 0;
  let relayListener = null;
  let listenerRemoved = false;
  const signal = {
    get aborted() {
      checkCount++;
      // Return false on the first check in ensurePage (line 158), true afterwards
      return checkCount > 1;
    },
    get reason() {
      return Object.assign(new Error('race-aborted-in-ensurePage'), { name: 'AbortError' });
    },
    addEventListener(type, fn) {
      if (type === 'abort') relayListener = fn;
    },
    removeEventListener(type, fn) {
      if (type === 'abort' && fn === relayListener) listenerRemoved = true;
    },
  };

  await assert.rejects(
    () => index.ensurePage(0x1000n, { signal }),
    /AbortError|aborted/
  );

  // Wait for producer promise settlement in microtask queue
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(innerControllerSignal?.aborted, 'producer controller signal must be aborted');
  assert.ok(listenerRemoved, 'relay abort listener must be cleaned up in finally');
});
