import { deepFreeze } from '../../core/identity/index.js';
import { createSemanticIrFunction } from '../../semantics/ir/function.js';
import { buildSemanticSsa } from '../../semantics/ssa/build.js';

/*
 * #8842 — the shared managed-bridge lowering core classifies a JVM node by
 * substring-matching the mnemonic, and two JVM local-state families are wrong
 * at the canonical Semantic IR boundary:
 *
 *   1. Every `istore/lstore/fstore/dstore/astore` mnemonic contains the
 *      substring "or", so the core emits a spurious `binary operator:"or"`
 *      node (zero outputs) beside the correct `state-write`. That fake, complete
 *      OR operation is unrelated to the value the local actually receives.
 *   2. `iinc index,const` is a local increment (`local = local + const`), but
 *      the lifter publishes the immediate as the bundle's only produced value,
 *      so the core lowers the local update to a `copy` of that constant — the
 *      read of the old local value is discarded and the increment is lost.
 *
 * Following the sanctioned overlay idiom (see bridge-dex-overlay-v2.js), this
 * post-pass drops the spurious store binary nodes and rebuilds the `iinc` update
 * as `add(oldLocalRead, const)`, then revalidates and rebuilds SSA. Bundles that
 * do not match these two families are returned byte-for-byte unchanged.
 */

const JVM_STORE_MNEMONIC = /^(?:i|l|f|d|a)store(?:_[0-3])?$/;

function bitvector(widthBits) {
  return { kind: 'bitvector', widthBits };
}

function widthOf(machineType) {
  const bits = Number(machineType?.widthBits);
  return Number.isSafeInteger(bits) && bits > 0 ? bits : 32;
}

export function overlayJvmLocalLowering(fn, lowered, options = {}) {
  if (fn?.frontendId !== 'jvm') return lowered;
  const old = lowered?.semanticIr;
  if (!old) return lowered;

  const valueById = new Map(old.values.map((value) => [value.id, { ...value }]));
  const nodesById = new Map(old.nodes.map((node) => [node.id, { ...node }]));
  const addedNodes = [];
  const insertBefore = new Map();
  const removedNodeIds = new Set();
  let changed = false;

  for (const bundle of fn.bundles ?? []) {
    const effectId = bundle.operationId;
    if (bundle.mnemonic === 'iinc') {
      const primary = old.nodes.find((node) => (
        node.kind === 'copy'
        && (node.sourceEffectIds || []).includes(effectId)
        && node.inputs.length === 1
        && node.outputs.length === 1
      ));
      if (!primary) continue;
      const immediate = bundle.producedValues?.[0]?.constant;
      if (immediate == null) continue;
      const resultValueId = primary.outputs[0];
      const resultValue = valueById.get(resultValueId);
      if (!resultValue || resultValue.metadata?.constant == null) continue;
      const width = widthOf(resultValue.machineType);
      const node = nodesById.get(primary.id);
      const oldLocalValueId = node.inputs[0];
      const constNodeId = `${node.id}:iinc-imm`;
      const constValueId = `${constNodeId}:value`;
      addedNodes.push({
        id: constNodeId,
        kind: 'const',
        blockId: node.blockId,
        inputs: [],
        outputs: [constValueId],
        operator: null,
        variable: null,
        memory: null,
        call: null,
        intrinsic: null,
        targets: [],
        attributes: { value: String(immediate) },
        unknown: null,
        completeness: 'complete',
        sourceEffectIds: [effectId],
        origin: node.origin,
      });
      valueById.set(constValueId, {
        id: constValueId,
        kind: 'definition',
        machineType: bitvector(width),
        definitionNodeId: constNodeId,
        sourceEntityId: null,
        variableKey: null,
        origin: node.origin,
        metadata: { constant: String(immediate) },
      });
      resultValue.machineType = bitvector(width);
      delete resultValue.metadata;
      node.kind = 'binary';
      node.operator = 'add';
      node.inputs = [oldLocalValueId, constValueId];
      node.attributes = {};
      insertBefore.set(node.id, [constNodeId]);
      changed = true;
      continue;
    }

    if (JVM_STORE_MNEMONIC.test(String(bundle.mnemonic ?? ''))) {
      const spurious = old.nodes.find((node) => (
        node.kind === 'binary'
        && node.operator === 'or'
        && node.outputs.length === 0
        && (node.sourceEffectIds || []).includes(effectId)
      ));
      if (spurious) {
        removedNodeIds.add(spurious.id);
        changed = true;
      }
    }
  }

  if (!changed) return lowered;

  for (const id of removedNodeIds) nodesById.delete(id);
  for (const node of addedNodes) nodesById.set(node.id, node);
  const nodes = [...nodesById.values()];
  const blocks = old.blocks.map((block) => ({
    ...block,
    nodeIds: block.nodeIds.flatMap((id) => (
      removedNodeIds.has(id) ? [] : [...(insertBefore.get(id) ?? []), id]
    )),
  }));
  const referencedValueIds = new Set(nodes.flatMap((node) => [...(node.inputs || []), ...(node.outputs || [])]));
  const values = [...valueById.values()].filter((value) => referencedValueIds.has(value.id) || value.kind !== 'definition');
  const allComplete = nodes.every((node) => node.completeness === 'complete');
  const completeness = (
    fn.aggregateCompleteness === 'exact'
    && (old.unknowns ?? []).length === 0
    && allComplete
  ) ? 'complete' : old.completeness;
  const semanticIr = createSemanticIrFunction({ ...old, blocks, nodes, values, completeness }, options);
  return deepFreeze({ ...lowered, semanticIr, ssa: buildSemanticSsa(semanticIr, lowered.cfg, options) });
}
