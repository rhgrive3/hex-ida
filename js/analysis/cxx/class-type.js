// A constructor/destructor ABI token proves a class type, even when the class
// has no virtual table. This does not prove that any other qualified function
// is non-static, nor does it supply a member name, layout, or inheritance.
import { cxxAbiFunctionRole } from '../../rtti.js';
import { deepFreeze, stableDigest } from '../../core/identity/index.js';

const proofs = new WeakSet();
export const isCanonicalCppClassTypeEvidence = value => value !== null
  && typeof value === 'object' && proofs.has(value);

function classNameFromLifetimeSymbol(symbol) {
  const role = cxxAbiFunctionRole(symbol);
  if (!role || !['constructor', 'destructor'].includes(role.kind)
    || typeof symbol !== 'string' || !symbol.startsWith('_ZN')) return null;
  // Keep this independent class-name decoder small: ordinary ASCII qualified
  // names only. Templates, substitutions and adjusting thunks stay unsupported.
  let position = 3;
  const parts = [];
  while (position < symbol.length && /[1-9]/.test(symbol[position])) {
    const match = /^[1-9][0-9]{0,2}/.exec(symbol.slice(position));
    if (!match || parts.length >= 16) return null;
    const size = Number(match[0]); position += match[0].length;
    if (size > 240 || position + size > symbol.length) return null;
    const part = symbol.slice(position, position + size); position += size;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) return null;
    parts.push(part);
  }
  if (!parts.length || !/^(?:C[123]|D[012])E/.test(symbol.slice(position))) return null;
  return parts.join('::');
}

// One bounded metadata walk; no code reads, decompilation, or source/debug data.
// An address with any incompatible alias cannot establish a class type.
export function buildCppClassTypeIndex({ symbols, snapshotId } = {}) {
  const result = new Map();
  if (typeof snapshotId !== 'string' || !snapshotId.trim()
    || !Number.isSafeInteger(symbols?.names?.length) || symbols.names.length > 262144) return result;
  const starts = new Set(Array.from(symbols.funcs ?? [], String));
  const records = new Map(), blocked = new Set();
  for (let i = 0; i < symbols.names.length; i++) {
    const address = symbols.addrs?.[i];
    if (typeof address !== 'bigint' || address <= 0n || !starts.has(String(address))) continue;
    const key = String(address), symbol = symbols.names[i];
    if (blocked.has(key)) continue;
    const className = classNameFromLifetimeSymbol(symbol), previous = records.get(key);
    if (previous && (!className || previous.className !== className)) {
      records.delete(key); blocked.add(key); continue;
    }
    if (!className) { blocked.add(key); continue; }
    if (!previous) records.set(key, { className, symbol, functionAddress: address });
  }
  for (const record of records.values()) {
    if (result.has(record.className)) continue;
    if (result.size >= 4096) break;
    const value = { schema: 'cpp-class-type-evidence/v1', ...record, snapshotId,
      rule: 'exact-lifetime-function-ABI-class-type' };
    value.digest = stableDigest(value);
    const proof = deepFreeze(value); proofs.add(proof); result.set(record.className, proof);
  }
  return result;
}
