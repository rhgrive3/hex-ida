// Regression for #5854: a call summary marked `completeness:'complete'` was
// accepted with `noreturn`/`mayThrow` omitted (normalized to null), so a call
// with no control-flow knowledge could publish as complete — the unresolved
// check only recognized the explicit 'unknown' string. Omitted knowledge is
// unprovided knowledge: it must count as unresolved, while explicit true/false
// keep publishing.
import assert from 'node:assert/strict';
import { createSemanticCallSummary } from '../js/semantics/ir/types.js';

const base = {
  targetEntityIds: ['callee'],
  arguments: [],
  returns: [],
  stateReads: [],
  stateWrites: [],
  memoryRead: { scope: 'none' },
  memoryWrite: { scope: 'none' },
  controlEffects: [],
  determinism: 'deterministic',
  summarySource: 'test',
  completeness: 'complete',
};

assert.throws(
  () => createSemanticCallSummary({ ...base }),
  (error) => error.message === 'semantic-ir-complete-call-has-unknown-effects',
  'an omitted noreturn/mayThrow must block a complete call',
);

assert.throws(
  () => createSemanticCallSummary({ ...base, noreturn: 'unknown' }),
  (error) => error.message === 'semantic-ir-complete-call-has-unknown-effects',
  'an explicit unknown noreturn still blocks a complete call',
);

assert.throws(
  () => createSemanticCallSummary({ ...base, noreturn: false }),
  (error) => error.message === 'semantic-ir-complete-call-has-unknown-effects',
  'mayThrow must be provided as well',
);

const complete = createSemanticCallSummary({ ...base, noreturn: false, mayThrow: false });
assert.equal(complete.noreturn, false);
assert.equal(complete.mayThrow, false);

const partial = createSemanticCallSummary({
  ...base,
  completeness: 'partial',
  noreturn: null,
  mayThrow: null,
  unknownEffects: { reason: 'not yet lifted', categories: ['control'] },
});
assert.equal(partial.noreturn, null, 'partial summaries keep null knowledge as null');
