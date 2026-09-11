import assert from 'node:assert/strict';
import { ContextBroker } from '../../../js/ai/context/broker.js';

const failures = [];
function check(name, fn) {
  try { fn(); }
  catch (error) { failures.push(new Error(`${name}: ${error.message}`, { cause: error })); }
}

// #4172: budget authority is typed. JavaScript ToNumber-compatible values must
// not become context/retention/line budgets, and conversion hooks must not run.
check('constructor maxBytes rejects arrays', () => {
  const broker = new ContextBroker({}, { maxBytes: ['1000000'] });
  assert.equal(broker.maxBytes, 128 * 1024);
});

check('constructor maxObservationBytes rejects numeric strings', () => {
  const broker = new ContextBroker({}, { maxObservationBytes: '500000' });
  assert.equal(broker.maxObservationBytes, 12 * 1024);
});

check('constructor maxFunctionLines rejects coercible objects without invoking hooks', () => {
  let coercions = 0;
  const coercible = {
    valueOf() { coercions++; return 900000; },
    toString() { coercions++; return '900000'; },
  };
  const broker = new ContextBroker({}, { maxFunctionLines: coercible });
  assert.equal(broker.maxFunctionLines, 160);
  assert.equal(coercions, 0, 'invalid budget values must not invoke conversion hooks');
});

check('turn budget rejects structured numeric-like values', () => {
  const broker = new ContextBroker({}, {
    maxBytes: 64 * 1024,
    maxObservationBytes: 12 * 1024,
  });
  const built = broker.buildModelContext({
    request: { mode: 'agent', style: 'analyst', scope: 'binary' },
    includeHistory: false,
    budgetBytes: ['4096'],
    observations: Array.from({ length: 4 }, (_, index) => ({
      tool: 'search_strings',
      summary: `${index}:` + 'x'.repeat(1500),
      evidenceIds: [],
      data: { marker: `issue-4172-budget-authority-${index}` },
    })),
  });
  assert.equal(built.context.recentObservations.length, 4,
    'invalid turn budget must fall back to broker maxBytes instead of shrinking the context');
  assert.equal(built.context.recentObservations[3].data.marker, 'issue-4172-budget-authority-3');
});

check('primitive numeric budgets preserve existing min/floor behavior', () => {
  const broker = new ContextBroker({}, {
    maxBytes: 5000,
    maxObservationBytes: 1500.5,
    maxFunctionLines: 12.9,
  });
  assert.equal(broker.maxBytes, 5000);
  assert.equal(broker.maxObservationBytes, 1500.5);
  assert.equal(broker.maxFunctionLines, 12);

  const minimums = new ContextBroker({}, {
    maxBytes: 1,
    maxObservationBytes: 1,
    maxFunctionLines: 1,
  });
  assert.equal(minimums.maxBytes, 4096);
  assert.equal(minimums.maxObservationBytes, 1024);
  assert.equal(minimums.maxFunctionLines, 8);
});

check('non-finite/non-positive numeric budgets keep fallback behavior', () => {
  const broker = new ContextBroker({}, {
    maxBytes: NaN,
    maxObservationBytes: Infinity,
    maxFunctionLines: 0,
  });
  assert.equal(broker.maxBytes, 128 * 1024);
  assert.equal(broker.maxObservationBytes, 12 * 1024);
  assert.equal(broker.maxFunctionLines, 160);
});

if (failures.length) throw new AggregateError(failures, `#4172: ${failures.length} regression(s) failed`);
console.log('issue-4172-context-broker-budget-type: PASS');
