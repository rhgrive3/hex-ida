const typeWords = (type) => type === 'J' || type === 'D' ? 2 : 1;

function registerKind(type) {
  if (type === 'J' || type === 'D') return 'wide';
  if (typeof type === 'string' && (type.startsWith('L') || type.startsWith('['))) return 'object';
  if (typeof type === 'string' && 'ZBCSI'.includes(type)) return 'int';
  if (type === 'F') return 'float';
  return null;
}

const finding = (code, details = {}) => ({ code, ...details });

export function validateLinearIntRegisterDataflow(meta, image) {
  const facts = Array.isArray(meta?.facts) ? meta.facts : [];
  if (!facts.length || meta?.triesSize !== 0) return { complete:false, errors:[], provenOffsets:[] };
  if (facts.some((fact) => ![0xb0, 0x0f].includes(fact?.opcode)
    || fact?.branch != null || fact?.invoke || fact?.moveResult || fact?.moveException)) {
    return { complete:false, errors:[], provenOffsets:[] };
  }
  const method = image?.methods?.[meta?.methodIdx];
  const params = Array.isArray(method?.proto?.params) ? method.proto.params : null;
  if (!params || !Number.isSafeInteger(meta?.registersSize) || !Number.isSafeInteger(meta?.insSize)) {
    return { complete:false, errors:[], provenOffsets:[] };
  }

  const registers = Array(meta.registersSize).fill(null);
  let cursor = meta.registersSize - meta.insSize;
  if (cursor < 0) return { complete:false, errors:[], provenOffsets:[] };
  if (!meta.isStatic) {
    if (cursor >= registers.length) return { complete:false, errors:[], provenOffsets:[] };
    registers[cursor++] = 'object';
  }
  for (const type of params) {
    const kind = registerKind(type);
    const words = typeWords(type);
    if (!kind || cursor + words > registers.length) return { complete:false, errors:[], provenOffsets:[] };
    registers[cursor] = kind;
    if (words === 2) registers[cursor + 1] = 'wide-tail';
    cursor += words;
  }
  if (cursor !== registers.length) return { complete:false, errors:[], provenOffsets:[] };

  const errors = [];
  const provenOffsets = [];
  for (const fact of facts) {
    const first = fact.regs?.[0]?.index;
    if (fact.opcode === 0xb0) {
      const second = fact.regs?.[1]?.index;
      if (registers[first] !== 'int' || registers[second] !== 'int') {
        errors.push(finding('dex-register-dataflow-type-mismatch', {
          offset: fact.offset, opcode: fact.opcode, registers: [first, second],
        }));
        continue;
      }
      registers[first] = 'int';
      provenOffsets.push(fact.offset);
      continue;
    }
    const expected = registerKind(method?.proto?.returnType);
    if (expected === 'int' && registers[first] === 'int') {
      provenOffsets.push(fact.offset);
    } else {
      errors.push(finding('dex-register-dataflow-type-mismatch', {
        offset: fact.offset, opcode: fact.opcode, register: first,
        expected, actual: registers[first] ?? null,
      }));
    }
  }
  return {
    complete: errors.length === 0 && provenOffsets.length === facts.length,
    errors,
    provenOffsets,
  };
}
