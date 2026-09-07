import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearFieldAccessArtifacts,
  fieldAccessRegion,
} from '../js/analysis/field-access-artifact.js';

const region = Object.freeze({ id: 'issue-6205-region', exec: true, size: 0x100n });

function preAbortBackend() {
  let calls = 0;
  return {
    get calls() { return calls; },
    fieldAccess() {
      calls += 1;
      throw new Error('pre-aborted requests must not start a backend operation');
    },
  };
}

test('#6205 pre-aborted caller Error keeps identity, name, and custom fields', async () => {
  const backend = preAbortBackend();
  const controller = new AbortController();
  const reason = new Error('view-closed');
  reason.customCode = 42;
  controller.abort(reason);

  await assert.rejects(
    () => fieldAccessRegion(backend, region, 0n, 4, { signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(reason.name, 'Error');
  assert.equal(reason.customCode, 42);
  assert.equal(backend.calls, 0);
  clearFieldAccessArtifacts(backend);
});

test('#6205 in-flight caller Error is preserved and cancellation still propagates', async () => {
  let cancelCalls = 0;
  const request = new Promise(() => {});
  request.cancel = () => { cancelCalls += 1; };
  const backend = { fieldAccess: () => request };
  const controller = new AbortController();
  const reason = new TypeError('navigation-aborted');
  reason.tag = 'caller-owned';

  const pending = fieldAccessRegion(backend, region, 8n, 8, { signal: controller.signal });
  controller.abort(reason);

  await assert.rejects(pending, (error) => error === reason);
  assert.equal(reason.name, 'TypeError');
  assert.equal(reason.tag, 'caller-owned');
  assert.equal(cancelCalls, 1);
  clearFieldAccessArtifacts(backend);
});

test('#6205 existing AbortError reason is returned without cloning or mutation', async () => {
  const backend = preAbortBackend();
  const controller = new AbortController();
  const reason = new Error('already-normalized');
  reason.name = 'AbortError';
  controller.abort(reason);

  await assert.rejects(
    () => fieldAccessRegion(backend, region, 16n, 4, { signal: controller.signal }),
    (error) => error === reason && error.name === 'AbortError',
  );
  assert.equal(backend.calls, 0);
  clearFieldAccessArtifacts(backend);
});

test('#6205 non-Error reasons preserve exact falsy text in a new AbortError', async () => {
  for (const [value, message] of [[0, '0'], [false, 'false'], ['', '']]) {
    const backend = preAbortBackend();
    const controller = new AbortController();
    controller.abort(value);
    await assert.rejects(
      () => fieldAccessRegion(backend, region, 24n, 4, { signal: controller.signal }),
      (error) => error instanceof Error && error.name === 'AbortError' && error.message === message,
    );
    assert.equal(backend.calls, 0);
    clearFieldAccessArtifacts(backend);
  }
});

test('#6205 undefined reason uses fallback and platform default AbortError passes through', async () => {
  const backend = preAbortBackend();
  await assert.rejects(
    () => fieldAccessRegion(backend, region, 32n, 4, {
      signal: { aborted: true, reason: undefined },
    }),
    (error) => error?.name === 'AbortError' && error?.message === 'Field-access search aborted',
  );

  const controller = new AbortController();
  controller.abort();
  const platformReason = controller.signal.reason;
  await assert.rejects(
    () => fieldAccessRegion(backend, region, 40n, 4, { signal: controller.signal }),
    (error) => error === platformReason && error?.name === 'AbortError',
  );
  assert.equal(backend.calls, 0);
  clearFieldAccessArtifacts(backend);
});
