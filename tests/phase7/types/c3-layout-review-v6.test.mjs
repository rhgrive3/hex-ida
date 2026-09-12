import test from 'node:test';import assert from 'node:assert/strict';
import {TypeConstraintGraph,reconstructStructuralType,selectedTypeIfCertain} from '../../../js/analysis/types/graph.js';
import {createTypeClaim} from '../../../js/analysis/types/constraints.js';
const hard=(g,id,descriptor)=>g.addHardConstraint({kind:'debug-type',origin:'debug-matched',claim:{entityId:id,layer:'structural',descriptor}});
const member=(offset,sizeBytes)=>({offset,sizeBytes,memberType:{kind:'integer'}});
test('C3 review: invalid aggregate member containers cannot reach the layout solver',()=>{
 for(const members of [{},[null],[true],[[]]])assert.throws(()=>createTypeClaim({entityId:'S',layer:'structural',descriptor:{kind:'struct',members}}),/structural/);
});
test('C3 review: overlapping struct members withhold a certain layout instead of inventing a union',()=>{
 const g=new TypeConstraintGraph({snapshotId:'layout-overlap'});hard(g,'S',{kind:'struct',members:[member(0,4),member(2,4)]});
 assert.equal(selectedTypeIfCertain(g.solveEntity('S'),'structural'),null);assert.equal(reconstructStructuralType(g,'S').kind,'unknown');
});
test('C3 review: unknown field width cannot be laundered into a zero-byte member',()=>{
 const g=new TypeConstraintGraph({snapshotId:'field-hole'});hard(g,'S',{kind:'struct',sizeBytes:8,members:[{offset:0,memberType:{kind:'unknown'}}]});
 assert.equal(reconstructStructuralType(g,'S').kind,'unknown');
});
test('C3 review: an incomplete aggregate declaration retains unknown extent without throwing',()=>{
 const g=new TypeConstraintGraph({snapshotId:'incomplete'});hard(g,'S',{kind:'struct'});
 const r=reconstructStructuralType(g,'S');assert.equal(r.kind,'struct');assert.equal(r.sizeBytes,null);assert.equal(r.alignBytes,null);
});
test('C3 review: nested array/union pointer references participate in the existing recursive SCC',()=>{
 const g=new TypeConstraintGraph({snapshotId:'nested-cycle'});
 hard(g,'A',{kind:'array',length:2,strideBytes:8,elementType:{kind:'union',sizeBytes:8,members:[{offset:0,sizeBytes:8,memberType:{kind:'pointer',targetEntityId:'B'}}]}});
 hard(g,'B',{kind:'struct',members:[{offset:0,sizeBytes:8,memberType:{kind:'pointer',targetEntityId:'A'}}]});
 assert.ok(g.dependenciesOf('A').has('B'));assert.ok(g.dependenciesOf('B').has('A'));
 const result=g.solveGraph();assert.ok(result);assert.equal(reconstructStructuralType(result.results.get('A'),'A').isRecursive,true);
});
