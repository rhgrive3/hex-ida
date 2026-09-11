import { createManagedFieldId, createManagedTypeId } from '../shared/identity.js';
import { dexTypeInfo } from './descriptor.js';
import { fail } from './validation-utils.js';

const SUFFIXES = ['', '-wide', '-object', '-boolean', '-byte', '-char', '-short'];
const VARIANT_TYPES = [/^[IF]$/, /^[JD]$/, /^(?:L|\[)/, /^Z$/, /^B$/, /^C$/, /^S$/];
const ACC_STATIC = 0x08;
const ACC_VOLATILE = 0x40;

// Static-field access carries the declaring class's initialization authority
// (#8053). A declared <clinit> in the class or any required superclass may
// execute arbitrary code and fail before an sget*/sput* completes. Exactness
// is retained only when that initializer chain is locally proven code-free,
// or when execution is already inside the declaring class's own <clinit>.
function resolveClassInitializationAuthority(image, declaringClass, method) {
  if (!Array.isArray(image.methods)) fail('dex-method-definitions-unavailable');
  const initializersFor = (classType) => {
    const initializers = image.methods.filter((entry) => entry?.classType === classType && entry?.name === '<clinit>');
    if (initializers.length > 1) fail('dex-class-initialization-ambiguous');
    return initializers.length === 1;
  };
  const selfInitializing = method?.classType === declaringClass && method?.name === '<clinit>';
  const clinitPresent = initializersFor(declaringClass);
  if (selfInitializing) {
    return {
      declaringClass,
      clinitPresent,
      initializationRequired: false,
      initializationProven: false,
      discharged: 'declaring-class-initializer',
    };
  }
  if (clinitPresent) {
    return { declaringClass, clinitPresent, initializationRequired: true, initializationProven: false };
  }

  const classes = image.classes ?? [];
  const declaringMatches = classes.filter((entry) => entry?.classType === declaringClass);
  if (declaringMatches.length !== 1) fail('dex-class-initialization-class-ambiguous');
  const seen = new Set([declaringClass]);
  let superType = declaringMatches[0]?.superType ?? null;
  while (superType != null) {
    if (typeof superType !== 'string' || !superType) fail('dex-class-initialization-superclass-invalid');
    if (seen.has(superType)) fail('dex-class-initialization-superclass-cycle');
    seen.add(superType);
    const matches = classes.filter((entry) => entry?.classType === superType);
    if (matches.length > 1) fail('dex-class-initialization-class-ambiguous');
    if (matches.length === 0) {
      return {
        declaringClass,
        clinitPresent: false,
        initializationRequired: true,
        initializationProven: false,
        superclassAuthority: 'unresolved',
      };
    }
    if (initializersFor(superType)) {
      return {
        declaringClass,
        clinitPresent: false,
        initializationRequired: true,
        initializationProven: false,
        superclassInitializationRequired: true,
        superclassInitializerClass: superType,
      };
    }
    superType = matches[0]?.superType ?? null;
  }

  // DEX 037 introduced default interface methods. For those formats, class
  // initialization may need to initialize default-method-bearing
  // superinterfaces before the class completes initialization. This owner
  // does not yet have canonical interface-list/default-method authority on
  // current main, so absence of that metadata cannot prove absence of the
  // trigger. Legacy pre-037 DEX cannot contain default interface methods and
  // therefore retains the existing exact clean-chain control.
  const versionMatch = typeof image.formatVersion === 'string'
    ? /^dex-(\d{3})$/.exec(image.formatVersion)
    : null;
  const dexVersion = versionMatch ? Number(versionMatch[1]) : null;
  if (!Number.isSafeInteger(dexVersion) || dexVersion >= 37) {
    return {
      declaringClass,
      clinitPresent: false,
      initializationRequired: true,
      initializationProven: false,
      superinterfaceAuthority: 'unavailable',
    };
  }

  return { declaringClass, clinitPresent: false, initializationRequired: false, initializationProven: false };
}

function resolveFieldDeclaration(image, field, fieldIndex, isStatic) {
  const owners = (image.classes ?? []).filter((cls) => cls?.classType === field.classType);
  if (owners.length === 0) return null;
  if (owners.length !== 1) fail('dex-field-declaration-ambiguous');
  const owner = owners[0];
  const expected = isStatic ? owner.staticFields : owner.instanceFields;
  const opposite = isStatic ? owner.instanceFields : owner.staticFields;
  if (!Array.isArray(expected) || !Array.isArray(opposite)) return null;
  const matches = expected.filter((entry) => entry?.fieldIdx === fieldIndex);
  const oppositeMatches = opposite.filter((entry) => entry?.fieldIdx === fieldIndex);
  if (matches.length > 1 || oppositeMatches.length > 1 || (matches.length && oppositeMatches.length)) {
    fail('dex-field-declaration-ambiguous');
  }
  if (!matches.length) {
    if (oppositeMatches.length) fail('dex-field-static-instance-mismatch');
    return null;
  }
  const accessFlags = matches[0]?.accessFlags;
  if (!Number.isSafeInteger(accessFlags) || accessFlags < 0) fail('dex-field-access-flags-invalid');
  if (((accessFlags & ACC_STATIC) !== 0) !== isStatic) fail('dex-field-static-instance-mismatch');
  return accessFlags;
}

export function dexFieldEffects({ opcode, formatByte, fieldIndex, image, method }) {
  const isStatic = opcode >= 0x60;
  const relative = opcode - (isStatic ? 0x60 : 0x52);
  const isWrite = relative >= 7, variant = relative % 7;
  const field = image.fields?.[fieldIndex];
  if (!field) fail('dex-reference-index-out-of-range');
  const info = dexTypeInfo(field.type);
  if (!VARIANT_TYPES[variant]?.test(field.type)) fail('dex-field-variant-type-mismatch');
  if (typeof field.name !== 'string' || !field.name || typeof field.classType !== 'string') fail('dex-field-identity-unresolved');
  const valueRegister = isStatic ? formatByte : formatByte & 15;
  const receiverRegister = formatByte >>> 4;
  const valueLocation = { kind:'register', index:valueRegister, bits:info.bits, type:info.type };
  const reads = isStatic ? [] : [{ kind:'register', index:receiverRegister, bits:32,
    type:{kind:'address',widthBits:32,addressSpace:'managed-heap'} }];
  const valueReadIndex = isWrite ? reads.length : null;
  if (isWrite) reads.push(valueLocation);
  const accessFlags = resolveFieldDeclaration(image, field, fieldIndex, isStatic);
  if (accessFlags == null) fail('dex-field-declaration-unresolved');
  const isVolatile = (accessFlags & ACC_VOLATILE) !== 0;
  const fieldIdentity = createManagedFieldId(createManagedTypeId(image.moduleId,field.classType),fieldIndex);
  const classInitialization = isStatic
    ? resolveClassInitializationAuthority(image, field.classType, method)
    : null;
  return {
    mnemonic:`${isStatic ? 's' : 'i'}${isWrite ? 'put' : 'get'}${SUFFIXES[variant]}`,
    locationReads:reads, locationWrites:isWrite ? [] : [valueLocation],
    producedValues:isWrite ? [] : [{ bits:info.byteWidth*8,
      type:info.extension ? {kind:'bitvector',widthBits:info.byteWidth*8} : info.type }],
    memoryEffects:[{ space:isStatic ? 'static-field' : 'field', field:field.name, classType:field.classType,
      fieldIdentity, fieldIndex, descriptor:field.type, isWrite, byteWidth:info.byteWidth,
      valueBits:info.bits, valueType:info.type, extension:info.extension ?? null,
      bindingVersion:1, addressReadIndex:isStatic ? null : 0, valueReadIndex,
      addressKind:isStatic ? 'static-field' : 'instance-field',
      declarationResolved:true, declarationAccessFlags:accessFlags,
      volatility:isVolatile, atomic:isVolatile,
      ordering:isVolatile ? (isWrite ? 'release' : 'acquire') : 'unknown',
      ...(isStatic ? { classInitialization } : {}) }],
    ...(isStatic && classInitialization.initializationRequired ? {
      completeness:'partial',
      unknownEffects:[{ category:'calls', reason:classInitialization.superclassAuthority === 'unresolved'
        ? 'dex-class-initialization-superclass-unresolved'
        : classInitialization.superinterfaceAuthority === 'unavailable'
          ? 'dex-class-initialization-superinterface-authority-unavailable'
          : 'dex-class-initialization-unverified' }],
    } : {}),
  };
}
