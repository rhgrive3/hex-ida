import {
  canonicalAddress,
  createBlockId,
  createFunctionId,
  createInstructionId,
  deepFreeze,
  stableDigest,
  stableStringify,
} from '../../core/identity/index.js';
import { appendTransform, createTransformRecord, createOriginSet, mergeOriginSets } from '../../core/identity/origin.js';
import { abiResultInvalidState, canonicalAbiEvidence } from '../../targets/abi/evidence.js';
import { createPhysicalStateVariable } from '../ir/normalize-effects.js';
import { classifySemanticMemoryRegion } from '../../analysis/alias/index-v2.js';
import { createPhase7AliasSolver } from '../../analysis/alias/solver.js';
import { createSemanticCfg } from '../cfg/index.js';
import {
  createMachineEffectBundle,
  validateMachineEffectBundle,
} from '../effects/index.js';
import {
  SEMANTIC_IR_SCHEMA_VERSION,
  SEMANTIC_IR_DEFAULT_BUDGET,
  createSemanticIrFunction,
  lowerMachineEffectBundleToSemanticIr,
} from '../ir/index.js';
import {
  SEMANTIC_SSA_BUILD_VERSION,
  buildSemanticSsa,
  validateSemanticSsa,
} from '../ssa/index.js';
import {
  MEMORY_SSA_BUILD_VERSION,
  buildMemorySsa,
  validateMemorySsa,
} from '../memoryssa/index.js';
import { projectSemanticIrV2ToLegacyV1 } from './semantic-ir-v2-to-v1.js';

export {
  MACHINE_EFFECTS_V1_COMPAT,
  lowerMachineEffectsToLegacyV1,
} from './machine-effects-to-v1.js';
export {
  SEMANTIC_IR_V2_V1_COMPAT,
  projectSemanticIrV2ToLegacyV1,
} from './semantic-ir-v2-to-v1.js';

export const SEMANTIC_V2_MIGRATION_MODES = Object.freeze({
  LEGACY: 'legacy-v1',
  V2_COMPAT: 'semantic-v2-compat',
  SHADOW_DIFFERENTIAL: 'semantic-v2-shadow-differential',
});

export const SEMANTIC_V2_COMPAT_PIPELINE_VERSION = '1.5.1';
export const SEMANTIC_V2_COMPAT_PATH = Object.freeze([
  'machine-effects',
  'semantic-ir-v2',
  'scalar-ssa',
  'region-resolver',
  'memoryssa',
  'v1-compat',
]);

const COMPLETENESS_RANK = Object.freeze({ complete: 0, partial: 1, unknown: 2 });
const UNKNOWN_CATEGORIES = Object.freeze(['registers', 'flags', 'memory', 'control', 'faults', 'other']);

function fail(code) { throw new TypeError(code); }
function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}
function nonEmpty(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}
function array(value, code) {
  if (!Array.isArray(value)) fail(code);
  return value;
}
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('semantic-v2-integration-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
function integerBytes(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
function instructionAddress(item) {
  const raw = item.address ?? item.decoded?.address;
  if (raw == null) fail('semantic-v2-integration-instruction-address-required');
  try { return BigInt(raw); }
  catch { fail('semantic-v2-integration-invalid-instruction-address'); }
}
function instructionLength(item, architecturePlugin) {
  return integerBytes(item.size ?? item.decoded?.size ?? architecturePlugin.fixedInstructionSize) ?? null;
}
function originWithInstruction(item, instructionId, architecturePlugin) {
  const address = instructionAddress(item);
  const length = instructionLength(item, architecturePlugin);
  const generated = createOriginSet({
    instructionIds: [instructionId],
    ...(length == null ? {} : { virtualRanges: [{ start: address, end: address + BigInt(length) }] }),
  });
  return mergeOriginSets(item.origin ?? item.decoded?.origin ?? createOriginSet({}), generated);
}
function unknownBundle({ architecturePlugin, instructionId, mode, origin }) {
  return createMachineEffectBundle({
    instructionId,
    architectureId: architecturePlugin.id,
    mode,
    operations: [],
    controlEffect: { kind: 'unknown', reason: 'architecture-lifter-returned-no-exact-effects' },
    possibleFaults: [],
    origin,
    completeness: 'unknown',
    unknownEffects: {
      categories: UNKNOWN_CATEGORIES,
      reason: 'architecture-lifter-returned-no-exact-effects',
      preservation: 'not-assumed',
    },
    metadata: { phase: 3, explicitUnknown: true },
  });
}
function mergeById(map, item, code) {
  const prior = map.get(item.id);
  if (!prior) {
    map.set(item.id, item);
    return;
  }
  if (stableStringify(prior) !== stableStringify(item)) fail(code);
}
function promotedCompleteness(current, next) {
  return COMPLETENESS_RANK[next] > COMPLETENESS_RANK[current] ? next : current;
}
function targetAddress(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  if (String(target.kind ?? '') !== 'absolute-address' || target.value == null) return null;
  try { return canonicalAddress(target.value); }
  catch { return null; }
}
function bundleTargets(bundle) {
  const control = bundle.controlEffect;
  const targets = [];
  if (control.target != null) targets.push(control.target);
  for (const target of control.targets ?? []) targets.push(target);
  if (control.fallthrough != null) targets.push(control.fallthrough);
  return targets;
}
function conditionalFallthroughTarget(control, instructionId) {
  if (control.fallthrough != null) return control.fallthrough;
  return { kind: 'fallthrough-continuation', instructionId };
}
function semanticEdgeKind(node, index) {
  if (node.kind === 'branch') return 'branch';
  if (node.kind === 'conditional-branch') return index === 0 ? 'conditional-true' : 'conditional-false';
  if (node.kind === 'switch') return 'switch-case';
  if (node.kind === 'unknown-control-effect'
      && node.attributes?.indirectControl?.targetState === 'candidate') return 'indirect-candidate';
  return 'unknown';
}

function filterUnresolvedConditionalFallthrough(fragment, bundle, controlTargets, blockByAddress, context = {}) {
  const control = bundle.controlEffect;
  if (control.kind !== 'conditional-branch' || !Array.isArray(fragment.nodes)) return fragment;
  const rawTargets = control.targets?.length
    ? [...control.targets]
    : control.target == null ? [] : [control.target];
  rawTargets.push(conditionalFallthroughTarget(control, bundle.instructionId));
  const fallthrough = rawTargets[rawTargets.length - 1];
  const fallthroughAddress = targetAddress(fallthrough);
  const resolved = fallthroughAddress != null
    && blockByAddress.has(fallthroughAddress)
    && controlTargets.some((entry) => stableStringify(entry?.target) === stableStringify(fallthrough));
  if (resolved) return fragment;

  const unknown = {
    reason: 'semantic-cfg-missing-fallthrough',
    categories: ['control'],
    detail: {
      ...(context.blockKey == null ? {} : { blockKey: String(context.blockKey) }),
      ...(context.instructionAddress == null ? {} : { instructionAddress: String(context.instructionAddress) }),
      expectedAddress: fallthroughAddress == null ? null : String(fallthroughAddress),
    },
  };
  const unknowns = [...(fragment.unknowns ?? [])];
  if (!unknowns.some((item) => item?.reason === unknown.reason && item?.detail?.blockKey === unknown.detail?.blockKey)) {
    unknowns.push(unknown);
  }
  let changed = false;
  const nodes = fragment.nodes.map((node) => {
    if (node?.kind !== 'conditional-branch' || !Array.isArray(node.targets) || node.targets.length < 2) return node;
    const targets = node.targets.slice(0, -1);
    if (!targets.length) return node;
    changed = true;
    return { ...node, targets };
  });
  return {
    ...fragment,
    ...(changed ? { nodes } : {}),
    completeness: fragment.completeness === 'unknown' ? 'unknown' : 'partial',
    unknowns,
  };
}
function normalizeSuccessor(input) {
  if (typeof input === 'string') return { to: input, kind: 'fallthrough' };
  input = object(input, 'semantic-v2-integration-invalid-successor');
  return {
    to: nonEmpty(input.to, 'semantic-v2-integration-successor-target-required'),
    kind: nonEmpty(input.kind ?? 'fallthrough', 'semantic-v2-integration-successor-kind-required'),
    ...(input.metadata == null ? {} : { metadata: input.metadata }),
  };
}

function architectureRegisterDescriptors(architecturePlugin) {
  if (typeof architecturePlugin.registerFile !== 'function') return [];
  let descriptors;
  try { descriptors = architecturePlugin.registerFile(); }
  catch { return []; }
  return Array.isArray(descriptors) ? descriptors : [];
}

function createRegionRootDescriptorProvider(architecturePlugin, architectureId, input, options) {
  const explicitProvider = input.rootDescriptorProvider
    ?? options.regionOptions?.rootDescriptorProvider
    ?? options.rootDescriptorProvider
    ?? null;
  const stackRegisterIds = new Set(architectureRegisterDescriptors(architecturePlugin)
    .filter((descriptor) => descriptor && String(descriptor.kind ?? '') === 'stack-pointer' && descriptor.id != null)
    .map((descriptor) => String(descriptor.id)));

  if (typeof explicitProvider !== 'function' && !stackRegisterIds.size) return null;
  return (request) => {
    if (typeof explicitProvider === 'function') {
      const supplied = explicitProvider(request);
      if (supplied != null) return supplied;
    }
    const identity = request?.variable?.physicalIdentity;
    if (identity?.kind !== 'register' || !stackRegisterIds.has(String(identity.registerId ?? ''))) return null;
    return {
      kind: 'stack-like',
      addressSpace: request.expectedAddressSpace ?? 'memory',
      baseOffset: 0,
      linearOffsets: true,
      rootIdentity: {
        kind: 'architecture-register-role',
        architectureId,
        role: 'stack-pointer',
        registerId: String(identity.registerId),
      },
    };
  };
}

function canonicalMemoryAccessProof(descriptor, architectureId) {
  const memory = descriptor?.memory;
  const machineEffects = descriptor?.node?.attributes?.machineEffects;
  const family = machineEffects?.bundleMetadata?.family;
  if (!memory || architectureId !== 'arm64' && architectureId !== 'arm64e'
      || family !== 'arm64-memory') return null;
  // The target producer deliberately leaves source-level qualifiers unknown at
  // this boundary. Its ordinary memory-operation contract is the authority
  // that these accesses are neither volatile nor atomic.
  if (memory.ordering != null && memory.ordering !== 'unknown') return null;
  if (memory.atomic === true || memory.volatility === true) return null;
  return {
    kind: 'canonical-memory-access-qualifiers',
    sourceEntityId: String(descriptor.node.id),
    architectureId: String(architectureId),
    family,
    widthBits: Number(memory.widthBits),
    endian: memory.endian,
    volatility: false,
    atomic: false,
    ordering: 'unknown',
    evidence: {
      operationKind: machineEffects.operationKind ?? null,
      machineFamily: family,
      sourceMnemonic: machineEffects.bundleMetadata?.mnemonic ?? null,
    },
  };
}

/**
 * Build the explicit Phase 3 migration route. There is deliberately no legacy
 * fallback here: callers either request this route and get a complete/partial/
 * explicit-unknown v2 result, or the call fails.
 *
 * Input blocks are discovery facts supplied by the caller. This function does
 * not rediscover CFG structure or parse mnemonics. Stable FunctionId, BlockId,
 * and InstructionId values are minted only through the canonical identity API.
 */
/**
 * Observe a declared scalar ABI result before SSA, not by searching rendered
 * register names after projection. The architectural return target stays in
 * its original control attributes. This adds a value observation, not a claim
 * about that value's root, a callee's effects, or aggregate reconstruction.
 */
function declaredValuesObservable(ir) {
  if (ir.completeness === 'complete' && ir.unknowns.length === 0) return true;
  // A typed call's normal-return value can be observed without settling any
  // of its memory, control or other state effects. Every other frontier stays
  // closed, and the original partial status/unknowns are never removed.
  return ir.completeness === 'partial' && ir.unknowns.length > 0
    && ir.unknowns.every(item => item.reason === 'call-context-effects-not-enriched')
    && ir.nodes.filter(node => node.kind === 'call').every(node => node.attributes?.abiCallBinding != null);
}

// AAPCS64's existing classifier spells a declared argument with the explicit
// possible/mustUse pair; other registered ABIs also publish exact. Preserve
// both positive contracts without treating a missing/false flag as authority.
function declaredExactArgument(argument) {
  return argument?.possible !== true && argument?.mustUse !== false
    && (argument?.exact === true || argument?.exact === undefined
      && argument?.possible === false && argument?.mustUse === true);
}

function bindDeclaredScalarReturns(ir, input, options) {
  const adapter = input.abiAdapter ?? options.abiAdapter ?? options.compatOptions?.abiAdapter;
  if (!adapter || !declaredValuesObservable(ir)
    || !ir.nodes.some(node => node.kind === 'return' && node.inputs.length === 0)) return ir;
  let classified, locations;
  try {
    adapter.observeFunction?.({ semanticIr:ir });
    classified = adapter.classifyFunctionReturn?.(options.functionReturn ?? {});
    if (!canonicalAbiEvidence(classified) || abiResultInvalidState(classified)
      || classified.partial === true || classified.unsupported === true) return ir;
    locations = adapter.returnLocations?.({ ...(options.functionReturn ?? {}), classified });
  } catch { return ir; }
  const identity = classified.abiIdentity;
  const snapshotId = options.memorySsaOptions?.snapshotId ?? options.snapshotId;
  if (identity.architectureId !== input.architecturePlugin.id
    || (identity.binaryId != null && identity.binaryId !== input.binaryId)
    || (identity.sliceId != null && identity.sliceId !== input.sliceId)
    || (identity.functionId != null && identity.functionId !== ir.functionId)
    || (snapshotId != null && identity.snapshotId !== snapshotId)) return ir;
  if (!Array.isArray(locations) || locations.length !== 1) return ir;
  const location = locations[0];
  if (location.kind !== 'register' || location.aggregate === true) return ir;
  const descriptor = architectureRegisterDescriptors(input.architecturePlugin)
    .find(reg => reg.id === location.reg && reg.kind === 'gp');
  const widthBits = descriptor?.physicalBits ?? descriptor?.bits;
  if (!Number.isSafeInteger(widthBits) || widthBits <= 0
    || !Number.isSafeInteger(location.bits) || location.bits <= 0 || location.bits > widthBits) return ir;
  const variable = createPhysicalStateVariable({ kind:'register', registerId:descriptor.physicalId ?? descriptor.id });
  const nodes = [], values = [...ir.values], before = new Map();
  for (const node of ir.nodes) {
    assertNotAborted(options);
    if (node.kind !== 'return' || node.inputs.length) { nodes.push(node); continue; }
    const fact = { kind:'abi-return-location', version:1, functionId:ir.functionId,
      returnNodeId:node.id, abiIdentity:identity, location };
    const key = stableDigest(fact);
    const readId = `abi_return_read_${key}`, valueId = `abi_return_value_${key}`;
    const narrow = location.bits !== widthBits;
    const truncId = `abi_return_trunc_${key}`, resultId = narrow ? `abi_return_result_${key}` : valueId;
    const addedIds = narrow ? [readId, truncId] : [readId];
    const origin = appendTransform(node.origin, createTransformRecord({
      passId:'semantic-abi-return-binding', passVersion:'1.0.0', ruleId:'declared-scalar-result',
      proofKind:'canonical-abi-location', consumedEntityIds:[node.id],
      producedEntityIds:[...addedIds, valueId, ...(narrow ? [resultId] : [])], preconditions:[fact],
    }));
    nodes.push({ id:readId, kind:'state-read', blockId:node.blockId,
      inputs:[], outputs:[valueId], variable, origin });
    values.push({ id:valueId, kind:'definition', definitionNodeId:readId,
      machineType:{ kind:'bitvector', widthBits }, origin });
    if (narrow) {
      nodes.push({ id:truncId, kind:'trunc', blockId:node.blockId,
        inputs:[valueId], outputs:[resultId], origin });
      values.push({ id:resultId, kind:'definition', definitionNodeId:truncId,
        machineType:{ kind:'bitvector', widthBits:location.bits }, origin });
    }
    before.set(node.id, addedIds);
    nodes.push({ ...node, inputs:[resultId], origin,
      attributes:{ ...node.attributes, abiReturnBinding:{ ...fact, valueId:resultId } } });
  }
  return createSemanticIrFunction({ ...ir, nodes, values,
    blocks:ir.blocks.map(block => ({ ...block,
      nodeIds:block.nodeIds.flatMap(id => [...(before.get(id) ?? []), id]) })),
  }, options.semanticIrOptions ?? {});
}

/** Exact full-register formal arguments seed the existing SSA entry model. */
function bindDeclaredEntryArguments(ir, input, options) {
  const prototype = input.functionPrototype ?? options.functionReturn?.functionPrototype;
  const adapter = input.abiAdapter ?? options.abiAdapter ?? options.compatOptions?.abiAdapter;
  if (!prototype || !adapter || !declaredValuesObservable(ir)) return ir;
  let classified;
  try { classified = adapter.classifyArguments?.({ functionPrototype:prototype }); }
  catch { return ir; }
  if (!canonicalAbiEvidence(classified) || abiResultInvalidState(classified)
    || classified.partial === true || !Array.isArray(classified.arguments)) return ir;
  const identity = classified.abiIdentity;
  const snapshotId = options.memorySsaOptions?.snapshotId ?? options.snapshotId;
  if (identity.architectureId !== input.architecturePlugin.id
    || (identity.binaryId != null && identity.binaryId !== input.binaryId)
    || (identity.sliceId != null && identity.sliceId !== input.sliceId)
    || (identity.functionId != null && identity.functionId !== ir.functionId)
    || (snapshotId != null && identity.snapshotId !== snapshotId)) return ir;
  const descriptors = architectureRegisterDescriptors(input.architecturePlugin);
  const values = [...ir.values];
  for (const argument of classified.arguments) {
    assertNotAborted(options);
    if (argument.location !== 'register' || !declaredExactArgument(argument) || argument.possible === true
      || argument.aggregate === true || argument.pieces?.length || argument.regs?.length > 1
      || !Number.isSafeInteger(argument.index) || argument.index < 0) continue;
    const descriptor = descriptors.find(reg => reg.id === argument.reg && reg.kind === 'gp');
    const widthBits = descriptor?.physicalBits ?? descriptor?.bits;
    if (!Number.isSafeInteger(widthBits) || argument.bits !== widthBits) continue;
    // A duplicated physical location is a contradiction, not two formals.
    if (classified.arguments.filter(item => item.reg === argument.reg).length !== 1) continue;
    const variable = createPhysicalStateVariable({ kind:'register', registerId:descriptor.physicalId ?? descriptor.id });
    if (!ir.nodes.some(node => node.variable?.key === variable.key)
      || ir.values.some(value => value.variableKey === variable.key
        && ['entry', 'undef', 'unknown'].includes(value.kind))) continue;
    const fact = { kind:'abi-entry-argument', version:1, functionId:ir.functionId,
      abiIdentity:identity, argumentIndex:argument.index, variableKey:variable.key,
      location:{ reg:argument.reg, bits:argument.bits, abiClass:argument.abiClass } };
    const id = `abi_entry_value_${stableDigest(fact)}`;
    const origin = appendTransform(ir.origin, createTransformRecord({
      passId:'semantic-abi-entry-binding', passVersion:'1.0.0', ruleId:'declared-register-argument',
      proofKind:'canonical-abi-location', consumedEntityIds:[ir.functionId], producedEntityIds:[id], preconditions:[fact],
    }));
    values.push({ id, kind:'entry', variableKey:variable.key,
      machineType:{ kind:'bitvector', widthBits }, origin,
      metadata:{ argumentIndex:argument.index, abiArgumentBinding:fact } });
  }
  return values.length === ir.values.length ? ir : createSemanticIrFunction({ ...ir, values }, options.semanticIrOptions ?? {});
}

/** Bind normal-return scalar values; do not resolve targets or callee effects. */
function bindDeclaredCallValues(ir, input, options) {
  const adapter = input.abiAdapter ?? options.abiAdapter ?? options.compatOptions?.abiAdapter;
  if (!adapter || !ir.nodes.some(node => node.kind === 'call')) return ir;
  const descriptors = architectureRegisterDescriptors(input.architecturePlugin);
  const physical = location => {
    if (location?.aggregate === true) return null;
    const descriptor = descriptors.find(reg => reg.id === location?.reg && reg.kind === 'gp');
    const widthBits = descriptor?.physicalBits ?? descriptor?.bits;
    if (!Number.isSafeInteger(widthBits) || widthBits <= 0 || location.bits !== widthBits) return null;
    return { widthBits, variable:createPhysicalStateVariable({ kind:'register', registerId:descriptor.physicalId ?? descriptor.id }) };
  };
  const nodes = [], values = [...ir.values], replacements = new Map();
  let addedNodes = 0;
  for (const node of ir.nodes) {
    assertNotAborted(options);
    let raw = null;
    if (node.kind === 'call' && !node.outputs.length && !node.call.arguments.length && !node.call.returns.length) {
      try { raw = adapter.classifyCall?.({ node, call:node.call, semanticIr:ir }); } catch { /* unknown */ }
    }
    if (!raw || !canonicalAbiEvidence(raw) || abiResultInvalidState(raw) || raw.partial === true
      || raw.noreturn === true || raw.returnAggregate === true || raw.returnIndirect === true
      || raw.returnLocations?.length !== 1 || raw.returnLocations[0].kind !== 'register'
      || !Array.isArray(raw.explicitArguments) || raw.explicitArguments.length > 64
      || raw.implicitInputs?.length || raw.stackArguments?.length || raw.stackArgsUnknown !== false) {
      nodes.push(node); continue;
    }
    const identity = raw.abiIdentity, snapshotId = options.memorySsaOptions?.snapshotId ?? options.snapshotId;
    if (identity.architectureId !== input.architecturePlugin.id
      || (identity.binaryId != null && identity.binaryId !== input.binaryId)
      || (identity.sliceId != null && identity.sliceId !== input.sliceId)
      || (identity.functionId != null && identity.functionId !== ir.functionId)
      || (snapshotId != null && identity.snapshotId !== snapshotId)) { nodes.push(node); continue; }
    const returned = physical(raw.returnLocations[0]);
    const args = raw.explicitArguments.map((argument, index) => argument.index === index
      && argument.location === 'register' && declaredExactArgument(argument) && argument.possible !== true
      && !argument.pieces?.length && !(argument.regs?.length > 1) ? physical(argument) : null);
    if (!returned || args.some(argument => !argument)
      || new Set(args.map(argument => argument.variable.key)).size !== args.length) { nodes.push(node); continue; }
    // Charge before allocating the expanded graph, not after building an
    // arbitrarily large set of register observations for the constructor.
    const growth = args.length + 1;
    if (ir.nodes.length + addedNodes + growth > (options.semanticIrOptions?.budget?.maxNodes ?? SEMANTIC_IR_DEFAULT_BUDGET.maxNodes)) {
      fail('semantic-ir-budget-exceeded-maxNodes');
    }
    if (values.length + growth > (options.semanticIrOptions?.budget?.maxValues ?? SEMANTIC_IR_DEFAULT_BUDGET.maxValues)) {
      fail('semantic-ir-budget-exceeded-maxValues');
    }
    addedNodes += growth;
    const fact = { kind:'abi-call-values', version:1, functionId:ir.functionId, callNodeId:node.id,
      abiIdentity:identity, arguments:raw.explicitArguments, returnLocation:raw.returnLocations[0] };
    const key = stableDigest(fact), resultId = `abi_call_result_${key}`, writeId = `abi_call_write_${key}`;
    const readIds = args.map((_, index) => `abi_call_read_${key}_${index}`);
    const argumentIds = args.map((_, index) => `abi_call_arg_${key}_${index}`);
    const origin = appendTransform(node.origin, createTransformRecord({
      passId:'semantic-abi-call-binding', passVersion:'1.0.0', ruleId:'declared-scalar-call-values',
      proofKind:'canonical-abi-location', consumedEntityIds:[node.id],
      producedEntityIds:[...readIds, ...argumentIds, resultId, writeId], preconditions:[fact],
    }));
    args.forEach((argument, index) => {
      nodes.push({ id:readIds[index], kind:'state-read', blockId:node.blockId,
        inputs:[], outputs:[argumentIds[index]], variable:argument.variable, origin });
      values.push({ id:argumentIds[index], kind:'definition', definitionNodeId:readIds[index],
        machineType:{ kind:'bitvector', widthBits:argument.widthBits }, origin });
    });
    values.push({ id:resultId, kind:'definition', definitionNodeId:node.id,
      machineType:{ kind:'bitvector', widthBits:returned.widthBits }, origin });
    nodes.push({ ...node, inputs:[...new Set([...node.inputs, ...argumentIds])], outputs:[resultId],
      call:{ ...node.call, arguments:argumentIds, returns:[resultId] }, origin,
      attributes:{ ...node.attributes, abiCallBinding:{ ...fact, argumentValueIds:argumentIds, returnValueId:resultId } } });
    // SSA still applies the CALL's broad unknown-state write first. Only the
    // declared result cell receives the fresh call value on normal continuation.
    nodes.push({ id:writeId, kind:'state-write', blockId:node.blockId,
      inputs:[resultId], outputs:[], variable:returned.variable, origin });
    replacements.set(node.id, [...readIds, node.id, writeId]);
  }
  return replacements.size === 0 ? ir : createSemanticIrFunction({ ...ir, nodes, values,
    blocks:ir.blocks.map(block => ({ ...block,
      nodeIds:block.nodeIds.flatMap(id => replacements.get(id) ?? [id]) })),
  }, options.semanticIrOptions ?? {});
}

export function buildSemanticV2CompatibilityPipeline(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'semantic-v2-integration-input-required');
  const architecturePlugin = object(input.architecturePlugin, 'semantic-v2-integration-architecture-plugin-required');
  if (typeof architecturePlugin.liftExact !== 'function') fail('semantic-v2-lift-exact-required');
  if (architecturePlugin.liftDecodedExact != null && typeof architecturePlugin.liftDecodedExact !== 'function') {
    fail('semantic-v2-lift-decoded-exact-invalid');
  }
  const architectureId = nonEmpty(architecturePlugin.id, 'semantic-v2-integration-architecture-id-required');
  const architectureSemanticVersion = nonEmpty(architecturePlugin.semanticVersion, 'semantic-v2-integration-architecture-semantic-version-required');
  const decoderSemanticVersion = nonEmpty(input.decoderSemanticVersion, 'semantic-v2-integration-decoder-semantic-version-required');
  const binaryId = nonEmpty(input.binaryId, 'semantic-v2-integration-binary-id-required');
  const sliceId = nonEmpty(input.sliceId, 'semantic-v2-integration-slice-id-required');
  const rawBlocks = array(input.blocks, 'semantic-v2-integration-blocks-required');
  if (!rawBlocks.length) fail('semantic-v2-integration-blocks-required');
  const machineEffectsContext = input.machineEffectsContext == null
    ? {}
    : object(input.machineEffectsContext, 'semantic-v2-integration-machine-effects-context-invalid');

  const canonicalStartIdentity = input.canonicalStartIdentity ?? { address: canonicalAddress(rawBlocks[0].startAddress) };
  const functionId = createFunctionId({ binaryId, sliceId, canonicalStartIdentity });

  const blockRecords = [];
  const blockByKey = new Map();
  const blockByAddress = new Map();
  for (let index = 0; index < rawBlocks.length; index++) {
    assertNotAborted(options);
    const raw = object(rawBlocks[index], 'semantic-v2-integration-invalid-block');
    const key = nonEmpty(raw.key ?? `block-${index}`, 'semantic-v2-integration-block-key-required');
    if (blockByKey.has(key)) fail('semantic-v2-integration-duplicate-block-key');
    if (raw.startAddress == null) fail('semantic-v2-integration-block-start-address-required');
    const startAddress = canonicalAddress(raw.startAddress);
    if (blockByAddress.has(startAddress)) fail('semantic-v2-integration-duplicate-block-address');
    const id = createBlockId({
      functionId,
      canonicalBlockIdentity: raw.canonicalIdentity ?? { startAddress },
    });
    const record = {
      key,
      id,
      startAddress,
      instructions: array(raw.instructions ?? [], 'semantic-v2-integration-invalid-block-instructions'),
      successors: array(raw.successors ?? [], 'semantic-v2-integration-invalid-block-successors').map(normalizeSuccessor),
      origin: raw.origin == null ? null : createOriginSet(raw.origin),
    };
    blockRecords.push(record);
    blockByKey.set(key, record);
    blockByAddress.set(startAddress, record);
  }

  const entryKey = nonEmpty(input.entryBlockKey ?? blockRecords[0].key, 'semantic-v2-integration-entry-block-required');
  const entryRecord = blockByKey.get(entryKey);
  if (!entryRecord) fail('semantic-v2-integration-entry-block-not-found');

  const blocks = new Map(blockRecords.map((record) => [record.id, {
    id: record.id,
    nodeIds: [],
    ...(record.origin == null ? {} : { origin: record.origin }),
  }]));
  const values = new Map();
  const nodes = new Map();
  const initialUnknowns = input.unknowns == null
    ? []
    : array(input.unknowns, 'semantic-v2-integration-invalid-function-unknowns');
  const initialCompleteness = input.completeness
    ?? (initialUnknowns.length ? 'partial' : 'complete');
  if (!Object.hasOwn(COMPLETENESS_RANK, initialCompleteness)) {
    fail('semantic-v2-integration-invalid-function-completeness');
  }
  const issues = new Map(initialUnknowns.map((unknown) => [stableStringify(unknown), unknown]));
  const bundles = [];
  const instructionTelemetry = [];
  let completeness = initialCompleteness;
  let unsupportedInstructionCount = 0;
  const conditionalFalseTargetByBlock = new Map();

  function mergeBlock(fragmentBlock) {
    const prior = blocks.get(fragmentBlock.id);
    if (!prior) {
      blocks.set(fragmentBlock.id, {
        id: fragmentBlock.id,
        nodeIds: fragmentBlock.nodeIds.slice(),
        ...(fragmentBlock.origin == null ? {} : { origin: fragmentBlock.origin }),
      });
      return;
    }
    prior.nodeIds.push(...fragmentBlock.nodeIds.filter((id) => !prior.nodeIds.includes(id)));
    if (prior.origin != null || fragmentBlock.origin != null) {
      prior.origin = mergeOriginSets(prior.origin ?? createOriginSet({}), fragmentBlock.origin ?? createOriginSet({}));
    }
  }

  for (const block of blockRecords) {
    for (const item of block.instructions) {
      assertNotAborted(options);
      object(item, 'semantic-v2-integration-invalid-instruction');
      const address = instructionAddress(item);
      const mode = nonEmpty(item.mode ?? item.decoded?.mode ?? input.mode ?? 'default', 'semantic-v2-integration-instruction-mode-required');
      const instructionId = createInstructionId({
        binaryId,
        sliceId,
        virtualAddress: address,
        decodeMode: mode,
        decoderSemanticVersion,
      });
      const origin = originWithInstruction(item, instructionId, architecturePlugin);
      const decoded = object(item.decoded ?? item, 'semantic-v2-integration-decoded-instruction-required');
      const liftContext = {
        ...machineEffectsContext,
        instructionId,
        origin,
        mode,
        signal: options.signal,
        machineEffectsOptions: options.machineEffectsOptions ?? {},
      };
      // A spread copy cannot carry private receiver/decoder object identity.
      // Let an architecture preserve its original object while binding the
      // canonical metadata itself. Existing liftExact plugins keep their API.
      let bundle = architecturePlugin.liftDecodedExact
        ? architecturePlugin.liftDecodedExact(decoded, liftContext)
        : architecturePlugin.liftExact({ ...decoded, instructionId, origin, mode }, liftContext);
      if (bundle && typeof bundle.then === 'function') fail('semantic-v2-integration-async-lifter-not-supported');
      if (bundle == null) {
        unsupportedInstructionCount++;
        bundle = unknownBundle({ architecturePlugin, instructionId, mode, origin });
      } else {
        bundle = validateMachineEffectBundle(bundle, options.machineEffectsOptions ?? {});
        if (bundle.instructionId !== instructionId) fail('semantic-v2-integration-instruction-id-mismatch');
        if (bundle.architectureId !== architectureId) fail('semantic-v2-integration-architecture-id-mismatch');
      }
      if (bundle.controlEffect.kind === 'conditional-branch') {
        const fallthrough = conditionalFallthroughTarget(bundle.controlEffect, bundle.instructionId);
        const fallthroughAddress = targetAddress(fallthrough);
        const targetBlock = fallthroughAddress == null ? null : blockByAddress.get(fallthroughAddress);
        conditionalFalseTargetByBlock.set(block.id, targetBlock?.id ?? null);
      }
      bundles.push(bundle);

      const autoTargets = [];
      for (const target of bundleTargets(bundle)) {
        const addressKey = targetAddress(target);
        const targetBlock = addressKey == null ? null : blockByAddress.get(addressKey);
        if (targetBlock) autoTargets.push({ target, blockId: targetBlock.id });
      }
      for (const explicit of item.controlTargets ?? []) {
        const target = object(explicit, 'semantic-v2-integration-invalid-control-target');
        const targetBlock = blockByKey.get(nonEmpty(target.to, 'semantic-v2-integration-control-target-block-required'));
        if (!targetBlock) fail('semantic-v2-integration-control-target-block-not-found');
        autoTargets.push({ target: target.target, blockId: targetBlock.id, ...(target.role == null ? {} : { role: target.role }) });
      }

      const loweredFragment = lowerMachineEffectBundleToSemanticIr(bundle, {
        functionId,
        blockId: block.id,
        entryBlockId: block.id,
        addressWidthBits: input.addressWidthBits,
        controlTargets: autoTargets,
      }, options.semanticIrOptions ?? {});
      const fragment = filterUnresolvedConditionalFallthrough(
        loweredFragment,
        bundle,
        autoTargets,
        blockByAddress,
        { blockKey: block.key, instructionAddress: address.toString() },
      );
      completeness = promotedCompleteness(completeness, fragment.completeness);
      for (const issue of fragment.unknowns) issues.set(stableStringify(issue), issue);
      for (const value of fragment.values) mergeById(values, value, 'semantic-v2-integration-conflicting-value-id');
      for (const node of fragment.nodes) mergeById(nodes, node, 'semantic-v2-integration-conflicting-node-id');
      for (const fragmentBlock of fragment.blocks) mergeBlock(fragmentBlock);
      instructionTelemetry.push(deepFreeze({
        instructionId,
        blockId: block.id,
        address: canonicalAddress(address),
        machineEffectsCompleteness: bundle.completeness,
        semanticIrCompleteness: fragment.completeness,
        explicitUnknown: bundle.completeness === 'unknown',
      }));
    }
  }

  if (!bundles.length) fail('semantic-v2-integration-function-has-no-instructions');
  const functionOrigin = mergeOriginSets(...bundles.map((bundle) => bundle.origin));
  for (const block of blockRecords) {
    const merged = blocks.get(block.id);
    if (merged && block.origin != null) merged.origin = mergeOriginSets(merged.origin ?? createOriginSet({}), block.origin);
  }
  const machineIr = createSemanticIrFunction({
    functionId,
    entryBlockId: entryRecord.id,
    blocks: [...blocks.values()],
    values: [...values.values()],
    nodes: [...nodes.values()],
    completeness,
    unknowns: [...issues.values()],
    origin: functionOrigin,
  }, options.semanticIrOptions ?? {});
  const callIr = bindDeclaredCallValues(machineIr, input, options);
  const ir = bindDeclaredEntryArguments(bindDeclaredScalarReturns(callIr, input, options), input, options);

  const nodeById = new Map(ir.nodes.map((node) => [node.id, node]));
  const successorMap = new Map();
  function addSuccessor(from, edge) {
    let list = successorMap.get(from);
    if (!list) { list = new Map(); successorMap.set(from, list); }
    const key = `${edge.to}\u0000${edge.kind}\u0000${stableStringify(edge.metadata ?? null)}`;
    list.set(key, edge);
  }
  for (const block of blockRecords) {
    for (const successor of block.successors) {
      const target = blockByKey.get(successor.to);
      if (!target) fail('semantic-v2-integration-successor-block-not-found');
      if (successor.kind === 'conditional-false'
        && (!conditionalFalseTargetByBlock.has(block.id)
          || conditionalFalseTargetByBlock.get(block.id) !== target.id)) {
        continue;
      }
      addSuccessor(block.id, { to: target.id, kind: successor.kind, ...(successor.metadata == null ? {} : { metadata: successor.metadata }) });
    }
  }
  for (const block of ir.blocks) {
    for (const nodeId of block.nodeIds) {
      const node = nodeById.get(nodeId);
      if (!node?.targets?.length) continue;
      node.targets.forEach((to, index) => addSuccessor(block.id, { to, kind: semanticEdgeKind(node, index) }));
    }
  }
  const cfg = createSemanticCfg({
    functionId,
    entryBlockId: entryRecord.id,
    blocks: ir.blocks.map((block) => ({
      id: block.id,
      successors: [...(successorMap.get(block.id)?.values() ?? [])],
    })),
  }, options.cfgOptions ?? {});

  const ssa = buildSemanticSsa(ir, cfg, options.ssaOptions ?? {});
  validateSemanticSsa(ssa, ir, cfg, options.ssaValidationOptions ?? {});

  const semanticIrDigest = stableDigest(ir);
  const scalarSsaDigest = stableDigest(ssa);
  const snapshotId = String(options.memorySsaOptions?.snapshotId ?? options.snapshotId ?? 'snapshot-unbound');
  const semanticIrId = options.memorySsaOptions?.identity?.semanticIrId
    ?? `semantic-ir-${stableDigest({ functionId, semanticIrDigest })}`;
  const scalarSsaId = options.memorySsaOptions?.identity?.scalarSsaId
    ?? `scalar-ssa-${stableDigest({ functionId, scalarSsaDigest })}`;
  const memorySsaId = options.memorySsaOptions?.identity?.memorySsaId
    ?? `memory-ssa-${stableDigest({ functionId, semanticIrDigest, scalarSsaDigest, buildVersion: MEMORY_SSA_BUILD_VERSION })}`;

  const regionOptions = options.regionOptions ?? {};
  const rootDescriptors = input.rootDescriptors ?? regionOptions.rootDescriptors ?? options.rootDescriptors;
  const rootDescriptorProvider = createRegionRootDescriptorProvider(architecturePlugin, architectureId, input, options);
  const aliasSolver = createPhase7AliasSolver({
    ir,
    cfg,
    ssa,
    options: {
      ...(options.aliasOptions ?? {}),
      // The points-to solve must see exactly the root descriptors the region
      // classification sees, or the two would name the same object differently
      // and every refinement would be silently discarded.
      canonicalOptions: {
        ...(rootDescriptors == null ? {} : { rootDescriptors }),
        ...(rootDescriptorProvider == null ? {} : { rootDescriptorProvider }),
        ...(options.aliasOptions?.canonicalOptions ?? {}),
      },
      ...(options.signal == null ? {} : { signal: options.signal }),
    },
  });
  const memorySsaOptionsFor = (canonicalMemorySsa = null) => ({
    ...(options.memorySsaOptions ?? {}),
    ssa,
    rootDescriptorProvider,
    accessProofForDescriptor: options.memorySsaOptions?.accessProofForDescriptor
      ?? ((descriptor) => canonicalMemoryAccessProof(descriptor, architectureId)),
    identity: {
      ...(options.memorySsaOptions?.identity ?? {}),
      binaryId,
      sliceId,
      functionId,
      architectureId,
      architectureSemanticVersion,
      decoderSemanticVersion,
      semanticIrContractVersion: ir.contractVersion,
      semanticIrId,
      semanticIrDigest,
      snapshotId,
      scalarSsaId,
      scalarSsaBuildVersion: SEMANTIC_SSA_BUILD_VERSION,
      scalarSsaDigest,
      memorySsaId,
      memorySsaBuildVersion: MEMORY_SSA_BUILD_VERSION,
      analyzerVersion: MEMORY_SSA_BUILD_VERSION,
    },
    snapshotId,
    canonicalIrIdentity: {
      functionId,
      semanticIrId,
      semanticIrContractVersion: ir.contractVersion,
      semanticIrDigest,
    },
    resolveRegion(memory, context) {
      return classifySemanticMemoryRegion(ir, context.node, {
        binaryId,
        ssa,
        ...(rootDescriptors == null ? {} : { rootDescriptors }),
        ...(rootDescriptorProvider == null ? {} : { rootDescriptorProvider }),
        ...(canonicalMemorySsa == null ? {} : { canonicalMemorySsa }),
      });
    },
    // The canonical alias provider. The Phase 7 solver answers region-identity
    // questions through the same conservative floor it always did, and adds a
    // field-sensitive refinement on top when — and only when — the points-to
    // solve proves one. Consumers get the stronger answer here rather than
    // building a private one, which is what keeps a single semantic truth.
    queryAlias: aliasSolver.queryAlias,
  });
  // A first canonical pass supplies only an immutable use/def witness to
  // region classification. The published artifact is rebuilt from the same
  // Semantic IR with pointer-through-stack regions refined by that witness;
  // no projected legacy path participates in either pass.
  const initialMemorySsa = buildMemorySsa(ir, cfg, memorySsaOptionsFor());
  const memorySsa = buildMemorySsa(ir, cfg, memorySsaOptionsFor(initialMemorySsa));
  validateMemorySsa(memorySsa, { cfg, ...(options.memorySsaValidationOptions ?? {}) });

  const legacyV1 = projectSemanticIrV2ToLegacyV1(ir, {
    ...(options.compatOptions ?? {}),
    cfg,
    ssa,
    memorySsa,
    abiAdapter: input.abiAdapter ?? options.abiAdapter ?? options.compatOptions?.abiAdapter,
  });

  // The wrapper object is immutable, and every canonical v2 artifact is already
  // frozen by its contract constructor. The legacy v1 compatibility projection
  // intentionally remains mutable because the existing public js/ir.js facade
  // attaches conservative safety/query caches to it after construction.
  return Object.freeze({
    mode: SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT,
    pipelineVersion: SEMANTIC_V2_COMPAT_PIPELINE_VERSION,
    path: SEMANTIC_V2_COMPAT_PATH,
    semanticSchemaVersion: SEMANTIC_IR_SCHEMA_VERSION,
    architectureId,
    architectureSemanticVersion,
    decoderSemanticVersion,
    scalarSsaPassVersion: SEMANTIC_SSA_BUILD_VERSION,
    memorySsaPassVersion: MEMORY_SSA_BUILD_VERSION,
    binaryId,
    sliceId,
    functionId,
    machineEffects: Object.freeze(bundles.slice()),
    semanticIr: ir,
    cfg,
    ssa,
    regions: memorySsa.regions,
    memorySsa,
    legacyV1,
    instrumentation: deepFreeze({
      v2Executed: true,
      path: SEMANTIC_V2_COMPAT_PATH,
      instructionCount: bundles.length,
      unsupportedInstructionCount,
      semanticUnknownCount: ir.unknowns.length,
      provenanceLossCount: 0,
      instructions: instructionTelemetry,
    }),
  });
}
