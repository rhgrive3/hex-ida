import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticCallSummary } from '../../js/semantics/ir/types.js';
import { buildLocalFunctionSummary } from '../../js/analysis/summary/local.js';

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

function callIr(callControl) {
  return {
    functionId: 'caller',
    values: [],
    nodes: [{
      id: 'call0',
      blockId: 'entry',
      kind: 'call',
      completeness: 'complete',
      inputs: [],
      outputs: [],
      call: {
        targetValueIds: [],
        targetEntityIds: ['callee'],
        arguments: [],
        returns: [],
        memoryRead: { scope: 'none' },
        memoryWrite: { scope: 'none' },
        stateReads: [],
        stateWrites: [],
        controlEffects: [],
        determinism: 'deterministic',
        summarySource: 'issue-5854-fixture',
        completeness: 'complete',
        ...callControl,
      },
    }],
    blocks: [],
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

test('#5854 local summary cannot promote omitted control knowledge to negative facts', () => {
  // On the pre-fix contract the complete call with omitted knowledge published
  // mayThrow:false / noreturn:false into the caller's FunctionSummary. Now the
  // degraded call carries an explicit unknown effect and unknown control facts.
  const result = buildLocalFunctionSummary(callIr({}), null, { definitions: [], uses: [] }, null, {
    snapshotId: 'issue-5854-snapshot',
  });
  assert.ok(result?.summary, 'the pass still publishes, but with unknown control facts');
  assert.equal(result.summary.noreturn, 'unknown');
  assert.equal(result.summary.mayThrow, 'unknown');
  assert.ok(
    (result.summary.unknownCallEffects ?? []).some((effect) => effect.reason === 'summary-incomplete'),
    'the omitted-knowledge call must surface as an unknown call effect',
  );
});

test('#5854 explicit proven control knowledge still composes into the caller summary', () => {
  const result = buildLocalFunctionSummary(callIr({ noreturn: false, mayThrow: false }), null, { definitions: [], uses: [] }, null, {
    snapshotId: 'issue-5854-snapshot',
  });
  assert.ok(result?.summary, 'the caller summary still publishes for explicit control knowledge');
  assert.equal(result.summary.mayThrow, false);
});
