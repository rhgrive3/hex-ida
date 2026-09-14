import { deepFreeze } from '../../core/identity/index.js';
import { createManagedImageId, createManagedModuleId } from '../shared/identity.js';
import { validateDexMap } from './map-validation.js';
import { checkedRange, fail } from './validation-utils.js';
import { readDexUleb128 as readUleb128 } from './leb128.js';
import { dexTypeInfo } from './descriptor.js';
import { dexDefinitionCodeError, dexMethodDefinitions } from './method-definitions.js';

// Aggregate pre-allocation bound on unique `type_list` materialization inside
// one parse. Aliased offsets are interned, so the charge is per physical list
// (#8707); an image that legitimately needs more distinct parameter entries than
// this is refused before any of those arrays exist.
export const DEX_TYPE_LIST_ENTRY_BUDGET = 1_000_000;

function requireOptionalDataItemOffset(limit, offset, alignment, minSize, code) {
  if (offset === 0) return;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % alignment !== 0) fail(code);
  checkedRange(limit, offset, minSize, code);
}

function requireIndex(table, idx, code) {
  if (!Number.isSafeInteger(idx) || idx < 0 || idx >= table.length) fail(code);
  return table[idx];
}

function compareDexIndexTuples(left, right) {
  for (let i = 0; i < left.length; i++) {
    if (left[i] < right[i]) return -1;
    if (left[i] > right[i]) return 1;
  }
  return 0;
}

// DEX string_ids use a locale-independent UTF-16 ordering. Keep this
// comparison explicit rather than using localeCompare, whose result can vary
// with the host locale and would not validate the on-disk identity order.
function compareDexStrings(left, right) {
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const leftUnit = left.charCodeAt(i), rightUnit = right.charCodeAt(i);
    if (leftUnit < rightUnit) return -1;
    if (leftUnit > rightUnit) return 1;
  }
  return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
}

function compareDexProtoKeys(left, right) {
  if (left.returnTypeIdx < right.returnTypeIdx) return -1;
  if (left.returnTypeIdx > right.returnTypeIdx) return 1;
  const length = Math.min(left.parameterTypeIndices.length, right.parameterTypeIndices.length);
  for (let i = 0; i < length; i++) {
    if (left.parameterTypeIndices[i] < right.parameterTypeIndices[i]) return -1;
    if (left.parameterTypeIndices[i] > right.parameterTypeIndices[i]) return 1;
  }
  return left.parameterTypeIndices.length < right.parameterTypeIndices.length
    ? -1
    : left.parameterTypeIndices.length > right.parameterTypeIndices.length ? 1 : 0;
}

function requireFieldOwnerType(descriptor) {
  if (!descriptor.startsWith('L')) fail('dex-invalid-field-owner-type');
  return descriptor;
}

function requireMethodOwnerType(descriptor) {
  if (!descriptor.startsWith('L') && !descriptor.startsWith('[')) fail('dex-invalid-method-owner-type');
  return descriptor;
}

// AOSP dex-format#class-def-item: class_idx and non-NO_INDEX superclass_idx
// must be class types. type_ids legitimately hold primitives, arrays and void
// for other roles, so the definer role resolves through its own contract —
// a non-array object descriptor (L...;) — or the role violation is lost
// after parsing and a primitive masquerades as a defined class (#7436).
function requireClassType(types, idx, code) {
  const descriptor = requireIndex(types, idx, code);
  const info = dexTypeInfo(descriptor);
  if (info.category !== 'object' || !descriptor.startsWith('L')) fail(code);
  return descriptor;
}

function isDexSimpleNameChar(codePoint, extendedSpaces) {
  if ((codePoint >= 0x41 && codePoint <= 0x5a) ||
      (codePoint >= 0x61 && codePoint <= 0x7a) ||
      (codePoint >= 0x30 && codePoint <= 0x39) ||
      codePoint === 0x24 || codePoint === 0x2d || codePoint === 0x5f) return true;
  if (codePoint === 0x20 || codePoint === 0x00a0 || codePoint === 0x202f) return extendedSpaces;
  if (codePoint >= 0x00a1 && codePoint <= 0x1fff) return true;
  if (codePoint >= 0x2000 && codePoint <= 0x200a) return extendedSpaces;
  if (codePoint >= 0x2010 && codePoint <= 0x2027) return true;
  if (codePoint >= 0x2030 && codePoint <= 0xd7ff) return true;
  if (codePoint >= 0xe000 && codePoint <= 0xffef) return true;
  return codePoint >= 0x10000 && codePoint <= 0x10ffff;
}

function isDexSimpleName(name, dexVersion) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const extendedSpaces = dexVersion >= 40;
  for (const char of name) {
    if (!isDexSimpleNameChar(char.codePointAt(0), extendedSpaces)) return false;
  }
  return true;
}

function requireDexMemberName(name, dexVersion, code) {
  const wrapped = name.length >= 2 && name.startsWith('<') && name.endsWith('>');
  const simpleName = wrapped ? name.slice(1, -1) : name;
  if (!isDexSimpleName(simpleName, dexVersion)) fail(code);
  return name;
}

const SUPPORTED_DEX_VERSIONS = new Set(['035', '037', '038', '039', '040']);

export function probeDex(bytes) {
  if (!bytes || bytes.length < 40) return { supported: false, confidence: 0, reason: 'too-small' };
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] !== 0x64 || u8[1] !== 0x65 || u8[2] !== 0x78 || u8[3] !== 0x0a || u8[7] !== 0x00) {
    return { supported: false, confidence: 0, reason: 'invalid-magic' };
  }
  if (u8[4] < 0x30 || u8[4] > 0x39 || u8[5] < 0x30 || u8[5] > 0x39 || u8[6] < 0x30 || u8[6] > 0x39) {
    return { supported: false, confidence: 0, reason: 'invalid-version' };
  }

  const vStr = String.fromCharCode(u8[4], u8[5], u8[6]);
  const versionInfo = { formatVersion: `dex-${vStr}`, vmSpecEdition: `dalvik-dex-${vStr}` };
  if (!SUPPORTED_DEX_VERSIONS.has(vStr)) {
    return { supported: false, confidence: 0, reason: 'unsupported-version', ...versionInfo };
  }
  return { supported: true, confidence: 1.0, ...versionInfo };
}

function decodeMutf8(bytes, offset) {
  const { value: utf16Size, nextOffset } = readUleb128(bytes, offset);
  let pos = nextOffset;
  const chars = [];
  let decodedUnits = 0;
  let terminated = false;

  while (pos < bytes.length) {
    const b1 = bytes[pos++];
    if (b1 === 0) {
      terminated = true;
      break;
    }

    let codeUnit;
    if (b1 <= 0x7f) {
      codeUnit = b1;
    } else if ((b1 & 0xe0) === 0xc0) {
      if (pos >= bytes.length) fail('dex-malformed-string-data');
      const b2 = bytes[pos++];
      if ((b2 & 0xc0) !== 0x80) fail('dex-malformed-string-data');
      codeUnit = ((b1 & 0x1f) << 6) | (b2 & 0x3f);
      if (codeUnit === 0) {
        if (b1 !== 0xc0 || b2 !== 0x80) fail('dex-malformed-string-data');
      } else if (codeUnit < 0x80) {
        fail('dex-malformed-string-data');
      }
    } else if ((b1 & 0xf0) === 0xe0) {
      if (pos + 1 >= bytes.length) fail('dex-malformed-string-data');
      const b2 = bytes[pos++];
      const b3 = bytes[pos++];
      if ((b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) fail('dex-malformed-string-data');
      codeUnit = ((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      if (codeUnit < 0x800) fail('dex-malformed-string-data');
    } else {
      fail('dex-malformed-string-data');
    }

    chars.push(String.fromCharCode(codeUnit));
    decodedUnits++;
    if (decodedUnits > utf16Size) fail('dex-malformed-string-data');
  }

  if (!terminated || decodedUnits !== utf16Size) fail('dex-malformed-string-data');
  return chars.join('');
}

export function parseDex(bytes, options = {}) {
  const probe = probeDex(bytes);
  if (!probe.supported) fail('dex-unsupported-binary');
  const dexVersion = Number(probe.formatVersion.slice(4));
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  if (u8.length < 0x70) fail('dex-truncated-header');
  const fileSize = view.getUint32(32, true);
  const headerSize = view.getUint32(36, true);
  const endianTag = view.getUint32(40, true);
  if (fileSize !== u8.length) fail('dex-file-size-mismatch');
  if (headerSize !== 0x70) fail('dex-invalid-header-size');
  if (endianTag !== 0x12345678) {
    if (endianTag === 0x78563412) fail('dex-reverse-endian-unsupported');
    fail('dex-invalid-endian-tag');
  }

  const stringIdsSize = view.getUint32(56, true), stringIdsOff = view.getUint32(60, true);
  const typeIdsSize = view.getUint32(64, true), typeIdsOff = view.getUint32(68, true);
  const protoIdsSize = view.getUint32(72, true), protoIdsOff = view.getUint32(76, true);
  const fieldIdsSize = view.getUint32(80, true), fieldIdsOff = view.getUint32(84, true);
  const methodIdsSize = view.getUint32(88, true), methodIdsOff = view.getUint32(92, true);
  const classDefsSize = view.getUint32(96, true), classDefsOff = view.getUint32(100, true);

  const validateTable = (size, off, width, code) => {
    if (size === 0) {
      if (off !== 0) fail(code);
      return;
    }
    if (off === 0) fail(code);
    if (!Number.isSafeInteger(size) || size > Math.floor(fileSize / width)) fail(code);
    checkedRange(fileSize, off, size * width, code);
  };
  validateTable(stringIdsSize, stringIdsOff, 4, 'dex-truncated-string-ids');
  validateTable(typeIdsSize, typeIdsOff, 4, 'dex-invalid-type-ids-range');
  validateTable(protoIdsSize, protoIdsOff, 12, 'dex-invalid-proto-ids-range');
  validateTable(fieldIdsSize, fieldIdsOff, 8, 'dex-invalid-field-ids-range');
  validateTable(methodIdsSize, methodIdsOff, 8, 'dex-invalid-method-ids-range');
  validateTable(classDefsSize, classDefsOff, 32, 'dex-invalid-class-defs-range');

  // Validate the complete map topology before decoding payloads, while preserving
  // established payload-specific error authority for malformed variable-size items.
  validateDexMap(u8, { validateVariableItems: false });

  const dataStart = view.getUint32(108, true);
  const dataEnd = dataStart + view.getUint32(104, true);
  const dataBytes = u8.subarray(0, dataEnd);
  const dataRange = (offset, size, code, alignment = 1, optional = false) => {
    if (optional && offset === 0) return;
    if (offset < dataStart || offset % alignment !== 0) fail(code);
    checkedRange(dataEnd, offset, size, code);
  };

  const strings = [];
  let previousString = null;
  for (let i=0;i<stringIdsSize;i++) {
    const off=stringIdsOff+i*4;
    if (off+4>fileSize) fail('dex-truncated-string-ids');
    const dataOff=view.getUint32(off,true);
    dataRange(dataOff,1,'dex-invalid-string-data-offset');
    const string = decodeMutf8(dataBytes,dataOff);
    if (previousString !== null && compareDexStrings(previousString, string) >= 0) {
      fail('dex-string-ids-order-invalid');
    }
    previousString = string;
    strings.push(string);
  }

  const types=[];
  let previousDescriptorIdx = -1;
  for (let i=0;i<typeIdsSize;i++) {
    const off=typeIdsOff+i*4;
    if (off+4>u8.length) fail('dex-truncated-type-ids');
    const descriptorIdx=view.getUint32(off,true);
    const descriptor = requireIndex(strings, descriptorIdx, 'dex-invalid-type-descriptor-index');
    dexTypeInfo(descriptor, { allowVoid:true });
    if (descriptorIdx <= previousDescriptorIdx) fail('dex-type-ids-order-invalid');
    previousDescriptorIdx = descriptorIdx;
    types.push(descriptor);
  }

  // A DEX `type_list` is one physical object no matter how many `proto_id_item`
  // or `class_def_item` rows alias it, so it is materialized once per exact
  // offset behind an aggregate entry charge taken *before* allocation, and the
  // immutable result is shared (#8707).
  const typeLists = new Map();
  const maxTypeListEntries = Number.isSafeInteger(options.maxTypeListEntries) && options.maxTypeListEntries >= 0
    ? options.maxTypeListEntries
    : DEX_TYPE_LIST_ENTRY_BUDGET;
  let typeListEntriesCharged = 0;
  function decodeTypeList(listOff, {
    headerCode, bodyCode, bodyAlignment = 1, indexCode, sizeBoundCode = null,
  }) {
    const cached = typeLists.get(listOff);
    if (cached !== undefined) return cached;
    dataRange(listOff, 4, headerCode, 4);
    const size = view.getUint32(listOff, true);
    if (sizeBoundCode !== null && size > Math.floor((fileSize - listOff - 4) / 2)) fail(sizeBoundCode);
    dataRange(listOff + 4, size * 2, bodyCode, bodyAlignment);
    if (size > maxTypeListEntries - typeListEntriesCharged) fail('dex-type-list-materialization-budget-exceeded');
    typeListEntriesCharged += size;
    const descriptors = [];
    const typeIndices = [];
    for (let entry = 0; entry < size; entry++) {
      const typeIdx = view.getUint16(listOff + 4 + entry * 2, true);
      const descriptor = requireIndex(types, typeIdx, indexCode);
      typeIndices.push(typeIdx);
      descriptors.push(descriptor);
    }
    const materialized = {
      descriptors: Object.freeze(descriptors),
      typeIndices: Object.freeze(typeIndices),
      shortySuffix: null,
    };
    typeLists.set(listOff, materialized);
    return materialized;
  }
  function typeListShortySuffix(list) {
    if (list.shortySuffix === null) {
      list.shortySuffix = list.descriptors.map((type) => dexTypeInfo(type).shorty).join('');
    }
    return list.shortySuffix;
  }
  const emptyTypeList = { descriptors: Object.freeze([]), typeIndices: Object.freeze([]), shortySuffix: '' };
  // `class_def_item.interfaces_off` (#7620) checks are functions of the physical
  // list's contents, so they are proven once per offset and reused by every
  // class aliasing that list.
  const validatedInterfaceLists = new Set();
  function validateInterfaceTypeList(listOff, list) {
    if (validatedInterfaceLists.has(listOff)) return;
    const seenInterfaces = new Set();
    for (const descriptor of list.descriptors) {
      if (!descriptor.startsWith('L')) fail('dex-invalid-interface-type');
      if (seenInterfaces.has(descriptor)) fail('dex-duplicate-interface-type');
      seenInterfaces.add(descriptor);
    }
    validatedInterfaceLists.add(listOff);
  }

  const protos=[];
  let previousProtoKey = null;
  for (let i=0;i<protoIdsSize;i++) {
    const off=protoIdsOff+i*12;
    if (off+12>u8.length) fail('dex-truncated-proto-ids');
    const shortyIdx=view.getUint32(off,true), returnTypeIdx=view.getUint32(off+4,true), paramsOff=view.getUint32(off+8,true);
    let params = emptyTypeList.descriptors;
    let parameterTypeIndices = emptyTypeList.typeIndices;
    let paramsShorty = '';
    if (paramsOff>0) {
      const list = decodeTypeList(paramsOff, {
        headerCode:'dex-invalid-proto-params-range',
        bodyCode:'dex-invalid-proto-params-range',
        indexCode:'dex-invalid-proto-param-type-index',
        sizeBoundCode:'dex-invalid-proto-params-range',
      });
      params = list.descriptors;
      parameterTypeIndices = list.typeIndices;
      paramsShorty = typeListShortySuffix(list);
    }
    const shorty = requireIndex(strings,shortyIdx,'dex-invalid-proto-shorty-index');
    const returnType = requireIndex(types,returnTypeIdx,'dex-invalid-proto-return-type-index');
    if (shorty !== dexTypeInfo(returnType,{allowVoid:true}).shorty + paramsShorty) fail('dex-invalid-proto-shorty');
    const protoKey = { returnTypeIdx, parameterTypeIndices };
    if (previousProtoKey !== null && compareDexProtoKeys(previousProtoKey, protoKey) >= 0) {
      fail('dex-proto-ids-order-invalid');
    }
    previousProtoKey = protoKey;
    protos.push({shorty,returnType,params});
  }

  const fields=[];
  let previousFieldKey = null;
  for(let i=0;i<fieldIdsSize;i++) {
    const off=fieldIdsOff+i*8;
    if(off+8>u8.length) fail('dex-truncated-field-ids');
    const classIdx=view.getUint16(off,true),typeIdx=view.getUint16(off+2,true),nameIdx=view.getUint32(off+4,true);
    const classType = requireFieldOwnerType(requireIndex(types,classIdx,'dex-invalid-field-class-index'));
    const name = requireDexMemberName(requireIndex(strings,nameIdx,'dex-invalid-field-name-index'),dexVersion,'dex-invalid-field-name');
    const fieldType = requireIndex(types,typeIdx,'dex-invalid-field-type-index');
    const fieldKey = [classIdx,nameIdx,typeIdx];
    if (previousFieldKey !== null && compareDexIndexTuples(previousFieldKey, fieldKey) >= 0) {
      fail('dex-field-ids-order-invalid');
    }
    previousFieldKey = fieldKey;
    fields.push({classType,type:fieldType,name});
  }

  const methods=[];
  let previousMethodKey = null;
  for(let i=0;i<methodIdsSize;i++) {
    const off=methodIdsOff+i*8;
    if(off+8>u8.length) fail('dex-truncated-method-ids');
    const classIdx=view.getUint16(off,true),protoIdx=view.getUint16(off+2,true),nameIdx=view.getUint32(off+4,true);
    const classType = requireMethodOwnerType(requireIndex(types,classIdx,'dex-invalid-method-class-index'));
    const name = requireDexMemberName(requireIndex(strings,nameIdx,'dex-invalid-method-name-index'),dexVersion,'dex-invalid-method-name');
    const proto = requireIndex(protos,protoIdx,'dex-invalid-method-proto-index');
    const methodKey = [classIdx,nameIdx,protoIdx];
    if (previousMethodKey !== null && compareDexIndexTuples(previousMethodKey, methodKey) >= 0) {
      fail('dex-method-ids-order-invalid');
    }
    previousMethodKey = methodKey;
    methods.push({classType,proto,name});
  }

  const classes=[];
  let previousClassIdx = -1;
  for(let i=0;i<classDefsSize;i++) {
    const off=classDefsOff+i*32;
    if(off+32>u8.length) fail('dex-truncated-class-defs');
    const classIdx=view.getUint32(off,true),accessFlags=view.getUint32(off+4,true),superclassIdx=view.getUint32(off+8,true);
    const interfacesOff=view.getUint32(off+12,true),sourceFileIdx=view.getUint32(off+16,true),annotationsOff=view.getUint32(off+20,true),classDataOff=view.getUint32(off+24,true),staticValuesOff=view.getUint32(off+28,true);
    requireOptionalDataItemOffset(fileSize,interfacesOff,4,4,'dex-invalid-interfaces-offset');
    requireOptionalDataItemOffset(fileSize,annotationsOff,4,16,'dex-invalid-annotations-offset');
    requireOptionalDataItemOffset(fileSize,staticValuesOff,1,1,'dex-invalid-static-values-offset');
    dataRange(annotationsOff,16,'dex-invalid-annotations-offset',4,true);
    dataRange(staticValuesOff,1,'dex-invalid-static-values-offset',1,true);
    const classType = requireClassType(types, classIdx, 'dex-invalid-class-definer-type');
    if (classIdx <= previousClassIdx) fail('dex-class-defs-order-invalid');
    previousClassIdx = classIdx;
    const directMethods=[],virtualMethods=[],staticFields=[],instanceFields=[];
    if(classDataOff>0) {
      dataRange(classDataOff,4,'dex-invalid-class-data-offset');
      let cPos=classDataOff;
      const {value:staticFieldsSize,nextOffset:sOff}=readUleb128(dataBytes,cPos);
      const {value:instanceFieldsSize,nextOffset:iOff}=readUleb128(dataBytes,sOff);
      const {value:directMethodsSize,nextOffset:dOff}=readUleb128(dataBytes,iOff);
      const {value:virtualMethodsSize,nextOffset:vOff}=readUleb128(dataBytes,dOff); cPos=vOff;
      const fieldDefinitions = new Set();
      for (const [count, output] of [[staticFieldsSize, staticFields], [instanceFieldsSize, instanceFields]]) {
        let lastFieldIdx = 0;
        for (let f = 0; f < count; f++) {
          const delta = readUleb128(dataBytes, cPos);
          const flags = readUleb128(dataBytes, delta.nextOffset); cPos = flags.nextOffset;
          lastFieldIdx += delta.value;
          const field = requireIndex(fields,lastFieldIdx,'dex-invalid-class-data-field-index');
          if ((f > 0 && delta.value === 0) || fieldDefinitions.has(lastFieldIdx)) fail('dex-field-definition-order-invalid');
          if (field.classType !== classType) fail('dex-field-definition-owner-mismatch');
          fieldDefinitions.add(lastFieldIdx);
          output.push({ fieldIdx:lastFieldIdx, accessFlags:flags.value });
        }
      }
      const validateCode = (codeOff, accessFlags) => {
        const error = dexDefinitionCodeError({codeOff, accessFlags});
        if (error) fail(error);
        if (codeOff === 0) return;
        dataRange(codeOff,16,'dex-invalid-code-offset',4);
        const instructionBytes = view.getUint32(codeOff+12,true)*2;
        dataRange(codeOff+16,instructionBytes,'dex-invalid-code-range');
        dataRange(view.getUint32(codeOff+8,true),1,'dex-invalid-debug-info-offset',1,true);
      };
      let lastMethodIdx=0;
      for(let m=0;m<directMethodsSize;m++) {
        const {value:delta,nextOffset:m1}=readUleb128(dataBytes,cPos); const {value:mFlags,nextOffset:m2}=readUleb128(dataBytes,m1); const {value:codeOff,nextOffset:m3}=readUleb128(dataBytes,m2); cPos=m3;
        lastMethodIdx+=delta; requireIndex(methods,lastMethodIdx,'dex-invalid-class-data-method-index'); validateCode(codeOff,mFlags); directMethods.push({methodIdx:lastMethodIdx,accessFlags:mFlags,codeOff});
      }
      lastMethodIdx=0;
      for(let m=0;m<virtualMethodsSize;m++) {
        const {value:delta,nextOffset:m1}=readUleb128(dataBytes,cPos); const {value:mFlags,nextOffset:m2}=readUleb128(dataBytes,m1); const {value:codeOff,nextOffset:m3}=readUleb128(dataBytes,m2); cPos=m3;
        lastMethodIdx+=delta; requireIndex(methods,lastMethodIdx,'dex-invalid-class-data-method-index'); validateCode(codeOff,mFlags); virtualMethods.push({methodIdx:lastMethodIdx,accessFlags:mFlags,codeOff});
      }
    }
    // class_def_item.interfaces_off is the authority for implemented
    // interfaces: decode the referenced type_list losslessly and fail closed
    // on AOSP contract violations — bounds, alignment, type_idx validity,
    // class (non-array/primitive) entries, and duplicates (#7620).
    let interfaceTypes = emptyTypeList.descriptors;
    if(interfacesOff!==0){
      const list = decodeTypeList(interfacesOff, {
        headerCode:'dex-invalid-interfaces-offset',
        bodyCode:'dex-invalid-interfaces-range',
        bodyAlignment:2,
        indexCode:'dex-invalid-interface-type-index',
      });
      validateInterfaceTypeList(interfacesOff, list);
      interfaceTypes = list.descriptors;
    }
    classes.push({classType,accessFlags,superType:superclassIdx!==0xffffffff?requireClassType(types,superclassIdx,'dex-invalid-superclass-type'):null,sourceFile:sourceFileIdx!==0xffffffff?requireIndex(strings,sourceFileIdx,'dex-invalid-source-file-index'):null,interfaceTypes,staticFields,instanceFields,directMethods,virtualMethods});
  }

  dexMethodDefinitions({ methods, classes });
  validateDexMap(u8);

  const binaryId=options.binaryId||'dex-binary'; const imageId=createManagedImageId(binaryId); const moduleId=createManagedModuleId(imageId,'classes.dex');
  return deepFreeze({imageId,moduleId,formatVersion:probe.formatVersion,vmSpecEdition:probe.vmSpecEdition,strings,types,protos,fields,methods,classes,dataSection:{offset:dataStart,size:dataEnd-dataStart},rawBytes:u8});
}
