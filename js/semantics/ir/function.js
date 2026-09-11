import { deepFreeze, stableStringify } from '../../core/identity/index.js';
import { isDeeplyFrozenPlainData, isKnownImmutableData, isKnownCanonicalJsonData, ordinaryDataPrototypes, ordinaryJsonBehavior } from '../../core/identity/immutable-data.js';
import { createOriginSet, isReusableOriginSet } from '../../core/identity/origin.js';
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
  positiveInteger,
  requiredOrigin,
  serializableForFrozenOutput,
  sortedUniqueStrings,
  uniqueStrings,
} from './common.js';
import { createSemanticNode, createSemanticValue } from './nodes.js';

// Only this constructor can issue the private normalized-root brand. A frozen
// transport (even an identical one) must go through complete normalization.
const NORMALIZED_FUNCTIONS = new WeakSet();
const SEMANTIC_SET_SNAPSHOTS = Object.values(SEMANTIC_SETS).map((set) => ({ set, values: [...set] }));
const STRING_TRIM = Object.getOwnPropertyDescriptor(String.prototype, 'trim')?.value;
const NUMBER_IS_SAFE_INTEGER = Object.getOwnPropertyDescriptor(Number, 'isSafeInteger')?.value;
const NUMBER_IS_FINITE = Object.getOwnPropertyDescriptor(Number, 'isFinite')?.value;
function ordinaryNormalizationRules() {
  if (Object.getOwnPropertyDescriptor(String.prototype, 'trim')?.value !== STRING_TRIM
    || Object.getOwnPropertyDescriptor(Number, 'isSafeInteger')?.value !== NUMBER_IS_SAFE_INTEGER
    || Object.getOwnPropertyDescriptor(Number, 'isFinite')?.value !== NUMBER_IS_FINITE) return false;
  // Exported enum Sets are mutable despite their frozen containing object.
  // Do not reuse a validation made against different rules or custom methods.
  for (const {set, values} of SEMANTIC_SET_SNAPSHOTS) {
    if (Reflect.ownKeys(set).length || set.size !== values.length) return false;
    for (const value of values) if (!set.has(value)) return false;
  }
  return true;
}

// Private, unchanged field whitelists: allocate once, not per normalized entity.
const ALLOWED_BLOCK = new Set(['id', 'nodeIds', 'origin']);
const ALLOWED_FUNCTION_UNKNOWN = new Set(['reason', 'categories', 'detail']);
const ALLOWED_FUNCTION = new Set([
    'schemaVersion', 'contractVersion', 'functionId', 'entryBlockId', 'blocks', 'values', 'nodes',
    'completeness', 'unknowns', 'origin',
  ]);

function normalizeBlock(input) {
  input = object(input, 'semantic-ir-invalid-block');
  assertAllowedKeys(input, ALLOWED_BLOCK, 'semantic-ir-unexpected-block-field');
  const out = {
    id: nonEmpty(input.id, 'semantic-ir-block-id-required'),
    nodeIds: uniqueStrings(input.nodeIds ?? [], 'semantic-ir-invalid-block-node-ids', false),
  };
  if (Object.hasOwn(input, 'origin')) out.origin = createOriginSet(input.origin);
  return deepFreeze(out);
}

function normalizeFunctionUnknown(input) {
  input = object(input, 'semantic-ir-invalid-function-unknown');
  assertAllowedKeys(input, ALLOWED_FUNCTION_UNKNOWN, 'semantic-ir-unexpected-function-unknown-field');
  const out = {
    reason: nonEmpty(input.reason, 'semantic-ir-function-unknown-reason-required'),
    categories: sortedUniqueStrings(input.categories ?? [], 'semantic-ir-invalid-function-unknown-categories'),
  };
  if (input.detail != null) out.detail = serializableForFrozenOutput(input.detail, 'semantic-ir-invalid-function-unknown-detail');
  return out;
}

function assertVersion(input) {
  const schemaVersion = input.schemaVersion;
  if (schemaVersion != null
      && (typeof schemaVersion !== 'number' || schemaVersion !== SEMANTIC_IR_SCHEMA_VERSION)) {
    fail('semantic-ir-schema-version-mismatch');
  }
  const contractVersion = input.contractVersion;
  if (contractVersion != null
      && (typeof contractVersion !== 'string' || contractVersion !== SEMANTIC_IR_CONTRACT_VERSION)) {
    fail('semantic-ir-contract-version-mismatch');
  }
}

const REFERENCE_COUNT_OVERFLOW = Number.MAX_SAFE_INTEGER + 1;
// These fields are consumed as complete JSON data by serializableForFrozenOutput,
// never as optional reference-bearing summaries. Preserve proxies on the latter.
const SERIALIZABLE_DATA_FIELDS = new Set([
  'metadata', 'attributes', 'detail', 'knownParts', 'physicalIdentity', 'condition', 'controlEffects',
]);

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
  // Only this producer-owned, recursively checked immutable payload is safe
  // to retain. Proxying it would discard the normalizer's ownership brand and
  // copy/normalize the whole provenance tree again for each semantic entity.
  // Caller-owned frozen objects, accessors and mutable children still capture.
  if (isReusableOriginSet(value) || (seen.immutableReads && isKnownImmutableData(value))) return value;
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
      const captured = SERIALIZABLE_DATA_FIELDS.has(property) && isKnownCanonicalJsonData(result)
        && ordinaryJsonBehavior() ? result : cacheReferenceReads(result, seen);
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

function sameStringSequence(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function callInputsMatchNode(node) {
  const argumentInputs = node.call.arguments;
  // An unresolved call with no target or argument summary may still carry
  // opaque generic inputs for conservative accounting. There is no embedded
  // I/O claim to contradict in that shape, so preserve the legacy boundary.
  if (node.call.targetEntityIds.length === 0
    && node.call.targetValueIds.length === 0
    && argumentInputs.length === 0) return true;
  // Direct calls and enriched indirect calls keep the target separate from
  // the ABI argument list; ABI-neutral lowering may also expose the target as
  // the leading generic input. Both are canonical, but no third value may
  // appear in either representation.
  if (sameStringSequence(node.inputs, argumentInputs)) return true;
  return sameStringSequence(node.inputs, [...node.call.targetValueIds, ...argumentInputs]);
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
    if (node.kind === 'zext' || node.kind === 'sext') {
      // Canonical extension type relation (#4576): a zext/sext may exist as a
      // canonical exact operation only when its declared source/target widths
      // equal the machine types on both sides. This is the non-bypassable
      // boundary check; the lowering-side guard stays as defense in depth.
      const fromBits = positiveInteger(node.attributes?.fromBits, 'semantic-ir-extension-width-attributes-required');
      const toBits = positiveInteger(node.attributes?.toBits, 'semantic-ir-extension-width-attributes-required');
      if (toBits < fromBits) fail('semantic-ir-extension-width-relation-invalid');
      if (node.inputs.length !== 1 || node.outputs.length !== 1) fail('semantic-ir-extension-operand-count-invalid');
      const extensionInput = valueById.get(node.inputs[0]);
      const extensionOutput = valueById.get(node.outputs[0]);
      if (!extensionInput || !extensionOutput) fail('semantic-ir-dangling-value-id');
      if (extensionInput.machineType.widthBits !== fromBits) fail('semantic-ir-extension-input-width-mismatch');
      if (extensionOutput.machineType.widthBits !== toBits) fail('semantic-ir-extension-output-width-mismatch');
    }
    if (node.memory && !valueById.has(node.memory.addressExpr.valueId)) fail('semantic-ir-dangling-address-value-id');
    if (node.call) {
      if (!callInputsMatchNode(node)) fail('semantic-ir-call-input-mismatch');
      if (!sameStringSequence(node.outputs, node.call.returns)) fail('semantic-ir-call-output-mismatch');
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
      if (!sameStringSequence(node.inputs, node.intrinsic.inputs)) fail('semantic-ir-intrinsic-input-mismatch');
      if (!sameStringSequence(node.outputs, node.intrinsic.outputs)) fail('semantic-ir-intrinsic-output-mismatch');
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

  // A node-local unknown payload is explicit unknown evidence even on an
  // ordinary node, so it must keep the function from claiming completeness
  // (defense in depth alongside the constructor's own conflict check; #5390).
  const hasUnknownNode = out.nodes.some((node) => SEMANTIC_SETS.unknownOperations.has(node.kind) || node.completeness !== 'complete' || node.unknown != null);
  if (out.completeness === 'complete' && (hasUnknownNode || out.unknowns.length)) fail('semantic-ir-completeness-conflict');
  if (out.completeness !== 'complete' && out.unknowns.length === 0) fail('semantic-ir-function-unknowns-required');
}

function inertReadOptions(options) {
  if (!ordinaryDataPrototypes() || !ordinaryJsonBehavior()) return false;
  // A getter-backed budget/cancellation option may change inherited fields
  // between preflight and normalization. Preserve captured reads in that case.
  // Effectful options always retain the original captured-read path.
  try {
    if (!options || typeof options !== 'object') return false;
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of ['signal', 'budget']) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (descriptor && !Object.hasOwn(descriptor, 'value')) return false;
      const value = descriptor?.value;
      if (value == null) continue;
      if (key === 'signal' || typeof value !== 'object') return false;
      const budgetPrototype = Object.getPrototypeOf(value);
      if (budgetPrototype !== Object.prototype && budgetPrototype !== null) return false;
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (!Object.hasOwn(descriptor, 'value')) return false;
      }
    }
    return true;
  } catch { return false; }
}

export function createSemanticIrFunction(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'semantic-ir-invalid-function');
  assertAllowedKeys(input, ALLOWED_FUNCTION, 'semantic-ir-unexpected-function-field');
  assertVersion(input);
  const referenceReads = new WeakMap();
  // Optional fields may be inherited. Prototype getters must keep the original
  // captured-read behavior even when the input's own data is immutable.
  const inertOptions = inertReadOptions(options);
  referenceReads.immutableReads = isKnownImmutableData(input) && inertOptions;
  const inputBlocks = array(input.blocks, 'semantic-ir-blocks-required');
  const rawBlocks = cacheReferenceReads(inputBlocks, referenceReads);
  const inputValues = array(input.values, 'semantic-ir-values-required');
  const rawValues = cacheReferenceReads(inputValues, referenceReads);
  const inputNodes = array(input.nodes, 'semantic-ir-nodes-required');
  const rawNodes = cacheReferenceReads(inputNodes, referenceReads);
  assertWithinBudget(rawBlocks.length, options, 'maxBlocks');
  assertWithinBudget(rawValues.length, options, 'maxValues');
  assertWithinBudget(rawNodes.length, options, 'maxNodes');
  // Preflight the complete reference denominator before nested normalization.
  assertWithinBudget(countRawReferences(rawBlocks, rawValues, rawNodes, referenceReads), options, 'maxReferences');
  // Caller-owned data retains every captured read, including transparent
  // Proxies that cannot be identified by property-descriptor inspection.
  // Only the producer-owned immutable root can bypass capture above.

  // Re-normalizing this exact private immutable publication cannot change its
  // field values under the unchanged rules. Reuse that normalization only;
  // raw and normalized reference budgets, cancellation and cross-entity
  // validation still run for the current call, not from a cached verdict.
  if (inertOptions && NORMALIZED_FUNCTIONS.has(input)
    && ordinaryDataPrototypes() && ordinaryJsonBehavior() && ordinaryNormalizationRules()) {
    assertWithinBudget(countReferences(input.nodes, input.values, input.blocks), options, 'maxReferences');
    validateNormalizedFunction(input, options);
    // Preserve the constructor's fresh root identity while sharing immutable
    // normalized records. Certifying this shell only visits already known children.
    const reused = Object.freeze({ ...input });
    isDeeplyFrozenPlainData(reused);
    NORMALIZED_FUNCTIONS.add(reused);
    return reused;
  }

  // Fixed UTF-16 code-unit order keeps canonical serialization locale independent (#5765).
  const compareCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const out = {
    schemaVersion: SEMANTIC_IR_SCHEMA_VERSION,
    contractVersion: SEMANTIC_IR_CONTRACT_VERSION,
    functionId: nonEmpty(input.functionId, 'semantic-ir-function-id-required'),
    entryBlockId: nonEmpty(input.entryBlockId, 'semantic-ir-entry-block-required'),
    blocks: rawBlocks.map((block) => normalizeBlock(cacheReferenceReads(block, referenceReads))).sort((a, b) => compareCodeUnit(a.id, b.id)),
    values: rawValues.map((value) => createSemanticValue(cacheReferenceReads(value, referenceReads))).sort((a, b) => compareCodeUnit(a.id, b.id)),
    nodes: rawNodes.map((node) => createSemanticNode(cacheReferenceReads(node, referenceReads))).sort((a, b) => compareCodeUnit(a.id, b.id)),
    completeness: enumValue(input.completeness ?? 'complete', SEMANTIC_SETS.completeness, 'semantic-ir-invalid-function-completeness'),
    unknowns: array(input.unknowns ?? [], 'semantic-ir-invalid-function-unknowns')
      .map(normalizeFunctionUnknown)
      .sort((a, b) => compareCodeUnit(stableStringify(a), stableStringify(b))),
    origin: requiredOrigin(input, 'semantic-ir-function-origin-required'),
  };
  assertWithinBudget(countReferences(out.nodes, out.values, out.blocks), options, 'maxReferences');
  validateNormalizedFunction(out, options);
  const frozen = deepFreeze(out);
  // Publish the private normalization brand only for fully immutable plain
  // data under the ordinary schema rules. It carries no authority for any
  // analysis artifact and cannot suppress caller-specific validation budgets.
  if (isDeeplyFrozenPlainData(frozen) && inertOptions
    && ordinaryDataPrototypes() && ordinaryJsonBehavior() && ordinaryNormalizationRules()) {
    NORMALIZED_FUNCTIONS.add(frozen);
  }
  return frozen;
}

export function validateSemanticIrFunction(input, options = {}) {
  return createSemanticIrFunction(input, options);
}

export function canonicalSerializeSemanticIr(input, options = {}) {
  return stableStringify(createSemanticIrFunction(input, options));
}
