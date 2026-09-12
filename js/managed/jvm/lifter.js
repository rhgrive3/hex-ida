import { createOriginSet } from '../../core/identity/origin.js';
import { createManagedExceptionRegionId, createManagedMethodId, createVMOperationId } from '../shared/identity.js';
import { createVMEffectBundle, createVMEffectFunction } from '../shared/vm-effects.js';
import { decodeJvmInstructionBoundary } from './instruction-boundary.js';
import { liftJvmMethod as liftJvmMethodCore } from './lifter-core.js';

function firstMalformedBoundary(bytecode) {
  let pc = 0;
  let opSeq = 0;
  while (pc < bytecode.length) {
    const opOffset = pc;
    const opcode = bytecode[opOffset];
    const boundary = decodeJvmInstructionBoundary(bytecode, opOffset);
    opSeq++;
    if (!boundary.complete || !Number.isSafeInteger(boundary.end) || boundary.end <= opOffset || boundary.end > bytecode.length) {
      return { opOffset, opcode, opSeq };
    }
    pc = boundary.end;
  }
  return null;
}

const SYNCHRONIZED_MONITOR_REASON = 'jvm-synchronized-method-monitor-unrepresented';

const JVM_INT_BRANCH_CONDITIONS = Object.freeze({
  0x99: Object.freeze({ kind: 'integer-comparison', predicate: 'eq', signed: true, arity: 1, compareToZero: true, widthBits: 32 }),
  0x9a: Object.freeze({ kind: 'integer-comparison', predicate: 'ne', signed: true, arity: 1, compareToZero: true, widthBits: 32 }),
  0x9b: Object.freeze({ kind: 'integer-comparison', predicate: 'lt', signed: true, arity: 1, compareToZero: true, widthBits: 32 }),
  0x9c: Object.freeze({ kind: 'integer-comparison', predicate: 'ge', signed: true, arity: 1, compareToZero: true, widthBits: 32 }),
  0x9d: Object.freeze({ kind: 'integer-comparison', predicate: 'gt', signed: true, arity: 1, compareToZero: true, widthBits: 32 }),
  0x9e: Object.freeze({ kind: 'integer-comparison', predicate: 'le', signed: true, arity: 1, compareToZero: true, widthBits: 32 }),
  0x9f: Object.freeze({ kind: 'integer-comparison', predicate: 'eq', signed: true, arity: 2, compareToZero: false, widthBits: 32 }),
  0xa0: Object.freeze({ kind: 'integer-comparison', predicate: 'ne', signed: true, arity: 2, compareToZero: false, widthBits: 32 }),
  0xa1: Object.freeze({ kind: 'integer-comparison', predicate: 'lt', signed: true, arity: 2, compareToZero: false, widthBits: 32 }),
  0xa2: Object.freeze({ kind: 'integer-comparison', predicate: 'ge', signed: true, arity: 2, compareToZero: false, widthBits: 32 }),
  0xa3: Object.freeze({ kind: 'integer-comparison', predicate: 'gt', signed: true, arity: 2, compareToZero: false, widthBits: 32 }),
  0xa4: Object.freeze({ kind: 'integer-comparison', predicate: 'le', signed: true, arity: 2, compareToZero: false, widthBits: 32 }),
});

function applyBranchPredicateSemantics(lifted, options = {}) {
  let changed = false;
  const bundles = lifted.bundles.map((bundle) => {
    const condition = JVM_INT_BRANCH_CONDITIONS[bundle.opcode];
    if (!condition) return bundle;
    let bundleChanged = false;
    const controlEffects = bundle.controlEffects.map((effect) => {
      if (effect?.kind !== 'conditional-branch') return effect;
      bundleChanged = true;
      changed = true;
      return { ...effect, condition };
    });
    return bundleChanged ? createVMEffectBundle({ ...bundle, controlEffects }, options) : bundle;
  });
  return changed ? createVMEffectFunction({ ...lifted, bundles }, options) : lifted;
}

function finalizeJvmSemantics(lifted, method, options = {}) {
  return applySynchronizedMethodSemantics(applyBranchPredicateSemantics(lifted, options), method, options);
}

function applySynchronizedMethodSemantics(lifted, method, options = {}) {
  if ((method?.accessFlags & 0x0020) === 0) return lifted; // ACC_SYNCHRONIZED

  const firstBundle = lifted.bundles[0] ?? null;
  const alreadyMarked = firstBundle?.unknownEffects?.some((effect) =>
    effect?.reason === SYNCHRONIZED_MONITOR_REASON) === true;
  const bundles = firstBundle ? [{
    ...firstBundle,
    completeness: firstBundle.completeness === 'unknown' ? 'unknown' : 'partial',
    unknownEffects: alreadyMarked
      ? firstBundle.unknownEffects
      : [...firstBundle.unknownEffects, {
        category: 'other',
        reason: SYNCHRONIZED_MONITOR_REASON,
      }],
  }, ...lifted.bundles.slice(1)] : lifted.bundles;

  return createVMEffectFunction({
    ...lifted,
    bundles,
    aggregateCompleteness: lifted.aggregateCompleteness === 'unknown' ? 'unknown' : 'partial',
    metadata: {
      ...lifted.metadata,
      synchronization: {
        kind: 'implicit-jvm-monitor',
        monitor: (method.accessFlags & 0x0008) !== 0 ? 'declaring-class' : 'receiver', // ACC_STATIC
        acquire: 'method-entry',
        release: 'normal-or-abrupt-exit',
        reentrant: true,
        completeness: 'unrepresented',
      },
    },
  }, options);
}

function cloneWithBytecodePrefix(jvmClass, methodIdx, method, bytecode) {
  const methods = jvmClass.methods.slice();
  methods[methodIdx] = {
    ...method,
    code: {
      ...method.code,
      bytecode,
    },
  };
  return { ...jvmClass, methods };
}

export function liftJvmMethod(methodIdx, jvmClass, options = {}) {
  const method = jvmClass?.methods?.[methodIdx];
  if (!method?.code) {
    return finalizeJvmSemantics(liftJvmMethodCore(methodIdx, jvmClass, options), method, options);
  }

  const bytecode = method.code.bytecode;
  const malformed = firstMalformedBoundary(bytecode);
  if (!malformed) {
    return finalizeJvmSemantics(liftJvmMethodCore(methodIdx, jvmClass, options), method, options);
  }

  const methodId = createManagedMethodId(jvmClass.moduleId, methodIdx, method.name);
  let prefixBundles = [];
  if (malformed.opOffset > 0) {
    const prefixClass = cloneWithBytecodePrefix(
      jvmClass,
      methodIdx,
      method,
      bytecode.slice(0, malformed.opOffset),
    );
    prefixBundles = liftJvmMethodCore(methodIdx, prefixClass, options).bundles;
  }

  const opId = createVMOperationId(methodId, malformed.opOffset, malformed.opSeq);
  const codeOffset = Number(method.code.offset ?? 0);
  const malformedBundle = createVMEffectBundle({
    schemaVersion: 1,
    contractVersion: '1.0.0',
    frontendId: 'jvm',
    frontendSemanticVersion: '1.0.0',
    profileId: jvmClass.vmSpecEdition,
    methodId,
    operationId: opId,
    bytecodeOffset: malformed.opOffset,
    opcode: malformed.opcode,
    mnemonic: `jvm_op_0x${malformed.opcode.toString(16)}`,
    consumedValues: [],
    producedValues: [],
    locationReads: [],
    locationWrites: [],
    memoryEffects: [],
    callEffects: [],
    controlEffects: [],
    possibleExceptions: [],
    origin: createOriginSet({
      operationIds: [opId],
      byteRanges: [{ start: codeOffset + malformed.opOffset, end: codeOffset + bytecode.length }],
    }),
    completeness: 'partial',
    unknownEffects: [{
      category: 'other',
      reason: `unsupported-jvm-opcode-0x${malformed.opcode.toString(16)}-malformed-boundary`,
    }],
  }, options);

  const exceptionRegions = (method.code.exceptionTable || []).map((exc, idx) => ({
    id: createManagedExceptionRegionId(methodId, idx),
    startOffset: exc.startPc,
    endOffset: exc.endPc,
    handlerOffset: exc.handlerPc,
    catchType: exc.catchType,
  }));

  const lifted = createVMEffectFunction({
    methodId,
    profileId: jvmClass.vmSpecEdition,
    frontendId: 'jvm',
    bundles: [...prefixBundles, malformedBundle],
    entryState: {
      maxStack: method.code.maxStack,
      maxLocals: method.code.maxLocals,
    },
    exceptionRegions,
    aggregateCompleteness: 'partial',
  }, options);
  return finalizeJvmSemantics(lifted, method, options);
}
