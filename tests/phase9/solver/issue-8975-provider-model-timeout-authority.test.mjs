import assert from 'node:assert/strict';
import test from 'node:test';

import { SolverSession } from '../../../js/symbolic/solver/session.js';
import { SOLVER_STATUS, isValidSolverResult } from '../../../js/symbolic/solver/result.js';

// #8975: a provider-supplied SAT model is canonicalized (recursively deep-copied
// and frozen) *after* SolverSession.settle() has already committed the lifecycle
// (record.settled = true, host timer cleared, entry removed from _inFlight). An
// over-deep or over-wide model therefore either overflowed the stack inside
// createSolverResult (abandoning the promise with no timer and no in-flight
// record) or exhausted the heap during the un-budgeted copy. Legitimate models
// from the exhaustive backend are flat symbol->scalar assignments (depth <= 2).

async function within(promise, ms = 500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve('__UNSETTLED__'), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class ModelSession extends SolverSession {
  constructor(model, options = {}) {
    super({ id: 'provider', version: '1' }, { timeoutMs: 25, ...options });
    this.model = model;
  }

  async _executeCheck() {
    let model = this.model;
    if (typeof this.model === 'function') model = this.model();
    return { status: SOLVER_STATUS.SAT, model, backend: 'provider', backendVersion: '1' };
  }
}

function deepModel(depth) {
  let model = { v: 1 };
  for (let i = 0; i < depth; i += 1) model = { next: model };
  return model;
}

test('over-deep provider model resolves to a bounded resource-limit result instead of stranding the promise', async () => {
  const session = new ModelSession(() => deepModel(5000));
  let result;
  try {
    result = await within(session.check({}));
  } finally {
    await session.dispose();
  }
  assert.notEqual(result, '__UNSETTLED__', 'the timeout guard must never be defeated by canonicalization failure');
  assert.equal(result.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(result.model, null, 'an over-budget model is not published as a proved SAT answer');
  assert.equal(result.lifecycle.publishable, false);
  assert.equal(result.lifecycle.budgetExceeded, true);
  assert.ok(isValidSolverResult(result));
  assert.equal(session._inFlight.size, 0, 'no in-flight record may leak after settlement');
});

test('over-wide provider model is bounded by the node budget during canonicalization', async () => {
  const session = new ModelSession(() => new Array(210_001).fill(null).map(() => ({ v: 1 })));
  let result;
  try {
    result = await within(session.check({}));
  } finally {
    await session.dispose();
  }
  assert.notEqual(result, '__UNSETTLED__');
  assert.equal(result.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(result.model, null);
  assert.equal(result.lifecycle.publishable, false);
});

test('hostile model whose getter throws still resolves the lifecycle (never strands)', async () => {
  const hostile = { get bad() { throw new Error('hostile canonicalization'); } };
  const session = new ModelSession(hostile);
  let result;
  try {
    result = await within(session.check({}));
  } finally {
    await session.dispose();
  }
  assert.notEqual(result, '__UNSETTLED__', 'a throwing provider result must resolve, not be abandoned');
  assert.equal(result.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(result.model, null);
});

test('shallow legitimate model still publishes SAT with an owned immutable snapshot', async () => {
  const session = new ModelSession({ sym_0: true, sym_1: 3n, sym_2: { inner: 7 } });
  let result;
  try {
    result = await within(session.check({}));
  } finally {
    await session.dispose();
  }
  assert.notEqual(result, '__UNSETTLED__');
  assert.equal(result.status, SOLVER_STATUS.SAT);
  assert.equal(result.lifecycle.publishable, true);
  assert.equal(result.model.sym_1, 3n);
  assert.equal(Object.isFrozen(result.model), true);
  assert.equal(Object.isFrozen(result.model.sym_2), true);
  assert.ok(isValidSolverResult(result));
});

test('a never-settling provider still falls back to the authoritative host timeout', async () => {
  class NeverSession extends SolverSession {
    async _executeCheck() { return new Promise(() => {}); }
  }
  const session = new NeverSession({ id: 'never', version: '1' }, { timeoutMs: 20 });
  let result;
  try {
    result = await within(session.check({}));
  } finally {
    await session.dispose();
  }
  assert.notEqual(result, '__UNSETTLED__');
  assert.equal(result.status, SOLVER_STATUS.TIMEOUT);
  assert.equal(result.lifecycle.timedOut, true);
});
