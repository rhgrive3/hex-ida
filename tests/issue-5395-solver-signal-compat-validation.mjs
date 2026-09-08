import assert from 'node:assert/strict';
import test from 'node:test';

import { SolverSession } from '../js/symbolic/solver/session.js';
import { SOLVER_STATUS } from '../js/symbolic/solver/result.js';

class TestSession extends SolverSession {
  async _executeCheck() { return { status: SOLVER_STATUS.UNKNOWN }; }
}

test('#5395 a truthy non-function addEventListener is rejected before in-flight registration', async () => {
  const session = new TestSession({ id: 'test', version: '1' });
  await assert.rejects(
    () => session.check({}, { signal: { aborted: false, addEventListener: true, removeEventListener() {} } }),
    (error) => error instanceof TypeError && /AbortSignal-compatible/.test(error.message),
  );
  assert.equal(session._inFlight.size, 0, 'no stranded in-flight record may survive the rejection');
});

test('#5395 a truthy non-function removeEventListener is rejected before in-flight registration', async () => {
  const session = new TestSession({ id: 'test', version: '1' });
  await assert.rejects(
    () => session.check({}, { signal: { aborted: false, addEventListener() {}, removeEventListener: true } }),
    (error) => error instanceof TypeError && /AbortSignal-compatible/.test(error.message),
  );
  assert.equal(session._inFlight.size, 0, 'cleanup incompatibility must fail before publication');
});

test('#5395 throwing addEventListener fails atomically before in-flight publication', async () => {
  const session = new TestSession({ id: 'test', version: '1' });
  const signal = {
    aborted: false,
    addEventListener() { throw new Error('boom'); },
    removeEventListener() {},
  };
  await assert.rejects(
    () => session.check({}, { signal }),
    (error) => error instanceof TypeError && /AbortSignal-compatible/.test(error.message),
  );
  assert.equal(session._inFlight.size, 0, 'listener setup failure must not strand an in-flight record');
});

test('#5395 throwing removeEventListener cannot strand a settled record', async () => {
  const session = new TestSession({ id: 'test', version: '1' });
  const signal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() { throw new Error('cleanup-boom'); },
  };
  const result = await session.check({}, { signal });
  assert.equal(result.status, SOLVER_STATUS.UNKNOWN);
  assert.equal(session._inFlight.size, 0, 'cleanup failure must not block deletion or settlement');
});

test('#5395 other malformed signal shapes are rejected up front too', async () => {
  const session = new TestSession({ id: 'test', version: '1' });
  for (const signal of [
    true,
    42,
    'signal',
    { aborted: false, addEventListener: {}, removeEventListener() {} },
    { aborted: false, addEventListener() {} },
  ]) {
    await assert.rejects(
      () => session.check({}, { signal }),
      (error) => error instanceof TypeError && /AbortSignal-compatible/.test(error.message),
      `signal ${JSON.stringify(signal)} must fail with the domain error`,
    );
  }
  assert.equal(session._inFlight.size, 0);
});

test('#5395 real AbortSignal-compatible objects keep working', async () => {
  const session = new TestSession({ id: 'test', version: '1' });
  const controller = new AbortController();
  const result = await session.check({}, { signal: controller.signal });
  assert.ok(result && typeof result.status === 'string');
  assert.equal(session._inFlight.size, 0, 'settled queries must leave the in-flight map');
});

test('#5395 a pre-aborted signal still settles as cancelled without publication', async () => {
  const session = new TestSession({ id: 'test', version: '1' });
  const controller = new AbortController();
  controller.abort();
  const result = await session.check({}, { signal: controller.signal });
  assert.equal(result.status, SOLVER_STATUS.CANCELLED);
  assert.equal(session._inFlight.size, 0);
});
