import { deepFreeze, stableStringify } from '../../core/identity/index.js';
import { createOriginSet } from '../../core/identity/origin.js';
import {
  SEMANTIC_IR_CONTRACT_VERSION,
  SEMANTIC_IR_SCHEMA_VERSION,
  SEMANTIC_SETS,
  array,
  assertAllowedKeys,
  assertNotAborted,
  assertWithinBudget,
  enumValue,
  fail,
  nonEmpty,
  object,
  requiredOrigin,
  serializable,
  sortedUniqueStrings,
  uniqueStrings,
} from './common.js';
import { createSemanticNode, createSemanticValue } from './nodes.js';

function normalizeBlock(input) {
  input = object(input, 'semantic-ir-invalid-block');
  assertAllowedKeys(input, new Set(['id', 'nodeIds', 'origin']), 'semantic-ir-unexpected-block-field');
  const out = {
    id: nonEmpty(input.id, 'semantic-ir-block-id-required'),
    nodeIds: uniqueStrings(input.nodeIds ?? [], 'semantic-ir-invalid-block-node-ids', false),
  };
  if (Object.hasOwn(input, 'origin')) out.origin = createOriginSet(input.origin);
  return deepFreeze(out);
}

function normalizeFunctionUnknown(input) {
  input = object(input, 'semantic-ir-invalid-function-unknown');
  assertAllowedKeys(input, new Set(['reason', 'categories', 'detail']), 'semantic-ir-unexpected-function-unknown-field');
  const out = {
    reason: nonEmpty(input.reason, 'semantic-ir-function-unknown-reason-required'),
    categories: sortedUniqueStrings(input.categories ?? [], 'semantic-ir-invalid-function-unknown-categories'),
  };
  if (input.detail != null) out.detail = serializable(input.detail, 'semantic-ir-invalid-function-unknown-detail');
  return out;
}

function assertVersion(input) {
  if (input.schemaVersion != null && Number(input.schemaVersion) !== SEMANTIC_IR_SCHEMA_VERSION) fail('semantic-ir-schema-version-mismatch');
  if (input.contractVersion != null && String(input.contractVersion) !== SEMANTIC_IR_CONTRACT_VERSION) fail('semantic-ir-contract-version-mismatch');
}

const REFERENCE_COUNT_OVERFLOW = Number.MAX_SAFE_INTEGER + 1;

function addReferenceCount(total, amount) {
  if (total === REFERENCE_COUNT_OVERFLOW
    || !Number.isSafeInteger(total)
    || total < 0
    || !Number.isSafeInteger(amount)
    || amount < 0
    || total > Number.MAX_SAFE_INTEGER - amount) {
    return REFERENCE_COUNT_OVERFLOW;
  }
  return total + amount;
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

// Cache every raw object/collection read used by the reference preflight. This
// keeps accessor-backed nested summaries and scopes identical when the same
// inputs are normalized after the preflight. The cache is lazy, so the
// preflight still reads collection lengths without enumerating their elements.
function needsReferenceClone(value) {
  if (Array.isArray(value)) return false;
  return Reflect.ownKeys(value).some((property) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
    return descriptor && 'value' in descriptor
      && descriptor.configurable === false
      && descriptor.writable === false
      && descriptor.value !== null
      && typeof descriptor.value === 'object';
  });
}

function cloneReferenceTarget(value) {
  const target = Object.create(Object.getPrototypeOf(value));
  for (const property of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
    if (!descriptor) continue;
    if ('value' in descriptor) {
      Object.defineProperty(target, property, {
        configurable: true,
        enumerable: descriptor.enumerable,
        writable: true,
        value: descriptor.value,
      });
    } else {
      Object.defineProperty(target, property, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set: descriptor.set,
      });
    }
  }
  return target;
}

function cacheReferenceReads(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object'
    || ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date) return value;
  const cached = seen.get(value);
  if (cached) return cached;
  const target = needsReferenceClone(value) ? cloneReferenceTarget(value) : value;
  const reads = new Map();
  const proxy = new Proxy(target, {
    get(proxyTarget, property, receiver) {
      if (reads.has(property)) return reads.get(property);
      const result = Reflect.get(proxyTarget, property, receiver);
      const descriptor = Reflect.getOwnPropertyDescriptor(proxyTarget, property);
      if (descriptor && 'value' in descriptor && descriptor.configurable === false && descriptor.writable === false) {
        // Frozen arrays cannot return a nested proxy through the invariant-protected slot.
        // Cache the nested view by raw identity and return the required raw value.
        cacheReferenceReads(result, seen);
        reads.set(property, result);
        return result;
      }
      const captured = cacheReferenceReads(result, seen);
      reads.set(property, captured);
      return captured;
    },
  });
  seen.set(value, proxy);
  seen.set(proxy, proxy);
  return proxy;
}

// Every collection that can carry a reference or bounded work item is part of
// the maxReferences denominator. Raw lengths are a conservative upper bound
// because normalization only deduplicates/sorts or maps one item to one item.
function summaryReferenceCount(summary, seen) {
  if (!summary || typeof summary !== 'object') return 0;
  summary = seen ? cacheReferenceReads(summary, seen) : summary;
  let count = 0;
  for (const key of [
    'targetValueIds', 'targetEntityIds', 'arguments', 'returns',
    'inputs', 'outputs', 'stateReads', 'stateWrites', 'controlEffects',
  ]) {
    count = addReferenceCount(count, arrayLength(summary[key]));
  }
  for (const scope of [summary.memoryRead, summary.memoryWrite]) {
    if (!scope || typeof scope !== 'object') continue;
    count = addReferenceCount(count, arrayLength(scope.accesses));
    count = addReferenceCount(count, arrayLength(scope.addressSpaces));
  }
  if (summary.unknownEffects && typeof summary.unknownEffects === 'object') {
    count = addReferenceCount(count, arrayLength(summary.unknownEffects.categories));
  }
  return count;
}

function countReferences(nodes, values, blocks) {
  let count = 0;
  for (const node of nodes) {
    for (const key of ['inputs', 'outputs', 'targets', 'sourceEffectIds']) {
      count = addReferenceCount(count, arrayLength(node[key]));
    }
    if (node.memory) count = addReferenceCount(count, 1);
    count = addReferenceCount(count, summaryReferenceCount(node.call));
    count = addReferenceCount(count, summaryReferenceCount(node.intrinsic));
  }
  for (const block of blocks) count = addReferenceCount(count, arrayLength(block.nodeIds));
  for (const value of values) {
    if (value.definitionNodeId != null) count = addReferenceCount(count, 1);
  }
  return count;
}

// Fail-closed raw-input preflight (#5858): reject the full raw denominator
// before nested collections are normalized, sorted, deduplicated, frozen, or
// serialized. Invalid objects still fail through the normal validators; an
// overflow sentinel rejects even when arithmetic cannot remain safe.
function countRawReferences(blocks, values, nodes, seen) {
  let count = 0;
  for (const block of blocks) {
    const blockView = cacheReferenceReads(object(block, 'semantic-ir-invalid-block'), seen);
    count = addReferenceCount(count, arrayLength(blockView.nodeIds));
  }
  for (const value of values) {
    const valueView = cacheReferenceReads(object(value, 'semantic-ir-invalid-value'), seen);
    if (valueView.definitionNodeId != null) count = addReferenceCount(count, 1);
  }
  for (const node of nodes) {
    const nodeView = cacheReferenceReads(object(node, 'semantic-ir-invalid-node'), seen);
    for (const key of ['inputs', 'outputs', 'targets', 'sourceEffectIds']) {
      count = addReferenceCount(count, arrayLength(nodeView[key]));
    }
    if (nodeView.memory != null) count = addReferenceCount(count, 1);
    count = addReferenceCount(count, summaryReferenceCount(nodeView.call, seen));
    count = addReferenceCount(count, summaryReferenceCount(nodeView.intrinsic, seen));
  }
  return count;
}

function validateNormalizedFunction(out, options) {
  assertNotAborted(options);
  const blockById = new Map();
  for (const block of out.blocks) {
    if (blockById.has(block.id)) fail('semantic-ir-duplicate-block-id');
    blockById.set(block.id, block);
  }
  if (!blockById.has(out.entryBlockId)) fail('semantic-ir-invalid-entry-block');

  const valueById = new Map();
  for (const value of out.values) {
    assertNotAborted(options);
    if (valueById.has(value.id)) fail('semantic-ir-duplicate-value-id');
    valueById.set(value.id, value);
  }

  const nodeById = new Map();
  for (const node of out.nodes) {
    assertNotAborted(options);
    if (nodeById.has(node.id)) fail('semantic-ir-duplicate-entity-id');
    nodeById.set(node.id, node);
    if (!blockById.has(node.blockId)) fail('semantic-ir-node-invalid-block');
  }

  const placedNodes = new Set();
  for (const block of out.blocks) {
    for (const nodeId of block.nodeIds) {
      const node = nodeById.get(nodeId);
      if (!node) fail('semantic-ir-block-dangling-node');
      if (placedNodes.has(nodeId)) fail('semantic-ir-node-in-multiple-blocks');
      if (node.blockId !== block.id) fail('semantic-ir-node-block-mismatch');
      placedNodes.add(nodeId);
    }
  }
  if (placedNodes.size !== out.nodes.length) fail('semantic-ir-unplaced-node');

  for (const node of out.nodes) {
    for (const id of node.inputs) if (!valueById.has(id)) fail('semantic-ir-dangling-value-id');
    for (const id of node.outputs) {
      const value = valueById.get(id);
      if (!value) fail('semantic-ir-dangling-value-id');
      if (value.kind !== 'definition' || value.definitionNodeId !== node.id) fail('semantic-ir-output-definition-mismatch');
    }
    if (node.memory && !valueById.has(node.memory.addressExpr.valueId)) fail('semantic-ir-dangling-address-value-id');
    if (node.call) {
      for (const id of [...node.call.targetValueIds, ...node.call.arguments, ...node.call.returns]) {
        if (!valueById.has(id)) fail('semantic-ir-dangling-call-value-id');
      }
      for (const scope of [node.call.memoryRead, node.call.memoryWrite]) {
        for (const access of scope.accesses ?? []) {
          if (!valueById.has(access.addressExpr.valueId)) fail('semantic-ir-dangling-address-value-id');
        }
      }
    }
    if (node.intrinsic) {
      for (const id of [...node.intrinsic.inputs, ...node.intrinsic.outputs]) {
        if (!valueById.has(id)) fail('semantic-ir-dangling-intrinsic-value-id');
      }
      for (const scope of [node.intrinsic.memoryRead, node.intrinsic.memoryWrite]) {
        for (const access of scope.accesses ?? []) {
          if (!valueById.has(access.addressExpr.valueId)) fail('semantic-ir-dangling-address-value-id');
        }
      }
    }
    for (const target of node.targets) if (!blockById.has(target)) fail('semantic-ir-invalid-control-target');
  }

  for (const value of out.values) {
    if (value.definitionNodeId == null) continue;
    const node = nodeById.get(value.definitionNodeId);
    if (!node || !node.outputs.includes(value.id)) fail('semantic-ir-value-definition-mismatch');
  }

  const hasUnknownNode = out.nodes.some((node) => SEMANTIC_SETS.unknownOperations.has(node.kind) || node.completeness !== 'complete');
  if (out.completeness === 'complete' && (hasUnknownNode || out.unknowns.length)) fail('semantic-ir-completeness-conflict');
  if (out.completeness !== 'complete' && out.unknowns.length === 0) fail('semantic-ir-function-unknowns-required');
}

export function createSemanticIrFunction(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'semantic-ir-invalid-function');
  assertAllowedKeys(input, new Set([
    'schemaVersion', 'contractVersion', 'functionId', 'entryBlockId', 'blocks', 'values', 'nodes',
    'completeness', 'unknowns', 'origin',
  ]), 'semantic-ir-unexpected-function-field');
  assertVersion(input);
  const referenceReads = new WeakMap();
  const rawBlocks = cacheReferenceReads(array(input.blocks, 'semantic-ir-blocks-required'), referenceReads);
  const rawValues = cacheReferenceReads(array(input.values, 'semantic-ir-values-required'), referenceReads);
  const rawNodes = cacheReferenceReads(array(input.nodes, 'semantic-ir-nodes-required'), referenceReads);
  assertWithinBudget(rawBlocks.length, options, 'maxBlocks');
  assertWithinBudget(rawValues.length, options, 'maxValues');
  assertWithinBudget(rawNodes.length, options, 'maxNodes');
  // Preflight the complete reference denominator before nested normalization.
  assertWithinBudget(countRawReferences(rawBlocks, rawValues, rawNodes, referenceReads), options, 'maxReferences');

  const out = {
    schemaVersion: SEMANTIC_IR_SCHEMA_VERSION,
    contractVersion: SEMANTIC_IR_CONTRACT_VERSION,
    functionId: nonEmpty(input.functionId, 'semantic-ir-function-id-required'),
    entryBlockId: nonEmpty(input.entryBlockId, 'semantic-ir-entry-block-required'),
    blocks: rawBlocks.map((block) => normalizeBlock(cacheReferenceReads(block, referenceReads))).sort((a, b) => a.id.localeCompare(b.id)),
    values: rawValues.map((value) => createSemanticValue(cacheReferenceReads(value, referenceReads))).sort((a, b) => a.id.localeCompare(b.id)),
    nodes: rawNodes.map((node) => createSemanticNode(cacheReferenceReads(node, referenceReads))).sort((a, b) => a.id.localeCompare(b.id)),
    completeness: enumValue(input.completeness ?? 'complete', SEMANTIC_SETS.completeness, 'semantic-ir-invalid-function-completeness'),
    unknowns: array(input.unknowns ?? [], 'semantic-ir-invalid-function-unknowns')
      .map(normalizeFunctionUnknown)
      .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
    origin: requiredOrigin(input, 'semantic-ir-function-origin-required'),
  };
  assertWithinBudget(countReferences(out.nodes, out.values, out.blocks), options, 'maxReferences');
  validateNormalizedFunction(out, options);
  return deepFreeze(out);
}

export function validateSemanticIrFunction(input, options = {}) {
  return createSemanticIrFunction(input, options);
}

export function canonicalSerializeSemanticIr(input, options = {}) {
  return stableStringify(createSemanticIrFunction(input, options));
}
