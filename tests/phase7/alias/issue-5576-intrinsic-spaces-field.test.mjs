import assert from 'node:assert/strict';
import test from 'node:test';

import { effectSummaryAliasRelation } from '../../../js/analysis/alias/legacy-safety-floor.js';

const target = {
  id: 'stack-0',
  kind: 'stack-fixed',
  functionId: 'f',
  offset: '0',
  widthBits: 64,
  origin: { instructionIds: ['i0'] },
};

test('#5576 a canonical intrinsic summary with spaces:["io"] separates from a memory region', () => {
  const memoryWrite = { scope: 'all', spaces: ['io'] };
  assert.equal(effectSummaryAliasRelation(memoryWrite, target, null), 'no');
});

test('#5576 the canonical spaces field keeps same-space and overlapping summaries conservative', () => {
  assert.equal(effectSummaryAliasRelation({ scope: 'all', spaces: ['memory'] }, target, null), 'may');
  assert.equal(effectSummaryAliasRelation({ scope: 'all' }, target, null), 'may');
});

test('#5576 the legacy addressSpaces spelling keeps its historical no answer', () => {
  const memoryWrite = { scope: 'all', addressSpaces: ['io'] };
  assert.equal(effectSummaryAliasRelation(memoryWrite, target, null), 'no');
});
