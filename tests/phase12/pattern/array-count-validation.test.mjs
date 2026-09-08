import assert from 'node:assert/strict';
import { evaluatePattern, typeCheckPattern } from '../../../js/pattern/index.js';

function arrayPattern(count) {
  return {
    kind: 'struct',
    name: 'Root',
    fields: [{
      name: 'items',
      type: {
        kind: 'array',
        count,
        element: { kind: 'primitive', name: 'u8' },
      },
    }],
  };
}

for (const count of [100n, Symbol('count'), () => 2, true, false, null, undefined, ['2']]) {
  assert.throws(
    () => typeCheckPattern({ ast: arrayPattern(count) }),
    (error) => error?.code === 'pattern-array-count-invalid',
    `unsupported array count must fail closed: ${typeof count}`,
  );
}

for (const count of [0, 2, Number.MAX_SAFE_INTEGER]) {
  assert.doesNotThrow(() => typeCheckPattern({ ast: arrayPattern(count) }));
}
assert.doesNotThrow(() => typeCheckPattern({ ast: arrayPattern('count') }));
assert.doesNotThrow(() => typeCheckPattern({ ast: arrayPattern({ op: 'const', value: 2 }) }));

const dynamic = {
  kind: 'struct',
  name: 'Dynamic',
  fields: [
    { name: 'count', type: { kind: 'primitive', name: 'u8' } },
    { name: 'items', type: { kind: 'array', count: 'count', element: { kind: 'primitive', name: 'u8' } } },
  ],
};
const result = evaluatePattern(dynamic, Uint8Array.from([2, 0x41, 0x42]));
assert.equal(result.status, 'complete');
assert.equal(result.value.fields.items.length, 2);
assert.equal(result.value.fields.items.expand(0).value, 0x41);
assert.equal(result.value.fields.items.expand(1).value, 0x42);

console.log('[phase12] pattern array count validation regression passed');
