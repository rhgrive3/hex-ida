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
    return applySynchronizedMethodSemantics(liftJvmMethodCore(methodIdx, jvmClass, options), method, options);
  }

  const bytecode = method.code.bytecode;
  const malformed = firstMalformedBoundary(bytecode);
  if (!malformed) {
    return applySynchronizedMethodSemantics(liftJvmMethodCore(methodIdx, jvmClass, options), method, options);
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
  return applySynchronizedMethodSemantics(lifted, method, options);
}
