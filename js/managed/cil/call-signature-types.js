function fail(code) { throw new TypeError(code); }

function readCompressed(bytes, offset, code) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) fail(code);
  const b0 = bytes[offset];
  if ((b0 & 0x80) === 0) return { value:b0, next:offset + 1 };
  if ((b0 & 0xc0) === 0x80) {
    if (offset + 1 >= bytes.length) fail(code);
    const value = ((b0 & 0x3f) << 8) | bytes[offset + 1];
    if (value < 0x80) fail(code);
    return { value, next:offset + 2 };
  }
  if ((b0 & 0xe0) === 0xc0) {
    if (offset + 3 >= bytes.length) fail(code);
    const value = ((b0 & 0x1f) * 0x1000000) + (bytes[offset + 1] << 16)
      + (bytes[offset + 2] << 8) + bytes[offset + 3];
    if (value < 0x4000) fail(code);
    return { value, next:offset + 4 };
  }
  fail(code);
}

function parseTypeDefOrRef(bytes, offset, code, typeDefOrRefRowCounts = null) {
  const parsed = readCompressed(bytes, offset, code);
  const tag = parsed.value & 0x03;
  const rid = parsed.value >>> 2;
  if (tag > 2 || rid < 1) fail(code);
  if (typeDefOrRefRowCounts !== null) {
    if (!Array.isArray(typeDefOrRefRowCounts) || typeDefOrRefRowCounts.length !== 3) fail(code);
    const rowCount = typeDefOrRefRowCounts[tag];
    if (!Number.isSafeInteger(rowCount) || rowCount < 0 || rid > rowCount) fail(code);
  }
  return { next:parsed.next, encoded:parsed.value };
}

function consumeCustomMods(bytes, offset, code, typeDefOrRefRowCounts = null) {
  let pos = offset;
  while (bytes[pos] === 0x1f || bytes[pos] === 0x20) {
    pos = parseTypeDefOrRef(bytes, pos + 1, code, typeDefOrRefRowCounts).next;
  }
  return pos;
}

function parseArrayShape(bytes, offset, code) {
  let parsed = readCompressed(bytes, offset, code);
  const rank = parsed.value;
  if (rank < 1) fail(code);
  parsed = readCompressed(bytes, parsed.next, code);
  const sizes = parsed.value;
  if (sizes > rank) fail(code);
  let pos = parsed.next;
  for (let i = 0; i < sizes; i++) pos = readCompressed(bytes, pos, code).next;
  parsed = readCompressed(bytes, pos, code);
  const lowerBounds = parsed.value;
  if (lowerBounds > rank) fail(code);
  pos = parsed.next;
  for (let i = 0; i < lowerBounds; i++) pos = readCompressed(bytes, pos, code).next;
  return pos;
}

function stackType(name, bits = null, extra = {}) {
  return Object.freeze({ stackType:name, ...(bits == null ? {} : { bits }), ...extra });
}

function parseType(bytes, offset, code, depth = 0, methodGenericArity = null, typeDefOrRefRowCounts = null) {
  if (depth > 32 || offset >= bytes.length) fail(code);
  let pos = consumeCustomMods(bytes, offset, code, typeDefOrRefRowCounts);
  if (pos >= bytes.length) fail(code);
  const type = bytes[pos++];

  if ([0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09].includes(type)) {
    return { next:pos, value:stackType('int32', 32) };
  }
  if (type === 0x0a || type === 0x0b) return { next:pos, value:stackType('int64', 64) };
  if (type === 0x0c || type === 0x0d) return { next:pos, value:stackType('float') };
  if (type === 0x0e || type === 0x1c) return { next:pos, value:stackType('object-ref') };
  if (type === 0x18 || type === 0x19) return { next:pos, value:stackType('native-int') };

  if (type === 0x11 || type === 0x12) { // VALUETYPE / CLASS
    const ref = parseTypeDefOrRef(bytes, pos, code, typeDefOrRefRowCounts);
    return { next:ref.next, value:type === 0x11
      ? stackType('value-type', null, { typeToken:ref.encoded })
      : stackType('object-ref', null, { typeToken:ref.encoded }) };
  }
  if (type === 0x13 || type === 0x1e) { // VAR / MVAR
    const index = readCompressed(bytes, pos, code);
    if (type === 0x1e && methodGenericArity !== null && index.value >= methodGenericArity) fail(code);
    return { next:index.next, value:stackType(type === 0x13 ? 'type-generic' : 'method-generic', null,
      { genericIndex:index.value }) };
  }
  if (type === 0x0f) { // PTR
    pos = consumeCustomMods(bytes, pos, code, typeDefOrRefRowCounts);
    if (bytes[pos] === 0x01) pos += 1; // PTR VOID
    else pos = parseType(bytes, pos, code, depth + 1, methodGenericArity, typeDefOrRefRowCounts).next;
    return { next:pos, value:stackType('native-int') };
  }
  if (type === 0x1d) { // SZARRAY
    pos = consumeCustomMods(bytes, pos, code, typeDefOrRefRowCounts);
    pos = parseType(bytes, pos, code, depth + 1, methodGenericArity, typeDefOrRefRowCounts).next;
    return { next:pos, value:stackType('object-ref') };
  }
  if (type === 0x14) { // ARRAY
    pos = parseType(bytes, pos, code, depth + 1, methodGenericArity, typeDefOrRefRowCounts).next;
    pos = parseArrayShape(bytes, pos, code);
    return { next:pos, value:stackType('object-ref') };
  }
  if (type === 0x15) { // GENERICINST
    const kind = bytes[pos++];
    if (kind !== 0x11 && kind !== 0x12) fail(code);
    const ref = parseTypeDefOrRef(bytes, pos, code, typeDefOrRefRowCounts);
    pos = ref.next;
    const count = readCompressed(bytes, pos, code);
    pos = count.next;
    const genericArgs = [];
    for (let i = 0; i < count.value; i++) {
      const arg = parseType(bytes, pos, code, depth + 1, methodGenericArity, typeDefOrRefRowCounts);
      genericArgs.push(arg.value);
      pos = arg.next;
    }
    return { next:pos, value:kind === 0x11
      ? stackType('value-type', null, { typeToken:ref.encoded, genericArgs })
      : stackType('object-ref', null, { typeToken:ref.encoded, genericArgs }) };
  }
  if (type === 0x1b) { // FNPTR
    const nested = parseMethodSignature(bytes, pos, code, depth + 1, false, methodGenericArity, typeDefOrRefRowCounts);
    return { next:nested.next, value:stackType('native-int') };
  }
  fail(code);
}

function parseReturn(bytes, offset, code, depth, methodGenericArity, typeDefOrRefRowCounts) {
  let pos = consumeCustomMods(bytes, offset, code, typeDefOrRefRowCounts);
  if (bytes[pos] === 0x01) return { next:pos + 1, value:null }; // VOID
  if (bytes[pos] === 0x16) return { next:pos + 1, value:stackType('typed-reference') };
  if (bytes[pos] === 0x10) { // BYREF
    pos = consumeCustomMods(bytes, pos + 1, code, typeDefOrRefRowCounts);
    const inner = parseType(bytes, pos, code, depth + 1, methodGenericArity, typeDefOrRefRowCounts);
    // ECMA-335 II.23.2.10: BYREF is a paired type. Dropping `inner.value`
    // collapsed int32&/int64& into one exact managed-pointer identity (#7750),
    // so the referent is carried losslessly on the stack type.
    return { next:inner.next, value:stackType('managed-pointer', null, { referent:inner.value }) };
  }
  return parseType(bytes, pos, code, depth + 1, methodGenericArity, typeDefOrRefRowCounts);
}

function parseParam(bytes, offset, code, depth, methodGenericArity, typeDefOrRefRowCounts) {
  let pos = consumeCustomMods(bytes, offset, code, typeDefOrRefRowCounts);
  if (bytes[pos] === 0x16) return { next:pos + 1, value:stackType('typed-reference') };
  if (bytes[pos] === 0x10) { // BYREF
    pos = consumeCustomMods(bytes, pos + 1, code, typeDefOrRefRowCounts);
    const inner = parseType(bytes, pos, code, depth + 1, methodGenericArity, typeDefOrRefRowCounts);
    // Same referent-retention contract as the return path (#7750).
    return { next:inner.next, value:stackType('managed-pointer', null, { referent:inner.value }) };
  }
  return parseType(bytes, pos, code, depth + 1, methodGenericArity, typeDefOrRefRowCounts);
}

function parseMethodSignature(bytes, offset, code, depth = 0, requireEnd = true, inheritedMethodGenericArity = null,
  typeDefOrRefRowCounts = null) {
  if (depth > 32 || offset >= bytes.length) fail(code);
  const callConvention = bytes[offset++];
  const kind = callConvention & 0x0f;
  if (![0x00, 0x01, 0x02, 0x03, 0x04, 0x05].includes(kind) || (callConvention & 0x80) !== 0) fail(code);
  const hasThis = (callConvention & 0x20) !== 0;
  const explicitThis = (callConvention & 0x40) !== 0;
  if (explicitThis && !hasThis) fail(code);

  let genericParameterCount = 0;
  const declaresMethodGenerics = (callConvention & 0x10) !== 0;
  if (declaresMethodGenerics) {
    const generic = readCompressed(bytes, offset, code);
    genericParameterCount = generic.value;
    offset = generic.next;
  }
  const methodGenericArity = declaresMethodGenerics ? genericParameterCount : inheritedMethodGenericArity;
  const count = readCompressed(bytes, offset, code);
  const ret = parseReturn(bytes, count.next, code, depth + 1, methodGenericArity, typeDefOrRefRowCounts);
  offset = ret.next;
  const parameters = [];
  let sentinelSeen = false;
  for (let i = 0; i < count.value; i++) {
    if (bytes[offset] === 0x41) {
      if (kind !== 0x05 || sentinelSeen) fail(code);
      sentinelSeen = true;
      offset += 1;
    }
    const param = parseParam(bytes, offset, code, depth + 1, methodGenericArity, typeDefOrRefRowCounts);
    parameters.push(param.value);
    offset = param.next;
  }
  if (requireEnd && offset !== bytes.length) fail(code);
  return {
    next:offset,
    value:Object.freeze({
      callConvention,
      kind,
      hasThis,
      explicitThis,
      genericParameterCount,
      parameters:Object.freeze(parameters),
      returnValue:ret.value,
    }),
  };
}

export function parseCilMethodSignature(blob, typeDefOrRefRowCounts = null) {
  if (!(blob instanceof Uint8Array)) fail('cil-call-signature-blob-required');
  return parseMethodSignature(blob, 0, 'cil-call-signature-invalid', 0, true, 0, typeDefOrRefRowCounts).value;
}

// ECMA-335 II.23.2.6 LocalVarSig: 0x07 Count T* where each T may carry
// custom modifiers, the PINNED modifier, and a BYREF pair. The lifter needs
// the typed locals as a stack-type array so ldloc/stloc stop publishing a
// fabricated 32-bit width (#5353).
export function parseCilLocalVarSignature(blob, typeDefOrRefRowCounts = null) {
  const code = 'cil-local-var-signature-invalid';
  if (!(blob instanceof Uint8Array) || blob.length < 2 || blob[0] !== 0x07) fail(code);
  const count = readCompressed(blob, 1, code);
  if (count.value < 1 || count.value > 0xfffe) fail(code);
  let pos = count.next;
  const locals = [];
  for (let index = 0; index < count.value; index++) {
    pos = consumeCustomMods(blob, pos, code, typeDefOrRefRowCounts);
    while (blob[pos] === 0x45) { // PINNED
      pos += 1;
      pos = consumeCustomMods(blob, pos, code, typeDefOrRefRowCounts);
    }
    if (blob[pos] === 0x16) { // TYPEDBYREF
      locals.push(stackType('typed-reference'));
      pos += 1;
      continue;
    }
    if (blob[pos] === 0x10) { // BYREF
      pos = consumeCustomMods(blob, pos + 1, code, typeDefOrRefRowCounts);
      const inner = parseType(blob, pos, code, 1, null, typeDefOrRefRowCounts);
      pos = inner.next;
      locals.push(stackType('managed-pointer', null, { referent:inner.value }));
      continue;
    }
    const parsed = parseType(blob, pos, code, 1, null, typeDefOrRefRowCounts);
    pos = parsed.next;
    locals.push(parsed.value);
  }
  if (pos !== blob.length) fail(code);
  return Object.freeze(locals);
}

export function parseCilMethodSpecInstantiation(blob, typeDefOrRefRowCounts = null) {  const code = 'cil-call-signature-methodspec-invalid';
  if (!(blob instanceof Uint8Array) || blob.length < 2 || blob[0] !== 0x0a) fail(code);
  const count = readCompressed(blob, 1, code);
  if (count.value < 1) fail(code);
  let pos = count.next;
  const args = [];
  for (let i = 0; i < count.value; i++) {
    const arg = parseType(blob, pos, code, 0, null, typeDefOrRefRowCounts);
    args.push(arg.value);
    pos = arg.next;
  }
  if (pos !== blob.length) fail(code);
  return Object.freeze(args);
}

// TypeSpec.Signature is a bare Type production (ECMA-335 II.23.2.12/II.23.2.14):
// custom modifiers, CLASS/VALUETYPE, GENERICINST, SZARRAY, ARRAY, PTR, VAR/MVAR,
// FNPTR. The whole blob must be one Type; anything unrepresentable is the
// caller's signal to retain the raw blob authority instead of an exact decode.
export function parseCilTypeSpecSignature(blob, typeDefOrRefRowCounts = null) {
  const code = 'cil-type-spec-signature-invalid';
  if (!(blob instanceof Uint8Array) || blob.length === 0) fail(code);
  const parsed = parseType(blob, 0, code, 0, null, typeDefOrRefRowCounts);
  if (parsed.next !== blob.length) fail(code);
  return Object.freeze(parsed.value);
}

export function substituteCilMethodGeneric(value, args) {
  if (!value || typeof value !== 'object') return value;
  if (value.stackType !== 'method-generic' && value.stackType !== 'managed-pointer') return value;
  if (value.stackType === 'managed-pointer') {
    // A BYREF referent may itself be a method generic; substitution must walk
    // the pair or the MethodSpec would re-collapse distinct instantiations (#7750).
    if (!value.referent) return value;
    const referent = substituteCilMethodGeneric(value.referent, args);
    if (referent === value.referent) return value;
    return { ...value, referent };
  }
  const index = value.genericIndex;
  if (!Number.isSafeInteger(index) || index < 0 || index >= args.length) {
    fail('cil-call-signature-methodspec-generic-index-invalid');
  }
  return args[index];
}
