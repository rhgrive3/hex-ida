import assert from 'node:assert/strict';
import test from 'node:test';

import { fieldAccessRegion, clearFieldAccessArtifacts } from '../js/analysis/field-access-artifact.js';

test('1. pre-aborted custom Error reason identity and name are not mutated', async () => {
  const backend = {
    fieldAccess() {
      throw new Error('should not be called');
    },
  };
  const region = { id: 'reg1', exec: true, size: 100n };
  const controller = new AbortController();
  const callerError = new Error('custom-failure');
  callerError.customCode = 42;
  controller.abort(callerError);

  let caught;
  try {
    await fieldAccessRegion(backend, region, 0x1000n, 4, { signal: controller.signal });
  } catch (err) {
    caught = err;
  }

  assert.equal(caught, callerError, 'caught error must be identical to caller-provided error');
  assert.equal(callerError.name, 'Error', 'caller Error name must not be mutated to AbortError');
  assert.equal(callerError.customCode, 42);
  clearFieldAccessArtifacts(backend);
});

test('2. in-flight aborted custom Error reason identity and name are not mutated', async () => {
  let finishReject;
  const promise = new Promise((_, reject) => { finishReject = reject; });
  promise.cancel = () => {};

  const backend = {
    fieldAccess() {
      return promise;
    },
  };
  const region = { id: 'reg2', exec: true, size: 100n };
  const controller = new AbortController();
  const callerError = new TypeError('in-flight-abort');
  callerError.tag = 'special';

  const pending = fieldAccessRegion(backend, region, 0x2000n, 4, { signal: controller.signal });
  controller.abort(callerError);

  let caught;
  try {
    await pending;
  } catch (err) {
    caught = err;
  }

  assert.equal(caught, callerError);
  assert.equal(callerError.name, 'TypeError');
  assert.equal(callerError.tag, 'special');
  clearFieldAccessArtifacts(backend);
});

test('3. existing AbortError instance is preserved directly', async () => {
  const backend = {
    fieldAccess() {
      throw new Error('should not be called');
    },
  };
  const region = { id: 'reg3', exec: true, size: 100n };
  const controller = new AbortController();
  const abortErr = new Error('aborted-operation');
  abortErr.name = 'AbortError';
  controller.abort(abortErr);

  let caught;
  try {
    await fieldAccessRegion(backend, region, 0x3000n, 4, { signal: controller.signal });
  } catch (err) {
    caught = err;
  }

  assert.equal(caught, abortErr);
  assert.equal(caught.name, 'AbortError');
  clearFieldAccessArtifacts(backend);
});

test('4. falsy non-Error reasons are preserved in error message with AbortError name', async () => {
  const backend = {
    fieldAccess() {
      throw new Error('should not be called');
    },
  };
  const region = { id: 'reg4', exec: true, size: 100n };

  // 0
  {
    const c0 = new AbortController();
    c0.abort(0);
    await assert.rejects(
      () => fieldAccessRegion(backend, region, 0x4000n, 4, { signal: c0.signal }),
      (err) => err?.name === 'AbortError' && err?.message === '0',
    );
  }

  // false
  {
    const cFalse = new AbortController();
    cFalse.abort(false);
    await assert.rejects(
      () => fieldAccessRegion(backend, region, 0x4000n, 4, { signal: cFalse.signal }),
      (err) => err?.name === 'AbortError' && err?.message === 'false',
    );
  }

  // empty string
  {
    const cEmpty = new AbortController();
    cEmpty.abort('');
    await assert.rejects(
      () => fieldAccessRegion(backend, region, 0x4000n, 4, { signal: cEmpty.signal }),
      (err) => err?.name === 'AbortError' && err?.message === '',
    );
  }

  // undefined reason (fallback)
  {
    const mockSignal = { aborted: true, reason: undefined };
    await assert.rejects(
      () => fieldAccessRegion(backend, region, 0x4000n, 4, { signal: mockSignal }),
      (err) => err?.name === 'AbortError' && err?.message === 'Field-access search aborted',
    );
  }

  // default controller abort (DOMException AbortError)
  {
    const cDefault = new AbortController();
    cDefault.abort();
    await assert.rejects(
      () => fieldAccessRegion(backend, region, 0x4000n, 4, { signal: cDefault.signal }),
      (err) => err?.name === 'AbortError',
    );
  }

  clearFieldAccessArtifacts(backend);
});
