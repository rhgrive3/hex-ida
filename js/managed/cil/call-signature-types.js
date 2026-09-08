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

function parseTypeDefOrRef(bytes, offset, code) {
  const parsed = readCompressed(bytes, offset, code);
  const tag = parsed.value & 0x03;
  const rid = parsed.value >>> 2;
  if (tag > 2 || rid < 1) fail(code);
  return { next:parsed.next, encoded:parsed.value };
}

function consumeCustomMods(bytes, offset, code) {
  let pos = offset;
  while (bytes[pos] === 0x1f || bytes[pos] === 0x20) {
    pos = parseTypeDefOrRef(bytes, pos + 1, code).next;
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

function parseType(bytes, offset, code, depth = 0) {
  if (depth > 32 || offset >= bytes.length) fail(code);
  let pos = consumeCustomMods(bytes, offset, code);
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
    const ref = parseTypeDefOrRef(bytes, pos, code);
    return { next:ref.next, value:type === 0x11
      ? stackType('value-type', null, { typeToken:ref.encoded })
      : stackType('object-ref', null, { typeToken:ref.encoded }) };
  }
  if (type === 0x13 || type === 0x1e) { // VAR / MVAR
    const index = readCompressed(bytes, pos, code);
    return { next:index.next, value:stackType(type === 0x13 ? 'type-generic' : 'method-generic', null,
      { genericIndex:index.value }) };
  }
  if (type === 0x0f) { // PTR
    pos = consumeCustomMods(bytes, pos, code);
    if (bytes[pos] === 0x01) pos += 1; // PTR VOID
    else pos = parseType(bytes, pos, code, depth + 1).next;
    return { next:pos, value:stackType('native-int') };
  }
  if (type === 0x1d) { // SZARRAY
    pos = consumeCustomMods(bytes, pos, code);
    pos = parseType(bytes, pos, code, depth + 1).next;
    return { next:pos, value:stackType('object-ref') };
  }
  if (type === 0x14) { // ARRAY
    pos = parseType(bytes, pos, code, depth + 1).next;
    pos = parseArrayShape(bytes, pos, code);
    return { next:pos, value:stackType('object-ref') };
  }
  if (type === 0x15) { // GENERICINST
    const kind = bytes[pos++];
    if (kind !== 0x11 && kind !== 0x12) fail(code);
    const ref = parseTypeDefOrRef(bytes, pos, code);
    pos = ref.next;
    const count = readCompressed(bytes, pos, code);
    pos = count.next;
    for (let i = 0; i < count.value; i++) pos = parseType(bytes, pos, code, depth + 1).next;
    return { next:pos, value:kind === 0x11
      ? stackType('value-type', null, { typeToken:ref.encoded })
      : stackType('object-ref', null, { typeToken:ref.encoded }) };
  }
  if (type === 0x1b) { // FNPTR
    const nested = parseMethodSignature(bytes, pos, code, depth + 1, false);
    return { next:nested.next, value:stackType('native-int') };
  }
  fail(code);
}

function parseReturn(bytes, offset, code, depth) {
  let pos = consumeCustomMods(bytes, offset, code);
  if (bytes[pos] === 0x01) return { next:pos + 1, value:null }; // VOID
  if (bytes[pos] === 0x16) return { next:pos + 1, value:stackType('typed-reference') };
  if (bytes[pos] === 0x10) { // BYREF
    pos = consumeCustomMods(bytes, pos + 1, code);
    const inner = parseType(bytes, pos, code, depth + 1);
    return { next:inner.next, value:stackType('managed-pointer') };
  }
  return parseType(bytes, pos, code, depth + 1);
}

function parseParam(bytes, offset, code, depth) {
  let pos = consumeCustomMods(bytes, offset, code);
  if (bytes[pos] === 0x16) return { next:pos + 1, value:stackType('typed-reference') };
  if (bytes[pos] === 0x10) {
    pos = consumeCustomMods(bytes, pos + 1, code);
    const inner = parseType(bytes, pos, code, depth + 1);
    return { next:inner.next, value:stackType('managed-pointer') };
  }
  return parseType(bytes, pos, code, depth + 1);
}

function parseMethodSignature(bytes, offset, code, depth = 0, requireEnd = true) {
  if (depth > 32 || offset >= bytes.length) fail(code);
  const callConvention = bytes[offset++];
  const kind = callConvention & 0x0f;
  if (![0x00, 0x01, 0x02, 0x03, 0x04, 0x05].includes(kind) || (callConvention & 0x80) !== 0) fail(code);
  const hasThis = (callConvention & 0x20) !== 0;
  const explicitThis = (callConvention & 0x40) !== 0;
  if (explicitThis && !hasThis) fail(code);

  let genericParameterCount = 0;
  if ((callConvention & 0x10) !== 0) {
    const generic = readCompressed(bytes, offset, code);
    genericParameterCount = generic.value;
    offset = generic.next;
  }
  const count = readCompressed(bytes, offset, code);
  const ret = parseReturn(bytes, count.next, code, depth + 1);
  offset = ret.next;
  const parameters = [];
  let sentinelSeen = false;
  for (let i = 0; i < count.value; i++) {
    if (bytes[offset] === 0x41) {
      if (kind !== 0x05 || sentinelSeen) fail(code);
      sentinelSeen = true;
      offset += 1;
    }
    const param = parseParam(bytes, offset, code, depth + 1);
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

export function parseCilMethodSignature(blob) {
  if (!(blob instanceof Uint8Array)) fail('cil-call-signature-blob-required');
  return parseMethodSignature(blob, 0, 'cil-call-signature-invalid').value;
}

export function parseCilMethodSpecInstantiation(blob) {
  const code = 'cil-call-signature-methodspec-invalid';
  if (!(blob instanceof Uint8Array) || blob.length < 2 || blob[0] !== 0x0a) fail(code);
  const count = readCompressed(blob, 1, code);
  if (count.value < 1) fail(code);
  let pos = count.next;
  const args = [];
  for (let i = 0; i < count.value; i++) {
    const arg = parseType(blob, pos, code);
    args.push(arg.value);
    pos = arg.next;
  }
  if (pos !== blob.length) fail(code);
  return Object.freeze(args);
}

export function substituteCilMethodGeneric(value, args) {
  if (!value || typeof value !== 'object' || value.stackType !== 'method-generic') return value;
  const index = value.genericIndex;
  if (!Number.isSafeInteger(index) || index < 0 || index >= args.length) {
    fail('cil-call-signature-methodspec-generic-index-invalid');
  }
  return args[index];
}
