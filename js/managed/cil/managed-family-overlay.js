import { createOriginSet } from '../../core/identity/origin.js';
import { createVMEffectBundle } from '../shared/vm-effects.js';
import { cilStackValueWidth } from './stack-width.js';

const TYPE_DEF = 0x02;
const TYPE_REF = 0x01;
const TYPE_SPEC = 0x1b;
const FLOAT_BITS = Object.freeze({ r4:32, r8:64 });

const LOADS = Object.freeze({
  0x90:{ mnemonic:'ldelem.i1', stackType:'int32', bits:32, primitive:'i1', byteWidth:1 },
  0x91:{ mnemonic:'ldelem.u1', stackType:'int32', bits:32, primitive:'u1', byteWidth:1 },
  0x92:{ mnemonic:'ldelem.i2', stackType:'int32', bits:32, primitive:'i2', byteWidth:2 },
  0x93:{ mnemonic:'ldelem.u2', stackType:'int32', bits:32, primitive:'u2', byteWidth:2 },
  0x94:{ mnemonic:'ldelem.i4', stackType:'int32', bits:32, primitive:'i4', byteWidth:4 },
  0x95:{ mnemonic:'ldelem.u4', stackType:'int32', bits:32, primitive:'u4', byteWidth:4 },
  0x96:{ mnemonic:'ldelem.i8', stackType:'int64', bits:64, primitive:'i8', byteWidth:8 },
  0x97:{ mnemonic:'ldelem.i', stackType:'native-int' },
  0x98:{ mnemonic:'ldelem.r4', stackType:'float', primitive:'r4', byteWidth:4 },
  0x99:{ mnemonic:'ldelem.r8', stackType:'float', primitive:'r8', byteWidth:8 },
  0x9a:{ mnemonic:'ldelem.ref', stackType:'object-ref' },
});
const STORES = Object.freeze({
  0x9b:{ mnemonic:'stelem.i', stackType:'native-int' },
  0x9c:{ mnemonic:'stelem.i1', stackType:'int32', primitive:'i1', byteWidth:1 },
  0x9d:{ mnemonic:'stelem.i2', stackType:'int32', primitive:'i2', byteWidth:2 },
  0x9e:{ mnemonic:'stelem.i4', stackType:'int32', primitive:'i4', byteWidth:4 },
  0x9f:{ mnemonic:'stelem.i8', stackType:'int64', primitive:'i8', byteWidth:8 },
  0xa0:{ mnemonic:'stelem.r4', stackType:'float', primitive:'r4', byteWidth:4 },
  0xa1:{ mnemonic:'stelem.r8', stackType:'float', primitive:'r8', byteWidth:8 },
  0xa2:{ mnemonic:'stelem.ref', stackType:'object-ref' },
});
const NORMAL = new Set([0x71,0x74,0x75,0x79,0x81,0x8c,0x8d,0x8e,0x8f,0xa3,0xa4,0xa5,...Object.keys(LOADS).map(Number),...Object.keys(STORES).map(Number)]);

function inlineType(image, token) {
  const table = token >>> 24, rid = token & 0x00ffffff;
  if (!Number.isSafeInteger(rid) || rid < 1) return { complete:false, reason:'cil-inline-type-token-invalid', typeToken:token };
  if (table === TYPE_DEF) {
    const row = image?.types?.[rid - 1];
    if (!row) return { complete:false, reason:'cil-inline-type-row-missing', typeToken:token };
    return { complete:true, typeToken:token, type:{ kind:'metadata-type', table:'TypeDef', rid, token, name:row.name ?? null, namespace:row.namespace ?? '' } };
  }
  if (table === TYPE_REF) {
    const row = image?.typeRefs?.[rid - 1];
    if (!row) return { complete:false, reason:'cil-inline-type-row-missing', typeToken:token };
    return { complete:true, typeToken:token, type:{ kind:'metadata-type', table:'TypeRef', rid, token, name:row.name ?? null, namespace:row.namespace ?? '', ...(row.resolutionScope ? { resolutionScope:row.resolutionScope } : {}) } };
  }
  if (table === TYPE_SPEC) {
    const row = image?.typeSpecs?.[rid - 1];
    if (!row) return { complete:false, reason:'cil-inline-type-row-missing', typeToken:token };
    if (!row.signature) return { complete:false, reason:'cil-inline-typespec-unresolved', typeToken:token, type:{ kind:'metadata-type', table:'TypeSpec', rid, token, signatureBlobIndex:row.signatureBlobIndex } };
    return { complete:true, typeToken:token, type:{ kind:'metadata-type', table:'TypeSpec', rid, token, signature:row.signature } };
  }
  return { complete:false, reason:'cil-inline-type-table-invalid', typeToken:token };
}
function stackValue(type) {
  if (!type?.complete) return {};
  const signature = type.type?.signature;
  return signature && typeof signature === 'object'
    ? { ...signature, typeToken:type.typeToken }
    : { typeToken:type.typeToken, managedType:type.type };
}
function byteWidth(value, nativePointerBits) {
  const bits = cilStackValueWidth(value);
  if (bits != null && bits % 8 === 0) return bits / 8;
  if (value?.stackType === 'float') return FLOAT_BITS[value.primitive] == null ? null : FLOAT_BITS[value.primitive] / 8;
  if (['object-ref','native-int','managed-pointer'].includes(value?.stackType)) return nativePointerBits == null ? null : nativePointerBits / 8;
  return null;
}
function arrayExceptions(mismatch = false) {
  return [
    { kind:'null-reference', condition:'array==null' },
    { kind:'index-out-of-range', condition:'index<0||index>=array.length' },
    ...(mismatch ? [{ kind:'array-type-mismatch', condition:'value-not-assignable-to-element-type' }] : []),
  ];
}
function readU32(bytecode, offset) {
  if (offset + 4 > bytecode.length) throw new TypeError('cil-truncated-operand');
  return new DataView(bytecode.buffer, bytecode.byteOffset, bytecode.byteLength).getUint32(offset, true);
}
function draftBase({ methodId, operationId, profileId, offset, opcode, mnemonic, codeBase, end }) {
  return {
    schemaVersion:1, contractVersion:'1.0.0', frontendId:'cil', frontendSemanticVersion:'1.0.0',
    profileId, methodId, operationId, bytecodeOffset:offset, opcode, mnemonic,
    consumedValues:[], producedValues:[], locationReads:[], locationWrites:[], memoryEffects:[], callEffects:[], controlEffects:[], possibleExceptions:[],
    origin:createOriginSet({ operationIds:[operationId], byteRanges:[{ start:codeBase + offset, end:codeBase + end }] }),
    completeness:'exact', unknownEffects:[], metadata:{},
  };
}
function partial(draft, category, reason) {
  draft.completeness = draft.completeness === 'unknown' ? 'unknown' : 'partial';
  draft.unknownEffects.push({ category, reason });
}

export function isCilManagedFamilyInstruction(bytecode, offset) {
  if (!(bytecode instanceof Uint8Array) || offset < 0 || offset >= bytecode.length) return false;
  const op = bytecode[offset];
  return NORMAL.has(op) || (op === 0xfe && bytecode[offset + 1] === 0x15);
}

export function liftCilManagedFamilyInstruction({ bytecode, offset, codeBase, cilImage, methodId, operationId, nativePointerBits, profileId, options = {} }) {
  if (!isCilManagedFamilyInstruction(bytecode, offset)) return null;
  let opcode = bytecode[offset], operand = offset + 1, end = operand, mnemonic = null;
  if (opcode === 0xfe) { opcode = 0xfe15; operand = offset + 2; end = operand + 4; mnemonic = 'initobj'; }
  else if ([0x71,0x74,0x75,0x79,0x81,0x8c,0x8d,0x8f,0xa3,0xa4,0xa5].includes(opcode)) end = operand + 4;
  if (end > bytecode.length) throw new TypeError('cil-truncated-operand');
  if (end === operand) end = offset + 1;
  const d = draftBase({ methodId, operationId, profileId, offset, opcode, mnemonic, codeBase, end });
  const token = end - operand === 4 ? readU32(bytecode, operand) : null;
  const resolved = token == null ? null : inlineType(cilImage, token);

  if (opcode === 0x71) {
    d.mnemonic='ldobj'; const value=stackValue(resolved), width=byteWidth(value,nativePointerBits);
    d.consumedValues.push({id:'address',stackType:'managed-pointer'}); d.producedValues.push(value);
    d.memoryEffects.push({space:'managed-memory',isWrite:false,...(width==null?{}:{byteWidth:width}),typeToken:token,type:resolved.type??null});
    d.possibleExceptions.push({kind:'null-reference',condition:'address==null'});
    if (!resolved.complete || width==null) partial(d,!resolved.complete?'types':'memory',!resolved.complete?resolved.reason:'cil-ldobj-storage-width-unresolved');
  } else if (opcode === 0x74 || opcode === 0x75) {
    d.mnemonic=opcode===0x74?'castclass':'isinst'; d.consumedValues.push({id:'obj',stackType:'object-ref'});
    d.producedValues.push({stackType:'object-ref',typeToken:token,...(resolved.type?{managedType:resolved.type}:{})});
    if (opcode===0x74) d.possibleExceptions.push({kind:'invalid-cast',condition:'obj!=null&&!assignable(obj,targetType)'});
    if (!resolved.complete) partial(d,'types',resolved.reason);
  } else if (opcode === 0x79) {
    d.mnemonic='unbox'; d.consumedValues.push({id:'obj',stackType:'object-ref'}); d.producedValues.push({stackType:'managed-pointer',typeToken:token,...(resolved.type?{pointee:resolved.type}:{})});
    d.possibleExceptions.push({kind:'null-reference',condition:'obj==null'},{kind:'invalid-cast',condition:'obj!=null&&!boxed-as-target-type'});
    if (!resolved.complete) partial(d,'types',resolved.reason);
  } else if (opcode === 0x81 || opcode === 0xfe15) {
    d.mnemonic=opcode===0x81?'stobj':'initobj'; const value=stackValue(resolved), width=byteWidth(value,nativePointerBits);
    if (opcode===0x81) d.consumedValues.push({id:'value',...value},{id:'address',stackType:'managed-pointer'}); else d.consumedValues.push({id:'address',stackType:'managed-pointer'});
    d.memoryEffects.push({space:'managed-memory',isWrite:true,...(opcode===0xfe15?{initialization:'zero'}:{}),...(width==null?{}:{byteWidth:width}),typeToken:token,type:resolved.type??null});
    d.possibleExceptions.push({kind:'null-reference',condition:'address==null'});
    if (!resolved.complete || width==null) partial(d,!resolved.complete?'types':'memory',!resolved.complete?resolved.reason:`cil-${d.mnemonic}-storage-width-unresolved`);
  } else if (opcode === 0x8c) {
    d.mnemonic='box'; d.consumedValues.push({id:'value',...stackValue(resolved)}); d.producedValues.push({stackType:'object-ref',allocationKind:'box',allocationSite:operationId,boxedTypeToken:token,...(resolved.type?{boxedType:resolved.type}:{})});
    if (!resolved.complete) partial(d,'types',resolved.reason);
  } else if (opcode === 0x8d) {
    d.mnemonic='newarr'; d.consumedValues.push({id:'length',stackType:'native-int'}); d.producedValues.push({stackType:'object-ref',allocationKind:'array',allocationSite:operationId,elementTypeToken:token,...(resolved.type?{elementType:resolved.type}:{}),arrayShape:{rank:1,sizes:[],lowerBounds:[]}});
    d.possibleExceptions.push({kind:'overflow',condition:'length<0||allocation-size-overflow'}); if (!resolved.complete) partial(d,'types',resolved.reason);
  } else if (opcode === 0x8e) {
    d.mnemonic='ldlen'; d.consumedValues.push({id:'array',stackType:'object-ref'}); d.producedValues.push({stackType:'native-int',...(nativePointerBits==null?{}:{bits:nativePointerBits}),unsigned:true}); d.possibleExceptions.push({kind:'null-reference',condition:'array==null'});
  } else if (opcode === 0x8f) {
    d.mnemonic='ldelema'; d.consumedValues.push({id:'index',stackType:'native-int'},{id:'array',stackType:'object-ref'}); d.producedValues.push({stackType:'managed-pointer',elementTypeToken:token,...(resolved.type?{pointee:resolved.type}:{})}); d.possibleExceptions.push(...arrayExceptions()); if (!resolved.complete) partial(d,'types',resolved.reason);
  } else if (LOADS[opcode]) {
    const spec=LOADS[opcode], width=spec.byteWidth??((spec.stackType==='native-int'||spec.stackType==='object-ref')&&nativePointerBits!=null?nativePointerBits/8:null); d.mnemonic=spec.mnemonic;
    d.consumedValues.push({id:'index',stackType:'native-int'},{id:'array',stackType:'object-ref'}); d.producedValues.push({stackType:spec.stackType,...(spec.bits==null?{}:{bits:spec.bits}),...(spec.primitive?{primitive:spec.primitive}:{})});
    d.memoryEffects.push({space:'array-element',isWrite:false,...(width==null?{}:{byteWidth:width}),elementKind:spec.mnemonic.slice(7),address:{base:'array',index:'index'}}); d.possibleExceptions.push(...arrayExceptions()); if (width==null) partial(d,'memory','cil-array-element-width-unresolved');
  } else if (STORES[opcode]) {
    const spec=STORES[opcode], width=spec.byteWidth??((spec.stackType==='native-int'||spec.stackType==='object-ref')&&nativePointerBits!=null?nativePointerBits/8:null); d.mnemonic=spec.mnemonic;
    d.consumedValues.push({id:'value',stackType:spec.stackType,...(spec.primitive?{primitive:spec.primitive}:{})},{id:'index',stackType:'native-int'},{id:'array',stackType:'object-ref'});
    d.memoryEffects.push({space:'array-element',isWrite:true,...(width==null?{}:{byteWidth:width}),elementKind:spec.mnemonic.slice(7),address:{base:'array',index:'index'}}); d.possibleExceptions.push(...arrayExceptions(spec.mnemonic==='stelem.ref')); if (width==null) partial(d,'memory','cil-array-element-width-unresolved');
  } else if (opcode === 0xa3 || opcode === 0xa4) {
    const write=opcode===0xa4, value=stackValue(resolved), width=byteWidth(value,nativePointerBits); d.mnemonic=write?'stelem':'ldelem';
    if (write) d.consumedValues.push({id:'value',...value},{id:'index',stackType:'native-int'},{id:'array',stackType:'object-ref'}); else { d.consumedValues.push({id:'index',stackType:'native-int'},{id:'array',stackType:'object-ref'}); d.producedValues.push(value); }
    d.memoryEffects.push({space:'array-element',isWrite:write,...(width==null?{}:{byteWidth:width}),typeToken:token,type:resolved.type??null,address:{base:'array',index:'index'}}); d.possibleExceptions.push(...arrayExceptions(write));
    if (!resolved.complete || width==null) partial(d,!resolved.complete?'types':'memory',!resolved.complete?resolved.reason:'cil-array-element-width-unresolved');
  } else if (opcode === 0xa5) {
    d.mnemonic='unbox.any'; d.consumedValues.push({id:'obj',stackType:'object-ref'}); const value=stackValue(resolved); d.producedValues.push(value);
    d.possibleExceptions.push({kind:'null-reference',condition:'obj==null&&target-is-nonnullable-value-type'},{kind:'invalid-cast',condition:'obj!=null&&!boxed-as-target-type'});
    if (!resolved.complete) partial(d,'types',resolved.reason); else if (value.stackType == null) partial(d,'types','cil-unbox-any-stack-category-unresolved');
  }
  return { bundle:createVMEffectBundle(d,options), end };
}
