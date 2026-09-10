import { stableStringify } from '../../core/identity/index.js';
import { analyzeSemanticDominance, createSemanticCfg } from '../cfg/index.js';
import { createSemanticIrFunction } from '../ir/function.js';
import { createSemanticSsaContract } from './contract.js';

const DEFAULT_MAX_WORK_ITEMS = 4194304;

function fail(code) { throw new TypeError(code); }
function positiveInteger(value, code) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}
function maxWorkItems(options) {
  return options?.budget?.maxWorkItems == null ? DEFAULT_MAX_WORK_ITEMS : positiveInteger(options.budget.maxWorkItems, 'semantic-ssa-invalid-budget-maxWorkItems');
}
function workCounter(options) {
  let used = 0;
  const maximum = maxWorkItems(options);
  return () => {
    assertNotAborted(options);
    if (++used > maximum) fail('semantic-ssa-budget-exceeded-maxWorkItems');
  };
}
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('semantic-ssa-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
function originHasContent(origin) {
  return origin && (origin.byteRanges?.length || origin.virtualRanges?.length || origin.instructionIds?.length
    || origin.operationIds?.length || origin.sourceLocations?.length || origin.parentEntityIds?.length || origin.transforms?.length);
}
function hasProducedTransform(entity, producedId) {
  return entity.origin?.transforms?.some((transform) => transform.passId === 'semantic-ssa'
    && transform.producedEntityIds.includes(producedId));
}
function originContains(container, required) {
  for (const key of ['byteRanges', 'virtualRanges', 'instructionIds', 'operationIds', 'sourceLocations', 'parentEntityIds']) {
    const have = new Set((container?.[key] ?? []).map((item) => stableStringify(item)));
    for (const item of required?.[key] ?? []) if (!have.has(stableStringify(item))) return false;
  }
  return true;
}
function blockSetEqual(ir, cfg) {
  return stableStringify(ir.blocks.map((block) => block.id).sort()) === stableStringify(cfg.blocks.map((block) => block.id).sort());
}
const CONTROL_PROJECTION_KINDS = new Set(['branch', 'conditional-branch', 'switch', 'return', 'trap', 'unknown-control-effect', 'incomplete']);
const UNKNOWN_CONTROL_EDGE_KINDS = new Set(['indirect-candidate', 'unknown']);

function isControlProjectionNode(node) {
  return CONTROL_PROJECTION_KINDS.has(node?.kind)
    && (node.kind !== 'incomplete' || node.unknown?.categories?.includes('control'));
}

function controlProjectionNode(block, nodesById) {
  let control = null;
  for (const nodeId of block.nodeIds) {
    const node = nodesById.get(nodeId);
    if (isControlProjectionNode(node)) control = node;
  }
  return control;
}

function projectionEdgeKey(to, kind) { return `${to}\u0000${kind}`; }
function sortedProjectionEdges(edges) {
  return [...new Set(edges.map((edge) => projectionEdgeKey(edge.to, edge.kind)))].sort();
}

function projectedControlEdges(node) {
  if (node.kind === 'branch') return node.targets.map((to) => ({ to, kind: 'branch' }));
  if (node.kind === 'conditional-branch') {
    return node.targets.map((to, index) => ({ to, kind: index === 0 ? 'conditional-true' : 'conditional-false' }));
  }
  if (node.kind === 'switch') return node.targets.map((to) => ({ to, kind: 'switch-case' }));
  if (node.kind === 'unknown-control-effect' || node.kind === 'incomplete') {
    const kind = node.attributes?.indirectControl?.targetState === 'candidate' ? 'indirect-candidate' : 'unknown';
    return node.targets.map((to) => ({ to, kind }));
  }
  return [];
}

function validateControlProjection(ir, cfg) {
  const nodesById = new Map(ir.nodes.map((node) => [node.id, node]));
  const cfgById = new Map(cfg.blocks.map((block) => [block.id, block]));
  for (const irBlock of ir.blocks) {
    const node = controlProjectionNode(irBlock, nodesById);
    if (!node) continue;
    const cfgBlock = cfgById.get(irBlock.id);
    const successors = cfgBlock.successors;
    if ((node.kind === 'unknown-control-effect' || node.kind === 'incomplete') && node.targets.length === 0) {
      if (successors.some((edge) => !UNKNOWN_CONTROL_EDGE_KINDS.has(edge.kind))) fail('semantic-ssa-control-flow-mismatch');
      continue;
    }
    if (node.kind === 'switch') {
      const expectedTargets = node.targets.slice().sort();
      const actualTargets = [...new Set(successors.map((edge) => edge.to))].sort();
      if (stableStringify(expectedTargets) !== stableStringify(actualTargets)
        || successors.some((edge) => !['switch-case', 'switch-default'].includes(edge.kind))) {
        fail('semantic-ssa-control-flow-mismatch');
      }
      continue;
    }
    if (node.kind === 'conditional-branch' && node.targets.length === 1) {
      const target = node.targets[0];
      if (successors.length === 0 || successors.some((edge) => edge.to !== target
        || !['conditional-true', 'conditional-false', 'fallthrough'].includes(edge.kind))) {
        fail('semantic-ssa-control-flow-mismatch');
      }
      continue;
    }
    const comparableSuccessors = node.kind === 'conditional-branch'
      ? successors.filter((edge) => edge.kind !== 'fallthrough')
      : successors;
    if (node.kind === 'conditional-branch'
      && successors.some((edge) => edge.kind === 'fallthrough' && !node.targets.includes(edge.to))) {
      fail('semantic-ssa-control-flow-mismatch');
    }
    if (stableStringify(sortedProjectionEdges(projectedControlEdges(node))) !== stableStringify(sortedProjectionEdges(comparableSuccessors))) {
      fail('semantic-ssa-control-flow-mismatch');
    }
  }
}

function computeExpectedPhiBlocks(variableKey, definitions, dominance, tick) {
  const reachable = new Set(dominance.reachable);
  const defBlocks = new Set(definitions
    .filter((definition) => definition.variableKey === variableKey && definition.kind !== 'phi' && definition.blockId != null && reachable.has(definition.blockId))
    .map((definition) => definition.blockId));
  const expected = new Set();
  const pending = [...defBlocks].sort();
  const queued = new Set(pending);
  while (pending.length) {
    tick();
    const blockId = pending.shift();
    for (const frontierId of dominance.dominanceFrontier[blockId] ?? []) {
      tick();
      if (!reachable.has(frontierId) || frontierId === dominance.reversePostOrder[0] || expected.has(frontierId)) continue;
      expected.add(frontierId);
      if (!defBlocks.has(frontierId) && !queued.has(frontierId)) {
        queued.add(frontierId);
        pending.push(frontierId);
        pending.sort();
      }
    }
  }
  return expected;
}

export function validateSemanticSsa(ssaInput, irInput, cfgInput, options = {}) {
  assertNotAborted(options);
  const tick = workCounter(options);
  const ir = createSemanticIrFunction(irInput, { signal: options.signal, ...(options.irOptions ?? {}) });
  const cfg = createSemanticCfg(cfgInput, { signal: options.signal, ...(options.cfgOptions ?? {}) });
  if (ir.functionId !== cfg.functionId) fail('semantic-ssa-function-mismatch');
  if (ir.entryBlockId !== cfg.entryBlockId) fail('semantic-ssa-entry-block-mismatch');
  if (!blockSetEqual(ir, cfg)) fail('semantic-ssa-block-set-mismatch');
  validateControlProjection(ir, cfg);
  const entry = cfg.blocks.find((block) => block.id === cfg.entryBlockId);
  if (entry.predecessors.length) fail('semantic-ssa-entry-has-predecessors');
  const ssa = createSemanticSsaContract({
    contractVersion: ssaInput.contractVersion,
    functionId: ssaInput.functionId,
    definitions: ssaInput.definitions,
    uses: ssaInput.uses,
  }, { cfg, signal: options.signal, budget: options.budget });
  if (ssa.functionId !== ir.functionId) fail('semantic-ssa-function-mismatch');

  const dominance = analyzeSemanticDominance(cfg, { signal: options.signal, budget: { maxWorkItems: maxWorkItems(options) }, ...(options.dominanceOptions ?? {}) });
  const cfgById = new Map(cfg.blocks.map((block) => [block.id, block]));
  const irByBlock = new Map(ir.blocks.map((block) => [block.id, block]));
  const nodePosition = new Map();
  for (const block of ir.blocks) for (let index = 0; index < block.nodeIds.length; index++) { tick(); nodePosition.set(block.nodeIds[index], { blockId: block.id, index }); }
  const definitionByValue = new Map(ssa.definitions.map((definition) => [definition.valueId, definition]));

  for (const definition of ssa.definitions) {
    tick();
    if (!originHasContent(definition.origin)) fail('semantic-ssa-empty-definition-origin');
    if (!definition.proof || definition.proof.passId !== 'semantic-ssa' || !Object.hasOwn(definition.proof, 'machineType')) fail('semantic-ssa-definition-proof-required');
    if (!hasProducedTransform(definition, definition.valueId)) fail('semantic-ssa-definition-transform-required');
    if (definition.kind === 'phi') {
      if (!definition.origin.parentEntityIds.includes(definition.blockId)) fail('semantic-ssa-phi-merge-origin-required');
      for (const incoming of definition.incoming) {
        tick();
        const incomingDef = definitionByValue.get(incoming.valueId);
        if (!incomingDef) fail('semantic-ssa-dangling-phi-value-id');
        if (stableStringify(incomingDef.proof?.machineType ?? null) !== stableStringify(definition.proof.machineType ?? null)) fail('semantic-ssa-phi-type-mismatch');
        if (!originContains(definition.origin, incomingDef.origin)) fail('semantic-ssa-phi-origin-incomplete');
        const predecessor = incoming.predecessorBlockId;
        if (incomingDef.blockId == null || !(dominance.dominators[predecessor] ?? []).includes(incomingDef.blockId)) {
          fail('semantic-ssa-phi-incoming-not-dominating-predecessor');
        }
      }
    }
  }

  for (const use of ssa.uses) {
    tick();
    if (!originHasContent(use.origin)) fail('semantic-ssa-empty-use-origin');
    if (!use.proof || use.proof.passId !== 'semantic-ssa' || !Object.hasOwn(use.proof, 'machineType')) fail('semantic-ssa-use-proof-required');
    if (!hasProducedTransform(use, use.useId)) fail('semantic-ssa-use-transform-required');
    const definition = definitionByValue.get(use.valueId);
    if (!definition) fail('semantic-ssa-dangling-value-id');
    if (stableStringify(definition.proof?.machineType ?? null) !== stableStringify(use.proof.machineType ?? null)) fail('semantic-ssa-use-type-mismatch');
    if (definition.blockId == null || use.blockId == null || !(dominance.dominators[use.blockId] ?? []).includes(definition.blockId)) {
      fail('semantic-ssa-definition-does-not-dominate-use');
    }
    if (definition.blockId === use.blockId && definition.kind !== 'phi' && !['entry', 'undef'].includes(definition.kind)) {
      const defPos = nodePosition.get(definition.proof?.sourceDefinitionNodeId ?? definition.sourceEntityId);
      const usePos = nodePosition.get(use.sourceEntityId);
      if (defPos && usePos && defPos.blockId === usePos.blockId && defPos.index >= usePos.index) fail('semantic-ssa-definition-after-use');
    }
  }

  const variableKeys = [...new Set(ssa.definitions.map((definition) => definition.variableKey).filter(Boolean))].sort();
  for (const variableKey of variableKeys) {
    tick();
    const expected = [...computeExpectedPhiBlocks(variableKey, ssa.definitions, dominance, tick)].sort();
    const actual = ssa.definitions.filter((definition) => definition.kind === 'phi' && definition.variableKey === variableKey).map((definition) => definition.blockId).sort();
    if (stableStringify(expected) !== stableStringify(actual)) fail('semantic-ssa-phi-placement-mismatch');
    const typeKeys = new Set(ssa.definitions.filter((definition) => definition.variableKey === variableKey).map((definition) => stableStringify(definition.proof?.machineType ?? null)));
    if (typeKeys.size > 1) fail('semantic-ssa-variable-type-collision');
  }

  for (const definition of ssa.definitions.filter((item) => item.kind === 'phi')) {
    tick();
    const predecessors = cfgById.get(definition.blockId).predecessors;
    const incoming = definition.incoming.map((item) => item.predecessorBlockId).sort();
    if (stableStringify(predecessors) !== stableStringify(incoming)) fail('semantic-ssa-phi-predecessor-set-incomplete');
    if (!irByBlock.has(definition.blockId)) fail('semantic-ssa-phi-block-not-in-ir');
  }
  return ssa;
}

export const assertSemanticSsaValid = validateSemanticSsa;
