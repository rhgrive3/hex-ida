import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort, BV_COMPARE_OP } from '../../../js/symbolic/expr/kinds.js';
import { createBool, createBv, createCompare, createFreshSymbol } from '../../../js/symbolic/expr/factory.js';
import { WorkerSolverBackend } from '../../../js/symbolic/solver/worker-backend.js';
import { SOLVER_STATUS, createSolverResult } from '../../../js/symbolic/solver/result.js';
import { CLAIM_KIND, VERIFICATION_QUERY_KIND, createVerificationQuery } from '../../../js/symbolic/verify/query.js';

function canonicalQuery(label) {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: label,
    assertion: createBool(true),
  });
}

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
  const result = await session.check(canonicalQuery('worker-timeout'), { timeoutMs: 5 });
  assert.equal(result.status, SOLVER_STATUS.TIMEOUT);
  assert.equal(result.lifecycle.publishable, false);
  assert.equal(worker.terminateCount, 1);
  assert.equal(session.isTerminated(), true);

  const reused = await session.check(canonicalQuery('must-not-reuse'));
  assert.equal(reused.status, SOLVER_STATUS.INVALID_QUERY);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(worker.terminateCount, 1);
});

test('worker cancellation and disposal are idempotent hard cleanup boundaries', async () => {
  const cancelledWorker = new MockWorker({ delayMs: 40 });
  const cancelledSession = workerBackend(cancelledWorker).createSession();
  const cancelled = cancelledSession.check(canonicalQuery('worker-cancel'));
  await cancelledSession.cancel();
  await cancelledSession.cancel();
  assert.equal((await cancelled).status, SOLVER_STATUS.CANCELLED);
  assert.equal(cancelledWorker.terminateCount, 1);

  const disposedWorker = new MockWorker({ delayMs: 40 });
  const disposedSession = workerBackend(disposedWorker).createSession();
  const disposed = disposedSession.check(canonicalQuery('worker-dispose'));
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
  const first = session.check(canonicalQuery('worker-first'));
  const second = session.check(canonicalQuery('worker-second'));
  const firstResult = await first;
  const secondResult = await second;
  assert.equal(firstResult.status, SOLVER_STATUS.CANCELLED);
  assert.equal(firstResult.lifecycle.stale, true);
  assert.equal(firstResult.lifecycle.publishable, false);
  assert.equal(secondResult.status, SOLVER_STATUS.UNSAT);
  assert.equal(secondResult.lifecycle.publishable, true);
});

test('worker transport rejects mismatched request tokens and result identity', async () => {
  class CorruptWorker extends MockWorker {
    postMessage(message) {
      this.messages.push(message);
      if (message.type !== 'solver-check') return;
      queueMicrotask(() => this.dispatch('message', {
        type: 'solver-result',
        requestId: message.requestId,
        token: message.token + 1,
        result: createSolverResult({
          status: SOLVER_STATUS.UNSAT,
          backend: 'worker-test-backend',
          backendVersion: '1.0.0',
          queryHash: message.query.queryHash,
        }),
      }));
    }
  }
  const result = await workerBackend(new CorruptWorker()).createSession().check(canonicalQuery('identity-corruption'));
  assert.equal(result.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(result.lifecycle.publishable, false);
});

test('exact session revalidates mutable query identity before publication', async () => {
  const worker = new MockWorker({ delayMs: 20 });
  const session = workerBackend(worker).createSession();
  const candidate = structuredClone(canonicalQuery('mutable-query'));
  const pending = session.check(candidate);
  candidate.targetEntity = 'mutated-while-solving';
  const result = await pending;
  assert.equal(result.status, SOLVER_STATUS.INVALID_QUERY);
  assert.match(result.reason, /^query-identity-changed-during-execution:/);
  assert.equal(result.queryHash, null);
  assert.equal(result.lifecycle.publishable, false);
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
    const result = await session.check(canonicalQuery(`repeat-timeout-${i}`), { timeoutMs: 3 });
    assert.equal(result.status, SOLVER_STATUS.TIMEOUT);
    assert.equal(worker.terminateCount, 1);
    assert.equal((await session.check(canonicalQuery(`reuse-${i}`))).status, SOLVER_STATUS.INVALID_QUERY);
  }
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.deepEqual(workers.map((worker) => worker.terminateCount), [1, 1, 1]);
});

test('worker host enforces global constraint and expression authority before transport', async () => {
  const worker = new MockWorker();
  const backend = new WorkerSolverBackend({ workerFactory: () => worker, maxConstraints: 1 });
  const over = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    constraints: [createBool(true), createBool(true)],
  });
  const result = await backend.createSession({ maxConstraints: Number.MAX_SAFE_INTEGER }).check(over, { maxConstraints: Number.MAX_SAFE_INTEGER });
  assert.equal(result.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(result.reason, 'constraint-budget-exceeded');
  assert.equal(result.lifecycle.publishable, false);
  assert.deepEqual(worker.messages, []);

  const forged = structuredClone(canonicalQuery('map-identity'));
  forged.targetEntity = new Map([['edge', 'different']]);
  const identityResult = await backend.createSession().check(forged);
  assert.equal(identityResult.status, SOLVER_STATUS.INVALID_QUERY);
  assert.equal(identityResult.lifecycle.publishable, false);
  assert.deepEqual(worker.messages, []);

  const x = createFreshSymbol(bvSort(4), 'worker_raw_constant');
  for (const value of [17n, -1n, 16n]) {
    const raw = { kind: 'const', sort: bvSort(4), value };
    const invalidConstant = createVerificationQuery({
      kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
      claimKind: CLAIM_KIND.EDGE_FEASIBLE,
      constraints: [createCompare(BV_COMPARE_OP.EQ, x, createBv(4, 1n)), createCompare(BV_COMPARE_OP.EQ, x, raw)],
    });
    const constantResult = await workerBackend(worker).createSession().check(invalidConstant);
    assert.equal(constantResult.status, SOLVER_STATUS.UNSUPPORTED);
    assert.equal(constantResult.reason, 'noncanonical-bv-constant');
  }
  assert.deepEqual(worker.messages, []);
});

test('worker boundary independently rejects incomplete, extra, mismatched, and noncanonical SAT models', async () => {
  const x = createFreshSymbol(bvSort(32), 'worker_model_x');
  const candidate = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    assertion: createCompare(BV_COMPARE_OP.EQ, x, createBv(32, 7n)),
  });
  class SatWorker extends MockWorker {
    constructor(model) { super(); this.model = model; }
    postMessage(message) {
      this.messages.push(message);
      if (message.type !== 'solver-check') return;
      queueMicrotask(() => this.dispatch('message', {
        type: 'solver-result',
        requestId: message.requestId,
        token: message.token,
        result: createSolverResult({
          status: SOLVER_STATUS.SAT,
          model: this.model,
          backend: 'worker-test-backend',
          backendVersion: '1.0.0',
          queryHash: message.query.queryHash,
        }),
      }));
    }
  }
  for (const model of [
    {},
    { [x.symbolId]: 7n, extra: 0n },
    { [x.symbolId]: 8n },
    { [x.symbolId]: '7' },
    { [x.symbolId]: 7 },
    { [x.symbolId]: -1n },
    { [x.symbolId]: 1n << 32n },
  ]) {
    const result = await workerBackend(new SatWorker(model)).createSession().check(candidate);
    assert.equal(result.status, SOLVER_STATUS.PROVIDER_FAILURE);
    assert.equal(result.lifecycle.publishable, false);
  }
  const accepted = await workerBackend(new SatWorker(new Map([[x.symbolId, 7n]]))).createSession().check(candidate);
  assert.equal(accepted.status, SOLVER_STATUS.SAT);
  assert.equal(accepted.model.get(x.symbolId), 7n);
  assert.throws(() => accepted.model.set(x.symbolId, 8n), TypeError);
});
