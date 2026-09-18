import { deepFreeze } from '../../core/identity/index.js';
import { buildSemanticSsa } from '../../semantics/ssa/build.js';

const blockOffset = id => {
  const m = /^bb_0x([0-9a-f]+)$/i.exec(String(id));
  return m ? Number.parseInt(m[1], 16) : null;
};
const blockId = off => `bb_0x${off.toString(16)}`;
const valueType = (kind,width,addressSpace=null) => addressSpace ? {kind,widthBits:width,addressSpace} : {kind,widthBits:width};


const DEX_BRANCH_OPERATORS = Object.freeze({ eq:'eq', ne:'ne', lt:'slt', ge:'sge', gt:'sgt', le:'sle' });

function repairDexControlSemantics(fn, lowered) {
  const old = lowered.semanticIr;
  const bundleByEffect = new Map((fn.bundles ?? []).map((bundle) => [bundle.operationId, bundle]));
  const additionsBefore = new Map();
  const replacements = new Map();
  const addedValues = [];

  for (const node of old.nodes) {
    const effectId = node.sourceEffectIds?.find((id) => bundleByEffect.has(id));
    const bundle = effectId == null ? null : bundleByEffect.get(effectId);
    if (!bundle) continue;

    if (node.kind === 'switch') {
      const control = bundle.controlEffects?.find((effect) => effect?.kind === 'switch');
      if (control && Array.isArray(control.caseValues)
          && Array.isArray(control.targetOffsets)
          && control.caseValues.length === control.targetOffsets.length) {
        replacements.set(node.id, {
          ...node,
          attributes: {
            ...node.attributes,
            caseValues: [...control.caseValues],
            payloadKind: control.payloadKind ?? null,
            payloadOffset: control.payloadOffset ?? null,
            machineControlEffect: control,
          },
        });
      }
      continue;
    }

    if (node.kind !== 'conditional-branch') continue;
    const control = bundle.controlEffects?.find((effect) => effect?.kind === 'conditional-branch');
    const condition = control?.condition;
    if (!condition || condition.kind !== 'integer-comparison' || condition.arity !== 1
        || condition.compareToZero !== true || condition.signed !== true
        || condition.widthBits !== 32 || !DEX_BRANCH_OPERATORS[condition.predicate]
        || node.inputs.length !== 1) continue;

    const zeroNodeId = `${node.id}:dex-zero`;
    const zeroValueId = `${zeroNodeId}:value`;
    const compareNodeId = `${node.id}:dex-condition`;
    const predicateValueId = `${compareNodeId}:value`;
    const zeroNode = {
      id: zeroNodeId, kind:'const', blockId:node.blockId, inputs:[], outputs:[zeroValueId],
      operator:null, variable:null, memory:null, call:null, intrinsic:null, targets:[],
      attributes:{ value:0, widthBits:32 }, unknown:null, completeness:node.completeness,
      sourceEffectIds:[...node.sourceEffectIds], origin:node.origin,
      metadata:{ constant:'0', mnemonic:'dex-branch-zero' },
    };
    const compareNode = {
      id: compareNodeId, kind:'compare', blockId:node.blockId,
      inputs:[node.inputs[0], zeroValueId], outputs:[predicateValueId],
      operator:DEX_BRANCH_OPERATORS[condition.predicate], variable:null, memory:null, call:null, intrinsic:null, targets:[],
      attributes:{ predicate:condition.predicate, signed:true, widthBits:32 },
      unknown:node.unknown, completeness:node.completeness,
      sourceEffectIds:[...node.sourceEffectIds], origin:node.origin,
      metadata:{ mnemonic:`dex-branch-${condition.predicate}` },
    };
    additionsBefore.set(node.id, [zeroNode, compareNode]);
    addedValues.push(
      { id:zeroValueId, kind:'definition', machineType:{kind:'bitvector',widthBits:32}, definitionNodeId:zeroNodeId, origin:node.origin, metadata:{constant:'0'} },
      { id:predicateValueId, kind:'definition', machineType:{kind:'predicate',widthBits:1}, definitionNodeId:compareNodeId, origin:node.origin },
    );
    replacements.set(node.id, {
      ...node,
      inputs:[predicateValueId],
      attributes:{
        ...node.attributes,
        conditionCode:condition.predicate,
        predicate:condition.predicate,
        signed:true,
        comparisonArity:1,
        compareToZero:true,
        machineControlEffect:control,
      },
    });
  }

  if (!additionsBefore.size && !replacements.size) return lowered;
  const nodes=[];
  for (const node of old.nodes) {
    nodes.push(...(additionsBefore.get(node.id) ?? []));
    nodes.push(replacements.get(node.id) ?? node);
  }
  const blocks=old.blocks.map((block)=>({
    ...block,
    nodeIds:block.nodeIds.flatMap((id)=>[
      ...(additionsBefore.get(id) ?? []).map((node)=>node.id),
      replacements.get(id)?.id ?? id,
    ]),
  }));
  const semanticIr={...old,blocks,nodes,values:[...old.values,...addedValues]};
  return {...lowered,semanticIr,ssa:buildSemanticSsa(semanticIr,lowered.cfg)};
}

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
  const replacement=new Map(), additionsBefore=new Map(), additionsAfter=new Map(), repairedUnknownAddressValues=new Set();
  let seq=0;
  const makeValue=(id,machineType,nodeId,origin)=>{const v={id,kind:'definition',machineType,definitionNodeId:nodeId,sourceEntityId:null,variableKey:null,origin};values.push(v);valueById.set(id,v);return v};
  // Index state-read/state-write nodes by each of their sourceEffectIds ONCE so each field
  // access is served by an O(matching-nodes) lookup instead of a full `old.nodes` rescan
  // (#8977). A node is either state-read or state-write, and each per-effect list is built by
  // walking `old.nodes` in order, so every list preserves the exact order `filter` produced.
  const NO_NODES=Object.freeze([]);
  const readsByEffect=new Map(), writesByEffect=new Map();
  for(const n of old.nodes){const ids=n.sourceEffectIds;if(!ids)continue;const target=n.kind==='state-read'?readsByEffect:n.kind==='state-write'?writesByEffect:null;if(!target)continue;for(const id of ids){let list=target.get(id);if(!list)target.set(id,list=[]);list.push(n)}}
  const readsFor=(effectId)=>readsByEffect.get(effectId)??NO_NODES;
  for(const node of old.nodes){
    if(!['load','store'].includes(node.kind))continue;
    const effectId=node.sourceEffectIds?.find(id=>bound.has(id));if(!effectId)continue;
    const {memory}=bound.get(effectId), reads=readsFor(effectId), getRead=i=>reads[i]?.outputs?.[0];
    const previousAddressValueId=node.memory?.addressExpr?.valueId, previousAddressValue=valueById.get(previousAddressValueId);
    if(memory.addressKind==='static-field'&&previousAddressValue?.kind==='unknown'&&previousAddressValue.metadata?.reason==='memory-address-unavailable') repairedUnknownAddressValues.add(previousAddressValueId);
    const addressNodeId=`${node.id}:field-address`, addressValueId=`${addressNodeId}:value`, addressInputs=memory.addressKind==='instance-field'?[getRead(memory.addressReadIndex)].filter(Boolean):[];
    const addressType=valueType('address',32,memory.space), addressValue=makeValue(addressValueId,addressType,addressNodeId,node.origin);
    const addressNode={id:addressNodeId,kind:'intrinsic',blockId:node.blockId,inputs:addressInputs,outputs:[addressValue.id],operator:`managed.dex.${memory.addressKind}-address`,variable:null,memory:null,call:null,intrinsic:{inputs:addressInputs,outputs:[addressValue.id],stateReads:[],stateWrites:[],memoryRead:{scope:'none'},memoryWrite:{scope:'none'},controlEffects:[],determinism:'input-dependent',symbolicDetail:'summary-only'},targets:[],attributes:{fieldIdentity:memory.fieldIdentity,descriptor:memory.descriptor},unknown:null,completeness:'complete',sourceEffectIds:[effectId],origin:node.origin};
    additionsBefore.set(node.id,[addressNode]);
    const mem={...node.memory,addressSpace:memory.space,addressExpr:{valueId:addressValue.id},widthBits:memory.byteWidth*8,volatility:memory.volatility??'unknown',atomic:memory.atomic??'unknown',ordering:memory.ordering??'unknown'};
    let updated={...node,memory:mem};
    if(memory.isWrite){let valueId=getRead(memory.valueReadIndex);const extras=[];if(memory.valueBits>memory.byteWidth*8){const id=`${node.id}:field-truncate`,out=`${id}:value`;makeValue(out,valueType('bitvector',memory.byteWidth*8),id,node.origin);extras.push({id,kind:'trunc',blockId:node.blockId,inputs:[valueId],outputs:[out],operator:null,variable:null,memory:null,call:null,intrinsic:null,targets:[],attributes:{},unknown:null,completeness:'complete',sourceEffectIds:[effectId],origin:node.origin});valueId=out}additionsBefore.set(node.id,[addressNode,...extras]);updated={...updated,inputs:[addressValue.id,valueId]}}
    else {updated={...updated,inputs:[addressValue.id]};if(memory.extension){const id=`${node.id}:field-extend`,out=`${id}:value`,kind=memory.extension==='sign'?'sext':'zext';makeValue(out,memory.valueType,id,node.origin);const fromBits=memory.byteWidth*8,toBits=memory.valueBits??memory.valueType?.widthBits;const ext={id,kind,blockId:node.blockId,inputs:[node.outputs[0]],outputs:[out],operator:null,variable:null,memory:null,call:null,intrinsic:null,targets:[],attributes:{fromBits,toBits},unknown:null,completeness:'complete',sourceEffectIds:[effectId],origin:node.origin};additionsAfter.set(node.id,[ext]);for(const w of writesByEffect.get(effectId)??NO_NODES){if(w.inputs?.[0]===node.outputs[0])replacement.set(w.id,{...w,inputs:[out]})}}}
    replacement.set(node.id,updated);
  }
  const nodes=[];for(const n of old.nodes){nodes.push(...(additionsBefore.get(n.id)??[]));nodes.push(replacement.get(n.id)??n);nodes.push(...(additionsAfter.get(n.id)??[]))}
  const byBlock=new Map();for(const n of nodes){if(!byBlock.has(n.blockId))byBlock.set(n.blockId,[]);byBlock.get(n.blockId).push(n.id)}
  const blocks=old.blocks.map(b=>({...b,nodeIds:byBlock.get(b.id)??[]}));
  const retainedValues=values.filter(v=>!repairedUnknownAddressValues.has(v.id));
  const stillMissingAddress=retainedValues.some(v=>v.kind==='unknown'&&v.metadata?.reason==='memory-address-unavailable');
  const unknowns=(old.unknowns??[]).filter(u=>u?.reason!=='memory-address-unavailable'||stillMissingAddress);
  const allNodesComplete=nodes.every(n=>n.completeness==='complete');
  const completeness=fn.aggregateCompleteness==='exact'&&unknowns.length===0&&allNodesComplete?'complete':old.completeness;
  const semanticIr={...old,blocks,nodes,values:retainedValues,unknowns,completeness};
  return {...lowered,semanticIr,ssa:buildSemanticSsa(semanticIr,lowered.cfg)};
}



function repairDexArrayMemory(fn, lowered) {
  const bound=new Map();
  for(const b of fn.bundles){const m=b.memoryEffects?.[0];if(m?.bindingVersion===2)bound.set(b.operationId,{bundle:b,memory:m})}
  if(!bound.size)return lowered;
  const old=lowered.semanticIr,values=[...old.values],valueById=new Map(values.map(v=>[v.id,v]));
  const replacement=new Map(),before=new Map(),after=new Map();
  const NO=Object.freeze([]),readsByEffect=new Map(),writesByEffect=new Map();
  for(const n of old.nodes){const ids=n.sourceEffectIds;if(!ids)continue;const target=n.kind==='state-read'?readsByEffect:n.kind==='state-write'?writesByEffect:null;if(!target)continue;for(const id of ids){let list=target.get(id);if(!list)target.set(id,list=[]);list.push(n)}}
  const makeValue=(id,machineType,nodeId,origin,metadata=null)=>{const v={id,kind:'definition',machineType,definitionNodeId:nodeId,sourceEntityId:null,variableKey:null,origin,...(metadata?{metadata}:{})};values.push(v);valueById.set(id,v);return v};
  for(const node of old.nodes){
    if(!['load','store'].includes(node.kind))continue;
    const effectId=node.sourceEffectIds?.find(id=>bound.has(id));if(!effectId)continue;
    const {memory,bundle}=bound.get(effectId),reads=readsByEffect.get(effectId)??NO,getRead=i=>reads[i]?.outputs?.[0];
    const base=getRead(memory.arrayReadIndex),index=memory.indexReadIndex==null?null:getRead(memory.indexReadIndex);
    if(!base)continue;
    const addressNodeId=`${node.id}:array-address`,addressValueId=`${addressNodeId}:value`,addressInputs=[base,index].filter(Boolean);
    makeValue(addressValueId,{kind:'address',widthBits:32,addressSpace:'array-element'},addressNodeId,node.origin);
    const addressNode={id:addressNodeId,kind:'intrinsic',blockId:node.blockId,inputs:addressInputs,outputs:[addressValueId],operator:'managed.dex.array-element-address',variable:null,memory:null,call:null,intrinsic:{inputs:addressInputs,outputs:[addressValueId],stateReads:[],stateWrites:[],memoryRead:{scope:'none'},memoryWrite:{scope:'none'},controlEffects:[],determinism:'input-dependent',symbolicDetail:'summary-only'},targets:[],attributes:{variant:memory.variant??null,elementWidth:memory.elementWidth??memory.byteWidth,elementCount:memory.elementCount??1,bulk:memory.bulk===true},unknown:null,completeness:'complete',sourceEffectIds:[effectId],origin:node.origin};
    const extras=[addressNode];
    const faults=[...(memory.receiverNullException===true?[{kind:'null-reference',condition:{valueId:base},detail:{exceptionType:'java/lang/NullPointerException',receiver:true}}]:[]),...(memory.boundsException===true&&index?[{kind:'array-bounds',condition:{valueId:index},detail:{exceptionType:'java/lang/ArrayIndexOutOfBoundsException'}}]:[])];const mem={...node.memory,addressSpace:'array-element',addressExpr:{valueId:addressValueId},widthBits:(memory.byteWidth||4)*8,faults};
    let updated={...node,memory:mem};
    if(memory.isWrite){
      let stored=memory.valueReadIndex==null?null:getRead(memory.valueReadIndex);
      if(stored&&memory.valueBits>memory.byteWidth*8){const id=`${node.id}:array-truncate`,out=`${id}:value`;makeValue(out,{kind:'bitvector',widthBits:memory.byteWidth*8},id,node.origin);extras.push({id,kind:'trunc',blockId:node.blockId,inputs:[stored],outputs:[out],operator:null,variable:null,memory:null,call:null,intrinsic:null,targets:[],attributes:{fromBits:memory.valueBits,toBits:memory.byteWidth*8},unknown:null,completeness:'complete',sourceEffectIds:[effectId],origin:node.origin});stored=out}
      if(!stored&&memory.bulk===true){const id=`${node.id}:array-payload`,out=`${id}:value`;makeValue(out,{kind:'bitvector',widthBits:memory.byteWidth*8},id,node.origin,{payloadOffset:String(memory.payloadOffset??0),elementCount:String(memory.elementCount??0)});extras.push({id,kind:'intrinsic',blockId:node.blockId,inputs:[],outputs:[out],operator:'managed.dex.fill-array-data-payload',variable:null,memory:null,call:null,intrinsic:{inputs:[],outputs:[out],stateReads:[],stateWrites:[],memoryRead:{scope:'none'},memoryWrite:{scope:'none'},controlEffects:[],determinism:'deterministic',symbolicDetail:'summary-only'},targets:[],attributes:{payloadOffset:memory.payloadOffset??null,elementCount:memory.elementCount??0,elementWidth:memory.elementWidth??memory.byteWidth},unknown:node.unknown,completeness:node.completeness,sourceEffectIds:[effectId],origin:node.origin});stored=out}
      updated={...updated,inputs:stored?[addressValueId,stored]:[addressValueId]};
    }else{
      updated={...updated,inputs:[addressValueId]};
      if(memory.extension){const id=`${node.id}:array-extend`,out=`${id}:value`,kind=memory.extension==='sign'?'sext':'zext';makeValue(out,memory.valueType,id,node.origin);const ext={id,kind,blockId:node.blockId,inputs:[node.outputs[0]],outputs:[out],operator:null,variable:null,memory:null,call:null,intrinsic:null,targets:[],attributes:{fromBits:memory.byteWidth*8,toBits:memory.valueBits},unknown:null,completeness:'complete',sourceEffectIds:[effectId],origin:node.origin};after.set(node.id,[ext]);for(const w of writesByEffect.get(effectId)??NO){if(w.inputs?.[0]===node.outputs[0])replacement.set(w.id,{...w,inputs:[out]})}}
    }
    before.set(node.id,extras);replacement.set(node.id,updated);
  }
  const nodes=[];for(const n of old.nodes){nodes.push(...(before.get(n.id)??[]));nodes.push(replacement.get(n.id)??n);nodes.push(...(after.get(n.id)??[]))}
  const byBlock=new Map();for(const n of nodes){if(!byBlock.has(n.blockId))byBlock.set(n.blockId,[]);byBlock.get(n.blockId).push(n.id)}
  const blocks=old.blocks.map(b=>({...b,nodeIds:byBlock.get(b.id)??[]}));
  const semanticIr={...old,blocks,nodes,values};
  return {...lowered,semanticIr,ssa:buildSemanticSsa(semanticIr,lowered.cfg)};
}

const DEX_SPECIAL_INTRINSICS=new Set(['new-array','filled-new-array','filled-new-array/range','array-length','check-cast','instance-of']);
function repairDexArrayTypeNodes(fn, lowered) {
  const bundles=new Map((fn.bundles??[]).map(b=>[b.operationId,b]));
  let changed=false;
  const nodes=lowered.semanticIr.nodes.map(node=>{
    const effectId=node.sourceEffectIds?.find(id=>bundles.has(id)),bundle=effectId?bundles.get(effectId):null,mn=bundle?.mnemonic;
    if(!bundle||(!DEX_SPECIAL_INTRINSICS.has(mn)&&mn!=='monitor-enter'&&mn!=='monitor-exit'))return node;
    if(node.kind==='state-read'||node.kind==='state-write'||node.kind==='load'||node.kind==='store')return node;
    changed=true;
    if(mn==='monitor-enter'||mn==='monitor-exit')return {...node,kind:'barrier',operator:null,attributes:{...(node.attributes??{}),synchronization:mn,type:'monitor'},metadata:{...(node.metadata??{}),dexMetadata:bundle.metadata??{}}};
    const operator=`managed.dex.${mn.replaceAll('/','-')}`;
    return {...node,kind:'intrinsic',operator,intrinsic:{inputs:[...(node.inputs??[])],outputs:[...(node.outputs??[])],stateReads:[],stateWrites:[],memoryRead:{scope:'none'},memoryWrite:(mn==='new-array'||mn.startsWith('filled-new-array'))?{scope:'all',addressSpaces:['managed-heap']}:{scope:'none'},controlEffects:[],determinism:'input-dependent',symbolicDetail:'summary-only'},attributes:{...(node.attributes??{}),...(bundle.metadata??{})},metadata:{...(node.metadata??{}),dexMetadata:bundle.metadata??{}}};
  });
  if(!changed)return lowered;
  const semanticIr={...lowered.semanticIr,nodes};
  return {...lowered,semanticIr,ssa:buildSemanticSsa(semanticIr,lowered.cfg)};
}

export function overlayDexLowering(fn, lowered) {
  if(fn?.frontendId!=='dex')return lowered;
  let out=repairDexControlSemantics(fn,lowered);
  out=splitDexExceptionBlocks(fn,out);
  out=repairDexFieldMemory(fn,out);
  out=repairDexArrayMemory(fn,out);
  out=repairDexArrayTypeNodes(fn,out);
  return deepFreeze(out);
}