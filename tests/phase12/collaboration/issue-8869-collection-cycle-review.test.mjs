import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectOperation } from '../../../js/collaboration/index.js';

const base = Object.freeze({
  projectIdentity: 'project:8869-cycle-review',
  binaryIdentity: 'binary:8869-cycle-review',
  targetEntityId: 'entity:8869-cycle-review',
  factKind: 'patch',
  action: 'set',
});

function expectCycle(payload) {
  assert.throws(
    () => createProjectOperation({ ...base, payload }),
    { name: 'TypeError', message: 'operation-payload-cyclic' },
  );
}

test('#8869 review: self-referential Map fails closed before collection recursion', () => {
  const payload = new Map();
  payload.set('self', payload);
  expectCycle(payload);
});

test('#8869 review: self-referential Set fails closed before collection recursion', () => {
  const payload = new Set();
  payload.add(payload);
  expectCycle(payload);
});

test('#8869 review: mixed object/Map and object/Set cycles fail closed', () => {
  const objectWithMap = {};
  const map = new Map([['object', objectWithMap]]);
  objectWithMap.collection = map;
  expectCycle(objectWithMap);

  const objectWithSet = {};
  const set = new Set([objectWithSet]);
  objectWithSet.collection = set;
  expectCycle(objectWithSet);
});

test('#8869 review: repeated acyclic collection values remain valid', () => {
  const shared = Object.freeze({ value: 7 });
  const payload = new Map([['left', shared], ['right', shared]]);
  const operation = createProjectOperation({ ...base, payload });
  assert.equal(operation.payload.$immutableCollection.kind, 'Map');
  assert.equal(operation.payload.$immutableCollection.entries.length, 2);
});
