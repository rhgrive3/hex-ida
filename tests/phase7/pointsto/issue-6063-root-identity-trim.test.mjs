import test from 'node:test'; import assert from 'node:assert/strict';
import {createPointsToSet,createPointsToTarget,exactRange} from '../../../js/analysis/pointsto/lattice.js'; import {pointsToAlias} from '../../../js/analysis/pointsto/alias.js';
const status={snapshotId:'s',analyzerId:'test',analyzerVersion:'1',completeness:'complete',stopReason:null};
function target(rootEntityId){return createPointsToTarget({addressSpace:'memory',rootKind:'rooted',rootEntityId,separationClass:'heap-like',separationAuthority:'root-descriptor',offsetRange:exactRange(0)});}
test('6063 root identity canonicalized',()=>{assert.equal(target(' root ').rootEntityId,'root');assert.equal(target('root').rootEntityId,'root');assert.equal(target('   ').rootEntityId,null);});
test('6063 whitespace variants do not separate',()=>{const r=pointsToAlias(createPointsToSet({targets:[target('root')]}),createPointsToSet({targets:[target(' root ')]}),{widthBitsLeft:64,widthBitsRight:64,status});assert.notEqual(r.relation,'no');assert.ok(!r.reasonCodes.includes('distinct-proven-root'));});
test('6063 distinct roots separate',()=>assert.equal(pointsToAlias(createPointsToSet({targets:[target('a')]}),createPointsToSet({targets:[target('b')]}),{widthBitsLeft:64,widthBitsRight:64,status}).relation,'no'));
