import test from 'node:test';
import assert from 'node:assert/strict';

import { createFreshSymbol, createConnective } from '../js/symbolic/expr/factory.js';
import { boolSort, BOOL_CONNECTIVE_OP } from '../js/symbolic/expr/kinds.js';
import {
  createVerificationQuery,
  VERIFICATION_QUERY_KIND,
  CLAIM_KIND,
} from '../js/symbolic/verify/query.js';
import { WorkerSolverBackend } from '../js/symbolic/solver/worker-backend.js';
import { ExhaustiveBvBackend } from '../js/symbolic/solver/exhaustive-backend.js';
import { SOLVER_STATUS, createSolverResult } from '../js/symbolic/solver/result.js';

const DEFAULTS = {
  maxBvWidth: 8,
  maxAssignments: 1 << 20,
  maxConstraints: 4096,
  maxExprNodes: 100000,
};

const BUDGETS = ['maxBvWidth', 'maxAssignments', 'maxConstraints', 'maxExprNodes'];

const REJECTED = [
  ['numeric string', '32'],
  ['numeric array', ['4']],
  ['boolean true', true],
  ['boolean false', false],
  ['object', {}],
  ['fraction', 2.5],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['negative infinity', Number.NEGATIVE_INFINITY],
  ['unsafe integer', Number.MAX_SAFE_INTEGER + 10],
  ['zero', 0],
  ['negative', -5],
  ['bigint', 8n],
];

class CapturingWorker {
  constructor() {
    this.messages = [];
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message) {
    this.messages.push(message);
    if (message.type !== 'solver-check') return;
    setTimeout(() => {
      for (const listener of this.listeners.get('message') || []) {
        listener({
          data: {
            type: 'solver-result',
            requestId: message.requestId,
            result: createSolverResult({
              status: SOLVER_STATUS.UNSAT,
              backend: 'worker-4957',
              backendVersion: '1.0.0',
              queryHash: message.query?.queryHash,
            }),
          },
        });
      }
    }, 0);
  }

  terminate() {}
}

function workerBackend(overrides = {}) {
  return new WorkerSolverBackend({
    id: 'worker-4957',
    version: '1.0.0',
    workerFactory: () => new CapturingWorker(),
    ...overrides,
  });
}

function xorQuery() {
  const a = createFreshSymbol(boolSort(), 'a-4957');
  const b = createFreshSymbol(boolSort(), 'b-4957');
  const query = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: 'issue-4957',
    constraints: [],
    assertion: createConnective(BOOL_CONNECTIVE_OP.XOR, a, b),
  });
  return { query, a, b };
}

test('#4957 WorkerSolverBackend keeps valid primitive positive safe-integer budgets', () => {
  const backend = workerBackend({ maxBvWidth: 16, maxAssignments: 512, maxConstraints: 77, maxExprNodes: 250 });
  assert.equal(backend.maxBvWidth, 16);
  assert.equal(backend.maxAssignments, 512);
  assert.equal(backend.maxConstraints, 77);
  assert.equal(backend.maxExprNodes, 250);
});

test('#4957 WorkerSolverBackend preserves existing defaults when budgets are omitted', () => {
  const backend = workerBackend();
  assert.equal(backend.maxBvWidth, DEFAULTS.maxBvWidth);
  assert.equal(backend.maxAssignments, DEFAULTS.maxAssignments);
  assert.equal(backend.maxConstraints, DEFAULTS.maxConstraints);
  assert.equal(backend.maxExprNodes, DEFAULTS.maxExprNodes);
});

for (const [label, bad] of REJECTED) {
  test(`#4957 WorkerSolverBackend rejects ${label} instead of coercing it into a budget`, () => {
    for (const budget of BUDGETS) {
      assert.throws(
        () => workerBackend({ [budget]: bad }),
        TypeError,
        `worker ${budget} must reject ${label}`,
      );
    }
  });
}

for (const [label, bad] of REJECTED) {
  test(`#4957 ExhaustiveBvBackend rejects ${label} instead of coercing it into a budget`, () => {
    for (const budget of BUDGETS) {
      assert.throws(
        () => new ExhaustiveBvBackend({ [budget]: bad }),
        TypeError,
        `exhaustive ${budget} must reject ${label}`,
      );
    }
  });
}

test('#4957 the issue minimal counterexample never promotes a schema violation into a budget', () => {
  assert.throws(() => workerBackend({
    maxBvWidth: ['4'],
    maxAssignments: '32',
    maxConstraints: true,
    maxExprNodes: ['100'],
  }), TypeError);
});

test('#4957 Worker and Exhaustive share one budget contract for rejected values', () => {
  for (const [label, bad] of REJECTED) {
    let workerThrew = false;
    let exhaustiveThrew = false;
    try { workerBackend({ maxConstraints: bad }); } catch (error) { workerThrew = error instanceof TypeError; }
    try { new ExhaustiveBvBackend({ maxConstraints: bad }); } catch (error) { exhaustiveThrew = error instanceof TypeError; }
    assert.equal(workerThrew, true, `worker must reject ${label}`);
    assert.equal(exhaustiveThrew, true, `exhaustive must reject ${label}`);
  }
});

test('#4957 Worker and Exhaustive normalize identical valid budgets and capabilities', () => {
  const valid = { maxBvWidth: 12, maxAssignments: 1024, maxConstraints: 64, maxExprNodes: 5000 };
  const worker = workerBackend(valid);
  const exhaustive = new ExhaustiveBvBackend(valid);
  for (const budget of BUDGETS) {
    assert.equal(worker[budget], exhaustive[budget], `${budget} contract parity`);
    assert.equal(worker[budget], valid[budget]);
  }
  const workerCaps = worker.baseCapabilities();
  assert.equal(workerCaps.maxBvWidth, 12);
  assert.equal(workerCaps.maxAssignments, 1024);
  assert.equal(workerCaps.maxConstraints, 64);
  assert.equal(workerCaps.maxExprNodes, 5000);
});

test('#4957 exact proof authority and capability fingerprint are preserved', () => {
  const backend = workerBackend({ maxConstraints: 64 });
  const capabilities = backend.capabilities();
  assert.equal(capabilities.proofAuthority, 'exact');
  assert.equal(capabilities.executionIsolation, 'dedicated-worker');
  assert.equal(capabilities.exactProofs, true);
  assert.equal(typeof capabilities.capabilityFingerprint, 'string');
  assert.equal(capabilities.capabilityFingerprint, backend.capabilityFingerprint());
  assert.equal(capabilities.maxConstraints, 64);
});

test('#4957 validated budgets flow through the worker transport without weakening execution', async () => {
  const worker = new CapturingWorker();
  const backend = new WorkerSolverBackend({
    id: 'worker-4957',
    version: '1.0.0',
    maxConstraints: 77,
    maxExprNodes: 250,
    workerFactory: () => worker,
  });
  const session = backend.createSession();
  assert.equal(session.options.maxConstraints, 77);
  assert.equal(session.options.maxBvWidth, DEFAULTS.maxBvWidth);
  const result = await session.check({ queryHash: 'issue-4957-flow' });
  assert.equal(result.status, SOLVER_STATUS.UNSAT);
  assert.equal(result.lifecycle.publishable, true);
  const sent = worker.messages.find((message) => message.type === 'solver-check').options;
  assert.equal(sent.maxConstraints, 77);
  assert.equal(sent.maxExprNodes, 250);
  assert.equal(sent.maxBvWidth, DEFAULTS.maxBvWidth);
  assert.equal(sent.maxAssignments, DEFAULTS.maxAssignments);
});

test('#4957 exact exhaustive session still proves a SAT query under the shared budget contract', async () => {
  const backend = new ExhaustiveBvBackend({ maxBvWidth: 8 });
  const { query, a, b } = xorQuery();
  const result = await backend.createSession().check(query);
  assert.equal(result.status, SOLVER_STATUS.SAT);
  assert.equal(result.lifecycle.publishable, true);
  assert.equal(result.model[a.symbolId] !== result.model[b.symbolId], true);
});
