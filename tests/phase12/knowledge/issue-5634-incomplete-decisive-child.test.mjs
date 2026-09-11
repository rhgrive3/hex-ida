// Regression for #5634 review remediation: an incomplete child may carry a
// provisional boolean, but it must never become short-circuit authority.
import assert from 'node:assert/strict';
import { evaluateCapabilityRule } from '../../../js/knowledge/phase12-rules.js';
import { createResourceBudget } from '../../../js/phase12/resource-budget.js';

const evaluate = (when, maxWork, id) => evaluateCapabilityRule({
  id: `r:${id}`,
  capabilityId: `cap:${id}`,
  version: 1,
  scope: 'function',
  when,
}, {
  snapshotId: `s:${id}`,
  entityId: `fn:${id}`,
  features: { present: 1 },
  completeness: 'complete',
}, {
  budget: createResourceBudget({ maxWork, maxNodes: 16 }),
});

// The leaf cannot run after outer any + not consume the work budget. The not
// therefore produces value:true with complete:false; that provisional true
// must not authorize a supported verdict.
const incompleteTrue = evaluate({
  op: 'any',
  args: [{ op: 'not', arg: { op: 'exists', path: 'present' } }],
}, 2, 'any-incomplete-true');
assert.equal(incompleteTrue.verdict, 'partial', 'incomplete true child must not short-circuit any() to supported');
assert.equal(incompleteTrue.completeness, 'partial');
assert.equal(incompleteTrue.budget.stopped?.reason, 'resource-limit-work');

// Double negation supplies the symmetric incomplete false case to all(): the
// leaf cannot run after all + not + not consume the budget, so the outer not
// returns value:false with complete:false. That false must remain partial.
const incompleteFalse = evaluate({
  op: 'all',
  args: [{ op: 'not', arg: { op: 'not', arg: { op: 'exists', path: 'present' } } }],
}, 3, 'all-incomplete-false');
assert.equal(incompleteFalse.verdict, 'partial', 'incomplete false child must not short-circuit all() to not-detected');
assert.equal(incompleteFalse.completeness, 'partial');
assert.equal(incompleteFalse.budget.stopped?.reason, 'resource-limit-work');

console.log('issue #5634 incomplete decisive-child regressions PASS');
