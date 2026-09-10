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

// Custom modifiers are part of the exact type identity (#7706/#7673 R2):
// CMOD_OPT (0x20) / CMOD_REQD (0x1f) followed by a TypeDefOrRef token.
function readCustomMods(bytes, offset, code, typeDefOrRefRowCounts = null) {
  const mods = [];
  let pos = offset;
  while (bytes[pos] === 0x1f || bytes[pos] === 0x20) {
    const ref = parseTypeDefOrRef(bytes, pos + 1, code, typeDefOrRefRowCounts);
    mods.push({ kind: bytes[pos] === 0x1f ? 'required' : 'optional', typeToken: ref.encoded });
    pos = ref.next;
  }
  return { next: pos, mods };
}

function consumeCustomMods(bytes, offset, code, typeDefOrRefRowCounts = null) {
  return readCustomMods(bytes, offset, code, typeDefOrRefRowCounts).next;
}

function parseArrayShape(bytes, offset, code) {
  let parsed = readCompressed(bytes, offset, code);
  const rank = parsed.value;
  if (rank < 1) fail(code);
  parsed = readCompressed(bytes, parsed.next, code);
  const sizeCount = parsed.value;
  if (sizeCount > rank) fail(code);
  const sizes = [];
  let pos = parsed.next;
  for (let i = 0; i < sizeCount; i++) {
    const size = readCompressed(bytes, pos, code);
    sizes.push(size.value);
    pos = size.next;
  }
  parsed = readCompressed(bytes, pos, code);
  const lowerBoundCount = parsed.value;
  if (lowerBoundCount > rank) fail(code);
  const lowerBounds = [];
  pos = parsed.next;
  for (let i = 0; i < lowerBoundCount; i++) {
    const bound = readCompressed(bytes, pos, code);
    lowerBounds.push(bound.value);
    pos = bound.next;
  }
  // The shape is part of the exact array type identity (#7706/#7673 R2).
  return { next:pos, shape:{ rank, sizes, lowerBounds } };
}

function stackType(name, bits = null, extra = {}) {
  return Object.freeze({ stackType:name, ...(bits == null ? {} : { bits }), ...extra });
}

// Attach identity-bearing components at their production level. Modifier
// placement is part of the exact identity (R1): leading modifiers (before
// the Type) and production-local modifiers (between SZARRAY/PTR and the
// element type) are structurally distinct groups, never flattened.
function attachMods(value, leadMods = [], localMods = []) {
  if (!value || (!leadMods.length && !localMods.length)) return value;
  return Object.freeze({
    ...value,
    ...(leadMods.length ? { customModifiers: Object.freeze([...leadMods]) } : {}),
    ...(localMods.length ? { productionCustomModifiers: Object.freeze([...localMods]) } : {}),
  });
}

function parseType(bytes, offset, code, depth = 0, methodGenericArity = null, typeDefOrRefRowCounts = null) {
  if (depth > 32 || offset >= bytes.length) fail(code);
  const lead = readCustomMods(bytes, offset, code, typeDefOrRefRowCounts);
  let pos = lead.next;
  if (pos >= bytes.length) fail(code);
  const type = bytes[pos++];

  if ([0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09].includes(type)) {
    return { next:pos, value:attachMods(stackType('int32', 32), lead.mods) };
  }
  if (type === 0x0a || type === 0x0b) return { next:pos, value:attachMods(stackType('int64', 64), lead.mods) };
  if (type === 0x0c || type === 0x0d) return { next:pos, value:attachMods(stackType('float'), lead.mods) };
  if (type === 0x0e || type === 0x1c) return { next:pos, value:attachMods(stackType('object-ref'), lead.mods) };
  if (type === 0x18 || type === 0x19) return { next:pos, value:attachMods(stackType('native-int'), lead.mods) };

  if (type === 0x11 || type === 0x12) { // VALUETYPE / CLASS
    const ref = parseTypeDefOrRef(bytes, pos, code, typeDefOrRefRowCounts);
    return { next:ref.next, value:attachMods(type === 0x11
      ? stackType('value-type', null, { typeToken:ref.encoded })
      : stackType('object-ref', null, { typeToken:ref.encoded }), lead.mods) };
  }
  if (type === 0x13 || type === 0x1e) { // VAR / MVAR
    const index = readCompressed(bytes, pos, code);
    if (type === 0x1e && methodGenericArity !== null && index.value >= methodGenericArity) fail(code);
    return { next:index.next, value:attachMods(stackType(type === 0x13 ? 'type-generic' : 'method-generic', null,
      { genericIndex:index.value }), lead.mods) };
  }
  if (type === 0x0f) { // PTR
    const pre = readCustomMods(bytes, pos, code, typeDefOrRefRowCounts);
    if (bytes[pre.next] === 0x01) { // PTR VOID — void is still a distinct pointee
      return { next:pre.next + 1, value:attachMods(stackType('native-int', null, { pointee:{ stackType:'void' } }), lead.mods, pre.mods) };
    }
    const pointee = parseType(bytes, pre.next, code, depth + 1, methodGenericArity, typeDefOrRefRowCounts);
    return { next:pointee.next, value:attachMods(stackType('native-int', null, { pointee:pointee.value }), lead.mods, pre.mods) };
  }
  if (type === 0x1d) { // SZARRAY
    const pre = readCustomMods(bytes, pos, code, typeDefOrRefRowCounts);
    const element = parseType(bytes, pre.next, code, depth + 1, methodGenericArity, typeDefOrRefRowCounts);
    // Array element identity is part of the exact type (#7706): int32[] and
    // int64[] are different constructed array types, not the same object-ref.
    return { next:element.next, value:attachMods(stackType('object-ref', null,
      { arrayShape:{ rank:1, sizes:[], lowerBounds:[] }, elementType:element.value }), lead.mods, pre.mods) };
  }
  if (type === 0x14) { // ARRAY
    const element = parseType(bytes, pos, code, depth + 1, methodGenericArity, typeDefOrRefRowCounts);
    const shape = parseArrayShape(bytes, element.next, code);
    return { next:shape.next, value:attachMods(stackType('object-ref', null,
      { arrayShape:shape.shape, elementType:element.value }), lead.mods) };
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
    return { next:pos, value:attachMods(kind === 0x11
      ? stackType('value-type', null, { typeToken:ref.encoded, genericArgs })
      : stackType('object-ref', null, { typeToken:ref.encoded, genericArgs }), lead.mods) };
  }
  if (type === 0x1b) { // FNPTR
    const nested = parseMethodSignature(bytes, pos, code, depth + 1, false, methodGenericArity, typeDefOrRefRowCounts);
    // The nested method signature is identity-bearing (#7673 R2): fnptr
    // types differ by their exact signature, not just "native-int".
    return { next:nested.next, value:attachMods(stackType('native-int', null,
      { signature:nested.value }), lead.mods) };
  }
  fail(code);
}

function parseReturn(bytes, offset, code, depth, methodGenericArity, typeDefOrRefRowCounts) {
  const lead = readCustomMods(bytes, offset, code, typeDefOrRefRowCounts);
  const pos = lead.next;
  if (bytes[pos] === 0x01) return { next:pos + 1, value:null }; // VOID
  if (bytes[pos] === 0x16) return { next:pos + 1, value:attachMods(stackType('typed-reference'), lead.mods) };
  if (bytes[pos] === 0x10) { // BYREF
    const pre = readCustomMods(bytes, pos + 1, code, typeDefOrRefRowCounts);
    const inner = parseType(bytes, pre.next, code, depth + 1, methodGenericArity, typeDefOrRefRowCounts);
    // Placement stays distinct (R1): lead mods precede the BYREF production;
    // mods between BYREF and the Type are BYREF-production-local.
    return { next:inner.next, value:attachMods(stackType('managed-pointer', null,
      { pointee:inner.value }), lead.mods, pre.mods) };
  }
  const inner = parseType(bytes, pos, code, depth + 1, methodGenericArity, typeDefOrRefRowCounts);
  return { next:inner.next, value:attachMods(inner.value, lead.mods) };
}

function parseParam(bytes, offset, code, depth, methodGenericArity, typeDefOrRefRowCounts) {
  const lead = readCustomMods(bytes, offset, code, typeDefOrRefRowCounts);
  const pos = lead.next;
  if (bytes[pos] === 0x16) return { next:pos + 1, value:attachMods(stackType('typed-reference'), lead.mods) };
  if (bytes[pos] === 0x10) {
    const pre = readCustomMods(bytes, pos + 1, code, typeDefOrRefRowCounts);
    const inner = parseType(bytes, pre.next, code, depth + 1, methodGenericArity, typeDefOrRefRowCounts);
    // Same placement semantics as the BYREF return production (R1).
    return { next:inner.next, value:attachMods(stackType('managed-pointer', null,
      { pointee:inner.value }), lead.mods, pre.mods) };
  }
  const inner = parseType(bytes, pos, code, depth + 1, methodGenericArity, typeDefOrRefRowCounts);
  return { next:inner.next, value:attachMods(inner.value, lead.mods) };
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

// ECMA-335 II.23.2.5 PropertySig: PROPERTY [HASTHIS] ParamCount Type Param*.
// Reuse the canonical Type/Param grammar so modifiers and TypeDefOrRef bounds
// stay identical to method-signature handling.
export function parseCilPropertySignature(blob, typeDefOrRefRowCounts = null) {
  const code = 'cil-property-signature-invalid';
  if (!(blob instanceof Uint8Array) || blob.length < 3) fail(code);
  let pos = 0;
  const callConvention = blob[pos++];
  if ((callConvention & 0x0f) !== 0x08 || (callConvention & ~0x28) !== 0) fail(code);
  const hasThis = (callConvention & 0x20) !== 0;
  const count = readCompressed(blob, pos, code);
  pos = count.next;
  const property = parseType(blob, pos, code, 0, 0, typeDefOrRefRowCounts);
  pos = property.next;
  const parameters = [];
  for (let i = 0; i < count.value; i++) {
    const parameter = parseParam(blob, pos, code, 0, 0, typeDefOrRefRowCounts);
    parameters.push(parameter.value);
    pos = parameter.next;
  }
  if (pos !== blob.length) fail(code);
  return Object.freeze({ callConvention, hasThis, propertyType:property.value, parameters:Object.freeze(parameters) });
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

export function parseCilMethodSpecInstantiation(blob, typeDefOrRefRowCounts = null) {
  const code = 'cil-call-signature-methodspec-invalid';
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

// Structural substitution (#7810): a method generic can appear at any nested
// identity position of the base signature — a PTR pointee, a BYREF referent,
// an array/SZARRAY element, a GENERICINST argument, or a nested FNPTR
// signature — not only at the top level. Substituting only top-level values
// would let a MethodSpec instantiation publish an unresolved generic as an
// exact pointee/element identity.
export function substituteCilMethodGeneric(value, args) {
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((entry) => {
      const substituted = substituteCilMethodGeneric(entry, args);
      if (substituted !== entry) changed = true;
      return substituted;
    });
    return changed ? Object.freeze(mapped) : value;
  }
  if (!value || typeof value !== 'object') return value;
  if (value.stackType === 'method-generic') {
    const index = value.genericIndex;
    if (!Number.isSafeInteger(index) || index < 0 || index >= args.length) {
      fail('cil-call-signature-methodspec-generic-index-invalid');
    }
    return args[index];
  }
  let changed = false;
  const out = {};
  for (const key of Object.keys(value)) {
    const entry = value[key];
    const substituted = substituteCilMethodGeneric(entry, args);
    if (substituted !== entry) changed = true;
    out[key] = substituted;
  }
  return changed ? Object.freeze(out) : value;
}
