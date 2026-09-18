// Regression for #5220: CapabilityRule equality (equals/in/contains) reused
// the lossy identity digest `stableDigest()` as a semantic predicate, so
// values of different types compared equal — e.g. feature BigInt 8n matched
// rule value string '8' and minted a complete `supported` CapabilityFact.
// Contract now: typed equality. Values compare only within the same
// primitive type; a comparison between two non-primitive values (objects/
// Maps/Sets — types the rule language defines no canonical representation
// for) stays undecided → verdict `partial` (fail-closed, no complete
// supported fact from a digest collision). The explicit numeric-coercion
// contract of gte/lte/gt/lt is unchanged.
import assert from 'node:assert/strict';
import { evaluateCapabilityRule } from '../../../js/knowledge/phase12-rules.js';

function evaluate(when, features) {
  return evaluateCapabilityRule(
    { id: 'typed-equality', capabilityId: 'example.capability', scope: 'function', when },
    { snapshotId: 's1', completeness: 'complete', features, evidenceIds: ['ev:amount'] },
  );
}

// 1. equals: BigInt 8n must not match rule string '8' (and vice versa).
{
  const result = evaluate({ op: 'equals', path: 'amount', value: '8' }, { amount: 8n });
  assert.equal(result.verdict, 'not-detected');
  assert.equal(result.completeness, 'complete');
}
{
  const result = evaluate({ op: 'equals', path: 'amount', value: 8 }, { amount: 8n });
  assert.equal(result.verdict, 'not-detected', 'bigint must not equal number');
}

// 2. Same-type same-value keeps matching.
assert.equal(evaluate({ op: 'equals', path: 'amount', value: '8' }, { amount: '8' }).verdict, 'supported');
assert.equal(evaluate({ op: 'equals', path: 'amount', value: 8n }, { amount: 8n }).verdict, 'supported');
assert.equal(evaluate({ op: 'equals', path: 'amount', value: true }, { amount: true }).verdict, 'supported');
// null vs null stays supported; missing path vs null stays not-detected.
assert.equal(evaluate({ op: 'equals', path: 'amount', value: null }, { amount: null }).verdict, 'supported');
assert.equal(evaluate({ op: 'equals', path: 'missing', value: null }, {}).verdict, 'not-detected');

// 3. in preserves the type difference.
assert.equal(evaluate({ op: 'in', path: 'amount', value: ['8', '9'] }, { amount: 8n }).verdict, 'not-detected');
assert.equal(evaluate({ op: 'in', path: 'amount', value: [8n, 9n] }, { amount: 8n }).verdict, 'supported');
assert.equal(evaluate({ op: 'in', path: 'amount', value: ['8', 9] }, { amount: 9 }).verdict, 'supported');

// 4. Array contains preserves the type difference.
assert.equal(evaluate({ op: 'contains', path: 'effects', value: '8' }, { effects: [8n] }).verdict, 'not-detected');
assert.equal(evaluate({ op: 'contains', path: 'effects', value: 8n }, { effects: [8n] }).verdict, 'supported');
assert.equal(evaluate({ op: 'contains', path: 'effects', value: 'xor' }, { effects: ['load', 'xor'] }).verdict, 'supported');

// 5. Non-primitive comparisons are undecided: partial, never complete-supported.
{
  const expected = { id: 'ev-1' };
  const result = evaluate({ op: 'equals', path: 'payload', value: expected }, { payload: { id: 'ev-1' } });
  assert.equal(result.verdict, 'partial');
  assert.equal(result.completeness, 'partial');
}
{
  const result = evaluate({ op: 'equals', path: 'payload', value: new Map([['a', 1]]) }, { payload: new Map([['a', 1]]) });
  assert.equal(result.verdict, 'partial');
}
{
  const result = evaluate({ op: 'in', path: 'payload', value: [{ id: 'ev-1' }] }, { payload: { id: 'ev-1' } });
  assert.equal(result.verdict, 'partial');
}
{
  const result = evaluate({ op: 'contains', path: 'payload', value: { id: 'ev-1' } }, { payload: [{ id: 'ev-1' }] });
  assert.equal(result.verdict, 'partial');
}
// One-sided non-primitive (object actual, primitive expected) is simply unequal.
assert.equal(evaluate({ op: 'equals', path: 'payload', value: 'ev-1' }, { payload: { id: 'ev-1' } }).verdict, 'not-detected');

// 6. not(undecided) stays fail-closed: partial, never complete-supported.
{
  const result = evaluate({ op: 'not', arg: { op: 'equals', path: 'payload', value: { a: 1 } } }, { payload: { a: 1 } });
  assert.equal(result.verdict, 'partial');
}

// 7. Numeric comparison contract (gte) is unchanged: string digits still compare numerically.
assert.equal(evaluate({ op: 'gte', path: 'loopCount', value: 1 }, { loopCount: 2 }).verdict, 'supported');
assert.equal(evaluate({ op: 'gte', path: 'loopCount', value: '1' }, { loopCount: 2 }).verdict, 'supported');
assert.equal(evaluate({ op: 'gte', path: 'loopCount', value: 3 }, { loopCount: 2 }).verdict, 'not-detected');
