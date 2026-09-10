import { deepFreeze } from '../../core/identity/index.js';
import { buildSemanticSsa } from '../../semantics/ssa/build.js';

const blockOffset = id => {
  const m = /^bb_0x([0-9a-f]+)$/i.exec(String(id));
  return m ? Number.parseInt(m[1], 16) : null;
};
const blockId = off => `bb_0x${off.toString(16)}`;
const valueType = (kind,width,addressSpace=null) => addressSpace ? {kind,widthBits:width,addressSpace} : {kind,widthBits:width};

function splitDexExceptionBlocks(fn, lowered) {
  if (!fn.exceptionRegions?.length) return lowered;
  const bundles = [...fn.bundles].sort((a,b)=>a.bytecodeOffset-b.bytecodeOffset);
  const bundleByEffect = new Map(bundles.map(b=>[b.operationId,b]));
  const offsets = new Set(bundles.map(b=>b.bytecodeOffset));
  const oldBlocks = lowered.cfg.blocks.map(b=>({ ...b, off:blockOffset(b.id) })).filter(b=>b.off!=null).sort((a,b)=>a.off-b.off);
  const starts = new Set(oldBlocks.map(b=>b.off));
  for (const r of fn.exceptionRegions) for (const off of [r.startOffset,r.endOffset,r.handlerOffset]) if (offsets.has(off)) starts.add(off);
  const sorted=[...starts].sort((a,b)=>a-b);
  if (sorted.length===oldBlocks.length && sorted.every((x,i)=>x===oldBlocks[i].off)) return lowered;
  const ownerOf = off => {
    let out=oldBlocks[0]; for(const b of oldBlocks){if(b.off>off)break;out=b} return out;
  };
  const oldNext = new Map(oldBlocks.map((b,i)=>[b.id,oldBlocks[i+1]?.off??Infinity]));
  const targetFirst = id => id;
  const cfgBlocks=[];
  for(let i=0;i<sorted.length;i++){
    const off=sorted[i], id=blockId(off), old=ownerOf(off), next=sorted[i+1]??Infinity, oldEnd=oldNext.get(old.id);
    let successors=[];
    if(next<oldEnd) successors=[{to:blockId(next),kind:'fallthrough'}];
    else successors=(old.successors??[]).filter(e=>e.kind!=='exception').map(e=>({...e,to:targetFirst(e.to)}));
    for(const r of fn.exceptionRegions){if(off>=r.startOffset&&off<r.endOffset&&offsets.has(r.handlerOffset)){
      const to=blockId(r.handlerOffset); if(!successors.some(e=>e.to===to&&e.kind==='exception'))successors.push({to,kind:'exception'});
    }}
    cfgBlocks.push({id,predecessors:[],successors});
  }
  const byId=new Map(cfgBlocks.map(b=>[b.id,b]));
  for(const b of cfgBlocks)for(const e of b.successors){const t=byId.get(e.to);if(t&&!t.predecessors.includes(b.id))t.predecessors.push(b.id)}
  const nodeOffset = n => bundleByEffect.get(n.sourceEffectIds?.[0])?.bytecodeOffset ?? blockOffset(n.blockId) ?? 0;
  const nodes=lowered.semanticIr.nodes.map(n=>({...n,blockId:blockId(sorted.filter(s=>s<=nodeOffset(n)).at(-1)??sorted[0])}));
  const blockOrigin=new Map(lowered.semanticIr.blocks.map(b=>[b.id,b.origin]));
  const irBlocks=cfgBlocks.map(b=>({id:b.id,nodeIds:nodes.filter(n=>n.blockId===b.id).map(n=>n.id),origin:blockOrigin.get(ownerOf(blockOffset(b.id)).id)}));
  const cfg={...lowered.cfg,blocks:cfgBlocks};
  const semanticIr={...lowered.semanticIr,blocks:irBlocks,nodes};
  return {...lowered,cfg,semanticIr,ssa:buildSemanticSsa(semanticIr,cfg)};
}

function repairDexFieldMemory(fn, lowered) {
  const bound = new Map();
  for(const b of fn.bundles){const m=b.memoryEffects?.[0];if(m?.bindingVersion===1)bound.set(b.operationId,{bundle:b,memory:m})}
  if(!bound.size)return lowered;
  const old=lowered.semanticIr, values=[...old.values], valueById=new Map(values.map(v=>[v.id,v]));
  const replacement=new Map(), additionsBefore=new Map(), additionsAfter=new Map();
  let seq=0;
  const makeValue=(id,machineType,nodeId,origin)=>{const v={id,kind:'definition',machineType,definitionNodeId:nodeId,sourceEntityId:null,variableKey:null,origin};values.push(v);valueById.set(id,v);return v};
  const readsFor=(effectId)=>old.nodes.filter(n=>n.kind==='state-read'&&n.sourceEffectIds?.includes(effectId));
  for(const node of old.nodes){
    if(!['load','store'].includes(node.kind))continue;
    const effectId=node.sourceEffectIds?.find(id=>bound.has(id));if(!effectId)continue;
    const {memory}=bound.get(effectId), reads=readsFor(effectId), getRead=i=>reads[i]?.outputs?.[0];
    const addressNodeId=`${node.id}:field-address`, addressValueId=`${addressNodeId}:value`, addressInputs=memory.addressKind==='instance-field'?[getRead(memory.addressReadIndex)].filter(Boolean):[];
    const addressType=valueType('address',32,memory.space), addressValue=makeValue(addressValueId,addressType,addressNodeId,node.origin);
    const addressNode={id:addressNodeId,kind:'intrinsic',blockId:node.blockId,inputs:addressInputs,outputs:[addressValue.id],operator:`managed.dex.${memory.addressKind}-address`,variable:null,memory:null,call:null,intrinsic:{inputs:addressInputs,outputs:[addressValue.id],stateReads:[],stateWrites:[],memoryRead:{scope:'none'},memoryWrite:{scope:'none'},controlEffects:[],determinism:'input-dependent',symbolicDetail:'summary-only'},targets:[],attributes:{fieldIdentity:memory.fieldIdentity,descriptor:memory.descriptor},unknown:null,completeness:'complete',sourceEffectIds:[effectId],origin:node.origin};
    additionsBefore.set(node.id,[addressNode]);
    const mem={...node.memory,addressSpace:memory.space,addressExpr:{valueId:addressValue.id},widthBits:memory.byteWidth*8,volatility:memory.volatility??'unknown',atomic:memory.atomic??'unknown',ordering:memory.ordering??'unknown'};
    let updated={...node,memory:mem};
    if(memory.isWrite){let valueId=getRead(memory.valueReadIndex);const extras=[];if(memory.valueBits>memory.byteWidth*8){const id=`${node.id}:field-truncate`,out=`${id}:value`;makeValue(out,valueType('bitvector',memory.byteWidth*8),id,node.origin);extras.push({id,kind:'trunc',blockId:node.blockId,inputs:[valueId],outputs:[out],operator:null,variable:null,memory:null,call:null,intrinsic:null,targets:[],attributes:{},unknown:null,completeness:'complete',sourceEffectIds:[effectId],origin:node.origin});valueId=out}additionsBefore.set(node.id,[addressNode,...extras]);updated={...updated,inputs:[addressValue.id,valueId]}}
    else {updated={...updated,inputs:[addressValue.id]};if(memory.extension){const id=`${node.id}:field-extend`,out=`${id}:value`,kind=memory.extension==='sign'?'sext':'zext';makeValue(out,memory.valueType,id,node.origin);const ext={id,kind,blockId:node.blockId,inputs:[node.outputs[0]],outputs:[out],operator:null,variable:null,memory:null,call:null,intrinsic:null,targets:[],attributes:{},unknown:null,completeness:'complete',sourceEffectIds:[effectId],origin:node.origin};additionsAfter.set(node.id,[ext]);for(const w of old.nodes.filter(n=>n.kind==='state-write'&&n.sourceEffectIds?.includes(effectId)&&n.inputs?.[0]===node.outputs[0]))replacement.set(w.id,{...w,inputs:[out]})}}
    replacement.set(node.id,updated);
  }
  const nodes=[];for(const n of old.nodes){nodes.push(...(additionsBefore.get(n.id)??[]));nodes.push(replacement.get(n.id)??n);nodes.push(...(additionsAfter.get(n.id)??[]))}
  const byBlock=new Map();for(const n of nodes){if(!byBlock.has(n.blockId))byBlock.set(n.blockId,[]);byBlock.get(n.blockId).push(n.id)}
  const blocks=old.blocks.map(b=>({...b,nodeIds:byBlock.get(b.id)??[]}));
  const semanticIr={...old,blocks,nodes,values};
  return {...lowered,semanticIr,ssa:buildSemanticSsa(semanticIr,lowered.cfg)};
}

export function overlayDexLowering(fn, lowered) {
  if(fn?.frontendId!=='dex')return lowered;
  let out=splitDexExceptionBlocks(fn,lowered);
  out=repairDexFieldMemory(fn,out);
  return deepFreeze(out);
}
