import test from 'node:test'; import assert from 'node:assert/strict';
import {checkMemoryViewFrame,MEMORY_VIEW_FRAME_SCHEMA} from '../../js/core/evidence/memory-transform-frame.js';
import {workFor} from './helpers.mjs';
const options={worldId:'w',snapshotId:'s',functionId:'f'};
function frame(){const before={version:'mssa-v1',functionId:'f',entities:[],accesses:[{id:'load1',width:8,exception:'can-fault'}],effects:[],control:[]};
return {schema:MEMORY_VIEW_FRAME_SCHEMA,...options,before,after:structuredClone(before),unknowns:[],scope:'phase8-expression-view-only'};}
for(const [name,change,path] of [
 ['width',f=>f.after.accesses[0].width=4,['accesses','0','width']],
 ['exception',f=>f.after.accesses[0].exception='none',['accesses','0','exception']],
 ['missing field',f=>delete f.after.accesses[0].width,['accesses','0','width']],
 ['lost effect',f=>f.after.effects.push({clobber:'all'}),['effects','length']],
 ['typed value',f=>{f.before.accesses[0].width=8n;},['accesses','0','width']],
]) test(`first memory ${name} divergence is bounded and actionable`,t=>{
 const f=frame();change(f);const r=checkMemoryViewFrame(f,{...options,work:workFor(t)});
 assert.equal(r.status,'rejected');assert.deepEqual(r.firstFailure.path,path);assert.equal(r.memoryOptimization,false);
 assert.ok(JSON.stringify(r.firstFailure).length<1500);
});
test('large changed values are not emitted as full diagnostic payloads',t=>{
 const f=frame();f.before.accesses[0].bytes='a'.repeat(10000);f.after.accesses[0].bytes='b'.repeat(10000);
 const r=checkMemoryViewFrame(f,{...options,work:workFor(t)});assert.equal(r.firstFailure.before.text.length,160);assert.equal(r.firstFailure.after.truncated,true);
});
test('matching data with open exceptional paths stays unknown; matching keys in another insertion order are equivalent',t=>{
 const f=frame();f.after.accesses[0]={exception:'can-fault',width:8,id:'load1'};
 assert.equal(checkMemoryViewFrame(f,{...options,work:workFor(t)}).status,'verified');
 f.unknowns=['exception-target-unresolved'];const r=checkMemoryViewFrame(f,{...options,work:workFor(t)});assert.equal(r.status,'unknown');assert.equal(r.firstFailure,undefined);
});
test('diagnostic still observes the work budget',t=>{
 const f=frame();f.after.accesses[0].width=1;
 assert.throws(()=>checkMemoryViewFrame(f,{...options,work:workFor(t,{workUnits:1})}),e=>e.code==='budget-exhausted');
});
