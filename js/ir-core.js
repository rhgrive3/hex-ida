/*
 * Semantic IR public-core compatibility facade.
 *
 * Semantic IR v2 compatibility is the Phase 3 production default after the
 * completed shadow differential. Legacy ARM64 remains an explicit oracle mode;
 * there is still no catch-and-fallback path between the engines.
 */
export * from './architecture/compat/ir-core-arm64-aapcs64-v1.js';

import {
  buildIR as buildLegacyIR,
  OP as LEGACY_OP,
  VK as LEGACY_VK,
  MK as LEGACY_MK,
  stackPointerProvenanceOf as legacyStackPointerProvenanceOf,
} from './architecture/compat/ir-core-arm64-aapcs64-v1.js';
import { buildCfg, EDGE } from './cfg.js';
import { stableDigest } from './core/identity/index.js';
import {
  SEMANTIC_V2_MIGRATION_MODES,
  buildSemanticV2CompatibilityPipeline,
} from './semantics/compat/index.js';
import {
  canonicalMemoryForwardingContextForLoad,
  isCanonicalExactMemoryForwarding,
} from './semantics/memoryssa/queries.js';
import { ARM64_ARCHITECTURE } from './targets/architecture/index.js';
import { resolveABIPlugin } from './targets/abi/index.js';
import { semanticAbiAdapter } from './analysis/semantic-function-base.js';
import { observeProjectedOperationData, projectedStateTransitionCandidates, projectedConstantTransitionCandidate } from './semantics/compat/semantic-ir-v2-to-v1.js';

const facadeConstantTransitions = new WeakMap();
const expectedFacadeConstantTransitions = new WeakMap();
const facadeStateTransitions = new WeakMap();
const facadePreservedStateHistories = new WeakMap();
const expectedFacadePreservedState = new WeakMap();
const facadeLocationHistories = new WeakMap();
const expectedFacadeLocations = new WeakMap();
const facadeTypedResultHistories = new WeakMap();
const expectedFacadeTypedResults = new WeakMap();
const facadeStackEscapeHistories = new WeakMap();
const expectedFacadeStackEscapes = new WeakMap();
const facadeProjectedConstants = new WeakMap();
const facadeAbiBindings = new WeakMap();
const expectedFacadeAbiBindings = new WeakMap();

export function facadeAbiBindingExpected(projected, instruction = null) {
  const expected = expectedFacadeAbiBindings.get(projected);
  return instruction == null ? (expected?.count || 0) > 0 : expected?.sources.has(instruction) === true;
}

export function readFacadeAbiBindingHistory(projected, instruction = null) {
  const entry = facadeAbiBindings.get(projected);
  if (!entry?.history.isCurrent()) return null;
  return instruction == null ? entry.history : entry.bySource.get(instruction) ?? null;
}

export function facadeProjectedConstantTransitionCandidate(projected, instruction) {
  return facadeProjectedConstants.get(projected)?.get(instruction) ?? null;
}

export function facadeStackEscapeTransitionExpected(projected, instruction = null) {
  const expected = expectedFacadeStackEscapes.get(projected);
  return instruction == null ? (expected?.count || 0) > 0 : expected?.sources.has(instruction) === true;
}

export function readFacadeStackEscapeHistory(projected, instruction = null) {
  const entry = facadeStackEscapeHistories.get(projected);
  if (!entry?.history.isCurrent()) return null;
  return instruction == null ? entry.history : entry.bySource.get(instruction) ?? null;
}

export function facadeTypedResultTransitionExpected(projected, instruction = null) {
  const expected = expectedFacadeTypedResults.get(projected);
  return instruction == null ? (expected?.count || 0) > 0 : expected?.sources.has(instruction) === true;
}

export function readFacadeTypedResultHistory(projected, instruction = null) {
  const entry = facadeTypedResultHistories.get(projected);
  if (!entry?.history.isCurrent()) return null;
  return instruction == null ? entry.history : entry.bySource.get(instruction) ?? null;
}

export function facadeLocationTransitionExpected(projected, instruction = null) {
  const expected = expectedFacadeLocations.get(projected);
  return instruction == null ? (expected?.count || 0) > 0 : expected?.sources.has(instruction) === true;
}

export function readFacadeLocationHistory(projected, instruction = null) {
  const entry = facadeLocationHistories.get(projected);
  if (!entry?.history.isCurrent()) return null;
  return instruction == null ? entry.history : entry.bySource.get(instruction) ?? null;
}

export function facadePreservedStateTransitionExpected(projected, instruction = null) {
  const expected = expectedFacadePreservedState.get(projected);
  return instruction == null ? (expected?.count || 0) > 0 : expected?.sources.has(instruction) === true;
}

export function readFacadePreservedStateHistory(projected, instruction = null) {
  const entry = facadePreservedStateHistories.get(projected);
  if (!entry?.history.isCurrent()) return null;
  return instruction == null ? entry.history : entry.bySource.get(instruction) ?? null;
}

export function facadeStateTransitionCandidates(projected) {
  return facadeStateTransitions.get(projected) ?? null;
}

export function readFacadeStateNormalization(projected) {
  const entry = facadeStateTransitions.get(projected);
  if (!entry?.normalization.events.length && entry?.normalization.completeness !== 'incomplete') return null;
  return entry?.isCurrent() ? entry.normalization : null;
}

function observeFacadeArguments(inst, history) {
  if (!history || history.unavailable) return null;
  const fields = ['args', 'extra', 'returnReg', 'returnEvidence'].map(key => ({ object:inst, key,
    before:Object.getOwnPropertyDescriptor(inst, key)?.value }));
  const args = fields[0].before, length = args && Object.getOwnPropertyDescriptor(args, 'length')?.value;
  if (!Array.isArray(args) || !Number.isSafeInteger(length) || length > 512) { history.unavailable = true; return null; }
  const values = new Set();
  for (let index = 0; index < length; index++) {
    const arg = Object.getOwnPropertyDescriptor(args, index)?.value;
    const value = arg && Object.getOwnPropertyDescriptor(arg, 'value')?.value;
    if (value) values.add(value);
  }
  for (const value of values) {
    if (fields.length >= 512) { history.unavailable = true; return null; }
    fields.push({ object:value, key:'uses', before:Object.getOwnPropertyDescriptor(value, 'uses')?.value });
  }
  return fields;
}

function retainFacadeArgumentWrites(fields, history) {
  if (!fields || !history || history.unavailable) return;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(field.object, field.key), after = descriptor?.value;
    const afterPresent = descriptor != null;
    if (Object.is(field.before, after) && (field.beforePresent === undefined || field.beforePresent === afterPresent)) continue;
    if (history.writes.length >= 4096) { history.unavailable = true; return; }
    history.writes.push(Object.freeze({ ...field, after, afterPresent }));
  }
}

function sealFacadeStateTransitions(projected, history) {
  if (!history?.source || history.unavailable || !history.writes.length) return;
  const source = history.source, writes = Object.freeze(history.writes);
  try {
    if (!source.matchesThroughWrites(writes)) return;
    // Observe the actual final writer output as well as the original source
    // through its exact write chain. No caller can supply or register writes.
    const definitions = projected.instructions.map(inst => ({ source:inst, beforeInputs:[] }));
    const output = observeProjectedOperationData(projected, definitions);
    const isCurrent = () => source.matchesThroughWrites(writes) && output();
    if (!isCurrent()) return;
    const cached = new Map();
    const normalization = Object.freeze({ ...source.normalization, isCurrent });
    facadeStateTransitions.set(projected, Object.freeze({ isCurrent, normalization, get(key) {
      const original = source.get(key);
      if (!original) return null;
      if (!cached.has(original)) cached.set(original, Object.freeze({ ...original, isCurrent }));
      return cached.get(original);
    } }));
  } catch { /* Missing bounded handoff never authorizes a stale predecessor. */ }
}

function sealFacadeProjectedConstants(projected, history, candidates) {
  if (!history || history.unavailable || !history.writes.length || !candidates.size) return;
  try {
    const writes = Object.freeze(history.writes), checks = new Map(), records = new Map();
    const output = observeProjectedOperationData(projected, projected.instructions.map(source => ({ source, beforeInputs:[] })));
    for (const [source, candidate] of candidates) {
      if (!checks.has(candidate.isCurrent)) {
        const current = () => candidate.isCurrent.matchesThroughWrites(writes) && output();
        checks.set(candidate.isCurrent, current() ? current : null);
      }
      const isCurrent = checks.get(candidate.isCurrent);
      if (isCurrent) records.set(source, Object.freeze({ ...candidate, isCurrent }));
    }
    facadeProjectedConstants.set(projected, records);
  } catch { /* Only the actual bounded facade writes can carry old constants. */ }
}

export function readFacadeConstantTransitions(projected, instruction) {
  const record = facadeConstantTransitions.get(projected)?.get(instruction);
  return record?.isCurrent() ? record : null;
}

export function facadeConstantTransitionExpected(projected, instruction) {
  return expectedFacadeConstantTransitions.get(projected)?.has(instruction) === true;
}

// Historical callers receive the canonical registry classifier through this
// compatibility name.  The v2 compatibility pipeline itself always uses the
// identity-carrying adapter below and never runs a private ABI classifier.
export function classifyCallArguments(instruction = {}, options = {}) {
  const source = instruction && typeof instruction === 'object' ? instruction : {};
  const target = {
    ...options,
    abiId:options.abiId ?? source.abiId,
    abi:options.abi ?? source.abi,
    callingConvention:options.callingConvention ?? source.callingConvention,
    architectureId:options.architectureId ?? source.architectureId,
    architecture:options.architecture ?? source.architecture ?? source.architectureId,
    platformId:options.platformId ?? source.platformId,
    platform:options.platform ?? source.platform ?? source.platformId,
    callPrototype:source.callPrototype ?? options.callPrototype,
  };
  const plugin = resolveABIPlugin(target, { legacyDefault:true });
  return plugin.classifyArguments({
    callTarget:source.callTarget ?? source.target ?? null,
    callPrototype:target.callPrototype ?? null,
  }, target);
}

let semanticMigrationMode = SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT;
let lastSemanticV2Instrumentation = null;

function normalizeMode(mode) {
  const value = mode ?? semanticMigrationMode;
  if (value === SEMANTIC_V2_MIGRATION_MODES.LEGACY || value === SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT) return value;
  throw new TypeError('semantic-migration-mode-unsupported');
}

/** Explicit process/session migration switch. Legacy-v1 remains available as the compatibility oracle. */
export function setSemanticMigrationMode(mode) {
  semanticMigrationMode = normalizeMode(mode);
  lastSemanticV2Instrumentation = null;
  return semanticMigrationMode;
}

export function getSemanticMigrationMode() { return semanticMigrationMode; }
export function getLastSemanticV2Instrumentation() { return lastSemanticV2Instrumentation; }

function asLegacyAddress(address) {
  if (address == null) return null;
  try { return typeof address === 'bigint' ? address : BigInt(address); }
  catch { return null; }
}

function rowResolver(model, opts) {
  if (typeof opts?.rowOfAddress === 'function') {
    return (address) => {
      const normalized = asLegacyAddress(address);
      return normalized == null ? null : opts.rowOfAddress(normalized);
    };
  }
  const rows = new Map();
  for (const instruction of model?.instructions ?? []) {
    if (instruction?.address != null && Number.isSafeInteger(instruction.row)) rows.set(instruction.address.toString(), instruction.row);
  }
  return (address) => address == null ? null : (rows.get(address.toString()) ?? null);
}

function edgeKind(edge) {
  if (edge.kind === EDGE.TAKEN) return 'conditional-true';
  if (edge.kind === EDGE.JUMP) return 'branch';
  if (edge.kind === EDGE.UNKNOWN) return 'unknown';
  return 'fallthrough';
}

function ephemeralBinaryId(model) {
  const identity = (model?.instructions ?? []).map((instruction) => ({
    address: instruction?.address ?? null,
    mnemonic: instruction?.mnemonic ?? null,
    operands: instruction?.operands ?? null,
  }));
  return `migration-model-${stableDigest(identity)}`;
}

function canonicalCompatibilityAbiAdapter(options = {}, binaryId = null, sliceId = null) {
  const plugin = resolveABIPlugin({
    ...options,
    architecture:options.architecture ?? options.architectureId ?? 'arm64',
    binaryId:binaryId ?? options.binaryId,
    sliceId:sliceId ?? options.sliceId,
  }, { legacyDefault:true });
  return semanticAbiAdapter(plugin, {
    ...options,
    architecture:options.architecture ?? options.architectureId ?? plugin.architectureId,
    binaryId:binaryId ?? options.binaryId,
    sliceId:sliceId ?? options.sliceId,
  });
}

/*
 * Legacy v1 region-root presentation.  Placement/classification authority is
 * always the adapter selected above; this helper only describes the legacy
 * memory-root view needed by the old ARM64 projection.  Refuse to manufacture
 * xN roots when a different canonical profile is selected.
 */
function aapcs64RegionRootDescriptorProvider(options = {}, abiAdapter = null) {
  const explicit = options.rootDescriptorProvider ?? options.regionOptions?.rootDescriptorProvider ?? null;
  return (request) => {
    if (typeof explicit === 'function') {
      const supplied = explicit(request);
      if (supplied != null) return supplied;
    }
    if (String(abiAdapter?.id || '').toLowerCase() !== 'aapcs64') return null;
    const identity = request?.variable?.physicalIdentity;
    if (identity?.kind !== 'register') return null;
    const registerId = String(identity.registerId ?? '');
    if (registerId === 'sp') {
      return {
        kind: 'stack-like',
        addressSpace: request.expectedAddressSpace ?? 'memory',
        baseOffset: 0,
        linearOffsets: true,
        rootIdentity: {
          kind: 'abi-storage-root',
          abi: abiAdapter.id,
          storageClass: 'function-local-stack',
          registerId,
        },
      };
    }
    const argument = /^x([0-7])$/.exec(registerId);
    if (!argument) return null;
    return {
      kind: 'rooted-object',
      addressSpace: request.expectedAddressSpace ?? 'memory',
      baseOffset: 0,
      linearOffsets: true,
      rootIdentity: {
        kind: 'abi-entry-argument-root',
        abi: abiAdapter.id,
        storageClass: 'external-entry-memory',
        argumentIndex: Number(argument[1]),
        registerId,
      },
    };
  };
}

function valueDominatesLegacyInstruction(value, inst, projected) {
  if (!value || !inst) return false;
  if (value.kind === LEGACY_VK.ARG) return true;
  const definition = value.def;
  if (!definition || definition === inst) return false;
  if (definition.block === inst.block) return Number(definition.row) <= Number(inst.row);
  const dominators = projected.dominators?.[inst.block];
  return dominators instanceof Set && dominators.has(definition.block);
}

function legacyDefinitionRecency(value, inst, projected) {
  if (!value || value.kind === LEGACY_VK.ARG || !value.def) return { scope:0, depth:0, row:Number.NEGATIVE_INFINITY };
  const definition = value.def;
  if (definition.block === inst.block) {
    return { scope:2, depth:Number.MAX_SAFE_INTEGER, row:Number(definition.row ?? Number.NEGATIVE_INFINITY) };
  }
  const dominators = projected.dominators?.[inst.block];
  if (!(dominators instanceof Set) || !dominators.has(definition.block)) {
    return { scope:-1, depth:-1, row:Number.NEGATIVE_INFINITY };
  }
  const definitionDominators = projected.dominators?.[definition.block];
  return {
    scope:1,
    depth:definitionDominators instanceof Set ? definitionDominators.size : 0,
    row:Number(definition.row ?? Number.NEGATIVE_INFINITY),
  };
}

function detachLegacyArguments(inst) {
  for (const arg of inst.args ?? []) {
    const value = arg?.value;
    if (!Array.isArray(value?.uses)) continue;
    value.uses = value.uses.filter((use) => use !== inst);
  }
  inst.args = [];
}

function selectReachingRegisterValue(projected, inst, reg, bits = null, excluded = null, observation = null) {
  const candidates = (projected.values ?? [])
    .filter((value) => value !== excluded && value.reg === reg && value.kind !== LEGACY_VK.UNDEF
      && valueDominatesLegacyInstruction(value, inst, projected))
    .sort((left, right) => {
      const leftRecency = legacyDefinitionRecency(left, inst, projected);
      const rightRecency = legacyDefinitionRecency(right, inst, projected);
      if (leftRecency.scope !== rightRecency.scope) return rightRecency.scope - leftRecency.scope;
      if (leftRecency.depth !== rightRecency.depth) return rightRecency.depth - leftRecency.depth;
      if (leftRecency.row !== rightRecency.row) return rightRecency.row - leftRecency.row;
      const leftWidth = Number(bits) > 0 && left.bits === Number(bits) ? 1 : 0;
      const rightWidth = Number(bits) > 0 && right.bits === Number(bits) ? 1 : 0;
      if (leftWidth !== rightWidth) return rightWidth - leftWidth;
      return (right.id ?? 0) - (left.id ?? 0);
    });
  if (observation && !observation.unavailable) {
    if (candidates.length > 512) observation.unavailable = true;
    else observation.candidates = Object.freeze(candidates.map(value => Object.freeze({ value,
      definition:value.def, reg:value.reg, kind:value.kind, bits:value.bits, constant:value.const })));
  }
  return candidates[0] ?? null;
}

function replaceLegacyArg(inst, from, to) {
  if (!inst || !from || !to || from === to) return false;
  let changed = false;
  for (const arg of inst.args ?? []) {
    if (arg?.value !== from) continue;
    arg.value = to;
    arg.bits = to.bits || arg.bits;
    changed = true;
  }
  if (!changed) return false;
  if (Array.isArray(from.uses)) from.uses = from.uses.filter((use) => use !== inst);
  if (!Array.isArray(to.uses)) to.uses = [];
  if (!to.uses.includes(inst)) to.uses.push(inst);
  return true;
}

function observePreservedStateSelection(projected) {
  const own = (object, key) => {
    if (object == null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && !Object.hasOwn(descriptor, 'value')) throw Error('selection-accessor');
    return descriptor?.value;
  };
  const values = own(projected, 'values'), length = own(values, 'length');
  if (!Array.isArray(values) || length > 512) throw Error('selection-value-budget');
  const fields = ['id', 'reg', 'kind', 'bits', 'def'];
  const facts = Array.from({ length }, (_, index) => {
    const value = own(values, String(index)), definition = own(value, 'def');
    return { value, fields:fields.map(key => own(value, key)), definition,
      row:own(definition, 'row'), block:own(definition, 'block') };
  });
  const dominators = own(projected, 'dominators'), prototype = dominators == null ? null : Object.getPrototypeOf(dominators);
  const keys = dominators == null ? [] : Reflect.ownKeys(dominators);
  if (keys.length > 512 || keys.some(key => typeof key !== 'string')) throw Error('selection-dominator-budget');
  let edges = 0;
  const size = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;
  const sets = keys.map(key => {
    const value = own(dominators, key);
    if (key === 'length' || value == null) return { key, value, members:null };
    if (Object.getPrototypeOf(value) !== Set.prototype || Reflect.ownKeys(value).length) throw Error('selection-dominator-shape');
    edges += size.call(value);
    if (edges > 4096) throw Error('selection-dominator-edge-budget');
    return { key, value, members:[...Set.prototype.values.call(value)] };
  });
  return (typedResults = null) => {
    try {
      const events = typedResults?.records || [];
      if (typedResults && events.length !== typedResults.count) return false;
      let finalLength = length;
      const changes = new Map();
      for (const event of events) {
        if (event.valueList !== values || event.valueLengthBefore !== finalLength) return false;
        if (event.operation === 'attach-new-typed-call-result') {
          if (own(values, String(finalLength)) !== event.output) return false;
          finalLength++;
        }
        if (event.valueLengthAfter !== finalLength) return false;
        for (const write of event.valueWrites) {
          if (!changes.has(write.object)) changes.set(write.object, new Map());
          const keys = changes.get(write.object);
          if (!keys.has(write.key)) keys.set(write.key, []);
          keys.get(write.key).push(write);
        }
      }
      const unchangedOrWritten = (value, key, before) => {
        let expected = before;
        for (const write of changes.get(value)?.get(key) || []) {
          if (!Object.is(write.before, expected)) return false;
          expected = write.after;
        }
        return own(value, key) === expected;
      };
      return own(projected, 'values') === values && own(values, 'length') === finalLength
        && facts.every((fact, index) => own(values, String(index)) === fact.value
          && fields.every((key, i) => unchangedOrWritten(fact.value, key, fact.fields[i]))
          && own(fact.definition, 'row') === fact.row && own(fact.definition, 'block') === fact.block)
        && own(projected, 'dominators') === dominators
        && (dominators == null || Object.getPrototypeOf(dominators) === prototype && Reflect.ownKeys(dominators).length === keys.length)
        && sets.every(({ key, value, members }) => own(dominators, key) === value
          && (members == null || Object.getPrototypeOf(value) === Set.prototype && !Reflect.ownKeys(value).length
            && size.call(value) === members.length && members.every(member => Set.prototype.has.call(value, member))));
    } catch { return false; }
  };
}

/*
 * Generic SSA is deliberately ABI-neutral and therefore treats an unknown call's
 * state category as a broad clobber. The selected canonical ABI adapter may
 * recover only a callee-preserved physical register state. Memory effects are
 * not changed.
 */
function restoreCanonicalPreservedStateReads(projected, adapter, history = null) {
  const observer = { records:[], sources:new WeakSet(), count:0, selection:null };
  let callerSaved = [];
  try { callerSaved = adapter?.callerSaved?.() ?? []; } catch { callerSaved = []; }
  const callerSavedSet = new Set(callerSaved.map(String));
  for (const inst of projected.instructions ?? []) {
    if (inst.op !== LEGACY_OP.MOV || !inst.extra?.stateRead || inst.args?.length !== 1) continue;
    const identity = inst.extra.stateRead?.physicalIdentity;
    if (identity?.kind !== 'register') continue;
    const reg = String(identity.registerId ?? '');
    if (!reg || callerSavedSet.has(reg)) continue;
    const unknown = inst.args[0]?.value;
    const call = unknown?.def;
    if (unknown?.kind !== LEGACY_VK.UNDEF || call?.op !== LEGACY_OP.CALL) continue;
    const selection = { candidates:[], unavailable:observer.records.length >= 1024 || callerSavedSet.size > 512 };
    const reaching = selectReachingRegisterValue(projected, call, reg, inst.dst?.bits ?? unknown.bits, unknown, selection);
    if (!reaching) continue;
    if (observer.count === 0) {
      try { observer.selection = observePreservedStateSelection(projected); } catch { /* bounded observation unavailable */ }
    }
    const argument = inst.args[0], beforeBits = argument.bits;
    const fields = history && !history.unavailable ? [[argument, 'value'], [argument, 'bits'], [unknown, 'uses'],
      [reaching, 'uses'], [inst.extra, 'abiPreservedState'], [inst.extra, 'abiPreservedStateEvidence']].map(([object, key]) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return { object, key, before:descriptor?.value, beforePresent:descriptor != null };
    }) : null;
    replaceLegacyArg(inst, unknown, reaching);
    inst.extra.abiPreservedState = true;
    inst.extra.abiPreservedStateEvidence = `canonical-${adapter?.id || 'abi'}-callee-preserved`;
    retainFacadeArgumentWrites(fields, history);
    observer.count++;
    observer.sources.add(inst);
    if (!selection.unavailable) {
      const inputs = Object.freeze([unknown, reaching].map(value => Object.freeze({ value, definition:value.def })));
      observer.records.push(Object.freeze({ source:inst, output:inst.dst, input:reaching, call,
        op:inst.op, sub:inst.sub, stage:'facade-preserved-state', ordinal:observer.count - 1,
        argument, before:unknown, after:reaching, beforeBits, afterBits:argument.bits,
        registerId:reg, abiId:String(adapter?.id || 'abi'), evidence:inst.extra.abiPreservedStateEvidence,
        callerSaved:Object.freeze([...callerSavedSet]), candidates:selection.candidates, inputs,
        beforeInputs:Object.freeze([...new Set([unknown, reaching, ...selection.candidates.map(item => item.value)])]) }));
    }
  }
  return observer;
}

// Only the actual private restoration writer supplies these before-images.
// The final seal observes later facade output, never reconstructs a restoration
// from public ABI flags, and does not certify scalar/ABI semantic equivalence.
function sealFacadePreservedStateHistory(projected, observer, constants, typedResults = null) {
  expectedFacadePreservedState.set(projected, observer);
  if (!observer.count) return;
  try {
    if (!observer.selection?.(typedResults)) return;
    const written = new Map(constants.records.map(event => [event.output, event.afterConstant]));
    const valid = observer.records.filter(event => event.source.op === event.op && event.source.sub === event.sub
      && event.source.dst === event.output && event.source.args?.length === 1 && event.source.args[0] === event.argument
      && event.argument.value === event.after && event.argument.bits === event.afterBits
      && event.source.extra?.abiPreservedState === true && event.source.extra?.abiPreservedStateEvidence === event.evidence
      && event.before.def === event.call && event.call.op === LEGACY_OP.CALL
      && event.inputs.every(input => input.value.def === input.definition)
      && event.candidates[0]?.value === event.after && !event.callerSaved.includes(event.registerId)
      && event.candidates.every(input => input.value.def === input.definition && input.value.reg === input.reg
        && input.value.kind === input.kind && input.value.bits === input.bits
        && (input.value.const === input.constant || written.has(input.value) && written.get(input.value) === input.value.const)));
    const output = observeProjectedOperationData(projected, valid);
    const isCurrent = () => observer.selection(typedResults) && output();
    const events = Object.freeze(valid), history = Object.freeze({ events, isCurrent,
      completeness:valid.length === observer.count ? 'complete' : 'incomplete' });
    facadePreservedStateHistories.set(projected, { history, bySource:new Map(valid.map(event => [event.source,
      Object.freeze({ events:Object.freeze([event]), isCurrent })])) });
  } catch { /* Actual restoration is retained; unavailable history cannot become complete. */ }
}

function exactLegacyConstant(value, active = new Set(), observation = null) {
  observeExactConstantRead(value, observation);
  if (!value || active.has(value.id)) return null;
  if (value.const != null) {
    try { return BigInt(value.const); } catch { return null; }
  }
  const def = value.def;
  if (!def) return null;
  active.add(value.id);
  let result = null;
  if (def.op === LEGACY_OP.CONST || def.op === LEGACY_OP.ADDR) {
    try { result = BigInt(def.extra?.value ?? def.extra?.target); } catch { result = null; }
  } else if (def.op === LEGACY_OP.MOV && def.args?.length === 1) {
    const inner = exactLegacyConstant(def.args[0]?.value, active, observation);
    if (inner != null) {
      if (def.sub === 'trunc' || def.sub === 'zext') result = BigInt.asUintN(Number(value.bits || 64), inner);
      else if (def.sub == null || def.sub === 'copy' || def.sub === 'bitcast') result = inner;
    }
  } else if (def.op === LEGACY_OP.BIN && def.args?.length >= 2) {
    const left = exactLegacyConstant(def.args[0]?.value, active, observation);
    const right = exactLegacyConstant(def.args[1]?.value, active, observation);
    if (left != null && right != null) {
      const bits = Number(value.bits || 64);
      if (def.sub === 'add') result = left + right;
      else if (def.sub === 'sub') result = left - right;
      else if (def.sub === 'mul') result = left * right;
      else if (def.sub === 'and') result = left & right;
      else if (def.sub === 'or') result = left | right;
      else if (def.sub === 'xor') result = left ^ right;
      else if (def.sub === 'shl') result = left << right;
      else if (def.sub === 'lshr') result = BigInt.asUintN(bits, left) >> right;
      if (result != null) result = BigInt.asUintN(bits, result);
    }
  }
  active.delete(value.id);
  return result;
}

// The existing evaluator describes only reads it actually makes. Recursive
// evaluations are dependencies, not invented writes to their intermediate values.
function observeExactConstantRead(value, observation) {
  if (!value || !observation || observation.unavailable || observation.seen.has(value)) return;
  if (observation.inputs.length >= 512) { observation.unavailable = true; return; }
  try {
    observation.seen.add(value);
    const definition = value.def;
    if ((definition?.args?.length || 0) > 512) { observation.unavailable = true; return; }
    observation.inputs.push(Object.freeze({ value, definition, constant:value.const, bits:value.bits,
      op:definition?.op, sub:definition?.sub, extra:definition?.extra,
      literal:definition?.extra?.value, target:definition?.extra?.target,
      args:Object.freeze((definition?.args || []).map(argument => Object.freeze({ argument, value:argument?.value }))) }));
  } catch { observation.unavailable = true; }
}

function propagateExactLegacyConstants(projected, history = null) {
  const observer = { records:[], expected:new WeakSet(), unavailable:new WeakSet() };
  for (const value of projected.values ?? []) {
    if (value.const != null) continue;
    const observation = { inputs:[], seen:new WeakSet(), unavailable:observer.records.length >= 1024 };
    const constant = exactLegacyConstant(value, new Set(), observation);
    if (constant != null) {
      const beforeConstant = value.const;
      value.const = BigInt.asUintN(Number(value.bits || 64), constant);
      if (history && !history.unavailable) {
        if (history.writes.length >= 4096) history.unavailable = true;
        else history.writes.push(Object.freeze({ object:value, key:'const', before:beforeConstant, after:value.const }));
      }
      const source = value.def;
      if (!source) continue;
      observer.expected.add(source);
      if (observation.unavailable) { observer.unavailable.add(source); continue; }
      observer.records.push(Object.freeze({ source, output:value, op:source.op, sub:source.sub, bits:value.bits,
        stage:'facade-exact-constants', round:0, ordinal:observer.records.length,
        beforeConstant, afterConstant:value.const, inputs:Object.freeze(observation.inputs),
        beforeInputs:Object.freeze(observation.inputs.map(input => input.value)) }));
    }
  }
  return observer;
}

// Only buildV2CompatFromLegacyModel can issue this facade's finalized records.
// A pure-data observer, a public constant, or copied event is not an issuer.
function sealFacadeConstantTransitions(projected, observer) {
  expectedFacadeConstantTransitions.set(projected, observer.expected);
  if (!observer.records.length) return;
  try {
    const written = new Map(observer.records.map(event => [event.output, event]));
    const valid = observer.records.filter(event => !observer.unavailable.has(event.source)
      && event.source.dst === event.output && event.output.const === event.afterConstant
      && event.inputs.every(input => input.value.def === input.definition && input.value.bits === input.bits
        && (input.value.const === input.constant || written.get(input.value)?.afterConstant === input.value.const)
        && input.definition?.op === input.op && input.definition?.sub === input.sub
        && input.definition?.extra === input.extra && input.definition?.extra?.value === input.literal
        && input.definition?.extra?.target === input.target
        && (input.definition?.args?.length || 0) === input.args.length
        && input.args.every((arg, index) => input.definition.args[index] === arg.argument && arg.argument?.value === arg.value)));
    const isCurrent = observeProjectedOperationData(projected, valid);
    facadeConstantTransitions.set(projected, new Map(valid.map(event => [event.source,
      Object.freeze({ source:event.source, events:Object.freeze([event]), isCurrent })])));
  } catch { /* Preserve the result; missing observation remains explicitly expected. */ }
}

function canonicalAddressBase(value, active = new Set()) {
  if (!value || active.has(value.id)) return value;
  active.add(value.id);
  const def = value.def;
  if (def?.op === LEGACY_OP.MOV && def.args?.length === 1
      && (def.extra?.stateRead || def.extra?.stateWrite || def.sub == null)) {
    const inner = canonicalAddressBase(def.args[0]?.value, active);
    active.delete(value.id);
    return inner || value;
  }
  active.delete(value.id);
  return value;
}

/*
 * MemorySSA alias conclusions remain authoritative. This restores only the
 * legacy public location shape from already-proven precise address metadata.
 */
function publicLocationIdentity(location) {
  return Object.freeze({ key:location?.key ?? null, kind:location?.kind ?? null,
    disp:location?.disp ?? null, size:location?.size ?? null, baseId:location?.base?.id ?? null,
    regionId:location?.regionId ?? null, aliasUncertain:location?.aliasUncertain === true,
    compatibilityShapeOnly:location?.compatibilityShapeOnly === true });
}

function beforePublicLocation(projected, source, key) {
  try {
    const locations = projected.locations;
    if (Object.getPrototypeOf(locations) !== Map.prototype) return null;
    return { location:source.loc, identity:publicLocationIdentity(source.loc), extra:source.extra, locations, key,
      mapBeforePresent:Map.prototype.has.call(locations, key), mapBefore:Map.prototype.get.call(locations, key) };
  } catch { return null; }
}

function retainPublicLocation(observer, projected, source, before, details, history) {
  observer.sources.add(source); observer.count++;
  if (before) retainFacadeArgumentWrites([{ object:source, key:'loc', before:before.location },
    { object:source, key:'extra', before:before.extra }], history);
  else if (history) history.unavailable = true;
  if (!before || observer.records.length >= 1024 || (source.args?.length || 0) > 512) return;
  const values = [...new Set([source.addr?.base, details.base, ...source.args.map(arg => arg.value)].filter(Boolean))];
  const memorySources = details.memory?.provenance?.sourceEntityIds || [];
  if (memorySources.length > 512) return;
  const related = memorySources.length ? projected.instructions.filter(inst => memorySources.includes(inst.semanticNodeId)) : [];
  if (memorySources.some(id => !related.some(inst => inst.semanticNodeId === id))) return;
  observer.records.push(Object.freeze({ source, output:source.dst, input:source.addr?.base,
    stage:'facade-public-location', ordinal:observer.count - 1, op:source.op, sub:source.sub,
    operation:details.operation, before:before.identity, after:publicLocationIdentity(source.loc),
    previousLocation:before.location, location:source.loc, extra:source.extra, address:source.addr,
    locations:before.locations, mapKey:before.key, mapBeforePresent:before.mapBeforePresent, mapBefore:before.mapBefore,
    mapAfter:Map.prototype.get.call(before.locations, before.key), mapWrite:details.mapWrite,
    base:details.base, stack:details.stack ? Object.freeze({ ...details.stack }) : null,
    memory:details.memory ?? null, proofContext:details.proofContext ?? null, related:Object.freeze(related),
    inputs:Object.freeze(values.map(value => Object.freeze({ value, definition:value.def }))),
    beforeInputs:Object.freeze(values),
    object:Object.freeze({ before:before.location, after:source.loc, displaced:before.mapBefore ?? null,
      related:Object.freeze(related) }),
  }));
}

function sealFacadeLocationHistory(projected, observer, escapes = null) {
  expectedFacadeLocations.set(projected, observer);
  if (!observer.count) return;
  try {
    const locations = projected.locations, size = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
    if (Object.getPrototypeOf(locations) !== Map.prototype || Reflect.ownKeys(locations).length || size.call(locations) > 1024) return;
    const bindings = [...Map.prototype.entries.call(locations)];
    const following = (escapes?.records || []).filter(event => event.source.extra === event.afterExtra
      && event.source.memUse === event.afterUse && event.source.reachingStore === undefined);
    const valid = observer.records.filter(event => event.locations === locations && event.source.op === event.op
      && event.source.sub === event.sub && event.source.loc === event.location
      && (event.source.extra === event.extra || following.some(next => next.source === event.source && next.beforeExtra === event.extra))
      && event.source.addr === event.address && event.source.dst === event.output
      && event.inputs.every(input => input.value.def === input.definition));
    const output = observeProjectedOperationData(projected, [...valid.flatMap(event => [event,
      ...event.related.map(source => ({ source, beforeInputs:[] }))]), ...following]);
    const proofsCurrent = () => valid.every(event => !event.memory || event.base?.def?.op === LEGACY_OP.LOAD
      && event.base.def.memoryForwarding === event.memory && isCanonicalExactMemoryForwarding(event.memory,
        canonicalMemoryForwardingContextForLoad(event.memory, event.base.def, event.proofContext)));
    const isCurrent = () => Object.getOwnPropertyDescriptor(projected, 'locations')?.value === locations
      && Object.getPrototypeOf(locations) === Map.prototype && !Reflect.ownKeys(locations).length
      && size.call(locations) === bindings.length && bindings.every(([key, value]) => Map.prototype.has.call(locations, key)
        && Map.prototype.get.call(locations, key) === value)
      && output() && proofsCurrent();
    if (!isCurrent()) return;
    const history = Object.freeze({ events:Object.freeze(valid), isCurrent,
      completeness:valid.length === observer.count ? 'complete' : 'incomplete' });
    facadeLocationHistories.set(projected, { history, bySource:new Map(valid.map(event => [event.source,
      Object.freeze({ events:Object.freeze([event]), isCurrent })])) });
  } catch { /* Public locations are unchanged; missing bounded history remains explicit. */ }
}

function restoreAapcs64PublicLocations(projected, history = null) {
  const observer = { records:[], sources:new WeakSet(), count:0 };
  for (const inst of projected.instructions ?? []) {
    if (inst.op !== LEGACY_OP.LOAD && inst.op !== LEGACY_OP.STORE) continue;
    if ((inst.loc?.kind !== LEGACY_MK.UNKNOWN && inst.loc?.kind !== LEGACY_MK.STACK) || inst.addr?.precise !== true || inst.addr.index != null) continue;
    const stack = legacyStackPointerProvenanceOf(inst.addr.base);
    if (stack?.must === true) {
      const offset = BigInt(stack.offset ?? 0n) + BigInt(inst.addr.disp ?? 0n);
      const size = inst.addr.size ?? inst.extra?.size ?? null;
      const existing = inst.loc?.kind === LEGACY_MK.STACK && inst.loc.disp != null && BigInt(inst.loc.disp) === offset
        && (inst.loc.size == null || size == null || Number(inst.loc.size) === Number(size)) ? inst.loc : null;
      const key = existing?.key ?? `stack:${offset.toString()}`;
      const before = beforePublicLocation(projected, inst, key);
      const loc = existing ?? {
        key,
        kind: LEGACY_MK.STACK,
        disp: offset,
        size,
        regionId: inst.loc?.regionId ?? null,
        origin: inst.loc?.origin ?? inst.addr?.origin ?? null,
        compatAbiPreservedAddress: true,
      };
      if (!existing) projected.locations?.set?.(key, loc);
      inst.loc = loc;
      inst.extra = { ...(inst.extra ?? {}), compatAbiPreservedAddress: true };
      retainPublicLocation(observer, projected, inst, before, { operation:existing ? 'reuse-stack-location' : 'replace-stack-location',
        base:inst.addr.base, stack, mapWrite:!existing }, history);
      continue;
    }
    const base = canonicalAddressBase(inst.addr.base);
    if (base?.def?.op !== LEGACY_OP.LOAD
        || !isCanonicalExactMemoryForwarding(base.def.memoryForwarding,
          canonicalMemoryForwardingContextForLoad(base.def.memoryForwarding, base.def,
            base.def.memoryForwardingContext ?? base.def.extra?.memoryForwardingContext))) continue;
    const disp = BigInt(inst.addr.disp ?? 0n);
    const size = inst.addr.size ?? inst.extra?.size ?? null;
    const key = `field:loaded:${base.id}+${disp.toString()}:s${size ?? '?'}`;
    const before = beforePublicLocation(projected, inst, key);
    const loc = {
      key,
      kind: LEGACY_MK.FIELD,
      base,
      disp,
      size,
      regionId: inst.loc?.regionId ?? null,
      origin: inst.loc?.origin ?? inst.addr?.origin ?? null,
      aliasUncertain: true,
      compatibilityShapeOnly: true,
    };
    projected.locations?.set?.(key, loc);
    inst.loc = loc;
    inst.extra = { ...(inst.extra ?? {}), compatibilityShapeOnly: true };
    retainPublicLocation(observer, projected, inst, before, { operation:'replace-field-location', base, mapWrite:true,
      memory:base.def.memoryForwarding, proofContext:base.def.memoryForwardingContext ?? base.def.extra?.memoryForwardingContext }, history);
  }
  return observer;
}

function abiBindingObserver(projected) {
  const observer = { records:[], sources:new WeakSet(), count:0, selection:null, observations:new Map() };
  try { observer.selection = observePreservedStateSelection(projected); } catch { /* Bounded selection is unavailable. */ }
  return observer;
}

function beginAbiBinding(inst, descriptors, observer) {
  return { beforeArguments:inst.args, beforeExtra:inst.extra, descriptors, selections:[], remaining:512,
    available:!!observer.selection && observer.records.length < 1024
      && Array.isArray(inst.args) && inst.args.length <= 512 && Array.isArray(descriptors) && descriptors.length <= 512 };
}

function retainAbiSelection(binding, descriptor, index, reg, bits, selection, value, outcome) {
  if (!binding.available) return;
  binding.remaining -= (selection?.candidates.length || 0) + 1;
  if (binding.remaining < 0 || selection?.unavailable) { binding.available = false; return; }
  binding.selections.push(Object.freeze({ descriptor, index, reg, bits, value, outcome,
    candidates:selection?.candidates || Object.freeze([]) }));
}

function retainAbiBinding(projected, inst, binding, observer, history, direction, outcome) {
  observer.count++; observer.sources.add(inst);
  if (!binding.available || !history || history.unavailable) return;
  try {
    const values = [...new Set([...binding.beforeArguments.map(arg => arg?.value), ...inst.args.map(arg => arg?.value),
      ...binding.selections.flatMap(selection => selection.candidates.map(candidate => candidate.value))].filter(Boolean))];
    if (values.length > 512) return;
    const event = Object.freeze({ stage:'facade-abi-binding', source:inst, output:inst.dst, op:inst.op, sub:inst.sub,
      ordinal:observer.count - 1, direction, outcome,
      operation:direction === 'call' ? 'attach-canonical-call-arguments' : 'attach-canonical-function-return',
      beforeArguments:binding.beforeArguments, afterArguments:inst.args,
      beforeExtra:binding.beforeExtra, afterExtra:inst.extra, descriptors:binding.descriptors,
      selections:Object.freeze(binding.selections), returnReg:inst.returnReg ?? null, evidence:inst.returnEvidence ?? null,
      inputs:Object.freeze(values.map(value => Object.freeze({ value, definition:value.def }))), beforeInputs:Object.freeze(values),
      object:Object.freeze({ beforeArguments:binding.beforeArguments, beforeExtra:binding.beforeExtra,
        afterArguments:inst.args, afterExtra:inst.extra, descriptors:binding.descriptors, selections:Object.freeze(binding.selections) }) });
    const current = observeProjectedOperationData(projected, [event]);
    if (!current()) return;
    observer.records.push(event);
    observer.observations.set(event, { current, offset:history.writes.length });
  } catch { /* Actual argument writes remain; no later public object can reissue history. */ }
}

function sealFacadeAbiBindings(projected, calls, returns, typedResults, writes) {
  const expected = { count:calls.count + returns.count, sources:new WeakSet() };
  for (const inst of projected.instructions) if (calls.sources.has(inst) || returns.sources.has(inst)) expected.sources.add(inst);
  expectedFacadeAbiBindings.set(projected, expected);
  if (!expected.count || !writes || writes.unavailable) return;
  try {
    const valid = [], checks = [];
    for (const [observer, following] of [[calls, typedResults], [returns, null]]) {
      if (!observer.selection || !observer.selection(following)) continue;
      checks.push(() => observer.selection(following));
      for (const event of observer.records) {
        const observed = observer.observations.get(event), chain = Object.freeze(writes.writes.slice(observed.offset));
        const current = () => observed.current.matchesThroughWrites(chain);
        if (!current()) continue;
        valid.push(event); checks.push(current);
      }
    }
    if (!valid.length) return;
    const uses = [...new Set(valid.flatMap(event => event.beforeInputs))].map(value => value.uses);
    const output = observeProjectedOperationData(projected, [...valid, { beforeInputs:[], object:{ finalUses:uses } }]);
    const isCurrent = () => output() && checks.every(check => check());
    if (!isCurrent()) return;
    const history = Object.freeze({ events:Object.freeze(valid), isCurrent, completeness:valid.length === expected.count ? 'complete' : 'incomplete' });
    facadeAbiBindings.set(projected, { history, bySource:new Map(valid.map(event => [event.source,
      Object.freeze({ events:Object.freeze([event]), isCurrent })])) });
  } catch { /* No partial observation is promoted into complete ABI history. */ }
}

function attachCanonicalCallArguments(projected, history = null) {
  const observer = abiBindingObserver(projected);
  for (const inst of projected.instructions ?? []) {
    if (inst.op !== LEGACY_OP.CALL || !Array.isArray(inst.callArguments)) continue;
    const binding = beginAbiBinding(inst, inst.callArguments, observer);
    const before = observeFacadeArguments(inst, history);
    detachLegacyArguments(inst);
    const seen = new Set();
    const uncertainValueIds = [];
    let index = -1;
    for (const descriptor of inst.callArguments) {
      index++;
      const reg = descriptor?.reg == null ? null : String(descriptor.reg);
      if (!reg) { retainAbiSelection(binding, descriptor, index, reg, null, null, null, 'no-register'); continue; }
      const selection = binding.available ? { candidates:[], unavailable:false } : null;
      const bits = descriptor.bits ?? null;
      const value = selectReachingRegisterValue(projected, inst, reg, bits, null, selection);
      const duplicate = !!value && seen.has(value.id);
      retainAbiSelection(binding, descriptor, index, reg, bits, selection, value, !value ? 'no-reaching-value' : duplicate ? 'duplicate-value' : 'selected');
      if (!value || duplicate) continue;
      seen.add(value.id);
      inst.args.push({ value, bits:value.bits || descriptor.bits || 64 });
      if (!Array.isArray(value.uses)) value.uses = [];
      if (!value.uses.includes(inst)) value.uses.push(inst);
      if (descriptor?.possible === true || descriptor?.mustUse === false || descriptor?.exact === false) {
        uncertainValueIds.push(value.semanticSsaValueId ?? value.semanticValueId ?? value.id);
      }
    }
    inst.extra = {
      ...(inst.extra ?? {}),
      abiProjectedArgumentValueIds: inst.args.map((arg) => arg.value?.semanticSsaValueId ?? arg.value?.semanticValueId ?? arg.value?.id),
      abiPossibleArgumentValueIds: uncertainValueIds,
    };
    retainFacadeArgumentWrites(before, history);
    retainAbiBinding(projected, inst, binding, observer, history, 'call', inst.args.length ? 'bound' : 'empty');
  }
  return observer;
}

function typedResultIdentity(value) {
  if (!value) return null;
  return Object.freeze({ id:value.id, kind:value.kind, reg:value.reg ?? null, bits:value.bits ?? null,
    sourceEntityId:value.sourceEntityId ?? null, compatDerived:value.compatDerived ?? null,
    unknown:value.unknown === true, compatibilityShapeOnly:value.compatibilityShapeOnly === true });
}

function observeTypedResultSelection(projected) {
  const own = (object, key) => {
    const descriptor = object == null ? null : Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && !Object.hasOwn(descriptor, 'value')) throw Error('typed-result-selection-accessor');
    return descriptor?.value;
  };
  const values = own(projected, 'values'), length = own(values, 'length');
  if (!Array.isArray(values) || !Number.isSafeInteger(length) || length > 512) throw Error('typed-result-selection-budget');
  const fields = ['id', 'reg', 'sourceEntityId', 'def', 'version'];
  const facts = Array.from({ length }, (_, index) => {
    const value = own(values, String(index));
    return { value, fields:fields.map(key => own(value, key)) };
  });
  return () => {
    try { return own(projected, 'values') === values && own(values, 'length') === length
      && facts.every((fact, index) => own(values, String(index)) === fact.value
        && fields.every((key, i) => own(fact.value, key) === fact.fields[i])); }
    catch { return false; }
  };
}

function sealFacadeTypedResultHistory(projected, observer) {
  expectedFacadeTypedResults.set(projected, observer);
  if (!observer.count) return;
  try {
    const selection = observeTypedResultSelection(projected);
    const valid = observer.records.filter(event => event.source.op === LEGACY_OP.CALL && event.source.dst === event.output
      && event.output.def === event.source && event.output.reg === event.registerId && event.output.bits === event.bits
      && event.output.unknown === true && event.output.compatDerived === 'typed-abi-call-result'
      && event.source.returnReg === event.registerId && event.source.returnBits === event.bits
      && event.source.returnEvidence === event.evidence);
    const output = observeProjectedOperationData(projected, valid);
    const isCurrent = () => selection() && output();
    if (!isCurrent()) return;
    const history = Object.freeze({ events:Object.freeze(valid), isCurrent,
      completeness:valid.length === observer.count ? 'complete' : 'incomplete' });
    facadeTypedResultHistories.set(projected, { history, bySource:new Map(valid.map(event => [event.source,
      Object.freeze({ events:Object.freeze([event]), isCurrent })])) });
  } catch { /* Actual ABI view writes are unchanged; unavailable history stays explicit. */ }
}

function attachCanonicalTypedCallResults(projected, instructionByRow, adapter, options = {}, history = null) {
  const observer = { records:[], sources:new WeakSet(), count:0 };
  for (const inst of projected.instructions ?? []) {
    if (inst.op !== LEGACY_OP.CALL || inst.dst) continue;
    const decoded = instructionByRow.get(inst.row) ?? null;
    const prototype = (() => {
      try { return decoded == null ? null : options.callPrototypeFor?.(decoded.callTarget ?? null, decoded) ?? options.callPrototype ?? null; }
      catch { return null; }
    })();
    const result = adapter?.classifyCall?.({
      call:{ target:decoded?.callTarget ?? null, callPrototype:prototype },
    }) ?? null;
    // A legacy scalar destination is valid only for one complete canonical
    // register location. Aggregate/multi-register returns stay in the full
    // returnLocations metadata carried by the call node.
    const returnLocations = Array.isArray(result?.returnLocations) ? result.returnLocations : [];
    if (result?.unsupported === true
      || returnLocations.length !== 1
      || returnLocations[0]?.kind !== 'register'
      || returnLocations[0]?.aggregate === true
      || !result?.returnReg
      || String(returnLocations[0]?.reg ?? '') !== String(result.returnReg)) continue;
    const reg = String(result.returnReg);
    const bits = Number(result.returnBits || 64);
    const candidates = (projected.values ?? [])
      .filter((value) => value?.reg === reg
        && value?.sourceEntityId === inst.semanticNodeId
        && value?.def == null)
      .sort((left, right) => Number(right.id ?? -1) - Number(left.id ?? -1));
    const priorVersion = Math.max(-1, ...(projected.values ?? [])
      .filter((value) => value?.reg === reg)
      .map((value) => Number(value.version ?? -1)));
    const available = observer.records.length < 1024 && (projected.values?.length || 0) <= 512 && (inst.args?.length || 0) <= 512;
    const before = available ? typedResultIdentity(candidates[0]) : null;
    const candidateHistory = available ? Object.freeze(candidates.map(value => Object.freeze({ value, before:typedResultIdentity(value) }))) : null;
    const value = candidates[0] ?? {
      id: (projected.values ?? []).length,
      vid: (projected.values ?? []).length + 1,
      kind: LEGACY_VK.DEF,
      reg,
      stateKey: null,
      version: priorVersion + 1,
      bits,
      def: null,
      uses: [],
      const: null,
      range: null,
      signed: null,
      nullable: null,
      type: null,
      label: reg,
      semanticValueId: null,
      semanticSsaValueId: null,
      sourceEntityId: inst.semanticNodeId,
      machineType: null,
      origin: inst.origin ?? null,
      compatibilityShapeOnly: true,
    };
    const valueList = projected.values, valueLengthBefore = valueList.length;
    const fields = available || history && !history.unavailable ? [
      ...['dst', 'returnReg', 'returnBits', 'returnEvidence', 'extra'].map(key => [inst, key]),
      ...['kind', 'reg', 'bits', 'def', 'unknown', 'undefined', 'clobbered', 'compatDerived'].map(key => [value, key]),
      ...(!candidates[0] ? [[valueList, String(valueLengthBefore)], [valueList, 'length']] : []),
    ].map(([object, key]) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return { object, key, before:descriptor?.value, beforePresent:descriptor != null };
    }) : null;
    const removedFields = available ? Object.freeze(['undefined', 'clobbered'].filter(key => Object.hasOwn(value, key))) : null;
    if (!candidates[0]) projected.values.push(value);
    value.kind = LEGACY_VK.DEF;
    value.reg = reg;
    value.bits = bits;
    value.def = inst;
    value.unknown = true;
    delete value.undefined;
    delete value.clobbered;
    value.compatDerived = 'typed-abi-call-result';
    inst.dst = value;
    inst.returnReg = reg;
    inst.returnBits = bits;
    inst.returnEvidence = result.returnEvidence || `canonical-${adapter?.id || 'abi'}-call`;
    inst.extra = {
      ...(inst.extra ?? {}),
      compatTypedCallResult: true,
      compatTypedCallResultEvidence: inst.returnEvidence,
      returnLocations,
      returnPieces:result.returnPieces ?? null,
    };
    retainFacadeArgumentWrites(fields, history);
    observer.sources.add(inst); observer.count++;
    if (available) {
      const inputs = Object.freeze([...new Set(inst.args.map(arg => arg.value).filter(Boolean))]);
      observer.records.push(Object.freeze({ stage:'facade-typed-call-result', ordinal:observer.count - 1,
        source:inst, output:value, op:inst.op, sub:inst.sub,
        operation:candidates[0] ? 'attach-existing-typed-call-result' : 'attach-new-typed-call-result',
        before, after:typedResultIdentity(value), registerId:reg, bits, abiId:String(adapter?.id || 'abi'),
        evidence:inst.returnEvidence, candidates:candidateHistory, priorVersion, removedFields,
        valueList, valueLengthBefore, valueLengthAfter:valueList.length,
        valueWrites:Object.freeze(fields.filter(field => field.object === value).map(field => {
          const descriptor = Object.getOwnPropertyDescriptor(value, field.key);
          return Object.freeze({ ...field, after:descriptor?.value, afterPresent:descriptor != null });
        })),
        inputs:Object.freeze(inputs.map(value => Object.freeze({ value, definition:value.def }))), beforeInputs:inputs,
        object:Object.freeze({ candidates:candidateHistory, returnLocations, returnPieces:result.returnPieces ?? null }) }));
    }
  }
  return observer;
}

function valueMayCarryStackAddress(value, observation = null) {
  const proof = legacyStackPointerProvenanceOf(value);
  if (observation) observation.proof = proof ? Object.freeze({ ...proof }) : null;
  return proof?.must === true || proof?.may === true;
}

/*
 * Invalidate a legacy compatibility store link when an intervening call receives
 * a stack address. Canonical MemorySSA/forwarding evidence is not rewritten; this
 * conservative public-view clobber cannot issue a new alias or numeric theorem.
 */

function stackEscapeMemoryIdentity(memory) {
  return Object.freeze({ kind:memory?.kind ?? null, definitionId:memory?.definitionId ?? null,
    regionId:memory?.regionId ?? null, clobberingInstructionId:memory?.clobberingInstructionId ?? null,
    previousDefinitionId:memory?.previousDefinitionId ?? null, compatibilityDerived:memory?.compatibilityDerived === true,
    evidence:memory?.evidence ?? null });
}

function sealFacadeStackEscapeHistory(projected, observer) {
  expectedFacadeStackEscapes.set(projected, observer);
  if (!observer.count) return;
  try {
    const valid = observer.records.filter(event => event.source.op === LEGACY_OP.LOAD && event.source.dst === event.output
      && event.source.reachingStore === undefined && event.source.memUse === event.afterUse && event.source.extra === event.afterExtra
      && event.source.memoryForwarding === event.memory && event.call.op === LEGACY_OP.CALL
      && event.call.args[event.argumentIndex] === event.argument && event.argument.value === event.input
      && (event.proof?.must === true || event.proof?.may === true));
    if (!valid.length) return;
    const scanned = [...new Set(valid.flatMap(event => event.selection))];
    const output = observeProjectedOperationData(projected, [...valid,
      ...scanned.map(source => ({ source, beforeInputs:[] }))]);
    if (!output()) return;
    const history = Object.freeze({ events:Object.freeze(valid), isCurrent:output,
      completeness:valid.length === observer.count ? 'complete' : 'incomplete' });
    facadeStackEscapeHistories.set(projected, { history, bySource:new Map(valid.map(event => [event.source,
      Object.freeze({ events:Object.freeze([event]), isCurrent:output })])) });
  } catch { /* The actual conservative write remains; bounded history is unavailable. */ }
}

function invalidateEscapedStackForwarding(projected, history = null) {
  const observer = { records:[], sources:new WeakSet(), count:0 };
  for (const load of projected.instructions ?? []) {
    if (load.op !== LEGACY_OP.LOAD || load.loc?.kind !== LEGACY_MK.STACK || !load.reachingStore) continue;
    const store = load.reachingStore;
    const block = projected.blocks?.[load.block];
    if (!block || store.block !== load.block) continue;
    let available = observer.records.length < 1024 && Array.isArray(block.insts) && block.insts.length <= 512;
    const tested = [];
    for (const inst of block.insts ?? []) {
      if (Number(inst.row) <= Number(store.row) || Number(inst.row) >= Number(load.row)) continue;
      if (inst.op !== LEGACY_OP.CALL) continue;
      if (!(inst.args ?? []).some((arg, index) => {
        const value = arg?.value;
        if (tested.length >= 512) available = false;
        const observed = available ? { call:inst, argument:arg, argumentIndex:index, value } : null;
        const matches = valueMayCarryStackAddress(value, observed);
        if (observed) tested.push(Object.freeze(observed));
        return matches;
      })) continue;
      const priorMemoryUse = load.memUse ?? null;
      const beforeExtra = load.extra;
      const fields = history && !history.unavailable ? ['reachingStore', 'memUse', 'extra'].map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(load, key);
        return { object:load, key, before:descriptor?.value, beforePresent:descriptor != null };
      }) : null;
      load.reachingStore = undefined;
      load.memUse = {
        kind:'clobber',
        definitionId:null,
        regionId:priorMemoryUse?.regionId ?? load.loc?.regionId ?? null,
        clobberingInstructionId:inst.id,
        previousDefinitionId:priorMemoryUse?.definitionId ?? null,
        compatibilityDerived:true,
        evidence:'aapcs64-stack-argument-escape',
      };
      load.extra = {
        ...(load.extra ?? {}),
        compatStackEscapeInvalidation:true,
        compatStackEscapeCallInstructionId:inst.id,
        canonicalMemoryUseKind:priorMemoryUse?.kind ?? null,
        canonicalMemoryDefinitionId:priorMemoryUse?.definitionId ?? null,
      };
      retainFacadeArgumentWrites(fields, history);
      observer.sources.add(load); observer.count++;
      if (available) {
        const selected = tested[tested.length - 1];
        const values = [...new Set([load.addr?.base, ...(store.args || []).map(arg => arg.value), ...tested.map(test => test.value)].filter(Boolean))];
        if (values.length <= 512) observer.records.push(Object.freeze({ source:load, output:load.dst, store, call:inst,
          op:load.op, sub:load.sub, stage:'facade-stack-escape', ordinal:observer.count - 1,
          operation:'invalidate-escaped-stack-forwarding', input:selected.value, proof:selected.proof,
          argument:selected.argument, argumentIndex:selected.argumentIndex,
          beforeUse:priorMemoryUse, afterUse:load.memUse, beforeExtra, afterExtra:load.extra,
          before:stackEscapeMemoryIdentity(priorMemoryUse), after:stackEscapeMemoryIdentity(load.memUse),
          memory:load.memoryForwarding, related:Object.freeze([...new Set([store, ...tested.map(test => test.call)])]),
          inputs:Object.freeze(values.map(value => Object.freeze({ value, definition:value.def }))), beforeInputs:Object.freeze(values),
          selection:block.insts, object:Object.freeze({ before:priorMemoryUse, beforeExtra, selection:block.insts, tested:Object.freeze(tested) }),
        }));
      }
      break;
    }
  }
  return observer;
}

/**
 * Semantic IR return nodes carry the architectural control target (for A64 RET,
 * typically the link register). That is not a source-language return value.
 */
function attachCanonicalFunctionReturns(projected, adapter, options = {}, history = null) {
  const observer = abiBindingObserver(projected);
  const returnEvidence = (() => {
    try {
      const classified = adapter?.classifyFunctionReturn?.({
        functionPrototype:options.functionPrototype ?? null,
        returnType:options.returnType ?? null,
        returnClass:options.returnClass ?? null,
        returnBits:options.returnBits ?? null,
        returnsValue:options.returnsValue,
      });
      return classified?.evidence
        ?? (adapter?.id === 'aapcs64' ? 'prototype-aapcs64' : `canonical-${adapter?.id || 'abi'}-return`);
    } catch { return `canonical-${adapter?.id || 'abi'}-return`; }
  })();
  const locations = adapter?.returnLocations?.({
    functionPrototype:options.functionPrototype ?? null,
    returnType:options.returnType ?? null,
    returnClass:options.returnClass ?? null,
    returnBits:options.returnBits ?? null,
    returnsValue:options.returnsValue,
  }) ?? [];
  for (const inst of projected?.instructions ?? []) {
    if (inst.op !== LEGACY_OP.RET) continue;
    const binding = beginAbiBinding(inst, locations, observer);
    let outcome = 'no-scalar-location';
    const before = observeFacadeArguments(inst, history);
    try {
      detachLegacyArguments(inst);
      inst.returnReg = null;
      inst.returnEvidence = null;
      inst.extra = {
        ...(inst.extra ?? {}),
        abiReturnLocations:locations,
      };
      if (locations.length !== 1 || locations[0]?.kind !== 'register' || locations[0]?.aggregate === true) continue;
      const result = locations[0];
      const selection = binding.available ? { candidates:[], unavailable:false } : null;
      const bits = result.bits ?? null;
      const value = selectReachingRegisterValue(projected, inst, result.reg, bits, null, selection);
      outcome = value ? 'bound' : 'no-reaching-value';
      retainAbiSelection(binding, result, 0, result.reg, bits, selection, value, value ? 'selected' : 'no-reaching-value');
      if (!value) continue;
      inst.args = [{ value, bits:value.bits || result.bits || 64 }];
      if (!Array.isArray(value.uses)) value.uses = [];
      if (!value.uses.includes(inst)) value.uses.push(inst);
      inst.returnReg = result.reg;
      inst.returnEvidence = returnEvidence;
      inst.extra = {
        ...(inst.extra ?? {}),
        abiProjectedReturnValueId: value.semanticSsaValueId ?? value.semanticValueId ?? value.id,
        abiProjectedReturnEvidence: inst.returnEvidence,
      };
    } finally {
      retainFacadeArgumentWrites(before, history);
      retainAbiBinding(projected, inst, binding, observer, history, 'return', outcome);
    }
  }
  return observer;
}

function buildV2CompatFromLegacyModel(model, opts = {}) {
  if (!model?.instructions?.length) return null;
  const rowOfAddress = rowResolver(model, opts);
  const legacyCfg = opts.cfg ?? buildCfg(model, { rowOfAddress });
  const instructionByRow = new Map(model.instructions.map((instruction) => [instruction.row, instruction]));
  const blocks = legacyCfg.nodes.map((node) => {
    const instructions = [];
    for (let row = node.startRow; row <= node.endRow; row++) {
      const instruction = instructionByRow.get(row);
      if (!instruction || instruction.data) continue;
      instructions.push({
        decoded: instruction,
        address: instruction.address,
        size: 4,
        mode: 'a64',
      });
    }
    const first = instructions[0]?.decoded?.address;
    if (first == null) throw new TypeError('semantic-v2-compat-empty-basic-block');
    return {
      key: `legacy-block-${node.index}`,
      startAddress: first,
      instructions,
      successors: node.succ
        .filter((successor) => successor.to >= 0)
        .map((successor) => ({ to: `legacy-block-${successor.to}`, kind: edgeKind(successor) })),
    };
  });
  const binaryId = String(opts.binaryId ?? model.binaryId ?? ephemeralBinaryId(model));
  const sliceId = String(opts.sliceId ?? model.sliceId ?? `migration-slice-${stableDigest({ binaryId, architecture: 'arm64' })}`);
  const abiAdapter = opts.abiAdapter ?? canonicalCompatibilityAbiAdapter(opts, binaryId, sliceId);
  const result = buildSemanticV2CompatibilityPipeline({
    architecturePlugin: ARM64_ARCHITECTURE,
    decoderSemanticVersion: String(opts.decoderSemanticVersion ?? 'legacy-model-decoder-v1'),
    binaryId,
    sliceId,
    addressWidthBits: 64,
    canonicalStartIdentity: { address: model.startAddress ?? model.instructions[0].address },
    entryBlockKey: legacyCfg.entry >= 0 ? `legacy-block-${legacyCfg.entry}` : blocks[0]?.key,
    blocks,
    abiAdapter,
    rootDescriptorProvider: aapcs64RegionRootDescriptorProvider(opts, abiAdapter),
  }, {
    signal: opts.signal,
    semanticIrOptions: opts.semanticIrOptions,
    ssaOptions: opts.ssaOptions,
    memorySsaOptions: opts.memorySsaOptions,
    compatOptions: {
      rowOfNode(node) {
        const address = node?.origin?.virtualRanges?.[0]?.start;
        return address == null ? null : rowOfAddress(address);
      },
      textOfNode(node) {
        const address = node?.origin?.virtualRanges?.[0]?.start;
        const row = address == null ? null : rowOfAddress(address);
        const instruction = row == null ? null : instructionByRow.get(row);
        return instruction ? `${instruction.mnemonic} ${instruction.operands ?? ''}`.trim() : `semantic-v2 ${node.kind}`;
      },
      ...(opts.compatOptions ?? {}),
    },
  });
  if (typeof process !== 'undefined' && process.env?.HEX_DEBUG_C2_MEM === '1' && typeof process.stderr?.write === 'function') {
    process.stderr.write(JSON.stringify(result.memorySsa?.regions ?? [], null, 2) + '\n');
    process.stderr.write(JSON.stringify((result.memorySsa?.regions ?? []).filter((region) => region.kind === 'unknown').map((region) => {
      const sourceId = region.uncertaintyIdentity?.sourceEntityId;
      const node = result.semanticIr?.nodes?.find((candidate) => String(candidate.id) === String(sourceId));
      const addressId = node?.memory?.addressExpr?.valueId;
      const value = result.semanticIr?.values?.find((candidate) => String(candidate.id) === String(addressId));
      const definition = result.semanticIr?.nodes?.find((candidate) => String(candidate.id) === String(value?.definitionNodeId));
      const addressInputs = (definition?.inputs ?? []).map((inputId) => {
        const inputValue = result.semanticIr?.values?.find((candidate) => String(candidate.id) === String(inputId));
        const inputDefinition = result.semanticIr?.nodes?.find((candidate) => String(candidate.id) === String(inputValue?.definitionNodeId));
        return {
          valueId: inputValue?.id,
          valueKind: inputValue?.kind,
          definitionNodeId: inputValue?.definitionNodeId,
          definitionKind: inputDefinition?.kind,
          variable: inputDefinition?.variable?.physicalIdentity?.registerId ?? null,
        };
      });
      const stateUses = (result.ssa?.uses ?? []).filter((use) => String(use.sourceEntityId) === String(definition?.inputs?.[0] ?? sourceId));
      const readNodeIds = new Set(addressInputs.filter((input) => input.definitionKind === 'state-read').map((input) => String(input.definitionNodeId)));
      const readUses = (result.ssa?.uses ?? []).filter((use) => readNodeIds.has(String(use.sourceEntityId)));
      const readValueIds = new Set(readUses.map((use) => String(use.valueId)));
      const pointerValue = result.semanticIr?.values?.find((candidate) => String(candidate.id) === 'semantic_value_3badd2c473b95936bb72aa67d5fb1655');
      const pointerDefinition = result.semanticIr?.nodes?.find((candidate) => String(candidate.id) === String(pointerValue?.definitionNodeId));
      const scalarUses = (result.ssa?.uses ?? []).filter((use) => String(use.sourceEntityId) === String(node?.id));
      const relevantIds = new Set(scalarUses.map((use) => String(use.valueId)));
      return {
        region: { id: region.id, kind: region.kind, widthBits: region.widthBits },
        node: { id: node?.id, kind: node?.kind, inputs: node?.inputs, address: node?.memory?.addressExpr },
        addressValue: { id: value?.id, definitionNodeId: value?.definitionNodeId },
        addressDefinition: { id: definition?.id, kind: definition?.kind, inputs: definition?.inputs },
        addressInputs,
        scalarSsa: {
          uses: scalarUses.map((use) => ({ sourceEntityId: use.sourceEntityId, valueId: use.valueId, kind: use.proof?.kind, sem: use.proof?.sourceSemanticValueId })),
          definitions: (result.ssa?.definitions ?? []).filter((candidate) => relevantIds.has(String(candidate.valueId))).map((candidate) => ({ valueId: candidate.valueId, kind: candidate.kind, src: candidate.sourceEntityId, proof: candidate.proof?.kind, sem: candidate.proof?.sourceSemanticValueId })),
        },
        readSsa: {
          uses: readUses.map((use) => ({ sourceEntityId: use.sourceEntityId, valueId: use.valueId, kind: use.proof?.kind, sem: use.proof?.sourceSemanticValueId })),
          definitions: (result.ssa?.definitions ?? []).filter((candidate) => readValueIds.has(String(candidate.valueId))).map((candidate) => ({ valueId: candidate.valueId, kind: candidate.kind, src: candidate.sourceEntityId, proof: candidate.proof?.kind, sem: candidate.proof?.sourceSemanticValueId })),
        },
        pointerSource: {
          value: pointerValue ? { id: pointerValue.id, definitionNodeId: pointerValue.definitionNodeId, variableKey: pointerValue.variableKey } : null,
          definition: pointerDefinition ? { id: pointerDefinition.id, kind: pointerDefinition.kind, variable: pointerDefinition.variable?.physicalIdentity?.registerId ?? null, inputs: pointerDefinition.inputs } : null,
        },
        stateUses,
      };
    }), null, 2) + '\n');
    process.stderr.write(JSON.stringify(result.memorySsa?.accessMetadata?.filter((item) => item.entityKind === 'use' && item.sourceKind === 'load').map((item) => ({
      id: item.memorySsaEntityId,
      node: item.nodeId,
      region: item.regionId,
      range: item.byteRange,
      proof: item.rangeProof,
      coverage: result.memorySsa.byteCoverage?.find((coverage) => String(coverage.useId) === String(item.memorySsaEntityId)),
    })), null, 2) + '\n');
  }
  const stateSource = projectedStateTransitionCandidates(result.legacyV1);
  const constantCandidates = new Map(), constantChecks = new Map();
  for (const source of result.legacyV1.instructions) {
    const candidate = projectedConstantTransitionCandidate(result.legacyV1, source);
    if (!candidate) continue;
    if (!constantChecks.has(candidate.isCurrent)) constantChecks.set(candidate.isCurrent, candidate.isCurrent());
    if (constantChecks.get(candidate.isCurrent)) constantCandidates.set(source, candidate);
  }
  const currentStateSource = stateSource?.isCurrent() ? stateSource : null;
  const stateHistory = { source:currentStateSource, writes:[], unavailable:false };
  const preservedStateObserver = restoreCanonicalPreservedStateReads(result.legacyV1, abiAdapter, stateHistory);
  const locationObserver = restoreAapcs64PublicLocations(result.legacyV1, stateHistory);
  const constantObserver = propagateExactLegacyConstants(result.legacyV1, stateHistory);
  const callBindingObserver = attachCanonicalCallArguments(result.legacyV1, stateHistory);
  const typedResultObserver = attachCanonicalTypedCallResults(result.legacyV1, instructionByRow, abiAdapter, opts, stateHistory);
  const stackEscapeObserver = invalidateEscapedStackForwarding(result.legacyV1, stateHistory);
  const returnBindingObserver = attachCanonicalFunctionReturns(result.legacyV1, abiAdapter, opts, stateHistory);
  sealFacadeStateTransitions(result.legacyV1, stateHistory);
  sealFacadeProjectedConstants(result.legacyV1, stateHistory, constantCandidates);
  sealFacadeConstantTransitions(result.legacyV1, constantObserver);
  sealFacadePreservedStateHistory(result.legacyV1, preservedStateObserver, constantObserver, typedResultObserver);
  sealFacadeLocationHistory(result.legacyV1, locationObserver, stackEscapeObserver);
  sealFacadeTypedResultHistory(result.legacyV1, typedResultObserver);
  sealFacadeStackEscapeHistory(result.legacyV1, stackEscapeObserver);
  sealFacadeAbiBindings(result.legacyV1, callBindingObserver, returnBindingObserver, typedResultObserver, stateHistory);
  if (typeof process !== 'undefined' && process.env?.HEX_DEBUG_C2_LEGACY === '1' && typeof process.stderr?.write === 'function') {
    process.stderr.write(JSON.stringify(result.legacyV1.instructions.filter((item) => item.op === 'load').map((item) => ({
      row: item.row,
      loc: item.loc?.key,
      fwd: item.memoryForwarding?.status,
      reason: item.memoryForwarding?.reason,
      reach: item.reachingStore?.row,
      context: item.memoryForwardingContext,
    })), null, 2) + '\n');
  }
  lastSemanticV2Instrumentation = result.instrumentation;
  return result.legacyV1;
}

/**
 * Explicit semantic-engine dispatch. No v2 exception is caught and rerouted to
 * legacy; semantic-v2-compat either returns its compatibility projection or
 * fails/returns explicit unknowns from the v2 pipeline.
 */
export function buildIR(model, opts = {}) {
  const mode = normalizeMode(opts.semanticMigrationMode);
  if (mode === SEMANTIC_V2_MIGRATION_MODES.LEGACY) return buildLegacyIR(model, opts);
  lastSemanticV2Instrumentation = null;
  return buildV2CompatFromLegacyModel(model, opts);
}
