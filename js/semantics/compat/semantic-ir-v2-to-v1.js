import { isCanonicalSemanticIrProducerArtifact, validateSemanticIrFunction } from '../ir/index.js';
import { createSemanticSsaContract } from '../ssa/contract.js';
import { createMemorySsaContract } from '../memoryssa/contract.js';
import {
  V1_OP, V1_VK, V1_MK, firstAddress, sourceInstructionIds, blockOrder, explicitTargetsForBlock,
  graphFacts, buildLegacyValues, buildStateProjectionIndex, legacyPublicStateIdentity, makeArg, addUse,
  classifyCallWithAbi, safeBigInt,
} from './semantic-ir-v2-to-v1-core.js';
import { projectNode } from './semantic-ir-v2-to-v1-nodes.js';
import { finalizeLegacyProjection } from './semantic-ir-v2-to-v1-finalize.js';
import {
  attachMemorySsa, attachFallbackMemory, addScalarSsaPhis, appendFunctionUnknowns,
  assignInstructionIds, memorySafetySummary,
} from './semantic-ir-v2-to-v1-memory.js';
import { isCanonicalMemorySsaProducerArtifact } from '../memoryssa/build.js';
import { isCanonicalSemanticSsaProducerArtifact } from '../ssa/build.js';
import { createProjectionIrObserver, PROJECTION_LIMITS } from '../../core/identity/live-data.js';
import { observedRangeAnnotationsMatch } from './legacy-value-ranges.js';

const memoryOperandTransitions = new WeakMap();
const expectedMemoryOperandTransitions = new WeakMap();
const constantTransitions = new WeakMap();
const expectedConstantTransitions = new WeakMap();
const stateTransitions = new WeakMap();
const expectedStateTransitions = new WeakMap();
const expectedStateNormalizations = new WeakMap();

// Reuse only the composed write-list identity, never a match result. Internal
// transition/range histories publish frozen arrays, so their contents cannot
// change between validation calls. Stable list identity lets the existing
// synchronous validation batch recognize repeated exact write sets instead of
// missing on a freshly allocated spread array every time.
const composedFrozenWriteLists = new WeakMap();
function combinedWriteList(writes, following) {
  if (!Array.isArray(writes) || !Array.isArray(following)) return null;
  if (!Object.isFrozen(writes) || !Object.isFrozen(following)) return [...writes, ...following];
  let perFollowing = composedFrozenWriteLists.get(writes);
  if (!perFollowing) composedFrozenWriteLists.set(writes, perFollowing = new WeakMap());
  let combined = perFollowing.get(following);
  if (!combined) {
    combined = Object.freeze([...writes, ...following]);
    perFollowing.set(following, combined);
  }
  return combined;
}

// Producer identity only, not a currentness or semantic-equivalence claim.
export function isIssuedSemanticProjection(projected) {
  return expectedStateTransitions.has(projected);
}

// Shared pure-data observation for projector and facade operation issuers. This
// function registers nothing: only private owning call sites issue records;
// obtaining a data matcher cannot attach/reseal a public or copied history.
export function observeProjectedOperationData(projected, transitions) {
  const own = (object, key) => Object.getOwnPropertyDescriptor(object, key)?.value;
  const rootKeys = ['instructions', 'values', 'blocks', 'compat', 'functionId', 'semanticIrVersion', 'origin'];
  const prototype = Object.getPrototypeOf(projected);
  const roots = rootKeys.map(key => own(projected, key));
  const blockById = new Map();
  for (let i = 0; i < projected.blocks.length; i += 1) {
    const b = projected.blocks[i];
    if (!blockById.has(b.index)) blockById.set(b.index, { block: b, blockIndex: i, phiIndex: null, instIndex: null });
  }
  const flatIndexByInst = new Map();
  for (let i = 0; i < projected.instructions.length; i += 1) {
    const inst = projected.instructions[i];
    if (!flatIndexByInst.has(inst)) flatIndexByInst.set(inst, i);
  }
  const valueIndexByVal = new Map();
  for (let i = 0; i < projected.values.length; i += 1) {
    const val = projected.values[i];
    if (!valueIndexByVal.has(val)) valueIndexByVal.set(val, i);
  }
  const uniqueInsts = new Set();
  const uniqueVals = new Set();
  for (let i = 0; i < transitions.length; i += 1) {
    const t = transitions[i];
    if (t.source) {
      uniqueInsts.add(t.source);
      if (t.source.dst) uniqueVals.add(t.source.dst);
    }
    if (t.store) uniqueInsts.add(t.store);
    if (t.input) {
      uniqueVals.add(t.input);
      if (t.input.def) uniqueInsts.add(t.input.def);
    }
    const bi = t.beforeInputs;
    if (bi) {
      for (let j = 0; j < bi.length; j += 1) {
        const v = bi[j];
        if (v) {
          uniqueVals.add(v);
          if (v.def) uniqueInsts.add(v.def);
        }
      }
    }
  }
  const locations = [];
  const blockListChecks = [];
  const seenBlockList = new Map();
  for (const instruction of uniqueInsts) {
    const bInfo = blockById.get(instruction.block);
    const block = bInfo?.block;
    const blockIndex = bInfo ? bInfo.blockIndex : -1;
    let key = 'insts';
    let index = -1;
    if (block) {
      if (block.phis && block.phis.length > 0) {
        if (bInfo.phiIndex === null) {
          const m = new Map();
          for (let i = 0; i < block.phis.length; i += 1) if (!m.has(block.phis[i])) m.set(block.phis[i], i);
          bInfo.phiIndex = m;
        }
        const pi = bInfo.phiIndex.get(instruction);
        if (pi !== undefined) { key = 'phis'; index = pi; }
      }
      if (index < 0 && block.insts) {
        if (bInfo.instIndex === null) {
          const m = new Map();
          for (let i = 0; i < block.insts.length; i += 1) if (!m.has(block.insts[i])) m.set(block.insts[i], i);
          bInfo.instIndex = m;
        }
        const ii = bInfo.instIndex.get(instruction);
        if (ii !== undefined) index = ii;
      }
    }
    const list = block?.[key];
    const flatIndex = flatIndexByInst.get(instruction) ?? -1;
    if (!(index >= 0) || flatIndex < 0) throw new Error('compat-transition-definition-missing');
    const blKey = `${blockIndex}:${key}`;
    if (!seenBlockList.has(blKey)) {
      const check = { blockIndex, block, blockId: block.index, key, list };
      seenBlockList.set(blKey, check);
      blockListChecks.push(check);
    }
    locations.push({ instruction, blockIndex, block, blockId: block.index, key, list, index, flatIndex });
  }
  const values = [];
  for (const value of uniqueVals) {
    const index = valueIndexByVal.get(value) ?? -1;
    if (index < 0) throw new Error('compat-transition-value-missing');
    values.push({ value, index });
  }
  // Transition roots are vertices of one cyclic SSA graph. Observe every
  // mutable field by distance from these exact roots, with a fresh observer.
  // Immutable descriptions have separately bounded data certificates; origins
  // also retain their normalization guards. Exact references, not equal IDs,
  // bind these descriptions; shallow freezes remain live observations.
  // Unrelated projection members are not additional observation roots.
  const captured = createProjectionIrObserver().captureCertifiedDataGraph([projected.compat,
    ...transitions.flatMap(({ source, store, input, beforeInputs, memory, object, emptyUses }) => [source, store, input, ...beforeInputs, memory, object, emptyUses])]);
  const matches = (writes = null) => {
    if (writes != null && (!Array.isArray(writes) || writes.length > PROJECTION_LIMITS.nodes)) return false;
    if (Object.getPrototypeOf(projected) !== prototype) return false;
    for (let i = 0; i < rootKeys.length; i += 1) {
      if (own(projected, rootKeys[i]) !== roots[i]) return false;
    }
    const rootValues = roots[1];
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i];
      if (own(rootValues, v.index) !== v.value) return false;
    }
    const rootBlocks = roots[2];
    for (let i = 0; i < blockListChecks.length; i += 1) {
      const b = blockListChecks[i];
      if (own(rootBlocks, b.blockIndex) !== b.block || own(b.block, 'index') !== b.blockId || own(b.block, b.key) !== b.list) return false;
    }
    const rootInsts = roots[0];
    for (let i = 0; i < locations.length; i += 1) {
      const loc = locations[i];
      if (own(loc.list, loc.index) !== loc.instruction || own(rootInsts, loc.flatIndex) !== loc.instruction) return false;
    }
    return writes == null ? captured.matches() || observedRangeAnnotationsMatch(projected, captured)
      : captured.matchesThroughWrites(writes) || observedRangeAnnotationsMatch(projected,
        { matchesThroughWrites:ranges => captured.matchesThroughWrites(combinedWriteList(writes, ranges)) });
  };
  // The ordinary predicate remains strict even if a caller passes arguments.
  // The separate method is only a pure-data comparison, never write authority.
  const workItems = captured.metrics.nodes + captured.metrics.edges + roots.length
    + values.length + locations.length * 8 + (captured.originCertification?.envelopes ?? 0)
    + (captured.dataCertification?.envelopes ?? 0);
  return Object.freeze(Object.assign(() => matches(), { workItems, matchesThroughWrites:writes => matches(writes) }));
}

// Private finalization is the issuer. Calling attachMemorySsa separately or
// copying its descriptions cannot register a transition on another projection.
function sealMemoryOperandTransitions(projected, transitions) {
  if (!transitions?.length) return;
  expectedMemoryOperandTransitions.set(projected, new WeakSet(transitions.map(transition => transition.source)));
  try {
    const valid = transitions.filter(({ source, input, store, proof, memory }) => source?.op === V1_OP.MOV
      && source.sub === 'memory-forward' && source.memoryOperandForwarding === proof
      && source.extra?.memoryOperandForwarding === proof && source.extra?.originalMemoryOp === V1_OP.LOAD
      && source.extra?.memoryAccess === memory && source.semanticNodeId === proof.loadSourceEntityId
      && source.dst?.semanticValueId === proof.outputValueId && input?.semanticValueId === proof.storedValueId
      && source.args?.length === 1 && source.args[0]?.value === input
      && store?.op === V1_OP.STORE && store.semanticNodeId === proof.storedSourceEntityId
      && store.args?.[0]?.value === input);
    const isCurrent = observeProjectedOperationData(projected, valid);
    const records = new Map();
    for (const transition of valid) records.set(transition.source, Object.freeze({ ...transition, isCurrent }));
    memoryOperandTransitions.set(projected, records);
  } catch {
    // The projection is still returned unchanged. Missing bounded observation
    // cannot be relabelled complete by a later reader of public proof metadata.
  }
}

export function readProjectedMemoryOperandTransition(projected, instruction) {
  const record = projectedMemoryOperandTransitionCandidate(projected, instruction);
  return record?.isCurrent() ? record : null;
}

// Descriptions are not current authority. The owning facade must validate the
// predecessor before its writes and retain the exact observed write handoff.
export function projectedMemoryOperandTransitionCandidate(projected, instruction) {
  return memoryOperandTransitions.get(projected)?.get(instruction) ?? null;
}

export function projectedMemoryOperandTransitionExpected(projected, instruction) {
  return expectedMemoryOperandTransitions.get(projected)?.has(instruction) === true;
}

function sealConstantTransitions(projected, observer) {
  expectedConstantTransitions.set(projected, observer.expected);
  if (!observer.records.length) return;
  try {
    const state = stateTransitions.get(projected), aliasedSources = new Set();
    let stateCurrent = null;
    const matchesInput = (source, input, index) => {
      if (input.argument?.value === input.value) return true;
      const history = state?.get(input.argument);
      if (!history || !(stateCurrent ??= state.isCurrent())) return false;
      let expected = input.value, written = false;
      for (const event of history.events) {
        if (event.kind !== 'resolve-state-alias' || event.source !== source || event.object !== input.argument
          || event.key !== 'value' || event.path !== `args:${index}`) continue;
        if (event.before !== expected) return false;
        expected = event.after; written = true;
      }
      if (!written || input.argument.value !== expected) return false;
      aliasedSources.add(source);
      return true;
    };
    const grouped = new Map();
    for (const event of observer.records) {
      if (!grouped.has(event.source)) grouped.set(event.source, []);
      grouped.get(event.source).push(event);
    }
    const valid = [...grouped].filter(([source, events]) => !observer.unavailable.has(source)
      && source.dst?.const === events.at(-1).afterConstant
      && events.every(event => source.dst === event.output && source.op === event.op && source.sub === event.sub
        && source.dst.bits === event.bits && source.args?.length === event.inputs.length
        && event.inputs.every((input, i) => source.args[i] === input.argument && matchesInput(source, input, i)
          && input.value?.def === input.definition)
        && (event.op !== V1_OP.LOAD || source.memoryForwarding === event.memoryForwarding)));
    const output = observeProjectedOperationData(projected, valid.flatMap(([, events]) => events));
    // Keep the original constant reads/operations. Only the already-issued
    // state writer can account for intervening argument aliases; a matching
    // scalar constant or public alias annotation is not a handoff.
    const aliased = valid.some(([source]) => aliasedSources.has(source));
    const isCurrent = !aliased ? output : Object.freeze(Object.assign(() => state.isCurrent() && output(), {
      matchesThroughWrites:writes => state.matchesThroughWrites(writes) && output.matchesThroughWrites(writes),
    }));
    constantTransitions.set(projected, new Map(valid.map(([source, events]) => [source,
      Object.freeze({ source, events:Object.freeze(events), isCurrent })])));
  } catch {
    // Preserve the scalar result. Unavailable observation remains expected and
    // cannot be reissued from a later public constant or copied description.
  }
}

export function readProjectedConstantTransitions(projected, instruction) {
  const record = projectedConstantTransitionCandidate(projected, instruction);
  return record?.isCurrent() ? record : null;
}

// Unvalidated owning descriptions for a private construction transaction. The
// public current reader above and every publishing consumer retain validation.
export function projectedConstantTransitionCandidate(projected, instruction) {
  return constantTransitions.get(projected)?.get(instruction) ?? null;
}

export function projectedConstantTransitionExpected(projected, instruction) {
  return expectedConstantTransitions.get(projected)?.has(instruction) === true;
}

function sealStateTransitions(projected, observer) {
  expectedStateTransitions.set(projected, observer.expected);
  expectedStateNormalizations.set(projected, observer.publicStateExpected || 0);
  if (!observer.records.length) return;
  try {
    const finalIdentity = new Map();
    for (const event of observer.records) if (event.identity) {
      if (!finalIdentity.has(event.output)) finalIdentity.set(event.output, new Map());
      for (const key of event.identityFields) finalIdentity.get(event.output).set(key, event.after[key]);
    }
    const own = (object, key) => Object.getOwnPropertyDescriptor(object, key)?.value;
    const eligible = new Set(observer.records.filter(event => !event.keys.some(key => observer.unavailable.has(key))
      && event.source?.op === event.op && event.source?.sub === event.sub
      && event.inputs.every(input => input.value.def === input.definition)
      && (event.kind !== 'suppress-unused-entry-state' || event.output.uses === event.emptyUses && !event.emptyUses?.length)
      && (event.identity ? [...finalIdentity.get(event.output)].every(([key, value]) => own(event.output, key) === value)
        : own(event.object, event.key) === event.after)));
    const accepted = new Set();
    for (const event of eligible) if (!event.causes?.some(cause => !accepted.has(cause))) accepted.add(event);
    const valid = [...accepted];
    const observation = observeProjectedOperationData(projected, valid);
    const locations = projected.locations;
    const locBaseEvents = valid.filter(event => event.path === 'locations:base');
    let mapped = [];
    if (locBaseEvents.length > 0) {
      const entriesByValue = new Map();
      for (const entry of Map.prototype.entries.call(locations)) {
        let bucket = entriesByValue.get(entry[1]);
        if (!bucket) { bucket = []; entriesByValue.set(entry[1], bucket); }
        bucket.push(entry);
      }
      for (let i = 0; i < locBaseEvents.length; i += 1) {
        const entries = entriesByValue.get(locBaseEvents[i].object);
        if (!entries || !entries.length) throw new Error('state-alias-location-missing');
        for (let j = 0; j < entries.length; j += 1) mapped.push(entries[j]);
      }
    }
    const mappedCurrent = () => !mapped.length || own(projected, 'locations') === locations
      && mapped.every(([key, value]) => Map.prototype.get.call(locations, key) === value);
    const isCurrent = () => observation() && mappedCurrent();
    const records = new Map();
    for (const event of valid) for (const key of event.keys) {
      if (!records.has(key)) records.set(key, []);
      records.get(key).push(event);
    }
    const byKey = new Map([...records].map(([key, events]) => [key,
      Object.freeze({ events:Object.freeze(events), isCurrent })]));
    const normalized = Object.freeze(valid.filter(event => event.stage === 'public-state-normalization'));
    const normalization = Object.freeze({ events:normalized, isCurrent,
      completeness:normalized.length === (observer.publicStateExpected || 0) ? 'complete' : 'incomplete' });
    stateTransitions.set(projected, Object.freeze({ get:key => byKey.get(key) ?? null, isCurrent, normalization,
      // Pure data matching is not write authority. Only the private facade
      // writer can issue a successor after observing its actual argument writes.
      matchesThroughWrites:writes => observation.matchesThroughWrites(writes) && mappedCurrent() }));
  } catch { /* State projection is unchanged; missing history remains expected. */ }
}

export function readProjectedStateTransitions(projected, source) {
  const record = projectedStateTransitionCandidates(projected)?.get(source);
  return record?.isCurrent() ? record : null;
}

// Private-producer descriptions, NOT a current certificate. Consumers must
// validate each selected record before use and again after their callbacks.
export function projectedStateTransitionCandidates(projected) {
  return stateTransitions.get(projected) ?? null;
}

export function readProjectedStateNormalization(projected) {
  if (!projectedStateNormalizationExpected(projected)) return null;
  const record = stateTransitions.get(projected)?.normalization;
  return record?.isCurrent() ? record : null;
}

export function projectedStateNormalizationExpected(projected) {
  return (expectedStateNormalizations.get(projected) || 0) > 0;
}

export function projectedStateTransitionExpected(projected, source) {
  return expectedStateTransitions.get(projected)?.has(source) === true;
}

function rowForNode(node, fallback, options) {
  if (typeof options.rowOfNode === 'function') {
    const value = options.rowOfNode(node);
    if (Number.isSafeInteger(value)) return value;
  }
  return fallback;
}

function semanticSsaContractInput(input) {
  return {
    contractVersion: input.contractVersion,
    functionId: input.functionId,
    definitions: input.definitions,
    uses: input.uses,
  };
}

function memorySsaContractInput(input) {
  return {
    contractVersion: input.contractVersion,
    functionId: input.functionId,
    regions: input.regions,
    definitions: input.definitions,
    uses: input.uses,
  };
}

// Keep the validated MemorySSA contract as the canonical semantic object while
// carrying its proof-bearing query indexes through the compatibility boundary.
// These fields are produced by the MemorySSA builder; they are not a second
// memory model and are deliberately copied without interpretation here.
function memorySsaProjectionArtifact(input, contract) {
  if (!input || typeof input !== 'object') return contract;
  const artifact = { ...contract };
  for (const key of [
    'buildVersion', 'accessMetadata', 'byteCoverage', 'identity', 'snapshotId',
    'canonicalIrIdentity', 'canonicalAccessBindings', 'completeness', 'status', 'unknowns', 'cancelled', 'truncated',
    'useDefLinks', 'defUseLinks', 'blockStates', 'canonicalDigest',
  ]) {
    if (Object.hasOwn(input, key)) artifact[key] = input[key];
  }
  return artifact;
}

function sameInstruction(node, instructionIds) {
  return sourceInstructionIds(node.origin).some((id) => instructionIds.has(id));
}

/**
 * Generic SSA represents an unseeded physical-state entry as an explicit undef.
 * Legacy v1 represents that same incoming symbolic machine state as version-0
 * ARG. This is a shape projection only: no concrete value or ABI role is added.
 */
function preserveIncomingPhysicalState(ssa, valuesById) {
  for (const definition of ssa?.definitions ?? []) {
    if (!definition.variableKey || definition.proof?.kind !== 'implicit-undef') continue;
    const value = valuesById.get(definition.valueId);
    if (!value) continue;
    value.kind = V1_VK.ARG;
    value.version = 0;
    delete value.undefined;
  }
}

/**
 * A state-read result is a value produced while observing physical state, not a
 * second public write to that state. When the same machine operation both reads
 * and writes one physical state identity (for example a read/modify/select/write
 * operation), keeping the read result's legacy `reg` creates two same-row public
 * definitions and can hide the proven write from legacy reaching-value queries.
 *
 * MachineEffects v1 already represents register-read results as temporaries. Do
 * the equivalent projection here only when the canonical origins prove that a
 * read and write belong to the same machine operation and physical identity.
 * The physical identity remains available on the state-read instruction and on
 * its reaching state SSA value; no architecture name or mnemonic is consulted.
 */
function preserveStateReadTemporaryIdentity(ir, valuesById) {
  const writes = new Set();
  for (const node of ir.nodes) {
    if (node.kind !== 'state-write') continue;
    const identity = legacyPublicStateIdentity(node.variable);
    if (!identity) continue;
    for (const instructionId of sourceInstructionIds(node.origin)) writes.add(`${instructionId}\u0000${identity}`);
  }
  if (!writes.size) return;

  for (const node of ir.nodes) {
    if (node.kind !== 'state-read') continue;
    const identity = legacyPublicStateIdentity(node.variable);
    if (!identity) continue;
    const sameOperationWrite = sourceInstructionIds(node.origin)
      .some((instructionId) => writes.has(`${instructionId}\u0000${identity}`));
    if (!sameOperationWrite) continue;
    for (const outputId of node.outputs ?? []) {
      const value = valuesById.get(outputId);
      if (!value) continue;
      value.reg = null;
      value.stateKey = null;
      value.version = 0;
      if (value.label === identity) value.label = node.id;
      value.compatDerived = 'state-read-temporary';
    }
  }
}

/**
 * Semantic IR separates a computed value from the following physical state
 * assignment. Legacy v1 names the computed destination itself with the register
 * identity. Restore that public role only when canonical SSA proves an exact
 * state-write assignment, the producer and write come from the same machine
 * instruction, and their widths are identical. This deliberately excludes
 * architectural view conversions such as W32 -> X64 zero-extension.
 */
function preserveExactStateWriteSourceIdentity(ir, producerByValueId, stateProjection, valuesById) {
  for (const node of ir.nodes) {
    if (node.kind !== 'state-write' || node.completeness !== 'complete' || node.inputs?.length !== 1) continue;
    if (node.variable?.physicalIdentity?.kind !== 'register') continue;
    const definition = stateProjection.writeDefinitionByNodeId.get(node.id) ?? null;
    if (!definition || definition.proof?.sourceSemanticValueId !== node.inputs[0]) continue;
    const source = valuesById.get(node.inputs[0]) ?? null;
    const destination = valuesById.get(definition.valueId) ?? null;
    const producer = producerByValueId.get(node.inputs[0]) ?? null;
    const identity = legacyPublicStateIdentity(node.variable);
    if (!source || !destination || !producer || !identity || source.bits !== destination.bits) continue;
    const instructionIds = new Set(sourceInstructionIds(node.origin));
    if (!instructionIds.size || !sameInstruction(producer, instructionIds)) continue;
    if (source.reg != null && source.reg !== identity) continue;
    source.reg = identity;
    if (source.label == null || source.label === producer.id) source.label = identity;
    source.compatDerived = 'exact-state-write-source';
  }
}

const compatBlockInstIndexCache = new WeakMap();
function compatBlockInstIndexOf(blockInsts, inst) {
  if (!Array.isArray(blockInsts) || !inst) return -1;
  let entry = compatBlockInstIndexCache.get(blockInsts);
  if (!entry || entry.length !== blockInsts.length) {
    const map = new Map();
    for (let i = 0; i < blockInsts.length; i += 1) {
      if (!map.has(blockInsts[i])) map.set(blockInsts[i], i);
    }
    entry = { length: blockInsts.length, map };
    compatBlockInstIndexCache.set(blockInsts, entry);
  }
  const idx = entry.map.get(inst);
  if (idx !== undefined && blockInsts[idx] === inst) return idx;
  return blockInsts.indexOf(inst);
}

function valueDominatesInstruction(value, inst, projected) {
  if (!value || !inst) return false;
  if (value.kind === V1_VK.ARG) return true;
  const definition = value.def;
  if (!definition || definition === inst) return false;
  if (definition.block === inst.block) {
    if (inst.op === V1_OP.PHI) return false;
    if (definition.op === V1_OP.PHI) return true;
    const defRow = Number(definition.row);
    const instRow = Number(inst.row);
    if (defRow !== instRow) return defRow < instRow;
    const blockInsts = projected.blocks?.[inst.block]?.insts;
    if (!Array.isArray(blockInsts)) return false;
    const defIdx = compatBlockInstIndexOf(blockInsts, definition);
    const instIdx = compatBlockInstIndexOf(blockInsts, inst);
    if (defIdx < 0 || instIdx < 0) return false;
    return defIdx < instIdx;
  }
  const dominators = projected.dominators?.[inst.block];
  return dominators instanceof Set && dominators.has(definition.block);
}

function abiRegisterDescriptors(argument) {
  if (!argument || typeof argument !== 'object') return [];
  if (argument.reg != null) return [{ reg: String(argument.reg), bits: Number(argument.bits ?? 0) || null }];
  if (!Array.isArray(argument.regs)) return [];
  return argument.regs.filter(Boolean).map((reg) => ({ reg: String(reg), bits: Number(argument.bits ?? 0) || null }));
}

function buildValuesByRegIndex(projected) {
  const valuesByReg = new Map();
  for (const value of projected.values) {
    if (value.reg == null) continue;
    let bucket = valuesByReg.get(value.reg);
    if (!bucket) {
      bucket = [];
      valuesByReg.set(value.reg, bucket);
    }
    bucket.push(value);
  }
  return valuesByReg;
}

function dominanceRankForArgument(value, inst, projected, targetBits) {
  const width = targetBits == null || value.bits === targetBits ? 1 : 0;
  const version = value.version ?? 0;
  const id = value.id ?? 0;
  if (value.kind === V1_VK.ARG || !value.def) {
    return { scope: 0, depth: 0, row: Number.NEGATIVE_INFINITY, nonPhi: 0, instIndex: -1, width, version, id };
  }
  const definition = value.def;
  const nonPhi = definition.op === V1_OP.PHI ? 0 : 1;
  const blockInsts = projected.blocks?.[definition.block]?.insts;
  const instIndex = nonPhi ? compatBlockInstIndexOf(blockInsts, definition) : -1;
  const row = Number(definition.row ?? Number.NEGATIVE_INFINITY);
  if (definition.block === inst.block) {
    return { scope: 2, depth: Number.MAX_SAFE_INTEGER, row, nonPhi, instIndex, width, version, id };
  }
  const defDominators = projected.dominators?.[definition.block];
  const depth = defDominators instanceof Set ? defDominators.size : 0;
  return { scope: 1, depth, row, nonPhi, instIndex, width, version, id };
}

function isBetterDominanceRank(candidate, best) {
  if (!best) return true;
  if (candidate.scope !== best.scope) return candidate.scope > best.scope;
  if (candidate.depth !== best.depth) return candidate.depth > best.depth;
  if (candidate.row !== best.row) return candidate.row > best.row;
  if (candidate.nonPhi !== best.nonPhi) return candidate.nonPhi > best.nonPhi;
  if (candidate.instIndex !== best.instIndex) return candidate.instIndex > best.instIndex;
  if (candidate.width !== best.width) return candidate.width > best.width;
  if (candidate.version !== best.version) return candidate.version > best.version;
  return candidate.id > best.id;
}

function projectedAbiArgumentValue(argument, inst, projected, valuesByReg) {
  if (argument && typeof argument === 'object' && Array.isArray(argument.uses) && argument.kind) {
    return valueDominatesInstruction(argument, inst, projected) ? argument : null;
  }
  const descriptors = abiRegisterDescriptors(argument);
  for (const descriptor of descriptors) {
    const bucket = valuesByReg.get(descriptor.reg);
    if (!bucket) continue;
    let bestValue = null;
    let bestRank = null;
    for (let i = 0; i < bucket.length; i += 1) {
      const value = bucket[i];
      if (!valueDominatesInstruction(value, inst, projected)) continue;
      const rank = dominanceRankForArgument(value, inst, projected, descriptor.bits);
      if (isBetterDominanceRank(rank, bestRank)) {
        bestRank = rank;
        bestValue = value;
      }
    }
    if (bestValue != null) return bestValue;
  }
  return null;
}

function resolveTailCallBranchTarget(inst, projected, options) {
  const targetBlock = inst.extra?.targetBlock;
  const isExternalTarget = targetBlock == null || (projected.blocks?.[targetBlock]?.insts?.length ?? 0) === 0;
  if (!isExternalTarget) return null;
  const machineTarget = inst.extra?.attributes?.machineControlEffect?.target ?? null;
  const symbolicTarget = machineTarget?.kind === 'symbolic-code-reference'
    && typeof machineTarget.name === 'string'
    && /^[A-Za-z_.$][A-Za-z0-9_.$@]{0,255}$/.test(machineTarget.name)
    ? machineTarget.name : null;
  const target = inst.extra?.target ?? safeBigInt(machineTarget);
  let symbolName = inst.extra?.name || symbolicTarget || null;
  if (!symbolName && target != null && typeof options?.symbolFor === 'function') {
    try { symbolName = options.symbolFor(target) || null; } catch { symbolName = null; }
  }
  if (!symbolName) return null;
  return { target, symbolName };
}

/**
 * MachineEffects keeps calls ABI-neutral. When the integration boundary supplies
 * an ABI adapter, #665 stores the adapter's physical argument locations on the
 * projected call. Bind those locations to already-projected state values only
 * when the value definition dominates the call (or is an incoming ARG). This is
 * compatibility projection of ABI knowledge; no instruction text is decoded and
 * no register name is embedded in generic code.
 *
 * Existing explicit Semantic IR arguments and ABI-projected inputs are additive.
 * The latter include implicit calling-convention state such as SysV AMD64 `%al`
 * for variadic calls, so dropping them because one explicit argument already
 * exists would sever the real def-use edge and allow its producer to disappear.
 */
function attachAbiProjectedArguments(projected, ir = null, valuesById = null, blockIndexById = null, options = {}) {
  const targets = [];
  let cfgMutated = false;
  for (const inst of projected.instructions) {
    if (inst.op === V1_OP.CALL && Array.isArray(inst.callArguments)) {
      targets.push({ inst, callArguments: inst.callArguments });
    } else if (inst.op === V1_OP.BR) {
      const tailTarget = resolveTailCallBranchTarget(inst, projected, options);
      if (!tailTarget) continue;
      inst.extra = inst.extra || {};
      inst.extra.name = tailTarget.symbolName;
      inst.extra.isTailCall = true;
      if (inst.extra.target == null && tailTarget.target != null) inst.extra.target = tailTarget.target;
      const block = projected.blocks?.[inst.block];
      if (block && Array.isArray(block.succ) && block.succ.length) {
        for (const succIdx of block.succ) {
          const succBlock = projected.blocks?.[succIdx];
          if (succBlock && Array.isArray(succBlock.pred)) {
            succBlock.pred = succBlock.pred.filter((p) => p !== block.index);
          }
        }
        block.succ = [];
        block.isExit = true;
        cfgMutated = true;
      }
      let callArguments = null;
      if (Array.isArray(inst.callArguments)) {
        callArguments = inst.callArguments;
      } else {
        const abi = classifyCallWithAbi({
          id: inst.semanticNodeId,
          call: {
            target: tailTarget.target,
            targetValueIds: [],
            targetEntityIds: [],
            arguments: [],
            returns: [],
            stateWrites: [],
          },
        }, ir, valuesById, options);
        if (Array.isArray(abi?.callArguments) && abi.callArguments.length) {
          callArguments = abi.callArguments;
          inst.callArguments = callArguments;
        }
      }
      if (Array.isArray(callArguments)) targets.push({ inst, callArguments });
    }
  }

  if (cfgMutated && Array.isArray(projected.blocks) && projected.blocks.length) {
    const resolvedBlockIndex = blockIndexById instanceof Map
      ? blockIndexById
      : new Map(projected.blocks.map((block, index) => [block.semanticBlockId, index]));
    for (const block of projected.blocks) block.isLoopHeader = false;
    const updatedGraph = graphFacts(
      projected.blocks,
      resolvedBlockIndex,
      projected.entry ?? 0,
      ir?.functionId ?? projected.functionId ?? 'semantic-v2-v1-compat',
      null,
    );
    for (const block of projected.blocks) block.isExit = block.succ.length === 0;
    projected.reachable = updatedGraph.reachable;
    projected.loops = updatedGraph.loops;
    projected.backEdges = updatedGraph.backEdges;
    projected.idom = updatedGraph.idom;
    projected.dominators = updatedGraph.dominators;
    if (projected.compat) {
      projected.compat.controlEdges = updatedGraph.edges;
      projected.compat.canonicalCfg = false;
    }
  }

  if (!targets.length) return;
  const valuesByReg = buildValuesByRegIndex(projected);
  for (const { inst, callArguments } of targets) {
    const existing = (inst.args || []).map((argument) => argument?.value).filter(Boolean);
    const seen = new Set(existing.map((value) => value.id));
    const values = existing.slice();
    for (const argument of callArguments) {
      const value = projectedAbiArgumentValue(argument, inst, projected, valuesByReg);
      if (!value || seen.has(value.id)) continue;
      seen.add(value.id);
      values.push(value);
      addUse(value, inst);
    }
    if (!values.length) continue;
    inst.args = values.map(makeArg);
    inst.extra.abiProjectedArgumentValueIds = values.map((value) => value.semanticSsaValueId ?? value.semanticValueId ?? value.id);
  }
}

/**
 * Canonical SSA can contain multiple entry values for one physical identity when
 * different typed access views are observed. Legacy v1 exposes one `args` value
 * per public identity. Choose that representative only after def-use projection,
 * preferring the entry view that is actually consumed. This avoids an unused
 * wider entry view shadowing the live narrower view while preserving deterministic
 * first-seen behavior when candidates are otherwise equivalent.
 */
function populateLegacyArguments(projected) {
  projected.args.clear();
  for (const value of projected.values) {
    if (value.kind !== V1_VK.ARG || !value.reg) continue;
    const current = projected.args.get(value.reg) ?? null;
    if (!current) {
      projected.args.set(value.reg, value);
      continue;
    }
    const currentUses = current.uses?.length ?? 0;
    const candidateUses = value.uses?.length ?? 0;
    if (candidateUses > currentUses) projected.args.set(value.reg, value);
  }
}

function addComparisonCarriers(ir, values, valuesById) {
  const flagWriteInstructionIds = new Set();
  const addWithCarryInstructionIds = new Set();
  for (const node of ir.nodes) {
    if (node.kind === 'state-write' && node.variable?.physicalIdentity?.kind === 'flag') {
      for (const id of sourceInstructionIds(node.origin)) flagWriteInstructionIds.add(id);
    }
    if (node.kind === 'intrinsic' && node.operator === 'add-with-carry') {
      for (const id of sourceInstructionIds(node.origin)) addWithCarryInstructionIds.add(id);
    }
  }

  const byNodeId = new Map();
  for (const node of ir.nodes) {
    if ((node.kind === 'compare'
        || (node.kind === 'intrinsic' && (node.operator === 'arm64.fp.fcmp' || node.operator === 'arm64.fp.fcmpe')))
        && node.outputs[0]) {
      const value = valuesById.get(node.outputs[0]);
      if (value) byNodeId.set(node.id, value);
      continue;
    }
    const flagProducingArithmetic = sameInstruction(node, flagWriteInstructionIds)
      && ((node.kind === 'intrinsic' && node.operator === 'add-with-carry')
        || (node.kind === 'binary' && !sameInstruction(node, addWithCarryInstructionIds)));
    if (!flagProducingArithmetic) continue;
    const value = {
      id: values.length,
      vid: values.length + 1,
      kind: V1_VK.DEF,
      reg: null,
      stateKey: null,
      version: 0,
      bits: 1,
      def: null,
      uses: [],
      const: null,
      range: null,
      signed: null,
      nullable: null,
      type: null,
      label: `comparison:${node.id}`,
      semanticValueId: null,
      semanticSsaValueId: null,
      sourceEntityId: node.id,
      machineType: { kind: 'predicate', widthBits: 1 },
      origin: node.origin,
      compatDerived: 'comparison-carrier',
    };
    values.push(value);
    byNodeId.set(node.id, value);
  }
  return byNodeId;
}

/**
 * Semantic IR v2 -> legacy Semantic IR v1 compatibility projection.
 *
 * This module consumes only canonical Semantic IR/SSA/MemorySSA/CFG contracts.
 * It does not decode instructions, inspect mnemonic text, or invoke a legacy
 * architecture lifter. The v1 vocabulary is only the compatibility target.
 */
export function projectSemanticIrV2ToLegacyV1(input, options = {}) {
  const ir = isCanonicalSemanticIrProducerArtifact(input) && options.validationOptions == null
    ? input
    : validateSemanticIrFunction(input, options.validationOptions || {});
  const ssaInput = options.ssa ?? options.semanticSsa ?? null;
  const ssa = ssaInput == null ? null
    : (isCanonicalSemanticSsaProducerArtifact(ssaInput) && options.ssaValidationOptions == null
      ? ssaInput
      : createSemanticSsaContract(
        semanticSsaContractInput(ssaInput), options.ssaValidationOptions || {},
      ));
  const memorySsaInput = options.memorySsa ?? null;
  // Keep the exact object issued by the canonical builder.  A validated
  // compatibility copy is intentionally unbound: serialized/process-boundary
  // clones must be rebuilt by the true producer before exact forwarding can be
  // consumed.
  let memorySsa = null;
  if (memorySsaInput != null) {
    const isCanonicalMemorySsa = isCanonicalMemorySsaProducerArtifact(memorySsaInput);
    if (isCanonicalMemorySsa && options.memorySsaValidationOptions == null) {
      memorySsa = memorySsaInput;
    } else {
      const memorySsaContract = createMemorySsaContract(
        memorySsaContractInput(memorySsaInput), options.memorySsaValidationOptions || {},
      );
      memorySsa = isCanonicalMemorySsa
        ? memorySsaInput
        : memorySsaProjectionArtifact(memorySsaInput, memorySsaContract);
    }
  }
  const canonicalCfg = options.cfg ?? options.semanticCfg ?? null;
  if (ssa && ssa.functionId !== ir.functionId) throw new TypeError('semantic-v2-v1-compat-ssa-function-mismatch');
  if (memorySsa && memorySsa.functionId !== ir.functionId) throw new TypeError('semantic-v2-v1-compat-memoryssa-function-mismatch');

  const nodeById = new Map(ir.nodes.map((node) => [node.id, node]));
  const semanticValueById = new Map(ir.values.map((value) => [value.id, value]));
  const producerByValueId = new Map();
  const registerStateWriteValueIds = new Set();
  const firstConsumerNodeByValueId = new Map();
  const multiConsumerNodeValueIds = new Set();
  for (const node of ir.nodes) {
    for (const valueId of node.outputs || []) producerByValueId.set(valueId, node);
    if (node.kind === 'state-write' && node.variable?.physicalIdentity?.kind === 'register' && node.inputs?.[0] != null) {
      registerStateWriteValueIds.add(node.inputs[0]);
    }
    for (const valueId of node.inputs || []) {
      if (!firstConsumerNodeByValueId.has(valueId)) firstConsumerNodeByValueId.set(valueId, node.id);
      else if (firstConsumerNodeByValueId.get(valueId) !== node.id) multiConsumerNodeValueIds.add(valueId);
    }
  }
  const orderedBlocks = blockOrder(ir);
  const blockIndexById = new Map(orderedBlocks.map((block, index) => [block.id, index]));
  const legacyBlocks = orderedBlocks.map((block, index) => ({
    index,
    semanticBlockId: block.id,
    semanticNodeIds: block.nodeIds.slice(),
    startRow: index,
    endRow: index,
    succ: explicitTargetsForBlock(block, nodeById).map((target) => blockIndexById.get(target)).filter((value) => value != null),
    successorEdges: [],
    pred: [],
    idom: -1,
    insts: [],
    phis: [],
    memPhis: [],
    isEntry: block.id === ir.entryBlockId,
    isExit: false,
    isLoopHeader: false,
    origin: block.origin ?? ir.origin,
  }));
  const blockBySemanticId = new Map(legacyBlocks.map((block) => [block.semanticBlockId, block]));
  const graph = graphFacts(
    legacyBlocks,
    blockIndexById,
    blockIndexById.get(ir.entryBlockId) ?? 0,
    ir.functionId,
    canonicalCfg,
  );
  for (const block of legacyBlocks) block.isExit = block.succ.length === 0;

  const { values, byId: valuesById } = buildLegacyValues(ir, ssa);
  preserveIncomingPhysicalState(ssa, valuesById);
  preserveStateReadTemporaryIdentity(ir, valuesById);
  const stateProjection = buildStateProjectionIndex(ssa);
  preserveExactStateWriteSourceIdentity(ir, producerByValueId, stateProjection, valuesById);
  const comparisonCarrierByNodeId = addComparisonCarriers(ir, values, valuesById);
  const canonicalValueUseIds = new Set(ir.nodes.flatMap(node => [
    ...(node.inputs || []), node.metadata?.returnControlTarget?.valueId,
  ]).filter(Boolean));
  for (const use of ssa?.uses || []) {
    if (use.semanticValueId) canonicalValueUseIds.add(use.semanticValueId);
    if (use.proof?.sourceSemanticValueId) canonicalValueUseIds.add(use.proof.sourceSemanticValueId);
  }
  const projected = {
    name: options.name ?? ir.functionId,
    functionId: ir.functionId,
    startAddress: firstAddress(ir.origin),
    truncated: ir.completeness !== 'complete',
    values,
    instructions: [],
    blocks: legacyBlocks,
    entry: blockIndexById.get(ir.entryBlockId) ?? 0,
    locations: new Map(),
    byRow: new Map(),
    args: new Map(),
    reachable: graph.reachable,
    loops: graph.loops,
    backEdges: graph.backEdges,
    idom: graph.idom,
    dominators: graph.dominators,
    stackSlots: [],
    origin: ir.origin,
    semanticIrVersion: ir.contractVersion,
    compat: {
      projection: 'semantic-ir-v2-to-v1',
      version: '1.3.0',
      semanticFunctionId: ir.functionId,
      scalarSsa: !!ssa,
      memorySsa: !!memorySsa,
      canonicalCfg: canonicalCfg != null,
      semanticNodeToLegacyInstructionIds: {},
      semanticValueToLegacyValueId: Object.fromEntries(ir.values
        .map((value) => [value.id, valuesById.get(value.id)?.id])
        .filter(([, id]) => id != null)),
      ssaValueToLegacyValueId: Object.fromEntries((ssa?.definitions ?? [])
        .map((definition) => [definition.valueId, valuesById.get(definition.valueId)?.id])
        .filter(([, id]) => id != null)),
      derivedComparisonCarriers: Object.fromEntries([...comparisonCarrierByNodeId.entries()].map(([nodeId, value]) => [nodeId, value.id])),
      controlEdges: graph.edges,
      origins: {
        function: ir.origin,
        blocks: Object.fromEntries(ir.blocks.map((block) => [block.id, block.origin ?? ir.origin])),
        nodes: Object.fromEntries(ir.nodes.map((node) => [node.id, node.origin])),
        values: Object.fromEntries(ir.values.map((value) => [value.id, value.origin])),
        ssaDefinitions: Object.fromEntries((ssa?.definitions ?? []).map((definition) => [definition.definitionId, definition.origin])),
        ssaUses: Object.fromEntries((ssa?.uses ?? []).map((use) => [use.useId, use.origin])),
        functionUnknowns: ir.unknowns.map(() => ir.origin),
      },
    },
  };

  const instructionBySemanticId = new Map();
  let fallbackRow = 0;
  for (const block of legacyBlocks) {
    let firstRow = null;
    let lastRow = null;
    const physicalStateCurrent = new Map();
    for (const nodeId of block.semanticNodeIds) {
      const node = nodeById.get(nodeId);
      if (!node) continue;
      const row = rowForNode(node, fallbackRow++, options);
      const instructions = projectNode(node, {
        blockIndex: block.index,
        row,
        values,
        valuesById,
        ir,
        ssa,
        nodeById,
        semanticValueById,
        producerByValueId,
        stateProjection,
        comparisonCarrierByNodeId,
        canonicalValueUseIds,
        registerStateWriteValueIds,
        firstConsumerNodeByValueId,
        multiConsumerNodeValueIds,
        physicalStateCurrent,
        blockBySemanticId,
        options,
      });
      const primary = instructions[0];
      instructionBySemanticId.set(node.id, primary);
      projected.instructions.push(...instructions);
      block.insts.push(...instructions);
      firstRow = firstRow == null ? row : Math.min(firstRow, row);
      lastRow = lastRow == null ? row : Math.max(lastRow, row);
    }
    block.startRow = firstRow ?? block.index;
    block.endRow = lastRow ?? block.startRow;
  }

  addScalarSsaPhis(projected, ssa, valuesById, blockIndexById, instructionBySemanticId);
  appendFunctionUnknowns(projected, ir);

  const constantObserver = { records:[], expected:new WeakSet(), unavailable:new WeakSet() };
  const stateObserver = { records:[], expected:new WeakSet(), unavailable:new WeakSet() };
  const memoryTransitions = memorySsa
    ? attachMemorySsa(projected, memorySsa, valuesById, instructionBySemanticId, blockIndexById, ir, constantObserver, options) : null;
  if (!memorySsa) attachFallbackMemory(projected);

  for (const inst of projected.instructions) {
    const mustClobberMemory = inst.memoryBarrier === true
      || (inst.op === V1_OP.CALL && inst.extra?.memoryWrite?.scope !== 'none')
      || (inst.op === V1_OP.UNKNOWN && inst.extra?.unknownCategories?.includes('memory'));
    if (!mustClobberMemory || inst.memKills?.length) continue;
    const loc = { key: `unknown-barrier:${inst.semanticNodeId ?? inst.id}`, kind: V1_MK.UNKNOWN, size: null };
    projected.locations.set(loc.key, loc);
    inst.memKills = [loc];
  }

  assignInstructionIds(projected);
  for (const inst of projected.instructions) {
    const semanticId = inst.sourceEntityId ?? inst.semanticNodeId;
    if (!semanticId) continue;
    let list = projected.compat.semanticNodeToLegacyInstructionIds[semanticId];
    if (!list) list = projected.compat.semanticNodeToLegacyInstructionIds[semanticId] = [];
    list.push(inst.id);
  }
  attachAbiProjectedArguments(projected, ir, valuesById, blockIndexById, options);
  finalizeLegacyProjection(projected, constantObserver, stateObserver);
  populateLegacyArguments(projected);
  projected.memorySafety = memorySafetySummary(projected);
  // `defUse` is deliberately not attached: the def-use index is the projected
  // `values` table and is read through the canonical `defUseFor(ir)` accessor.
  // Attaching a closure here made the projection an unserializable carrier of
  // runtime state (structuredClone threw DataCloneError).
  sealMemoryOperandTransitions(projected, memoryTransitions);
  sealStateTransitions(projected, stateObserver);
  sealConstantTransitions(projected, constantObserver);
  return projected;
}

export const SEMANTIC_IR_V2_V1_COMPAT = Object.freeze({
  contractVersion: '1.3.0',
  legacyOps: V1_OP,
  legacyValueKinds: V1_VK,
  legacyMemoryKinds: V1_MK,
});
