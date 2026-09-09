import assert from 'node:assert/strict';
import { ScopeController } from '../../../js/ai/control/scope.js';

const snapshot = { currentFunction:{ address:0x1000n } };

for (const onExpand of [true, {}, []]) {
  const scope = new ScopeController(snapshot, 'auto', { onExpand });
  assert.equal(scope.effectiveScope, 'function');
  assert.doesNotThrow(() => scope.expandTo('binary', 'search needed'));
  assert.equal(scope.effectiveScope, 'binary');
  assert.equal(scope.expansions.length, 1);
  assert.equal(scope.expansions[0].to, 'binary');
}

const events = [];
const scope = new ScopeController(snapshot, 'auto', { onExpand:event => events.push(event) });
assert.equal(scope.expandTo('binary', 'search needed'), true);
assert.equal(events.length, 1);
assert.equal(events[0], scope.expansions[0]);

console.log('issue #4173 callable onExpand contract: PASS');
