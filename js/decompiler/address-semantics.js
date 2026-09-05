function safeExtendName(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

function wrapped(text) {
  const s = String(text || 'index');
  return /^[-+]?\w+(?:->\w+|\.\w+)*$/.test(s) ? s : `(${s})`;
}

export function renderExtendedIndex(indexText, extend = null) {
  const index = wrapped(indexText);
  if (typeof extend !== 'string' && extend !== null) return `__arm64_index_invalid(${index})`;
  switch (extend === null ? '' : extend.toLowerCase()) {
    case 'sxtw': return `(int64_t)(int32_t)${index}`;
    case 'uxtw': return `(uint64_t)(uint32_t)${index}`;
    case 'sxtx': return `(int64_t)${index}`;
    case 'uxtx': return `(uint64_t)${index}`;
    case 'lsl': case '': return indexText;
    default: return `__arm64_index_${safeExtendName(extend)}(${index})`;
  }
}

export function renderIndexedMemory(baseText, indexText, { extend = null, scale = 0, size = 0 } = {}) {
  const shift = typeof scale === 'number' && Number.isSafeInteger(scale) && scale >= 0 ? scale : 0;
  const bytes = typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : 0;
  const index = renderExtendedIndex(indexText, extend);
  const scaleBytes = 2 ** shift;
  if (bytes > 0 && Number.isSafeInteger(scaleBytes) && scaleBytes === bytes) {
    return `${wrapped(baseText)}[${index}]`;
  }
  const offset = shift ? `(${index} << ${shift})` : index;
  return `memory[${baseText} + ${offset}]`;
}

function canonicalExtendSelector(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string') return null;
  switch (value.toLowerCase()) {
    case 'sxtw': case 'uxtw': case 'sxtx': case 'uxtx': case 'lsl':
      return value.toLowerCase();
    default:
      return null;
  }
}

function canonicalScale(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function canonicalIndexValue(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) {
    const parsed = BigInt(value);
    if (parsed < 0n) return null;
    return parsed;
  }
  return null;
}

export function effectiveIndexOffset(value, extend = null, scale = 0) {
  const index = canonicalIndexValue(value);
  if (index === null) return null;
  const selector = canonicalExtendSelector(extend ?? '');
  if (selector === null) return null;
  const shift = canonicalScale(scale);
  if (shift === null) return null;
  let canonical = index;
  switch (selector) {
    case 'sxtw': canonical = BigInt.asIntN(32, index); break;
    case 'uxtw': canonical = BigInt.asUintN(32, index); break;
    case 'sxtx': canonical = BigInt.asIntN(64, index); break;
    case 'uxtx': case 'lsl': canonical = BigInt.asUintN(64, index); break;
  }
  return canonical << BigInt(shift);
}
