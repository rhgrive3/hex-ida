function asNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseDescriptorType(text, start, { allowVoid = false } = {}) {
  if (typeof text !== 'string' || start >= text.length) return null;
  const ch = text[start];
  if (allowVoid && ch === 'V') return { kind: 'void', slots: 0, next: start + 1 };
  if ('BCSZI'.includes(ch)) return { kind: 'int', slots: 1, next: start + 1 };
  if (ch === 'F') return { kind: 'float', slots: 1, next: start + 1 };
  if (ch === 'J') return { kind: 'long', slots: 2, next: start + 1 };
  if (ch === 'D') return { kind: 'double', slots: 2, next: start + 1 };
  if (ch === 'L') {
    const end = text.indexOf(';', start + 1);
    if (end <= start + 1) return null;
    return { kind: 'ref', slots: 1, next: end + 1 };
  }
  if (ch === '[') {
    let pos = start;
    let dimensions = 0;
    while (text[pos] === '[') {
      dimensions++;
      pos++;
      if (dimensions > 255) return null;
    }
    const component = parseDescriptorType(text, pos);
    if (!component || component.kind === 'void') return null;
    return { kind: 'ref', slots: 1, next: component.next };
  }
  return null;
}

function parseMethodDescriptor(text, isStatic) {
  if (typeof text !== 'string' || text[0] !== '(') return null;
  const parameters = [];
  let pos = 1;
  while (pos < text.length && text[pos] !== ')') {
    const type = parseDescriptorType(text, pos);
    if (!type) return null;
    parameters.push(type);
    pos = type.next;
  }
  if (text[pos] !== ')') return null;
  const returns = parseDescriptorType(text, pos + 1, { allowVoid: true });
  if (!returns || returns.next !== text.length) return null;

  const locals = [];
  let slot = 0;
  if (!isStatic) locals[slot++] = 'ref';
  for (const parameter of parameters) {
    locals[slot++] = parameter.kind;
    if (parameter.slots === 2) locals[slot++] = 'cat2-tail';
  }
  return { returns, initialLocals: locals, parameterSlots: slot };
}

function stackSlots(stack) {
  let slots = 0;
  for (const value of stack) slots += value === 'long' || value === 'double' || value === 'unknown2' || value === 'top2' ? 2 : 1;
  return slots;
}

function cloneState(state) {
  return { stack: [...state.stack], locals: [...state.locals] };
}

function statesEqual(a, b) {
  if (!a || !b || a.stack.length !== b.stack.length || a.locals.length !== b.locals.length) return false;
  for (let i = 0; i < a.stack.length; i++) if (a.stack[i] !== b.stack[i]) return false;
  for (let i = 0; i < a.locals.length; i++) if ((a.locals[i] ?? null) !== (b.locals[i] ?? null)) return false;
  return true;
}

function stackCategory(kind) {
  if (kind === 'long' || kind === 'double' || kind === 'unknown2' || kind === 'top2') return 2;
  if (kind == null || kind === 'cat2-tail') return null;
  return 1;
}

function mergeStackKind(left, right) {
  if (left === right) return { compatible: true, kind: left };
  const leftCategory = stackCategory(left);
  const rightCategory = stackCategory(right);
  if (leftCategory == null || rightCategory == null || leftCategory !== rightCategory) {
    return { compatible: false, kind: null };
  }
  const joinedTop = leftCategory === 2 ? 'top2' : 'top1';
  if (left === joinedTop || right === joinedTop) return { compatible: true, kind: joinedTop };
  const unknown = leftCategory === 2 ? 'unknown2' : 'unknown1';
  if (left === unknown || right === unknown) return { compatible: true, kind: joinedTop };
  return { compatible: false, kind: null };
}

function normalizeCategory2Locals(locals) {
  for (let i = 0; i < locals.length; i++) {
    const kind = locals[i];
    if (kind === 'long' || kind === 'double') {
      if (locals[i + 1] !== 'cat2-tail') locals[i] = null;
    } else if (kind === 'cat2-tail') {
      const head = i > 0 ? locals[i - 1] : null;
      if (head !== 'long' && head !== 'double') locals[i] = null;
    }
  }
}

function mergeStates(previous, incoming) {
  if (!previous || !incoming || previous.stack.length !== incoming.stack.length || previous.locals.length !== incoming.locals.length) {
    return { compatible: false, changed: false, state: previous };
  }

  const stack = [];
  for (let i = 0; i < previous.stack.length; i++) {
    const merged = mergeStackKind(previous.stack[i], incoming.stack[i]);
    if (!merged.compatible) return { compatible: false, changed: false, state: previous };
    stack.push(merged.kind);
  }

  const locals = previous.locals.map((kind, index) => kind === incoming.locals[index] ? kind : null);
  normalizeCategory2Locals(locals);
  const state = { stack, locals };
  return { compatible: true, changed: !statesEqual(previous, state), state };
}

function popKind(state, expected, errors, offset) {
  const actual = state.stack.pop();
  if (actual == null) {
    errors.push({ code: 'jvm-stack-underflow', offset, expected });
    return false;
  }
  const compatibleUnknown = (actual === 'unknown1' && expected && !['long', 'double'].includes(expected))
    || (actual === 'unknown2' && (expected === 'long' || expected === 'double'));
  if (expected && actual !== expected && !compatibleUnknown) {
    errors.push({ code: 'jvm-stack-type-mismatch', offset, expected, actual });
    return false;
  }
  return true;
}

function setLocal(state, index, kind, slots) {
  if (state.locals[index] === 'cat2-tail' && index > 0) state.locals[index - 1] = null;
  if (state.locals[index + 1] === 'cat2-tail') state.locals[index + 1] = null;
  if (slots === 2 && state.locals[index + 1] && state.locals[index + 2] === 'cat2-tail') state.locals[index + 2] = null;
  state.locals[index] = kind;
  if (slots === 2) state.locals[index + 1] = 'cat2-tail';
}

function readLocal(state, index, kind, slots, errors, offset) {
  const actual = state.locals[index] ?? null;
  if (actual !== kind || (slots === 2 && state.locals[index + 1] !== 'cat2-tail')) {
    errors.push({ code: 'jvm-local-type-mismatch', offset, index, expected: kind, actual });
    return false;
  }
  return true;
}

function cpIndexFor(bundle) {
  const opcode = bundle.opcode;
  if (opcode === 0x12 || opcode === 0x13 || opcode === 0x14)
    return bundle.producedValues?.find((value) => value?.cpIndex != null)?.cpIndex ?? null;
  if (opcode >= 0xb2 && opcode <= 0xb5)
    return bundle.memoryEffects?.find((effect) => effect?.cpIndex != null)?.cpIndex ?? null;
  if (opcode >= 0xb6 && opcode <= 0xb9)
    return bundle.callEffects?.find((effect) => effect?.cpIndex != null)?.cpIndex ?? null;
  if (opcode === 0xbb)
    return bundle.producedValues?.find((value) => value?.cpClassIndex != null)?.cpClassIndex ?? null;
  return null;
}

function validateConstantPoolOperand(bundle, image, classMajor, errors, unsupported) {
  const opcode = bundle.opcode;
  const cpIndex = cpIndexFor(bundle);
  if (cpIndex == null) {
    if ([0xc0, 0xc1].includes(opcode)) unsupported.add(`cp-operand-not-published:${bundle.bytecodeOffset}`);
    return;
  }
  if (!image?.constantPool) {
    unsupported.add(`cp-validation-context-missing:${bundle.bytecodeOffset}`);
    return;
  }
  if (!Number.isInteger(cpIndex) || cpIndex <= 0 || cpIndex >= image.constantPool.length) {
    errors.push({ code: 'jvm-invalid-cp-operand-index', offset: bundle.bytecodeOffset, cpIndex });
    return;
  }
  const tag = image.constantPool[cpIndex]?.tag ?? null;
  let allowed = null;
  if (opcode === 0x12 || opcode === 0x13) allowed = new Set([3, 4, 7, 8, 15, 16, 17]);
  else if (opcode === 0x14) allowed = new Set([5, 6, 17]);
  else if (opcode >= 0xb2 && opcode <= 0xb5) allowed = new Set([9]);
  else if (opcode === 0xb6) allowed = new Set([10]);
  else if (opcode === 0xb9) allowed = new Set([11]);
  else if (opcode === 0xb7 || opcode === 0xb8) allowed = new Set(classMajor >= 52 ? [10, 11] : [10]);
  else if (opcode === 0xbb) allowed = new Set([7]);
  if (allowed && !allowed.has(tag)) {
    errors.push({ code: 'jvm-invalid-cp-operand-tag', offset: bundle.bytecodeOffset, cpIndex, tag });
  }
  if (tag === 17) unsupported.add(`dynamic-constant-verification:${bundle.bytecodeOffset}`);
}

function executeBundle(bundle, state, descriptor, errors, unsupported) {
  const opcode = bundle.opcode;
  const offset = bundle.bytecodeOffset;
  const push = (kind) => state.stack.push(kind);
  const unaryLocal = (base, kind, slots) => {
    const index = opcode - base;
    if (readLocal(state, index, kind, slots, errors, offset)) push(kind);
  };

  if (bundle.completeness !== 'exact' && bundle.completeness !== 'exact-with-intrinsic') {
    unsupported.add(`semantic-effect-${bundle.completeness}:${offset}`);
    return false;
  }

  switch (opcode) {
    case 0x00: return true;
    case 0x01: push('ref'); return true;
    case 0x02: case 0x03: case 0x04: case 0x05: case 0x06: case 0x07: case 0x08:
    case 0x10: case 0x11: push('int'); return true;
    case 0x09: case 0x0a: push('long'); return true;
    case 0x12: case 0x13: push('unknown1'); unsupported.add(`ldc-type-resolution:${offset}`); return true;
    case 0x14: push('unknown2'); unsupported.add(`ldc2-type-resolution:${offset}`); return true;
    case 0x15: case 0x16: case 0x17: case 0x18: case 0x19: {
      const index = bundle.locationReads?.find((entry) => entry?.kind === 'local')?.index;
      const kind = opcode === 0x15 ? 'int' : opcode === 0x16 ? 'long' : opcode === 0x17 ? 'float' : opcode === 0x18 ? 'double' : 'ref';
      const slots = kind === 'long' || kind === 'double' ? 2 : 1;
      if (readLocal(state, index, kind, slots, errors, offset)) push(kind);
      return true;
    }
    case 0x1a: case 0x1b: case 0x1c: case 0x1d: unaryLocal(0x1a, 'int', 1); return true;
    case 0x1e: case 0x1f: case 0x20: case 0x21: unaryLocal(0x1e, 'long', 2); return true;
    case 0x22: case 0x23: case 0x24: case 0x25: unaryLocal(0x22, 'float', 1); return true;
    case 0x26: case 0x27: case 0x28: case 0x29: unaryLocal(0x26, 'double', 2); return true;
    case 0x2a: case 0x2b: case 0x2c: case 0x2d: unaryLocal(0x2a, 'ref', 1); return true;
    case 0x36: case 0x37: case 0x38: case 0x39: case 0x3a: {
      const index = bundle.locationWrites?.find((entry) => entry?.kind === 'local')?.index;
      const kind = opcode === 0x36 ? 'int' : opcode === 0x37 ? 'long' : opcode === 0x38 ? 'float' : opcode === 0x39 ? 'double' : 'ref';
      const slots = kind === 'long' || kind === 'double' ? 2 : 1;
      if (popKind(state, kind, errors, offset)) setLocal(state, index, kind, slots);
      return true;
    }
    case 0x3b: case 0x3c: case 0x3d: case 0x3e:
    case 0x3f: case 0x40: case 0x41: case 0x42:
    case 0x43: case 0x44: case 0x45: case 0x46:
    case 0x47: case 0x48: case 0x49: case 0x4a:
    case 0x4b: case 0x4c: case 0x4d: case 0x4e: {
      const family = opcode < 0x3f ? [0x3b, 'int', 1] : opcode < 0x43 ? [0x3f, 'long', 2] : opcode < 0x47 ? [0x43, 'float', 1] : opcode < 0x4b ? [0x47, 'double', 2] : [0x4b, 'ref', 1];
      const index = opcode - family[0];
      if (popKind(state, family[1], errors, offset)) setLocal(state, index, family[1], family[2]);
      return true;
    }
    case 0x57: {
      const top = state.stack[state.stack.length - 1];
      if (top === 'long' || top === 'double' || top === 'unknown2' || top === 'top2') errors.push({ code: 'jvm-pop-category2-invalid', offset });
      else popKind(state, null, errors, offset);
      return true;
    }
    case 0x58: {
      const top = state.stack.pop();
      if (top == null) errors.push({ code: 'jvm-stack-underflow', offset, expected: 'category2-or-two-category1' });
      else if (top !== 'long' && top !== 'double' && top !== 'unknown2' && top !== 'top2') {
        const next = state.stack.pop();
        if (next == null || next === 'long' || next === 'double' || next === 'unknown2' || next === 'top2') errors.push({ code: 'jvm-pop2-shape-invalid', offset });
      }
      return true;
    }
    case 0x59: {
      const top = state.stack[state.stack.length - 1];
      if (top == null) errors.push({ code: 'jvm-stack-underflow', offset, expected: 'category1' });
      else if (top === 'long' || top === 'double' || top === 'unknown2' || top === 'top2') errors.push({ code: 'jvm-dup-category2-invalid', offset });
      else push(top);
      return true;
    }
    case 0x60: case 0x64: case 0x68: case 0x6c: case 0x70:
    case 0x78: case 0x7a: case 0x7c: case 0x7e: case 0x80: case 0x82:
      popKind(state, 'int', errors, offset); popKind(state, 'int', errors, offset); push('int'); return true;
    case 0x84: {
      const index = bundle.locationReads?.find((entry) => entry?.kind === 'local')?.index;
      readLocal(state, index, 'int', 1, errors, offset); return true;
    }
    case 0x99: case 0x9a: case 0x9b: case 0x9c: case 0x9d: case 0x9e:
      popKind(state, 'int', errors, offset); return true;
    case 0x9f: case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4:
      popKind(state, 'int', errors, offset); popKind(state, 'int', errors, offset); return true;
    case 0xa7: return true;
    case 0xac: popKind(state, 'int', errors, offset); if (descriptor.returns.kind !== 'int') errors.push({ code: 'jvm-return-type-mismatch', offset }); return true;
    case 0xad: popKind(state, 'long', errors, offset); if (descriptor.returns.kind !== 'long') errors.push({ code: 'jvm-return-type-mismatch', offset }); return true;
    case 0xae: popKind(state, 'float', errors, offset); if (descriptor.returns.kind !== 'float') errors.push({ code: 'jvm-return-type-mismatch', offset }); return true;
    case 0xaf: popKind(state, 'double', errors, offset); if (descriptor.returns.kind !== 'double') errors.push({ code: 'jvm-return-type-mismatch', offset }); return true;
    case 0xb0: popKind(state, 'ref', errors, offset); if (descriptor.returns.kind !== 'ref') errors.push({ code: 'jvm-return-type-mismatch', offset }); unsupported.add(`reference-assignability:${offset}`); return true;
    case 0xb1: if (descriptor.returns.kind !== 'void') errors.push({ code: 'jvm-return-type-mismatch', offset }); return true;
    case 0xbb: push('ref'); unsupported.add(`uninitialized-object-verification:${offset}`); return true;
    case 0xbf: popKind(state, 'ref', errors, offset); unsupported.add(`throwable-assignability:${offset}`); return true;
    case 0xc0: popKind(state, 'ref', errors, offset); push('ref'); unsupported.add(`checkcast-cp-validation:${offset}`); return true;
    case 0xc1: popKind(state, 'ref', errors, offset); push('int'); unsupported.add(`instanceof-cp-validation:${offset}`); return true;
    case 0xc2: case 0xc3: popKind(state, 'ref', errors, offset); unsupported.add(`structured-locking-verification:${offset}`); return true;
    case 0xb2: case 0xb3: case 0xb4: case 0xb5:
      unsupported.add(`field-descriptor-verification:${offset}`); return false;
    case 0xb6: case 0xb7: case 0xb8: case 0xb9:
      unsupported.add(`invoke-descriptor-verification:${offset}`); return false;
    default:
      unsupported.add(`opcode-verification:${offset}:0x${Number(opcode).toString(16)}`); return false;
  }
}

function knownInstructionLength(opcode) {
  if ([0x10, 0x12, 0x15, 0x16, 0x17, 0x18, 0x19, 0x36, 0x37, 0x38, 0x39, 0x3a].includes(opcode)) return 2;
  if ([0x11, 0x13, 0x14, 0x84, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e,
    0x9f, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa7,
    0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xbb, 0xc0, 0xc1].includes(opcode)) return 3;
  if (opcode === 0xb9) return 5;
  if ([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
    0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25,
    0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d,
    0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46,
    0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e,
    0x57, 0x58, 0x59, 0x60, 0x64, 0x68, 0x6c, 0x70, 0x78, 0x7a, 0x7c, 0x7e, 0x80, 0x82,
    0xac, 0xad, 0xae, 0xaf, 0xb0, 0xb1, 0xbf, 0xc2, 0xc3].includes(opcode)) return 1;
  return null;
}

function normalSuccessors(bundle, bundles, index) {
  const controls = bundle.controlEffects ?? [];
  if (controls.some((effect) => effect?.kind === 'return' || effect?.kind === 'throw' || effect?.kind === 'trap')) return [];
  const branchTargets = controls.filter((effect) => effect?.kind === 'branch' || effect?.kind === 'conditional-branch').map((effect) => effect.targetOffset);
  const unconditional = controls.some((effect) => effect?.kind === 'branch');
  const out = [...branchTargets];
  if (!unconditional && index + 1 < bundles.length) out.push(bundles[index + 1].bytecodeOffset);
  return [...new Set(out)];
}

export function verifyJvmMethod(decoded, options = {}) {
  const errors = [];
  const unsupported = new Set();
  if (!decoded || typeof decoded !== 'object' || !Array.isArray(decoded.bundles)) {
    return { status: 'invalid', errors: [{ code: 'jvm-verifier-invalid-decoded-method' }], warnings: [], verifierFacts: [] };
  }

  const metadata = decoded.metadata ?? {};
  const accessFlags = Number.isInteger(metadata.accessFlags) ? metadata.accessFlags : null;
  const descriptorText = typeof metadata.descriptor === 'string' ? metadata.descriptor : null;
  const isStatic = accessFlags != null && (accessFlags & 0x0008) !== 0;
  const descriptor = parseMethodDescriptor(descriptorText, isStatic);
  if (!descriptor) errors.push({ code: 'jvm-invalid-method-descriptor' });
  if (metadata.methodName === '<init>') unsupported.add('constructor-initialization-verification');

  const isNative = accessFlags != null && (accessFlags & 0x0100) !== 0;
  const isAbstract = accessFlags != null && (accessFlags & 0x0400) !== 0;
  const hasCode = metadata.hasCode === true;
  if (metadata.hasCode !== true && metadata.hasCode !== false) unsupported.add('method-code-cardinality-metadata-missing');
  else if ((isNative || isAbstract) && hasCode) errors.push({ code: 'jvm-code-forbidden-by-access-flags' });
  else if (!isNative && !isAbstract && !hasCode) errors.push({ code: 'jvm-concrete-method-code-required' });

  if (errors.length || !hasCode) {
    return {
      status: errors.length ? 'invalid' : unsupported.size ? 'partial' : 'valid',
      errors,
      warnings: [...unsupported].map((code) => ({ code })),
      verifierFacts: [],
    };
  }

  const bundles = [...decoded.bundles].sort((a, b) => a.bytecodeOffset - b.bytecodeOffset);
  const starts = new Set(bundles.map((bundle) => bundle.bytecodeOffset));
  const codeLength = asNonNegativeInteger(metadata.codeLength);
  const maxStack = asNonNegativeInteger(decoded.entryState?.maxStack);
  const maxLocals = asNonNegativeInteger(decoded.entryState?.maxLocals);
  if (codeLength == null || maxStack == null || maxLocals == null) unsupported.add('code-limits-metadata-missing');
  if (bundles.length === 0 || bundles[0]?.bytecodeOffset !== 0) errors.push({ code: 'jvm-code-missing-entry-instruction' });
  if (descriptor && maxLocals != null && descriptor.parameterSlots > maxLocals) errors.push({ code: 'jvm-parameters-exceed-max-locals' });

  const classMajor = Number.isInteger(metadata.classMajorVersion) ? metadata.classMajorVersion : 0;
  const hasControlFlowBranch = bundles.some((bundle) => (bundle.controlEffects ?? []).some((effect) => effect?.kind === 'branch' || effect?.kind === 'conditional-branch'));
  if (classMajor >= 50 && hasControlFlowBranch) unsupported.add('stack-map-frame-verification');
  for (let bundleIndex = 0; bundleIndex < bundles.length; bundleIndex++) {
    const bundle = bundles[bundleIndex];
    const offset = asNonNegativeInteger(bundle.bytecodeOffset);
    if (offset == null || (codeLength != null && offset >= codeLength)) errors.push({ code: 'jvm-invalid-instruction-offset', offset: bundle.bytecodeOffset });
    for (const effect of bundle.controlEffects ?? []) {
      if (effect?.kind !== 'branch' && effect?.kind !== 'conditional-branch') continue;
      const target = effect.targetOffset;
      if (!Number.isSafeInteger(target) || target < 0 || (codeLength != null && target >= codeLength) || !starts.has(target)) {
        errors.push({ code: 'jvm-invalid-branch-target', offset: bundle.bytecodeOffset, target });
      }
    }
    for (const access of [...(bundle.locationReads ?? []), ...(bundle.locationWrites ?? [])]) {
      if (access?.kind !== 'local') continue;
      const index = access.index;
      const slots = access.bits === 64 ? 2 : 1;
      if (!Number.isSafeInteger(index) || index < 0 || maxLocals == null || index + slots > maxLocals) {
        errors.push({ code: 'jvm-local-index-out-of-range', offset: bundle.bytecodeOffset, index, slots });
      }
    }
    validateConstantPoolOperand(bundle, options.image ?? null, classMajor, errors, unsupported);
    const length = knownInstructionLength(bundle.opcode);
    if (length != null && (bundle.completeness === 'exact' || bundle.completeness === 'exact-with-intrinsic')) {
      const expectedNext = bundle.bytecodeOffset + length;
      const actualNext = bundleIndex + 1 < bundles.length ? bundles[bundleIndex + 1].bytecodeOffset : codeLength;
      if (actualNext != null && expectedNext !== actualNext) {
        errors.push({ code: 'jvm-instruction-boundary-mismatch', offset: bundle.bytecodeOffset, expectedNext, actualNext });
      }
    }
  }

  if (bundles.length > 0 && codeLength != null) {
    const last = bundles[bundles.length - 1];
    const terminal = (last.controlEffects ?? []).some((effect) => ['return', 'throw', 'trap', 'branch'].includes(effect?.kind));
    if (!terminal && last.completeness === 'exact') errors.push({ code: 'jvm-code-falls-through-end', offset: last.bytecodeOffset });
  }

  if ((decoded.exceptionRegions ?? []).length > 0) {
    unsupported.add('exception-handler-type-state-verification');
    for (const region of decoded.exceptionRegions) {
      if (!starts.has(region.startOffset) || !starts.has(region.handlerOffset) || (region.endOffset !== codeLength && !starts.has(region.endOffset))) {
        errors.push({ code: 'jvm-invalid-exception-handler-boundary', regionId: region.id ?? null });
      }
    }
  }

  if (descriptor && maxStack != null && maxLocals != null && errors.length === 0) {
    const initialLocals = Array(maxLocals).fill(null);
    for (let i = 0; i < descriptor.initialLocals.length && i < maxLocals; i++) initialLocals[i] = descriptor.initialLocals[i] ?? null;
    const states = new Map([[0, { stack: [], locals: initialLocals }]]);
    const queue = [0];
    const bundleByOffset = new Map(bundles.map((bundle, index) => [bundle.bytecodeOffset, { bundle, index }]));
    while (queue.length && errors.length === 0) {
      const offset = queue.shift();
      const entry = bundleByOffset.get(offset);
      if (!entry) continue;
      const state = cloneState(states.get(offset));
      const canPropagate = executeBundle(entry.bundle, state, descriptor, errors, unsupported);
      const usedStack = stackSlots(state.stack);
      if (usedStack > maxStack) errors.push({ code: 'jvm-max-stack-exceeded', offset, actual: usedStack, maxStack });
      if (!canPropagate || errors.length) continue;
      for (const successor of normalSuccessors(entry.bundle, bundles, entry.index)) {
        if (!starts.has(successor)) continue;
        const previous = states.get(successor);
        if (!previous) {
          states.set(successor, cloneState(state));
          queue.push(successor);
          continue;
        }
        const merged = mergeStates(previous, state);
        if (!merged.compatible) {
          errors.push({ code: 'jvm-incompatible-frame-merge', offset: successor });
          break;
        }
        if (merged.changed) {
          states.set(successor, merged.state);
          queue.push(successor);
        }
      }
    }
  }

  const status = errors.length > 0 ? 'invalid' : unsupported.size > 0 ? 'partial' : 'valid';
  return {
    status,
    errors,
    warnings: [...unsupported].map((code) => ({ code })),
    verifierFacts: [
      { kind: 'jvm-instruction-boundaries-checked', checked: true },
      { kind: 'jvm-stack-local-dataflow', checked: status !== 'partial' },
    ],
  };
}