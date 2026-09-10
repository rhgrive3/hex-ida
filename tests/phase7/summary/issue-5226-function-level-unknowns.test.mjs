import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { summaryIsPure } from '../../../js/analysis/summary/contract.js';

// Canonical Semantic IR: function-level gaps recorded in `unknowns` with every
// node complete. Valid per validateNormalizedFunction() (js/semantics/ir/function.js).
function partialIr(overrides = {}) {
  return {
    functionId: 'partial_fn',
    nodes: [
      { id: 'n0', kind: 'const', completeness: 'complete' },
      { id: 'n1', kind: 'ret', completeness: 'complete' },
    ],
    unknowns: [{ kind: 'unscanned-region', detail: 'lowering gap' }],
    completeness: 'partial',
    ...overrides,
  };
}

const args = () => [{}, { definitions: [], uses: [] }, {}, { snapshotId: 's-5226' }];

test('#5226 function-level unknowns keep the summary partial and non-pure', () => {
  const { summary } = buildLocalFunctionSummary(partialIr(), ...args());
  assert.equal(summary.status.completeness, 'partial',
    `function-level unknowns must not publish complete: ${summary.status.completeness}`);
  assert.equal(summaryIsPure(summary), false);
});

test('#5226 a non-complete ir.completeness alone degrades the summary', () => {
  const ir = partialIr({ unknowns: [] });
  // partial + empty unknowns is not a canonical spelling, but the summary
  // must still refuse completeness for a non-complete IR.
  const { summary } = buildLocalFunctionSummary(ir, ...args());
  assert.equal(summary.status.completeness, 'partial');
});

test('#5226 a complete IR with no unknowns keeps its complete summary', () => {
  const ir = partialIr({ unknowns: [], completeness: 'complete' });
  const { summary } = buildLocalFunctionSummary(ir, ...args());
  assert.equal(summary.status.completeness, 'complete');
  assert.equal(summaryIsPure(summary), true);
});
