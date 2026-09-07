import assert from 'node:assert/strict';
import test from 'node:test';
import { TypeConstraintGraph, reconstructStructuralType, selectedTypeIfCertain } from '../../../js/analysis/types/graph.js';
import { createTypeClaim } from '../../../js/analysis/types/constraints.js';
const hard=(g,id,descriptor)=>g.addHardConstraint({kind:'debug-type',origin:'debug-matched',claim:{entityId:id,layer:'structural',descriptor}});
const int={kind:'integer',widthBits:32};

test('C3: declared union preserves overlapping alternatives, never becomes a struct',()=>{
 const g=new TypeConstraintGraph({snapshotId:'union-v6'});
 hard(g,'U',{kind:'union',sizeBytes:8,alignBytes:8,members:[{offset:0,sizeBytes:4,fieldName:'bits',memberType:int},{offset:0,sizeBytes:8,fieldName:'next',memberType:{kind:'pointer',targetEntityId:'U'}}]});
 const r=reconstructStructuralType(g,'U');assert.equal(r.kind,'union');assert.equal(r.members.length,2);assert.equal(r.sizeBytes,8);assert.equal(r.isRecursive,true);assert.equal(r.confidence,'certain');
});
test('C3: top-level arrays retain stride/length/element and exact derived extent',()=>{
 const g=new TypeConstraintGraph({snapshotId:'array-v6'});
 hard(g,'A',{kind:'array',length:3,strideBytes:4,elementType:{...int,sizeBytes:4},alignBytes:4});
 const r=reconstructStructuralType(g,'A');assert.equal(r.kind,'array');assert.equal(r.length,3);assert.equal(r.strideBytes,4);assert.equal(r.sizeBytes,12);assert.deepEqual(r.elementType,{...int,sizeBytes:4});
});
test('C3: contradictory array lengths/types withhold selection',()=>{
 const g=new TypeConstraintGraph({snapshotId:'array-conflict'});
 hard(g,'A',{kind:'array',length:3,strideBytes:4,elementType:int});hard(g,'A',{kind:'array',length:4,strideBytes:4,elementType:int});
 assert.equal(selectedTypeIfCertain(g.solveEntity('A'),'structural'),null);
 assert.equal(reconstructStructuralType(g,'A').kind,'unknown');
});
test('C3: reconstruction preserves integers above 2^53 through public output',()=>{
 const g=new TypeConstraintGraph({snapshotId:'huge-v6'});
 hard(g,'Huge',{offset:9007199254740993n,sizeBytes:2,alignBytes:2,memberType:{kind:'integer',widthBits:16}});
 const r=reconstructStructuralType(g,'Huge');assert.equal(r.members[0].offset,'9007199254740993');assert.equal(r.sizeBytes,'9007199254740996');assert.equal(r.alignBytes,2);
});
test('C3: hard aggregate extent may not silently expand to accommodate an incompatible field',()=>{
 const g=new TypeConstraintGraph({snapshotId:'inconsistent-v6'});
 hard(g,'S',{kind:'struct',sizeBytes:4,alignBytes:4});hard(g,'S',{offset:8,sizeBytes:4,memberType:int});
 assert.equal(selectedTypeIfCertain(g.solveEntity('S'),'structural'),null);
});
test('C3: explicit packed alignment is retained instead of upgraded from a guessed natural alignment',()=>{
 const g=new TypeConstraintGraph({snapshotId:'packed-v6'});
 hard(g,'S',{kind:'struct',sizeBytes:5,alignBytes:1,members:[{offset:0,sizeBytes:1,memberType:{kind:'integer',widthBits:8}},{offset:1,sizeBytes:4,memberType:int}]});
 const r=reconstructStructuralType(g,'S');assert.equal(r.sizeBytes,5);assert.equal(r.alignBytes,1);
});
test('C3: malformed nested layout cannot mint a certain aggregate or invoke coercion hooks',()=>{
 let calls=0;for(const value of [true,[4],{valueOf(){calls++;return 4;}}]){
  assert.throws(()=>createTypeClaim({layer:'structural',entityId:'bad',descriptor:{kind:'struct',members:[{offset:0,sizeBytes:value,memberType:int}]}}),/structural|descriptor/);
 }
 assert.equal(calls,0);
 assert.throws(()=>createTypeClaim({layer:'structural',entityId:'bad',descriptor:{kind:'array',length:3,strideBytes:2,elementType:{kind:'integer',sizeBytes:4}}}),/structural/);
});
test('C3: descriptor depth and shared-DAG expansion are bounded before hashing',()=>{
 let deep={kind:'integer'};for(let i=0;i<80;i++)deep={kind:'pointer',pointeeType:deep};
 assert.throws(()=>createTypeClaim({layer:'structural',entityId:'deep',descriptor:deep}),/descriptor.*budget/);
 let dag={kind:'integer'};for(let i=0;i<20;i++)dag={a:dag,b:dag};
 assert.throws(()=>createTypeClaim({layer:'structural',entityId:'dag',descriptor:dag}),/descriptor.*budget/);
});
test('C3: stale, cancelled and wrong-entity results never reconstruct a certain type',()=>{
 const g=new TypeConstraintGraph({snapshotId:'type-current'});hard(g,'S',{offset:0,sizeBytes:4,memberType:int});
 const result=g.solveEntity('S');assert.equal(reconstructStructuralType(result,'different'),null);
 assert.equal(reconstructStructuralType(result,'S',{snapshotId:'type-stale'}),null);
 const stopped={...result,status:{...result.status,completeness:'partial',stopReason:'cancelled'}};
 assert.equal(reconstructStructuralType(stopped,'S').kind,'unknown');
 assert.equal(reconstructStructuralType(g,'S',{signal:AbortSignal.abort()}).kind,'unknown');
});
test('C3: union/struct disagreement remains a contradiction, soft hints do not invent unions',()=>{
 const g=new TypeConstraintGraph({snapshotId:'no-guessed-union'});hard(g,'S',{kind:'union',sizeBytes:8});hard(g,'S',{kind:'struct',sizeBytes:8});
 assert.ok(g.solveEntity('S').layers.structural.contradictions.length);assert.equal(reconstructStructuralType(g,'S').kind,'unknown');
});
