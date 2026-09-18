import assert from 'node:assert/strict';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { buildDex } from '../fixtures/medium-dex.mjs';

console.log('[phase11] running DEX MemberName regression #7619...');

function setVersion(bytes, version) {
  const copy = bytes.slice();
  copy.set([...version].map((char) => char.charCodeAt(0)), 4);
  return copy;
}

function fieldFixture(name, version = '039') {
  const { bytes } = buildDex({
    classNames: ['LTest;'],
    fields: [{ classType: 'LTest;', type: 'I', name, owner: 'NOPE' }],
    methods: [],
  });
  return setVersion(bytes, version);
}

function methodFixture(name, version = '039') {
  const { bytes } = buildDex({
    classNames: ['LTest;'],
    fields: [],
    methods: [{
      classType: 'LTest;',
      name,
      returnType: 'V',
      params: [],
      words: null,
      defined: false,
    }],
  });
  return setVersion(bytes, version);
}

assert.equal(parseDex(fieldFixture('x')).fields[0].name, 'x');
assert.equal(parseDex(methodFixture('foo')).methods[0].name, 'foo');
assert.equal(parseDex(methodFixture('<init>')).methods[0].name, '<init>');
assert.equal(parseDex(fieldFixture('<synthetic>')).fields[0].name, '<synthetic>');

for (const name of ['', 'a/b', 'a.b', 'a;b', 'a[b', '<>', '<a/b>', 'a<b>']) {
  assert.throws(
    () => parseDex(fieldFixture(name)),
    /dex-invalid-field-name/,
    `field MemberName ${JSON.stringify(name)} must be rejected`,
  );
  assert.throws(
    () => parseDex(methodFixture(name)),
    /dex-invalid-method-name/,
    `method MemberName ${JSON.stringify(name)} must be rejected`,
  );
}

for (const name of ['a¡b', 'a‐b', 'a‰b']) {
  assert.equal(parseDex(methodFixture(name, '039')).methods[0].name, name);
}

for (const name of ['a b', 'a b', 'a b', 'a b']) {
  assert.throws(
    () => parseDex(methodFixture(name, '039')),
    /dex-invalid-method-name/,
    `DEX 039 must reject extended-space MemberName ${JSON.stringify(name)}`,
  );
  assert.equal(
    parseDex(methodFixture(name, '040')).methods[0].name,
    name,
    `DEX 040 must accept extended-space MemberName ${JSON.stringify(name)}`,
  );
}

{
  const { bytes } = buildDex({
    classNames: ['LTest;'],
    fields: [],
    methods: [],
    strings: ['a/b'],
  });
  assert.ok(parseDex(bytes).strings.includes('a/b'), 'non-member strings must not use MemberName grammar');
}

console.log('  ok DEX MemberName regression #7619 passed');
