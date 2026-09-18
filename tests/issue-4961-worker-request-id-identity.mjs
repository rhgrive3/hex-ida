/* Regression coverage for #4961: worker response correlation must accept only
   the canonical primitive decimal-string request identity the host generated,
   so a malformed worker envelope can never launder onto another query. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBool } from '../js/symbolic/expr/factory.js';
import { WorkerSolverBackend } from '../js/symbolic/solver/worker-backend.js';
import { SOLVER_STATUS, createSolverResult } from '../js/symbolic/solver/result.js';
import { isCanonicalRequestId } from '../js/symbolic/solver/worker-protocol.js';
import { CLAIM_KIND, VERIFICATION_QUERY_KIND, createVerificationQuery } from '../js/symbolic/verify/query.js';

class ManualWorker {
  constructor() {
    this.listeners = new Map();
    this.messages = [];
    this.terminateCount = 0;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(data) {
    for (const listener of this.listeners.get('message') || []) listener({ data });
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminateCount += 1;
  }

  issuedRequestId() {
    const check = this.messages.find((message) => message.type === 'solver-check');
    return check?.requestId ?? null;
  }

  issuedToken() {
    const check = this.messages.find((message) => message.type === 'solver-check');
    return check?.token ?? null;
  }
}

function startSession(worker) {
  const backend = new WorkerSolverBackend({
    id: 'worker-identity-backend',
    version: '1.0.0',
    workerFactory: () => worker,
  });
  return backend.createSession({ timeoutMs: 0 });
}

function canonicalUnsatQuery(targetEntity) {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity,
    assertion: createBool(false),
  });
}

function resultFor(query) {
  return createSolverResult({
    status: SOLVER_STATUS.UNSAT,
    backend: 'worker-identity-backend',
    backendVersion: '1.0.0',
    queryHash: query.queryHash,
  });
}

async function flush() {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

async function isPending(promise, ms = 25) {
  const sentinel = Symbol('pending');
  const raced = await Promise.race([
    promise.then(() => 'resolved'),
    new Promise((resolve) => { setTimeout(() => resolve(sentinel), ms); }),
  ]);
  return raced === sentinel;
}

test('issue-4961: canonical decimal-string requestId resolves only its own pending query', async () => {
  const worker = new ManualWorker();
  const session = startSession(worker);
  const submittedQuery = canonicalUnsatQuery('canonical-identity');
  const inFlight = session.check(submittedQuery);
  await flush();
  const requestId = worker.issuedRequestId();
  assert.equal(typeof requestId, 'string');
  assert.equal(requestId, '1');

  worker.dispatch({
    type: 'solver-result',
    requestId,
    token: worker.issuedToken(),
    result: resultFor(submittedQuery),
  });
  const result = await inFlight;
  assert.equal(result.status, SOLVER_STATUS.UNSAT);
  assert.equal(result.lifecycle.publishable, true);
  assert.equal(session.pending.size, 0);
});

test('issue-4961: array requestId aliasing is dropped and keeps the pending entry', async () => {
  const worker = new ManualWorker();
  const session = startSession(worker);
  const submittedQuery = canonicalUnsatQuery('array-alias');
  const inFlight = session.check(submittedQuery);
  await flush();
  const requestId = worker.issuedRequestId();

  worker.dispatch({
    type: 'solver-result',
    requestId: [requestId],
    token: worker.issuedToken(),
    result: resultFor(submittedQuery),
  });
  assert.equal(await isPending(inFlight), true);
  assert.equal(session.pending.size, 1);
  assert.equal(session.pending.has(requestId), true);
  assert.equal(worker.terminateCount, 0);

  worker.dispatch({
    type: 'solver-result',
    requestId,
    token: worker.issuedToken(),
    result: resultFor(submittedQuery),
  });
  const result = await inFlight;
  assert.equal(result.status, SOLVER_STATUS.UNSAT);
  assert.equal(result.lifecycle.publishable, true);
});

test('issue-4961: object, number, boolean and null requestIds never correlate', async () => {
  const hostile = [
    { toString: () => '1' },
    1,
    true,
    null,
    undefined,
    '',
    ' 1',
    '1 ',
    '01',
    '+1',
    '1.0',
    '0x1',
    '1n',
  ];
  for (const requestId of hostile) {
    const worker = new ManualWorker();
    const session = startSession(worker);
    const submittedQuery = canonicalUnsatQuery(`hostile-${String(typeof requestId)}`);
    const inFlight = session.check(submittedQuery);
    await flush();
    const issued = worker.issuedRequestId();

    worker.dispatch({
      type: 'solver-result',
      requestId,
      token: worker.issuedToken(),
      result: resultFor(submittedQuery),
    });
    assert.equal(await isPending(inFlight, 10), true, `must not correlate: ${String(requestId)}`);
    assert.equal(session.pending.has(issued), true);
    assert.equal(worker.terminateCount, 0);
    await session.dispose();
  }
});

test('issue-4961: unknown and stale canonical ids still drop without deleting pending entries', async () => {
  const worker = new ManualWorker();
  const session = startSession(worker);
  const submittedQuery = canonicalUnsatQuery('unknown-id');
  const inFlight = session.check(submittedQuery);
  await flush();
  const issued = worker.issuedRequestId();

  worker.dispatch({
    type: 'solver-result',
    requestId: '9876543210',
    token: worker.issuedToken(),
    result: resultFor(submittedQuery),
  });
  assert.equal(await isPending(inFlight, 10), true);
  assert.equal(session.pending.has(issued), true);

  worker.dispatch({
    type: 'solver-result',
    requestId: issued,
    token: worker.issuedToken(),
    result: resultFor(submittedQuery),
  });
  assert.equal((await inFlight).status, SOLVER_STATUS.UNSAT);
});

test('issue-4961: malformed envelopes never bypass the timeout termination boundary', async () => {
  const backend = new WorkerSolverBackend({
    id: 'worker-identity-backend',
    version: '1.0.0',
    workerFactory: () => new ManualWorker(),
  });
  const session = backend.createSession();
  const result = await session.check(canonicalUnsatQuery('malformed-timeout'), { timeoutMs: 5 });
  assert.equal(result.status, SOLVER_STATUS.TIMEOUT);
  assert.equal(result.lifecycle.publishable, false);
  assert.equal(session.isTerminated(), true);
});

test('issue-4961: shared envelope validator accepts every host-minted id and nothing laundered', async () => {
  const worker = new ManualWorker();
  const session = startSession(worker);
  const started = [];
  for (let i = 0; i < 3; i += 1) {
    started.push(session.check(canonicalUnsatQuery(`minted-${i}`)));
    await flush();
  }
  const minted = worker.messages
    .filter((message) => message.type === 'solver-check')
    .map((message) => message.requestId);
  assert.equal(minted.length, 3);
  for (const requestId of minted) {
    assert.equal(isCanonicalRequestId(requestId), true);
  }

  for (const rejected of [[minted[0]], { toString: () => minted[0] }, Number(minted[0]), -minted[0]]) {
    assert.equal(isCanonicalRequestId(rejected), false);
  }
  await session.dispose();
  for (const inFlight of started) {
    assert.equal(typeof (await inFlight).status, 'string');
  }
});
