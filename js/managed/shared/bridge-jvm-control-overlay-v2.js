import { deepFreeze } from '../../core/identity/index.js';
import { createSemanticIrFunction } from '../../semantics/ir/function.js';
import { buildSemanticSsa } from '../../semantics/ssa/build.js';

const PREDICATES = new Set(['eq', 'ne', 'lt', 'ge', 'gt', 'le']);
const OPERATORS = Object.freeze({
  eq: 'eq',
  ne: 'ne',
  lt: 'slt',
  ge: 'sge',
  gt: 'sgt',
  le: 'sle',
});

function normalizeJvmBranchCondition(control, inputCount) {
  const condition = control?.condition;
  if (!condition || condition.kind !== 'integer-comparison') return null;
  const predicate = typeof condition.predicate === 'string' ? condition.predicate.toLowerCase() : '';
  if (!PREDICATES.has(predicate)) return null;
  if (condition.signed !== true || condition.widthBits !== 32) return null;
  if (condition.arity !== 1 && condition.arity !== 2) return null;
  if (condition.arity !== inputCount) return null;
  if ((condition.arity === 1) !== (condition.compareToZero === true)) return null;
  if (condition.arity === 2 && condition.compareToZero !== false) return null;
  return { predicate, operator: OPERATORS[predicate], arity: condition.arity };
}

function partialBranch(node) {
  return {
    ...node,
    completeness: 'partial',
    unknown: {
      reason: 'jvm-branch-predicate-unresolved',
      categories: ['control'],
    },
  };
}

function ownershipFailure() {
  throw new TypeError('jvm-control-overlay-block-node-owner-invalid');
}

function buildBlocksFromOriginalOrder(old, nodes, additionsBefore, replacements) {
  const originalNodeById = new Map();
  for (const node of old.nodes) {
    if (!node || typeof node.id !== 'string' || originalNodeById.has(node.id)) ownershipFailure();
    originalNodeById.set(node.id, node);
  }

  const transformedNodeById = new Map();
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || transformedNodeById.has(node.id)) ownershipFailure();
    transformedNodeById.set(node.id, node);
  }

  for (const [originalNodeId, additions] of additionsBefore) {
    const original = originalNodeById.get(originalNodeId);
    if (!original || !Array.isArray(additions)) ownershipFailure();
    for (const addition of additions) {
      if (!addition || addition.blockId !== original.blockId
          || transformedNodeById.get(addition.id) !== addition) {
        ownershipFailure();
      }
    }
  }
  for (const originalNodeId of replacements.keys()) {
    if (!originalNodeById.has(originalNodeId)) ownershipFailure();
  }

  const placedOriginalNodeIds = new Set();
  const placedTransformedNodeIds = new Set();
  const blocks = old.blocks.map((block) => {
    if (!Array.isArray(block.nodeIds)) {
      throw new TypeError('jvm-control-overlay-block-order-missing');
    }
    const nodeIds = [];
    for (const originalNodeId of block.nodeIds) {
      if (typeof originalNodeId !== 'string' || placedOriginalNodeIds.has(originalNodeId)) {
        throw new TypeError('jvm-control-overlay-block-node-identity-invalid');
      }
      const original = originalNodeById.get(originalNodeId);
      if (!original || original.blockId !== block.id) ownershipFailure();
      placedOriginalNodeIds.add(originalNodeId);

      for (const addition of additionsBefore.get(originalNodeId) ?? []) {
        if (placedTransformedNodeIds.has(addition.id)) ownershipFailure();
        placedTransformedNodeIds.add(addition.id);
        nodeIds.push(addition.id);
      }

      const replacement = replacements.get(originalNodeId) ?? original;
      if (!replacement || replacement.blockId !== block.id
          || transformedNodeById.get(replacement.id) !== replacement
          || placedTransformedNodeIds.has(replacement.id)) {
        ownershipFailure();
      }
      placedTransformedNodeIds.add(replacement.id);
      nodeIds.push(replacement.id);
    }
    return { ...block, nodeIds };
  });

  if (placedOriginalNodeIds.size !== old.nodes.length
      || placedTransformedNodeIds.size !== nodes.length) ownershipFailure();
  return blocks;
}

export function overlayJvmControlLowering(fn, lowered, options = {}) {
  if (fn?.frontendId !== 'jvm') return lowered;
  const old = lowered.semanticIr;
  const bundleByEffect = new Map((fn.bundles ?? []).map((bundle) => [bundle.operationId, bundle]));
  const additionsBefore = new Map();
  const replacements = new Map();
  const addedValues = [];
  let unresolved = false;

  for (const node of old.nodes) {
    if (node.kind !== 'conditional-branch') continue;
    const effectId = node.sourceEffectIds?.find((id) => bundleByEffect.has(id));
    const bundle = effectId == null ? null : bundleByEffect.get(effectId);
    // Branches whose predicate was already materialized as a compare node
    // during lowering carry comparisonArity 2 with a single predicate input;
    // the overlay must not demote them for lacking raw-operand
    // integer-comparison arity agreement (#8917).
    if (node.inputs.length === 1 && node.attributes?.comparisonArity === 2) continue;
    const control = bundle?.controlEffects?.find((effect) => effect?.kind === 'conditional-branch') ?? null;
    const condition = normalizeJvmBranchCondition(control, node.inputs.length);
    if (!condition) {
      unresolved = true;
      replacements.set(node.id, partialBranch(node));
      continue;
    }

    const before = [];
    const compareInputs = [...node.inputs];
    if (condition.arity === 1) {
      const zeroNodeId = `${node.id}:jvm-zero`;
      const zeroValueId = `${zeroNodeId}:value`;
      before.push({
        id: zeroNodeId,
        kind: 'const',
        blockId: node.blockId,
        inputs: [],
        outputs: [zeroValueId],
        operator: null,
        variable: null,
        memory: null,
        call: null,
        intrinsic: null,
        targets: [],
        attributes: { value: 0, widthBits: 32 },
        unknown: null,
        completeness: 'complete',
        sourceEffectIds: [...node.sourceEffectIds],
        origin: node.origin,
        metadata: { constant: '0', mnemonic: 'jvm-branch-zero' },
      });
      addedValues.push({
        id: zeroValueId,
        kind: 'definition',
        machineType: { kind: 'bitvector', widthBits: 32 },
        definitionNodeId: zeroNodeId,
        origin: node.origin,
        metadata: { constant: '0' },
      });
      compareInputs.push(zeroValueId);
    }

    const compareNodeId = `${node.id}:jvm-condition`;
    const predicateValueId = `${compareNodeId}:value`;
    before.push({
      id: compareNodeId,
      kind: 'compare',
      blockId: node.blockId,
      inputs: compareInputs,
      outputs: [predicateValueId],
      operator: condition.operator,
      variable: null,
      memory: null,
      call: null,
      intrinsic: null,
      targets: [],
      attributes: {
        predicate: condition.predicate,
        signed: true,
        widthBits: 32,
      },
      unknown: null,
      completeness: 'complete',
      sourceEffectIds: [...node.sourceEffectIds],
      origin: node.origin,
      metadata: { mnemonic: `jvm-branch-${condition.predicate}` },
    });
    addedValues.push({
      id: predicateValueId,
      kind: 'definition',
      machineType: { kind: 'predicate', widthBits: 1 },
      definitionNodeId: compareNodeId,
      origin: node.origin,
    });
    additionsBefore.set(node.id, before);
    replacements.set(node.id, {
      ...node,
      inputs: [predicateValueId],
      attributes: {
        ...node.attributes,
        conditionCode: condition.predicate,
        predicate: condition.predicate,
        signed: true,
        comparisonArity: condition.arity,
        compareToZero: condition.arity === 1,
        machineControlEffect: control,
      },
    });
  }

  if (!additionsBefore.size && !unresolved) return lowered;

  const nodes = [];
  for (const node of old.nodes) {
    nodes.push(...(additionsBefore.get(node.id) ?? []));
    nodes.push(replacements.get(node.id) ?? node);
  }
  const blocks = buildBlocksFromOriginalOrder(old, nodes, additionsBefore, replacements);
  const unknowns = unresolved
    ? [...(old.unknowns ?? []), { reason: 'jvm-branch-predicate-unresolved', categories: ['control'] }]
    : old.unknowns;
  const semanticIr = createSemanticIrFunction({
    ...old,
    blocks,
    nodes,
    values: [...old.values, ...addedValues],
    completeness: unresolved ? 'partial' : old.completeness,
    unknowns,
  }, options);
  return deepFreeze({
    ...lowered,
    semanticIr,
    ssa: buildSemanticSsa(semanticIr, lowered.cfg, options),
  });
}