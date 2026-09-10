import assert from 'node:assert/strict';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { buildDex } from '../fixtures/medium-dex.mjs';

console.log('[phase11] running DEX member owner type regression #7618...');

function fieldFixture(classType) {
  return buildDex({
    classNames: ['LTest;'],
    fields: [{ classType, type: 'I', name: 'ghost', owner: 'NOPE' }],
    methods: [],
  }).bytes;
}

function methodFixture(classType) {
  return buildDex({
    classNames: ['LTest;'],
    fields: [],
    methods: [{
      classType,
      name: 'ghost',
      returnType: 'V',
      params: [],
      words: null,
      defined: false,
    }],
  }).bytes;
}

{
  const image = parseDex(fieldFixture('LExternal;'));
  assert.equal(image.fields[0].classType, 'LExternal;');
}

for (const classType of ['I', '[I']) {
  assert.throws(
    () => parseDex(fieldFixture(classType)),
    /dex-invalid-field-owner-type/,
    `field owner ${classType} must be rejected`,
  );
}

{
  const image = parseDex(methodFixture('LExternal;'));
  assert.equal(image.methods[0].classType, 'LExternal;');
}

{
  const image = parseDex(methodFixture('[I'));
  assert.equal(image.methods[0].classType, '[I');
}

for (const classType of ['I', 'J', 'Z', 'V']) {
  assert.throws(
    () => parseDex(methodFixture(classType)),
    /dex-invalid-method-owner-type/,
    `method owner ${classType} must be rejected`,
  );
}

console.log('  ok DEX member owner type regression #7618 passed');
