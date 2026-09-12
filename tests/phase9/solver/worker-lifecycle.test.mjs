import assert from 'node:assert/strict';
import test from 'node:test';

import { createBool } from '../../../js/symbolic/expr/factory.js';
import { CLAIM_KIND, VERIFICATION_QUERY_KIND, createVerificationQuery } from '../../../js/symbolic/verify/query.js';
import { WorkerSolverBackend } from '../../../js/symbolic/solver/worker-backend.js';
import { SOLVER_STATUS, createSolverResult } from '../../../js/symbolic/solver/result.js';

class MockWorker {
  constructor({ delayMs = 0 } = {}) {
    this.delayMs = delayMs;
    this.listeners = new Map();
    this.terminateCount = 0;
    this.messages = [];
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, data) {
    for (const listener of this.listeners.get(type) || []) listener({ data });
  }

  postMessage(message) {
    this.messages.push(message);
    if (message.type !== 'solver-check') return;
    setTimeout(() => {
      this.dispatch('message', {
        type: 'solver-result',
        requestId: message.requestId,
        token: message.token,
        result: createSolverResult({
          status: SOLVER_STATUS.UNSAT,
          backend: 'worker-test-backend',
          backendVersion: '1.0.0',
          queryHash: message.query.queryHash,
        }),
      });
    }, this.delayMs);
  }

  terminate() {
    this.terminateCount++;
  }
}


function query(label) {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
    targetEntity: label,
    assertion: createBool(true),
  });
}

function workerBackend(worker) {
  return new WorkerSolverBackend({
    id: 'worker-test-backend',
    version: '1.0.0',
    workerFactory: () => worker,
  });
}

test('worker timeout terminates the worker and cannot be reused', async () => {
  const worker = new MockWorker({ delayMs: 40 });
  const backend = workerBackend(worker);
  const session = backend.createSession();
  const result = await session.check(query('worker-timeout'), { timeoutMs: 5 });
  assert.equal(result.status, SOLVER_STATUS.TIMEOUT);
  assert.equal(result.lifecycle.publishable, false);
  assert.equal(worker.terminateCount, 1);
  assert.equal(session.isTerminated(), true);

  const reused = await session.check(query('must-not-reuse'));
  assert.equal(reused.status, SOLVER_STATUS.INVALID_QUERY);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(worker.terminateCount, 1);
});

test('worker cancellation and disposal are idempotent hard cleanup boundaries', async () => {
  const cancelledWorker = new MockWorker({ delayMs: 40 });
  const cancelledSession = workerBackend(cancelledWorker).createSession();
  const cancelled = cancelledSession.check(query('worker-cancel'));
  await cancelledSession.cancel();
  await cancelledSession.cancel();
  assert.equal((await cancelled).status, SOLVER_STATUS.CANCELLED);
  assert.equal(cancelledWorker.terminateCount, 1);

  const disposedWorker = new MockWorker({ delayMs: 40 });
  const disposedSession = workerBackend(disposedWorker).createSession();
  const disposed = disposedSession.check(query('worker-dispose'));
  await disposedSession.dispose();
  await disposedSession.dispose();
  const disposedResult = await disposed;
  assert.equal(disposedResult.status, SOLVER_STATUS.CANCELLED);
  assert.equal(disposedResult.lifecycle.publishable, false);
  assert.equal(disposedWorker.terminateCount, 1);
});

test('late worker result after stale token is ignored by the host session', async () => {
  const worker = new MockWorker({ delayMs: 20 });
  const session = workerBackend(worker).createSession();
  const first = session.check(query('worker-first'));
  const second = session.check(query('worker-second'));
  const firstResult = await first;
  const secondResult = await second;
  assert.equal(firstResult.status, SOLVER_STATUS.CANCELLED);
  assert.equal(firstResult.lifecycle.stale, true);
  assert.equal(firstResult.lifecycle.publishable, false);
  assert.equal(secondResult.status, SOLVER_STATUS.UNSAT);
  assert.equal(secondResult.lifecycle.publishable, true);
});

test('worker backend advertises measured-only memory rather than an unenforceable cap', () => {
  const backend = workerBackend(new MockWorker());
  const capabilities = backend.capabilities();
  assert.equal(capabilities.executionIsolation, 'dedicated-worker');
  assert.equal(capabilities.memoryBudgetClass, 'measured-only');
  assert.equal(capabilities.proofAuthority, 'exact');
});

test('repeated worker timeouts terminate every worker and do not leak reusable sessions', async () => {
  const workers = [];
  for (let i = 0; i < 3; i++) {
    const worker = new MockWorker({ delayMs: 30 });
    workers.push(worker);
    const session = workerBackend(worker).createSession();
    const result = await session.check(query(`repeat-timeout-${i}`), { timeoutMs: 3 });
    assert.equal(result.status, SOLVER_STATUS.TIMEOUT);
    assert.equal(worker.terminateCount, 1);
    assert.equal((await session.check(query(`reuse-${i}`))).status, SOLVER_STATUS.INVALID_QUERY);
  }
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.deepEqual(workers.map((worker) => worker.terminateCount), [1, 1, 1]);
});

test('worker result with a mismatched request token is rejected as provider failure', async () => {
  class ForgedTokenWorker extends MockWorker {
    postMessage(message) {
      this.messages.push(message);
      if (message.type !== 'solver-check') return;
      setTimeout(() => {
        this.dispatch('message', {
          type: 'solver-result',
          requestId: message.requestId,
          token: 'forged-token',
          result: createSolverResult({
            status: SOLVER_STATUS.UNSAT,
            backend: 'worker-test-backend',
            backendVersion: '1.0.0',
            queryHash: message.query.queryHash,
          }),
        });
      }, 0);
    }
  }

  const session = workerBackend(new ForgedTokenWorker()).createSession();
  const result = await session.check(query('forged-token'));
  assert.equal(result.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(result.reason, 'solver-worker-result-identity-mismatch');
  assert.equal(result.lifecycle.publishable, false);
});

test('worker SAT model is revalidated on the host before publication', async () => {
  class CorruptModelWorker extends MockWorker {
    postMessage(message) {
      this.messages.push(message);
      if (message.type !== 'solver-check') return;
      setTimeout(() => {
        this.dispatch('message', {
          type: 'solver-result',
          requestId: message.requestId,
          token: message.token,
          result: createSolverResult({
            status: SOLVER_STATUS.SAT,
            model: { unexpected: 1n },
            backend: 'worker-test-backend',
            backendVersion: '1.0.0',
            queryHash: message.query.queryHash,
          }),
        });
      }, 0);
    }
  }

  const session = workerBackend(new CorruptModelWorker()).createSession();
  const result = await session.check(query('corrupt-worker-model'));
  assert.equal(result.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.match(result.reason, /solver-worker-model-validation-failed/);
  assert.equal(result.lifecycle.publishable, false);
});
