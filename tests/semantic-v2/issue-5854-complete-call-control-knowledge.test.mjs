import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticCallSummary } from '../../js/semantics/ir/types.js';

function completeCallInput(control = {}) {
  return {
    targetEntityIds: ['callee'],
    arguments: [],
    returns: [],
    stateReads: [],
    stateWrites: [],
    memoryRead: { scope: 'none' },
    memoryWrite: { scope: 'none' },
    controlEffects: [],
    determinism: 'deterministic',
    summarySource: 'issue-5854-fixture',
    completeness: 'complete',
    ...control,
  };
}

test('#5854 complete call with omitted noreturn/mayThrow is rejected, not silently completed', () => {
  assert.throws(
    () => createSemanticCallSummary(completeCallInput()),
    /semantic-ir-complete-call-missing-control-knowledge/,
  );
});

test('#5854 complete call rejects a null noreturn even when mayThrow is explicit', () => {
  assert.throws(
    () => createSemanticCallSummary(completeCallInput({ mayThrow: false })),
    /semantic-ir-complete-call-missing-control-knowledge/,
  );
  assert.throws(
    () => createSemanticCallSummary(completeCallInput({ noreturn: false })),
    /semantic-ir-complete-call-missing-control-knowledge/,
  );
});

test('#5854 complete call with explicit boolean control knowledge still canonicalizes', () => {
  const summary = createSemanticCallSummary(completeCallInput({ noreturn: false, mayThrow: false }));
  assert.equal(summary.completeness, 'complete');
  assert.equal(summary.noreturn, false);
  assert.equal(summary.mayThrow, false);
  const proving = createSemanticCallSummary(completeCallInput({ noreturn: true, mayThrow: false }));
  assert.equal(proving.noreturn, true);
  assert.equal(proving.mayThrow, false);
});

test('#5854 partial call keeps the fail-closed unknown contract', () => {
  const summary = createSemanticCallSummary({
    targetEntityIds: ['callee'],
    arguments: [],
    returns: [],
    stateReads: [],
    stateWrites: [],
    memoryRead: { scope: 'all', addressSpaces: ['memory'] },
    memoryWrite: { scope: 'all', addressSpaces: ['memory'] },
    controlEffects: [],
    determinism: 'unknown',
    noreturn: 'unknown',
    mayThrow: 'unknown',
    summarySource: 'issue-5854-partial-fixture',
    completeness: 'partial',
    unknownEffects: { reason: 'callee effects unresolved', categories: ['control'] },
  });
  assert.equal(summary.completeness, 'partial');
  assert.equal(summary.noreturn, 'unknown');
  assert.equal(summary.mayThrow, 'unknown');
});
