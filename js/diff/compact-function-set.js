export const COMPACT_DIFF_FUNCTION_SET_SCHEMA = 'hex.diff.compact-function-set/v1';
export const SYMMETRIC_DIFF_PROFILE = 'symmetric-symbol-fast/v1';

export function createCompactFunctionSet(symbols, architecture, limit = 350000) {
  const functionAddresses = symbols?.funcs || [];
  const total = Number(functionAddresses.length || 0);
  const count = Math.min(total, Math.max(0, Number(limit) || 0));
  return Object.freeze({
    schema: COMPACT_DIFF_FUNCTION_SET_SCHEMA,
    evidenceProfile: SYMMETRIC_DIFF_PROFILE,
    architecture: String(architecture || 'unknown').toLowerCase(),
    functionAddresses,
    symbolAddresses: symbols?.addrs || [],
    symbolNames: symbols?.names || [],
    count,
    total,
    complete: count === total && symbols?.functionStartsComplete === true,
    truncationReason: count < total ? 'function-budget' : symbols?.functionStartsComplete === true ? null : 'function-discovery-incomplete',
  });
}

export function materializeCompactFunctionSet(input) {
  if (input?.schema !== COMPACT_DIFF_FUNCTION_SET_SCHEMA) return input || [];
  const functions = input.functionAddresses || [];
  const count = Math.min(Number(input.count || 0), functions.length);
  const symbolAddresses = input.symbolAddresses || [];
  const symbolNames = input.symbolNames || [];
  const names = new Map();
  for (let i = 0; i < Math.min(symbolAddresses.length, symbolNames.length); i++) {
    if (symbolNames[i]) names.set(String(symbolAddresses[i]), symbolNames[i]);
  }
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const address = functions[i];
    const next = i + 1 < functions.length ? functions[i + 1] : null;
    out[i] = {
      address,
      name: names.get(String(address)) || null,
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
