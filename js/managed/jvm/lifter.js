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
  if (!method?.code) return liftJvmMethodCore(methodIdx, jvmClass, options);

  const bytecode = method.code.bytecode;
  const malformed = firstMalformedBoundary(bytecode);
  if (!malformed) return liftJvmMethodCore(methodIdx, jvmClass, options);

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

  return createVMEffectFunction({
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
}
