import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLocalFunctionSummary } from '../../js/analysis/summary/local.js';

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

test('#5854 local summary cannot promote omitted call control knowledge to negative facts', () => {
  // Raw (non-canonicalized) IR can still reach the local producer with a
  // complete call whose noreturn/mayThrow were never specified. Pre-fix the
  // pass read the missing fields as "returns / does not throw" and published
  // proven-looking negative control facts into the caller summary.
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

test('#5854 a one-sided null control field also degrades to unknown', () => {
  for (const partial of [{ noreturn: false }, { mayThrow: false }]) {
    const result = buildLocalFunctionSummary(callIr(partial), null, { definitions: [], uses: [] }, null, {
      snapshotId: 'issue-5854-snapshot',
    });
    assert.ok(result?.summary);
    assert.equal(result.summary.noreturn, 'unknown');
    assert.equal(result.summary.mayThrow, 'unknown');
  }
});

test('#5854 explicit proven control knowledge still composes into the caller summary', () => {
  const result = buildLocalFunctionSummary(callIr({ noreturn: false, mayThrow: false }), null, { definitions: [], uses: [] }, null, {
    snapshotId: 'issue-5854-snapshot',
  });
  assert.ok(result?.summary, 'the caller summary still publishes for explicit control knowledge');
  assert.equal(result.summary.mayThrow, false);
  assert.equal(result.summary.noreturn, false);
  assert.equal((result.summary.unknownCallEffects ?? []).length, 0);
});
