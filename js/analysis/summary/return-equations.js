/** Serializable return transfers, consumed by the existing summary SCC solver. */
export const RETURN_EQUATION_LIMIT = 4096;
export const RETURN_ARGUMENT_LIMIT = 256;
export const RETURN_FACT_LIMIT = 512;
const fail = () => { throw new TypeError('function-summary-invalid-return-equations'); };
const record = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
};
const id = value => { if (typeof value !== 'string' || !value.trim()) fail(); return value.trim(); };
const index = value => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(); return value; };
const dense = (value, limit) => {
  if (!Array.isArray(value) || value.length > limit) fail();
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) fail();
  return value;
};
const integer = value => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value).toString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'string' || !/^[+-]?[0-9]+$/.test(value)) fail();
  return BigInt(value).toString();
};

// null is the legacy/no-transfer state, NOT an empty exact return universe.
// The producer emits one row per returned value at each return site. Every
// published return value must be covered; malformed or truncated transfers
// cannot silently replace the local conservative facts.
export function canonicalReturnEquations(value, summary, normalizeFact) {
  if (value == null) return null;
  record(value);
  if (value.version !== 1 || Object.keys(value).some(key => !['version', 'rows'].includes(key))) fail();
  const sites = new Set(), covered = new Set();
  const callSites = new Map();
  for (const call of [...(summary.directCalls ?? []), ...(summary.indirectCallSets ?? [])]) {
    callSites.set(call.callSiteId, (callSites.get(call.callSiteId) ?? 0) + 1);
  }
  const fact = raw => {
    record(raw);
    if (Object.keys(raw).some(key => !['kind', 'argIndex', 'returnIndex', 'offset', 'rootEntityId', 'allocationSiteId', 'addressSpace'].includes(key))) fail();
    if (!['arg', 'root', 'allocation', 'unknown'].includes(raw.kind)) fail();
    if (raw.kind === 'arg') index(raw.argIndex);
    if (raw.kind === 'root' || raw.kind === 'allocation') {
      id(raw.rootEntityId ?? raw.allocationSiteId); id(raw.addressSpace);
    }
    if (raw.returnIndex != null) index(raw.returnIndex);
    if (raw.offset != null) integer(raw.offset);
    return normalizeFact(raw);
  };
  const rows = dense(value.rows, RETURN_EQUATION_LIMIT).map(raw => {
    record(raw);
    const common = ['siteId', 'valueId', 'returnIndex', 'kind'];
    const extra = raw.kind === 'fact' ? ['fact'] : ['callSiteId', 'callReturnIndex', 'offset', 'arguments'];
    if (Object.keys(raw).some(key => !common.includes(key) && !extra.includes(key))) fail();
    const row = { siteId:id(raw.siteId), valueId:id(raw.valueId), returnIndex:index(raw.returnIndex), kind:raw.kind };
    const key = JSON.stringify([row.siteId, row.returnIndex]);
    if (sites.has(key)) fail();
    sites.add(key); covered.add(row.valueId);
    if (row.kind === 'fact') {
      row.fact = fact(raw.fact);
      if ((row.fact.returnIndex ?? 0) !== row.returnIndex) fail();
    } else if (row.kind === 'call') {
      row.callSiteId = id(raw.callSiteId);
      if (callSites.get(row.callSiteId) !== 1) fail();
      row.callReturnIndex = index(raw.callReturnIndex);
      row.offset = integer(raw.offset);
      row.arguments = dense(raw.arguments, RETURN_ARGUMENT_LIMIT).map(fact);
    } else fail();
    return row;
  });
  const expected = new Set(summary.returnValues ?? []);
  if (expected.size !== covered.size || [...expected].some(valueId => !covered.has(valueId))) fail();
  rows.sort((a, b) => a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : a.returnIndex - b.returnIndex);
  return { version:1, rows };
}

/** The same substitution is used by local wrappers and recursive solving. */
export function substituteReturnFact(provenance, args, returnIndex, outerOffset = '0') {
  const unknown = { kind:'unknown', returnIndex };
  try {
    let source = provenance;
    let offset = BigInt(outerOffset) + BigInt(provenance.offset ?? 0);
    if (provenance.kind === 'arg') {
      source = args[provenance.argIndex];
      if (!source) return unknown;
      offset += BigInt(source.offset ?? 0);
    }
    if (source.kind === 'arg') return { kind:'arg', argIndex:source.argIndex, returnIndex, offset:offset.toString() };
    if (source.kind !== 'root' && source.kind !== 'allocation') return unknown;
    const rootEntityId = source.rootEntityId ?? source.allocationSiteId;
    if (!rootEntityId || !source.addressSpace) return unknown;
    return { kind:source.kind, rootEntityId, addressSpace:source.addressSpace, returnIndex, offset:offset.toString(),
      ...(source.allocationSiteId != null ? { allocationSiteId:source.allocationSiteId } : {}) };
  } catch { return unknown; }
}
