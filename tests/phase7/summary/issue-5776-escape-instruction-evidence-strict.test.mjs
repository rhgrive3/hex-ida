import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeEscape } from '../../../js/analysis/summary/escape.js';

// #5776 residual: escape-fact evidence must follow the same canonical
// primitive non-empty string contract as the local summary's instruction
// origin. escape.js used to launder structured IDs with `.map(String)`.
const local = (rootKey) => ({ top: false, targets: [{ rootKey, rootKind: 'rooted' }] });

function runWithOrigin(origin) {
  const pointsToRun = { status: { completeness: 'complete' }, pointsTo: new Map([
    ['A', local('A')],
    ['G', { top: false, targets: [{ rootKey: 'global', rootKind: 'absolute' }] }],
  ]) };
  const ir = {
    nodes: [{
      id: 's1',
      kind: 'store',
      inputs: ['A', 'A'],
      memory: { addressExpr: { valueId: 'A' } },
      origin,
    }],
  };
  return analyzeEscape(ir, {}, {}, pointsToRun, {});
}

test('#5776 canonical string instruction evidence keeps flowing into escape facts', () => {
  const result = runWithOrigin({ instructionIds: ['i0', 'i1', 'i0'] });
  const facts = result.escapes.filter((r) => r.siteId === 's1');
  assert.ok(facts.length >= 1);
  assert.ok(facts.every((r) => r.evidenceIds.includes('i0') || r.evidenceIds.includes('i1')));
  for (const fact of facts) {
    assert.ok(fact.evidenceIds.every((id) => typeof id === 'string'), 'evidence IDs stay primitive strings');
  }
});

test('#5776 a structured instruction ID cannot launder into escape evidence', () => {
  assert.throws(
    () => runWithOrigin({ instructionIds: [['i0']] }),
    (error) => error instanceof TypeError && error.message === 'summary-invalid-instruction-evidence',
  );
  assert.throws(
    () => runWithOrigin({ instructionIds: [{ id: 'i0' }] }),
    (error) => error instanceof TypeError && error.message === 'summary-invalid-instruction-evidence',
  );
  assert.throws(
    () => runWithOrigin({ instructionIds: [42] }),
    (error) => error instanceof TypeError && error.message === 'summary-invalid-instruction-evidence',
  );
  assert.throws(
    () => runWithOrigin({ instructionIds: [''] }),
    (error) => error instanceof TypeError && error.message === 'summary-invalid-instruction-evidence',
  );
});

test('#5776 a non-array instruction origin is rejected, not String()-coalesced', () => {
  assert.throws(
    () => runWithOrigin({ instructionIds: 'i0' }),
    (error) => error instanceof TypeError && error.message === 'summary-invalid-instruction-evidence',
  );
});

test('#5776 absent origin keeps escape analysis working', () => {
  const result = runWithOrigin(undefined);
  const facts = result.escapes.filter((r) => r.siteId === 's1');
  assert.ok(facts.length >= 1);
  assert.deepEqual(facts[0].evidenceIds, []);
});
