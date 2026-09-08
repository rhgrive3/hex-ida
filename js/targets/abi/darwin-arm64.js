import { ABIPlugin } from './registry.js';
import {
  aggregateLayoutDescriptorPresent,
  aggregateRequiresIndirectCopy,
  canonicalAggregateLayout,
} from './aggregate-layout.js';
import {
  AAPCS64_ABI,
  classifyAAPCS64CallReturn,
  classifyAAPCS64FunctionReturn,
} from './aapcs64.js';

const DARWIN_PLATFORMS = new Set(['darwin','apple','ios','ios-simulator','ipados','ipados-simulator','macos','maccatalyst','tvos','tvos-simulator','watchos','watchos-simulator','visionos','visionos-simulator','maccatalyst']);

function callPrototypeOf(insn, opts) {
  // Calls may arrive through the production functionPrototype field while
  // older callers still provide callPrototype. Normalize both to one source.
  let proto = insn?.callPrototype || insn?.functionPrototype || null;
  if (!proto) {
    try { proto = opts?.callPrototypeFor?.(insn?.callTarget ?? null, insn) || null; } catch { proto = null; }
  }
  return proto;
}

function parameterList(proto) {
  const list = proto && (proto.args || proto.parameters || proto.params || proto.arguments);
  return Array.isArray(list) ? list : null;
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
  const normalized = values;
  return { present:true, value:normalized.every((value) => value === normalized[0]) ? normalized[0] : null };
}

function aggregateAlignmentEvidence(parameter, layoutEvidence) {
  const alignmentKeys = ['alignmentBytes', 'alignBytes', 'alignment'];
  const ownAlignment = (record) => {
    if (!nestedRecord(record)) return { present:false, value:null };
    const owners = [record];
    if (nestedRecord(record.layout)) owners.push(record.layout);
    const values = owners
      .filter((owner) => alignmentKeys.some((key) => Object.hasOwn(owner, key)))
      .map((owner) => alignmentKeys
        .filter((key) => Object.hasOwn(owner, key))
        .map((key) => {
          const value = owner[key];
          return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
        }));
    if (!values.length) return { present:false, value:null };
    const flattened = values.flat();
    if (flattened.some((value) => value == null)
      || flattened.some((value) => value !== flattened[0])) return { present:true, value:null };
    return { present:true, value:flattened[0] };
  };
  const explicit = ownAlignment(parameter);
  if (explicit.present) return explicit.value == null
    ? { proven:false, alignment:1 } : { proven:true, alignment:explicit.value };
  if (!layoutEvidence?.members?.length) return { proven:false, alignment:1 };
  const memberAlignments = [];
  for (const member of layoutEvidence.members) {
    const evidence = ownAlignment(member);
    if (!evidence.present || evidence.value == null) return { proven:false, alignment:1 };
    memberAlignments.push(evidence.value);
  }
  return { proven:true, alignment:Math.max(8, ...memberAlignments) };
}

function pointerSpelling(value) {
  return /\*|(?:^|[^a-z0-9_])(?:pointer|ptr|object|class|block|closure)(?![a-z0-9_])/.test(String(value || '').toLowerCase());
}

function isAppleLongDoubleScalar(...values) {
  const text = values.map((value) => String(value || '')).join(' ').toLowerCase();
  return /(?:^|\s)long double(?:\s|$)/.test(text) && !pointerSpelling(text);
}

function parameterClass(param) {
  const type = String(param?.type || param?.name || '').toLowerCase();
  const cls = String(param?.abiClass || param?.class || param?.kind || '').toLowerCase();
  const pointer = param?.pointer === true || param?.isPointer === true || pointerSpelling(`${type} ${cls}`);
  const appleLongDouble = !pointer && /(?:^|\s)long double(?:\s|$)/.test(`${type} ${cls}`);
  const hfaMeta = descriptorBoolean(param, 'hfa');
  const hvaMeta = descriptorBoolean(param, 'hva');
  const aggregateMetadataInvalid = (hfaMeta.present && hfaMeta.value === null)
    || (hvaMeta.present && hvaMeta.value === null);
  const hfa = hfaMeta.value === true || param?.hfa === true || cls.includes('hfa') || cls.includes('homogeneous');
  const hva = hvaMeta.value === true || cls.includes('hva');
  const homogeneous = hfa || hva;
  const aggregateDescriptorPresent = aggregateLayoutDescriptorPresent(param);
  const aggregateHint = param?.aggregate === true || param?.isAggregate === true
    || aggregateDescriptorPresent || /aggregate|struct|union|record|array|composite/.test(`${type} ${cls}`);
  const vector = !aggregateHint && (param?.vector === true || cls.includes('vector') || /vector|simd/.test(type));
  const aggregate = !pointer && !homogeneous && !appleLongDouble && aggregateHint;
  const fp = !aggregate && (appleLongDouble || hfa || vector || cls.includes('float') || cls.includes('fp') || /^(float|double|__fp16)/.test(type));
  // A nested layout descriptor is the canonical aggregate source.  Resolve it
  // before reading legacy aliases so a classifier cannot publish bits/member
  // lanes from one descriptor while the validated physical layout comes from
  // another.
  const layoutEvidence = homogeneous || aggregate ? canonicalAggregateLayout(param) : null;
  const canonicalMembers = layoutEvidence?.members ?? null;
  const rawMembers = param?.members ?? param?.elements ?? canonicalMembers ?? param?.count;
  const memberArray = Array.isArray(rawMembers) ? rawMembers : null;
  const declaredMembers = memberArray ? memberArray.length : Number(rawMembers);
  const members = homogeneous && Number.isSafeInteger(declaredMembers) && declaredMembers >= 1 && declaredMembers <= 4
    ? declaredMembers : homogeneous ? 0 : 1;
  const declaredBits = Number(layoutEvidence?.bits ?? param?.bits ?? param?.sizeBits);
  const firstMemberBits = memberArray?.length ? Number(memberArray[0]?.bits ?? memberArray[0]?.sizeBits) : null;
  const declaredElementBits = Number(canonicalMembers?.[0]?.bits
    ?? param?.elementBits ?? param?.memberBits ?? firstMemberBits);
  const elementBits = homogeneous && Number.isSafeInteger(declaredElementBits) && declaredElementBits > 0
    ? declaredElementBits : homogeneous ? 0 : null;
  const explicitTotalBitsProven = Number.isSafeInteger(declaredBits) && declaredBits > 0;
  const homogeneousSizeMatches = !homogeneous || !explicitTotalBitsProven
    || (members > 0 && elementBits > 0 && declaredBits === members * elementBits);
  const homogeneousMembersMatch = !homogeneous || !!layoutEvidence
    && layoutEvidence.members.length === members
    && layoutEvidence.members.every((member) => member.bits === elementBits);
  const homogeneousElementBytes = homogeneous && layoutEvidence?.members?.length
    ? layoutEvidence.members[0].bytes : null;
  const homogeneousBytesMatch = !homogeneous || !!homogeneousElementBytes
    && layoutEvidence.members.every((member) => member.bytes === homogeneousElementBytes);
  const homogeneousOffsetsMatch = !homogeneous || !!homogeneousElementBytes
    && layoutEvidence.members.every((member, index) => member.byteOffset === index * homogeneousElementBytes);
  const homogeneousLayoutProven = !homogeneous
    || (!!layoutEvidence && members > 0 && elementBits > 0 && homogeneousSizeMatches
      && homogeneousMembersMatch && homogeneousBytesMatch && homogeneousOffsetsMatch
      && hfaMeta.value !== null && hvaMeta.value !== null
      && !(hfaMeta.value === true && hvaMeta.value === true));
  const aggregateLayoutProven = !aggregateMetadataInvalid && (!aggregate || !!layoutEvidence);
  const bits = homogeneous && members > 0 && elementBits > 0
    ? homogeneousSizeMatches ? Math.max(8, Math.min(512, elementBits * members))
      : Math.max(8, Math.min(512, explicitTotalBitsProven ? declaredBits : 64))
    : aggregate ? aggregateLayoutProven ? Math.max(8, Math.min(512, declaredBits)) : 0
      : Math.max(8, Math.min(512, explicitTotalBitsProven ? declaredBits : 64));
  const bytes = homogeneous
    ? layoutEvidence?.bytes ?? (bits > 0 ? Math.max(1, Math.ceil(bits / 8)) : 0)
    : aggregate
    ? layoutEvidence?.bytes ?? (bits > 0 ? Math.max(1, Math.ceil(bits / 8)) : 0)
    : bits > 0 ? Math.max(1, Math.ceil(bits / 8)) : 0;
  const rawExplicitAlignment = param?.alignmentBytes || param?.alignBytes || param?.alignment || 0;
  const explicitAlignment = typeof rawExplicitAlignment === 'number' ? rawExplicitAlignment : 0;
  const explicitAlignmentBytes = Number.isSafeInteger(explicitAlignment) && explicitAlignment > 0
    ? explicitAlignment : null;
  const explicitAlignmentProven = Number.isSafeInteger(explicitAlignment) && explicitAlignment > 0;
  const aggregateAlignment = aggregateAlignmentEvidence(param, layoutEvidence);
  let alignmentBytes = explicitAlignmentProven ? explicitAlignment : 1;
  if (!explicitAlignmentProven) {
    if (aggregate && aggregateAlignment.proven) alignmentBytes = aggregateAlignment.alignment;
    else if (homogeneous && homogeneousElementBytes > 0) alignmentBytes = homogeneousElementBytes;
    else if (!aggregate && bytes >= 16) alignmentBytes = 16;
    else if (bytes >= 8) alignmentBytes = 8;
    else if (bytes >= 4) alignmentBytes = 4;
    else if (bytes >= 2) alignmentBytes = 2;
  }
  const signed = param?.signed === true || /(^|\s)(?:signed|int\d*)/.test(type);
  return {
    pointer, hfa, hva, homogeneous, homogeneousLayoutProven, aggregateMetadataInvalid,
    aggregate, aggregateLayoutProven, aggregateAlignmentProven:!aggregate || aggregateAlignment.proven, aggregateLayout:layoutEvidence,
    aggregateBytes:aggregate ? bytes : null,
    vector, fp, members, elementBits,
    elementBytes:homogeneousElementBytes
      ?? (homogeneous && elementBits > 0 ? Math.ceil(elementBits / 8) : null),
    appleLongDouble,
    appleLongDoubleWidthConflict:appleLongDouble && explicitTotalBitsProven && bits !== 64,
    bits, bytes, alignmentBytes, explicitAlignmentBytes, signed,
  };
}

function alignUp(value, alignment) {
  const a = Math.max(1, Number(alignment) || 1);
  return Math.ceil(value / a) * a;
}

function registerSource(reg, bits) {
  return { t:'reg', reg, bits, possible:false, mustUse:true };
}

export function classifyDarwinArm64Arguments(insn, opts = {}) {
  const proto = callPrototypeOf(insn, opts);
  const params = parameterList(proto);
  const srcs = [];
  const arguments_ = [];
  const stackArguments = [];
  let gp = 0;
  let fp = 0;
  let stackOffset = 0;
  let stackArgsMayContainPointers = false;
  let aggregatePartial = false;

  if (!params) {
    for (let i = 0; i < 8; i++) {
      srcs.push({ t:'reg', reg:`x${i}`, bits:64, possible:true, mustUse:false, exact:false, certainty:'unknown', abiClass:'unknown-gp' });
      arguments_.push({ index:i, location:'register', reg:`x${i}`, bits:64, abiClass:'unknown-gp', possible:true, mustUse:false, exact:false, certainty:'unknown', mayContainPointers:true });
    }
    for (let i = 0; i < 8; i++) {
      srcs.push({ t:'reg', reg:`v${i}`, bits:128, possible:true, mustUse:false, exact:false, certainty:'unknown', abiClass:'unknown-fp-vector' });
      arguments_.push({ index:8 + i, location:'register', reg:`v${i}`, bits:128, abiClass:'unknown-fp-vector', possible:true, mustUse:false, exact:false, certainty:'unknown' });
    }
    return {
      srcs,
      arguments:arguments_,
      stackArguments,
      stackArgsUnknown:true,
      stackArgsMayContainPointers:true,
      possibleRegisterInputs:srcs.slice(),
      partial:true,
      evidence:'conservative-darwin-arm64',
    };
  }

  for (let index = 0; index < params.length; index++) {
    const param = params[index];
    const c = parameterClass(param);
    const variadicProto = proto?.variadic === true || proto?.varargs === true;
    const fixedCount = Number.isSafeInteger(proto?.fixedParameterCount) && proto.fixedParameterCount >= 0
      ? proto.fixedParameterCount : null;
    const anonymousVararg = variadicProto && (
      param?.variadic === true || param?.unnamed === true || param?.named === false
      || (fixedCount != null && index >= fixedCount)
    );
    const forceStack = anonymousVararg === true;
    if (c.appleLongDoubleWidthConflict) {
      aggregatePartial = true;
      arguments_.push({ index, location:'unknown', abiClass:'darwin-long-double-width-conflict',
        bits:c.bits, partial:true, possible:true, mustUse:false, exact:false, certainty:'unknown',
        reason:'darwin-arm64-long-double-width-conflicts-with-apple-binary64' });
      continue;
    }
    if (c.aggregateMetadataInvalid) {
      aggregatePartial = true;
      arguments_.push({ index, location:'unknown', abiClass:'aggregate-metadata-unproven', aggregate:true,
        partial:true, possible:true, mustUse:false, exact:false, certainty:'unknown',
        reason:'aggregate-hfa-hva-metadata-invalid' });
      continue;
    }
    if (c.homogeneous && !c.homogeneousLayoutProven) {
      aggregatePartial = true;
      arguments_.push({
        index, location:'unknown', abiClass:c.hfa ? 'hfa-unproven' : 'hva-unproven',
        aggregate:true, partial:true, possible:true, mustUse:false, exact:false, certainty:'unknown',
        reason:'darwin-arm64-homogeneous-aggregate-layout-not-proven',
      });
      continue;
    }
    if (c.aggregate && !c.aggregateLayoutProven) {
      aggregatePartial = true;
      arguments_.push({
        index, location:'unknown', abiClass:'aggregate-unproven', aggregate:true,
        partial:true, possible:true, mustUse:false, exact:false, certainty:'unknown',
        reason:'darwin-arm64-aggregate-size-layout-not-proven',
      });
      continue;
    }
    if (c.aggregate && aggregateRequiresIndirectCopy(c.aggregateBytes)) {
      const reg = !forceStack && gp < 8 ? `x${gp++}` : null;
      const stackPointerOffset = reg ? null : alignUp(stackOffset, 8);
      const entry = reg
        ? {
          index, location:'register', reg, abiClass:'aggregate-indirect-copy', pointer:true, bits:64, bytes:8,
          pointeeBits:c.bits, aggregate:true, callerCopy:true,
          mayContainPointers:param?.mayContainPointers === true || param?.containsPointers === true,
          possible:false, mustUse:true,
        }
        : {
          index, location:'stack', offset:stackPointerOffset, bytes:8,
          abiClass:'aggregate-indirect-copy', pointer:true, bits:64,
          pointeeBits:c.bits, aggregate:true, callerCopy:true,
          mayContainPointers:param?.mayContainPointers === true || param?.containsPointers === true,
          possible:false, mustUse:true,
          ...(forceStack ? { variadicAnonymous:true } : {}),
        };
      if (reg) srcs.push(registerSource(reg, 64));
      else { stackArguments.push(entry); stackOffset = stackPointerOffset + 8; }
      arguments_.push(entry);
      stackArgsMayContainPointers = true;
      continue;
    }
    if (c.aggregate && !c.aggregateAlignmentProven) {
      aggregatePartial = true;
      arguments_.push({
        index, location:'unknown', abiClass:'aggregate-alignment-unproven', aggregate:true,
        partial:true, possible:true, mustUse:false, exact:false, certainty:'unknown',
        reason:'darwin-arm64-aggregate-alignment-not-proven',
      });
      continue;
    }
    if ((c.fp || c.hva) && !forceStack) {
      const regsNeeded = c.homogeneous ? c.members : 1;
      if (fp + regsNeeded <= 8) {
        const regs = [];
        for (let n = 0; n < regsNeeded; n++) {
          const reg = `v${fp++}`;
          regs.push(reg);
          srcs.push(registerSource(reg, c.homogeneous ? c.elementBits : c.vector ? Math.min(128, c.bits) : c.bits));
        }
        arguments_.push({
          index,
          location:'register',
          regs,
          reg:regs[0],
          abiClass:c.hfa ? 'hfa' : c.hva ? 'hva' : c.vector ? 'vector' : 'fp',
          pointer:c.pointer,
          bits:c.bits,
          bytes:c.bytes,
          ...(c.homogeneous ? {
            aggregate:true, members:c.members, memberCount:c.members, elementBits:c.elementBits,
            elementBytes:c.elementBytes, homogeneousLayoutProven:true,
            pieces:regs.map((reg,piece) => ({
              pieceIndex:piece, order:piece, reg, abiClass:c.hfa ? 'hfa' : 'hva',
              bits:c.elementBits, bytes:c.elementBytes, byteOffset:piece * c.elementBytes,
            })),
          } : regsNeeded > 1 ? {
            pieces:regs.map((reg,piece) => ({
              pieceIndex:piece, order:piece, reg, abiClass:'wide-integer',
              bits:Math.min(64, Math.max(1, c.bits - piece * 64)), bytes:8, byteOffset:piece * 8,
            })),
          } : {}),
          possible:false,
          mustUse:true,
        });
        continue;
      }
      /* AAPCS64 Stage C: an HFA/HVA that cannot fit the remaining SIMD/FP
       * registers sets NSRN to 8 before the stack allocation. Without this
       * cursor exhaustion a later scalar FP argument could re-enter the
       * v-register path with registers the spilled aggregate never used. */
      if (c.homogeneous) fp = 8;
    } else {
      const regsNeeded = Math.max(1, Math.ceil(c.bits / 64));
      // A padded aggregate needs a physical lane proof that differs from its
      // logical bit width.  Do not publish an invented register split until a
      // dedicated register-padding representation exists; the stack path
      // below carries the complete canonical extent exactly.
      if (c.aggregate && c.aggregateBytes > Math.ceil(c.bits / 8)
        && gp + regsNeeded <= 8) {
        aggregatePartial = true;
        arguments_.push({ index, location:'unknown', abiClass:'aggregate-padding-register-layout-unproven',
          aggregate:true, partial:true, possible:true, mustUse:false, exact:false, certainty:'unknown',
          reason:'aggregate-physical-padding-register-layout-not-represented' });
        continue;
      }
      if (gp + regsNeeded <= 8 && !forceStack) {
        const regs = [];
        for (let n = 0; n < regsNeeded; n++) {
          const reg = `x${gp++}`;
          regs.push(reg);
          srcs.push(registerSource(reg, 64));
        }
        arguments_.push({
          index,
          location:'register',
          regs,
          reg:regs[0],
          abiClass:c.aggregate ? 'aggregate' : c.pointer ? 'pointer' : regsNeeded > 1 ? 'wide-integer' : 'integer',
          pointer:c.pointer,
          bits:c.bits,
          ...(c.aggregate || regsNeeded > 1 ? {
            bytes:regsNeeded * 8,
            pieces:regs.map((reg,piece) => ({
              pieceIndex:piece, order:piece, reg, abiClass:c.aggregate ? 'aggregate' : 'wide-integer',
              bits:Math.min(64, Math.max(1, c.bits - piece * 64)), bytes:8, byteOffset:piece * 8,
            })),
          } : {}),
          ...(c.aggregate ? { aggregate:true, alignmentBytes:c.alignmentBytes } : {}),
          possible:false,
          mustUse:true,
          ...(c.bits < 32 && !c.pointer ? {
            callerExtended:true,
            extension:c.signed ? 'sign-extend-to-32' : 'zero-extend-to-32',
          } : {}),
        });
        continue;
      }
    }

    const stackAlignmentBytes = c.homogeneous
      ? Math.max(c.elementBytes ?? 1, c.explicitAlignmentBytes ?? 0)
      : c.alignmentBytes;
    stackOffset = alignUp(stackOffset, stackAlignmentBytes);
    /* Apple ARM64 stack arguments consume compact slots of their natural
     * layout, not 8-byte-padded registers ("Function arguments may consume
     * slots on the stack that are not multiples of 8 bytes"). An HFA/HVA that
     * spills keeps its canonical member packing (float[4] = 16 bytes at
     * offsets 0/4/8/12) and the next argument starts right after it, so the
     * per-member slot width is the element's own size, never a widened 8. */
    const homogeneousStackElementBytes = c.homogeneous ? (c.elementBytes ?? 0) : null;
    const stackBytes = c.homogeneous ? Math.max(c.bytes ?? 0, homogeneousStackElementBytes * c.members)
      : c.aggregate ? Math.max(8, Math.ceil((c.aggregateBytes ?? c.bytes) / 8) * 8)
        : c.bits > 64 ? Math.max(8, Math.ceil(c.bits / 64) * 8) : c.bytes;
    const entry = {
      index,
      location:'stack',
      offset:stackOffset,
      bytes:stackBytes,
      alignmentBytes:stackAlignmentBytes,
      abiClass:c.aggregate ? 'aggregate' : c.hfa ? 'hfa' : c.hva ? 'hva' : c.vector ? 'vector' : c.fp ? 'fp' : c.pointer ? 'pointer' : 'integer',
      pointer:c.pointer,
      bits:c.bits,
      ...(c.aggregate ? { aggregate:true } : {}),
      ...(c.homogeneous ? {
        aggregate:true, members:c.members, memberCount:c.members, elementBits:c.elementBits,
        elementBytes:c.elementBytes, stackElementBytes:homogeneousStackElementBytes, homogeneousLayoutProven:true,
        pieces:Array.from({ length:c.members }, (_unused,piece) => ({
          pieceIndex:piece, order:piece, stackOffset:stackOffset + piece * homogeneousStackElementBytes,
          bits:c.elementBits, bytes:homogeneousStackElementBytes,
          byteOffset:piece * homogeneousStackElementBytes, abiClass:c.hfa ? 'hfa' : 'hva',
        })),
      } : c.aggregate || c.bits > 64 ? {
        pieces:c.aggregate ? [{
          pieceIndex:0, order:0, stackOffset, bits:c.bits, bytes:stackBytes, byteOffset:0,
          abiClass:'aggregate',
        }] : Array.from({ length:Math.max(1, Math.ceil(c.bits / 64)) }, (_unused,piece) => ({
          pieceIndex:piece, order:piece, stackOffset:stackOffset + piece * 8,
          bits:Math.min(64, Math.max(1, c.bits - piece * 64)), bytes:8, byteOffset:piece * 8,
          abiClass:c.hfa ? 'hfa' : c.hva ? 'hva' : c.vector ? 'vector' : 'wide-integer',
        })),
      } : {}),
      possible:false,
      mustUse:true,
      compactDarwinSlot:true,
      ...(forceStack ? { variadicAnonymous:true } : {}),
    };
    stackArguments.push(entry);
    arguments_.push(entry);
    stackOffset += stackBytes;
    if (c.pointer || param?.mayContainPointers === true || param?.containsPointers === true) stackArgsMayContainPointers = true;
  }

  const variadic = proto?.variadic === true || proto?.varargs === true;
  return {
    srcs,
    arguments:arguments_,
    stackArguments,
    stackArgsUnknown:variadic,
    stackArgsMayContainPointers:stackArgsMayContainPointers || variadic,
    possibleRegisterInputs:[],
    variadicTail:variadic ? {
      location:'stack',
      possible:true,
      mustUse:false,
      exact:false,
      certainty:'unknown',
      slotAlignmentBytes:8,
      mayContainPointers:true,
      reason:'darwin-arm64-variadic-stage-c-stack-only',
    } : null,
    partial:variadic || aggregatePartial,
    evidence:variadic ? 'prototype-darwin-arm64-variadic' : 'prototype-darwin-arm64',
  };
}

const DARWIN_CALLER_SAVED = Object.freeze(AAPCS64_ABI.callerSaved().filter((reg) => reg !== 'x18'));
const DARWIN_CALLEE_SAVED = Object.freeze(AAPCS64_ABI.calleeSaved().filter((reg) => reg !== 'x18'));

function normalizeAppleReturnType(proto, opts = {}) {
  const source = opts?.returnType || proto?.returnType || proto?.ret || proto?.result || '';
  const sourceClass = opts?.returnClass || proto?.returnClass || proto?.abiClass || proto?.resultClass || '';
  if (!isAppleLongDoubleScalar(source, sourceClass)) return proto;
  const normalized = { ...proto };
  delete normalized.ret;
  delete normalized.result;
  normalized.returnType = 'double';
  if (Object.hasOwn(normalized, 'returnClass') || Object.hasOwn(normalized, 'abiClass') || Object.hasOwn(normalized, 'resultClass')) normalized.returnClass = 'fp';
  return normalized;
}

function appleLongDoubleReturnConflict(proto, opts = {}) {
  const source = String(opts?.returnType || proto?.returnType || proto?.ret || proto?.result || '');
  const sourceClass = String(opts?.returnClass || proto?.returnClass || proto?.abiClass || proto?.resultClass || '');
  if (!isAppleLongDoubleScalar(source, sourceClass)) return null;
  if (opts?.returnsValue === false || proto?.returnsValue === false || proto?.void === true) return null;
  const raw = opts?.returnBits ?? proto?.returnBits ?? proto?.bits;
  const bits = Number(raw);
  if (!Number.isSafeInteger(bits) || bits <= 0 || bits === 64) return null;
  return { reg:null, regs:[], bits, bytes:null, partial:true, unsupported:true, possible:true, mustUse:false, exact:false, certainty:'unknown',
    reason:'darwin-arm64-long-double-width-conflicts-with-apple-binary64' };
}

function classifyDarwinArm64CallReturn(insn, opts = {}) {
  const proto = callPrototypeOf(insn, opts);
  const conflict = appleLongDoubleReturnConflict(proto, opts);
  if (conflict) return conflict;
  const normalized = normalizeAppleReturnType(proto, opts);
  if (!proto || normalized === proto) return classifyAAPCS64CallReturn(insn, opts);
  return classifyAAPCS64CallReturn({ ...(insn || {}), callPrototype:normalized }, opts);
}

function classifyDarwinArm64FunctionReturn(opts = {}) {
  const proto = opts?.functionPrototype || opts?.prototype || null;
  const conflict = appleLongDoubleReturnConflict(proto, opts);
  if (conflict) return conflict;
  return classifyAAPCS64FunctionReturn({ ...opts, functionPrototype:normalizeAppleReturnType(proto, opts) });
}

export const DARWIN_ARM64_ABI = new ABIPlugin({
  id:'darwin-arm64',
  semanticVersion:'1',
  semanticIdentity:'darwin-arm64@1',
  architectureId:'arm64',
  platformPredicate:({ platform }) => DARWIN_PLATFORMS.has(String(platform || '').toLowerCase()),
  callingConventions:()=>Object.freeze(['darwin-arm64','apple-arm64','aapcs64']),
  classifyArguments:classifyDarwinArm64Arguments,
  classifyCallReturn:classifyDarwinArm64CallReturn,
  classifyFunctionReturn:classifyDarwinArm64FunctionReturn,
  // v0-v7 and their b/h/s/d/q views are the FP/SIMD argument bank.
  classifyEntryRegister:(reg) => {
    const text = String(reg || '').trim().toLowerCase();
    const integerArgument = /^x([0-7])$/.exec(text);
    if (integerArgument) return { kind:'argument', reg:text, index:Number(integerArgument[1]), abiClass:'integer' };
    const vectorArgument = /^v([0-7])$/.exec(text);
    if (vectorArgument) return {
      kind:'argument', reg:`v${Number(vectorArgument[1])}`, index:8 + Number(vectorArgument[1]),
      view:'vector', abiClass:'fp-vector',
    };
    const viewArgument = /^(?:[qbdsh])([0-7])$/.exec(text);
    if (viewArgument) return {
      kind:'argument', reg:`v${Number(viewArgument[1])}`, index:8 + Number(viewArgument[1]),
      view:text.slice(0, 1), abiClass:'fp-vector',
    };
    return { kind:'incoming-register-state', reg:text };
  },
  callerSaved:()=>DARWIN_CALLER_SAVED,
  calleeSaved:()=>DARWIN_CALLEE_SAVED,
  stackRules:()=>Object.freeze({
    alignment:16,
    stackGrows:'down',
    compactArgumentSlots:true,
    argumentSlotBytes:null,
    variadicAnonymousArguments:'stack-only',
    variadicStackSlotAlignment:8,
    reservedRegisters:Object.freeze(['x18']),
    narrowIntegerArguments:'caller-extends-to-32',
    vaListKind:'char-pointer',
    redZoneBytes:128,
  }),
  redZone:()=>128,
  unwindRules:()=>Object.freeze({ framePointer:'x29', linkRegister:'x30', redZoneBytes:128 }),
  defaultUnknownCallEffects:()=>Object.freeze({
    registerClobbers:DARWIN_CALLER_SAVED,
    memoryEffects:'unknown',
    mayThrow:true,
    stackArguments:'unknown',
    stackArgsMayContainPointers:true,
    reservedRegisters:Object.freeze(['x18']),
  }),
});
