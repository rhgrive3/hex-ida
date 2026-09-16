from pathlib import Path
p=Path('js/managed/shared/bridge-dex-overlay-v2.js')
s=p.read_text()
marker="const valueType = (kind,width,addressSpace=null) => addressSpace ? {kind,widthBits:width,addressSpace} : {kind,widthBits:width};\n"
assert marker in s and 'function repairDexControlSemantics' not in s
insert=r'''

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
'''
s=s.replace(marker, marker+insert, 1)
old='  let out=splitDexExceptionBlocks(fn,lowered);'
new='  let out=repairDexControlSemantics(fn,lowered);\n  out=splitDexExceptionBlocks(fn,out);'
assert old in s
s=s.replace(old,new,1)
p.write_text(s)
