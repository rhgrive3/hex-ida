import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCppClassTypeIndex, isCanonicalCppClassTypeEvidence } from '../../../js/analysis/cxx/class-type.js';
import { createCppTypedArgumentEvidence } from '../../../js/analysis/cxx/typed-argument.js';
import { createCppTypedArgumentReceiverEvidence } from '../../../js/analysis/cxx/object-evidence.js';
import { createCxxEvidenceProvider } from '../../../js/analysis/cxx/project.js';
import { createCxxQueryPlanner } from '../../../js/analysis/cxx/query-recovery.js';
import { currentCppReceiver } from '../../../js/decompiler/cxx-evidence.js';

function symbols(rows) {
  return { names: rows.map(row=>row[0]), addrs: rows.map(row=>row[1]),
    funcs: [...new Set(rows.map(row=>row[1]))],
    nameAt: address=>rows.find(row=>row[1]===address)?.[0] };
}

test('lifetime ABI class proof rejects resemblance, incompatible aliases and forged or stale authority', ()=> {
  for (const name of ['_ZN6Entity6EntityEv', '_ZN6Entity5aC1EbEv', '_ZN6EntityC9Ev',
    '_ZNK6Entity1fEv', '_ZN6EntityC1Evjunk', '_Z1fP6Entity']) {
    assert.equal(buildCppClassTypeIndex({symbols:symbols([[name,1n]]),snapshotId:'s'}).size,0,name);
  }
  for (const rows of [['_ZN6EntityC1Ev','_ZN5OtherC1Ev'],
    ['_ZN6EntityC1Ev','_Z1fv'],['_Z1fv','_ZN6EntityC1Ev']]) {
    assert.equal(buildCppClassTypeIndex({symbols:symbols(rows.map(name=>[name,1n])),snapshotId:'s'}).size,0);
  }
  const s=symbols([['_ZN6EntityC1Ev',1n],['_ZN6EntityC2Ev',1n],['_Z1fP6Entity',2n]]);
  const p=buildCppClassTypeIndex({symbols:s,snapshotId:'s'}).get('Entity');
  assert.ok(isCanonicalCppClassTypeEvidence(p)); assert.ok(Object.isFrozen(p));
  const input={argumentProof:createCppTypedArgumentEvidence({symbol:'_Z1fP6Entity',functionAddress:2n}),
    classIdentity:{kind:'named',className:'Entity',offsetToTop:0n},classTypeProof:p,
    functionId:'f',functionAddress:2n,canonicalValueId:'x0',snapshotId:'s'};
  assert.equal(createCppTypedArgumentReceiverEvidence(input).classIdentity.vtableAddress,null);
  assert.throws(()=>createCppTypedArgumentReceiverEvidence({...input,classTypeProof:{...p}}),/class-proof-required/);
  assert.throws(()=>createCppTypedArgumentReceiverEvidence({...input,snapshotId:'later'}),/class-proof-required/);
  assert.throws(()=>createCppTypedArgumentReceiverEvidence({...input,classIdentity:{...input.classIdentity,className:'Other'}}),/class-proof-required/);
});

test('non-polymorphic input recovery publishes canonical anonymous fields without inventing this or layout',async()=> {
  const sym=symbols([['_ZN6EntityC1Ev',1n],['_Z1fP6EntityS0_',2n]]);
  const provider=createCxxEvidenceProvider({symbols:sym,snapshotId:'s',cacheKey:'s',
    cache:{get:async()=>({classes:[],pointerBytes:8})},read:()=>{throw new Error('no new byte analysis');}});
  await provider.build();
  const ir={functionId:'f',values:[{id:'arg0',kind:'arg',reg:'x0',bits:64}],instructions:[
    {op:'load',id:'read',loc:{kind:'field',base:{id:'arg0'},disp:8n,size:4},dst:{id:'v',bits:32}}]};
  const request={functionId:'f',functionAddress:2n,functionName:'_Z1fP6EntityS0_',ir};
  assert.equal(provider.projectForFunction(request),null);
  const projection=provider.projectForFunction({...request,enableTypedArguments:true});
  assert.ok(projection);assert.equal(projection.receiver.nonStaticProof,null);
  assert.equal(projection.receiver.receiverRole,'typed-argument');
  assert.equal(currentCppReceiver({addr:2n,cxxEvidence:projection},ir),null);
  assert.equal(projection.members.length,1);assert.equal(projection.members[0].offsetBytes,8n);
  const field=[...provider.memberIndex().classes.values()][0].ivars[0];
  assert.equal(field.anonymous,true);assert.equal(field.offset,8);assert.equal(field.size,4);
  const planner=createCxxQueryPlanner({symbols:sym,classEvidence:{classes:[]},
    isExecutable:()=>true,planningPolicy:'value-accessor-v3'});
  assert.ok(planner.planOwner('entity','Entity').some(row=>row.address===2n));
});
