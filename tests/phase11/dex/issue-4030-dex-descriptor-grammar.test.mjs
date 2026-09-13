import assert from 'node:assert/strict';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { buildDex } from '../fixtures/medium-dex.mjs';

console.log('[phase11] running DEX descriptor grammar regression #4030...');

function dex(method = {}) {
  return buildDex({
    classNames: ['LTest;'],
    fields: [],
    methods: [{ classType: 'LTest;', name: 'foo', returnType: 'V', params: [], words: [0x000e], ...method }],
  }).bytes;
}

function fieldDex(classType) {
  return buildDex({
    classNames: ['LTest;'],
    fields: [{ classType, type: 'I', name: 'ghost', owner: 'NOPE' }],
    methods: [],
  }).bytes;
}

{
  const image = parseDex(dex());
  assert.deepEqual(image.types, ['LTest;', 'V']);
  assert.deepEqual(image.protos[0], { shorty: 'V', returnType: 'V', params: [] });
}

{
  const image = parseDex(dex({ returnType: 'J', params: ['[I', 'Ljava/lang/String;'] }));
  assert.deepEqual(image.protos[0], { shorty: 'JLL', returnType: 'J', params: ['[I', 'Ljava/lang/String;'] });
}

for (const descriptor of ['not-a-type', 'LTest', 'V2', '[V', 'Ljava/lang/Object', 'L;']) {
  assert.throws(
    () => parseDex(dex({ returnType: descriptor })),
    /dex-invalid-type-descriptor/,
    `type_id ${JSON.stringify(descriptor)} must be rejected`,
  );
}

assert.throws(() => parseDex(dex({ params: ['V'] })), /dex-invalid-type-descriptor/);
assert.throws(() => parseDex(dex({ params: ['not-a-type'] })), /dex-invalid-type-descriptor/);

for (const shorty of ['I', 'VLL', 'LL', 'Z']) {
  assert.throws(
    () => parseDex(dex({ params: ['I', 'Ljava/lang/Object;'], shorty })),
    /dex-invalid-proto-shorty/,
    `shorty ${JSON.stringify(shorty)} must not contradict the prototype`,
  );
}

for (const classType of ['I', '[I', 'V']) {
  assert.throws(
    () => parseDex(fieldDex(classType)),
    /dex-invalid-field-owner-type/,
    `field owner ${classType} must not be accepted in a class-only context`,
  );
}

assert.deepEqual(parseDex(dex({ params: ['I', 'Ljava/lang/Object;'], shorty: 'VIL' })).protos[0], {
  shorty: 'VIL',
  returnType: 'V',
  params: ['I', 'Ljava/lang/Object;'],
});

console.log('  ok DEX descriptor grammar regression #4030 passed');
