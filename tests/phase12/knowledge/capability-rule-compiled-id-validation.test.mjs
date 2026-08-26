import assert from 'node:assert/strict';
import { evaluateCapabilityRule, evaluateCapabilityRules } from '../../../js/knowledge/phase12-rules.js';

const fakeCompiled = {
  compiledId: 'fake',
  id: 'r',
  version: '1',
  scope: 'not-a-real-scope',
  dependencies: [],
  requiredFeatures: [],
  capabilityId: 'cap',
  expression: { op: 'exists', path: 'x' },
};

assert.throws(
  () => evaluateCapabilityRule(fakeCompiled, { features: { x: true } }),
  /capability-rule-scope-invalid/,
);
assert.throws(
  () => evaluateCapabilityRules([fakeCompiled], { features: { x: true } }),
  /capability-rule-scope-invalid/,
);

console.log('phase12 compiled capability rule validation: ok');
