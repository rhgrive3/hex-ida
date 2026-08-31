import { ABIPlugin } from './registry.js';
import { aggregateLayoutDescriptorPresent, canonicalAggregateLayout } from './aggregate-layout.js';

function callPrototypeOf(insn, opts) {
  let proto = insn?.callPrototype || null;
  if (!proto) {
    try { proto = opts?.callPrototypeFor?.(insn?.callTarget ?? null, insn) || null; } catch { proto = null; }
  }
  return proto;
}

function callParameterList(proto) {
  const list = proto && (proto.args || proto.parameters || proto.params || proto.arguments);
  return Array.isArray(list) ? list : null;
}

function scalableAAPCS64Class(type, cls) {
  const text = `${type} ${cls}`;
  const predicate = /\bsvbool_t\b|\bpredicate\b|\bsve[-_ ]?predicate\b/.test(text);
  const scalable = predicate || /\bscalable[-_ ]?(?:vector|type)\b|\bsve\b|\bsv(?:u?int|float|bfloat)[0-9_]*_t\b/.test(text);
  if (!scalable) return null;
  return predicate ? 'sve-predicate' : 'sve-scalable-vector';
}

function nestedRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function aggregateBoolean(parameter, key) {
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

function parameterAbiClass(param) {
  const type = String(param?.type || param?.name || '').toLowerCase();
  const cls = String(param?.abiClass || param?.class || param?.kind || '').toLowerCase();
  const scalableClass = scalableAAPCS64Class(type, cls);
  const pointer = param?.pointer === true || param?.isPointer === true || /\*|pointer|ptr|object|class|block|closure/.test(type + ' ' + cls);
  const hfaMeta = aggregateBoolean(param, 'hfa');
  const hvaMeta = aggregateBoolean(param, 'hva');
  const aggregateMetadataInvalid = (hfaMeta.present && hfaMeta.value === null)
    || (hvaMeta.present && hvaMeta.value === null);
  const hfa = hfaMeta.value === true || cls.includes('hfa') || cls.includes('homogeneous');
  const hva = hvaMeta.value === true || cls.includes('hva');
  const homogeneous = hfa || hva;
  const aggregateDescriptorPresent = aggregateLayoutDescriptorPresent(param);
  const vector = !scalableClass && (cls.includes('vector') || /vector|simd/.test(type));
  const aggregate = !scalableClass && !pointer && !homogeneous && (param?.aggregate === true || param?.isAggregate === true
    || aggregateDescriptorPresent || /aggregate|struct|union|record|array|composite/.test(type + ' ' + cls));
  const fp = !scalableClass && !aggregate && (homogeneous || vector || cls.includes('float') || cls.includes('fp') || /^(float|double|__fp16)/.test(type));
  // `layout` is the canonical aggregate descriptor when present.  Classifier
  // fields are only aliases; consuming a top-level width/member list here
  // would create a second truth and can turn a nested exact layout into bits=0
  // or an invented one-lane placement.
  const layoutEvidence = homogeneous || aggregate ? canonicalAggregateLayout(param) : null;
  const canonicalMembers = layoutEvidence?.members ?? null;
  const rawMembers = param?.members ?? param?.elements ?? canonicalMembers ?? param?.count;
  const memberArray = Array.isArray(rawMembers) ? rawMembers : null;
  const declaredMembers = memberArray ? memberArray.length : Number(rawMembers);
  const members = homogeneous && Number.isSafeInteger(declaredMembers) && declaredMembers >= 1 && declaredMembers <= 4
    ? declaredMembers : homogeneous ? 0 : 1;
  const explicitBits = Number(layoutEvidence?.bits ?? param?.bits ?? param?.sizeBits);
  const firstMemberBits = memberArray?.length ? Number(memberArray[0]?.bits ?? memberArray[0]?.sizeBits) : null;
  const explicitElementBits = Number(canonicalMembers?.[0]?.bits
    ?? param?.elementBits ?? param?.memberBits ?? firstMemberBits);
  const explicitTotalBitsProven = Number.isSafeInteger(explicitBits) && explicitBits > 0;
  const elementBits = homogeneous
    ? Number.isSafeInteger(explicitElementBits) && explicitElementBits > 0 ? explicitElementBits
      : 0
    : null;
  const homogeneousMembersMatch = !homogeneous || !!layoutEvidence
    && layoutEvidence.members.length === members
    && layoutEvidence.members.every((member) => member.bits === elementBits);
  const homogeneousElementBytes = homogeneous && layoutEvidence?.members?.length
    ? layoutEvidence.members[0].bytes : null;
  const homogeneousBytesMatch = !homogeneous || !!homogeneousElementBytes
    && layoutEvidence.members.every((member) => member.bytes === homogeneousElementBytes);
  const homogeneousOffsetsMatch = !homogeneous || !!homogeneousElementBytes
    && layoutEvidence.members.every((member, index) => member.byteOffset === index * homogeneousElementBytes);
  const homogeneousSizeMatches = !homogeneous || !explicitTotalBitsProven
    || (members >= 1 && elementBits > 0 && explicitBits === members * elementBits);
  const homogeneousLayoutProven = !homogeneous && !aggregateMetadataInvalid
    || (!!layoutEvidence && members >= 1 && members <= 4 && elementBits >= 8
      && Number.isSafeInteger(elementBits) && Number.isSafeInteger(homogeneousElementBytes)
      && homogeneousSizeMatches && homogeneousMembersMatch && homogeneousBytesMatch
      && homogeneousOffsetsMatch && hfaMeta.value !== null && hvaMeta.value !== null
      && !(hfaMeta.value === true && hvaMeta.value === true));
  // A plain aggregate has no ABI placement until its logical size is proven.
  // Do not let the scalar fallback below turn an un-sized struct/union into a
  // one-register exact argument.
  const aggregateLayoutProven = !aggregateMetadataInvalid && (!aggregate || !!layoutEvidence);
  const int128 = !pointer && !aggregate && !fp && /(?:unsigned\s+)?__int128|int128_t|uint128_t/.test(type + ' ' + cls);
  const rawBits = homogeneous
    ? homogeneousLayoutProven ? elementBits * members : explicitTotalBitsProven ? explicitBits : 0
    : aggregate
      ? aggregateLayoutProven ? explicitBits : 0
      : Number.isFinite(explicitBits) && explicitBits > 0 ? explicitBits : int128 ? 128 : 64;
  const bits = rawBits > 0 ? Math.max(8, Math.min(1 << 20, Math.floor(rawBits))) : 0;
  const wideIntegral = !pointer && !aggregate && !fp && bits === 128;
  const declaredAlignment = Number(param?.alignment ?? param?.align ?? param?.alignmentBytes);
  const alignment = Number.isFinite(declaredAlignment) && declaredAlignment > 0
    ? Math.min(16, Math.max(1, Math.floor(declaredAlignment)))
    : wideIntegral ? 16 : 8;
  const mayContainPointers = param?.mayContainPointers === true || param?.containsPointers === true;
  return {
    pointer, hfa, hva, homogeneous, homogeneousLayoutProven, aggregateLayoutProven, vector, aggregate, fp,
    members, elementBits, elementBytes:homogeneousElementBytes, bits, wideIntegral, alignment,
    aggregateLayout:layoutEvidence,
    aggregateBytes:aggregate ? layoutEvidence?.bytes ?? (bits > 0 ? Math.ceil(bits / 8) : null) : null,
    aggregateMetadataInvalid,
    mayContainPointers, scalableClass,
  };
}

function possibleRegisterSource(reg, bits, abiClass) {
  return { t:'reg', reg, bits, possible:true, mustUse:false, exact:false,
    certainty:'unknown', purpose:'variadic-tail-candidate', abiClass };
}

export function classifyAAPCS64Arguments(insn, opts = {}) {
  const proto = callPrototypeOf(insn, opts);
  const params = callParameterList(proto);
  const srcs = [];
  const arguments_ = [];
  const stackArguments = [];
  const unsupported = [];
  let gp = 0, fp = 0, stackOffset = 0;
  let stackArgsMayContainPointers = false;
  if (!params) {
    for (let i=0;i<8;i++) {
      srcs.push({t:'reg',reg:`x${i}`,bits:64,possible:true,mustUse:false,exact:false,certainty:'unknown',abiClass:'unknown-gp'});
      arguments_.push({index:i,location:'register',reg:`x${i}`,abiClass:'unknown-gp',possible:true,mustUse:false,exact:false,certainty:'unknown',mayContainPointers:true});
    }
    for (let i=0;i<8;i++) {
      srcs.push({t:'reg',reg:`v${i}`,bits:128,possible:true,mustUse:false,exact:false,certainty:'unknown',abiClass:'unknown-fp-vector'});
      arguments_.push({index:8+i,location:'register',reg:`v${i}`,abiClass:'unknown-fp-vector',possible:true,mustUse:false,exact:false,certainty:'unknown'});
    }
    return {
      srcs,
      arguments:arguments_,
      stackArguments,
      stackArgsUnknown:true,
      stackArgsMayContainPointers:true,
      possibleRegisterInputs:srcs.slice(),
      partial:true,
      evidence:'conservative-aapcs64',
    };
  }
  params.forEach((param,index) => {
    const c=parameterAbiClass(param);
    if (c.scalableClass) {
      const entry={index,location:'unsupported',abiClass:c.scalableClass,pointer:false,scalable:true,evidence:'unsupported-aapcs64-sve'};
      arguments_.push(entry);unsupported.push(entry);return;
    }
    if (c.aggregateMetadataInvalid) {
      const entry={index,location:'unknown',abiClass:'aggregate-metadata-unproven',aggregate:true,
        partial:true,possible:true,mustUse:false,exact:false,certainty:'unknown',
        reason:'aggregate-hfa-hva-metadata-invalid'};
      arguments_.push(entry);unsupported.push(entry);return;
    }
    if (c.homogeneous && !c.homogeneousLayoutProven) {
      const entry={
        index, location:'unknown', abiClass:c.hfa ? 'hfa-unproven' : 'hva-unproven',
        aggregate:true, partial:true, possible:true, mustUse:false, exact:false, certainty:'unknown',
        reason:'homogeneous-aggregate-member-layout-not-proven',
      };
      arguments_.push(entry); unsupported.push(entry); return;
    }
    if (c.aggregate && !c.aggregateLayoutProven) {
      const entry={
        index, location:'unknown', abiClass:'aggregate-unproven', aggregate:true,
        partial:true, possible:true, mustUse:false, exact:false, certainty:'unknown',
        reason:'aggregate-size-layout-not-proven',
      };
      arguments_.push(entry); unsupported.push(entry); return;
    }
    const regsNeeded=c.homogeneous ? c.members : 1;
    if (c.fp && fp + regsNeeded <= 8) {
      const regs=[];
      for(let n=0;n<regsNeeded;n++){
        const reg=`v${fp++}`;
        regs.push(reg);
        srcs.push({t:'reg',reg,bits:c.homogeneous ? c.elementBits : c.vector ? 128 : c.bits,possible:false,mustUse:true});
      }
      const homogeneousBytes = c.homogeneous ? c.elementBytes : null;
      arguments_.push({
        index,location:'register',regs,reg:regs[0],abiClass:c.hfa?'hfa':c.hva?'hva':c.vector?'vector':'fp',
        pointer:c.pointer,bits:c.bits,bytes:c.homogeneous ? homogeneousBytes * c.members : Math.ceil(c.bits / 8),
        ...(c.homogeneous ? {
          aggregate:true, members:c.members, memberCount:c.members, elementBits:c.elementBits,
          elementBytes:homogeneousBytes, homogeneousLayoutProven:true,
          pieces:regs.map((reg,piece) => ({
            pieceIndex:piece, order:piece, reg, abiClass:c.hfa ? 'hfa' : 'hva',
            bits:c.elementBits, bytes:homogeneousBytes, byteOffset:piece * homogeneousBytes,
          })),
        } : {}),
        possible:false,mustUse:true,
      });
      return;
    }

    if (c.aggregate && c.bits > 128) {
      const reg = gp < 8 ? `x${gp++}` : null;
      const entry = reg
        ? {index,location:'register',reg,abiClass:'aggregate-indirect-copy',pointer:true,bits:64,bytes:8,
          pointeeBits:c.bits,aggregate:true,callerCopy:true,mayContainPointers:c.mayContainPointers,
          pieces:[{pieceIndex:0,order:0,reg,bits:64,bytes:8,byteOffset:0,abiClass:'aggregate-indirect-copy'}],
          possible:false,mustUse:true}
        : {index,location:'stack',offset:stackOffset,bytes:8,abiClass:'aggregate-indirect-copy',pointer:true,bits:64,
          pointeeBits:c.bits,aggregate:true,callerCopy:true,mayContainPointers:c.mayContainPointers,
          pieces:[{pieceIndex:0,order:0,stackOffset,bits:64,bytes:8,byteOffset:0,abiClass:'aggregate-indirect-copy'}],
          possible:false,mustUse:true};
      if (reg) srcs.push({t:'reg',reg,bits:64,purpose:'aggregate-indirect-copy',possible:false,mustUse:true});
      else { stackArguments.push(entry); stackOffset += 8; }
      arguments_.push(entry);
      stackArgsMayContainPointers = true;
      return;
    }

    if (c.wideIntegral) {
      if ((gp & 1) !== 0) gp += 1;
      if (gp <= 6) {
        const regs=[`x${gp}`,`x${gp+1}`]; gp += 2;
        for (const reg of regs) srcs.push({t:'reg',reg,bits:64,purpose:'wide-integral-piece',possible:false,mustUse:true});
        arguments_.push({index,location:'registers',regs,reg:regs[0],abiClass:'wide-integer',pointer:false,bits:128,bytes:16,alignment:16,pieces:regs.map((reg,piece)=>({pieceIndex:piece,order:piece,reg,bits:64,bytes:8,byteOffset:piece*8,abiClass:'wide-integer'})),possible:false,mustUse:true});
        return;
      }
      gp = 8;
      stackOffset = Math.ceil(stackOffset / 16) * 16;
      const entry={index,location:'stack',offset:stackOffset,bytes:16,abiClass:'wide-integer',pointer:false,bits:128,alignment:16,
        pieces:[{pieceIndex:0,order:0,stackOffset,bits:128,bytes:16,byteOffset:0,abiClass:'wide-integer'}],
        possible:false,mustUse:true};
      stackArguments.push(entry);arguments_.push(entry);stackOffset+=16;
      return;
    }

    if (c.aggregate) {
      // Stack placement follows the canonical physical object extent, not
      // merely ceil(logicalBits / 64).  Trailing padding is part of the ABI
      // slot and must advance the next argument's offset.
      const bytes=Math.max(8,Math.ceil((c.aggregateBytes ?? Math.ceil(c.bits / 8)) / 8) * 8);
      if (c.alignment >= 16 && (gp & 1) !== 0) gp += 1;
      const needed=Math.ceil(bytes/8);
      // A register split cannot represent a trailing padding-only lane in the
      // current canonical piece schema.  Preserve the exact stack path when
      // no GP register remains, but fail closed rather than publishing bits
      // copied into a padding lane when a register path would be selected.
      if (c.aggregateBytes > Math.ceil(c.bits / 8) && gp < 8) {
        const entry={ index, location:'unknown', abiClass:'aggregate-padding-register-layout-unproven',
          aggregate:true, partial:true, possible:true, mustUse:false, exact:false, certainty:'unknown',
          reason:'aggregate-physical-padding-register-layout-not-represented' };
        arguments_.push(entry);
        unsupported.push(entry);
        return;
      }
      if (gp + needed <= 8) {
        const regs=[];
        for(let n=0;n<needed;n++){
          const reg=`x${gp++}`;
          regs.push(reg);
          srcs.push({t:'reg',reg,bits:64,purpose:'aggregate-piece',possible:false,mustUse:true});
        }
        arguments_.push({index,location:'registers',regs,reg:regs[0],aggregate:true,abiClass:'aggregate',pointer:false,bits:c.bits,bytes,alignment:c.alignment,mayContainPointers:c.mayContainPointers,pieces:regs.map((reg,piece)=>{
          const pieceBits=Math.min(64, Math.max(1,c.bits-piece*64));
          return {pieceIndex:piece,order:piece,reg,bits:pieceBits,bytes:8,byteOffset:piece*8,abiClass:'aggregate'};
        }),possible:false,mustUse:true});
        return;
      }
      const registerPieces = stackOffset === 0 ? Math.max(0, 8 - gp) : 0;
      if (registerPieces > 0) {
        const regs=[];
        const pieces=[];
        for(let n=0;n<registerPieces;n++){
          const reg=`x${gp++}`;
          regs.push(reg);
          srcs.push({t:'reg',reg,bits:64,purpose:'aggregate-piece',possible:false,mustUse:true});
          pieces.push({pieceIndex:n,order:n,reg,bits:64,bytes:8,byteOffset:n*8,abiClass:'aggregate'});
        }
        gp=8;
        const stackBytes=bytes-registerPieces*8;
        stackOffset = c.alignment >= 16 ? Math.ceil(stackOffset / 16) * 16 : stackOffset;
        const stackPieceBits = Math.max(1, c.bits - registerPieces * 64);
        const stackEntry={index,location:'stack-fragment',offset:stackOffset,bytes:stackBytes,abiClass:'aggregate',aggregate:true,pointer:false,bits:stackPieceBits,alignment:8,mayContainPointers:c.mayContainPointers,pieceOffsetBytes:registerPieces*8,
          pieces:[{pieceIndex:registerPieces,order:registerPieces,stackOffset,bytes:stackBytes,bits:stackPieceBits,byteOffset:registerPieces*8,abiClass:'aggregate'}],
          possible:false,mustUse:true};
        stackArguments.push(stackEntry);
        arguments_.push({index,location:'register-stack',regs,reg:regs[0],offset:stackOffset,stackBytes,bytes,abiClass:'aggregate',aggregate:true,pointer:false,bits:c.bits,alignment:c.alignment,mayContainPointers:c.mayContainPointers,pieces:[...pieces,{pieceIndex:registerPieces,order:registerPieces,stackOffset,bytes:stackBytes,bits:stackPieceBits,byteOffset:registerPieces*8,abiClass:'aggregate'}],possible:false,mustUse:true});
        stackOffset+=stackBytes;
        if(c.mayContainPointers) stackArgsMayContainPointers=true;
        return;
      }
      gp = 8;
      stackOffset = c.alignment >= 16 ? Math.ceil(stackOffset / 16) * 16 : stackOffset;
      const entry={index,location:'stack',offset:stackOffset,bytes,aggregate:true,abiClass:'aggregate',pointer:false,bits:c.bits,alignment:c.alignment,mayContainPointers:c.mayContainPointers,pieces:[{pieceIndex:0,order:0,stackOffset:stackOffset,bits:c.bits,bytes,byteOffset:0,abiClass:'aggregate'}],possible:false,mustUse:true};
      stackArguments.push(entry);arguments_.push(entry);stackOffset+=bytes;
      if(c.mayContainPointers) stackArgsMayContainPointers=true;
      return;
    }

    if (!c.fp && gp < 8) {
      const reg=`x${gp++}`;
      srcs.push({t:'reg',reg,bits:64,possible:false,mustUse:true});
      arguments_.push({index,location:'register',reg,abiClass:c.pointer?'pointer':'integer',pointer:c.pointer,bits:c.bits,possible:false,mustUse:true});
      return;
    }
    const slots=Math.max(1,Math.ceil(c.bits/64));
    if (c.homogeneous && fp + regsNeeded > 8) fp = 8;
    const homogeneousElementBytes = c.homogeneous ? c.elementBytes : null;
    // AAPCS64 spills each homogeneous element into its own ABI stack slot.
    // The slot is at least one 8-byte slot even when the logical element is a
    // 32-bit HFA member; wider HVA members retain their canonical physical
    // element span and alignment. Derive all offsets from this one layout.
    const homogeneousStackElementBytes = c.homogeneous ? Math.max(8, homogeneousElementBytes) : null;
    const stackBytes=c.homogeneous ? homogeneousStackElementBytes * c.members : slots * 8;
    const entry={index,location:'stack',offset:stackOffset,bytes:stackBytes,abiClass:c.hfa?'hfa':c.hva?'hva':c.vector?'vector':c.fp?'fp':c.pointer?'pointer':'integer',pointer:c.pointer,bits:c.bits,possible:false,mustUse:true,
      ...(c.homogeneous ? {
        aggregate:true, members:c.members, memberCount:c.members, elementBits:c.elementBits,
        elementBytes:homogeneousElementBytes, stackElementBytes:homogeneousStackElementBytes,
        homogeneousLayoutProven:true,
        pieces:Array.from({length:c.members}, (_unused,piece) => ({
          pieceIndex:piece, order:piece,
          stackOffset:stackOffset + piece * homogeneousStackElementBytes,
          bits:c.elementBits, bytes:homogeneousStackElementBytes,
          byteOffset:piece * homogeneousStackElementBytes, abiClass:c.hfa?'hfa':'hva',
        })),
      } : {}),
    };
    stackArguments.push(entry);arguments_.push(entry);stackOffset+=stackBytes;
    if(c.pointer || c.mayContainPointers) stackArgsMayContainPointers=true;
  });

  const variadic=proto?.variadic===true||proto?.varargs===true;
  const possibleRegisterInputs=[];
  if (variadic) {
    for (let i=gp;i<8;i++) {
      const source=possibleRegisterSource(`x${i}`,64,'variadic-unknown-gp');
      srcs.push(source);
      possibleRegisterInputs.push(source);
      arguments_.push({index:null,location:'register',reg:`x${i}`,bits:64,abiClass:'variadic-unknown-gp',possible:true,mustUse:false,exact:false,certainty:'unknown',mayContainPointers:true});
    }
    for (let i=fp;i<8;i++) {
      const source=possibleRegisterSource(`v${i}`,128,'variadic-unknown-fp-vector');
      srcs.push(source);
      possibleRegisterInputs.push(source);
      arguments_.push({index:null,location:'register',reg:`v${i}`,bits:128,abiClass:'variadic-unknown-fp-vector',possible:true,mustUse:false,exact:false,certainty:'unknown'});
    }
  }
  return {
    srcs, arguments:arguments_, stackArguments,
    stackArgsUnknown:variadic,
    stackArgsMayContainPointers:stackArgsMayContainPointers||variadic,
    possibleRegisterInputs,
    partial:variadic||unsupported.length>0,
    evidence:unsupported.length?'partial-aapcs64-unsupported-sve':variadic?'prototype-aapcs64-variadic':'prototype-aapcs64',
    unsupported:unsupported.length>0,
    unsupportedArguments:unsupported,
  };
}

function scalableReturnClass(proto, type, cls) {
  return scalableAAPCS64Class(type, cls) || scalableAAPCS64Class(type, String(proto?.returnKind || proto?.resultKind || '').toLowerCase());
}

function returnBitsOf(...values) {
  const raw = values.find((value) => value != null);
  if (raw == null) return 64;
  const bits = Number(raw);
  return Number.isFinite(bits) && Number.isInteger(bits) && bits > 0 ? bits : null;
}

function explicitReturnBitsOf(...values) {
  const raw = values.find((value) => value != null);
  if (raw == null) return null;
  const bits = Number(raw);
  return Number.isSafeInteger(bits) && bits > 0 ? bits : null;
}

function homogeneousReturnInfo(proto, cls, returnBits, layoutEvidence = null) {
  const returnAggregate = nestedRecord(proto?.returnAggregate) ? proto.returnAggregate : null;
  const hfaMeta = aggregateBoolean(proto, 'hfa');
  const hvaMeta = aggregateBoolean(proto, 'hva');
  const homogeneous = hfaMeta.value === true || hvaMeta.value === true
    || cls.includes('hfa') || cls.includes('hva') || cls.includes('homogeneous');
  if (!homogeneous) return null;
  const rawMembers = proto?.members ?? proto?.memberCount ?? proto?.elements
    ?? proto?.count ?? proto?.hfaCount ?? proto?.hvaCount
    ?? returnAggregate?.members ?? returnAggregate?.memberCount ?? returnAggregate?.elements
    ?? returnAggregate?.count ?? returnAggregate?.hfaCount ?? returnAggregate?.hvaCount
    ?? layoutEvidence?.members;
  const members = Array.isArray(rawMembers) ? rawMembers.length : Number(rawMembers);
  const rawElementBits = proto?.elementBits ?? proto?.memberBits ?? proto?.returnElementBits
    ?? (Array.isArray(rawMembers) ? rawMembers[0]?.bits ?? rawMembers[0]?.sizeBits : null)
    ?? returnAggregate?.elementBits ?? returnAggregate?.memberBits ?? returnAggregate?.returnElementBits
    ?? layoutEvidence?.members?.[0]?.bits;
  const elementBits = Number(rawElementBits);
  // HFA/HVA is exact only when the member count, member type width, and total
  // layout agree.  In particular, do not turn absent metadata into a
  // one-element homogeneous aggregate.
  if (!Number.isSafeInteger(members) || members < 1 || members > 4
    || !Number.isSafeInteger(elementBits) || elementBits <= 0
    || !Number.isSafeInteger(returnBits) || returnBits !== members * elementBits) {
    return { invalid:true };
  }
  const kind = hvaMeta.value === true || cls.includes('hva') ? 'hva' : 'hfa';
  const elementBytes = layoutEvidence?.members?.[0]?.bytes ?? Math.ceil(elementBits / 8);
  const bytes = layoutEvidence?.bytes ?? elementBytes * members;
  if (layoutEvidence && (layoutEvidence.members.length !== members
    || !Number.isSafeInteger(elementBytes) || elementBytes <= 0
    || layoutEvidence.members.some((member, index) => member.bits !== elementBits
      || member.bytes !== elementBytes || member.byteOffset !== index * elementBytes)
    || bytes !== elementBytes * members
    || hfaMeta.value === null || hvaMeta.value === null
    || (hfaMeta.value === true && hvaMeta.value === true))) return { invalid:true };
  return { kind, members, elementBits, bits:returnBits, bytes, elementBytes };
}

function aggregateReturnLayout(proto, returnBits = null) {
  const normalized = { ...proto };
  if (Number.isSafeInteger(returnBits) && returnBits > 0) normalized.bits = returnBits;
  // canonicalAggregateLayout compares top-level and returnAggregate aliases;
  // spreading the nested object here would erase conflicts before validation.
  return canonicalAggregateLayout(normalized);
}

function aggregateReturnPieces(bits, abiClass = 'aggregate') {
  if (!Number.isSafeInteger(bits) || bits <= 0 || bits > 128) return null;
  const count = Math.ceil(bits / 64);
  return Array.from({ length:count }, (_unused, index) => {
    const pieceBits = Math.min(64, bits - index * 64);
    return {
      pieceIndex:index, order:index, reg:`x${index}`, abiClass,
      /* Each x-register is an eight-byte physical lane; the logical final
       * lane may contain fewer payload bits but still occupies the full slot. */
      bits:pieceBits, bytes:8, byteOffset:index * 8,
    };
  });
}

function homogeneousReturnPieces(info) {
  return Array.from({ length:info.members }, (_unused, index) => ({
    pieceIndex:index, order:index, reg:`v${index}`, abiClass:info.kind,
    bits:info.elementBits, bytes:info.bytes / info.members, byteOffset:index * (info.bytes / info.members),
  }));
}

function indirectReturnResult() {
  return {
    reg:null, regs:[], bits:64, aggregate:true, indirect:true,
    resultLocation:'memory', abiClass:'indirect-result', pointerBits:64,
    hiddenResultPointer:'x8',
  };
}

export function classifyAAPCS64CallReturn(insn, opts = {}) {
  const proto = callPrototypeOf(insn, opts);
  if (!proto) return null;
  const type = String(proto.returnType || proto.ret || proto.result || '').toLowerCase();
  const cls = String(proto.returnClass || proto.abiClass || proto.resultClass || '').toLowerCase();
  if (proto.void === true || type === 'void' || cls === 'void') return null;
  const returnAggregate = proto.returnAggregate && typeof proto.returnAggregate === 'object'
    && !Array.isArray(proto.returnAggregate) ? proto.returnAggregate : null;
  const malformedReturnAggregate = Object.hasOwn(proto, 'returnAggregate')
    && proto.returnAggregate != null && typeof proto.returnAggregate !== 'boolean'
    && !returnAggregate;
  const aggregate=proto.aggregate===true||proto.isAggregate===true||!!returnAggregate
    || aggregateLayoutDescriptorPresent(proto)
    || malformedReturnAggregate
    ||/aggregate|struct|union|record|array|composite/.test(type+' '+cls);
  const explicitReturnBits = explicitReturnBitsOf(proto.returnBits, proto.bits);
  const aggregateLayout = aggregate ? aggregateReturnLayout(proto, explicitReturnBits) : null;
  if (aggregate && !aggregateLayout) {
    return { reg:null, regs:[], bits:explicitReturnBits, bytes:null, aggregate:true, partial:true,
      reason:'aapcs64-aggregate-return-size-layout-unproven' };
  }
  if ((proto.indirectResult === true || cls === 'indirect') && aggregate && explicitReturnBits == null) {
    return { reg:null, regs:[], bits:null, bytes:null, aggregate:true, partial:true,
      reason:'aapcs64-aggregate-return-size-not-proven' };
  }
  if (proto.indirectResult === true || cls === 'indirect') return indirectReturnResult();
  if (scalableReturnClass(proto,type,cls)) return null;
  const returnBits = aggregate
    ? explicitReturnBits ?? aggregateLayout?.bits ?? null
    : returnBitsOf(proto.returnBits, proto.bits);
  if (aggregate && returnBits == null) {
    return { reg:null, regs:[], bits:null, bytes:null, aggregate:true, partial:true,
      reason:'aapcs64-aggregate-return-size-not-proven' };
  }
  // Direct register-return pieces currently describe payload lanes, not a
  // padding-only lane.  Refuse a padded aggregate return rather than
  // collapsing its physical extent to the logical width.
  if (aggregate && aggregateLayout?.bytes > Math.ceil(returnBits / 8)) {
    return { reg:null, regs:[], bits:returnBits, bytes:aggregateLayout.bytes, aggregate:true, partial:true,
      reason:'aapcs64-padded-aggregate-return-layout-not-represented' };
  }
  if (returnBits == null) return null;
  const homogeneous = homogeneousReturnInfo(proto, cls, returnBits, aggregateLayout);
  if (homogeneous?.invalid) return { reg:null, regs:[], bits:returnBits, aggregate:true, partial:true, reason:'aapcs64-homogeneous-return-layout-not-proven' };
  if (homogeneous) {
    const pieces = homogeneousReturnPieces(homogeneous);
    return {
      reg:pieces[0].reg, regs:pieces.map((piece) => piece.reg), pieces,
      bits:returnBits, bytes:homogeneous.bytes, aggregate:true,
      abiClass:homogeneous.kind, members:homogeneous.members,
      elementBits:homogeneous.elementBits, homogeneousLayoutProven:true,
    };
  }
  if (cls.includes('fp') || cls.includes('float') || cls.includes('vector') || /^(float|double|__fp16)/.test(type)) {
    return { reg:'v0', bits:returnBits };
  }
  const wideInteger=!aggregate&&(/(?:unsigned\s+)?__int128|int128_t|uint128_t/.test(type+' '+cls)||returnBits===128);
  if (aggregate && returnBits>128) return indirectReturnResult();
  if ((aggregate && returnBits>64) || wideInteger) {
    const pieces = aggregateReturnPieces(returnBits);
    if (!pieces) return { reg:null, partial:true, aggregate:true, reason:'aapcs64-aggregate-return-width-not-proven' };
    return { reg:'x0',regs:pieces.map((piece) => piece.reg),bits:returnBits,bytes:pieces.length * 8,aggregate,wideInteger,pieces };
  }
  if (aggregate) {
    const pieces = aggregateReturnPieces(returnBits);
    return { reg:'x0', regs:['x0'], bits:returnBits, bytes:8, aggregate:true,
      abiClass:'integer-aggregate', pieces:pieces || [] };
  }
  if (type || cls || proto.returnsValue === true) return { reg:'x0', bits:returnBits };
  return null;
}

export function classifyAAPCS64FunctionReturn(opts = {}) {
  const proto = opts?.functionPrototype || opts?.prototype || null;
  const type = String(opts?.returnType || proto?.returnType || proto?.ret || proto?.result || '').toLowerCase();
  const cls = String(opts?.returnClass || proto?.returnClass || proto?.abiClass || proto?.resultClass || '').toLowerCase();
  if (opts?.returnsValue === false || proto?.returnsValue === false || proto?.void === true || type === 'void' || cls === 'void') return null;
  const returnAggregate = proto?.returnAggregate && typeof proto.returnAggregate === 'object'
    && !Array.isArray(proto.returnAggregate) ? proto.returnAggregate : null;
  const malformedReturnAggregate = Object.hasOwn(proto || {}, 'returnAggregate')
    && proto?.returnAggregate != null && typeof proto.returnAggregate !== 'boolean'
    && !returnAggregate;
  const aggregate=proto?.aggregate===true||proto?.isAggregate===true||!!returnAggregate
    || aggregateLayoutDescriptorPresent(proto)
    || malformedReturnAggregate
    ||/aggregate|struct|union|record|array|composite/.test(type+' '+cls);
  const explicitReturnBits = explicitReturnBitsOf(proto?.returnBits, proto?.bits, opts?.returnBits);
  const aggregateLayout = aggregate ? aggregateReturnLayout(proto, explicitReturnBits) : null;
  if (aggregate && !aggregateLayout) {
    return { reg:null, regs:[], bits:explicitReturnBits, bytes:null, aggregate:true, partial:true,
      reason:'aapcs64-aggregate-return-size-layout-unproven' };
  }
  if ((proto?.indirectResult === true || cls === 'indirect') && aggregate && explicitReturnBits == null) {
    return { reg:null, regs:[], bits:null, bytes:null, aggregate:true, partial:true,
      reason:'aapcs64-aggregate-return-size-not-proven' };
  }
  if (proto?.indirectResult === true || cls === 'indirect') return indirectReturnResult();
  if (scalableReturnClass(proto,type,cls)) return null;
  const returnBits = aggregate
    ? explicitReturnBits ?? aggregateLayout?.bits ?? null
    : returnBitsOf(proto?.returnBits, proto?.bits, opts?.returnBits);
  if (aggregate && returnBits == null) {
    return { reg:null, regs:[], bits:null, bytes:null, aggregate:true, partial:true,
      reason:'aapcs64-aggregate-return-size-not-proven' };
  }
  if (aggregate && aggregateLayout?.bytes > Math.ceil(returnBits / 8)) {
    return { reg:null, regs:[], bits:returnBits, bytes:aggregateLayout.bytes, aggregate:true, partial:true,
      reason:'aapcs64-padded-aggregate-return-layout-not-represented' };
  }
  if (returnBits == null) return null;
  const homogeneous = homogeneousReturnInfo(proto, cls, returnBits, aggregateLayout);
  if (homogeneous?.invalid) return { reg:null, regs:[], bits:returnBits, aggregate:true, partial:true, reason:'aapcs64-homogeneous-return-layout-not-proven' };
  if (homogeneous) {
    const pieces = homogeneousReturnPieces(homogeneous);
    return {
      reg:pieces[0].reg, regs:pieces.map((piece) => piece.reg), pieces,
      bits:returnBits, bytes:homogeneous.bytes, aggregate:true,
      abiClass:homogeneous.kind, members:homogeneous.members,
      elementBits:homogeneous.elementBits, homogeneousLayoutProven:true,
    };
  }
  if (cls.includes('fp') || cls.includes('float') || cls.includes('vector') || /^(float|double|__fp16)/.test(type)) {
    return { reg:'v0', bits:returnBits };
  }
  if (type || cls || opts?.returnsValue === true || proto?.returnsValue === true) {
    const wideInteger=!aggregate&&(/(?:unsigned\s+)?__int128|int128_t|uint128_t/.test(type+' '+cls)||returnBits===128);
    if (aggregate && returnBits>128) return indirectReturnResult();
    if ((aggregate && returnBits>64) || wideInteger) {
      const pieces = aggregateReturnPieces(returnBits);
      if (!pieces) return { reg:null, partial:true, aggregate:true, reason:'aapcs64-aggregate-return-width-not-proven' };
      return {reg:'x0',regs:pieces.map((piece) => piece.reg),bits:returnBits,bytes:pieces.length * 8,aggregate,wideInteger,pieces};
    }
    if (aggregate) {
      const pieces = aggregateReturnPieces(returnBits);
      return { reg:'x0', regs:['x0'], bits:returnBits, bytes:8, aggregate:true,
        abiClass:'integer-aggregate', pieces:pieces || [] };
    }
    return { reg:'x0', bits:returnBits };
  }
  return null;
}

const CALLER_SAVED_BASE = Object.freeze(['x0','x1','x2','x3','x4','x5','x6','x7','x8','x9','x10','x11','x12','x13','x14','x15','x16','x17','x30','nzcv',
  ...Array.from({length:8},(_x,i)=>`v${i}`), ...Array.from({length:16},(_x,i)=>`v${i+16}`)]);
const CALLER_SAVED_WITH_X18 = Object.freeze(['x0','x1','x2','x3','x4','x5','x6','x7','x8','x9','x10','x11','x12','x13','x14','x15','x16','x17','x18','x30','nzcv',
  ...Array.from({length:8},(_x,i)=>`v${i}`), ...Array.from({length:16},(_x,i)=>`v${i+16}`)]);
const CALLEE_SAVED = Object.freeze(['x19','x20','x21','x22','x23','x24','x25','x26','x27','x28','x29', ...Array.from({length:8},(_x,i)=>`v${i+8}`)]);
const APPLE_X18_RESERVED = new Set(['apple','darwin','macos','macosx','ios','ipados','tvos','watchos','visionos','maccatalyst','ios-simulator','tvos-simulator','watchos-simulator','visionos-simulator']);

function platformFromContext(context = {}) {
  return String(context?.platform || context?.image?.platform || context?.target?.platform || context?.binary?.platform || 'unknown').trim().toLowerCase();
}

function callerSavedFor(context = {}) {
  return APPLE_X18_RESERVED.has(platformFromContext(context)) ? CALLER_SAVED_BASE : CALLER_SAVED_WITH_X18;
}

export const AAPCS64_ABI = new ABIPlugin({
  id:'aapcs64', semanticVersion:'2', architectureId:'arm64',
  platformPredicate:({ platform }) => !platform || platform === 'linux' || platform === 'android' || platform === 'unknown',
  callingConventions:()=>Object.freeze(['aapcs64']),
  classifyArguments:classifyAAPCS64Arguments,
  classifyCallReturn:classifyAAPCS64CallReturn,
  classifyFunctionReturn:classifyAAPCS64FunctionReturn,
  classifyEntryRegister:(reg) => /^x[0-7]$/.test(String(reg || '')) ? { kind:'argument', reg:String(reg), index:Number(String(reg).slice(1)) } : { kind:'incoming-register-state', reg:String(reg || '') },
  callerSaved:(context)=>callerSavedFor(context),
  calleeSaved:()=>CALLEE_SAVED,
  stackRules:()=>Object.freeze({ alignment:16, stackGrows:'down', argumentSlotBytes:8, variadicRegisterSaveAreas:true }),
  redZone:()=>0,
  unwindRules:()=>Object.freeze({ framePointer:'x29', linkRegister:'x30' }),
  defaultUnknownCallEffects:(context)=>Object.freeze({ registerClobbers:callerSavedFor(context), memoryEffects:'unknown', mayThrow:true, stackArguments:'unknown', stackArgsMayContainPointers:true }),
});
