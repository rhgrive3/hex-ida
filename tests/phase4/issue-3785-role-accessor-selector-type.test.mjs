import assert from 'node:assert/strict';
import { ACTION, inferRole } from '../../js/role.js';

function infer(sel) {
  return inferRole({
    owner: {
      className:'Demo',
      sel,
      accessorField:{
        name:'_count',
        property:{ name:'count' },
        offset:0x10n,
        type:'int',
        size:4,
      },
    },
    updates:[],
    chains:[],
    selectors:[],
    strings:[],
    callees:[],
    callers:[],
    verified:false,
  });
}

function metadataEvidence(role) {
  return (role?.evidence || []).filter((item) => item.code === 'role-accessor-metadata');
}

const setter = infer('setCount:');
assert.equal(setter.action, ACTION.SET, 'primitive setter selector keeps accessor semantics');
assert.equal(setter.subject?.plain, 'count');
assert.equal(setter.subject?.certain, true);
assert.equal(metadataEvidence(setter).length, 1);

const getter = infer('count');
assert.equal(getter.action, ACTION.GET, 'primitive getter selector keeps accessor semantics');
assert.equal(getter.subject?.plain, 'count');
assert.equal(getter.subject?.certain, true);
assert.equal(metadataEvidence(getter).length, 1);

for (const sel of [['setCount:'], ['count'], 123, true, { toString() { return 'setCount:'; } }]) {
  const role = infer(sel);
  assert.equal(metadataEvidence(role).length, 0, `${typeof sel} selector must not create metadata accessor authority`);
  assert.notEqual(role.subject?.certain, true, 'malformed selector must not manufacture a certain field subject');
}

console.log('issue #3785 strict Objective-C accessor selector type: PASS');
