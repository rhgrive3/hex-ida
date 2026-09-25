import {
  createBitVectorValue,
  createMachineEffectBundle,
  createMachineOperation,
  createMemoryAccess,
} from '../../../../semantics/effects/index.js';
import {
  Arm64AddressingError,
  arm64AddressOffset,
  arm64RegisterOperand,
  arm64Temporary,
  buildArm64EffectiveAddress,
  createArm64RegisterRead,
  createArm64RegisterWrite,
} from './addressing.js';
import { arm64EffectIdentityContext, canonicalAddressValue, instructionMnemonic } from './common.js';

const STRUCTURE_MEMORY_MNEMONICS = new Set([
  'ld1','ld2','ld3','ld4',
  'st1','st2','st3','st4',
]);
const STRUCTURE_ARRANGEMENTS = new Map([
  ['8b', { laneCount:8, elementBits:8 }],
  ['16b', { laneCount:16, elementBits:8 }],
  ['4h', { laneCount:4, elementBits:16 }],
  ['8h', { laneCount:8, elementBits:16 }],
  ['2s', { laneCount:2, elementBits:32 }],
  ['4s', { laneCount:4, elementBits:32 }],
  ['1d', { laneCount:1, elementBits:64 }],
  ['2d', { laneCount:2, elementBits:64 }],
]);

function operandsOf(decoded) {
  return Array.isArray(decoded?.ops) ? decoded.ops : Array.isArray(decoded?.operands) ? decoded.operands : [];
}

function bundle(decoded, context, fields) {
  const ctx = arm64EffectIdentityContext(decoded, context);
  return createMachineEffectBundle({
    instructionId:ctx.instructionId,
    architectureId:ctx.architectureId,
    mode:ctx.mode,
    operations:fields.operations || [],
    controlEffect:{ kind:'fallthrough' },
    possibleFaults:fields.possibleFaults || [],
    origin:ctx.origin,
    completeness:fields.completeness || 'exact',
    ...(fields.unknownEffects ? { unknownEffects:fields.unknownEffects } : {}),
    metadata:{ family:'arm64-memory', mnemonic:instructionMnemonic(decoded), transfer:'structure', ...(fields.metadata || {}) },
  }, ctx.options);
}

function partial(decoded, context, reason) {
  return bundle(decoded, context, {
    completeness:'partial',
    operations:[],
    unknownEffects:{ categories:['memory','registers','other'], reason },
    metadata:{ unsupported:true },
  });
}

function isMemoryOperand(operand) {
  return operand?.k === 'mem' || operand?.kind === 'memory';
}

function expectedListCount(mnemonic, actual) {
  const structureCount = Number(mnemonic.at(-1));
  return structureCount === 1 ? actual >= 1 && actual <= 4 : actual === structureCount;
}

function canonicalRegisterList(list, mnemonic) {
  if (list?.k !== 'list' || !Array.isArray(list.regs) || !expectedListCount(mnemonic, list.regs.length)) {
    return { reason:'arm64-structure-memory-register-list-shape-invalid' };
  }

  const registers = [];
  let arrangement = null;
  let shape = null;
  for (let index = 0; index < list.regs.length; index++) {
    const operand = list.regs[index];
    const register = arm64RegisterOperand(operand);
    if (!register || register.kind !== 'vector' || operand?.k !== 'reg' || operand?.cls !== 'vec'
        || operand?.bits !== 128 || operand?.shift != null || operand?.extend != null) {
      return { reason:'arm64-structure-memory-vector-register-required' };
    }
    if (typeof operand.arr !== 'string') return { reason:'arm64-structure-memory-arrangement-required' };
    const currentArrangement = operand.arr.trim().toLowerCase();
    const currentShape = STRUCTURE_ARRANGEMENTS.get(currentArrangement);
    if (!currentShape) return { reason:'arm64-structure-memory-arrangement-unencodable' };
    if (currentArrangement === '1d'
        && (!mnemonic.endsWith('1') || list.regs.length > 2)) {
      return { reason:'arm64-structure-memory-arrangement-unencodable-for-register-list' };
    }
    if (operand.text != null && (typeof operand.text !== 'string'
        || operand.text.trim().toLowerCase() !== `v${register.num}.${currentArrangement}`)) {
      return { reason:'arm64-structure-memory-register-arrangement-conflict' };
    }
    if (arrangement != null && currentArrangement !== arrangement) {
      return { reason:'arm64-structure-memory-register-arrangements-must-match' };
    }
    const expectedRegister = (registers[0]?.num + index) & 31;
    if (registers.length && register.num !== expectedRegister) {
      return { reason:'arm64-structure-memory-register-list-must-be-consecutive' };
    }
    arrangement = currentArrangement;
    shape = currentShape;
    registers.push(register);
  }

  return { registers, arrangement, ...shape, vectorBits:shape.laneCount * shape.elementBits };
}

function addressFaults(direction, { accessIndex, addressExpr, alignment, tagChecked }) {
  const causes = ['address-size','translation','access-flag','permission','external'];
  if (alignment > 1) causes.push('alignment');
  if (tagChecked) causes.push('tag-check');
  const faults = [{
    kind:'data-abort',
    condition:{ kind:'memory-access-fault', access:direction, accessIndex },
    detail:{ causes, tagChecked, addressExpr },
  }];
  if (alignment > 1) faults.push({
    kind:'alignment-fault',
    condition:{ kind:'misaligned', alignment, accessIndex },
    detail:{ access:direction, alignment },
  });
  return faults;
}

function integerEvidence(value) {
  if (value != null && typeof value === 'object') {
    if (value.shift != null || value.extend != null) return null;
    value = value.value;
  }
  return canonicalAddressValue(value);
}

function conflictingIntegerFields(operand, leftKey, rightKey) {
  if (!Object.hasOwn(operand, leftKey) || !Object.hasOwn(operand, rightKey)) return false;
  const left = operand[leftKey];
  const right = operand[rightKey];
  if ((left == null) !== (right == null)) return true;
  if (left == null) return false;
  const leftValue = integerEvidence(left);
  const rightValue = integerEvidence(right);
  return leftValue == null || rightValue == null || leftValue !== rightValue;
}

function validateAddressing(addressing, transferredBytes) {
  if (conflictingIntegerFields(addressing.mem, 'addressDisp', 'disp')) {
    return 'arm64-structure-memory-conflicting-address-displacement-evidence';
  }
  if (conflictingIntegerFields(addressing.mem, 'writebackDisp', 'writebackOffset')) {
    return 'arm64-structure-memory-conflicting-writeback-displacement-evidence';
  }
  if (addressing.index) return 'arm64-structure-memory-register-offset-unmodeled';
  if (addressing.mode !== 'offset' && addressing.mode !== 'post') return 'arm64-structure-memory-addressing-mode-unmodeled';
  const addressDisplacement = addressing.metadata.addressDisplacement == null
    ? 0n : BigInt(addressing.metadata.addressDisplacement);
  if (addressDisplacement !== 0n) return 'arm64-structure-memory-base-displacement-unmodeled';
  if (addressing.mode === 'offset') {
    if (addressing.writebackRegister || addressing.metadata.writebackDisplacement != null) {
      return 'arm64-structure-memory-offset-form-cannot-write-back';
    }
    return null;
  }
  if (addressing.writebackRegister) {
    return addressing.metadata.writebackDisplacement == null
      ? null : 'arm64-structure-memory-conflicting-post-index-evidence';
  }
  if (addressing.metadata.writebackDisplacement == null) return 'arm64-structure-memory-post-index-required';
  return BigInt(addressing.metadata.writebackDisplacement) === BigInt(transferredBytes)
    ? null : 'arm64-structure-memory-post-index-immediate-does-not-match-transfer-size';
}

function accessFor(ctx, addressExpr, widthBits) {
  return createMemoryAccess({
    space:'memory', addressExpr, widthBits, endian:ctx.dataEndianness,
    alignment:Math.max(1, widthBits / 8),
  }, ctx.options);
}

function memoryAccessMetadata(mnemonic, arrangement, register, registerIndex, elementIndex, memoryElementIndex, addressing) {
  return {
    architecture:'arm64',
    mnemonic,
    transfer:'structure',
    arrangement,
    structureRegisterIndex:registerIndex,
    registerId:register.physicalId,
    elementIndex,
    memoryElementIndex,
    accessOrder:memoryElementIndex,
    addressing:addressing.metadata,
  };
}

export function isArm64StructureMemoryInstruction(decodedOrMnemonic) {
  const mnemonic = typeof decodedOrMnemonic === 'string'
    ? decodedOrMnemonic.trim().toLowerCase() : instructionMnemonic(decodedOrMnemonic);
  return STRUCTURE_MEMORY_MNEMONICS.has(mnemonic);
}

export function liftArm64StructureMemoryEffects(decoded, context = {}) {
  const mnemonic = instructionMnemonic(decoded);
  if (!STRUCTURE_MEMORY_MNEMONICS.has(mnemonic)) return null;
  const ctx = arm64EffectIdentityContext(decoded, context);
  const ops = operandsOf(decoded);
  if (ops.length !== 2 || ops[0]?.k !== 'list' || !isMemoryOperand(ops[1])) {
    return partial(decoded, context, 'arm64-structure-memory-operand-shape-invalid');
  }

  const list = canonicalRegisterList(ops[0], mnemonic);
  if (list.reason) return partial(decoded, context, list.reason);
  const { registers, arrangement, laneCount, elementBits, vectorBits } = list;
  const elementBytes = elementBits / 8;
  const transferredBytes = registers.length * laneCount * elementBytes;

  let addressing;
  try {
    addressing = buildArm64EffectiveAddress(decoded, { prefix:'structure.address', accessWidthBits:elementBits });
  } catch (error) {
    if (error instanceof Arm64AddressingError) return partial(decoded, context, error.code);
    throw error;
  }
  const addressError = validateAddressing(addressing, transferredBytes);
  if (addressError) return partial(decoded, context, addressError);

  const isLoad = mnemonic.startsWith('ld');
  const direction = isLoad ? 'read' : 'write';
  const operations = [...addressing.readOperations];
  const possibleFaults = [];
  if (addressing.base.kind === 'sp') {
    possibleFaults.push({
      kind:'stack-pointer-alignment-fault',
      condition:{ kind:'sp-misaligned', alignment:16 },
      detail:{ baseRegister:'sp', architecturalCheck:'CheckSPAlignment' },
    });
  }
  const tagChecked = addressing.base.kind !== 'sp' || addressing.mode !== 'offset';
  const registerCount = registers.length;
  const elementCount = registerCount * laneCount;

  if (isLoad) {
    const registerLanes = registers.map(() => []);
    for (let memoryElementIndex = 0; memoryElementIndex < elementCount; memoryElementIndex++) {
      let registerIndex;
      let elementIndex;
      if (mnemonic.endsWith('1')) {
        registerIndex = Math.floor(memoryElementIndex / laneCount);
        elementIndex = memoryElementIndex % laneCount;
      } else {
        elementIndex = Math.floor(memoryElementIndex / registerCount);
        registerIndex = memoryElementIndex % registerCount;
      }
      const register = registers[registerIndex];
      const addressExpr = arm64AddressOffset(addressing.addressExpr, BigInt(memoryElementIndex * elementBytes));
      const access = accessFor(ctx, addressExpr, elementBits);
      possibleFaults.push(...addressFaults(direction, {
        accessIndex:memoryElementIndex, addressExpr, alignment:elementBytes, tagChecked,
      }));
      const metadata = memoryAccessMetadata(mnemonic, arrangement, register, registerIndex, elementIndex, memoryElementIndex, addressing);
      const raw = arm64Temporary(`structure.load.element.${memoryElementIndex}`, elementBits);
      operations.push(createMachineOperation({ kind:'memory-read', access, value:raw, metadata }));
      registerLanes[registerIndex].push({ elementIndex, memoryElementIndex, value:raw });
    }

    for (let registerIndex = 0; registerIndex < registerCount; registerIndex++) {
      const register = registers[registerIndex];
      let vector = createBitVectorValue(vectorBits, 0n);
      const lanes = registerLanes[registerIndex];
      for (const { elementIndex, memoryElementIndex, value } of lanes) {
        const assembled = arm64Temporary(`structure.load.v${register.num}.lane.${elementIndex}`, vectorBits);
        operations.push(createMachineOperation({
          kind:'value',
          opcode:'insert-lane',
          inputs:[vector, value],
          outputs:[assembled],
          metadata:{
            architecture:'arm64', purpose:'arm64-structure-load-deinterleave',
            registerId:register.physicalId, structureRegisterIndex:registerIndex,
            arrangement, laneIndex:elementIndex, laneWidthBits:elementBits,
            memoryElementIndex,
          },
        }));
        vector = assembled;
      }
      let physical = vector;
      if (vectorBits < 128) {
        physical = arm64Temporary(`structure.load.v${register.num}.physical`, 128);
        operations.push(createMachineOperation({
          kind:'value', opcode:'zero-extend', inputs:[vector], outputs:[physical],
          metadata:{ architecture:'arm64', fromBits:vectorBits, toBits:128, writePolicy:'zero-upper-vector-bits' },
        }));
      }
      operations.push(createArm64RegisterWrite(register, physical, {
        physicalWidth:128,
        metadata:{
          purpose:'arm64-structure-load', registerIndex, arrangement,
          writePolicy:vectorBits < 128 ? 'zero-upper-vector-bits' : 'full-width',
        },
      }));
    }
  } else {
    const registerValues = registers.map((register, registerIndex) => {
      const read = createArm64RegisterRead(register, `structure.store.v${register.num}`, 128);
      operations.push(read.operation);
      return read.value;
    });
    for (let memoryElementIndex = 0; memoryElementIndex < elementCount; memoryElementIndex++) {
      let registerIndex;
      let elementIndex;
      if (mnemonic.endsWith('1')) {
        registerIndex = Math.floor(memoryElementIndex / laneCount);
        elementIndex = memoryElementIndex % laneCount;
      } else {
        elementIndex = Math.floor(memoryElementIndex / registerCount);
        registerIndex = memoryElementIndex % registerCount;
      }
      const register = registers[registerIndex];
      const metadata = memoryAccessMetadata(mnemonic, arrangement, register, registerIndex, elementIndex, memoryElementIndex, addressing);
      const source = arm64Temporary(`structure.store.element.${memoryElementIndex}`, elementBits);
      operations.push(createMachineOperation({
        kind:'value', opcode:'extract-lane', inputs:[registerValues[registerIndex]], outputs:[source],
        metadata:{
          architecture:'arm64', purpose:'arm64-structure-store-interleave',
          registerId:register.physicalId, structureRegisterIndex:registerIndex,
          arrangement, laneIndex:elementIndex,
          laneWidthBits:elementBits, sourceWidthBits:128, memoryElementIndex,
        },
      }));
      const addressExpr = arm64AddressOffset(addressing.addressExpr, BigInt(memoryElementIndex * elementBytes));
      const access = accessFor(ctx, addressExpr, elementBits);
      possibleFaults.push(...addressFaults(direction, {
        accessIndex:memoryElementIndex, addressExpr, alignment:elementBytes, tagChecked,
      }));
      operations.push(createMachineOperation({ kind:'memory-write', access, value:source, metadata }));
    }
  }

  operations.push(...addressing.writebackOperations);
  return bundle(decoded, context, {
    operations,
    possibleFaults,
    metadata:{
      arrangement, elementBits, elementBytes, laneCount, registerCount,
      memoryElementCount:elementCount,
      deinterleaved:!mnemonic.endsWith('1'),
      addressing:addressing.metadata,
    },
  });
}
