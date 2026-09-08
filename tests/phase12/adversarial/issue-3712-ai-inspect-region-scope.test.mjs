import assert from 'node:assert/strict';
import { ScopeController } from '../../../js/ai/control/scope.js';
import { regionSchema } from '../../../js/ai/tools/schemas.js';
import { validateSchema } from '../../../js/ai/validation.js';

const regionArgs = {
  functionAddress: '0x1000',
  view: 'assembly',
  start: 10,
  count: 20,
};

assert.equal(validateSchema(regionArgs, regionSchema()).ok, true, 'numeric start is the region pagination offset');
assert.equal(validateSchema({ ...regionArgs, start: '10' }, regionSchema()).ok, false, 'string start must not bypass the integer pagination schema');

const functionScope = new ScopeController({
  currentFunction: {
    address: '0x1000',
    range: { start: '0x1000', end: '0x1100' },
  },
}, 'function');

assert.equal(functionScope.scopeAllowsTool('function', 'inspect_function_region', regionArgs), true);
assert.doesNotThrow(() => functionScope.assertToolCall('inspect_function_region', regionArgs));
assert.throws(
  () => functionScope.assertToolCall('inspect_function_region', { ...regionArgs, functionAddress: '0x2000' }),
  (error) => error?.type === 'scope_violation' || error?.code === 'scope_violation',
  'the real functionAddress remains scope-authoritative',
);
assert.throws(
  () => functionScope.assertToolCall('path_probe', { from: '0x1000', to: '0x2000' }),
  (error) => error?.type === 'scope_violation' || error?.code === 'scope_violation',
  'generic from/to address fields must remain guarded',
);

const selectionScope = new ScopeController({
  selection: { start: '0x1000', end: '0x1004' },
  currentFunction: {
    address: '0x1000',
    range: { start: '0x1000', end: '0x1100' },
  },
}, 'selection');
assert.doesNotThrow(() => selectionScope.assertToolCall('inspect_function_region', regionArgs));

const neighborhoodScope = new ScopeController({
  currentFunction: {
    address: '0x1000',
    range: { start: '0x1000', end: '0x1100' },
  },
  neighborhood: ['0x2000'],
}, 'neighborhood');
assert.doesNotThrow(() => neighborhoodScope.assertToolCall('inspect_function_region', { ...regionArgs, functionAddress: '0x2000' }));

console.log('issue-3712-ai-inspect-region-scope: ok');
