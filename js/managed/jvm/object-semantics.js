import { createVMEffectBundle, createVMEffectFunction } from '../shared/vm-effects.js';
import { parseJvmMethodDescriptor } from './descriptors.js';

const MANAGED_HEAP_REFERENCE = Object.freeze({
  kind: 'address',
  widthBits: 64,
  addressSpace: 'managed-heap',
});

function resolveJvmClassRefName(jvmClass, cpIndex) {
  const pool = jvmClass?.constantPool;
  if (!Array.isArray(pool) || !Number.isInteger(cpIndex) || cpIndex <= 0 || cpIndex >= pool.length) return null;
  const entry = pool[cpIndex];
  if (!entry || entry.tag !== 7 || !Number.isInteger(entry.nameIndex)) return null;
  const name = pool[entry.nameIndex];
  return name?.tag === 1 && typeof name.value === 'string' && name.value.length > 0 ? name.value : null;
}

function resolveJvmMethodRef(jvmClass, cpIndex) {
  const pool = jvmClass?.constantPool;
  if (!Array.isArray(pool) || !Number.isInteger(cpIndex) || cpIndex <= 0 || cpIndex >= pool.length) return null;
  const entry = pool[cpIndex];
  if (!entry || (entry.tag !== 10 && entry.tag !== 11)) return null;
  const owner = resolveJvmClassRefName(jvmClass, entry.classIndex);
  const nameAndType = pool[entry.nameAndTypeIndex];
  if (owner == null || !nameAndType || nameAndType.tag !== 12) return null;
  const name = pool[nameAndType.nameIndex];
  const descriptor = pool[nameAndType.descriptorIndex];
  if (name?.tag !== 1 || typeof name.value !== 'string' || name.value.length === 0) return null;
  if (descriptor?.tag !== 1 || typeof descriptor.value !== 'string') return null;
  let parsed;
  try { parsed = parseJvmMethodDescriptor(descriptor.value); }
  catch { return null; }
  return {
    owner,
    name: name.value,
    descriptor: descriptor.value,
    parameterCount: parsed.parameters.length,
  };
}

function allocationFact(value) {
  if (!value || typeof value !== 'object' || typeof value.allocationId !== 'string') return null;
  return {
    allocationId: value.allocationId,
    allocatedClass: typeof value.allocatedClass === 'string' ? value.allocatedClass : value.valueType,
    allocationState: value.allocationState === 'initialized' ? 'initialized' : 'uninitialized',
    fresh: value.fresh === true,
  };
}

function withAllocation(value, fact) {
  if (!fact) return value;
  return {
    ...value,
    allocationId: fact.allocationId,
    allocatedClass: fact.allocatedClass,
    allocationState: fact.allocationState,
    fresh: fact.fresh,
  };
}

function branchJoinOffsets(lifted) {
  const joins = new Set();
  for (const bundle of lifted?.bundles ?? []) {
    for (const effect of bundle?.controlEffects ?? []) {
      if (Number.isSafeInteger(effect?.targetOffset)) joins.add(effect.targetOffset);
      for (const target of effect?.targets ?? []) {
        if (Number.isSafeInteger(target?.targetOffset)) joins.add(target.targetOffset);
      }
      if (Number.isSafeInteger(effect?.defaultTargetOffset)) joins.add(effect.defaultTargetOffset);
    }
  }
  for (const region of lifted?.exceptionRegions ?? []) {
    if (Number.isSafeInteger(region?.handlerOffset)) joins.add(region.handlerOffset);
  }
  return joins;
}

function rewriteInstanceofUnknowns(unknownEffects) {
  return (unknownEffects ?? []).map((effect) => effect?.reason === 'jvm-instanceof-type-test-target-unrepresented-in-canonical-ir'
    ? { ...effect, reason: 'jvm-instanceof-runtime-resolution-effects-unrepresented' }
    : effect);
}

/**
 * Close the JVM object-semantics gap after the opcode lifter has validated CP
 * operands. This layer owns the cross-opcode identity facts that require a
 * short linear stack history (`new -> dup -> invokespecial <init>`) while
 * failing closed at CFG joins or any operation whose stack effect is not fully
 * represented. It does not make heap allocation or class-resolution effects
 * complete; it only preserves the authority already proven by the bytecode and
 * checked constant-pool entries.
 */
export function applyJvmObjectIdentitySemantics(lifted, jvmClass, options = {}) {
  if (lifted?.frontendId !== 'jvm' || !Array.isArray(lifted.bundles)) return lifted;

  const joins = branchJoinOffsets(lifted);
  const stackFacts = [];
  let stackFactsTrusted = true;
  let changed = false;
  const bundles = [];

  for (const original of lifted.bundles) {
    if (joins.has(original.bytecodeOffset)) stackFactsTrusted = false;

    let bundle = original;
    let consumedValues = original.consumedValues;
    let producedValues = original.producedValues;
    let callEffects = original.callEffects;
    let unknownEffects = original.unknownEffects;
    let bundleChanged = false;

    if (original.mnemonic === 'new') {
      const produced = original.producedValues?.[0];
      if (typeof produced?.valueType === 'string' && produced.referenceKind === 'new-allocation') {
        const fact = {
          allocationId: `jvm-allocation:${original.operationId}`,
          allocatedClass: produced.valueType,
          allocationState: 'uninitialized',
          fresh: true,
        };
        producedValues = [{
          ...produced,
          type: MANAGED_HEAP_REFERENCE,
          ...fact,
        }, ...original.producedValues.slice(1)];
        bundleChanged = true;
      }
    } else if (original.mnemonic === 'instanceof') {
      const target = original.producedValues?.[0]?.valueType;
      consumedValues = original.consumedValues.map((value, index) => index === 0
        ? { ...value, type: MANAGED_HEAP_REFERENCE }
        : value);
      if (typeof target === 'string') {
        producedValues = [{
          ...original.producedValues[0],
          type: { kind: 'bitvector', widthBits: 32 },
          referenceKind: 'type-test-result',
          predicateKind: 'jvm-instanceof',
          predicateTargetClass: target,
          booleanEncoding: 'int32-0-or-1',
        }, ...original.producedValues.slice(1)];
        unknownEffects = rewriteInstanceofUnknowns(original.unknownEffects);
      }
      bundleChanged = consumedValues !== original.consumedValues
        || producedValues !== original.producedValues
        || unknownEffects !== original.unknownEffects;
    } else if (original.mnemonic === 'checkcast') {
      consumedValues = original.consumedValues.map((value, index) => index === 0
        ? { ...value, type: MANAGED_HEAP_REFERENCE }
        : value);
      producedValues = original.producedValues.map((value, index) => index === 0 && typeof value?.valueType === 'string'
        ? { ...value, type: MANAGED_HEAP_REFERENCE }
        : value);
      bundleChanged = true;
    } else if (original.mnemonic === 'dup') {
      const fact = stackFactsTrusted ? stackFacts[stackFacts.length - 1] : null;
      if (fact?.allocationId) {
        consumedValues = original.consumedValues.map((value, index) => index === 0 ? withAllocation(value, fact) : value);
        producedValues = original.producedValues.map((value) => withAllocation(value, fact));
        bundleChanged = true;
      }
    } else if (original.mnemonic === 'invokespecial') {
      const call = original.callEffects?.[0];
      const resolved = resolveJvmMethodRef(jvmClass, call?.cpIndex);
      if (resolved?.name === '<init>' && stackFactsTrusted) {
        const receiverIndex = stackFacts.length - resolved.parameterCount - 1;
        const receiver = receiverIndex >= 0 ? stackFacts[receiverIndex] : null;
        if (receiver?.allocationId) {
          callEffects = original.callEffects.map((effect, index) => index === 0 ? {
            ...effect,
            owner: resolved.owner,
            name: resolved.name,
            descriptor: resolved.descriptor,
            receiverAllocationId: receiver.allocationId,
            initializesAllocation: true,
          } : effect);
          // #1138: `invokespecial <init>` pushes its own objectref back onto the
          // stack, so the freshly initialized object is the value the following
          // bytecode sees. Carry the receiver's allocation identity across that
          // push instead of dropping it with the popped slot.
          producedValues = original.producedValues.map((value) => value?.aliasConsumedReceiver === true
            ? withAllocation(value, { ...receiver, allocationState: 'initialized' })
            : value);
          for (const fact of stackFacts) {
            if (fact?.allocationId === receiver.allocationId) fact.allocationState = 'initialized';
          }
          bundleChanged = true;
        }
      }
    }

    if (bundleChanged) {
      bundle = createVMEffectBundle({
        ...original,
        consumedValues,
        producedValues,
        callEffects,
        unknownEffects,
      }, options);
      changed = true;
    }
    bundles.push(bundle);

    for (let index = 0; index < bundle.consumedValues.length; index += 1) stackFacts.pop();
    for (const value of bundle.producedValues) stackFacts.push(allocationFact(value));

    const freshNew = bundle.mnemonic === 'new'
      && bundle.producedValues.some((value) => allocationFact(value)?.allocationState === 'uninitialized');
    if (bundle.completeness !== 'exact' && !freshNew) stackFactsTrusted = false;
    if (bundle.mnemonic.startsWith('invoke')) stackFactsTrusted = false;
    if (bundle.controlEffects.some((effect) =>
      effect?.kind === 'branch' || effect?.kind === 'conditional-branch'
      || effect?.kind === 'switch' || effect?.kind === 'return' || effect?.kind === 'throw')) {
      stackFactsTrusted = false;
    }
  }

  return changed ? createVMEffectFunction({ ...lifted, bundles }, options) : lifted;
}
