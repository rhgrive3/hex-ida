export const COMPACT_DIFF_FUNCTION_SET_SCHEMA = 'hex.diff.compact-function-set/v1';
export const SYMMETRIC_DIFF_PROFILE = 'symmetric-symbol-fast/v1';

// Preserve legacy numeric input compatibility, but never publish fractional or
// negative array lengths. Clamp to the actual column length before allocation.
function boundedFunctionCount(value, maximum) {
  const count = Number(value);
  return Number.isNaN(count) ? 0 : Math.min(maximum, Math.max(0, Math.floor(count)));
}

const MAX_U64_ADDRESS = 0xffffffffffffffffn;

function canonicalAddressKey(value) {
  let address;
  if (typeof value === 'bigint') address = value;
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    address = BigInt(value);
  } else if (typeof value === 'string') {
    const text = value.trim();
    const isHex = /^0[xX][0-9a-fA-F]+$/.test(text);
    const isDecimal = /^[0-9]+$/.test(text);
    if ((!isHex && !isDecimal) || (isHex ? text.length > 18 : text.length > 20)) return null;
    try { address = BigInt(text); } catch { return null; }
  } else return null;
  if (address < 0n || address > MAX_U64_ADDRESS) return null;
  return address.toString();
}

function symbolColumns(addresses, names) {
  const addressColumn = Array.isArray(addresses) || (ArrayBuffer.isView(addresses) && typeof addresses.length === 'number') ? addresses : [];
  const nameColumn = Array.isArray(names) ? names : [];
  const count = Math.min(addressColumn.length, nameColumn.length);
  let malformed = false;
  for (let i = 0; i < count; i++) {
    if (canonicalAddressKey(addressColumn[i]) == null || typeof nameColumn[i] !== 'string') { malformed = true; break; }
  }
  if (!malformed) return { addresses:addressColumn, names:nameColumn, count };
  const safeAddresses = [], safeNames = [];
  for (let i = 0; i < count; i++) {
    if (canonicalAddressKey(addressColumn[i]) == null || typeof nameColumn[i] !== 'string') continue;
    safeAddresses.push(addressColumn[i]);
    safeNames.push(nameColumn[i]);
  }
  return { addresses:safeAddresses, names:safeNames, count:safeAddresses.length };
}

export function createCompactFunctionSet(symbols, architecture, limit = 350000) {
  const functionAddresses = symbols?.funcs || [];
  const total = Number(functionAddresses.length || 0);
  const count = boundedFunctionCount(limit, total);
  const symbolsForIdentity = symbolColumns(symbols?.addrs, symbols?.names);
  return Object.freeze({
    schema: COMPACT_DIFF_FUNCTION_SET_SCHEMA,
    evidenceProfile: SYMMETRIC_DIFF_PROFILE,
    architecture: String(architecture || 'unknown').toLowerCase(),
    functionAddresses,
    symbolAddresses: symbolsForIdentity.addresses,
    symbolNames: symbolsForIdentity.names,
    count,
    total,
    complete: count === total && symbols?.functionStartsComplete === true,
    truncationReason: count < total ? 'function-budget' : symbols?.functionStartsComplete === true ? null : 'function-discovery-incomplete',
  });
}

export function materializeCompactFunctionSet(input) {
  if (input?.schema !== COMPACT_DIFF_FUNCTION_SET_SCHEMA) return input || [];
  const functions = input.functionAddresses || [];
  const count = boundedFunctionCount(input.count, functions.length);
  const symbolsForIdentity = symbolColumns(input.symbolAddresses, input.symbolNames);
  const names = new Map();
  for (let i = 0; i < symbolsForIdentity.count; i++) {
    const name = symbolsForIdentity.names[i];
    const key = canonicalAddressKey(symbolsForIdentity.addresses[i]);
    if (key != null && name) names.set(key, name);
  }
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const address = functions[i];
    const next = i + 1 < functions.length ? functions[i + 1] : null;
    out[i] = {
      address,
      name: names.get(canonicalAddressKey(address)) || null,
      size: next != null && next > address ? Number(next - address) : 0,
      architecture: input.architecture,
      strings: [], calls: [], imports: [], semantic: { writes: [], thresholds: [] }, fieldAccessShape: [],
      evidenceProfile: input.evidenceProfile,
    };
  }
  return out;
}

export function demoteLowInformationAbsenceClaims(result) {
  const demoted = [];
  for (const change of result?.deleted || []) demoted.push({ ...change, status:'unresolved', changeType:'unresolved', confidence:0, reason:'low-information-symmetric-profile', side:'before' });
  for (const change of result?.new || []) demoted.push({ ...change, status:'unresolved', changeType:'unresolved', confidence:0, reason:'low-information-symmetric-profile', side:'after' });
  if (!demoted.length) return result;
  const keep = (result.changes || []).filter((change) => change.changeType !== 'deleted' && change.changeType !== 'new');
  return {
    ...result,
    deleted: [],
    new: [],
    unresolved: [...(result.unresolved || []), ...demoted],
    changes: [...keep, ...demoted].sort((a, b) => {
      const x = a.before?.address ?? a.after?.address ?? 0n;
      const y = b.before?.address ?? b.after?.address ?? 0n;
      return x < y ? -1 : x > y ? 1 : 0;
    }),
  };
}
