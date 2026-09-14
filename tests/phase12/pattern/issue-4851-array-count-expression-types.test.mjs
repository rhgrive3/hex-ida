import assert from 'node:assert/strict';
import { evaluatePattern, typeCheckPattern } from '../../../js/pattern/index.js';

const u8 = { kind: 'primitive', name: 'u8' };

function patternWithCount(count, constants = undefined) {
  const ast = {
    kind: 'struct',
    name: 'Root',
    fields: [{ name: 'items', type: { kind: 'array', count, element: u8 } }],
  };
  if (constants !== undefined) ast.constants = constants;
  return ast;
}

function isCountError(error) {
  return error?.code === 'pattern-array-count-invalid';
}

// Numeric const expressions are the only const values that can be array counts.
for (const value of [['2'], true, false, '2', { valueOf: () => 2 }, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.throws(
    () => typeCheckPattern({ ast: patternWithCount({ op: 'const', value }) }),
    isCountError,
    `invalid const array count must fail closed: ${String(value)}`,
  );
}
assert.doesNotThrow(() => typeCheckPattern({ ast: patternWithCount({ op: 'const', value: 0 }) }));
assert.doesNotThrow(() => typeCheckPattern({ ast: patternWithCount({ op: 'const', value: 2 }) }));
assert.doesNotThrow(() => typeCheckPattern({ ast: patternWithCount({ op: 'const', value: Number.MAX_SAFE_INTEGER }) }));

// JSON/object ASTs must enforce the same typed const contract.
const jsonAst = JSON.parse(JSON.stringify(patternWithCount({ op: 'const', value: ['2'] })));
assert.throws(() => typeCheckPattern({ ast: jsonAst }), isCountError);

// Ref expressions are dynamic, so type-checking accepts them, but their resolved
// value must still be a primitive non-negative safe-integer number at evaluation.
const structuredRef = patternWithCount(
  { op: 'ref', path: 'constants.count' },
  { count: ['2'] },
);
assert.doesNotThrow(() => typeCheckPattern({ ast: structuredRef }));
assert.throws(
  () => evaluatePattern(structuredRef, Uint8Array.from([0x41, 0x42])),
  isCountError,
  'structured ref value must not be coerced into an array count',
);

for (const value of [true, false, '2', '   ', null, ['2']]) {
  const refPattern = patternWithCount(
    { op: 'ref', path: 'constants.count' },
    { count: value },
  );
  assert.throws(
    () => evaluatePattern(refPattern, Uint8Array.from([0x41, 0x42])),
    isCountError,
    `resolved ref must not be coerced into an array count: ${String(value)}`,
  );
}

// Boolean-producing expressions are not numeric array counts either.
const comparisonCount = patternWithCount({
  op: 'eq',
  left: { op: 'const', value: 1 },
  right: { op: 'const', value: 1 },
});
assert.doesNotThrow(() => typeCheckPattern({ ast: comparisonCount }));
assert.throws(
  () => evaluatePattern(comparisonCount, Uint8Array.from([0x41])),
  isCountError,
  'boolean expression result must not become count 1',
);

// The direct string-ref form shares the same runtime count authority.
const directStructuredRef = patternWithCount('constants.count', { count: ['2'] });
assert.throws(
  () => evaluatePattern(directStructuredRef, Uint8Array.from([0x41, 0x42])),
  isCountError,
  'direct ref value must satisfy the same typed count contract',
);

// Valid numeric refs keep their existing behavior and layout.
const validRef = patternWithCount(
  { op: 'ref', path: 'constants.count' },
  { count: 2 },
);
const result = evaluatePattern(validRef, Uint8Array.from([0x41, 0x42]));
assert.equal(result.status, 'complete');
assert.equal(result.value.fields.items.length, 2);
assert.equal(result.value.fields.items.expand(0).value, 0x41);
assert.equal(result.value.fields.items.expand(1).value, 0x42);

console.log('[phase12] issue #4851 array-count expression type regression passed');
