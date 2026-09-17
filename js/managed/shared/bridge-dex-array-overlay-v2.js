import { deepFreeze } from '../../core/identity/index.js';
import { buildSemanticSsa } from '../../semantics/ssa/build.js';

const valueType = (kind,width,addressSpace=null) => addressSpace ? {kind,widthBits:width,addressSpace} : {kind,widthBits:width};

export function overlayDexArrayMemory(fn, lowered) {
  const bound = new Map();
  for (const bundle of fn.bundles ?? []) {
    const memory = bundle.memoryEffects?.[0];
    if (memory?.bindingVersion === 2 && memory.addressKind === 'array-element') {
      bound.set(bundle.operationId, { bundle, memory });
    }
  }
  if (!bound.size) return lowered;

  const old = lowered.semanticIr;
  const values = [...old.values];
  const valueById = new Map(values.map((value) => [value.id, value]));
  const replacement = new Map(), additionsBefore = new Map(), additionsAfter = new Map();
  const readsByEffect = new Map(), writesByEffect = new Map();
  const NO_NODES = Object.freeze([]);
  for (const node of old.nodes) {
    const ids = node.sourceEffectIds;
    if (!ids) continue;
    const target = node.kind === 'state-read' ? readsByEffect : node.kind === 'state-write' ? writesByEffect : null;
    if (!target) continue;
    for (const id of ids) {
      let list = target.get(id);
      if (!list) target.set(id, list = []);
      list.push(node);
    }
  }
  const makeValue = (id, machineType, nodeId, origin) => {
    const value = { id, kind:'definition', machineType, definitionNodeId:nodeId, sourceEntityId:null, variableKey:null, origin };
    values.push(value); valueById.set(id, value); return value;
  };

  for (const node of old.nodes) {
    if (!['load', 'store'].includes(node.kind)) continue;
    const effectId = node.sourceEffectIds?.find((id) => bound.has(id));
    if (!effectId) continue;
    const { memory } = bound.get(effectId);
    const reads = readsByEffect.get(effectId) ?? NO_NODES;
    const readValue = (index) => Number.isSafeInteger(index) ? reads[index]?.outputs?.[0] : null;
    const baseValueId = readValue(memory.addressReadIndex);
    const indexValueId = readValue(memory.indexReadIndex);
    if (!baseValueId || !indexValueId) continue;

    const addressNodeId = `${node.id}:array-address`;
    const addressValueId = `${addressNodeId}:value`;
    const addressValue = makeValue(addressValueId, valueType('address', 32, 'array-element'), addressNodeId, node.origin);
    const addressNode = {
      id:addressNodeId, kind:'intrinsic', blockId:node.blockId,
      inputs:[baseValueId, indexValueId], outputs:[addressValue.id], operator:'managed.dex.array-element-address',
      variable:null, memory:null, call:null,
      intrinsic:{ inputs:[baseValueId, indexValueId], outputs:[addressValue.id], stateReads:[], stateWrites:[], memoryRead:{scope:'none'}, memoryWrite:{scope:'none'}, controlEffects:[], determinism:'input-dependent', symbolicDetail:'summary-only' },
      targets:[], attributes:{ descriptor:memory.descriptor, byteWidth:memory.byteWidth, variant:memory.variant }, unknown:null,
      completeness:'complete', sourceEffectIds:[effectId], origin:node.origin,
    };
    const before = [addressNode];
    const updatedMemory = { ...node.memory, addressSpace:'array-element', addressExpr:{ valueId:addressValue.id }, widthBits:memory.byteWidth * 8 };
    let updated = { ...node, memory:updatedMemory, inputs:[addressValue.id] };

    if (memory.isWrite) {
      let valueId = readValue(memory.valueReadIndex);
      if (!valueId) continue;
      if (memory.valueBits > memory.byteWidth * 8) {
        const truncateNodeId = `${node.id}:array-truncate`, truncateValueId = `${truncateNodeId}:value`;
        makeValue(truncateValueId, valueType('bitvector', memory.byteWidth * 8), truncateNodeId, node.origin);
        before.push({
          id:truncateNodeId, kind:'trunc', blockId:node.blockId, inputs:[valueId], outputs:[truncateValueId], operator:null,
          variable:null, memory:null, call:null, intrinsic:null, targets:[], attributes:{ fromBits:memory.valueBits, toBits:memory.byteWidth * 8 },
          unknown:null, completeness:'complete', sourceEffectIds:[effectId], origin:node.origin,
        });
        valueId = truncateValueId;
      }
      updated = { ...updated, inputs:[addressValue.id, valueId] };
    } else if (memory.extension) {
      const extendNodeId = `${node.id}:array-extend`, extendValueId = `${extendNodeId}:value`;
      const kind = memory.extension === 'sign' ? 'sext' : 'zext';
      makeValue(extendValueId, memory.valueType, extendNodeId, node.origin);
      additionsAfter.set(node.id, [{
        id:extendNodeId, kind, blockId:node.blockId, inputs:[node.outputs[0]], outputs:[extendValueId], operator:null,
        variable:null, memory:null, call:null, intrinsic:null, targets:[], attributes:{ fromBits:memory.byteWidth * 8, toBits:memory.valueBits },
        unknown:null, completeness:'complete', sourceEffectIds:[effectId], origin:node.origin,
      }]);
      for (const write of writesByEffect.get(effectId) ?? NO_NODES) {
        if (write.inputs?.[0] === node.outputs[0]) replacement.set(write.id, { ...write, inputs:[extendValueId] });
      }
    }
    additionsBefore.set(node.id, before);
    replacement.set(node.id, updated);
  }

  const nodes = [];
  for (const node of old.nodes) {
    nodes.push(...(additionsBefore.get(node.id) ?? []));
    nodes.push(replacement.get(node.id) ?? node);
    nodes.push(...(additionsAfter.get(node.id) ?? []));
  }
  const byBlock = new Map();
  for (const node of nodes) {
    if (!byBlock.has(node.blockId)) byBlock.set(node.blockId, []);
    byBlock.get(node.blockId).push(node.id);
  }
  const blocks = old.blocks.map((block) => ({ ...block, nodeIds:byBlock.get(block.id) ?? [] }));
  const semanticIr = { ...old, blocks, nodes, values };
  return { ...lowered, semanticIr, ssa:buildSemanticSsa(semanticIr, lowered.cfg) };
}


export function overlayDexArrayLowering(fn, lowered) {
  if (fn?.frontendId !== 'dex') return lowered;
  return deepFreeze(overlayDexArrayMemory(fn, lowered));
}
