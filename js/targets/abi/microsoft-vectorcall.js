import { ABIPlugin } from './registry.js';
import { MICROSOFT_X64_ABI, callPrototypeOf, parameterClass, typeBits, microsoftX64AggregateReturnDecision, microsoftX64ReturnResult } from './microsoft-x64.js';
import { aggregateLayoutDescriptorPresent, canonicalAggregateLayout } from './aggregate-layout.js';

const INTEGER_ARGUMENT_REGISTERS = Object.freeze(['rcx','rdx','r8','r9']);
const VECTOR_REGISTER_COUNT = 6;
const VECTOR_ARGUMENT_REGISTERS = Object.freeze(Array.from({ length:VECTOR_REGISTER_COUNT }, (_value,index) => `xmm${index}`));
const VECTORCALL_NAMES = new Set(['vectorcall','microsoft-vectorcall']);

function parameterList(prototype) {
  const list = prototype && (prototype.args || prototype.parameters || prototype.params || prototype.arguments);
  return Array.isArray(list) ? list : null;
}

function canonicalConvention(value) {
  return String(value || '').trim().toLowerCase().replace(/^__/, '');
}

function conventionOf(prototype, options = {}) {
  return canonicalConvention(options.callingConvention ?? options.convention ?? options.cc
    ?? prototype?.callingConvention ?? prototype?.convention ?? prototype?.cc ?? null);
}

function nestedRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function descriptorBoolean(parameter, key) {
  const owners = [parameter];
  if (nestedRecord(parameter?.layout)) owners.push(parameter.layout);
  if (nestedRecord(parameter?.returnAggregate)) owners.push(parameter.returnAggregate);
  if (nestedRecord(parameter?.returnAggregate?.layout)) owners.push(parameter.returnAggregate.layout);
  const values = owners.filter((owner) => Object.hasOwn(owner, key)).map((owner) => owner[key]);
  if (!values.length) return { present:false, value:false };
  if (values.some((value) => typeof value !== 'boolean')) return { present:true, value:null };
  return { present:true, value:values.every((value) => value === values[0]) ? values[0] : null };
}

function vectorRegister(index, bits) {
  if (bits > 256) return `zmm${index}`;
  if (bits > 128) return `ymm${index}`;
  return `xmm${index}`;
}

function unsupported(convention) {
  return {
    srcs:[], arguments:[], stackArguments:[], stackArgsUnknown:true,
    stackArgsMayContainPointers:true, partial:true, unsupported:true,
    reason:'microsoft-vectorcall-calling-convention-mismatch',
    callingConvention:convention,
    evidence:'unsupported-microsoft-vectorcall-convention',
  };
}

function appendSource(srcs, reg, bits, extra = {}) {
  srcs.push({ t:'reg', reg, bits, possible:false, mustUse:true, ...extra });
}

function hasPhysicalAggregateDescriptor(parameter) {
  if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) return false;
  if (Object.hasOwn(parameter, 'layout')) return true;
  const nested = parameter.returnAggregate && typeof parameter.returnAggregate === 'object'
    && !Array.isArray(parameter.returnAggregate) ? parameter.returnAggregate : null;
  const layout = parameter.layout && typeof parameter.layout === 'object' && !Array.isArray(parameter.layout)
    ? parameter.layout : null;
  const nestedLayout = nested?.layout && typeof nested.layout === 'object' && !Array.isArray(nested.layout)
    ? nested.layout : null;
  return [parameter, layout, nested, nestedLayout].some((owner) => owner && [
    'padding', 'paddings', 'paddingBytes',
  ].some((field) => Object.hasOwn(owner, field)))
    || [parameter, layout, nested, nestedLayout].some((owner) => owner && [
      'members', 'fields', 'elements',
    ].some((field) => Array.isArray(owner[field])
      || (owner[field] && typeof owner[field] === 'object')));
}

function hvaInfo(parameter, classified) {
  const type = `${classified.type} ${classified.abiClass}`;
  const hvaMeta = descriptorBoolean(parameter, 'hva');
  const hfaMeta = descriptorBoolean(parameter, 'hfa');
  const metadataInvalid = (hvaMeta.present && hvaMeta.value === null)
    || (hfaMeta.present && hfaMeta.value === null);
  const hva = hvaMeta.value === true || hfaMeta.value === true || /hva|homogeneous vector/.test(type);
  const canonical = classified.aggregateLayout;
  const rawMembers = canonical?.members ?? parameter?.members ?? parameter?.elements ?? parameter?.count;
  const declaredMembers = Array.isArray(rawMembers) ? rawMembers.length : Number(rawMembers);
  const members = hva && Number.isSafeInteger(declaredMembers) && declaredMembers >= 1 && declaredMembers <= 4
    ? declaredMembers : hva ? 0 : 1;
  const rawElementBits = Number(canonical?.members?.[0]?.bits
    ?? parameter?.elementBits ?? parameter?.memberBits
    ?? (Array.isArray(rawMembers) ? rawMembers[0]?.bits ?? rawMembers[0]?.sizeBits : null));
  // Microsoft x64 __vectorcall: a vector type is a floating-point type
  // (float, double) OR a SIMD vector type, so an HVA of 32-bit floats is
  // valid. Elements pass in XMM registers; the previous 64-bit minimum
  // demoted every float HVA to unproven.
  const elementBits = Number.isSafeInteger(rawElementBits) && rawElementBits >= 32 && rawElementBits <= 256
    && (rawElementBits === 32 || rawElementBits === 64 || rawElementBits === 128 || rawElementBits === 256)
    ? rawElementBits : 0;
  const elementBytes = canonical?.members?.[0]?.bytes
    ?? (elementBits > 0 ? Math.ceil(elementBits / 8) : 0);
  const bytes = canonical?.bytes ?? (members > 0 && elementBytes > 0 ? members * elementBytes : 0);
  const canonicalLayoutValid = !canonical || (canonical.members.length === members
    && canonical.members.every((member, index) => member.bits === elementBits
      && member.bytes === elementBytes && member.byteOffset === index * elementBytes)
    && bytes === members * elementBytes);
  // A numeric `members`/`count` is the legacy vectorcall HVA shape.  Treat it
  // as the old logical proof, but any array/object layout descriptor must be
  // canonicalized and must not fall back to those top-level aliases.
  const descriptorMalformed = hva && hasPhysicalAggregateDescriptor(parameter)
    && !canonical;
  const layoutProven = !hva || (!descriptorMalformed && canonicalLayoutValid
    && members > 0 && elementBits > 0 && Number.isSafeInteger(classified.bits)
    && classified.bits === members * elementBits
    && hvaMeta.value !== null && hfaMeta.value !== null
    && !(hvaMeta.value === true && hfaMeta.value === true));
  return { hva, members, elementBits, elementBytes, bytes, layoutProven,
    descriptorMalformed, metadataInvalid, canonical };
}

export function classifyMicrosoftVectorcallArguments(instruction, options = {}) {
  const prototype = callPrototypeOf(instruction, options);
  const convention = conventionOf(prototype, options);
  if (convention && !VECTORCALL_NAMES.has(convention)) return unsupported(convention);
  /* MSVC rejects variadic `__vectorcall` prototypes outright ("can't use a
   * vararg variable length argument list"), so the combination is a
   * contradictory prototype, not a partially known ABI: fail closed instead of
   * publishing exact fixed-parameter placements for a call that cannot exist. */
  if (prototype?.variadic === true || prototype?.varargs === true) {
    return {
      srcs:[], arguments:[], stackArguments:[], stackArgsUnknown:true,
      stackArgsMayContainPointers:true, partial:true, unsupported:true,
      reason:'microsoft-vectorcall-variadic-unsupported',
      callingConvention:convention || 'vectorcall',
      evidence:'unsupported-microsoft-vectorcall-variadic',
    };
  }
  const parameters = parameterList(prototype);
  if (!parameters) {
    const srcs = [
      ...INTEGER_ARGUMENT_REGISTERS.map((reg) => ({ t:'reg', reg, bits:64, possible:true, mustUse:false, exact:false, certainty:'unknown' })),
      ...Array.from({ length:VECTOR_REGISTER_COUNT }, (_value, index) => ({ t:'reg', reg:`xmm${index}`, bits:128, possible:true, mustUse:false, exact:false, certainty:'unknown', wideVectorPossible:true })),
    ];
    return {
      srcs,
      arguments:srcs.map((source) => ({ location:'register', reg:source.reg, bits:source.bits, possible:true, mustUse:false, exact:false, certainty:'unknown' })),
      stackArguments:[], stackArgsUnknown:true, stackArgsMayContainPointers:true,
      partial:true, evidence:'conservative-microsoft-vectorcall',
    };
  }

  const srcs = [];
  const arguments_ = [];
  const stackArguments = [];
  /* __vectorcall register allocation (#5586): the first six argument
   * positions carrying vector/FP values map to their own position's
   * XMM/YMM0..5 and are reserved up front — even before any HVA runs — so a
   * later positional vector can never have its register stolen by an
   * earlier HVA. HVA members then fill the still-unused vector registers
   * left to right; an HVA that cannot fit the unused registers passes by
   * reference. */
  const vectorUsed = Array.from({ length:VECTOR_REGISTER_COUNT }, () => false);
  parameters.forEach((parameter, position) => {
    if (position >= VECTOR_REGISTER_COUNT) return;
    const classified = parameterClass(parameter);
    const hva = hvaInfo(parameter, classified);
    if (!hva.hva && (classified.vector ? classified.bits <= 256 : classified.floating)) {
      vectorUsed[position] = true;
    }
  });
  const nextFreeVectorPositions = (count) => {
    const positions = [];
    for (let cursor = 0; cursor < VECTOR_REGISTER_COUNT && positions.length < count; cursor++) {
      if (!vectorUsed[cursor]) positions.push(cursor);
    }
    return positions;
  };
  let stackIndex = 0;
  let stackArgsMayContainPointers = false;
  let aggregatePartial = false;
  let vectorAllocationUnknown = false;

  parameters.forEach((parameter, index) => {
    const classified = parameterClass(parameter);
    /* An intrinsic vector spelling and a conflicting declared width cannot
     * both be true; fail closed instead of publishing an exact register or
     * stack placement for an impossible type. */
    if (classified.intrinsicBitsConflict) {
      aggregatePartial = true;
      arguments_.push({
        index, location:'unknown', abiClass:'vector-width-conflict',
        partial:true, possible:true, mustUse:false, exact:false, certainty:'unknown',
        reason:'microsoft-vectorcall-intrinsic-vector-width-conflict',
      });
      return;
    }
    const hva = hvaInfo(parameter, classified);
    const uncertainHvaBefore = vectorAllocationUnknown;
    if (hva.metadataInvalid) {
      aggregatePartial = true;
      if (hva.hva) vectorAllocationUnknown = true;
      arguments_.push({ index, location:'unknown', abiClass:'aggregate-metadata-unproven', aggregate:true,
        partial:true, possible:true, mustUse:false, exact:false, certainty:'unknown',
        reason:'aggregate-hfa-hva-metadata-invalid' });
      return;
    }
    if (hva.hva && !hva.layoutProven) {
      aggregatePartial = true;
      if (hva.hva) vectorAllocationUnknown = true;
      arguments_.push({
        index, location:'unknown', abiClass:'hva-unproven', aggregate:true,
        partial:true, possible:true, mustUse:false, exact:false, certainty:'unknown',
        reason:'microsoft-vectorcall-hva-member-layout-not-proven',
      });
      return;
    }
    const vectorValue = classified.vector || hva.hva;
    if (vectorValue) {
      const regsNeeded = hva.hva ? hva.members : 1;
      const elementBits = hva.hva ? hva.elementBits : classified.bits;
      const elementBytes = hva.hva ? hva.elementBytes : Math.ceil(classified.bits / 8);
      const physicalBytes = hva.hva ? hva.bytes : Math.ceil(classified.bits / 8);
      if (hva.hva && physicalBytes > Math.ceil(classified.bits / 8)) {
        aggregatePartial = true;
        if (hva.hva) vectorAllocationUnknown = true;
        arguments_.push({ index, location:'unknown', abiClass:'hva-padding-register-layout-unproven', aggregate:true,
          partial:true, possible:true, mustUse:false, exact:false, certainty:'unknown',
          reason:'microsoft-vectorcall-padded-hva-register-layout-not-represented' });
        return;
      }
      if (uncertainHvaBefore && hva.hva) {
        aggregatePartial = true;
        const candidateRegisters = VECTOR_ARGUMENT_REGISTERS.filter((_reg, position) => !vectorUsed[position]);
        arguments_.push({
          index, location:'unknown', candidateRegisters, stackPossible:true,
          abiClass:'hva-after-unproven-hva', aggregate:true, pointer:true,
          bits:classified.bits, partial:true, possible:true, mustUse:false,
          exact:false, certainty:'unknown',
          reason:'microsoft-vectorcall-hva-register-allocation-uncertain',
        });
        stackArgsMayContainPointers = true;
        vectorAllocationUnknown = true;
        return;
      }
      /* A positional vector/FP value always has its own position's register
       * available (reserved in the pre-pass); positions beyond the six
       * vector slots never had a register and keep the by-reference stack
       * fallback. HVA members take the unused registers; when too few
       * remain the HVA passes by reference. */
      const freePositions = hva.hva
        ? nextFreeVectorPositions(regsNeeded)
        : (index < VECTOR_REGISTER_COUNT ? [index] : []);
      if (elementBits <= 256 && freePositions.length === regsNeeded) {
        const regs = [];
        for (const registerPosition of freePositions) {
          vectorUsed[registerPosition] = true;
          const reg = vectorRegister(registerPosition, elementBits);
          regs.push(reg);
          appendSource(srcs, reg, elementBits, { purpose:hva.hva?'vectorcall-hva':'vectorcall-vector' });
        }
        arguments_.push({
          index, location:'register', reg:regs[0], regs,
          abiClass:hva.hva?'hva':'vector', bits:classified.bits,
          bytes:physicalBytes,
          vectorElementBits:elementBits, pointer:false,
          ...(hva.hva ? {
            aggregate:true, members:hva.members, memberCount:hva.members, elementBits:hva.elementBits,
            elementBytes, homogeneousLayoutProven:true,
            pieces:regs.map((reg,piece) => ({
              pieceIndex:piece, order:piece, reg, abiClass:'hva', bits:hva.elementBits,
              bytes:elementBytes, byteOffset:piece * elementBytes,
            })),
          } : {}),
          possible:false, mustUse:true,
        });
        return;
      }
      // An HVA in one of the first four parameter positions that cannot fit
      // the remaining vector registers passes a reference to caller-allocated
      // memory in the integer register corresponding to its position
      // (RCX/RDX/R8/R9 per Microsoft x64 __vectorcall) — it never falls
      // directly to the stack.
      if (hva.hva && index < INTEGER_ARGUMENT_REGISTERS.length) {
        const integerRegister = INTEGER_ARGUMENT_REGISTERS[index];
        const entry = {
          index, location:'register', reg:integerRegister,
          abiClass:'hva-indirect', pointer:true, indirectReference:true,
          bits:64, pointeeBits:classified.bits,
          requiredTemporaryAlignment:Math.min(32, Math.max(16, Math.ceil(classified.bits / 8))),
          bytes:8,
          pieces:[{ pieceIndex:0, order:0, reg:integerRegister, abiClass:'hva-indirect', bits:64, bytes:8, byteOffset:0 }],
          possible:false, mustUse:true,
        };
        arguments_.push(entry);
        appendSource(srcs, integerRegister, 64, { purpose:'vectorcall-hva-indirect' });
        return;
      }
      const offset = 32 + stackIndex++ * 8;
      const entry = {
        index, location:'stack', offset, offsetBase:'caller-stack-before-call', calleeEntryOffset:offset + 8,
        bytes:8, abiClass:hva.hva?'hva-indirect':'vector-indirect', pointer:true,
        bits:64, pointeeBits:classified.bits, requiredTemporaryAlignment:Math.min(32, Math.max(16, Math.ceil(classified.bits / 8))),
        pieces:[{ pieceIndex:0, order:0, stackOffset:offset,
          abiClass:hva.hva?'hva-indirect':'vector-indirect', bits:64, bytes:8, byteOffset:0 }],
        possible:false, mustUse:true,
      };
      arguments_.push(entry); stackArguments.push(entry); stackArgsMayContainPointers = true;
      return;
    }

    if (classified.aggregate) {
      if (classified.aggregateLayoutPresent && !classified.aggregateLayoutProven) {
        aggregatePartial = true;
        arguments_.push({ index, location:'unknown', abiClass:'aggregate-layout-unproven', aggregate:true,
          partial:true, possible:true, mustUse:false, exact:false, certainty:'unknown',
          reason:'microsoft-vectorcall-aggregate-layout-not-proven' });
        return;
      }
      /* __vectorcall extends the standard x64 convention: outside the
       * vector/HVA rules, integer-class arguments follow standard x64.
       * A trivial 8/16/32/64-bit aggregate with proven layout passes by
       * value in its integer location; proven other sizes pass by
       * reference; anything unproven stays partial (#5589). */
      const physicalPadding = classified.aggregateBytes > Math.ceil(classified.bits / 8);
      const exactSmallAggregate = !physicalPadding && classified.bitsProven && classified.trivialForCalls
        && [8,16,32,64].includes(classified.bits);
      const exactIndirect = classified.bitsProven
        && (classified.nonTrivialForCalls || ![8,16,32,64].includes(classified.bits));
      if (!exactSmallAggregate && !exactIndirect) {
        aggregatePartial = true;
        if (index < INTEGER_ARGUMENT_REGISTERS.length) {
          const candidates = [INTEGER_ARGUMENT_REGISTERS[index], VECTOR_ARGUMENT_REGISTERS[index]];
          arguments_.push({
            index, location:'unknown', candidateRegisters:candidates, stackPossible:false,
            abiClass:'aggregate-unclassified-partial', pointer:true, bits:classified.bits,
            partial:true, possible:true, mustUse:false, exact:false, certainty:'unknown',
          });
        } else {
          const offset = 32 + stackIndex++ * 8;
          const entry = {
            index, location:'stack', offset, offsetBase:'caller-stack-before-call', calleeEntryOffset:offset + 8,
            bytes:8, abiClass:'aggregate-unclassified-partial', pointer:true, bits:classified.bits,
            partial:true, possible:true, mustUse:false, exact:false, certainty:'unknown',
          };
          arguments_.push(entry); stackArguments.push(entry);
        }
        stackArgsMayContainPointers = true;
        return;
      }
      const indirect = !exactSmallAggregate;
      if (index < INTEGER_ARGUMENT_REGISTERS.length) {
        const reg = INTEGER_ARGUMENT_REGISTERS[index];
        appendSource(srcs, reg, indirect ? 64 : classified.bits,
          { purpose:indirect ? 'vectorcall-aggregate-by-reference' : 'vectorcall-aggregate-value' });
        arguments_.push({ index, location:'register', reg, aggregate:true,
          abiClass:indirect ? 'aggregate-indirect' : 'integer-aggregate',
          pointer:indirect, bits:indirect ? 64 : classified.bits,
          bytes:indirect ? 8 : Math.max(8, Math.ceil(classified.bits / 8)),
          pointeeBits:indirect ? classified.bits : undefined,
          pieces:[{ pieceIndex:0, order:0, reg, abiClass:indirect ? 'aggregate-indirect' : 'integer-aggregate',
            bits:indirect ? 64 : classified.bits, bytes:indirect ? 8 : Math.max(8, Math.ceil(classified.bits / 8)), byteOffset:0 }],
          possible:false, mustUse:true });
      } else {
        const offset = 32 + stackIndex++ * 8;
        const entry = { index, location:'stack', offset, offsetBase:'caller-stack-before-call', calleeEntryOffset:offset + 8,
          aggregate:true, bytes:8, abiClass:indirect ? 'aggregate-indirect' : 'integer-aggregate',
          pointer:indirect, bits:indirect ? 64 : classified.bits,
          pointeeBits:indirect ? classified.bits : undefined,
          pieces:[{ pieceIndex:0, order:0, stackOffset:offset, abiClass:indirect ? 'aggregate-indirect' : 'integer-aggregate',
            bits:indirect ? 64 : classified.bits, bytes:8, byteOffset:0 }],
          possible:false, mustUse:true };
        arguments_.push(entry); stackArguments.push(entry);
      }
      stackArgsMayContainPointers ||= indirect || classified.pointer;
      return;
    }

    if (classified.floating && index < VECTOR_REGISTER_COUNT) {
      /* Position-mapped allocation: a scalar FP value in one of the first
       * six positions uses its own position's register (XMM0-5, width view)
       * — the pre-pass reserved it, so it is always free here (#5586). */
      const reg = vectorRegister(index, classified.bits);
      appendSource(srcs, reg, classified.bits, { purpose:'vectorcall-scalar-fp' });
      arguments_.push({ index, location:'register', reg, abiClass:'fp', pointer:false, bits:classified.bits, possible:false, mustUse:true });
      return;
    }

    if (classified.floating) {
      // Vectorcall passes vector/FP arguments in positions six and later by
      // reference to caller-allocated memory, so the stack slot contains a
      // pointer even for a scalar floating-point value (#5586).
      const offset = 32 + stackIndex++ * 8;
      const entry = {
        index, location:'stack', offset, offsetBase:'caller-stack-before-call', calleeEntryOffset:offset + 8,
        bytes:8, abiClass:'fp-indirect', pointer:true, indirectReference:true,
        bits:64, pointeeBits:classified.bits,
        pieces:[{ pieceIndex:0, order:0, stackOffset:offset,
          abiClass:'fp-indirect', bits:64, bytes:8, byteOffset:0 }],
        possible:false, mustUse:true,
      };
      arguments_.push(entry); stackArguments.push(entry); stackArgsMayContainPointers = true;
      return;
    }

    if (index < INTEGER_ARGUMENT_REGISTERS.length) {
      const reg = INTEGER_ARGUMENT_REGISTERS[index];
      appendSource(srcs, reg, 64, { purpose:'vectorcall-integer' });
      arguments_.push({ index, location:'register', reg, abiClass:classified.pointer?'pointer':'integer', pointer:classified.pointer, bits:classified.bits, possible:false, mustUse:true });
      stackArgsMayContainPointers ||= classified.pointer;
      return;
    }

    const offset = 32 + stackIndex++ * 8;
    const entry = { index, location:'stack', offset, offsetBase:'caller-stack-before-call', calleeEntryOffset:offset + 8, bytes:8, abiClass:classified.floating?'fp':classified.pointer?'pointer':'integer', pointer:classified.pointer, bits:classified.bits, possible:false, mustUse:true };
    arguments_.push(entry); stackArguments.push(entry); stackArgsMayContainPointers ||= classified.pointer;
  });

  return {
    srcs, arguments:arguments_, stackArguments,
    stackArgsUnknown:prototype?.variadic===true||prototype?.varargs===true,
    stackArgsMayContainPointers:stackArgsMayContainPointers || prototype?.variadic===true || prototype?.varargs===true,
    partial:aggregatePartial || prototype?.variadic===true||prototype?.varargs===true,
    callingConvention:'vectorcall',
    evidence:'prototype-microsoft-vectorcall',
  };
}

function aggregateReturnDescriptor(prototype, options = {}) {
  const source = { ...(prototype || {}) };
  const explicit = options.returnBits ?? prototype?.returnBits ?? null;
  const explicitBits = explicit == null ? null : Number(explicit);
  const sourceBits = source.bits ?? source.sizeBits ?? null;
  const sourceBitsNumber = sourceBits == null ? null : Number(sourceBits);
  if (explicitBits != null && sourceBits != null
    && (!Number.isSafeInteger(explicitBits) || !Number.isSafeInteger(sourceBitsNumber)
      || explicitBits <= 0 || sourceBitsNumber !== explicitBits)) {
    return { present:true, layout:null, malformed:true, bits:explicitBits };
  }
  if (explicitBits != null && sourceBits == null && Number.isSafeInteger(explicitBits) && explicitBits > 0) {
    source.bits = explicitBits;
  }
  // Numeric `members`/`count` is the legacy vectorcall HVA shape; it is not a
  // physical descriptor by itself. Arrays, objects, padding, or `layout` are
  // physical evidence and therefore must survive canonical validation.
  const present = aggregateLayoutDescriptorPresent(source);
  const physical = hasPhysicalAggregateDescriptor(source);
  const layout = physical ? canonicalAggregateLayout(source) : null;
  return { present:physical || present, layout, malformed:physical && layout == null,
    bits:layout?.bits ?? (Number.isSafeInteger(explicitBits) && explicitBits > 0 ? explicitBits : sourceBitsNumber) };
}

function vectorcallReturn(prototype, options = {}) {
  if (!prototype) return { reg:null, partial:true, reason:'prototype-missing' };
  const convention = conventionOf(prototype, options);
  if (convention && !VECTORCALL_NAMES.has(convention)) return { reg:null, partial:true, unsupported:true, reason:'microsoft-vectorcall-calling-convention-mismatch' };
  const type = String(options.returnType || prototype.returnType || prototype.ret || prototype.result || '').trim().toLowerCase();
  const abiClass = String(options.returnClass || prototype.returnClass || prototype.abiClass || prototype.resultClass || '').trim().toLowerCase();
  if (options.returnsValue === false || prototype.returnsValue === false || prototype.void === true || type === 'void' || abiClass === 'void') return null;
  const returnAggregate = prototype.returnAggregate && typeof prototype.returnAggregate === 'object'
    && !Array.isArray(prototype.returnAggregate) ? prototype.returnAggregate : null;
  const homogeneous = prototype.hva === true || prototype.hfa === true
    || returnAggregate?.hva === true || returnAggregate?.hfa === true
    || abiClass.includes('hva') || abiClass.includes('homogeneous');
  if (homogeneous) {
    const descriptor = aggregateReturnDescriptor(prototype, options);
    if (descriptor.malformed) {
      return { reg:null, partial:true, aggregate:true, reason:'microsoft-vectorcall-hva-return-layout-not-proven' };
    }
    const rawMembers = descriptor.layout?.members
      ?? prototype.members ?? prototype.memberCount ?? prototype.elements ?? prototype.count;
    const members = Array.isArray(rawMembers) ? rawMembers.length : Number(rawMembers);
    const elementBits = Number(descriptor.layout?.members?.[0]?.bits
      ?? prototype.elementBits ?? prototype.memberBits
      ?? (Array.isArray(rawMembers) ? rawMembers[0]?.bits ?? rawMembers[0]?.sizeBits : null));
    const rawBits = Number(descriptor.bits ?? options.returnBits ?? prototype.returnBits ?? prototype.bits);
    const elementBytes = descriptor.layout?.members?.[0]?.bytes
      ?? (Number.isSafeInteger(elementBits) && elementBits > 0 ? Math.ceil(elementBits / 8) : 0);
    const physicalBytes = descriptor.layout?.bytes
      ?? (Number.isSafeInteger(members) && members > 0 && elementBytes > 0 ? members * elementBytes : 0);
    const canonicalLayoutValid = !descriptor.layout || (descriptor.layout.members.length === members
      && descriptor.layout.members.every((member, index) => member.bits === elementBits
        && member.bytes === elementBytes && member.byteOffset === index * elementBytes)
      && physicalBytes === members * elementBytes);
    if (!Number.isSafeInteger(members) || members < 1 || members > 4
      || !Number.isSafeInteger(elementBits) || elementBits < 32 || elementBits > 256
      || (elementBits !== 32 && elementBits !== 64 && elementBits !== 128 && elementBits !== 256)
      || !Number.isSafeInteger(rawBits) || rawBits !== members * elementBits
      || !canonicalLayoutValid || physicalBytes <= 0
      || physicalBytes > Math.ceil(rawBits / 8)) {
      return { reg:null, partial:true, aggregate:true, reason:'microsoft-vectorcall-hva-return-layout-not-proven' };
    }
    const pieces = Array.from({ length:members }, (_unused,index) => ({
      pieceIndex:index, order:index, reg:vectorRegister(index, elementBits), abiClass:'hva',
      bits:elementBits, bytes:elementBytes, byteOffset:index * elementBytes,
    }));
    return {
      reg:pieces[0].reg, regs:pieces.map((piece) => piece.reg), pieces,
      bits:rawBits, bytes:physicalBytes, aggregate:true, abiClass:'hva',
      members, elementBits, homogeneousLayoutProven:true,
    };
  }
  const vector = /vector|simd|sse|__m128|__m256/.test(`${type} ${abiClass}`);
  if (vector) {
    const rawBits = Number(options.returnBits ?? prototype.returnBits ?? prototype.bits ?? typeBits(type, /__m256/.test(type) ? 256 : 128));
    const bits = Number.isSafeInteger(rawBits) && rawBits > 0 ? rawBits : 128;
    if (bits <= 256) return { reg:vectorRegister(0, bits), bits, abiClass:'vector' };
    return { reg:null, partial:true, reason:'microsoft-vectorcall-wide-vector-return-unsupported' };
  }
  if (/float|double|\bfp\b/.test(`${type} ${abiClass}`)) {
    const words = `${type} ${abiClass}`.split(/[^a-z0-9]+/);
    const canonical = words.includes('float') && !words.includes('double') ? 32
      : words.includes('double') && !words.includes('float') ? 64 : null;
    const explicit = options.returnBits ?? prototype.returnBits ?? prototype.bits;
    const bits = Number(explicit ?? typeBits(type, 64));
    if (!Number.isSafeInteger(bits) || bits <= 0) return { reg:null, partial:true, reason:'microsoft-vectorcall-return-width-invalid' };
    if (canonical != null && explicit != null && bits !== canonical) {
      return { reg:null, partial:true, reason:'microsoft-vectorcall-return-width-contradicts-type' };
    }
    if (bits > 128) return { reg:null, partial:true, reason:'microsoft-vectorcall-wide-fp-return-unsupported' };
    return { reg:'xmm0', bits, abiClass:'fp' };
  }
  const aggregate = prototype.aggregate === true
    || aggregateLayoutDescriptorPresent(prototype)
    || (prototype.returnAggregate && typeof prototype.returnAggregate === 'object'
      && !Array.isArray(prototype.returnAggregate))
    || (Object.hasOwn(prototype, 'returnAggregate') && prototype.returnAggregate != null
      && typeof prototype.returnAggregate !== 'boolean')
    || /aggregate|struct|union|record|array/.test(`${type} ${abiClass}`);
  if (aggregate) {
    /* __vectorcall inherits the standard x64 integer-return rule: results of
     * integer type, including structs/unions of 8 bytes or less, return by
     * value in RAX. Reuse the shared standard-x64 decision instead of an
     * unconditional partial so a proven trivial small aggregate classifies
     * exactly like Win64 (#5590). The hidden-result path additionally
     * requires its own profile proof: the physical pointee layout plus an
     * asserted copy-semantics intent (trivial or non-trivial). Without both
     * the sret contract stays conservative. */
    const descriptor = aggregateReturnDescriptor(prototype, options);
    const decision = microsoftX64AggregateReturnDecision(descriptor, prototype, options);
    if (decision.kind === 'direct' && !descriptor.layout) {
      return { reg:null, partial:true, aggregate:true,
        reason:'microsoft-vectorcall-non-hva-aggregate-return-requires-layout-proof' };
    }
    if (decision.kind === 'indirect') {
      const layoutProven = !!descriptor.layout;
      const copySemanticsAsserted = options.returnTrivialForCalls === true
        || prototype?.returnTrivialForCalls === true || prototype?.trivialForCalls === true
        || prototype?.pod === true
        || options.returnNonTrivialForCalls === true
        || prototype?.returnNonTrivialForCalls === true
        || prototype?.nonTrivialForCalls === true || prototype?.nonTrivial === true;
      if (!layoutProven || !copySemanticsAsserted) {
        return { reg:null, partial:true, aggregate:true,
          pointeeBits:decision.pointeeBits ?? null, hiddenResultPossible:true,
          reason:'microsoft-vectorcall-non-hva-aggregate-return-requires-layout-proof' };
      }
    }
    return microsoftX64ReturnResult(decision);
  }
  if (type || abiClass || options.returnsValue === true || prototype.returnsValue === true) {
    const bits = Number(options.returnBits ?? prototype.returnBits ?? prototype.bits ?? 64);
    if (!Number.isSafeInteger(bits) || bits <= 0) return { reg:null, partial:true, reason:'microsoft-vectorcall-return-width-invalid' };
    return { reg:'rax', bits };
  }
  return { reg:null, partial:true, reason:'return-value-evidence-missing' };
}

export function classifyMicrosoftVectorcallCallReturn(instruction, options = {}) {
  return vectorcallReturn(callPrototypeOf(instruction, options), options);
}
export function classifyMicrosoftVectorcallFunctionReturn(options = {}) {
  return vectorcallReturn(options.functionPrototype || options.prototype || {}, options);
}

export const MICROSOFT_VECTORCALL_ABI = new ABIPlugin({
  id:'microsoft-vectorcall', semanticVersion:'1', semanticIdentity:'microsoft-vectorcall@1', architectureId:'x86_64',
  platformPredicate:({ platform }) => ['windows','win32','windows-nt','pe'].includes(platform),
  callingConventions:()=>Object.freeze(['vectorcall','__vectorcall','microsoft-vectorcall']),
  classifyArguments:classifyMicrosoftVectorcallArguments,
  classifyCallReturn:classifyMicrosoftVectorcallCallReturn,
  classifyFunctionReturn:classifyMicrosoftVectorcallFunctionReturn,
  classifyEntryRegister:(reg) => {
    // Register identity is schema data: never stringify arrays/objects into
    // an argument-register token (#5718).
    const id = typeof reg === 'string' ? reg.toLowerCase() : '';
    const vectorIndex = VECTOR_ARGUMENT_REGISTERS.indexOf(id);
    if (vectorIndex >= 0) return { kind:'argument', reg:id, index:vectorIndex, abiClass:'fp-or-vector' };
    if (typeof reg !== 'string') return { kind:'incoming-register-state', reg:id };
    return MICROSOFT_X64_ABI.classifyEntryRegister(reg);
  },
  callerSaved:()=>MICROSOFT_X64_ABI.callerSaved(),
  calleeSaved:()=>MICROSOFT_X64_ABI.calleeSaved(),
  stackRules:()=>Object.freeze({ ...MICROSOFT_X64_ABI.stackRules(), callingConvention:'vectorcall', vectorArgumentRegisters:6 }),
  redZone:()=>0,
  unwindRules:()=>MICROSOFT_X64_ABI.unwindRules(),
  defaultUnknownCallEffects:()=>Object.freeze({ ...MICROSOFT_X64_ABI.defaultUnknownCallEffects(), vectorcallEffects:'unknown' }),
});