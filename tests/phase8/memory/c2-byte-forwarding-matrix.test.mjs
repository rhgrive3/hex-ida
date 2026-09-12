import test from 'node:test';
import assert from 'node:assert/strict';
import { stableDigest } from '../../../js/core/identity/index.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { createMemoryRegionRef } from '../../../js/semantics/memoryssa/contract.js';
import { buildMemorySsa, MEMORY_SSA_BUILD_VERSION, isCanonicalMemorySsaProducerArtifact } from '../../../js/semantics/memoryssa/build.js';
import { forwardMemoryValue, CANONICAL_MEMORY_FORWARDING_CONSUMER, CANONICAL_MEMORY_FORWARDING_PURPOSE,
 canonicalMemoryForwardingContext, isCanonicalExactMemoryForwarding } from '../../../js/semantics/memoryssa/queries.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { buildExpressionForTesting } from '../../../js/decompiler/pipeline-core.js';

const WIDTHS=[8,16,32,64,128],ENDIANS=['little','big'];
const CASES=['full','split','overwrite','hole','unknown-byte','volatile-load','atomic-load',
 'volatile-store','atomic-store','unknown-write','unknown-call','may-store'];
const origin=id=>({instructionIds:[`c2_${id}`]});
const bitType=widthBits=>({kind:'bitvector',widthBits});
const addressType={kind:'address',widthBits:64,addressSpace:'memory'};
function readBytes(bytes,endian) {
 let value=0n;
 for(let i=0;i<bytes.length;i++)value|=BigInt(bytes[i])<<BigInt(8*(endian==='little'?i:bytes.length-1-i));
 return value;
}
function makeFixture(bits,endian,scenario) {
 const name=`c2-bytes-${bits}-${endian}-${scenario}`,count=bits/8,nodes=[],values=[],expected=Array.from({length:count},(_,i)=>(0x91+i*37)&255);
 const add=(id,kind,extra={})=>{const node={id,kind,blockId:'b0',inputs:[],outputs:[],origin:origin(id),...extra};nodes.push(node);return node;};
 const value=(id,type,definition,constant)=>{
  const item={id,kind:definition?'definition':'entry',machineType:type,origin:origin(id)};
  if(definition){item.definitionNodeId=definition;item.sourceEntityId=definition;}
  if(constant!==undefined)item.metadata={constant:{kind:'bitvector',widthBits:type.widthBits,value:constant}};
  values.push(item);return id;
 };
 value('addr',addressType,'n_addr');add('n_addr','address',{outputs:['addr'],attributes:{value:'0x4000'}});
 const access=(widthBits,qualifiers={})=>({addressSpace:'memory',addressExpr:{valueId:'addr'},widthBits,endian,
  alignment:1,volatility:false,atomic:false,ordering:'unknown',faults:[],...qualifiers});
 const addressing=offset=>({machineEffects:{operationMetadata:{addressing:{addressDisplacement:String(offset)}}}});
 const store=(id,offset,bytes,{unknown=false,qualifiers={}}={})=>{
  const width=bytes.length*8,stored=readBytes(bytes,endian),valueId=`value_${id}`,definition=`const_${id}`;
  value(valueId,bitType(width),unknown?null:definition,unknown?undefined:stored);
  if(!unknown)add(definition,'const',{outputs:[valueId],attributes:{value:stored}});
  add(id,'store',{inputs:['addr',valueId],memory:access(width,qualifiers),attributes:addressing(offset)});
 };
 if(scenario==='split'||scenario==='hole'){
  for(let i=0;i<count-(scenario==='hole'?1:0);i++)store(`store_${i}`,i,[expected[i]]);
 }else {
  store('store_full',0,expected,{qualifiers:scenario==='volatile-store'?{volatility:true}:scenario==='atomic-store'?{atomic:true}: {}});
 }
 if(scenario==='overwrite'||scenario==='unknown-byte'||scenario==='may-store'){
  const offset=Math.floor(count/2);expected[offset]=0x5e;
  store('store_override',offset,[expected[offset]],{unknown:scenario==='unknown-byte'});
 }
 let partial=false;
 if(scenario==='unknown-write'){
  partial=true;add('unknown_writer','unknown-memory-effect',{completeness:'unknown',unknown:{reason:'unresolved-writer',categories:['memory']}});
 }
 if(scenario==='unknown-call'){
  partial=true;add('unknown_call','call',{completeness:'unknown',unknown:{reason:'unresolved-call',categories:['memory']},call:{
   targetValueIds:[],targetEntityIds:[],arguments:[],returns:[],stateReads:[],stateWrites:[],memoryRead:{scope:'unknown'},memoryWrite:{scope:'unknown'},
   controlEffects:[],determinism:'unknown',noreturn:'unknown',mayThrow:'unknown',summarySource:'fixture',completeness:'unknown',
   unknownEffects:{reason:'unresolved-call',categories:['memory']}}});
 }
 value('loaded',bitType(bits),'n_load');
 add('n_load','load',{inputs:['addr'],outputs:['loaded'],memory:access(bits,scenario==='volatile-load'?{volatility:true}:scenario==='atomic-load'?{atomic:true}:{}),attributes:addressing(0)});
 add('n_return','return',{inputs:['loaded']});
 const ir=createSemanticIrFunction({schemaVersion:2,contractVersion:'2.0.0',functionId:name,entryBlockId:'b0',blocks:[{id:'b0',nodeIds:nodes.map(n=>n.id),origin:origin('block')}],
  nodes,values,completeness:partial?'partial':'complete',unknowns:partial?[{reason:'unresolved-memory',categories:['memory']}]:[],origin:origin(name)});
 const cfg=createSemanticCfg({functionId:name,entryBlockId:'b0',blocks:[{id:'b0',successors:[]}]});
 const region=createMemoryRegionRef({id:'region',kind:'global-absolute',binaryId:name,address:'0x4000',widthBits:bits,origin:origin('region')});
 const digest=stableDigest(ir),identity={binaryId:name,sliceId:'slice',functionId:name,semanticIrId:'ir',scalarSsaId:'ssa',memorySsaId:'mssa',snapshotId:'snapshot',
  semanticIrContractVersion:'2.0.0',semanticIrDigest:digest,scalarSsaBuildVersion:'1.0.0',scalarSsaDigest:'fixture-ssa',memorySsaBuildVersion:MEMORY_SSA_BUILD_VERSION,analyzerVersion:'c2-fixture'};
 const artifact=buildMemorySsa(ir,cfg,{regions:[region],resolveRegion:()=>region,queryAlias:(_left,_right,context)=>{
  const may=scenario==='may-store'&&[context.left,context.right].some(item=>item.descriptor?.node?.id==='store_override');
  return {relation:may?'may':'must',reasonCodes:[may?'overlapping-possible-store':'identical-region-identity'],evidenceIds:['c2-canonical-alias'],
   proof:{analyzerId:'phase7.alias.solver',analyzerVersion:'1.1.0',completeness:'complete',stopReason:null}};
 },identity,snapshotId:'snapshot',
  canonicalIrIdentity:{functionId:name,semanticIrId:'ir',semanticIrContractVersion:'2.0.0',semanticIrDigest:digest}});
 return {name,ir,cfg,artifact,expected};
}

test('C2 byte forwarding: canonical width/endian/coverage/clobber matrix reaches the actual consumer',t=>{
 const rows=[];
 for(const bits of WIDTHS)for(const endian of ENDIANS)for(const scenario of CASES){
  const {name,ir,cfg,artifact,expected}=makeFixture(bits,endian,scenario),before=structuredClone(ir);
  assert.equal(isCanonicalMemorySsaProducerArtifact(artifact),true,name);
  if(scenario==='may-store'){
   assert.ok(artifact.definitions.some(d=>d.sourceEntityId==='store_full'&&d.kind==='memory-def'),'initial coverage must be an ordinary exact store');
   assert.ok(artifact.definitions.some(d=>d.sourceEntityId==='store_override'&&d.kind==='may-alias-clobber'),'only the overlapping override is may-alias');
  }
  if(scenario==='unknown-call')assert.ok(artifact.definitions.some(d=>d.sourceEntityId==='unknown_call'&&d.kind==='call-clobber'));
  if(scenario==='unknown-write')assert.ok(artifact.definitions.some(d=>d.sourceEntityId==='unknown_writer'&&d.kind==='unknown-clobber'));
  const use=artifact.uses.find(u=>u.sourceEntityId==='n_load');assert.ok(use,name);
  const options={functionId:ir.functionId,ir,cfg,consumerId:CANONICAL_MEMORY_FORWARDING_CONSUMER,purpose:CANONICAL_MEMORY_FORWARDING_PURPOSE};
  const direct=forwardMemoryValue(artifact,use.id,options);
  const projected=projectSemanticIrV2ToLegacyV1(ir,{memorySsa:artifact,cfg}),load=projected.instructions.find(i=>i.semanticNodeId==='n_load');assert.ok(load,name);
  const numeric=['full','split','overwrite'].includes(scenario);
  if(numeric){
   assert.equal(direct.status,'exact',`${name}: ${direct.reason}`);assert.deepEqual(direct.bytes,expected,name);
   assert.equal(direct.value,readBytes(expected,endian),name);assert.equal(direct.widthBits,bits);
   assert.equal(direct.proofKind,'canonical-memoryssa-byte-forwarding');
   const winners=scenario==='split'?Array.from({length:bits/8},(_,i)=>`store_${i}`):scenario==='overwrite'?
    bits===8?['store_override']:['store_full','store_override']:['store_full'];
   assert.deepEqual(direct.provenance.sourceEntityIds,winners,'winner order and overwritten contributors must be exact');
   assert.deepEqual(direct.contributingDefinitionIds,winners.map(id=>artifact.definitions.find(d=>d.sourceEntityId===id).id));
   assert.equal(load.memoryForwarding?.status,'exact',name);assert.equal(load.dst.const,direct.value,name);
   const context=canonicalMemoryForwardingContext(direct,{artifact,useId:use.id,sourceEntityId:'n_load',nodeId:'n_load',entityId:direct.loadEntityId,
    regionId:direct.loadRegionId,range:direct.loadRange,artifactDigest:artifact.canonicalDigest,snapshotId:artifact.snapshotId,
    consumerId:CANONICAL_MEMORY_FORWARDING_CONSUMER,purpose:CANONICAL_MEMORY_FORWARDING_PURPOSE});
   assert.equal(isCanonicalExactMemoryForwarding(direct,context),true);
   assert.equal(isCanonicalExactMemoryForwarding(structuredClone(direct),context),false,'copied proof has no private authority');
   assert.equal(isCanonicalExactMemoryForwarding(direct,{...context,snapshotId:'stale'}),false);
   assert.notEqual(forwardMemoryValue(structuredClone(artifact),use.id,options).status,'exact','copied producer has no private authority');
   const expression=buildExpressionForTesting(load.dst,{ir:{...projected,args:new Map()},model:{calls:[]}});
   assert.equal(expression.kind,'const',name);assert.equal(expression.value,direct.value,name);
   // A same-width producer may retain a structural reachingStore link. Its
   // presence is not authority: explicitly withdraw the canonical forwarding
   // fact while leaving that link intact and require a residual load.
   const unproved={...load.dst,const:null};
   unproved.def={...load,dst:unproved,memoryForwarding:{status:'unknown',exact:false,completeness:'unknown',reason:'test-withdrawn-proof'}};
   assert.equal(buildExpressionForTesting(unproved,{ir:{...projected,args:new Map()},model:{calls:[]}}).kind,'load',name);
  }else {
   assert.notEqual(direct.status,'exact',`${name}: unresolved byte/effect cannot authorize exact reconstruction`);
   assert.equal(load.dst.const,null,name);assert.notEqual(load.memoryForwarding?.status,'exact',name);
  }
  assert.deepEqual(forwardMemoryValue(artifact,use.id,options),direct,'same canonical artifact replay');
  const aborted=new AbortController();aborted.abort();
  assert.equal(forwardMemoryValue(artifact,use.id,{...options,signal:aborted.signal}).status,'cancelled');
  assert.deepEqual(structuredClone(ir),before,name);
  rows.push({bits,endian,scenario,status:direct.status,reason:direct.reason,expected:numeric?'numeric':'withheld',
   value:numeric?String(direct.value):null,bytes:numeric?direct.bytes:null});
 }
 assert.equal(rows.length,120);assert.equal(new Set(rows.map(r=>`${r.bits}/${r.endian}/${r.scenario}`)).size,120);
 t.diagnostic(JSON.stringify({schema:'c2-byte-forwarding-matrix-v1',rows,
  scope:'canonical builder/query/compatibility/consumer; no cloned proof issuance, no replacement memory engine'}));
});
