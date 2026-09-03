const ACC_STATIC = 0x0008;
const ACC_NATIVE = 0x0100;
const ACC_ABSTRACT = 0x0400;

// Widths for the opcodes the current DEX lifter recognizes. Unknown DEX
// instructions make verifier completeness partial instead of being guessed.
function width(op) {
  if (op === 0x00 || op === 0x01 || op === 0x04 || op === 0x07 ||
      (op >= 0x0a && op <= 0x12) || op === 0x27 || op === 0x28 ||
      (op >= 0xb0 && op <= 0xba)) return 1;
  if (op === 0x02 || op === 0x05 || op === 0x08 || op === 0x13 || op === 0x16 ||
      op === 0x1a || op === 0x22 || op === 0x29 || (op >= 0x32 && op <= 0x3d) ||
      (op >= 0x52 && op <= 0x5f) || (op >= 0x90 && op <= 0x9a) ||
      (op >= 0xd8 && op <= 0xdf)) return 2;
  if (op === 0x14 || (op >= 0x6e && op <= 0x72)) return 3;
  return null;
}

// These opcodes can be certified without a register-type dataflow pass. Other
// recognized opcodes are checked for local structural constraints but remain
// verifier-partial, preventing an exact semantic bundle from minting spec truth.
const LOCAL_COMPLETE = new Set([0x00, 0x0e, 0x12, 0x13, 0x14, 0x16, 0x1a, 0x28, 0x29]);
const finding = (code, details = {}) => ({ code, ...details });
const typeWords = (type) => type === 'J' || type === 'D' ? 2 : 1;
function returnKind(type) {
  if (type === 'V') return 'void';
  if (type === 'J' || type === 'D') return 'wide';
  if (typeof type === 'string' && (type.startsWith('L') || type.startsWith('['))) return 'object';
  return typeof type === 'string' && type ? 'single' : null;
}
function methodEntry(image, methodIdx) {
  for (const cls of image?.classes ?? []) {
    for (const entry of cls?.directMethods ?? []) if (entry?.methodIdx === methodIdx) return entry;
    for (const entry of cls?.virtualMethods ?? []) if (entry?.methodIdx === methodIdx) return entry;
  }
  return null;
}
function uleb(bytes, start) {
  let value = 0, shift = 0, pos = start;
  for (let i = 0; i < 5; i++) {
    if (pos >= bytes.length) throw new TypeError('dex-validation-truncated-uleb128');
    const byte = bytes[pos++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: pos };
    shift += 7;
  }
  throw new TypeError('dex-validation-malformed-uleb128');
}
function sleb(bytes, start) {
  let value = 0, shift = 0, pos = start, byte = 0;
  for (let i = 0; i < 5; i++) {
    if (pos >= bytes.length) throw new TypeError('dex-validation-truncated-sleb128');
    byte = bytes[pos++]; value |= (byte & 0x7f) << shift; shift += 7;
    if ((byte & 0x80) === 0) {
      if (shift < 32 && (byte & 0x40)) value |= (~0 << shift);
      return { value: value | 0, next: pos };
    }
  }
  throw new TypeError('dex-validation-malformed-sleb128');
}

function instructionFact(view, start, pc, op, w, image) {
  const fmt = view.getUint8(start + pc * 2 + 1);
  const word = (n) => view.getUint16(start + (pc + n) * 2, true);
  const sword = (n) => view.getInt16(start + (pc + n) * 2, true);
  const regs = [];
  const reg = (index, words = 1) => regs.push({ index, words });
  let reference = null, branch = null, invoke = null;

  if (op === 0x01 || op === 0x04 || op === 0x07) { const n = op === 0x04 ? 2 : 1; reg((fmt >> 4) & 15, n); reg(fmt & 15, n); }
  else if (op === 0x02 || op === 0x05 || op === 0x08) { const n = op === 0x05 ? 2 : 1; reg(word(1), n); reg(fmt, n); }
  else if (op >= 0x0a && op <= 0x0d) reg(fmt, op === 0x0b ? 2 : 1);
  else if (op >= 0x0f && op <= 0x11) reg(fmt, op === 0x10 ? 2 : 1);
  else if (op === 0x12) reg(fmt & 15);
  else if (op === 0x13 || op === 0x14 || op === 0x1a || op === 0x22) reg(fmt);
  else if (op === 0x16) reg(fmt, 2);
  else if (op === 0x27) reg(fmt);
  else if (op >= 0x32 && op <= 0x37) { reg(fmt & 15); reg((fmt >> 4) & 15); }
  else if (op >= 0x38 && op <= 0x3d) reg(fmt);
  else if (op >= 0x52 && op <= 0x5f) { const wide = op === 0x53 || op === 0x5a ? 2 : 1; reg(fmt & 15, wide); reg((fmt >> 4) & 15); }
  else if (op >= 0x90 && op <= 0x9a) { const r = word(1); reg(fmt); reg(r & 255); reg(r >> 8); }
  else if (op >= 0xb0 && op <= 0xba) { reg(fmt & 15); reg((fmt >> 4) & 15); }
  else if (op >= 0xd8 && op <= 0xdf) { const r = word(1); reg(fmt); reg(r & 255); }

  if (op === 0x1a) reference = { kind: 'string', index: word(1) };
  else if (op === 0x22) reference = { kind: 'type', index: word(1) };
  else if (op >= 0x52 && op <= 0x5f) reference = { kind: 'field', index: word(1) };
  else if (op >= 0x6e && op <= 0x72) reference = { kind: 'method', index: word(1) };

  if (op === 0x28) branch = (pc + (fmt >= 128 ? fmt - 256 : fmt)) * 2;
  else if (op === 0x29 || (op >= 0x32 && op <= 0x3d)) branch = (pc + sword(1)) * 2;

  if (op >= 0x6e && op <= 0x72) {
    const count = (fmt >> 4) & 15, packed = word(2), methodIndex = word(1);
    const registers = [packed & 15, (packed >> 4) & 15, (packed >> 8) & 15, (packed >> 12) & 15, fmt & 15].slice(0, Math.min(count, 5));
    const target = image.methods?.[methodIndex] ?? null;
    const params = Array.isArray(target?.proto?.params) ? target.proto.params : null;
    const isStatic = op === 0x71;
    invoke = {
      count, registers, methodIndex, params, isStatic,
      expectedWords: params ? params.reduce((sum, type) => sum + typeWords(type), isStatic ? 0 : 1) : null,
      resultKind: returnKind(target?.proto?.returnType),
    };
  }

  return {
    offset: pc * 2, opcode: op, width: w, regs, reference, branch, invoke,
    moveResult: op === 0x0a ? 'single' : op === 0x0b ? 'wide' : op === 0x0c ? 'object' : null,
    moveException: op === 0x0d,
    returnKind: op === 0x0e ? 'void' : op === 0x0f ? 'single' : op === 0x10 ? 'wide' : op === 0x11 ? 'object' : null,
  };
}

function exceptionFacts(bytes, view, meta) {
  if (!meta.triesSize) return { tries: [], handlers: [], complete: true, errors: [] };
  const errors = [], tries = [], handlers = [];
  const triesStart = meta.insnsEnd + (meta.insnsSize & 1 ? 2 : 0);
  if (triesStart + meta.triesSize * 8 > bytes.length) return { tries, handlers, complete: false, errors: [finding('dex-truncated-try-items')] };
  const listStart = triesStart + meta.triesSize * 8;
  try {
    const rawTries = [];
    for (let i = 0; i < meta.triesSize; i++) {
      const p = triesStart + i * 8, start = view.getUint32(p, true), count = view.getUint16(p + 4, true);
      rawTries.push({ index: i, start: start * 2, end: (start + count) * 2, count, handlerOff: view.getUint16(p + 6, true) });
    }
    let r = uleb(bytes, listStart), pos = r.next;
    if (r.value > 65535 || r.value > bytes.length - pos) throw new TypeError('dex-validation-handler-count-invalid');
    const byOffset = new Map();
    for (let i = 0; i < r.value; i++) {
      const relative = pos - listStart, size = sleb(bytes, pos); pos = size.next;
      const targets = [];
      for (let j = 0; j < Math.abs(size.value); j++) {
        const type = uleb(bytes, pos); pos = type.next; const addr = uleb(bytes, pos); pos = addr.next;
        targets.push({ typeIndex: type.value, target: addr.value * 2 });
      }
      if (size.value <= 0) { const addr = uleb(bytes, pos); pos = addr.next; targets.push({ typeIndex: null, target: addr.value * 2 }); }
      byOffset.set(relative, targets); handlers.push(...targets);
    }
    for (const item of rawTries) tries.push({ ...item, targets: byOffset.get(item.handlerOff) ?? null });
    return { tries, handlers, complete: true, errors };
  } catch (error) {
    errors.push(finding('dex-malformed-catch-handler-list', { detail: error?.message ?? String(error) }));
    return { tries, handlers, complete: false, errors };
  }
}

export function captureDexValidationMetadata(methodIdx, image) {
  const structuralErrors = [], partialReasons = [];
  const entry = methodEntry(image, methodIdx), method = image?.methods?.[methodIdx] ?? null;
  if (!entry) structuralErrors.push(finding('dex-method-definition-missing', { methodIdx }));
  if (!method) structuralErrors.push(finding('dex-method-id-missing', { methodIdx }));
  const flags = entry?.accessFlags ?? 0, codeOff = entry?.codeOff ?? 0;
  const isStatic = !!(flags & ACC_STATIC), isNative = !!(flags & ACC_NATIVE), isAbstract = !!(flags & ACC_ABSTRACT);
  const params = Array.isArray(method?.proto?.params) ? method.proto.params : [];
  const base = {
    methodIdx, accessFlags: flags, codeOff, isStatic, isNative, isAbstract,
    expectedInsSize: params.reduce((sum, type) => sum + typeWords(type), isStatic ? 0 : 1),
    methodReturn: method?.proto?.returnType ?? null,
    tableSizes: { strings: image?.strings?.length ?? 0, types: image?.types?.length ?? 0, fields: image?.fields?.length ?? 0, methods: image?.methods?.length ?? 0 },
  };
  if (!codeOff) return { ...base, structuralErrors, partialReasons, facts: [], tries: [], handlers: [], exceptionComplete: true };
  const bytes = image?.rawBytes;
  if (!(bytes instanceof Uint8Array) || codeOff + 16 > bytes.length) {
    structuralErrors.push(finding('dex-truncated-code-item'));
    return { ...base, structuralErrors, partialReasons, facts: [], tries: [], handlers: [], exceptionComplete: false };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const registersSize = view.getUint16(codeOff, true), insSize = view.getUint16(codeOff + 2, true), outsSize = view.getUint16(codeOff + 4, true);
  const triesSize = view.getUint16(codeOff + 6, true), debugInfoOff = view.getUint32(codeOff + 8, true), insnsSize = view.getUint32(codeOff + 12, true), insnsStart = codeOff + 16, insnsEnd = insnsStart + insnsSize * 2;
  if (insnsSize === 0) structuralErrors.push(finding('dex-empty-instruction-stream'));
  if (debugInfoOff !== 0 && debugInfoOff >= bytes.length) structuralErrors.push(finding('dex-debug-info-offset-out-of-range', { debugInfoOff }));
  if (codeOff % 4) structuralErrors.push(finding('dex-code-item-offset-alignment-invalid', { codeOff }));
  if (!Number.isSafeInteger(insnsEnd) || insnsEnd > bytes.length) structuralErrors.push(finding('dex-truncated-instructions'));
  const padding = triesSize && (insnsSize & 1) && insnsEnd + 2 <= bytes.length ? view.getUint16(insnsEnd, true) : null;
  if (padding !== null && padding !== 0) structuralErrors.push(finding('dex-code-item-padding-nonzero', { padding }));

  const facts = [];
  if (!structuralErrors.some((e) => e.code === 'dex-truncated-instructions')) {
    for (let pc = 0; pc < insnsSize;) {
      const op = view.getUint8(insnsStart + pc * 2);
      const formatByte = view.getUint8(insnsStart + pc * 2 + 1);
      if (op === 0x00 && formatByte !== 0x00) {
        partialReasons.push(finding('dex-verifier-payload-unsupported', { offset: pc * 2, signature: formatByte }));
        break;
      }
      const w = width(op);
      if (w == null) { partialReasons.push(finding('dex-verifier-opcode-unsupported', { offset: pc * 2, opcode: op })); break; }
      if (pc + w > insnsSize) { structuralErrors.push(finding('dex-instruction-crosses-insns-size', { offset: pc * 2, opcode: op })); break; }
      facts.push(instructionFact(view, insnsStart, pc, op, w, image));
      if (!LOCAL_COMPLETE.has(op)) partialReasons.push(finding('dex-verifier-dataflow-incomplete', { offset: pc * 2, opcode: op }));
      pc += w;
    }
  }
  const scanComplete = facts.reduce((n, f) => n + f.width, 0) === insnsSize;
  if (!scanComplete && !partialReasons.length && !structuralErrors.length) partialReasons.push(finding('dex-verifier-instruction-scan-incomplete'));
  const ex = scanComplete && insnsEnd <= bytes.length ? exceptionFacts(bytes, view, { triesSize, insnsSize, insnsEnd }) : { tries: [], handlers: [], complete: false, errors: [] };
  structuralErrors.push(...ex.errors);
  if (!ex.complete) partialReasons.push(finding('dex-exception-metadata-incomplete'));
  return { ...base, registersSize, insSize, outsSize, triesSize, insnsSize, insnsStart, insnsEnd, structuralErrors, partialReasons, facts, tries: ex.tries, handlers: ex.handlers, exceptionComplete: ex.complete, scanComplete };
}

function tableSize(meta, kind) { return meta.tableSizes?.[`${kind}s`] ?? null; }

export function validateDexMethod(decoded) {
  const meta = decoded?.metadata?.dexValidation;
  const structuralErrors = Array.isArray(meta?.structuralErrors) ? [...meta.structuralErrors] : [];
  const partialReasons = Array.isArray(meta?.partialReasons) ? [...meta.partialReasons] : [];
  const errors = [], warnings = [], verifierFacts = [];
  if (!meta || typeof meta !== 'object') {
    structuralErrors.push(finding('dex-validation-metadata-missing'));
    return { structuralErrors, errors, warnings, verifierFacts, partialReasons };
  }
  if (!meta.codeOff) {
    if (!meta.isNative && !meta.isAbstract) errors.push(finding('dex-code-item-required-for-concrete-method'));
    verifierFacts.push(finding('dex-code-item-access-flags-checked', { codeOff: meta.codeOff, accessFlags: meta.accessFlags }));
    return { structuralErrors, errors, warnings, verifierFacts, partialReasons };
  }
  if (meta.isNative || meta.isAbstract) errors.push(finding('dex-code-item-forbidden-for-native-or-abstract-method'));
  if (!Number.isSafeInteger(meta.registersSize) || !Number.isSafeInteger(meta.insSize) || meta.insSize > meta.registersSize) errors.push(finding('dex-register-file-size-invalid', { registersSize: meta.registersSize, insSize: meta.insSize }));
  if (Number.isSafeInteger(meta.expectedInsSize) && meta.insSize !== meta.expectedInsSize) errors.push(finding('dex-ins-size-signature-mismatch', { insSize: meta.insSize, expectedInsSize: meta.expectedInsSize }));

  const facts = Array.isArray(meta.facts) ? meta.facts : [], bundles = Array.isArray(decoded?.bundles) ? decoded.bundles : [];
  const boundaries = new Set(facts.map((f) => f.offset)), branches = new Set(facts.map((f) => f.branch).filter(Number.isSafeInteger));
  const codeBytes = Number.isSafeInteger(meta.insnsSize) ? meta.insnsSize * 2 : null;
  if (meta.scanComplete) {
    if (facts.length !== bundles.length) structuralErrors.push(finding('dex-validation-instruction-count-mismatch', { raw: facts.length, decoded: bundles.length }));
    for (let i = 0; i < Math.min(facts.length, bundles.length); i++) {
      if (facts[i].offset !== bundles[i]?.bytecodeOffset || facts[i].opcode !== bundles[i]?.opcode) structuralErrors.push(finding('dex-instruction-provenance-mismatch', { index: i, rawOffset: facts[i].offset, decodedOffset: bundles[i]?.bytecodeOffset ?? null, rawOpcode: facts[i].opcode, decodedOpcode: bundles[i]?.opcode ?? null }));
    }
  }

  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    for (const r of fact.regs) if (!Number.isSafeInteger(r.index) || r.index < 0 || r.index + r.words > meta.registersSize) errors.push(finding(r.words === 2 ? 'dex-wide-register-pair-out-of-range' : 'dex-register-out-of-range', { offset: fact.offset, index: r.index, words: r.words, registersSize: meta.registersSize }));
    if (fact.reference) { const size = tableSize(meta, fact.reference.kind); if (!Number.isSafeInteger(size) || fact.reference.index < 0 || fact.reference.index >= size) errors.push(finding('dex-reference-index-out-of-range', { offset: fact.offset, ...fact.reference, size })); }
    if (fact.branch != null && codeBytes != null) {
      if (!Number.isSafeInteger(fact.branch) || fact.branch < 0 || fact.branch >= codeBytes) errors.push(finding('dex-branch-target-out-of-range', { offset: fact.offset, targetOffset: fact.branch, codeBytes }));
      else if (meta.scanComplete && !boundaries.has(fact.branch)) errors.push(finding('dex-branch-target-not-instruction-boundary', { offset: fact.offset, targetOffset: fact.branch }));
    }
    if (fact.invoke) {
      for (const r of fact.invoke.registers) if (!Number.isSafeInteger(r) || r < 0 || r >= meta.registersSize) errors.push(finding('dex-register-out-of-range', { offset: fact.offset, index: r, role: 'invoke-argument', registersSize: meta.registersSize }));
      if (fact.invoke.count > 5) errors.push(finding('dex-invoke-argument-count-invalid', { offset: fact.offset, count: fact.invoke.count }));
      if (fact.invoke.count > meta.outsSize) errors.push(finding('dex-invoke-outs-size-exceeded', { offset: fact.offset, count: fact.invoke.count, outsSize: meta.outsSize }));
      if (fact.invoke.expectedWords != null && fact.invoke.count !== fact.invoke.expectedWords) errors.push(finding('dex-invoke-argument-count-mismatch', { offset: fact.offset, count: fact.invoke.count, expectedWords: fact.invoke.expectedWords }));
      if (fact.invoke.params && fact.invoke.count === fact.invoke.expectedWords) {
        let at = fact.invoke.isStatic ? 0 : 1;
        for (const type of fact.invoke.params) { if (typeWords(type) === 2 && fact.invoke.registers[at + 1] !== fact.invoke.registers[at] + 1) errors.push(finding('dex-invoke-wide-argument-register-pair-invalid', { offset: fact.offset, register: fact.invoke.registers[at] ?? null })); at += typeWords(type); }
      }
    }
    if (fact.moveResult) {
      if (branches.has(fact.offset)) errors.push(finding('dex-move-result-control-flow-entry-invalid', { offset: fact.offset }));
      const prev = facts[i - 1];
      if (!prev?.invoke) errors.push(finding('dex-move-result-without-producer', { offset: fact.offset }));
      else if (prev.invoke.resultKind === 'void') errors.push(finding('dex-move-result-after-void', { offset: fact.offset }));
      else if (prev.invoke.resultKind && prev.invoke.resultKind !== fact.moveResult) errors.push(finding('dex-move-result-category-mismatch', { offset: fact.offset, actual: fact.moveResult, expected: prev.invoke.resultKind }));
      else if (!prev.invoke.resultKind) partialReasons.push(finding('dex-move-result-category-unresolved', { offset: fact.offset }));
    }
    if (fact.moveException && meta.exceptionComplete && !meta.handlers.some((h) => h.target === fact.offset)) errors.push(finding('dex-move-exception-not-handler-entry', { offset: fact.offset }));
    if (fact.returnKind) { const expected = returnKind(meta.methodReturn); if (expected && expected !== fact.returnKind) errors.push(finding('dex-return-category-mismatch', { offset: fact.offset, actual: fact.returnKind, expected })); else if (!expected) partialReasons.push(finding('dex-return-category-unresolved', { offset: fact.offset })); }
  }

  if (meta.scanComplete && facts.length) {
    const last = facts[facts.length - 1], terminal = last.opcode === 0x27 || last.opcode === 0x28 || last.opcode === 0x29 || (last.opcode >= 0x0e && last.opcode <= 0x11);
    if (!terminal) errors.push(finding('dex-method-falls-through-end', { offset: last.offset, opcode: last.opcode }));
  }
  let previousEnd = -1;
  for (const item of meta.tries ?? []) {
    if (!Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || item.count <= 0 || item.start < 0 || item.end <= item.start || item.end > codeBytes) { errors.push(finding('dex-try-range-invalid', { index: item.index, startOffset: item.start, endOffset: item.end })); continue; }
    if (item.start < previousEnd) errors.push(finding('dex-try-ranges-overlap-or-unsorted', { index: item.index, startOffset: item.start, previousEndOffset: previousEnd }));
    previousEnd = Math.max(previousEnd, item.end);
    if (!boundaries.has(item.start) || (item.end !== codeBytes && !boundaries.has(item.end))) errors.push(finding('dex-try-range-not-instruction-boundary', { index: item.index, startOffset: item.start, endOffset: item.end }));
    if (!Array.isArray(item.targets)) errors.push(finding('dex-try-handler-offset-invalid', { index: item.index, handlerOffset: item.handlerOff }));
  }
  for (const handler of meta.handlers ?? []) {
    if (handler.typeIndex != null && (handler.typeIndex < 0 || handler.typeIndex >= meta.tableSizes.types)) errors.push(finding('dex-catch-handler-type-index-out-of-range', { typeIndex: handler.typeIndex }));
    if (!Number.isSafeInteger(handler.target) || handler.target < 0 || handler.target >= codeBytes) errors.push(finding('dex-catch-handler-target-out-of-range', { targetOffset: handler.target }));
    else if (!boundaries.has(handler.target)) errors.push(finding('dex-catch-handler-target-not-instruction-boundary', { targetOffset: handler.target }));
    else if (branches.has(handler.target)) errors.push(finding('dex-move-exception-control-flow-entry-invalid', { targetOffset: handler.target }));
  }
  verifierFacts.push(finding('dex-independent-verifier-ran', { instructions: facts.length, registersSize: meta.registersSize, triesSize: meta.triesSize }));
  return { structuralErrors, errors, warnings, verifierFacts, partialReasons };
}
