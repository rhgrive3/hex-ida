import { deepFreeze } from '../../core/identity/index.js';
import { createSemanticIrFunction } from '../../semantics/ir/function.js';
import { createSemanticNode, createSemanticValue } from '../../semantics/ir/nodes.js';
import { buildSemanticSsa } from '../../semantics/ssa/build.js';
import { overlayDexArrayLowering } from './bridge-dex-array-overlay-v2.js';

const JVM_I32_SHIFTS = new Set(['ishl', 'ishr', 'iushr']);
const WASM_I32_SHIFTS = new Set(['i32.shl', 'i32.shr_s', 'i32.shr_u']);

function requiresI32ShiftMask(frontendId, mnemonic) {
  const text = String(mnemonic ?? '').toLowerCase();
  return frontendId === 'jvm' ? JVM_I32_SHIFTS.has(text)
    : frontendId === 'wasm' ? WASM_I32_SHIFTS.has(text)
      : false;
}

// JVM int shifts and Wasm i32 shifts both consume only the low 5 bits of the
// shift count. Keep that language rule explicit in canonical Semantic IR so a
// dynamic count is not later interpreted with host/target shift semantics
// (#8999). Signedness of the shifted value remains solely in the shift opcode.
export function overlayManagedI32ShiftCounts(fn, lowered, options = {}) {
  if (fn?.frontendId === 'dex') return overlayDexArrayLowering(fn, lowered);
  if (fn?.frontendId !== 'jvm' && fn?.frontendId !== 'wasm') return lowered;
  const shiftEffects = new Map((fn.bundles ?? [])
    .filter((bundle) => requiresI32ShiftMask(fn.frontendId, bundle?.mnemonic))
    .map((bundle) => [bundle.operationId, bundle]));
  if (!shiftEffects.size) return lowered;

  const old = lowered.semanticIr;
  const valueById = new Map((old.values ?? []).map((value) => [value.id, value]));
  const insertedByShift = new Map();
  const addedValues = [];
  const matched = new Set();

  for (const node of old.nodes ?? []) {
    const effectId = node.sourceEffectIds?.find((id) => shiftEffects.has(id));
    if (effectId == null) continue;
    const bundle = shiftEffects.get(effectId);
    if (node.kind !== 'binary' || node.inputs?.length !== 2 || node.outputs?.length !== 1
      || !['shl', 'ashr', 'lshr'].includes(node.operator)) {
      throw new TypeError('managed-bridge-invalid-i32-shift-shape');
    }
    const rhs = valueById.get(node.inputs[1]);
    if (rhs?.machineType?.kind !== 'bitvector' || rhs.machineType.widthBits !== 32) {
      throw new TypeError('managed-bridge-invalid-i32-shift-count-type');
    }
    matched.add(effectId);
    // Preserve the existing compact rendering/folding for constant counts by
    // publishing the already-normalized constant. Dynamic counts retain an
    // explicit canonical `and 31` node, so every consumer observes the source
    // VM's low-5-bit rule rather than host shift behavior.
    if (rhs.metadata?.constant != null) {
      let normalized;
      try { normalized = (BigInt(rhs.metadata.constant) & 31n).toString(); }
      catch { throw new TypeError('managed-bridge-invalid-i32-shift-count-constant'); }
      const normalizedNodeId = `${node.id}_shift_count_normalized_const`;
      const normalizedValueId = `${normalizedNodeId}_value`;
      const normalizedValue = createSemanticValue({
        id: normalizedValueId,
        kind: 'definition',
        machineType: rhs.machineType,
        definitionNodeId: normalizedNodeId,
        origin: node.origin,
        metadata: { constant: normalized },
      });
      const normalizedNode = createSemanticNode({
        id: normalizedNodeId,
        blockId: node.blockId,
        kind: 'const',
        inputs: [],
        outputs: [normalizedValueId],
        attributes: { value: normalized },
        origin: node.origin,
        sourceEffectIds: [effectId],
        completeness: 'complete',
        metadata: { mnemonic: `${bundle.mnemonic}:shift-count-normalized` },
      });
      insertedByShift.set(node.id, { before: [normalizedNode], replacement: { ...node, inputs: [node.inputs[0], normalizedValueId] } });
      addedValues.push(normalizedValue);
    } else {
      const constNodeId = `${node.id}_shift_count_mask_const`;
      const constValueId = `${constNodeId}_value`;
      const maskNodeId = `${node.id}_shift_count_mask`;
      const maskValueId = `${maskNodeId}_value`;
      const constValue = createSemanticValue({
        id: constValueId,
        kind: 'definition',
        machineType: rhs.machineType,
        definitionNodeId: constNodeId,
        origin: node.origin,
        metadata: { constant: '31' },
      });
      const maskValue = createSemanticValue({
        id: maskValueId,
        kind: 'definition',
        machineType: rhs.machineType,
        definitionNodeId: maskNodeId,
        origin: node.origin,
      });
      const constNode = createSemanticNode({
        id: constNodeId,
        blockId: node.blockId,
        kind: 'const',
        inputs: [],
        outputs: [constValueId],
        attributes: { value: '31' },
        origin: node.origin,
        sourceEffectIds: [effectId],
        completeness: 'complete',
        metadata: { mnemonic: `${bundle.mnemonic}:shift-count-mask` },
      });
      const maskNode = createSemanticNode({
        id: maskNodeId,
        blockId: node.blockId,
        kind: 'binary',
        inputs: [node.inputs[1], constValueId],
        outputs: [maskValueId],
        operator: 'and',
        origin: node.origin,
        sourceEffectIds: [effectId],
        completeness: 'complete',
        metadata: { mnemonic: `${bundle.mnemonic}:shift-count-mask` },
      });
      insertedByShift.set(node.id, { before: [constNode, maskNode], replacement: { ...node, inputs: [node.inputs[0], maskValueId] } });
      addedValues.push(constValue, maskValue);
    }
  }
  if (matched.size !== shiftEffects.size) throw new TypeError('managed-bridge-i32-shift-node-missing');
  if (!insertedByShift.size) return lowered;

  const nodes = [];
  for (const node of old.nodes) {
    const insertion = insertedByShift.get(node.id);
    if (!insertion) nodes.push(node);
    else nodes.push(...insertion.before, insertion.replacement);
  }
  const blocks = old.blocks.map((block) => {
    const nodeIds = [];
    for (const nodeId of block.nodeIds) {
      const insertion = insertedByShift.get(nodeId);
      if (!insertion) nodeIds.push(nodeId);
      else nodeIds.push(...insertion.before.map((entry) => entry.id), nodeId);
    }
    return { ...block, nodeIds };
  });
  const semanticIr = createSemanticIrFunction({ ...old, nodes, blocks, values: [...old.values, ...addedValues] }, options);
  return deepFreeze({ ...lowered, semanticIr, ssa: buildSemanticSsa(semanticIr, lowered.cfg, options) });
}
