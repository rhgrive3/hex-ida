// Regression for #5634: all/any rule expressions must short-circuit once their
// logical value is definite. A budget stop after a decisive child must not
// demote an already-determined verdict to partial.
import assert from 'node:assert/strict';
import { evaluateCapabilityRule } from '../../../js/knowledge/phase12-rules.js';
import { createResourceBudget } from '../../../js/phase12/resource-budget.js';

const budget = (maxWork, maxNodes = maxWork) => ({ budget: createResourceBudget({ maxWork, maxNodes }) });

// any(): a true first child is decisive even when the budget stops before the
// remaining children can be evaluated.
const anyRule = {
  id: 'r:any', capabilityId: 'cap:any', version: 1, scope: 'function',
  when: { op: 'any', args: [
    { op: 'exists', path: 'present' },
    { op: 'exists', path: 'other' },
    { op: 'exists', path: 'more' },
  ] },
};
const anyResult = evaluateCapabilityRule(anyRule, { snapshotId: 's1', entityId: 'fn-1', features: { present: 1 }, completeness: 'complete' }, budget(2, 2));
assert.equal(anyResult.verdict, 'supported', `any(true, unevaluated) must stay supported, got ${anyResult.verdict}`);
assert.equal(anyResult.completeness, 'complete', 'a definite verdict must not be demoted to partial');

// all(): a false first child is decisive even when the budget stops before the
// remaining children can be evaluated.
const allRule = {
  id: 'r:all', capabilityId: 'cap:all', version: 1, scope: 'function',
  when: { op: 'all', args: [
    { op: 'exists', path: 'missing' },
    { op: 'exists', path: 'present' },
    { op: 'exists', path: 'present' },
  ] },
};
const allResult = evaluateCapabilityRule(allRule, { snapshotId: 's2', entityId: 'fn-2', features: { present: 1 }, completeness: 'complete' }, budget(2, 2));
assert.equal(allResult.verdict, 'not-detected', `all(false, unevaluated) must stay not-detected, got ${allResult.verdict}`);
assert.equal(allResult.completeness, 'complete', 'a definite verdict must not be demoted to partial');

// Without a budget stop the short-circuit verdicts are unchanged.
const anyOpen = evaluateCapabilityRule(anyRule, { snapshotId: 's3', entityId: 'fn-3', features: { present: 1 }, completeness: 'complete' }, budget(10_000));
assert.equal(anyOpen.verdict, 'supported');
const allFail = evaluateCapabilityRule(allRule, { snapshotId: 's4', entityId: 'fn-4', features: { present: 1 }, completeness: 'complete' }, budget(10_000));
assert.equal(allFail.verdict, 'not-detected');

// The decisive child stops the walk before later children are attempted: the
// budget must not report a stop for an expression whose value was determined.
assert.equal(allResult.budget.stopped, null, 'a definite verdict must not spend budget on unreachable children');
assert.equal(anyResult.budget.stopped, null, 'a definite verdict must not spend budget on unreachable children');

// A genuine budget stop with no decisive child still degrades to partial
// (the short-circuit must not widen into "any budget stop is fine").
const undecided = {
  id: 'r:undecided', capabilityId: 'cap:undecided', version: 1, scope: 'function',
  when: { op: 'any', args: [
    { op: 'exists', path: 'missing' },
    { op: 'exists', path: 'also-missing' },
  ] },
};
const partialResult = evaluateCapabilityRule(undecided, { snapshotId: 's5', entityId: 'fn-5', features: { present: 1 }, completeness: 'complete' }, budget(2, 2));
assert.equal(partialResult.verdict, 'partial', 'an undecided expression stopped by the budget must stay partial');
assert.equal(partialResult.budget.stopped?.reason, 'resource-limit-work');

console.log('issue #5634 phase12 rule short-circuit regressions PASS');
