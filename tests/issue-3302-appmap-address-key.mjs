import assert from 'node:assert/strict';
import { buildAppMap } from '../js/appmap.js';

function makeFields() {
  const cls = {
    name: 'ZzzClass',
    superName: null,
    methods: [{ addr: 0x1000n, sel: 'run' }],
    classMethods: [],
    fields: [],
  };
  return { classCount: 1, classes: new Map([[cls.name, cls]]) };
}

function makeProgram(target) {
  return {
    functionRange: () => ({ start: 0x1000n, end: 0x1010n }),
    refsFrom: () => [{ target }],
    calleesOf: () => [],
    callCountOf: () => 0,
  };
}

const symbols = { nameAt: () => null };

function categoryFor(strings, target) {
  const map = buildAppMap({
    fields: makeFields(),
    program: makeProgram(target),
    symbols,
    strings,
  });
  assert.equal(map.classCount, 1);
  return map.classes[0].category;
}

// Canonical primitive address forms continue to resolve to the same identity.
assert.equal(categoryFor([{ addr: 4096n, text: 'purchase payment checkout' }], 4096n), 'purchase');
assert.equal(categoryFor([{ addr: 4096, text: 'purchase payment checkout' }], 4096n), 'purchase');
assert.equal(categoryFor([{ addr: '0x1000', text: 'purchase payment checkout' }], 4096n), 'purchase');

// Structured/non-address string-table evidence must not collide with a canonical target.
for (const addr of [
  ['4096'],
  { toString: () => '4096' },
  true,
  -1,
  -1n,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
  '',
  'not-an-address',
]) {
  assert.equal(
    categoryFor([{ addr, text: 'purchase payment checkout' }], 4096n),
    'unknown',
    `malformed string-table address must fail closed: ${String(addr)}`,
  );
}

// Lookup-side structured values must also fail closed against a canonical table entry.
for (const target of [
  ['4096'],
  { toString: () => '4096' },
  true,
  -1,
  -1n,
  Number.NaN,
  Number.POSITIVE_INFINITY,
]) {
  assert.equal(
    categoryFor([{ addr: 4096n, text: 'purchase payment checkout' }], target),
    'unknown',
    `malformed reference target must fail closed: ${String(target)}`,
  );
}

console.log('issue #3302 appmap address-key regression passed');
