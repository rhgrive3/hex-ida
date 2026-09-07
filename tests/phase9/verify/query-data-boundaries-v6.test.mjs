import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../../js/symbolic/expr/index.js';
import { createVerificationQuery, validateVerificationQuery, VERIFICATION_QUERY_KIND as K, CLAIM_KIND as C } from '../../../js/symbolic/verify/query.js';
const fields={kind:K.BOUNDED_EQUIVALENCE,claimKind:C.EQUIVALENT,assertion:E.createBool(true)};
test('query creation rejects accessor request fields without calling them',()=>{
  let calls=0;const input={...fields,get proofScope(){calls++;return {};}};
  assert.throws(()=>createVerificationQuery(input),/accessor/);assert.equal(calls,0);
});
test('query validation rejects accessor fields without calling them',()=>{
  const good=createVerificationQuery(fields);let calls=0;
  const bad={...good,get proofScope(){calls++;return {};}};
  assert.equal(validateVerificationQuery(bad).valid,false);assert.equal(calls,0);
});
test('query expression data accessors are refused before structural hashing',()=>{
  let calls=0;const bad={kind:'const',sort:E.boolSort(),get value(){calls++;return true;}};
  assert.throws(()=>createVerificationQuery({...fields,assertion:bad}),/accessor/);assert.equal(calls,0);
});
test('unknown detail accessors do not run during hashing',()=>{
  let calls=0;const node={kind:'unknown_semantic',sort:E.boolSort(),reason:'unsupported',detail:{get x(){calls++;return 1;}}};
  assert.throws(()=>createVerificationQuery({...fields,assertion:node}),/detail|accessor/);assert.equal(calls,0);
});
test('small identity DAG cannot bypass the expanded JSON work budget',()=>{
  let scope={leaf:'x'};for(let i=0;i<16;i++)scope={a:scope,b:scope};
  assert.throws(()=>createVerificationQuery({...fields,proofScope:scope}),/expansion|budget/);
});
test('scalar and string identity payloads count against the serialized-work limit',()=>{
  assert.throws(()=>createVerificationQuery({...fields,proofScope:{value:'x'.repeat(100001)}}),/budget/);
});
test('proof constraints cannot hide false or malformed entries via array iterators',()=>{
  const constraints=[E.createBool(false)];constraints[Symbol.iterator]=function*(){};
  assert.throws(()=>createVerificationQuery({...fields,constraints}),/array|symbol|canonical/);
  assert.throws(()=>createVerificationQuery({...fields,constraints:[null]}),/expression|constraint/);
});
test('structured-cloned valid queries retain identity and semantic nodes remain frozen',()=>{
  const x=E.createFreshSymbol(E.bvSort(32),'clone');
  const query=createVerificationQuery({...fields,assertion:E.createCompare('eq',x,x),proofScope:{source:'owned',count:2}});
  assert.equal(validateVerificationQuery(structuredClone(query)).valid,true);
  assert.equal(Object.isFrozen(query.assertion),true);assert.equal(Object.isFrozen(query.constraints),true);
});
test('ignored expression metadata is not traversed by the query freezer',()=>{
  let calls=0;const x={...E.createFreshSymbol(E.bvSort(32),'metadata'),meta:{get ignored(){calls++;return {};}}};
  createVerificationQuery({...fields,assertion:E.createCompare('eq',x,x)});assert.equal(calls,0);
});
