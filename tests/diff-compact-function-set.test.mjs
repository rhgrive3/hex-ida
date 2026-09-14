import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPACT_DIFF_FUNCTION_SET_SCHEMA,
  SYMMETRIC_DIFF_PROFILE,
  createCompactFunctionSet,
  materializeCompactFunctionSet,
  demoteLowInformationAbsenceClaims,
} from '../js/diff/compact-function-set.js';

function symbols() {
  return {
    funcs:[0x1000n,0x1040n,0x1100n],
    addrs:[0x1000n,0x1040n,0x1100n],
    names:['alpha','beta','gamma'],
    functionStartsComplete:true,
  };
}

test('compact diff function set keeps columns on the main side and materializes rows only in the worker helper', () => {
  const source=symbols();
  const compact=createCompactFunctionSet(source,'arm64',350000);
  assert.equal(compact.schema,COMPACT_DIFF_FUNCTION_SET_SCHEMA);
  assert.equal(compact.evidenceProfile,SYMMETRIC_DIFF_PROFILE);
  assert.equal(compact.functionAddresses,source.funcs);
  assert.equal(compact.total,3);
  assert.equal(compact.complete,true);
  assert.equal(Object.hasOwn(compact,'items'),false);
  const rows=materializeCompactFunctionSet(compact);
  assert.equal(rows.length,3);
  assert.deepEqual(rows.map((row)=>row.name),['alpha','beta','gamma']);
  assert.deepEqual(rows.map((row)=>row.size),[0x40,0xc0,0]);
  assert.ok(rows.every((row)=>row.evidenceProfile===SYMMETRIC_DIFF_PROFILE));
});

test('incomplete discovery stays incomplete without shrinking the function denominator', () => {
  const source=symbols(); source.functionStartsComplete=false;
  const compact=createCompactFunctionSet(source,'arm64',2);
  assert.equal(compact.count,2);
  assert.equal(compact.total,3);
  assert.equal(compact.complete,false);
  assert.equal(compact.truncationReason,'function-budget');
});

test('low-information symmetric profile never turns unmatched functions into definite new/deleted claims', () => {
  const before={address:0x1000n,name:'a'};
  const after={address:0x2000n,name:'b'};
  const result=demoteLowInformationAbsenceClaims({
    deleted:[{before,after:null,status:'deleted',changeType:'deleted',confidence:1}],
    new:[{before:null,after,status:'new',changeType:'new',confidence:1}],
    unresolved:[],
    changes:[
      {before,after:null,status:'deleted',changeType:'deleted',confidence:1},
      {before:null,after,status:'new',changeType:'new',confidence:1},
    ],
  });
  assert.deepEqual(result.deleted,[]);
  assert.deepEqual(result.new,[]);
  assert.equal(result.unresolved.length,2);
  assert.ok(result.unresolved.every((row)=>row.changeType==='unresolved'&&row.confidence===0));
});
